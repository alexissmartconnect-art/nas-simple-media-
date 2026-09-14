# NAS Simple Media

> Simple free Plex-like media server for Synology NAS — **multi-user**, libraries with selective sharing, movies / music / TV. Docker-first. LAN + private expiring share links. No transcoding.

**Serveur média simple** pour NAS Synology : films, musique, séries. **Comptes multi-utilisateurs**, bibliothèques partagées sélectivement, liens privés à expiration. Lecture HTML5 directe (pas de transcodage).

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Comptes & bibliothèques](#comptes--bibliothèques)
3. [Organisation des dossiers](#organisation-des-dossiers)
4. [Installation Synology (Container Manager)](#installation-synology-container-manager)
5. [Accès distant (Bouygues / CGNAT)](#accès-distant-bouygues--cgnat)
6. [Variables d'environnement](#variables-denvironnement)
7. [Développement local](#développement-local)
8. [Limites (v1)](#limites-v1)

---

## Fonctionnalités

- Bibliothèques **Films / Séries / Musique** définies par l’admin (chemin + type)
- **Multi-utilisateurs** : admin crée les comptes, active/désactive, attribue les bibliothèques
- Chaque utilisateur ne voit **que** les bibliothèques qui lui sont accordées (admin voit tout)
- Interface web sombre, mobile-friendly
- Lecture HTML5 + **HTTP Range** (seek)
- **Liens de partage d’un média** (film / épisode / piste) : jeton, expiration, max uses, mot de passe
- Rescan + file watch optionnel
- Docker multi-arch **amd64 / arm64**

**Hors scope :** transcodage, DLNA, TMDB, apps mobiles, live TV.

---

## Comptes & bibliothèques

### Premier démarrage

- Un compte **`admin`** est créé automatiquement avec le mot de passe `ADMIN_PASSWORD`.
- Trois bibliothèques par défaut : `Films` → `Movies/`, `Séries` → `Series/`, `Musique` → `Music/` (sous `MEDIA_PATH`).

### Rôles

| Rôle    | Droits |
|---------|--------|
| `admin` | Tout : users, bibliothèques, grants, rescan, tous les partages |
| `user`  | Parcourir / lire ses bibliothèques ; créer des liens item si `can_share` |

### Partage « bibliothèque entière »

Dans **Admin · Comptes**, cochez les bibliothèques autorisées pour chaque utilisateur.  
C’est le partage sélectif type Plex (sans les couches complexes).

### Partage « un seul média »

Bouton **Partager** sur un film / épisode / piste → URL `/s/<jeton>` (sans login).  
Options : expiration, nombre d’usages, mot de passe.

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

Extensions : vidéo `mp4 mkv avi webm` · audio `mp3 flac m4a opus wav`.  
Heuristiques : `SxxExx` / `1x02` pour les séries ; `Artiste - Album - Piste` ou dossiers pour la musique.

Données app (SQLite) : ex. `/volume1/docker/nas-simple-media/data`.

---

## Installation Synology (Container Manager)

1. Copiez le projet sous `/volume1/docker/nas-simple-media/`.
2. Créez `.env` :

```env
ADMIN_PASSWORD=UnMotDePasseFort
PUBLIC_BASE_URL=http://192.168.1.50:8096
```

3. Adaptez `docker-compose.yml` (chemins host) :

```yaml
volumes:
  - /volume1/media:/media:ro
  - /volume1/docker/nas-simple-media/data:/data
```

4. **Container Manager → Projet → Créer**, ou en SSH :

```bash
cd /volume1/docker/nas-simple-media
sudo docker compose up -d --build
```

5. Ouvrez `http://IP-NAS:8096` → connectez-vous (`admin` / votre mot de passe).
6. **Admin · Bibliothèques** : vérifiez les chemins, **Rescan**.
7. **Admin · Comptes** : créez la famille / potes et cochez leurs bibliothèques.

Pare-feu DSM : autorisez **8096/TCP** en LAN seulement. Pour Internet : Tailscale ou Cloudflare Tunnel (pas de port-forward Bouygues).

---

## Accès distant (Bouygues / CGNAT)

Les box Bouygues (souvent en **CGNAT**) ne permettent en général **pas** une redirection de ports fiable. Ce projet **ne documente pas** le port-forwarding.

### Tailscale (recommandé)

1. Tailscale sur le NAS + téléphones / PC.
2. Accès via IP Tailscale : `http://100.x.y.z:8096`.
3. Optionnel : `tailscale serve --bg 8096` pour HTTPS.
4. Mettez `PUBLIC_BASE_URL` sur l’URL Tailscale pour des liens de partage corrects.

### Cloudflare Tunnel

1. Tunnel `cloudflared` → `http://127.0.0.1:8096` (ou le service Docker).
2. Hostname `https://media.votredomaine.fr`.
3. `PUBLIC_BASE_URL=https://media.votredomaine.fr`.
4. Ajoutez une policy Zero Trust si possible (en plus des comptes app).

Les liens `/s/…` restent sans login admin, mais protégés par jeton (+ options).

---

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `MEDIA_PATH` | `/media` | Racine des bibliothèques relatives |
| `DATA_PATH` | `/data` | SQLite |
| `PORT` | `8096` | Port HTTP |
| `ADMIN_PASSWORD` | `changeme` | Mot de passe initial du user `admin` |
| `PUBLIC_BASE_URL` | `http://localhost:8096` | Base des liens de partage |
| `ENABLE_WATCH` | `1` | `0` pour couper le file watch |

---

## Développement local

```bash
cd nas-simple-media
cp .env.example .env
mkdir -p ./media/Movies ./media/Series ./media/Music ./data
npm install
npm test
npm run build
MEDIA_PATH=./media DATA_PATH=./data ADMIN_PASSWORD=dev npm start
# → http://localhost:8096  (admin / dev)
```

Dev reload : `MEDIA_PATH=./media DATA_PATH=./data ADMIN_PASSWORD=dev npm run dev`

Scripts : `build`, `start`, `dev`, `test`.

---

## Limites (v1)

- Pas de transcodage (codecs supportés par le navigateur).
- Pas de jaquettes / métadonnées Internet.
- Pas de DLNA / apps natives.
- Le file watch dépend de l’OS ; sinon **Rescan**.

---

## Licence

MIT — voir [LICENSE](./LICENSE).
