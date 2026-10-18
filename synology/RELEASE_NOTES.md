## NAS Simple Media 1.7.0 — Installation en un clic

- **ffmpeg inclus dans le paquet** : les binaires statiques `ffmpeg` 4.1 et `ffprobe` 5.2
  (GPL-3.0, sources et licence fournies) sont livrés dans `app/bin`. La lecture
  « Compatible » (HLS), l’analyse des codecs, les vignettes et les sous-titres fonctionnent
  donc dès l’installation, **sans le dépôt SynoCommunity**. Si `ffmpeg6`/`ffmpeg7` est
  installé, il reste utilisé en priorité ; `FFMPEG_PATH` permet de forcer un binaire.
- **Dossier partagé « media » créé automatiquement** : DSM le crée au démarrage et donne
  au compte de service `sc-nas-simple-media` l’accès lecture/écriture. Plus aucune commande
  `synoacltool` ni réglage d’autorisation n’est nécessaire pour ce dossier ; les
  sous-dossiers `Movies`, `Series` et `Music` sont créés et scannés au premier lancement.
- **Dépendance unique : Node.js v22** : Package Center l’installe automatiquement.
  `ffmpeg6` n’est plus une dépendance obligatoire, une installation sans SynoCommunity
  ne peut donc plus échouer. DSM 7.2 minimum (moteur SQLite intégré à Node).
- **Port 8096 déclaré à DSM** : entrée `8096/tcp` dans les services du pare-feu et de la
  redirection de ports, accès direct via le bouton « Ouvrir » de Package Center.
- **Configuration générée à l’installation** : `etc/nas-simple-media.env` (chemin des
  médias, données, port, mot de passe initial, proxy, transcodage) est écrit puis conservé
  lors des mises à jour. `ADMIN_PASSWORD=changeme` impose le changement au premier login.
- **Mises à jour sûres** : sauvegarde automatique de `library.db` dans `var/backups`
  avant chaque mise à niveau (5 dernières conservées), redémarrage attendu sur `/health`,
  rotation du journal à 5 Mo.
- **Diagnostic intégré** : `var/INSTALLATION.txt` récapitule l’URL, le compte, les dossiers
  et le ffmpeg utilisé ; l’interface web affiche un avertissement si ffmpeg manque.
- **Documentation embarquée** : `app/docs/{README,DOP,env.example,LICENSE,RELEASE_NOTES}.md`.
- **Limites connues** : paquet `geminilake` (DS220+, DS420+, DS720+, DS920+…) ; DSM
  demande d’autoriser les éditeurs tiers pour installer un paquet non signé ; les dossiers
  existants (hors partage « media ») nécessitent toujours l’autorisation de lecture pour
  `sc-nas-simple-media` (expliqué dans l’interface et dans le rapport d’installation) ;
  le ffmpeg embarqué est volontairement ancien (décodage HEVC 10 bits et encodage VAAPI,
  pas d’AV1).

## NAS Simple Media 1.6.1 — Cohérence de la documentation et de la publication

- **Configuration documentée** : `.env.example` rassemble les variables de configuration
  et de sécurité utiles au déploiement.
- **README corrigé** : version courante et nom du paquet SPK alignés sur `1.6.1` ;
  les indications sur le mot de passe d’usine sont explicites.
- **`changeme`** : le rappel concerne uniquement le mot de passe d’usine du compte `admin`
  lorsqu’il est encore utilisé, pas les autres mots de passe.
- **Android** : le code source envoie l’User-Agent `NASMedia-Android/0.2.0`. L’APK 0.2.0
  déjà publié n’a pas été recompilé et conserve l’User-Agent `0.1` ; cette release ne
  republie pas l’application Android.

## NAS Simple Media 1.6.0 — Sécurité (phase 0)

- **Mot de passe par défaut** : un compte qui utilise encore `changeme` doit le changer
  à la première connexion (imposé par le serveur ; l’appli Android renvoie vers le web).
- **Mots de passe** : 10 caractères minimum pour tout nouveau mot de passe (les anciens
  continuent de fonctionner).
