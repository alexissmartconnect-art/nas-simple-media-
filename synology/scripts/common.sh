#!/bin/sh
# Shared helpers for the nas-simple-media package lifecycle scripts.
#
# Sourced by preinst / postinst / preupgrade / postupgrade / preuninst /
# postuninst / start-stop-status.  Kept POSIX-sh compatible: DSM's /bin/sh is
# not guaranteed to be bash.

PKGNAME="nas-simple-media"
SERVICE_USER="sc-nas-simple-media"
SERVICE_GROUP="sc-nas-simple-media"
APP_PORT="8096"

# Shared folder created automatically by conf/resource (data-share worker).
# It is never deleted on uninstall, so the user's media files are safe.
MEDIA_SHARE_NAME="media"

# DSM sets SYNOPKG_PKGDEST to /var/packages/<pkg>/target (i.e.
# /volumeX/@appstore/<pkg>); fall back cleanly for manual testing outside DSM.
# NAS_SM_PKGROOT lets the scripts be exercised from a scratch directory.
if [ -n "${NAS_SM_PKGROOT:-}" ]; then
  PKGROOT="${NAS_SM_PKGROOT}"
  TARGET_DIR="${PKGROOT}/target"
elif [ -d "/var/packages/${PKGNAME}" ]; then
  PKGROOT="/var/packages/${PKGNAME}"
  TARGET_DIR="${SYNOPKG_PKGDEST:-${PKGROOT}/target}"
elif [ -n "${SYNOPKG_PKGDEST:-}" ] && [ -d "${SYNOPKG_PKGDEST}/app" ] && [ ! -d "${SYNOPKG_PKGDEST}/target" ]; then
  PKGROOT="${SYNOPKG_PKGDEST}"
  TARGET_DIR="${SYNOPKG_PKGDEST}"
else
  PKGROOT="${SYNOPKG_PKGDEST:-/var/packages/${PKGNAME}}"
  TARGET_DIR="${PKGROOT}/target"
fi
APPDIR="${TARGET_DIR}/app"
VAR_DIR="${SYNOPKG_PKGVAR:-${PKGROOT}/var}"
ETC_DIR="${PKGROOT}/etc"
TMP_DIR="${PKGROOT}/tmp"
BACKUP_DIR="${VAR_DIR}/backups"
PIDFILE="${VAR_DIR}/${PKGNAME}.pid"
LOGFILE="${VAR_DIR}/${PKGNAME}.log"
ENVFILE="${ETC_DIR}/${PKGNAME}.env"

# DSM 7.0+ creates this symlink automatically for the data-share worker
# (since DSM 7.0-41201).  It points at /volumeX/media.
MEDIA_LINK="${PKGROOT}/shares/${MEDIA_SHARE_NAME}"

# Node.js engine required by the bundled SQLite driver (node:sqlite, Node >= 22.5).
NODE_MIN_MAJOR="22"
NODE_MIN_MINOR="5"

log() {
  echo "[${PKGNAME}] $*"
}

warn() {
  echo "[${PKGNAME}] WARNING: $*" >&2
}

die() {
  echo "[${PKGNAME}] ERROR: $*" >&2
  exit 1
}

# ---------------------------------------------------------------- paths / env

# Resolve symlinks without relying on GNU readlink -f (not always present).
resolve_dir() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"
}

# Read one KEY=VALUE from the runtime env file without executing it.
env_value() {
  [ -f "${ENVFILE}" ] || return 1
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "${ENVFILE}" \
    | tail -n 1 \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# Real path of the automatic "media" shared folder, when it exists.
package_share_path() {
  if [ -d "${MEDIA_LINK}" ]; then
    resolve_dir "${MEDIA_LINK}"
    return 0
  fi
  for _dir in /volume1/media /volume2/media /volume3/media /volume4/media; do
    if [ -d "${_dir}" ]; then
      printf '%s\n' "${_dir}"
      return 0
    fi
  done
  return 1
}

# Resolve MEDIA_PATH: "auto" (the default written by the installer) and an empty
# value mean the automatic "media" shared folder.
resolve_media_path() {
  _value="${1:-}"
  case "${_value}" in
    ''|auto|AUTO)
      default_media_path
      ;;
    *)
      printf '%s\n' "${_value}"
      ;;
  esac
}

# Pick a sensible default media root: the automatic media share first, then
# the first shared folder that exists.
default_media_path() {
  _share="$(package_share_path 2>/dev/null || true)"
  if [ -n "${_share}" ]; then
    printf '%s\n' "${_share}"
    return 0
  fi
  for _dir in /volume1/media /volume2/media /volume3/media /volume4/media /volume1 /volume2; do
    if [ -d "${_dir}" ]; then
      printf '%s\n' "${_dir}"
      return 0
    fi
  done
  printf '%s\n' "/volume1"
}

