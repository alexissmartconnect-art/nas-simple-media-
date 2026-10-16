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

---

## Fonctionnalités

- Bibliothèques **Films / Séries / Musique** (chemin + type)
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
npm test          # 92 tests
npm run build
npm run spk       # -> dist-spk/nas-simple-media-1.3.0-geminilake.spk
```

Le `.spk` n’est **jamais** commité : c’est un artefact de release, publié sur
[GitHub Releases](https://github.com/alexissmartconnect-art/nas-simple-media-/releases).

---

## Accès distant (Bouygues / CGNAT)

Souvent **pas** de port-forward fiable (CGNAT). Ce projet **ne documente pas** le port-forwarding.

### Tailscale (recommandé)

1. Tailscale sur le NAS + clients.
2. `http://100.x.y.z:8096` — optionnel `tailscale serve --bg 8096`.
3. `PUBLIC_BASE_URL` = URL Tailscale (liens partage + VLC corrects).

### Cloudflare Tunnel

Tunnel → `http://127.0.0.1:8096`, hostname public, `PUBLIC_BASE_URL` adapté. Zero Trust recommandé.

---

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `MEDIA_PATH` | `/media` | Racine des bibliothèques relatives |
| `DATA_PATH` | `/data` | SQLite + caches (transcode, miniatures, sous-titres) |
| `PORT` | `8096` | Port HTTP |
| `ADMIN_PASSWORD` | `changeme` | Mot de passe initial `admin` |
| `PUBLIC_BASE_URL` | `http://localhost:8096` | Base des liens partage / VLC |
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

## Licence

MIT — voir [LICENSE](./LICENSE).
