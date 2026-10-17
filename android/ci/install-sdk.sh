#!/bin/bash
# Installs the Android SDK pieces the app module needs (JDK 17 is set up by Actions).
set -euo pipefail

if ! command -v sdkmanager >/dev/null 2>&1; then
  echo "sdkmanager introuvable. ANDROID_HOME=${ANDROID_HOME:-} ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-}" >&2
  exit 1
fi

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$sdk_root" ]; then
  echo "ANDROID_HOME non défini" >&2
  exit 1
fi

mkdir -p "$sdk_root/licenses"
printf '%s\n' "24333f8a63b6825ea9c5514f83c2829b004d1fee" > "$sdk_root/licenses/android-sdk-license"
yes | sdkmanager --licenses >/dev/null || true
sdkmanager --install "platforms;android-35" "build-tools;35.0.0"

if ! find "$sdk_root" -name aapt -type f | grep -q .; then
  sdkmanager --install "build-tools;34.0.0"
fi
if ! find "$sdk_root" -name apksigner -type f | grep -q .; then
  echo "apksigner introuvable après installation du SDK" >&2
  exit 1
fi

echo "SDK OK : $(find "$sdk_root/build-tools" -name apksigner -type f | sort | tail -1)"
