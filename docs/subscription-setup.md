# Abonnement Stripe 3 €/mois — guide de branchement

Gate d'accès **OFF par défaut** : sans `SUB_GATE=1` dans le `.env`, l'app est strictement
inchangée. Ce guide explique comment l'activer. Le code est déjà en place (client
`gui/subgate.js` + `gui/renderer/gate.*`, backend `supabase/`).

> **Réalisme** : le binaire est public (obligatoire pour l'auto-update signé). Ce gate
> protège l'utilisateur lambda, pas un reverser déterminé. Le seul verrou inviolable
> serait de déplacer le moteur de snipe côté serveur (hors périmètre). C'est du
> *licensing poli*, conforme à la demande. La sécu réelle ici : l'état d'abonnement
> honoré hors-ligne est un **jeton signé Ed25519 par le serveur** → impossible de forger
> un `active` en réécrivant son cache (contrairement à un simple cache chiffré).

## 0. Architecture (5 lignes)
1. **Identité** : compte Supabase (email + mot de passe). `uid` = ancre, liée au client Stripe.
2. **Vérité** : table Postgres `subscriptions` (RLS lecture-propre) alimentée par le **webhook Stripe**.
3. **Entitlement** : edge function `subscription-status` (JWT-gated) → **jeton signé Ed25519**.
4. **Gate client** : `subgate.js` choisit `gate.html` ou `index.html` au démarrage ; grâce hors-ligne 72 h (jeton + horloge NTP anti-rollback). Gardes sur les IPC moteur.
5. **Paiement** : **Payment Link** 3 €/mois, `client_reference_id=<uid>`.

## 1. Paire Ed25519 d'entitlement
Déjà générée : la **publique** est figée dans `gui/subgate.js` (`ENT_PUBLIC_KEY_SPKI_B64`),
la **privée** est dans `.ent-key.b64` (gitignoré, local). **À sauvegarder hors repo.**
Pour en régénérer une :
```bash
node -e "const{generateKeyPairSync}=require('crypto');const{publicKey,privateKey}=generateKeyPairSync('ed25519');console.log('PUB',publicKey.export({type:'spki',format:'der'}).toString('base64'));console.log('PRIV',privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))"
```
→ PUB dans `subgate.js` (client) ; PRIV = secret `ENT_PRIVATE_KEY_PKCS8_B64` de l'edge function.

## 2. Supabase
1. Projet Supabase créé → note `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public), `SUPABASE_SERVICE_ROLE_KEY` (secret, Edge seulement).
2. Appliquer la migration `supabase/migrations/0001_subscriptions.sql` (table + RLS).
3. Déployer les fonctions :
   ```bash
   supabase functions deploy subscription-status
   supabase functions deploy stripe-webhook --no-verify-jwt
   supabase secrets set STRIPE_SECRET_KEY=sk_... STRIPE_WEBHOOK_SECRET=whsec_... ENT_PRIVATE_KEY_PKCS8_B64="$(cat .ent-key.b64)"
   # SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY sont auto-injectés.
   ```

## 3. Stripe (test d'abord)
1. Test mode → **Product catalog → Add product** : `Saliox Sniper`, **Recurring**, **3,00 EUR**, **Monthly** → copier `price_...`.
2. **Payment Links → New** → ce prix → copier l'URL → `STRIPE_PAYMENT_LINK`.
3. **Settings → Billing → Customer portal** : activer (résiliation self-service).
4. **Manage failed payments** : Smart Retries ON + statut final = **Cancel subscription**.
5. **Developers → Webhooks → Add endpoint** → `https://<ref>.functions.supabase.co/stripe-webhook` → cocher : `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed` → copier `whsec_...`.
6. **Developers → API keys** → `sk_...`.
7. Poser les secrets Supabase (§2.3) puis tester : `stripe listen --forward-to https://<ref>.functions.supabase.co/stripe-webhook`, carte OK `4242 4242 4242 4242`, échec `4000 0000 0000 0341`.

**Live** : activer le compte → recréer Product/Price + Payment Link + endpoint webhook (test ≠ live), nouveaux `sk_live_`/`whsec_live_`, mettre à jour les secrets + `STRIPE_PAYMENT_LINK`.

## 4. Activer le gate dans le build
Dans le `.env` posé à côté de `Snipe MC.exe` (ou du hub) :
```
SUB_GATE=1
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
STRIPE_PAYMENT_LINK=https://buy.stripe.com/xxxxxxxx
```
Absent → aucun gate. On peut gater snipe-mc et pas le hub (ou l'inverse) : c'est par `.env`.

## 5. Réutiliser pour snipe-hub
1. Copier `gui/subgate.js` + `gui/renderer/gate.html` + `gui/renderer/gate.js` (même `ENT_PUBLIC_KEY_SPKI_B64`).
2. Appliquer les mêmes points de câblage dans le `main.js` du hub (import, `resolveEntry()` au load, handlers `subgate:*`, gardes `gateLocked()`) + le bridge `subgate` dans son preload.
3. **Mêmes** edge functions / table / paire Ed25519 → **un abonnement unique** déverrouille les deux apps.

## 6. Ce que tu dois fournir
- Supabase : URL + anon key + service_role key.
- Stripe : secret key + webhook secret + URL du Payment Link.
- Décisions : confirmation email Supabase ON/OFF ; TTL de grâce (72 h par défaut — si tu changes, aligner `GRACE_S`/`FRESH_S` dans `subgate.js` ET `grace_until` dans l'edge function).
