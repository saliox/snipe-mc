// Edge Function `stripe-webhook` — reçoit les événements Stripe, vérifie la SIGNATURE,
// et met à jour public.subscriptions (upsert idempotent) via la clé service_role.
//
// Déploiement :  supabase functions deploy stripe-webhook --no-verify-jwt
//   (Stripe n'envoie pas de JWT Supabase ; l'authenticité vient de la signature Stripe.)
// Secrets requis :  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
import Stripe from 'npm:stripe@17'
import { createClient } from 'jsr:@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  httpClient: Stripe.createFetchHttpClient(),
})
const cryptoProvider = Stripe.createSubtleCryptoProvider() // obligatoire en Deno
const whsec = Deno.env.get('STRIPE_WEBHOOK_SECRET')!
const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

// current_period_end a migré au niveau item selon l'apiVersion => repli robuste.
function periodEnd(sub: any): string | null {
  const ts = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null
  return ts ? new Date(ts * 1000).toISOString() : null
}
async function uidFromCustomer(customer: string): Promise<string | null> {
  const { data } = await admin.from('subscriptions').select('user_id')
    .eq('stripe_customer_id', customer).maybeSingle()
  return data?.user_id ?? null
}
async function upsertSub(uid: string, sub: any) {
  const { error } = await admin.from('subscriptions').upsert({
    user_id: uid,
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    status: sub.status,
    current_period_end: periodEnd(sub),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })
  if (error) throw error
}

Deno.serve(async (req) => {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return new Response('missing signature', { status: 400 })
  const body = await req.text() // CORPS BRUT : ne jamais parser avant la vérif
  let ev: Stripe.Event
  try {
    ev = await stripe.webhooks.constructEventAsync(body, sig, whsec, undefined, cryptoProvider)
  } catch (e) {
    return new Response(`bad sig: ${(e as Error).message}`, { status: 400 })
  }

  try {
    switch (ev.type) {
      case 'checkout.session.completed': {
        const s = ev.data.object as Stripe.Checkout.Session
        if (s.mode !== 'subscription') break
        const uid = s.client_reference_id ?? s.metadata?.user_id
        const customer = s.customer as string
        const subId = s.subscription as string | null
        if (!uid || !customer) break
        if (subId) {
          // Backfill : les events récurrents ne portent PAS client_reference_id.
          await stripe.subscriptions.update(subId, { metadata: { supabase_user_id: uid } })
          const sub = await stripe.subscriptions.retrieve(subId)
          await upsertSub(uid, sub)
        } else {
          await admin.from('subscriptions').upsert(
            { user_id: uid, stripe_customer_id: customer, status: 'active', updated_at: new Date().toISOString() },
            { onConflict: 'user_id' },
          )
        }
        break
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = ev.data.object as Stripe.Subscription
        const uid = (sub.metadata?.supabase_user_id) ?? await uidFromCustomer(sub.customer as string)
        if (uid) await upsertSub(uid, sub)
        break
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const inv = ev.data.object as any
        if (!inv.subscription) break
        const sub = await stripe.subscriptions.retrieve(inv.subscription)
        const uid = (sub.metadata?.supabase_user_id) ?? await uidFromCustomer(sub.customer as string)
        if (uid) await upsertSub(uid, sub)
        break
      }
    }
  } catch (e) {
    console.error('handler error', e)
    return new Response('handler error', { status: 500 }) // 5xx => Stripe rejoue
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
