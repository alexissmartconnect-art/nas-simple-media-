# NAS Simple Media

> Serveur média simple type Plex pour NAS Synology — **multi-utilisateurs**, bibliothèques sélectives, films / musique / séries. Docker-first. Lecture **Direct** ou **Compatible** (ffmpeg HLS), téléchargement + **VLC**.

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Direct vs Compatible](#direct-vs-compatible)
3. [VLC & téléchargement](#vlc--téléchargement)
4. [Comptes & bibliothèques](#comptes--bibliothèques)
5. [Organisation des dossiers](#organisation-des-dossiers)
6. [Installation Synology (Container Manager)](#installation-synology-container-manager)
7. [Accès distant (Bouygues / CGNAT)](#accès-distant-bouygues--cgnat)
8. [Variables d'environnement](#variables-denvironnement)
9. [Développement local](#développement-local)
10. [Limites](#limites)

---

## Fonctionnalités

- Bibliothèques **Films / Séries / Musique** (chemin + type)
- **Multi-utilisateurs** + ACL par bibliothèque
- Lecture HTML5 + **HTTP Range** (seek)
- **Mode Direct** : fichier original (codecs natifs navigateur)
- **Mode Compatible** : transcodage **ffmpeg → HLS** (H.264 + AAC **stéréo**)
- **Télécharger** le fichier original + **Ouvrir dans VLC** (URL / `.m3u`)
- Liens de partage `/s/<jeton>` (expiration, max uses, mot de passe) avec lecture / DL / VLC
- Rescan + file watch optionnel
- Docker multi-arch **amd64 / arm64** (image avec **ffmpeg**)

**Hors scope :** DLNA, TMDB, apps mobiles, live TV, passthrough DTS dans le navigateur.

---

## Direct vs Compatible

| Mode | Quoi | Quand |
|------|------|--------|
| **Direct** | Progressive download du fichier original (`/api/stream/:id`) | MP4/WebM (H.264/AAC, VP9…) souvent OK |
| **Compatible** | ffmpeg → HLS (`/api/stream/:id/hls`) H.264 + AAC **stéréo** | MKV / AVI / Remux, DTS, AC3, HEVC difficile |

- Les navigateurs **ne gèrent presque jamais le DTS** (bitstream). En Compatible, l’audio est **downmixé en AAC stéréo** — ce n’est **pas** un passthrough DTS 5.1.
- Pour le **plein DTS / TrueHD 5.1** et les gros Remux : utilisez **VLC sur le LAN** (beaucoup plus léger pour le NAS que le transcodage).
- Sur Synology, le CPU est souvent faible : `TRANSCODE_MAX_JOBS=1` (défaut). Le transcodage est **lourd** ; préférez VLC pour les fichiers 4K/Remux.

L’UI propose un bascule **Direct | Compatible** ; si Direct échoue sur un conteneur dur, bascule auto vers Compatible.

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
Cache transcodage : `DATA_PATH/cache/transcode/<id>/` (nettoyage TTL).

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
| `DATA_PATH` | `/data` | SQLite + cache transcode |
| `PORT` | `8096` | Port HTTP |
| `ADMIN_PASSWORD` | `changeme` | Mot de passe initial `admin` |
| `PUBLIC_BASE_URL` | `http://localhost:8096` | Base des liens partage / VLC |
| `ENABLE_WATCH` | `1` | `0` pour couper le file watch |
| `TRANSCODE_ENABLED` | `true` | Active le mode Compatible (HLS) |
| `FFMPEG_PATH` | `ffmpeg` | Binaire ffmpeg |
| `TRANSCODE_MAX_JOBS` | `1` | Jobs ffmpeg simultanés (Synology : 1) |
| `TRANSCODE_CACHE_TTL_MS` | `7200000` | TTL cache HLS (2 h) |
| `STREAM_TOKEN_TTL_MS` | `86400000` | TTL jetons VLC (24 h) |

---

## Développement local

**Prérequis :** Node ≥ 18, et **ffmpeg** installé sur l’hôte pour le mode Compatible (`ffmpeg` dans le `PATH`, ou `FFMPEG_PATH`).

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

## Limites

- Compatible = **H.264 + AAC stéréo** (downmix) — **pas** de passthrough DTS/TrueHD dans le navigateur.
- Transcodage **CPU-intensif** sur NAS ; 1 job max recommandé ; préférer **VLC en LAN** pour Remux lourds.
- Pas de jaquettes / métadonnées Internet / DLNA / apps natives.
- Le file watch dépend de l’OS ; sinon **Rescan**.

---

## Licence

MIT — voir [LICENSE](./LICENSE).
