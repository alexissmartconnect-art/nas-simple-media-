## NAS Simple Media 1.2.0 — paquet natif DSM 7 pour Synology DS220+

Paquet **natif** (sans Docker) ciblant la **DS220+** — arch `geminilake`, DSM 7.x,
port **8096**, service exécuté sous l'utilisateur dédié `sc-nas-simple-media`.

### Téléchargement

| Fichier | Arch | Taille |
|---|---|---|
| `nas-simple-media-1.2.0-geminilake.spk` | geminilake (DS220+/DS420+/DS720+/DS920+) | 3,8 Mio |

### Installation

**1. Autoriser les éditeurs tiers**
Centre de paquets → Paramètres → Général → Niveau de confiance → **Tous les éditeurs**.

**2. Installer les dépendances**

| Paquet | Source | Pourquoi |
|---|---|---|
| **Node.js v22** | Synology (DSM **7.2** minimum) | Moteur JS ; `node:sqlite` est intégré à Node ≥ 22.5 |
| **ffmpeg6** | [SynoCommunity](https://packages.synocommunity.com) | Transcodage « Compatible » (HLS H.264 + AAC stéréo) |

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

### Vérifications

- `npm test` : **66 tests**, tous verts (dont 8 tests de l'adaptateur SQLite sur les deux moteurs, et 22 tests de packaging)
- `npm run build` : OK
- Test de bout en bout : extraction du `.spk`, démarrage via `run.sh`, scan de bibliothèque, authentification, API `/api/media`, arrêt gracieux par SIGTERM

### Chemins utiles

| Chemin | Contenu |
|---|---|
| `/var/packages/nas-simple-media/target/app/` | Application |
| `/var/packages/nas-simple-media/etc/nas-simple-media.env` | Configuration |
| `/var/packages/nas-simple-media/var/` | Base SQLite, partages, cache HLS |
| `/var/packages/nas-simple-media/var/nas-simple-media.log` | Journal du service |
