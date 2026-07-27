# Snipe MC

Sniper de pseudos Minecraft pour comptes Microsoft / Java, en application de bureau **et** en ligne de
commande. Quand un pseudo se libère — 37 jours après un changement de nom — l'outil le réclame à la
seconde près sur **ton** compte, avec des connexions déjà ouvertes et une horloge calée sur NTP.

> Le snipe ne fait que **changer le nom de ton propre compte** via l'API officielle Minecraft. Il ne
> touche à aucun compte tiers. Respecte le rate limit de Mojang : trop agressif, tu te bloques
> toi-même au pire moment.

## Démarrer

```bash
npm install
copy .env.example .env      # puis renseigne MS_CLIENT_ID
npm start                   # lance l'app
```

Il te faut une **app Azure AD** (public client, scope `XboxLive.signin`) approuvée pour Minecraft — les
étapes sont dans `.env.example`. Si `login_with_xbox` répond `403 "Invalid app registration"`, fais
approuver ton app sur https://aka.ms/mce-reviewappid.

## Ce que tu peux faire

**Te connecter** au choix : le login Microsoft classique par device-code (bouton **MS LOGIN**), ou en
collant directement un bearer token. Le pseudo du compte s'affiche dès que le token est validé.

**Changer ton pseudo** tout de suite, quand tu as repéré un nom libre. Attention au cooldown de 30 jours
côté Java.

**Vérifier un pseudo** en un coup : disponibilité publique côté Mojang, plus le statut côté compte
(`AVAILABLE`, `DUPLICATE`, `NOT_ALLOWED`).

**Scanner une liste entière** — colle-la ou charge un `.txt`, un pseudo par ligne. Chaque nom est
vérifié un par un avec un délai réglable, un recul automatique en cas de rate limit, et tu exportes les
libres dans un fichier à la fin.

**Générer des candidats** de N lettres, en `a-z`, `a-z0-9` ou avec underscores, soit au hasard, soit en
énumérant tout l'espace quand il est assez petit. Le résultat alimente directement le scan.