- **Sessions** conservées dans SQLite : un redémarrage du NAS ne déconnecte plus personne ;
  déconnexion et changement de mot de passe invalident réellement les sessions.
- **Secret** aléatoire généré dans le dossier de données (`session.secret`), plus dérivé
  du mot de passe admin.
- **Cookie** `HttpOnly`, `SameSite=Lax`, `Secure` en HTTPS. **HSTS** uniquement en HTTPS.
  **CSP** stricte (aucun script inline) et anti-iframe.
- **Proxy** : seuls les proxys locaux sont crus (`TRUST_PROXY_HOPS`), l’IP cliente ne
  peut plus être falsifiée depuis Internet. Limites de débit par IP sur la connexion et
  les liens publics, verrouillage temporaire d’un compte après 10 échecs (hors réseau local).
- **Partages** : le mot de passe n’apparaît plus jamais dans les URL (jeton signé de courte
  durée, cookie dédié) ; les anciens liens `?password=` restent acceptés pendant la transition.
  Les réponses publiques ne contiennent plus les chemins du NAS.
- `/api/setup/status` ne révèle l’état du mot de passe par défaut qu’au réseau local.

## NAS Simple Media 1.5.1 — Diagnostic Tailscale sécurisé

- Bouton **Vérifier Tailscale** dans Administration → Accès externe.
- Diagnostic réservé à l’administrateur, exécuté avec les droits du paquet :
  client installé, version, connexion et configuration Funnel ciblant le serveur.
- Lecture seule : aucune activation, aucun changement de permissions ou d’URL,
  aucune commande sudo. Délais et sorties bornés, résultat conservé 15 secondes.
- Accès refusé et réponses non reconnues signalés sans exposer la sortie brute.
- Les droits d’activation et l’autorisation HTTPS/Funnel restent non confirmés.
- Guide corrigé : Serve est privé ; Funnel permet l’accès public sans Tailscale
  chez les proches, avec comptes applicatifs et limites de débit.
- Aucun changement des privilèges du paquet et aucune publication à l’installation.

## NAS Simple Media 1.5.0 — Explorateur NAS/USB intégré & Accès Externe clé en main

> **Thème :** plus besoin de taper un chemin Linux, et les liens de partage
> fonctionnent enfin en 4G/5G.

### 🗂️ Explorateur de dossiers serveur intégré (File Explorer)

- Nouveau `GET /api/admin/fs?path=…` : **volumes et disques détectés automatiquement**
  (`MEDIA_PATH`, `/volume1`…`/volume4`, `/volumeUSB1`…`/volumeUSB4` + leurs dossiers
  `usbshare*`, `/volumeSATA*`, `/media`, `/mnt`, dossiers des bibliothèques existantes)
  affichés en **boutons d'accès rapide**.
- Dans la modale **Bibliothèque**, le navigateur s'ouvre automatiquement :
  bouton **⬆ Parent**, **✓ Utiliser ce dossier**, **🏠 MEDIA_PATH**, compteur de
  **médias présents dans le dossier courant** (et par sous-dossier), rechargement à la demande.
- Les dossiers techniques Synology (`@eaDir`, `#recycle`, `@tmp`, `@appstore`, fichiers
  cachés, `$RECYCLE.BIN`, `System Volume Information`, `lost+found`) sont masqués.
- Dossier protégé (`EACCES`/`EPERM`) → badge **🔒 Accès DSM requis** et mode d'emploi
  exact : *Panneau de configuration → Dossier partagé → Autorisations → Utilisateur interne
  du système → Lecture pour `sc-nas-simple-media`*.

### 🔎 Résolution intelligente des chemins Synology (File Station)

- `/usbshare1-2/Films` → `/volumeUSB1/usbshare1-2/Films`
- `/usbshare1/Films` → `/volumeUSB1/usbshare/Films` (`usbshare1` sur DSM 7)
- `/video/Films`, `/music/…`, `/photo/…` → `/volume1/…`
- Les chemins réels restent prioritaires s'ils existent (compatibilité Docker `/media`,
  `/music`…), et la liste noire des dossiers système (`/etc`, `/proc`, `/dev`…) est conservée.

### 🌐 Accès externe & liens de partage publics

