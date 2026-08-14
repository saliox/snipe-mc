// Config du gate d'abonnement BAKÉE dans le build (asar), pour qu'elle ne soit PAS
// désactivable en éditant un .env livré en clair (faille C2 de l'audit).
//
// - En DEV (app non packagée), subgate.js autorise l'override par le .env.
// - En build PACKAGÉ, seules ces valeurs comptent.
//
// Vit dans src/ (et non gui/) car le moteur (src/entitlement.js, importé par
// src/sniper.js / src/auth.js / src/nameapi.js) doit pouvoir lire cette config
// SANS dépendre de gui/ — c'est ce qui permet à ces modules de se refuser
// eux-mêmes quand ils sont importés directement, hors de gui/main.js (audit :
// moteur nu non gaté). gui/subgate.js l'importe aussi (couche IPC Electron).
//
// Laisser vide = gate OFF (défaut). Pour gater un build : renseigne ces 3 valeurs
// AVANT de construire l'installeur (l'anon key Supabase est publique de toute façon ;
// aucun secret ici). Voir docs/subscription-setup.md.
export const GATE = {
  SUB_GATE: '',            // '1' pour activer
  SUPABASE_URL: '',        // https://xxxx.supabase.co
  SUPABASE_ANON_KEY: '',   // clé ANON publique
  STRIPE_PAYMENT_LINK: '', // https://buy.stripe.com/xxxx
  SUB_PRICE_LABEL: '3 €/mois',
};