# ---------------------------------------------------------------- node / ffmpeg

# Locate a usable Node.js runtime. Synology ships it as "Node.js_vNN".
# v24 is accepted too (node:sqlite is stable there); v22 is the declared
# dependency so Package Center installs it automatically.
find_node() {
  for _candidate in \
    /var/packages/Node.js_v24/target/bin/node \
    /var/packages/Node.js_v22/target/bin/node \
    /var/packages/Node.js_v20/target/bin/node \
    /volume*/@appstore/Node.js_v*/target/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [ -n "${_candidate}" ] && [ -x "${_candidate}" ]; then
      printf '%s\n' "${_candidate}"
      return 0
    fi
  done
  _found="$(command -v node 2>/dev/null || true)"
  if [ -n "${_found}" ]; then
    printf '%s\n' "${_found}"
    return 0
  fi
  return 1
}

# Print "<major>.<minor>" for the given node binary (e.g. "22.22").
node_version() {
  _node="$1"
  "${_node}" -p "process.versions.node.split('.').slice(0,2).join('.')" 2>/dev/null || echo "0.0"
}

# True when the node runtime is new enough to provide the built-in SQLite engine.
node_is_supported() {
  _node="$1"
  [ -n "${_node}" ] || return 1
  _version="$(node_version "${_node}")"
  _major="${_version%%.*}"
  _rest="${_version#*.}"
  _minor="${_rest%%.*}"
  case "${_major}${_minor}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "${_major}" -gt "${NODE_MIN_MAJOR}" ] && return 0
  [ "${_major}" -eq "${NODE_MIN_MAJOR}" ] && [ "${_minor}" -ge "${NODE_MIN_MINOR}" ] && return 0
  return 1
}

# Node 22.5–22.12 need --experimental-sqlite; later versions do not.
# Prints the needed flag (nothing when no flag is required).
node_sqlite_flag() {
  _node="$1"
  [ -n "${_node}" ] || return 1
  if "${_node}" -e "require('node:sqlite')" >/dev/null 2>&1; then
    return 0
  fi
  if "${_node}" --experimental-sqlite -e "require('node:sqlite')" >/dev/null 2>&1; then
    printf '%s\n' "--experimental-sqlite"
    return 0
  fi
  return 1
}

# Locate ffmpeg.  User override first, then Synology/SynoCommunity packages,
# then the static binary bundled in the SPK, then PATH.
find_ffmpeg() {
  _want="${1:-${FFMPEG_PATH:-}}"
  if [ -n "${_want}" ]; then
    case "${_want}" in
      /*)
        if [ -x "${_want}" ]; then printf '%s\n' "${_want}"; return 0; fi
        ;;
      *)
        _resolved="$(command -v "${_want}" 2>/dev/null || true)"
        if [ -n "${_resolved}" ]; then printf '%s\n' "${_resolved}"; return 0; fi
        ;;
    esac
  fi
  for _candidate in \
    /var/packages/ffmpeg7/target/bin/ffmpeg \
    /var/packages/ffmpeg6/target/bin/ffmpeg \
    /volume*/@appstore/ffmpeg*/target/bin/ffmpeg \
    /usr/bin/ffmpeg \
    /usr/local/bin/ffmpeg \
    /bin/ffmpeg \
    "${APPDIR}/bin/ffmpeg"
  do
    if [ -n "${_candidate}" ] && [ -x "${_candidate}" ]; then
      printf '%s\n' "${_candidate}"
      return 0
    fi
  done
  _resolved="$(command -v ffmpeg 2>/dev/null || true)"
  if [ -n "${_resolved}" ]; then printf '%s\n' "${_resolved}"; return 0; fi
  return 1
}

# Locate ffprobe next to ffmpeg for media probing (DTS / 5.1 / HDR detection).
find_ffprobe() {
  _want="${1:-${FFPROBE_PATH:-}}"
  if [ -n "${_want}" ]; then
    case "${_want}" in
      /*)
        if [ -x "${_want}" ]; then printf '%s\n' "${_want}"; return 0; fi
        ;;
      *)
        _resolved="$(command -v "${_want}" 2>/dev/null || true)"
        if [ -n "${_resolved}" ]; then printf '%s\n' "${_resolved}"; return 0; fi
        ;;
    esac
  fi
  for _candidate in \
    /var/packages/ffmpeg7/target/bin/ffprobe \
    /var/packages/ffmpeg6/target/bin/ffprobe \
    /volume*/@appstore/ffmpeg*/target/bin/ffprobe \
    /usr/bin/ffprobe \
    /usr/local/bin/ffprobe \
    /bin/ffprobe \
    "${APPDIR}/bin/ffprobe"
  do
    if [ -n "${_candidate}" ] && [ -x "${_candidate}" ]; then
      printf '%s\n' "${_candidate}"
      return 0
    fi
  done
  _resolved="$(command -v ffprobe 2>/dev/null || true)"
  if [ -n "${_resolved}" ]; then printf '%s\n' "${_resolved}"; return 0; fi
  return 1
}