- **Support natif Reverse Proxy / DDNS** : `trust proxy` + `X-Forwarded-Proto` /
  `X-Forwarded-Host` (et en-tête RFC 7239 `Forwarded`) → liens de partage, flux `.m3u`
  VLC et QR codes utilisent automatiquement `https://mon-nas.synology.me`
  (DSM Reverse Proxy, Cloudflare Tunnel, Tailscale, nginx). `TRUST_PROXY=0` pour désactiver.
- **Nouveau panneau `Administration → 🌐 Accès externe`** (`GET /api/admin/network`) :
  URL locale détectée (`http://<ip-lan>:8096`), URL publique active, détection du proxy
  inversé, **détection de l'IP publique**, champ éditable en 1 clic et bouton
  **📱 Tester / QR Code d'accès mobile**.
- **Guide pas-à-pas en français** dans l'écran : ① DDNS `*.synology.me` + Proxy inversé DSM
  (HTTPS gratuit, port 8096 non exposé), ② ouverture de port Box (NAT/PAT), ③ sans ouvrir
  de port (Tailscale / Cloudflare Tunnel).
- La modale de partage **avertit** quand le lien généré est encore privé
  (`localhost`, `192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`, `100.64-127.x`, `*.local`) avec un
  bouton direct **« Configurer l'adresse externe »**.

### 🚀 Démarrage guidé

- **Scan automatique** à la création et à la modification d'une bibliothèque
  (`POST` / `PATCH /api/admin/libraries`) : la réponse indique
  `scan: {scanned, added, updated, removed}`.
- Accueil **assistant de démarrage** quand 0 média est indexé :
  *📁 Choisir mes dossiers Films/Séries/Musique*, *⟳ Scanner maintenant*,
  *🌐 Configurer l'accès externe*.
- Page de connexion : indication discrète tant que le compte par défaut
  (`admin` / `changeme`) est actif.

### 🧪 Qualité

- `npm test` : **122 tests**, 0 échec (nouveaux tests explorateur NAS/USB, alias
  `/usbshare*`, `X-Forwarded-Proto`/`Host` sur les liens de partage, panneau réseau,
  scan automatique, statut de première connexion).
- `npx tsc --noEmit` : OK · `npm run spk` : `dist-spk/nas-simple-media-1.5.0-geminilake.spk`.

---

## NAS Simple Media 1.4.0 — paquet natif DSM 7 pour Synology DS220+

### Nouveautés 1.4.0 — interface « Plex like »

- **Sidebar** façon Plex : Accueil, Bibliothèques (+ compteurs), Partages, Admin
- Rails d'accueil **Reprendre** / **Récemment ajoutés**, posters 2:3 avec
  barre de progression et badge « NOUVEAU »
- Page détail **preplay** : backdrop flouté, poster, badges codecs, reprise proposée
- **Lecteur cinéma** plein écran (OSD auto-masqué), navigation chapitres
- **Tri Films** : Titre A→Z / Z→A, Ajoutés récemment, Plus volumineux
- Thème sombre + accent orange, responsive mobile (sidebar off-canvas)

## NAS Simple Media 1.3.0 — paquet natif DSM 7 pour Synology DS220+

Paquet **natif** (sans Docker) ciblant la **DS220+** — arch `geminilake`, DSM 7.x,
port **8096**, service exécuté sous l'utilisateur dédié `sc-nas-simple-media`.

### Nouveautés 1.3.0 — moteur Plex-like + Surround 5.1

- **Détection DTS / 5.1** : analyse ffprobe des vrais codecs (DTS, DTS-HD MA,
  TrueHD, AC-3, E-AC-3, FLAC 5.1/7.1, HDR), mise en cache, badges dans l'UI
- **Compatible Surround** : DTS/TrueHD → **AAC 5.1** (au lieu de stéréo forcée),
  sélecteur Stéréo / Surround / Original par piste audio
