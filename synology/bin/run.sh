#!/bin/sh
# run.sh — the service entry point, executed as sc-nas-simple-media.
#
# It records its own PID *before* exec'ing node, so `exec` keeps the PID stable
# and the PID file written by start-stop-status always points at the real
# process. That removes the usual "su wrapper PID" guesswork.

set -u

PKGNAME="nas-simple-media"
APP_PORT="8096"

# Resolve /var/packages/nas-simple-media from this script's own location:
# <pkgroot>/target/app/bin/run.sh
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
APPDIR="$(dirname "${SELF_DIR}")"
PKGROOT="$(dirname "$(dirname "${APPDIR}")")"
VAR_DIR="${PKGROOT}/var"
ETC_DIR="${PKGROOT}/etc"
ENVFILE="${ETC_DIR}/${PKGNAME}.env"
PIDFILE="${VAR_DIR}/${PKGNAME}.pid"

mkdir -p "${VAR_DIR}" "${ETC_DIR}" 2>/dev/null || true

# Publish our PID before exec so stop/status are always accurate.
echo $$ > "${PIDFILE}" 2>/dev/null || true

# --- load configuration ------------------------------------------------------
# Parsed (not sourced) so arbitrary values cannot execute shell code.
if [ -f "${ENVFILE}" ]; then
  while IFS='=' read -r _key _value; do
    case "${_key}" in
      ''|\#*) continue ;;
    esac
    # strip surrounding whitespace and optional quotes
    _key="${_key%%[[:space:]]}"
    _value="${_value#\"}"; _value="${_value%\"}"
    _value="${_value#\'}"; _value="${_value%\'}"
    [ -n "${_key}" ] || continue
    export "${_key}=${_value}"
  done < "${ENVFILE}"
fi

# --- defaults ----------------------------------------------------------------
: "${MEDIA_PATH:=/volume1}"
: "${DATA_PATH:=${VAR_DIR}}"
: "${PORT:=${APP_PORT}}"
: "${TRANSCODE_ENABLED:=true}"
: "${FFMPEG_PATH:=ffmpeg}"
: "${TRANSCODE_MAX_JOBS:=1}"
: "${NODE_ENV:=production}"

export MEDIA_PATH DATA_PATH PORT TRANSCODE_ENABLED FFMPEG_PATH TRANSCODE_MAX_JOBS NODE_ENV

# --- locate node -------------------------------------------------------------
NODE_BIN=""
for _candidate in \
  /var/packages/Node.js_v22/target/bin/node \
  /var/packages/Node.js_v24/target/bin/node \
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

cd "${APPDIR}" || exit 1
exec "${NODE_BIN}" "${APPDIR}/dist/index.js"