# ---------------------------------------------------------------- directories

ensure_dirs() {
  mkdir -p "${VAR_DIR}" "${ETC_DIR}" "${TMP_DIR}" "${APPDIR}" "${BACKUP_DIR}" 2>/dev/null || true
}

chown_to_service() {
  if [ "$(id -u 2>/dev/null)" = "0" ]; then
    chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${VAR_DIR}" "${ETC_DIR}" "${TMP_DIR}" 2>/dev/null || true
  fi
}

# Create the default library folders inside the media share.  The data-share
# resource grants read/write to the package user, so this generally succeeds;
# failures are harmless (the UI explorer can create/select folders later).
ensure_media_layout() {
  _media="$(resolve_media_path "$(env_value MEDIA_PATH 2>/dev/null || true)")"
  for _sub in Movies Series Music; do
    if ! mkdir -p "${_media}/${_sub}" 2>/dev/null; then
      warn "cannot create ${_media}/${_sub} (check the shared-folder permission)"
    fi
  done
}

# ---------------------------------------------------------------- environment

# Write the runtime env file, preserving any existing user customisation.
write_env_file() {
  if [ -f "${ENVFILE}" ]; then
    log "keeping existing configuration ${ENVFILE}"
    return 0
  fi

  _ip="$(detect_lan_ip)"
  if [ -n "${_ip}" ]; then
    _public_url="http://${_ip}:${APP_PORT}"
  else
    _public_url="http://localhost:${APP_PORT}"
  fi

  mkdir -p "${ETC_DIR}" 2>/dev/null || true
  cat > "${ENVFILE}" <<EOF
# nas-simple-media runtime configuration
# Generated by the package installer. Edit and restart the package to apply.
# This file is preserved across upgrades.

# Base folder holding library subfolders (Movies, Series, Music, ...).
# "auto" = the "media" shared folder created by DSM (recommended): the service
# resolves it at each start, so moving the share to another volume keeps
# working.  Replace it with an absolute path to use another folder, or add
# libraries from the web UI explorer.
MEDIA_PATH=auto

# SQLite database, share metadata and HLS transcode cache.
DATA_PATH=${VAR_DIR}

# HTTP port (must match adminport in the package INFO).
PORT=${APP_PORT}

# Initial administrator password; user "admin" is created on first start.
# The web UI forces a password change while this is still "changeme".
ADMIN_PASSWORD=changeme

# Public base URL used to build share links, VLC stream URLs and QR codes,
# e.g. http://192.168.1.50:8096 or https://mon-nas.synology.me
# Set to the LAN address of this NAS at install time; change it here or from
# the UI (Administration -> "Acces externe & Reseau") when using a DDNS name.
PUBLIC_BASE_URL=${_public_url}

# Trust reverse-proxy headers (X-Forwarded-For / -Proto / -Host) only from local
# proxies (DSM Reverse Proxy, Tailscale serve, nginx on the NAS): loopback,
# link-local and private addresses. An Internet client can never spoof its IP.
# TRUST_PROXY=0 disables it; TRUST_PROXY_HOPS=<n> or a subnet list overrides it.
TRUST_PROXY=1
# TRUST_PROXY_HOPS=loopback, linklocal, uniquelocal

# "Compatible" mode transcodes to HLS with ffmpeg. Disable to save CPU.
TRANSCODE_ENABLED=true
# Empty = automatic: ffmpeg6/7 from SynoCommunity when installed, otherwise
# the static binary bundled in this package.  Set an absolute path to override.
FFMPEG_PATH=
FFPROBE_PATH=
TRANSCODE_MAX_JOBS=1
TRANSCODE_HWACCEL=none

# Analyse codecs (ffprobe) and extract posters / subtitles with ffmpeg.
PROBE_ENABLED=true
PROBE_ON_SCAN=1
THUMBS_ENABLED=true

# Recursive file watch (0 disables it; scans still work).
ENABLE_WATCH=1

# SQLite backend: leave empty to auto-select (node:sqlite, else better-sqlite3).
NAS_SM_SQLITE_BACKEND=
EOF
  if [ ! -s "${ENVFILE}" ]; then
    warn "could not write ${ENVFILE}; the service will use built-in defaults"
    return 1
  fi

  chmod 600 "${ENVFILE}" 2>/dev/null || true
  log "wrote default configuration ${ENVFILE}"
}

# ---------------------------------------------------------------- diagnostics

