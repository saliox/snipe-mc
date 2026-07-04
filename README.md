# snipe-mc

Sniper de pseudos Minecraft (comptes Microsoft / Java), en **application de bureau
(Electron)** et en **CLI**. Quand un pseudo est libéré (37 jours après un changement
de nom), l'app le réclame à la seconde près sur **ton propre compte**, via des
connexions pré-chauffées et une horloge synchronisée en NTP.

> ⚠️ Le snipe ne fait que **changer le nom de ton compte** via l'API officielle
> Minecraft. Ça ne touche à aucun compte tiers. Respecte le rate limit de Mojang.

## Sécurité

- **Tokens chiffrés au repos** : le cache de login Microsoft est chiffré (AES-256-GCM,
  clé liée à la machine+utilisateur) dans le dossier userData ; les comptes
  enregistrés sont chiffrés via DPAPI (`safeStorage`). Rien de sensible en clair.
- **Renderer verrouillé** : `contextIsolation`, `sandbox`, `nodeIntegration:false`,
  `webviewTag:false`, DevTools coupés en version packagée, **CSP** stricte
  (`default-src 'none'`), navigation et pop-ups bloqués, toutes les permissions
  (caméra/micro/géo/notifs) refusées.
- **Token jamais exposé** : les proxies ne voient jamais ton bearer token (checks
  publics anonymes seulement) ; il ne passe pas non plus par un proxy.
- **Auto-update signé par empreinte** : chaque MAJ est vérifiée par **SHA-256**
  avant installation (Releases GitHub publiques).

## Deux façons de l'utiliser

- **App fenêtrée** (`.exe`) : interface **style terminal** (« MINECRAFT SNIPER »),
  console en direct, et tous les outils ci-dessous.
- **CLI** : snipe/check en ligne de commande (voir plus bas).

## Fonctionnalités de l'app

- **Token** — colle un *bearer token* Minecraft (access token) pour agir sans passer
  par le login Microsoft. Le pseudo du compte s'affiche une fois le token validé.
  (Ou clique **MS LOGIN** pour le device-code classique.)
- **Change Username** — saisis un pseudo et clique **CHANGE USERNAME** : renomme le
  compte du token actif (utile pour prendre un pseudo repéré). Cooldown Java 30 j.
- **Bulk check** — colle une liste (ou **LOAD .TXT**, un pseudo par ligne) et
  **CHECK ALL** : vérifie chaque pseudo un par un (LIBRE / PRIS / INVALIDE), délai
  réglable, recul auto sur rate-limit, option *statut compte* (AVAILABLE/NOT_ALLOWED),
  et **EXPORT LIBRES** vers un `.txt`.
- **Generate** — génère des pseudos de N lettres (3, 4, …), charset `a-z` / `a-z0-9`
  / `+_`, en aléatoire (count) ou *tout énumérer* (petits espaces) → remplit le bulk.
- **Check 1 pseudo** — vérif rapide d'un seul pseudo (public Mojang + statut compte).
- **Snipe** — un pseudo précis : mode *surveillance* (dès que libre), *planifié* (date)
  ou *dans X* (45s/15m/2h), rafale timée NTP + réglages avancés (burst, spacing, lead,
  connexions, skip-NTP). Bouton **test horloge (NTP)** pour mesurer le décalage.
- **Auto-update** intégré (voir plus bas).

## Fonctionnement

1. **Auth** — connexion Microsoft en *device code*, puis chaîne Xbox Live → XSTS →
   Minecraft services. Token mis en cache et rafraîchi tout seul (`data/token.json`).
2. **Dispo** — API publique Mojang *et* API du compte (`AVAILABLE` / `DUPLICATE` /
   `NOT_ALLOWED`).
3. **Timing** — décalage d'horloge mesuré par NTP (`time.google.com`, `cloudflare`,
   `pool.ntp.org`) et corrigé au tir.
4. **Snipe** — pré-chauffe les sockets TLS ~10 s avant le drop, puis envoie une
   rafale de `PUT /minecraft/profile/name/{name}` autour de T0. Stoppe au 1er `200`.

## Installation (dev)

```bash
cd "C:\Users\teamf\snipe mc"
npm install
copy .env.example .env      # puis renseigne MS_CLIENT_ID (voir .env.example)
npm start                   # lance l'app Electron
```

Il faut une **app Azure AD** (public client, scope `XboxLive.signin`) approuvée
pour Minecraft — étapes dans `.env.example`. Si `login_with_xbox` renvoie
`403 "Invalid app registration"`, fais approuver l'app via https://aka.ms/mce-reviewappid.

## Construire l'exe

### Installeur pour un autre PC (Setup.exe) — recommandé

```bash
npm run installer   # -> dist\Snipe MC Setup 1.0.0.exe  (~81 Mo)
```
Produit un **installeur Windows autonome** (NSIS) à donner à quelqu'un. Il s'installe
**par utilisateur, sans admin ni UAC** (`%LOCALAPPDATA%\Programs\Snipe MC`) et
s'enregistre dans « Applications installées » (désinstallation propre via Windows
ou `Uninstall.exe`).

L'assistant **propose** à l'utilisateur :
- une case **« Raccourci sur le bureau »** sur la page *Composants* (cochée par défaut) ;
- une case **« Lancer Snipe MC »** sur la page finale.

Un raccourci **Menu Démarrer** (app + désinstalleur) est toujours créé.

