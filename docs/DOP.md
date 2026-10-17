# DOP — Mode opératoire NAS Simple Media

> Document pas-à-pas pour **l’administrateur** (celui qui gère le NAS) et pour **les invités** (famille, amis).
> Chaque étape renvoie aux écrans réels de l’interface web de NAS Simple Media et de l’appli Android.

**Légende**

| Repère | Signification |
|---|---|
| 🟢 | Disponible aujourd’hui sur `main` |
| 🟢 *(PR #9)* | Appli Android — PR [#9](https://github.com/alexissmartconnect-art/nas-simple-media-/pull/9) **fusionnée**, disponible |
| 🟢 *(PR #8)* | Appli web installable (PWA) — PR [#8](https://github.com/alexissmartconnect-art/nas-simple-media-/pull/8) **fusionnée**, disponible |
| 🟢 *(phase 0)* | Durcissement sécurité (version 1.6.0 / appli 0.2.0) — PR [#10](https://github.com/alexissmartconnect-art/nas-simple-media-/pull/10) **fusionnée**, disponible ([release v1.6.0](https://github.com/alexissmartconnect-art/nas-simple-media-/releases/tag/v1.6.0)) |
| ⚠️ | Point de sécurité à lire avant d’agir |

Les intitulés des menus **Synology DSM**, **Freebox OS**, **Tailscale** et **Android** peuvent légèrement varier selon la version ou le fabricant.

## Sommaire

1. [Prérequis](#1-prérequis)
2. [Admin — installation, mot de passe, bibliothèques](#2-admin--installation-mot-de-passe-bibliothèques)
3. [Admin — accès depuis l’extérieur](#3-admin--accès-depuis-lextérieur)
4. [Admin — comptes invités et liens de partage](#4-admin--comptes-invités-et-liens-de-partage)
5. [Invité — téléphone Android](#5-invité--téléphone-android)
6. [Invité — Android TV / Google TV](#6-invité--android-tv--google-tv)
7. [Invité — iPhone / iPad](#7-invité--iphone--ipad)
8. [Dépannage](#8-dépannage)

---

## 1. Prérequis

| Élément | Détail |
|---|---|
| NAS | **Synology DS220+** sous **DSM 7.2 ou plus** (nécessaire pour le paquet Node.js v22). |
| Box | **Freebox**, et un accès à l’espace abonné Free si vous choisissez la voie B (§3). |
| Compte DSM | Un compte **administrateur DSM** pour installer des paquets et régler les dossiers partagés. |
| Médias | Un dossier partagé, par exemple `/volume1/media/` avec `Movies/`, `Series/` et `Music/` (voir la section *Organisation des dossiers* du README). |
| Compte NAS Simple Media | Le compte **`admin`** créé au premier démarrage, avec le mot de passe `ADMIN_PASSWORD`, **`changeme`** par défaut. |
| Invités | Un téléphone Android, une télé Android TV / Google TV ou un iPhone. Pour la voie A : un compte Tailscale (gratuit). |

**Nommage des fichiers** (pour que les séries soient reconnues) : `Series/Nom de la série/Nom.S01E01.mkv`.

---

## 2. Admin — installation, mot de passe, bibliothèques

### 2.1 Installer le serveur — au choix, paquet SPK ou Docker

#### Option SPK, paquet natif DSM 7 (recommandé sur DS220+) 🟢

1. **Centre de paquets → Paramètres → Général → Niveau de confiance → *Tous les éditeurs***.
2. **Centre de paquets** : installez **Node.js v22** (paquet Synology).
3. Pour le transcodage, ajoutez la source SynoCommunity :
   **Centre de paquets → Paramètres → Sources de paquets → Ajouter**, avec le nom `SynoCommunity` et l’emplacement `https://packages.synocommunity.com`. Installez ensuite **ffmpeg6**.
4. Téléchargez le fichier `nas-simple-media-<version>-geminilake.spk` depuis
   [GitHub Releases](https://github.com/alexissmartconnect-art/nas-simple-media-/releases).
5. **Centre de paquets → Installation manuelle →** sélectionnez le `.spk`. Le service démarre sur le port **8096**.
6. **Étape obligatoire : droits sur les médias.**
   **Panneau de configuration → Dossier partagé → (votre dossier média) → Modifier → Autorisations**
   → donnez la **lecture** à l’utilisateur **`sc-nas-simple-media`**.
   Sans ce réglage, le scanner ne voit aucun fichier.
7. Ouvrez `http://IP-DU-NAS:8096`.

**Mise à jour (SPK)** : téléchargez le nouveau `.spk`, puis refaites **Installation manuelle**. La configuration est conservée dans
`/var/packages/nas-simple-media/etc/nas-simple-media.env`, et la base dans `/var/packages/nas-simple-media/var/`.

Commandes utiles, en SSH avec un compte admin DSM :

```bash
sudo /var/packages/nas-simple-media/scripts/start-stop-status status
sudo /var/packages/nas-simple-media/scripts/start-stop-status restart
# Journal : /var/packages/nas-simple-media/var/nas-simple-media.log
```

#### Option Docker (Container Manager) 🟢

1. Copiez le projet dans `/volume1/docker/nas-simple-media/`.
2. Créez un fichier `.env` en choisissant **tout de suite** un mot de passe fort :

   ```env
   ADMIN_PASSWORD=UnMotDePasseFort
   PUBLIC_BASE_URL=http://192.168.1.50:8096
   TRANSCODE_ENABLED=true
   TRANSCODE_MAX_JOBS=1
   ```

3. Adaptez les chemins de vos médias dans `docker-compose.yml`.
   🟢 *(phase 0)* L’image tourne en utilisateur **non-root** (`node`, uid 1000). Donnez-lui le dossier data **une fois**, en SSH :

   ```bash
   sudo mkdir -p /volume1/docker/nas-simple-media/data
   sudo chown -R 1000:1000 /volume1/docker/nas-simple-media/data
   ```

   Sans cela, le conteneur s’arrête avec le message « DATA_PATH … n'est pas accessible en écriture ».
   Si vous n’utilisez l’appli **que** via le proxy inversé DSM ou `tailscale serve`, remplacez dans le compose
   `- "8096:8096"` par `- "127.0.0.1:8096:8096"` : le port 8096 n’est alors plus joignable depuis le réseau
   (ni depuis le LAN). Laissez la ligne d’origine si vous voulez `http://IP-DU-NAS:8096` à la maison.
4. Lancez le conteneur en SSH :

   ```bash
   cd /volume1/docker/nas-simple-media
   sudo docker compose up -d --build
   ```

5. Ouvrez `http://IP-DU-NAS:8096`.

**Mise à jour (Docker)** : récupérez la nouvelle version du projet dans le même dossier, puis relancez `sudo docker compose up -d --build`.
🟢 *(phase 0)* En passant à 1.6.0, faites d’abord le `chown -R 1000:1000` ci-dessus : l’ancien conteneur écrivait en root.

### 2.2 Changer le mot de passe `admin` (avant toute autre chose) ⚠️

🟢 *(phase 0)* **Le changement est obligatoire** tant que le compte utilise `changeme` :

1. Depuis un navigateur **du réseau local** (le rappel « Première connexion : identifiant **admin**, mot de passe **changeme** » ne s’affiche qu’en local), connectez-vous avec `admin` / `changeme` — ou la valeur de `ADMIN_PASSWORD` si vous l’avez définie.
2. Si le mot de passe est `changeme`, l’écran **« Nouveau mot de passe obligatoire »** apparaît aussitôt : saisissez deux fois un mot de passe d’**au moins 10 caractères** (les variantes de « changeme » sont refusées), puis **Enregistrer et continuer**. Tant que ce n’est pas fait, le serveur refuse tout le reste.
3. Les autres appareils connectés avec l’ancien mot de passe sont déconnectés.
4. Plus tard, pour changer à nouveau : en haut de l’écran, **🔑 Mot de passe** → **Mot de passe actuel** + **Nouveau mot de passe (min. 10 caractères)**.

L’appli Android ne propose pas ce formulaire : avec `changeme`, elle affiche « Ce compte utilise encore le mot de passe par défaut… changez-le d’abord dans l’interface web (…/login.html) », puis on se reconnecte dans l’appli avec le nouveau mot de passe.

> Avant la phase 0 (version ≤ 1.5.1) : pas de blocage, seulement un rappel sur la page de connexion, et 4 caractères minimum. Changez-le quand même via **🔑 Mot de passe**.

### 2.3 Créer les bibliothèques

Au premier démarrage, trois bibliothèques existent déjà : `Films` → `Movies/`, `Séries` → `Series/` et `Musique` → `Music/`.

1. Menu de gauche, rubrique **Administration** : **📚 Bibliothèques**.
2. Cliquez sur **+ Bibliothèque**.
3. Remplissez les champs :
   - **Nom**, par exemple « Films enfants » ;
   - **Type** : films, séries ou musique ;
   - **Chemin du dossier** : tapez-le, ou passez par **📁 Parcourir les dossiers du NAS / USB** puis **✓ Utiliser ce dossier**. Les disques USB sont proposés, par exemple `/usbshare1/Films`.
4. **Enregistrer**. La bibliothèque est indexée tout de suite. Le bouton **Rescan** relance l’indexation plus tard si besoin.
5. Si le dossier est vide ou illisible, revoyez l’étape 6 du §2.1 (droits pour `sc-nas-simple-media`).

---

## 3. Admin — accès depuis l’extérieur

> ⚠️ **Sécurité avant d’exposer le serveur publiquement** (voie B, ou Tailscale Funnel).
>
> 🟢 *(phase 0)* Ce qui est fait dans la version 1.6.0 :
>
> - cookie de session `HttpOnly` + `SameSite=Lax`, et `Secure` dès que l’accès se fait en HTTPS ;
> - en-têtes CSP stricte, anti-iframe, et HSTS (uniquement en HTTPS) ;
> - le mot de passe d’un lien de partage **ne passe plus dans l’URL** (jeton temporaire signé) ;
> - sessions **en base** (plus perdues au redémarrage), déconnexion réelle ;
> - changement obligatoire de `changeme`, 10 caractères minimum, limites de débit et verrouillage temporaire d’un compte après 10 échecs depuis Internet ;
> - seuls les proxys locaux (DSM, `tailscale serve`) peuvent annoncer l’IP du client (`TRUST_PROXY_HOPS`).
>
> Ce qui reste vrai : un accès en **`http://` depuis Internet** (redirection directe du port 8096) fait circuler les mots de passe en clair — utilisez toujours HTTPS (voie A ou B5). Pas de double authentification ni de journal des connexions. Les anciens liens `?password=` restent acceptés pendant la transition ; pour les refuser, `SHARE_PASSWORD_QUERY_COMPAT=0`.
>
> **Recommandation :** la **voie A (Tailscale privé)** reste la plus sûre, car elle n’ouvre rien sur Internet. La voie B est raisonnable **avec la version 1.6.0 installée**, le §2.2 fait et un compte `user` par invité, limité à ses bibliothèques (§4). Sur une installation restée en 1.5.1 ou avant, l’ancien avertissement s’applique : cookie sans `secure`, pas de HSTS/CSP, mot de passe de partage dans l’URL, sessions en mémoire — mettez d’abord à jour.

### Voie A — Tailscale, réseau privé (recommandée) 🟢

Rien n’est ouvert sur la Freebox. Seuls les appareils invités dans votre réseau Tailscale (« tailnet ») peuvent joindre le NAS.

**A1. Installer Tailscale sur le NAS**

1. **Centre de paquets** → cherchez **Tailscale** → **Installer**.
2. Ouvrez le paquet et connectez le NAS à votre compte Tailscale.
3. Contrôle depuis NAS Simple Media : **Administration → 🌐 Accès externe → Vérifier Tailscale**. Cette vérification se contente de lire l’état : elle ne modifie rien.

**A2. Activer l’adresse HTTPS `….ts.net` avec `tailscale serve`**

1. Dans la console d’administration Tailscale (login.tailscale.com), onglet **DNS** : activez **MagicDNS** et les **certificats HTTPS** (HTTPS Certificates).
2. En SSH sur le NAS, avec un compte admin DSM :

   ```bash
   sudo /var/packages/Tailscale/target/bin/tailscale serve --bg http://127.0.0.1:8096
   sudo /var/packages/Tailscale/target/bin/tailscale serve status
   ```

   La commande `status` affiche l’adresse, de la forme `https://<nom-du-nas>.<votre-tailnet>.ts.net`.
3. Dans NAS Simple Media : **Administration → 🌐 Accès externe** → collez cette adresse → **Enregistrer**. Les liens de partage et QR codes l’utiliseront.
4. Avec cette adresse HTTPS, l’appli web s’installe sur téléphone (PWA 🟢).

> `tailscale serve` reste **privé** : seuls les appareils de votre tailnet y accèdent. `tailscale funnel` rendrait le serveur **public** : à éviter tant que la version 1.6.0 (phase 0 🟢) n’est pas installée, et même ensuite, n’activez-le que si vos invités ne peuvent pas utiliser Tailscale (voir l’avertissement plus haut).

**A3. Donner l’accès à vos amis**

Deux possibilités dans la console Tailscale :

- **Partager uniquement la machine NAS** : onglet **Machines** → menu **…** du NAS → **Share…** → envoyez le lien d’invitation. L’ami accepte avec son propre compte Tailscale et ne voit que le NAS. C’est la solution conseillée.
- **Inviter la personne dans votre tailnet** : onglet **Users** → **Invite users**. Elle verra alors toutes vos machines autorisées par vos règles d’accès.

Chaque invité installe ensuite Tailscale sur ses appareils (§5, §6, §7), puis utilise l’adresse `https://<nom-du-nas>.<tailnet>.ts.net`.

### Voie B — Freebox + DDNS Synology + proxy inversé DSM (accès public) 🟢 ⚠️

À réserver aux cas où les invités ne peuvent pas installer Tailscale. **Lisez l’avertissement sécurité plus haut.**

**B1. Obtenir une IPv4 complète (« full-stack »), seulement si votre ligne est en IP partagée**

1. Espace abonné Free → **Ma Freebox** → **Demander une adresse IP fixe V4 full-stack**.
2. Redémarrez la Freebox une fois la demande activée.
   Sans IPv4 complète, une ligne en IP partagée ne permet pas de rediriger le port 443.

**B2. Rediriger les ports vers le NAS**

1. Freebox OS (`http://mafreebox.freebox.fr`) → **Paramètres de la Freebox** → **Mode avancé** → **Gestion des ports**.
2. Ajoutez deux redirections TCP vers l’**IP locale du NAS** :
   - port externe **443** → port interne **443** ;
   - port externe **80** → port interne **80**, uniquement pour l’obtention et le renouvellement du certificat Let’s Encrypt.
3. **N’ouvrez pas** le port 8096 sur Internet.

**B3. DDNS Synology**

1. DSM → **Panneau de configuration → Accès externe → DDNS → Ajouter**.
2. Fournisseur **Synology**, puis nom d’hôte, par exemple `mon-nas.synology.me`.
3. Cochez l’option d’obtention d’un certificat Let’s Encrypt si elle est proposée.

**B4. Certificat Let’s Encrypt**

1. DSM → **Panneau de configuration → Sécurité → Certificat**.
2. Si le certificat n’a pas été créé à l’étape B3 : **Ajouter** → obtenir un certificat de **Let’s Encrypt** pour `mon-nas.synology.me`.

**B5. Proxy inversé DSM**

1. DSM → **Panneau de configuration → Portail de connexion → Avancé → Proxy inversé → Créer**.
2. **Source** : protocole `HTTPS`, nom d’hôte `mon-nas.synology.me`, port `443`.
3. **Destination** : protocole `HTTP`, nom d’hôte `localhost`, port `8096`.
4. **Sécurité → Certificat → Paramètres** : associez le certificat Let’s Encrypt à cette entrée de proxy inversé.

**B6. Déclarer l’adresse dans NAS Simple Media**

1. **Administration → 🌐 Accès externe** → collez `https://mon-nas.synology.me` → **Enregistrer**.
2. Testez avec **📱 Tester / QR Code**, depuis un téléphone **en 4G/5G avec le Wi-Fi coupé**.

---

## 4. Admin — comptes invités et liens de partage

### 4.1 Créer un compte invité avec droits par bibliothèque 🟢

1. **Administration → 👥 Comptes → + Nouvel utilisateur**.
2. Remplissez les champs :
   - **Identifiant**, par exemple `julie` ;
   - **Mot de passe** : fort, à transmettre par un canal privé ;
   - **Rôle** : **`user`**. Ne donnez jamais `admin` à un invité.
   - **Peut créer des liens de partage** : décochez si l’invité ne doit pas partager à son tour.
   - **Bibliothèques autorisées** : cochez **uniquement** celles qu’il peut voir.
3. Validez. Le bouton **📱 QR Accès** du compte affiche un QR code vers la page de connexion, avec l’identifiant pré-rempli.
4. Pour couper l’accès : ouvrez le compte et décochez **Compte actif**, ou supprimez-le. Ses sessions sont fermées.

### 4.2 Créer un lien de partage `/s/…` (sans compte) 🟢

1. Ouvrez un film, un épisode, une série, un artiste, un dossier ou une bibliothèque → **🔗 Partager**
   (pour un dossier ou une bibliothèque : **🔗 Partager ce dossier** / **🔗 Partager la bibliothèque**).
2. Dans la fenêtre « Lien de partage », réglez les options :
   - **Expiration (optionnel)** : date et heure, ou les raccourcis **+24h**, **+7 jours** et **+30 jours** ;
   - **Utilisations max** : nombre de lectures autorisées ;
   - **Mot de passe (optionnel)**. 🟢 *(phase 0)* L’invité le tape une fois ; il est échangé contre un jeton valable **12 h** et n’apparaît jamais dans les liens de lecture, VLC ou `.m3u`. Après 12 h, l’invité retape le mot de passe (et retélécharge le `.m3u` le cas échéant).
3. **Créer**, puis **Copier le lien** ou **QR Code**. Le lien a la forme `https://<votre-adresse>/s/<jeton>`.
4. Si la fenêtre affiche **⚠️ Ce lien utilise une adresse locale**, cliquez sur **Configurer l’adresse externe**, puis reprenez le §3.
5. **Révoquer** : menu **🔗 Mes partages** → **Révoquer** sur la ligne concernée, puis confirmez.

> Avec la voie A, un lien `/s/` ne fonctionne que pour les personnes connectées à votre tailnet.
> Un lien `/s/` s’ouvre dans le navigateur, ou directement dans l’appli Android en mode invité 🟢.

---

## 5. Invité — téléphone Android

> 🟢 L’appli native **NAS Media** est disponible : l’administrateur transmet l’APK (`nas-media-debug.apk`, produit par `cd android && ./gradlew assembleDebug`). Le navigateur fonctionne aussi : `https://<adresse>` → page de connexion.

**5.1 (Voie A seulement) Installer Tailscale**

1. Play Store → **Tailscale** → **Installer**.
2. Connectez-vous avec le compte qui a reçu l’invitation (§3, A3) et activez la connexion.

**5.2 Installer l’APK**

1. Récupérez le fichier `nas-media-debug.apk` envoyé par l’administrateur.
2. Ouvrez-le depuis **Fichiers** ou **Téléchargements**.
3. Android demande d’autoriser l’installation d’**applications inconnues** pour l’appli qui ouvre le fichier : autorisez-la, revenez en arrière, puis **Installer**.
4. L’appli s’appelle **NAS Media**.

**5.3 Ajouter le serveur et se connecter**

1. Écran **Mes serveurs** → **Ajouter un serveur**.
2. **Adresse du serveur**, selon votre cas :
   - voie A : `nas.xxxx.ts.net`. L’appli complète en `https://…` ; la ligne « → … » sous le champ montre l’adresse finale.
   - voie B : `mon-nas.synology.me` ;
   - à la maison : `192.168.1.50`, complété en `http://192.168.1.50:8096`.
3. **Vérifier et continuer**. Si un avertissement jaune « adresse publique en http:// » apparaît, demandez l’adresse HTTPS à l’administrateur.
4. Écran **Connexion** : saisissez votre **Utilisateur** et votre **Mot de passe**. Laissez cochée **Se souvenir du mot de passe (chiffré sur l’appareil)** pour être reconnecté automatiquement si la session expire. Puis **Se connecter**.
   🟢 *(phase 0)* Si le message « Ce compte utilise encore le mot de passe par défaut… » s’affiche, changez-le d’abord dans un navigateur (§2.2), puis reconnectez-vous.

**5.4 Lire un média**

1. **Accueil** : rangées **Continuer la lecture**, **Bibliothèques** et **Ajouts récents**. La loupe ouvre **Rechercher**.
2. Ouvrez un titre, puis **Lire**, ou **Reprendre à …** / **Depuis le début**.
3. Dans la fiche ou dans le lecteur, bouton **Options**, choisissez la **Qualité** :
   - **Auto** (recommandé) : fichier original si le téléphone sait le lire, sinon conversion par le serveur ;
   - **Original** : fichier intact, consomme le plus de débit ;
   - **1080p / 720p / 480p** : conversion par le serveur. Prenez **720p ou 480p en 4G**.
4. **Options** permet aussi de choisir la piste **Audio** et les **Sous-titres**.
5. Votre position est enregistrée sur le serveur et se retrouve sur la télé.

**5.5 Ouvrir un lien de partage**

Touchez un lien `https://…/s/…` et choisissez **NAS Media**. Vous pouvez aussi le coller dans **Mes serveurs → Ouvrir un lien de partage → Ouvrir**. Le mot de passe du partage est demandé si nécessaire (🟢 *(phase 0)* envoyé une seule fois au serveur, il n’apparaît plus dans les adresses de lecture ; il faut l’appli **0.2.0**).

---

## 6. Invité — Android TV / Google TV

> 🟢 Même appli que sur téléphone.

**6.1 (Voie A seulement) Tailscale sur la télé**

1. Play Store de la télé → **Tailscale** → **Installer**.
2. Connectez-vous : la télé affiche un code ou un QR code, à valider depuis votre téléphone avec le compte invité.

**6.2 Autoriser les sources inconnues**

1. **Paramètres → Système → À propos** → cliquez **7 fois** sur la ligne de build (*Build du système d’exploitation Android TV*) pour activer les options pour les développeurs.
2. **Paramètres → Applications → Sécurité et restrictions → Sources inconnues** → autorisez **Downloader**. Cette étape se fait après avoir installé Downloader (6.3).

**6.3 Installer l’APK — au choix**

- **Avec l’appli Downloader** :
  1. Play Store → **Downloader** (de AFTVnews) → **Installer**.
  2. Dans Downloader, saisissez l’URL directe de l’APK. L’administrateur peut la fournir, par exemple avec un lien de partage **File Station** du NAS pointant vers `nas-media-debug.apk`.
  3. Téléchargez, puis **Installer**.
- **Avec adb**, depuis un ordinateur du même réseau :
  1. Sur la télé, activez **Débogage USB / réseau** dans les options pour les développeurs.
  2. Sur l’ordinateur :

     ```bash
     adb connect 192.168.1.60:5555      # IP de la télé
     adb install -r nas-media-debug.apk
     ```

L’appli **NAS Media** apparaît dans le lanceur TV avec sa bannière orange.

**6.4 Utiliser la télécommande**

- Au premier lancement, refaites le §5.3 (ajout du serveur, connexion). Le clavier à l’écran s’ouvre dans les champs texte ; le bouton **Retour** le referme.
- Les **flèches** déplacent la sélection, signalée par un cadre orange. **OK** ouvre l’élément, **Retour** revient en arrière.
- Dans le lecteur : **OK** affiche les commandes (lecture/pause, ±10 s / +30 s, CC).
  - Le bouton **Options** de la barre de commandes ouvre **Qualité**, **Audio** et **Sous-titres**.
  - Sur une télécommande qui a une touche **Menu**, cette touche ouvre aussi Options.

---

## 7. Invité — iPhone / iPad

> 🟢 L’installation sur l’écran d’accueil (PWA) est disponible, **à condition** d’utiliser une adresse **HTTPS** (voie A `…ts.net` ou voie B `…synology.me`). Avec `http://192.168.x.x:8096`, cela ne fonctionne pas. Il n’y a pas d’appli native iOS.

1. (Voie A) App Store → **Tailscale** → connectez-vous avec le compte invité.
2. Ouvrez **Safari**. L’installation sur l’écran d’accueil ne se fait que depuis Safari.
3. Allez sur `https://<adresse-du-serveur>` et connectez-vous.
4. Bouton **Partager** (carré avec une flèche) → **Sur l’écran d’accueil** → **Ajouter**.
5. Lancez **NAS Simple Media** depuis l’icône. Si le NAS ne répond pas, une page « Serveur injoignable » s’affiche.

---

## 8. Dépannage

| Symptôme | Cause probable | Que faire |
|---|---|---|
| **Serveur injoignable** / « Vérifier et continuer » échoue | Tailscale coupé sur l’appareil (voie A) ; mauvaise adresse ; NAS éteint ; certificat ou redirection manquants (voie B) | Activez Tailscale et vérifiez que le NAS apparaît connecté. Vérifiez l’adresse (`https://` pour `.ts.net` et `synology.me`, `http://…:8096` en local). Admin : `start-stop-status status` (SPK) ou `docker compose ps` (Docker). Testez en 4G/5G avec le Wi-Fi coupé. |
| « Ce n’est pas un serveur NAS Simple Media » | L’adresse pointe vers DSM ou vers un autre service | Utilisez l’adresse du proxy inversé (B5) ou le port **8096** en local, pas le port 5000/5001 de DSM. |
| **Session perdue après un redémarrage du NAS** (retour à l’écran de connexion) | Version ≤ 1.5.1 : sessions gardées en mémoire. 🟢 *(phase 0)* sessions en base : ne se produit plus qu’une fois, juste après la mise à jour 1.6.0, ou après 7 jours | Appli Android : si « Se souvenir du mot de passe » était cochée, la reconnexion est automatique ; sinon, reconnectez-vous. Navigateur : reconnectez-vous. |
| 🟢 « Nouveau mot de passe obligatoire » (web) ou « Ce compte utilise encore le mot de passe par défaut » (Android) | Le compte utilise toujours `changeme` | §2.2 : choisissez un mot de passe d’au moins 10 caractères dans le navigateur, puis reconnectez l’appli. |
| 🟢 « Compte temporairement verrouillé après trop d’échecs » | 10 mauvais mots de passe sur ce compte en 15 min (le blocage ne s’applique qu’aux connexions venant d’Internet) | Attendez 15 min, ou connectez-vous depuis le réseau local (jamais verrouillé). Si vous ne reconnaissez pas ces essais, changez le mot de passe. |
| 🟢 Docker : le conteneur redémarre en boucle, « DATA_PATH … n'est pas accessible en écriture » | Image non-root depuis 1.6.0 | `sudo chown -R 1000:1000 /volume1/docker/nas-simple-media/data` (§2.1), puis `sudo docker compose up -d`. |
| 🟢 Le `.m3u` / lien VLC d’un partage protégé ne marche plus | Le jeton d’accès du partage a expiré (12 h) | Rouvrez le lien `/s/…`, retapez le mot de passe et retéléchargez le `.m3u`. |
| **La vidéo ne démarre pas**, ou elle saccade | Débit insuffisant ; codec non lu par l’appareil ; conversion trop lourde pour le NAS | **Baissez la qualité** (Options → 720p puis 480p). Si « Lecture directe impossible : passage en mode Compatible (HLS) » s’affiche, laissez la conversion démarrer (« Le serveur prépare le flux… »). Une seule conversion tourne à la fois par défaut (`TRANSCODE_MAX_JOBS=1`) : attendez que l’autre lecture se termine. |
| **Impossible d’avancer loin** dans une vidéo en mode converti | Le serveur convertit depuis le début ; la partie demandée n’existe pas encore | Patientez, ou passez en **Original** / **Auto** si l’appareil sait lire le fichier : l’avance rapide est alors immédiate. Limite connue, amélioration prévue (conversion qui démarre au point de reprise). |
| Bibliothèque vide | Droits manquants pour `sc-nas-simple-media` (SPK) ou mauvais chemin | §2.1, étape 6, puis **Rescan** dans **Administration → 📚 Bibliothèques**. |
| Le lien `/s/` contient `192.168…` | L’adresse externe n’est pas déclarée | **Administration → 🌐 Accès externe** → enregistrez l’adresse HTTPS (§3). |
| « Trop de tentatives. Réessayez dans … s » | Protection contre les essais de mot de passe | Attendez le délai indiqué, puis vérifiez l’identifiant et le mot de passe. |
| APK refusé à l’installation | Sources inconnues non autorisées | §5.2 (téléphone) ou §6.2 (télé). |
