# NAS Simple Media

> Serveur média simple type Plex pour NAS Synology — **multi-utilisateurs**, bibliothèques sélectives, films / musique / séries. Docker-first. Lecture **Direct**, **Remux direct** ou **Compatible** (ffmpeg HLS, **Stéréo ou Surround 5.1**), téléchargement + **VLC**.

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Lecture : Direct, Remux direct, Compatible](#lecture--direct-remux-direct-compatible)
3. [Audio 5.1 / DTS / TrueHD](#audio-51--dts--truehd)
4. [VLC & téléchargement](#vlc--téléchargement)
5. [Comptes & bibliothèques](#comptes--bibliothèques)
6. [Organisation des dossiers](#organisation-des-dossiers)
7. [Installation Synology (Container Manager)](#installation-synology-container-manager)
8. [Installation native Synology (paquet SPK, DSM 7)](#installation-native-synology-paquet-spk-dsm-7)
9. [Accès distant (Bouygues / CGNAT)](#accès-distant-bouygues--cgnat)
10. [Variables d'environnement](#variables-denvironnement)
11. [Développement local](#développement-local)
12. [Parité Plex & limites](#parité-plex--limites)
13. [Appli Android (téléphone & Android TV)](#appli-android-téléphone--android-tv)

📘 **Mode opératoire pas-à-pas (admin & invités) : [docs/DOP.md](docs/DOP.md)**

---

## Nouveautés 1.5.1 — Diagnostic Tailscale en lecture seule

- **Administration → Accès externe → Vérifier Tailscale** : installation, version,
  connexion et configuration Funnel, sans activation ni élévation des droits.
- Distinction explicite entre **Serve privé** et **Funnel public** dans le guide.
- Les autorisations d’activation et l’accessibilité Internet restent à vérifier sur le NAS.

## Nouveautés 1.5.0 — Explorateur NAS/USB & Accès externe

- 🗂️ **Explorateur de dossiers intégré** : volumes et disques USB détectés automatiquement
  (`/volume1…4`, `/volumeUSB1…4` + `usbshare*`, `/volumeSATA*`, `/media`, `/mnt`, `MEDIA_PATH`),
  compteur de médias par dossier, bouton **⬆ Parent**, badge **🔒 Accès DSM requis** avec le
  mode d'emploi ACL quand un dossier est protégé. Plus besoin de taper un chemin Linux.
- 🔎 **Chemins File Station** acceptés : `/usbshare1-2/Films` → `/volumeUSB1/usbshare1-2/Films`,
  `/usbshare1/Films` → `/volumeUSB1/usbshare/Films`, `/video/Films` → `/volume1/video/Films`.
- 🌐 **Accès externe clé en main** : panneau `Admin → 🌐 Accès externe` (URL locale, IP publique,
  proxy inversé détecté, QR code d'accès mobile) et **guide pas-à-pas** : DDNS Synology +
  Proxy inversé DSM (HTTPS gratuit), ouverture de port Box (NAT/PAT 8096), ou tunnel
  Tailscale / Cloudflare (aucun port ouvert). Les liens de partage, `.m3u` VLC et QR codes
  suivent automatiquement `X-Forwarded-Proto` / `X-Forwarded-Host`, et un avertissement
  s'affiche si le lien reste en adresse privée (`localhost`, `192.168.x.x`, `10.x.x.x`…).
- 🚀 **Démarrage guidé** : scan automatique à la création/modification d'une bibliothèque,
  assistant sur l'accueil quand 0 média est indexé, rappel de première connexion sur la page
  de login tant que `admin` / `changeme` est actif.

---

## Fonctionnalités

- Bibliothèques **Films / Séries / Musique** (chemin + type)
- **Explorateur NAS/USB** dans la modale Bibliothèque (chemins File Station acceptés)
- **Multi-utilisateurs** + ACL par bibliothèque
- **Analyse ffprobe** : vrais codecs, **DTS / DTS-HD / TrueHD / AC-3 / 5.1 / 7.1 / HDR** détectés et mis en cache
- Lecture HTML5 + **HTTP Range** (seek) + **ETag / If-Range**
- **Mode Direct** : fichier original (codecs natifs navigateur)
- **Remux direct** (type Plex) : vidéo **copiée sans ré-encodage** quand elle est compatible — quasi gratuit en CPU
- **Mode Compatible** : ffmpeg → HLS, qualités **Original / 1080p / 720p / 480p**, audio **Stéréo ou Surround 5.1**, choix de la piste audio
- **Sous-titres** intégrés extraits en WebVTT (SRT/ASS/MOV_TEXT), sélection dans le lecteur
- **Interface façon Plex** : sidebar (Accueil, Bibliothèques + compteurs, Partages, Admin), rails **Reprendre** / **Récemment ajoutés**, posters 2:3 + barre de progression, prévisualisation listes 16:9, **tri Films** (Titre A→Z / Z→A, Ajoutés récemment, Plus volumineux)
- Page **détail « preplay »** façon Plex : **backdrop flouté**, poster, badges de codecs, pistes audio/sous-titres, reprise proposée
- **Lecteur cinéma** plein écran : OSD haut/bas qui s’efface, navigation pistes audio / sous-titres / chapitres, **Reprendre** (On Deck), **Récemment ajoutés**, **miniatures** vidéo, **dashboard** des transcodages (admin)
- **Télécharger** le fichier original + **Ouvrir dans VLC** (URL / `.m3u`)
- Liens de partage `/s/<jeton>` (expiration, max uses, mot de passe) avec lecture / DL / VLC / Compatible Surround
- Rescan + file watch optionnel
- Docker multi-arch **amd64 / arm64** (image avec **ffmpeg + ffprobe**)

**Hors scope :** DLNA, TMDB/jaquettes Internet, apps mobiles, live TV, bitstream DTS/TrueHD dans le navigateur (impossible techniquement — voir ci-dessous).

---

## Lecture : Direct, Remux direct, Compatible

Comme Plex, le serveur choisit le chemin le moins cher selon les **vrais codecs** (ffprobe) :

| Mode | Quoi | Charge NAS | Quand |
|------|------|------------|-------|
| **Direct** | Fichier original (`/api/stream/:id`) | Nulle | MP4/WebM H.264 + AAC/Opus |
| **Remux direct** | Reconditionnement HLS, vidéo **copiée** (`-c:v copy`), audio converti si besoin | Faible | MKV H.264 + DTS/AC3 → HLS + AAC |
| **Compatible** | Ré-encodage H.264 + AAC (`/api/stream/:id/hls?quality=&audio=&surround=`) | Forte | HEVC/AV1/VP9, changement de qualité, downmix |

- L’UI affiche le badge **⚙ Remux direct / Transcodage** et son explication à chaque lecture Compatible.
- Si Direct échoue sur un conteneur dur, bascule auto vers Compatible.
- Sur Synology, le CPU est souvent faible : `TRANSCODE_MAX_JOBS=1` (défaut). Le **Remux direct** change la donne pour les MKV H.264 : ~5 % CPU au lieu de ~200 %.

---

## Audio 5.1 / DTS / TrueHD

Les navigateurs **ne décodent pas** le DTS / TrueHD / AC-3 en bitstream (aucun décodeur, sauf AC-3/E-AC-3 sous Safari). La stratégie, comme Plex :

| Source | Direct (navigateur) | Compatible Stéréo (défaut) | Compatible **Surround 5.1** | VLC |
|--------|---------------------|----------------------------|------------------------------|-----|
| DTS / DTS-HD MA 5.1 | ✗ (pas de son) | **AAC stéréo** (downmix) | **AAC 5.1** 384k (surround préservé) | ✓ bitstream original |
| TrueHD 7.1 / 5.1 | ✗ | AAC stéréo | **AAC 5.1** | ✓ bitstream original |
| AC-3 / E-AC-3 5.1 | ✗ (sauf Safari) | AAC stéréo | **AAC 5.1** (ou passthrough Safari, optionnel) | ✓ bitstream original |
| FLAC 5.1 / Opus 5.1 | variable | AAC stéréo | **AAC 5.1** | ✓ original |
| AAC/MP3 stéréo | ✓ | copié | copié | ✓ |

- Le sélecteur **Audio** du lecteur propose chaque piste en **Stéréo** et, si elle est multicanal, en **Surround 5.1**. Changer de piste relance la session HLS (comme Plex en transcodage) en conservant la position.
- `TRANSCODE_SURROUND_CODEC=eac3` permet de générer du **E-AC-3 5.1** au lieu de l’AAC (utile côté Safari/Apple TV) ; `TRANSCODE_AUDIO_PASSTHROUGH=true` autorise le **passthrough AC-3/E-AC-3** (`?passthrough=1`, Safari/TV uniquement).
- Pour le **bitstream exact** (DTS:X, Atmos…) : **VLC** via le bouton dédié (URL authentifiée + QR code).
- L’analyse ffprobe est **mise en cache** (table `media_probe`, clé mtime+taille) : un seul passage rapide par fichier, puis instantané.

---

## VLC & téléchargement

- **Télécharger** → `GET /api/media/:id/download` (auth) — `Content-Disposition: attachment`, fichier original.
- **Ouvrir dans VLC** → URL HTTP avec jeton (`/api/stream/:id/raw?token=…`) + aide (Média → Ouvrir un flux réseau, ou `vlc "<url>"`).
- **Playlist `.m3u`** → pointe vers l’URL authentifiée pour double-clic dans VLC.
- Les partages `/s/…` exposent aussi téléchargement, VLC et Compatible lorsque le lien autorise la lecture.

---

## Comptes & bibliothèques

### Premier démarrage

- Compte **`admin`** avec le mot de passe `ADMIN_PASSWORD`.
- Bibliothèques par défaut : `Films` → `Movies/`, `Séries` → `Series/`, `Musique` → `Music/` (sous `MEDIA_PATH`).

### Rôles

| Rôle    | Droits |
|---------|--------|
| `admin` | Tout : users, bibliothèques, grants, rescan, tous les partages |
| `user`  | Parcourir / lire ses bibliothèques ; liens item si `can_share` |

Stream / download / HLS respectent toujours l’ACL bibliothèque.

---

## Organisation des dossiers

```text
/volume1/media/
├── Movies/
│   └── Inception (2010)/Inception.mkv
├── Series/
│   └── Breaking Bad/Breaking.Bad.S01E01.mkv
└── Music/
    └── Daft Punk/Discovery/01 - One More Time.mp3
```

Extensions : vidéo `mp4 mkv avi webm m4v` · audio `mp3 flac m4a opus wav`.  
Caches : transcodage `DATA_PATH/cache/transcode/<id>[-profil]/` (nettoyage TTL), miniatures `cache/thumbs/`, sous-titres `cache/subs/`, analyse codecs en base (`media_probe`).

---

## Installation Synology (Container Manager)

1. Copiez le projet sous `/volume1/docker/nas-simple-media/`.
2. Créez `.env` :

```env
ADMIN_PASSWORD=UnMotDePasseFort
PUBLIC_BASE_URL=http://192.168.1.50:8096
TRANSCODE_ENABLED=true
TRANSCODE_MAX_JOBS=1
```

3. Adaptez `docker-compose.yml` (chemins host).
4. Build & start :

```bash
cd /volume1/docker/nas-simple-media
sudo docker compose up -d --build
```

5. Ouvrez `http://IP-NAS:8096` → `admin` / votre mot de passe.
6. **Admin · Bibliothèques** → Rescan ; **Admin · Comptes** → grants.

L’image Docker installe **ffmpeg**. Pare-feu DSM : **8096/TCP** en LAN. Pour Internet : Tailscale ou Cloudflare Tunnel.

---

## Installation native Synology (paquet SPK, DSM 7)

Paquet natif ciblant la **DS220+** (arch `geminilake`, DSM 7.x), sans Docker.

### 1. Autoriser les éditeurs tiers

**Centre de paquets → Paramètres → Général → Niveau de confiance → *Tous les éditeurs***.

Sans ce réglage, DSM refuse d’installer un paquet non signé par Synology.

### 2. Installer les dépendances

| Paquet | Source | Pourquoi |
|---|---|---|
| **Node.js v22** | Synology (DSM **7.2** minimum) | Moteur JavaScript. `node:sqlite` est intégré à Node ≥ 22.5 : **aucun module natif à compiler**. |
| **ffmpeg6** | [SynoCommunity](https://packages.synocommunity.com) | Transcodage « Compatible » (HLS, Remux direct, AAC Stéréo/5.1), **ffprobe** (détection DTS/5.1), miniatures, sous-titres. |

```bash
# Dépôt SynoCommunity (pour ffmpeg6) :
#   Centre de paquets → Paramètres → Sources de paquets → Ajouter
#   Nom      : SynoCommunity
#   Emplacement : https://packages.synocommunity.com
```

> **Note sur `nodejs20`** — le paquet SPK déclare `Node.js_v22` et non `nodejs20`.
> `nodejs20` n’existe pas chez SynoCommunity (qui ne publie aucun paquet Node) :
> Node.js est fourni **par Synology**, sous les noms `Node.js_v20` et `Node.js_v22`,
> disponibles à partir de DSM 7.2. La version 22 est requise parce que c’est elle
> qui embarque le moteur SQLite intégré — c’est ce qui rend le paquet installable
> sur une DSM dont la glibc (2.26) est trop ancienne pour les binaires natifs
> précompilés de `better-sqlite3`.

### 3. Installer le paquet

**Centre de paquets → Installation manuelle →** sélectionner
`nas-simple-media-1.3.0-geminilake.spk`.

Le service démarre automatiquement sur le port **8096**.

### 4. Donner l’accès aux médias (ACL) — *étape obligatoire*

Le service tourne sous l’utilisateur dédié **`sc-nas-simple-media`** (jamais root).

**Panneau de configuration → Dossier partagé → Modifier → Autorisations**
→ accordez **lecture** (et parcours) sur `sc-nas-simple-media` pour vos dossiers de médias.

> Sans cette ACL, le scanner ne voit aucun fichier. C’est le seul réglage manuel requis.

### 5. Ouvrir l’interface

`http://IP-DU-NAS:8096` → identifiant **`admin`**, mot de passe = `ADMIN_PASSWORD`
(valeur par défaut `changeme`, à changer dans
`/var/packages/nas-simple-media/etc/nas-simple-media.env`).

### Chemins utiles

| Chemin | Contenu |
|---|---|
| `/var/packages/nas-simple-media/target/app/` | Application (Node.js + `node_modules`) |
| `/var/packages/nas-simple-media/etc/nas-simple-media.env` | Configuration |
| `/var/packages/nas-simple-media/var/` | Base SQLite, métadonnées de partage, cache HLS |
| `/var/packages/nas-simple-media/var/nas-simple-media.log` | Journal du service |
| `/var/packages/nas-simple-media/scripts/start-stop-status` | Contrôle manuel du service |

```bash
# Redémarrer / arrêter / état
sudo /var/packages/nas-simple-media/scripts/start-stop-status restart
sudo /var/packages/nas-simple-media/scripts/start-stop-status stop
sudo /var/packages/nas-simple-media/scripts/start-stop-status status
```

### Variables d’environnement du paquet

Identiques à la section [Variables d’environnement](#variables-denvironnement), plus :

| Variable | Défaut | Rôle |
|---|---|---|
| `NAS_SM_SQLITE_BACKEND` | *(vide)* | Force le moteur SQLite : `node:sqlite` ou `better-sqlite3`. Laisser vide pour l’auto-détection. Utile pour diagnostiquer une installation. |

### Construire le paquet soi-même

```bash
npm ci
npm test          # 122 tests
npm run build
npm run spk       # -> dist-spk/nas-simple-media-1.5.1-geminilake.spk
```

Le `.spk` n’est **jamais** commité : c’est un artefact de release, publié sur
[GitHub Releases](https://github.com/alexissmartconnect-art/nas-simple-media-/releases).

---

## Accès distant (Internet / 4G / 5G)

Le serveur détecte **tout seul** l'adresse à mettre dans les liens de partage : URL locale
(`http://<ip-lan>:8096`), `PUBLIC_BASE_URL` et en-têtes de proxy inversé
(`X-Forwarded-Proto`, `X-Forwarded-Host`, `Forwarded`). Un guide pas-à-pas est intégré dans
l'interface : **Administration → 🌐 Accès externe**. Trois options :

### Option 1 — DDNS Synology `*.synology.me` + Proxy inversé DSM (recommandé)

HTTPS gratuit (Let's Encrypt), le port 8096 n'est **jamais** exposé à Internet.

1. Panneau de configuration → Accès externe → **DDNS** → Synology, `mon-nas.synology.me`.
2. Panneau de configuration → Portail de connexion → Avancé → **Proxy inversé** :
   source `HTTPS` / `mon-nas.synology.me` / `443` → destination `HTTP` / `localhost` / `8096`.
3. Sécurité → **Certificat** (Let's Encrypt) affecté au service proxy inversé.
4. Box : rediriger `443` (et `80` pour le renouvellement du certificat) vers le NAS.
5. Dans l'UI : coller `https://mon-nas.synology.me` → **Enregistrer** → **📱 Tester / QR Code**.

### Option 2 — Ouverture de port sur la Box (NAT/PAT 8096)

Box → NAT/PAT : port externe `8096` → IP locale du NAS (`TCP`), puis utiliser
`http://<ip-publique>:8096` (l'IP publique est détectée par le panneau réseau). Trafic HTTP
en clair : à éviter hors test. Si le port 8096 est exposé directement, `TRUST_PROXY=0`
empêche qu'un client forge les en-têtes `X-Forwarded-*`.

### Option 3 — Sans ouvrir de port (Tailscale / Cloudflare Tunnel)

Souvent la seule solution avec le **CGNAT** (Bouygues, Free…) :

- **Tailscale privé (Serve)** : nécessite Tailscale chez chaque invité ; ce n’est pas un accès public.
- **Tailscale public (Funnel)** : les proches utilisent seulement un lien HTTPS et leur compte
  NAS Simple Media. Une autorisation HTTPS/Funnel dans le compte Tailscale peut être nécessaire ;
  des limites de débit s’appliquent. Le service devient accessible sur Internet : changez le mot de
  passe administrateur par défaut et créez des comptes `user` avec les seules bibliothèques autorisées.
  Configuration manuelle par un administrateur Synology :
  `sudo /var/packages/Tailscale/target/bin/tailscale funnel --bg http://127.0.0.1:8096`.
  Enregistrez ensuite l’adresse HTTPS obtenue dans **Administration → Accès externe**.
  Testez en 4G/5G avec Wi-Fi et Tailscale désactivés.

- **Cloudflare Tunnel** : `cloudflared tunnel --url http://localhost:8096` (essai) ou tunnel
  nommé + domaine → `PUBLIC_BASE_URL` adapté. Zero Trust recommandé.

**Diagnostic Tailscale (SPK)** : dans **Administration → Accès externe → Vérifier Tailscale**,
le serveur recherche le client dans les emplacements connus (dont
`/var/packages/Tailscale/target/bin/tailscale`) et lit sa version, sa connexion et la
configuration Funnel. Chaque commande a un délai maximal de 5 secondes et une sortie limitée ;
le résultat est conservé 15 secondes pour éviter des processus répétés. Cette vérification est
réservée aux administrateurs et tourne avec les droits du paquet `sc-nas-simple-media`.
Elle ne lance ni `sudo`, ni connexion, ni activation ; elle ne modifie ni les permissions ni
l’adresse enregistrée. Une configuration Funnel détectée n’est pas une preuve d’accessibilité
Internet. Les droits d’activation et l’autorisation du compte restent **non confirmés**.
Si l’accès est refusé, aucune élévation automatique n’est tentée ; ne passez pas l’application en root.

Les liens générés alors utilisent automatiquement l'adresse externe ; s'ils restent en adresse
privée, la modale de partage affiche un avertissement avec un bouton **Configurer l'adresse externe**.

---

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `MEDIA_PATH` | `/media` | Racine des bibliothèques relatives |
| `DATA_PATH` | `/data` | SQLite + caches (transcode, miniatures, sous-titres) |
| `PORT` | `8096` | Port HTTP |
| `ADMIN_PASSWORD` | `changeme` | Mot de passe initial `admin` |
| `PUBLIC_BASE_URL` | `http://localhost:8096` | Base des liens partage / VLC (ex. `https://mon-nas.synology.me`) |
| `TRUST_PROXY` | `1` | `0` pour ignorer `X-Forwarded-Proto`/`Host` (port 8096 exposé directement) |
| `ENABLE_WATCH` | `1` | `0` pour couper le file watch |
| `TRANSCODE_ENABLED` | `true` | Active le mode Compatible (HLS) |
| `FFMPEG_PATH` | `ffmpeg` | Binaire ffmpeg |
| `FFPROBE_PATH` | `ffprobe` | Binaire ffprobe (analyse codecs / DTS / 5.1) |
| `TRANSCODE_MAX_JOBS` | `1` | Jobs ffmpeg simultanés (Synology : 1) |
| `TRANSCODE_CACHE_TTL_MS` | `7200000` | TTL cache HLS (2 h) |
| `STREAM_TOKEN_TTL_MS` | `86400000` | TTL jetons VLC (24 h) |
| `PROBE_ENABLED` | `true` | Analyse ffprobe des médias |
| `PROBE_ON_SCAN` | `false` | Analyse en arrière-plan après chaque scan (`true` = pré-analyse) |
| `PROBE_TIMEOUT_MS` | `15000` | Timeout d’une analyse ffprobe |
| `TRANSCODE_VIDEO_COPY` | `true` | Remux direct : copie vidéo sans ré-encodage si possible |
| `TRANSCODE_COPY_CODECS` | `h264,mpeg4` | Codecs vidéo éligibles à la copie |
| `TRANSCODE_PRESET` | `veryfast` | Preset x264 logiciel |
| `TRANSCODE_CRF` | `23` | Qualité x264 (16–32) |
| `TRANSCODE_HWACCEL` | `none` | `none` \| `auto` \| `qsv` \| `vaapi` (nécessite `/dev/dri`) |
| `TRANSCODE_VAAPI_DEVICE` | `/dev/dri/renderD128` | Périphérique VAAPI |
| `TRANSCODE_SURROUND_CODEC` | `aac` | Codec du profil Surround 5.1 : `aac` \| `eac3` \| `ac3` |
| `TRANSCODE_SURROUND_BITRATE` | `384k` | Débit audio Surround |
| `TRANSCODE_STEREO_BITRATE` | `192k` | Débit audio Stéréo |
| `TRANSCODE_AUDIO_PASSTHROUGH` | `false` | Autorise le passthrough AC-3/E-AC-3 (`?passthrough=1`, Safari/TV) |
| `THUMBS_ENABLED` | `true` | Miniatures vidéo (posters) |

---

## Développement local

**Prérequis :** Node ≥ 18, et **ffmpeg + ffprobe** installés sur l’hôte pour le mode Compatible, l’analyse DTS/5.1, les miniatures et les sous-titres (`ffmpeg`/`ffprobe` dans le `PATH`, ou `FFMPEG_PATH`/`FFPROBE_PATH`). Sans ffmpeg, la lecture Directe, VLC et les partages restent fonctionnels.

```bash
cd nas-simple-media
cp .env.example .env
mkdir -p ./media/Movies ./media/Series ./media/Music ./data
npm install
npm test
npm run build
MEDIA_PATH=./media DATA_PATH=./data ADMIN_PASSWORD=dev TRANSCODE_ENABLED=true npm start
# → http://localhost:8096  (admin / dev)
```

Dev reload : `MEDIA_PATH=./media DATA_PATH=./data ADMIN_PASSWORD=dev npm run dev`

Scripts : `build`, `start`, `dev`, `test`.

---

## Parité Plex & limites

| Fonction Plex | NAS Simple Media |
|---|---|
| Direct Play | ✅ Mode Direct (fichier original + Range + ETag) |
| Direct Stream (remux) | ✅ Copie vidéo HLS quand possible, badge ⚙ explicatif |
| Transcode + qualités | ✅ Original / 1080p / 720p / 480p |
| Audio multi-pistes + 5.1 | ✅ Pistes ffprobe, AAC 5.1 Surround (DTS/TrueHD/AC-3 → 5.1) |
| Sous-titres | ✅ Extraction WebVTT + sélecteur (texte uniquement) |
| On Deck / Reprendre | ✅ Progression par utilisateur, reprise proposée |
| Recently Added | ✅ Rangée d’accueil |
| Preplay / détails | ✅ Posters, badges codecs, pistes, résumé |
| Dashboard transcodages | ✅ Admin · Sessions (temps réel, arrêt possible) |
| Accélération matérielle | ✅ QSV / VAAPI optionnels (`TRANSCODE_HWACCEL`) |
| Partages externes | ✅ Liens `/s/…` + VLC + Compatible |

Limites assumées :

- **Pas de bitstream DTS/TrueHD dans le navigateur** (limite des navigateurs eux-mêmes) — le Surround passe par **AAC 5.1** (ou E-AC-3/AC-3 côté Safari), le bitstream exact reste disponible via **VLC**.
- Transcodage complet **CPU-intensif** sur NAS ; 1 job max recommandé ; préférer **Remux direct** (automatique) ou **VLC en LAN** pour les Remux lourds.
- Sous-titres **image** (PGS/VobSub) non convertibles en texte → VLC uniquement (pas d’incrustation, trop lourde pour un NAS).
- Pas de jaquettes / métadonnées Internet (TMDB), DLNA, Chromecast, apps natives.
- Le file watch dépend de l’OS ; sinon **Rescan**.

---

## Appli Android (téléphone & Android TV)

Une **seule appli native** (Kotlin, Jetpack Compose, Media3/ExoPlayer) pour les
téléphones **et** les téléviseurs Android TV / Google TV — comme le client Plex.
Code source : [`android/`](android/).

**Ce qu'elle fait**

- Plusieurs serveurs mémorisés (IP locale, `*.ts.net` Tailscale, domaine DSM/Let's Encrypt) ;
  connexion avec les comptes existants du serveur. La session (et, si vous cochez la case,
  le mot de passe pour se reconnecter tout seul après un redémarrage du NAS) est stockée
  **chiffrée** (EncryptedSharedPreferences, clé dans l'Android Keystore).
- Accueil : **Continuer la lecture**, **Bibliothèques**, **Ajouts récents**.
- Films en grille d'affiches (tri A→Z / ajouts récents / taille), **séries → saisons → épisodes**,
  **musique → artistes → albums → titres** (lecture en file d'attente), **recherche**.
- Fiche média : codecs, pistes audio et sous-titres, **Reprendre à …** / Depuis le début.
- Lecteur ExoPlayer : qualité **Auto / Original / 1080p / 720p / 480p**, choix de la piste audio
  et des sous-titres, reprise de lecture synchronisée avec le serveur (toutes les 10 s).
  *Auto* lit le fichier original quand l'appareil sait le décoder, sinon passe par le remux/transcodage
  HLS du serveur (DTS, TrueHD, AVI…) ; si la lecture directe échoue, l'appli bascule seule en HLS.
- **Liens de partage** `https://…/s/<jeton>` : ils s'ouvrent dans l'appli en **invité**
  (mot de passe du partage demandé si besoin). On peut aussi coller un lien depuis l'écran des serveurs.
- **Android TV** : icône dans le lanceur TV (bannière), navigation à la **télécommande (D-pad)**,
  cartes Compose for TV avec mise en avant du focus ; dans le lecteur, bouton **Options** de la barre
  de contrôle (ou touche Menu) pour la qualité, l'audio et les sous-titres.

**Installer l'APK**

L'APK est produit par GitHub Actions (onglet *Actions* → *Android APK* → dernier run → artefact
`nas-media-debug-apk`, une fois `android/ci/github-workflow-android.yml` déplacé dans `.github/workflows/`) ou localement (`cd android && ./gradlew assembleDebug` →
`android/app/build/outputs/apk/debug/app-debug.apk`).

- *Téléphone* : copiez l'APK sur le téléphone, ouvrez-le, autorisez « Installer des applis inconnues »
  pour votre gestionnaire de fichiers / navigateur, puis Installer.
- *Android TV / Google TV* :
  1. Paramètres → Système → À propos → cliquez 7 fois sur *Build Android TV OS* pour activer les options
     pour les développeurs ; puis Applications → Sécurité → autorisez les sources inconnues pour **Downloader**.
  2. Installez l'appli **Downloader** (AFTVnews) depuis le Play Store, saisissez l'URL de l'APK
     (par ex. un lien direct sur votre NAS ou un raccourci), téléchargez puis installez.
  3. Ou via **adb** depuis un PC du réseau : activez *Débogage réseau* sur la TV puis
     `adb connect 192.168.1.50:5555 && adb install -r nas-media-debug.apk`.

**HTTPS / http en clair**

- Sur le réseau local, `http://192.168.x.x:8096` fonctionne : l'appli autorise le HTTP en clair
  (`network_security_config.xml`) parce qu'Android ne sait pas limiter cela à des plages d'IP locales.
  En saisie, une IP/un nom local sans `http(s)://` devient `http://…:8096`, un nom public devient `https://…`.
- Depuis l'extérieur, utilisez **HTTPS** : Tailscale (`tailscale serve` → `https://nas.xxx.ts.net`)
  ou le proxy inverse DSM avec Let's Encrypt. L'appli affiche un avertissement si vous saisissez une
  adresse publique en `http://` (le mot de passe circulerait en clair).
- Avec Tailscale classique, installez aussi l'appli **Tailscale** sur le téléphone / la TV.

**Limites actuelles** : pas encore d'affiches/métadonnées en ligne (vignettes extraites des vidéos),
pas de Chromecast ni de téléchargement hors-ligne, pas d'écran d'administration dans l'appli ;
en HLS transcodé, avancer au-delà de la partie déjà transcodée attend que le serveur la produise
(le transcodage repart du début). La session est en mémoire sur le serveur : après un redémarrage
du NAS, l'appli se reconnecte seule si le mot de passe a été mémorisé, sinon elle redemande la connexion.

## Licence

MIT — voir [LICENSE](./LICENSE).