**Sniper un pseudo précis**, de trois façons : en surveillance (tir dès qu'il se libère), à une date
donnée, ou dans X temps (45 s, 15 min, 2 h). Les réglages fins — taille de la rafale, espacement, avance
au tir, nombre de connexions — sont tous accessibles, et un bouton mesure ton décalage d'horloge.

## Comment ça marche

1. **Connexion** — Microsoft en device code, puis la chaîne Xbox Live → XSTS → Minecraft services. Le
   token est mis en cache et rafraîchi tout seul.
2. **Disponibilité** — l'API publique Mojang et l'API du compte sont interrogées.
3. **Horloge** — le décalage est mesuré par NTP (`time.google.com`, Cloudflare, `pool.ntp.org`) et
   corrigé au moment du tir.
4. **Tir** — les sockets TLS sont pré-chauffées une dizaine de secondes avant le drop, puis une rafale
   de `PUT /minecraft/profile/name/{nom}` part autour de T0. Ça s'arrête au premier `200`.

## Sécurité

- **Tes tokens sont chiffrés au repos.** Le cache de login Microsoft est chiffré en AES-256-GCM avec une
  clé liée à ta machine et à ton compte utilisateur ; les comptes enregistrés passent par DPAPI. Rien
  de sensible n'est stocké en clair.
- **La fenêtre est verrouillée** : isolation du contexte, bac à sable, pas d'intégration Node, DevTools
  coupés en version packagée, politique de contenu stricte, navigation et pop-ups bloqués, toutes les
  permissions du navigateur refusées.
- **Ton token ne passe jamais par un proxy.** Les proxies ne servent qu'aux vérifications publiques,
  qui sont anonymes.
- **Les mises à jour sont signées.** Chaque version est vérifiée par empreinte SHA-256 *et* signature
  Ed25519 avant installation.

Les tests unitaires (`npm test`) couvrent cette logique, dont le garde-fou qui empêche de basculer en
connexion directe quand tous les proxies sont morts — ce qui exposerait ton IP.

## Construire l'exe

### Installeur pour un autre PC — le plus simple

```bash
npm run installer   # → dist\Snipe MC Setup x.y.z.exe
```

Un installeur Windows autonome, à donner tel quel. Il s'installe **par utilisateur, sans admin ni UAC**
et se désinstalle proprement depuis Windows. L'assistant propose un raccourci bureau et le lancement à
la fin ; le raccourci menu Démarrer est toujours créé.

Il fonctionne 100 % hors-ligne en réutilisant le NSIS déjà présent, et reconstruit le portable si
besoin. Pour une installation silencieuse : `"Snipe MC Setup x.y.z.exe" /S`.

Sur le PC de destination, pense à placer un `.env` à côté de `Snipe MC.exe`.

### Portable

```bash
npm run portable   # → dist\Snipe MC-portable\
```

Un dossier à copier, sans installation. Double-clic sur `Snipe MC.exe`, avec le `.env` à côté.

### Via electron-builder

```bash
npm run dist
```

Nécessite le **Mode développeur Windows** ou des droits admin (electron-builder extrait un outil qui
contient des liens symboliques). Si c'est bloqué, utilise `npm run installer`.

> L'app packagée cherche son `.env` dans cet ordre : à côté de l'exe, puis dans le dossier userData,
> puis à la racine du projet.

## Mises à jour

Côté utilisateur, **il n'y a rien à faire**. Au lancement, si une version plus récente existe, une
bannière apparaît. Un clic télécharge, l'installeur se lance en silence, l'app redémarre à jour. Un
bouton dans l'en-tête permet aussi de vérifier à la demande.

Tout passe par les releases GitHub publiques de `saliox/snipe-mc` : aucune adresse à configurer, aucun
serveur à héberger. Le fichier est rejeté si l'empreinte SHA-256 **ou** la signature ne correspond pas.

### Publier une version (mainteneur)

```bash
# 1. bumpe la version dans package.json
export SNIPE_MC_SIGN_KEY=...                    # clé privée Ed25519
npm run publish:update "Notes de la version"    # build + release GitHub
```

### Pourquoi une signature en plus du SHA-256

Le SHA-256 seul ne suffisait pas : il était servi par la **même** release GitHub que le binaire. Un
compte GitHub compromis pouvait donc publier un binaire malveillant *et* l'empreinte censée le valider.

Les manifestes portent maintenant une signature Ed25519, vérifiée avec une clé publique figée dans
`src/updatecore.js` — indépendante de GitHub. Sans signature valide, la mise à jour est refusée.

`SNIPE_MC_SIGN_KEY` est la clé privée correspondante : **elle ne doit jamais se retrouver dans le dépôt
ni sur GitHub** (gestionnaire de mots de passe ou coffre-fort). Pour en générer une paire :

```bash
node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');console.log('PUB',publicKey.export({type:'spki',format:'der'}).toString('base64'));console.log('PRIV',privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))"
```

`PUB` va dans `UPDATE_PUBLIC_KEY_B64` (`src/updatecore.js`), `PRIV` devient `SNIPE_MC_SIGN_KEY`.

> Changer de clé casse la mise à jour automatique de toutes les installations existantes tant qu'elles
> n'ont pas reçu la nouvelle clé publique. À ne faire qu'en cas de compromission suspectée.

## En ligne de commande

```bash
node src/index.js login                 # première connexion
node src/index.js whoami                # compte en cache
node src/index.js check Notch           # disponibilité d'un pseudo
node src/index.js time                  # décalage d'horloge
node src/index.js snipe Dream --at 2026-07-10T15:00:00Z --burst 8
node src/index.js snipe Dream --in 45s
node src/index.js snipe Dream --monitor
```

| Option | Défaut | Rôle |
|---|---|---|
| `--at <ISO>` | — | Instant du drop, en UTC |
| `--in <durée>` | — | Alternative relative : `90s`, `15m`, `2h` |
| `--monitor` | — | Sonde la dispo (1 req/s) et tire dès que c'est libre |
| `--burst <n>` | 6 | Nombre de requêtes dans la rafale |
| `--spacing <ms>` | 30 | Espacement entre les requêtes |
| `--lead <ms>` | 40 | Avance de la première requête sur T0 |
| `--connections <n>` | 3 | Connexions pré-chauffées |
| `--skip-ntp` | — | Ne pas synchroniser l'horloge |

## Régler le tir

**Tu prends des 429 ?** Baisse `--burst` et monte `--spacing`. Être trop agressif te bloque toi-même
pile au mauvais moment.

**`--lead` compense ta latence réseau.** Le journal affiche la latence de chaque requête : si tu es à
60 ms, mets `--lead 60`.

**Trouver l'heure du drop** est le vrai problème — Mojang a retiré l'historique public. Croise avec un
service tiers comme namemc pour avoir la seconde exacte. Sinon, le mode surveillance sert de filet.

## Structure

```
src/            le moteur, partagé par le CLI et l'app
  auth.js       Microsoft → Xbox → XSTS → Minecraft, avec cache et refresh
  mojang.js     disponibilité (publique et compte)
  ntp.js        décalage d'horloge
  sniper.js     pré-chauffe, rafale timée, mode surveillance
  index.js      le CLI
gui/            l'application Electron
  main.js       processus principal et IPC
  preload.cjs   pont sécurisé vers l'interface
  renderer/     l'interface
test/           tests unitaires (npm test)
```