- 100% hors-ligne : utilise le NSIS déjà présent (cache electron-builder ou NSIS
  système / `NSIS_DIR`). Aucun droit admin requis.
- `npm run installer` reconstruit d'abord le portable si besoin.
- Sur le PC de destination : double-clic sur le Setup, puis place un fichier `.env`
  (voir `.env.example`) **à côté de `Snipe MC.exe`** dans le dossier installé.

Options silencieuses : `"Snipe MC Setup 1.0.0.exe" /S` (installe sans UI).

### Portable (dossier à copier, sans installation)

```bash
npm run portable   # -> dist\Snipe MC-portable\Snipe MC.exe
```
Copie/partage le dossier `dist\Snipe MC-portable\` ; double-clic sur **Snipe MC.exe**.
Place le `.env` à côté de l'exe.

### Via electron-builder (installeur signé + auto-update possible)

```bash
npm run dist       # -> dist\Snipe MC Setup x.y.z.exe + portable
```
Nécessite le **Mode développeur Windows** ou des **droits admin** (electron-builder
extrait un outil contenant des symlinks). Active le Mode développeur : Paramètres →
Confidentialité et sécurité → Espace développeurs. Si bloqué, utilise `npm run installer`.

> **`.env` de l'app packagée** : l'app le cherche, dans l'ordre, à côté de
> `Snipe MC.exe`, puis dans le dossier userData, puis à la racine du projet (dev).

## Mises à jour automatiques (auto-hébergées)

L'app se met à jour toute seule depuis **un PC de ton choix** (pas de cloud). Ce PC
héberge les nouvelles versions ; chaque app cliente vérifie au démarrage, télécharge
et installe.

### Sur le PC qui héberge

```bash
# 1. bumper la version dans package.json (ex. 1.0.0 -> 1.0.1)
npm run publish:update "Notes de la version"   # build l'installeur + release\latest.json (SHA-256)
npm run serve:updates                            # sert release\ sur le LAN (port 8770)
```
`serve:updates` affiche les URL à utiliser, ex. `http://192.168.1.50:8770/`. Laisse-le
tourner (ou mets-le en tâche/pm2). Le pare-feu Windows peut demander d'autoriser Node.js.

### Sur chaque PC client

Dans le `.env` (à côté de `Snipe MC.exe`), renseigne l'URL du PC hébergeur :

```
UPDATE_URL=http://192.168.1.50:8770/
```

Au lancement, si une version plus récente existe, une bannière **« Nouvelle version
disponible »** apparaît. Clic → téléchargement (barre de progression) → l'installeur
se lance en silencieux et l'app **redémarre à jour**. Bouton **« vérifier les MAJ »**
aussi dans l'en-tête.

- Intégrité vérifiée par **SHA-256** (le fichier est rejeté s'il ne correspond pas).
- Sans `UPDATE_URL`, l'auto-update est simplement désactivé.
- L'installeur étant **non signé**, la mise à jour n'est pas authentifiée
  cryptographiquement : n'héberge le flux que sur un PC/réseau de confiance.

## CLI

```bash
node src/index.js login                 # 1re connexion
node src/index.js whoami                 # compte en cache
node src/index.js check Notch            # dispo d'un pseudo
node src/index.js time                   # décalage d'horloge
node src/index.js snipe Dream --at 2026-07-10T15:00:00Z --burst 8
node src/index.js snipe Dream --in 45s
node src/index.js snipe Dream --monitor
```

| Option | Défaut | Rôle |
|---|---|---|
| `--at <ISO>` | — | Instant du drop en UTC (`2026-07-10T15:00:00Z`) |
| `--in <durée>` | — | Alternative relative : `90s`, `15m`, `2h` |
| `--monitor` | — | Poll la dispo (1 req/s) et tire dès que libre |
| `--burst <n>` | 6 | Requêtes dans la rafale |
| `--spacing <ms>` | 30 | Espacement entre requêtes |
| `--lead <ms>` | 40 | Avance de la 1re requête sur T0 |
| `--connections <n>` | 3 | Connexions pré-chauffées |
| `--skip-ntp` | — | Ne pas synchroniser l'horloge |

## Régler le tir

- **429 (rate limit)** : baisse `--burst`, monte `--spacing`. Trop agressif = tu te
  bloques toi-même au mauvais moment.
- **`--lead`** compense la latence réseau : mesure ta latence (affichée par requête
  dans le journal) et ajuste (latence 60 ms → `--lead 60`).
- **Drop time** : Mojang a retiré l'historique public. Croise avec un service tiers
  (namemc) pour la seconde exacte. Sinon le **mode surveillance** sert de filet.

## Icône (optionnel)

Dépose un `build/icon.ico` (256×256) et remets `"icon": "build/icon.ico"` sous
`build.win` dans `package.json` avant `npm run dist`.

## Structure

```
src/            moteur partagé (CLI + GUI)
  auth.js       MSA -> Xbox -> XSTS -> Minecraft (+ cache/refresh)
  mojang.js     disponibilité (public + compte)
  ntp.js        offset d'horloge SNTP
  sniper.js     pré-chauffe + rafale timée + mode surveillance
  index.js      CLI
gui/            application Electron
  main.js       processus principal + IPC
  preload.cjs   pont sécurisé
  renderer/     interface (HTML/CSS/JS)
scripts/
  build-portable.mjs   assemblage portable hors-ligne
```