- **Remux direct** : vidéo H.264 copiée sans ré-encodage (~5 % CPU au lieu de ~200 %)
- **Qualités** Original / 1080p / 720p / 480p, **sous-titres** WebVTT intégrés
- **Reprendre** (On Deck), **Récemment ajoutés**, **miniatures**, page détail « preplay »
- **Dashboard** admin des transcodages en cours (arrêt possible)
- Accélération matérielle optionnelle QSV / VAAPI (`TRANSCODE_HWACCEL`)

### Téléchargement

| Fichier | Arch | Taille |
|---|---|---|
| `nas-simple-media-1.3.0-geminilake.spk` | geminilake (DS220+/DS420+/DS720+/DS920+) | ~3,9 Mio |

### Installation

**1. Autoriser les éditeurs tiers**
Centre de paquets → Paramètres → Général → Niveau de confiance → **Tous les éditeurs**.

**2. Installer les dépendances**

| Paquet | Source | Pourquoi |
|---|---|---|
| **Node.js v22** | Synology (DSM **7.2** minimum) | Moteur JS ; `node:sqlite` est intégré à Node ≥ 22.5 |
| **ffmpeg6** | [SynoCommunity](https://packages.synocommunity.com) | Transcodage « Compatible » (HLS, Remux direct, AAC Stéréo/5.1), **ffprobe** (DTS/5.1), miniatures, sous-titres |

Dépôt SynoCommunity : Centre de paquets → Paramètres → Sources de paquets → Ajouter
→ `https://packages.synocommunity.com`

**3. Installer le paquet**
Centre de paquets → **Installation manuelle** → sélectionner le `.spk`.

**4. Donner l'accès aux médias (ACL) — obligatoire**
Panneau de configuration → Dossier partagé → Modifier → Autorisations →
accorder **lecture** à `sc-nas-simple-media` sur vos dossiers de médias.
Sans cette ACL, le scanner ne voit aucun fichier.

**5. Ouvrir** `http://IP-DU-NAS:8096` → `admin` / mot de passe `ADMIN_PASSWORD`
(configurable dans `/var/packages/nas-simple-media/etc/nas-simple-media.env`).

### Notes techniques

**Dépendance Node.js.** Le paquet déclare `Node.js_v22` et non `nodejs20`.
`nodejs20` n'existe pas chez SynoCommunity, qui ne publie aucun paquet Node :
Node.js est fourni **par Synology** sous les noms `Node.js_v20` / `Node.js_v22`,
disponibles à partir de DSM 7.2. La version 22 est nécessaire car c'est elle qui
embarque le moteur SQLite intégré.

**Moteur SQLite.** DSM 7.2 embarque **glibc 2.26**. Le module natif
`better-sqlite3` précompilé exige **GLIBC 2.36** (`arc4random`,
`_dl_find_object`) et DSM n'a pas de compilateur pour le reconstruire sur place.
Le paquet utilise donc `node:sqlite`, intégré à Node 22 — **zéro code natif,
zéro dépendance glibc**. Un repli automatique sur `better-sqlite3` existe pour
les runtimes plus anciens (image Docker sur Node 20), dont le comportement est
inchangé. `NAS_SM_SQLITE_BACKEND` permet de forcer un moteur pour diagnostiquer.

**Migration base.** Les nouvelles tables `media_probe` (cache ffprobe) et
`playback_progress` (reprise de lecture) sont créées automatiquement au premier
démarrage (`CREATE TABLE IF NOT EXISTS`) — aucune action requise.

### Vérifications

- `npm test` : **92 tests**, tous verts (dont analyse ffprobe, moteur de décision,
  profils ffmpeg, progression/reprise, et 22 tests de packaging)
- `npm run build` : OK
- Test de bout en bout : extraction du `.spk`, démarrage via `run.sh`, scan de bibliothèque, authentification, API `/api/media`, arrêt gracieux par SIGTERM

### Chemins utiles

| Chemin | Contenu |
|---|---|
| `/var/packages/nas-simple-media/target/app/` | Application |
| `/var/packages/nas-simple-media/etc/nas-simple-media.env` | Configuration |
| `/var/packages/nas-simple-media/var/` | Base SQLite, partages, caches (HLS, miniatures, sous-titres) |
| `/var/packages/nas-simple-media/var/nas-simple-media.log` | Journal du service |