detect_lan_ip() {
  _ip="$(hostname -i 2>/dev/null | awk '{print $1}')"
  case "${_ip}" in
    ''|127.*|0.0.0.0|169.254.*) _ip="" ;;
  esac
  if [ -z "${_ip}" ] && command -v ip >/dev/null 2>&1; then
    _ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)"
  fi
  case "${_ip}" in
    127.*|0.0.0.0|169.254.*) _ip="" ;;
  esac
  printf '%s\n' "${_ip}"
}

# Human-readable install/repair summary, kept in the data directory.
write_install_report() {
  ensure_dirs
  _report="${VAR_DIR}/INSTALLATION.txt"
  _media_setting="$(env_value MEDIA_PATH 2>/dev/null || true)"
  _media="$(resolve_media_path "${_media_setting}")"
  case "${_media_setting}" in
    ''|auto) _media_note='MEDIA_PATH=auto : dossier partage "media" cree par DSM' ;;
    *) _media_note="MEDIA_PATH=${_media_setting}" ;;
  esac
  _ip="$(detect_lan_ip)"
  _url="http://${_ip}:${APP_PORT}"
  [ -n "${_ip}" ] || _url="http://<adresse-du-NAS>:${APP_PORT}"
  _ffmpeg="$(env_value FFMPEG_PATH 2>/dev/null || true)"
  [ -n "${_ffmpeg}" ] || _ffmpeg="$(find_ffmpeg || echo 'introuvable')"
  _ffmpeg_version=""
  if [ -x "${_ffmpeg}" ]; then
    _ffmpeg_version="$("${_ffmpeg}" -version 2>/dev/null | head -n 1)"
  fi

  cat > "${_report}" <<EOF
NAS Simple Media ${SYNOPKG_PKGVER:-${VERSION:-unknown}}
=============================================

Interface web : ${_url}
Identifiant   : admin
Mot de passe  : changeme  (changement impose a la premiere connexion)
                 ou la valeur ADMIN_PASSWORD du fichier de configuration.

Dossier medias : ${_media}
                 ${_media_note}
  -> sous-dossiers Movies, Series, Music crees automatiquement
  -> le dossier partage "media" est cree par DSM et accessible en lecture/
     ecriture au compte de service sc-nas-simple-media : aucune ACL manuelle
     n'est necessaire pour ce dossier.
  -> pour vos propres dossiers : Panneau de configuration > Dossier partage >
     Autorisations > Utilisateur interne du systeme > sc-nas-simple-media >
     Lecture (le scanner ne voit rien sans cette autorisation).

Configuration : ${ENVFILE}
Donnees       : ${VAR_DIR}
Journal       : ${LOGFILE}
Documentation : ${APPDIR}/docs/README.md et ${APPDIR}/docs/DOP.md

ffmpeg        : ${_ffmpeg}
                ${_ffmpeg_version}
EOF

  # 644 so the report can be opened from File Station / a shared folder.
  chmod 644 "${_report}" 2>/dev/null || true
  if [ "$(id -u 2>/dev/null)" = "0" ]; then
    chown "${SERVICE_USER}:${SERVICE_GROUP}" "${_report}" 2>/dev/null || true
  fi
  log "installation report: ${_report}"
}

# ---------------------------------------------------------------- service state

is_running() {
  [ -f "${PIDFILE}" ] || return 1
  _pid="$(cat "${PIDFILE}" 2>/dev/null)"
  [ -n "${_pid}" ] || return 1
  kill -0 "${_pid}" 2>/dev/null
}

# ---------------------------------------------------------------- upgrade data

# Copy the SQLite database (and its WAL/SHM sidecars) into var/backups.
# The service is stopped by DSM before preupgrade, so the files are consistent.
backup_database() {
  _label="${1:-preupgrade}"
  [ -f "${VAR_DIR}/library.db" ] || {
    log "no database to back up yet"
    return 0
  }
  mkdir -p "${BACKUP_DIR}" 2>/dev/null || true
  _stamp="$(date +%Y%m%d-%H%M%S)"
  _base="${BACKUP_DIR}/library-${_label}-${_stamp}.db"
  if ! cp "${VAR_DIR}/library.db" "${_base}" 2>/dev/null; then
    warn "could not back up ${VAR_DIR}/library.db"
    return 1
  fi
  [ -f "${VAR_DIR}/library.db-wal" ] && cp "${VAR_DIR}/library.db-wal" "${_base}-wal" 2>/dev/null || true
  [ -f "${VAR_DIR}/library.db-shm" ] && cp "${VAR_DIR}/library.db-shm" "${_base}-shm" 2>/dev/null || true
  log "database backup: ${_base}"

  # Keep the 5 most recent backups (and their sidecars).
  ls -1t "${BACKUP_DIR}"/library-*.db 2>/dev/null | tail -n +6 | while IFS= read -r _old; do
    rm -f "${_old}" "${_old}-wal" "${_old}-shm" 2>/dev/null || true
  done
  return 0
}
