// Edge Function `subscription-status` — JWT-gated (verify_jwt = true, défaut).
// Renvoie un JETON SIGNÉ Ed25519 { payload, sig } que le client honore hors-ligne :
// la signature couvre active + grace_until, donc l'utilisateur ne peut pas forger un
// `active` (chiffrer son cache ne suffirait pas, la clé securebox est recalculable).
//
// Déploiement :  supabase functions deploy subscription-status
// Secret requis :  ENT_PRIVATE_KEY_PKCS8_B64  (pendant privé de ENT_PUBLIC dans subgate.js)
import { createClient } from 'jsr:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

// Clé privée Ed25519 (PKCS8 DER, base64) — SECRET Edge, jamais côté client.
const PRIV_B64 = Deno.env.get('ENT_PRIVATE_KEY_PKCS8_B64')!
let signKey: CryptoKey | null = null
async function key() {
  if (!signKey) {
    const raw = Uint8Array.from(atob(PRIV_B64), (c) => c.charCodeAt(0))
    signKey = await crypto.subtle.importKey('pkcs8', raw, { name: 'Ed25519' }, false, ['sign'])
  }
  return signKey
}
// ORDRE DE CLÉS FIXE — doit correspondre octet pour octet au client (subgate.js).
const canonical = (p: any) =>
  JSON.stringify({ uid: p.uid, device: p.device, active: p.active, status: p.status, grace_until: p.grace_until, iat: p.iat })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const authz = req.headers.get('Authorization') ?? ''
  if (!authz.startsWith('Bearer ')) return json({ error: 'missing_token' }, 401)
  const { data: { user }, error } = await admin.auth.getUser(authz.slice(7))
  if (error || !user) return json({ error: 'invalid_token' }, 401)

  let device = ''
  try { device = String((await req.json())?.device ?? '').slice(0, 128) } catch { /* body vide */ }

  // M4 : une erreur DB ne doit JAMAIS produire un jeton active:false en 200 (ça
  // écraserait la grâce hors-ligne d'un abonné). On renvoie 503 → le client garde son cache.
  const { data: sub, error: dbErr } = await admin
    .from('subscriptions')
    .select('status, current_period_end')
    .eq('user_id', user.id)
    .maybeSingle()
  if (dbErr) return json({ error: 'db' }, 503)

  // M2 : quota d'appareils SERVEUR-AUTORITAIRE (le device signé est enregistré et plafonné).
  const MAX_DEVICES = 3
  let deviceAllowed = true
  if (device) {
    const { data: known, error: e1 } = await admin.from('devices')
      .select('device_fp').eq('user_id', user.id).eq('device_fp', device).maybeSingle()
    if (e1) return json({ error: 'db' }, 503)
    if (known) {
      await admin.from('devices').update({ last_seen: new Date().toISOString() })
        .eq('user_id', user.id).eq('device_fp', device)
    } else {
      const { count } = await admin.from('devices')
        .select('*', { count: 'exact', head: true }).eq('user_id', user.id)
      if ((count ?? 0) >= MAX_DEVICES) deviceAllowed = false // trop d'appareils → pas d'accès sur celui-ci
      else await admin.from('devices').insert({ user_id: user.id, device_fp: device })
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const pe = sub?.current_period_end ? Math.floor(Date.parse(sub.current_period_end) / 1000) : 0
  const active = deviceAllowed && !!sub &&
    (['active', 'trialing'].includes(sub.status) || (sub.status === 'past_due' && now < pe))

  const payload = {
    uid: user.id,
    device,
    active,
    status: sub?.status ?? 'none',
    grace_until: active ? now + 72 * 3600 : now, // grâce hors-ligne 72 h d'un abo BON ; sinon 0
    iat: now,
  }
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', await key(), new TextEncoder().encode(canonical(payload))))
  return json({ payload, sig: btoa(String.fromCharCode(...sig)) })
})
