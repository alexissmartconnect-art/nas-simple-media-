#!/bin/sh
# run.sh — the service entry point, executed as sc-nas-simple-media.
#
# It resolves the runtime configuration, finds Node.js and the best available
# ffmpeg (SynoCommunity ffmpeg6/7, otherwise the static binary bundled in the
# package), records its own PID *before* exec'ing node, and starts the server.
#
# Keeping the PID stable across exec means the PID file written by
# start-stop-status always points at the real node process.

set -u

PKGNAME="nas-simple-media"
APP_PORT="8096"
MEDIA_SHARE_NAME="media"

# Resolve /var/packages/nas-simple-media from this script's own location:
# <pkgroot>/target/app/bin/run.sh
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
APPDIR="$(dirname "${SELF_DIR}")"
_candidate_root="$(dirname "$(dirname "${APPDIR}")")"
if [ -d "/var/packages/${PKGNAME}" ] && [ ! -d "${_candidate_root}/var" ]; then
  PKGROOT="/var/packages/${PKGNAME}"
else
  PKGROOT="${_candidate_root}"
fi
VAR_DIR="${SYNOPKG_PKGVAR:-${PKGROOT}/var}"
ETC_DIR="${PKGROOT}/etc"
ENVFILE="${ETC_DIR}/${PKGNAME}.env"
PIDFILE="${VAR_DIR}/${PKGNAME}.pid"
MEDIA_LINK="${PKGROOT}/shares/${MEDIA_SHARE_NAME}"

mkdir -p "${VAR_DIR}" "${ETC_DIR}" 2>/dev/null || true

# Publish our PID before exec so stop/status are always accurate.
echo $$ > "${PIDFILE}" 2>/dev/null || true

# --- load configuration ------------------------------------------------------
# Parsed (not sourced) so arbitrary values cannot execute shell code.
if [ -f "${ENVFILE}" ]; then
  while IFS='=' read -r _key _value || [ -n "${_key:-}" ]; do
    # strip surrounding whitespace and optional quotes (and CR from CRLF files)
    _key="$(printf '%s' "${_key:-}" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    _value="$(printf '%s' "${_value:-}" | tr -d '\r')"
    case "${_key}" in
      ''|'#'*) continue ;;
    esac
    _value="${_value#\"}"; _value="${_value%\"}"
    _value="${_value#\'}"; _value="${_value%\'}"
    [ -n "${_key}" ] || continue
    export "${_key}=${_value}"
  done < "${ENVFILE}"
fi

# --- media root --------------------------------------------------------------
# Automatic shared folder first; MEDIA_PATH=auto keeps working if the share
# is moved to another volume after installation.
if [ -z "${MEDIA_PATH:-}" ] || [ "${MEDIA_PATH}" = "auto" ]; then
  MEDIA_PATH=""
  if [ -d "${MEDIA_LINK}" ]; then
    MEDIA_PATH="$(cd "${MEDIA_LINK}" && pwd -P)"
  fi
  if [ -z "${MEDIA_PATH}" ]; then
    for _dir in /volume1/media /volume2/media /volume3/media /volume4/media /volume1; do
      if [ -d "${_dir}" ]; then
        MEDIA_PATH="${_dir}"
        break
      fi
    done
  fi
  [ -n "${MEDIA_PATH}" ] || MEDIA_PATH="/volume1"
fi

# --- defaults ----------------------------------------------------------------
if [ -d "/var/packages/ffmpeg6/target/bin" ]; then
  PATH="/var/packages/ffmpeg6/target/bin:${PATH}"
  export PATH
fi
if [ -d "/var/packages/ffmpeg7/target/bin" ]; then
  PATH="/var/packages/ffmpeg7/target/bin:${PATH}"
  export PATH
fi

: "${DATA_PATH:=${VAR_DIR}}"
: "${PORT:=${APP_PORT}}"
: "${TRANSCODE_ENABLED:=true}"
: "${TRANSCODE_MAX_JOBS:=1}"
: "${NODE_ENV:=production}"

# --- ffmpeg / ffprobe --------------------------------------------------------
# Priority: explicit path from the env file > PATH (ffmpeg6/7 packages are
# prepended above) > the static binary bundled in this package.
resolve_tool() {
  _want="$1"
  _bundled="$2"
  _name="$3"
  if [ -n "${_want}" ]; then
    case "${_want}" in
      /*)
        if [ -x "${_want}" ]; then printf '%s\n' "${_want}"; return 0; fi
        ;;
      *)
        _hit="$(command -v "${_want}" 2>/dev/null || true)"
        if [ -n "${_hit}" ]; then printf '%s\n' "${_hit}"; return 0; fi
        ;;
    esac
  fi
  _hit="$(command -v "${_name}" 2>/dev/null || true)"
  if [ -n "${_hit}" ]; then printf '%s\n' "${_hit}"; return 0; fi
  if [ -x "${_bundled}" ]; then
    printf '%s\n' "${_bundled}"
    return 0
  fi
  return 1
}

FFMPEG_PATH="$(resolve_tool "${FFMPEG_PATH:-}" "${APPDIR}/bin/ffmpeg" ffmpeg || true)"
FFPROBE_PATH="$(resolve_tool "${FFPROBE_PATH:-}" "${APPDIR}/bin/ffprobe" ffprobe || true)"
[ -n "${FFMPEG_PATH}" ] || FFMPEG_PATH="ffmpeg"
[ -n "${FFPROBE_PATH}" ] || FFPROBE_PATH="ffprobe"
if [ "${FFMPEG_PATH}" = "${APPDIR}/bin/ffmpeg" ]; then
  BUNDLED_FFMPEG=1
else
  BUNDLED_FFMPEG=0
fi

if [ ! -x "${FFMPEG_PATH}" ] && ! command -v "${FFMPEG_PATH}" >/dev/null 2>&1; then
  echo "[${PKGNAME}] WARNING: ffmpeg introuvable — transcodage 'Compatible' desactive." \
       "Installez ffmpeg6 (SynoCommunity) ou utilisez le paquet SPK complet." >&2
  TRANSCODE_ENABLED=false
fi

export MEDIA_PATH DATA_PATH PORT TRANSCODE_ENABLED FFMPEG_PATH FFPROBE_PATH
export TRANSCODE_MAX_JOBS NODE_ENV BUNDLED_FFMPEG
export HOME="${VAR_DIR}"
export TMPDIR="${VAR_DIR}/tmp"
mkdir -p "${TMPDIR}" 2>/dev/null || true

# --- locate node -------------------------------------------------------------
NODE_BIN=""
for _candidate in \
  /var/packages/Node.js_v24/target/bin/node \
  /var/packages/Node.js_v22/target/bin/node \
  /var/packages/Node.js_v20/target/bin/node \
  /volume*/@appstore/Node.js_v*/target/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  if [ -n "${_candidate}" ] && [ -x "${_candidate}" ]; then
    NODE_BIN="${_candidate}"
    break
  fi
done
if [ -z "${NODE_BIN}" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "${NODE_BIN}" ]; then
  echo "[${PKGNAME}] ERROR: no Node.js runtime found. Install the Synology package 'Node.js v22'." >&2
  exit 1
fi

# node:sqlite needs --experimental-sqlite on Node 22.5–22.12 (unflagged later).
NODE_FLAG=""
if ! "${NODE_BIN}" -e "require('node:sqlite')" >/dev/null 2>&1; then
  if "${NODE_BIN}" --experimental-sqlite -e "require('node:sqlite')" >/dev/null 2>&1; then
    NODE_FLAG="--experimental-sqlite"
  else
    echo "[${PKGNAME}] WARNING: node:sqlite unavailable; the server may fail to open its database." >&2
  fi
fi

cd "${APPDIR}" || exit 1
exec "${NODE_BIN}" ${NODE_FLAG} "${APPDIR}/dist/index.js"
