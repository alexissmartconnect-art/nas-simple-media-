#!/bin/bash
# Uses the Android SDK preinstalled on GitHub-hosted Ubuntu runners
# (ANDROID_HOME=/usr/local/lib/android/sdk, platform 35 and build-tools 35).
# android-actions/setup-android@v3 is not used: it requests the removed
# "tools" package and crashes under the Node 24 runner runtime.
set -euo pipefail

sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
if [ ! -d "$sdk_root" ]; then
  echo "Android SDK introuvable : $sdk_root" >&2
  exit 1
fi

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "ANDROID_HOME=$sdk_root" >> "$GITHUB_ENV"
  echo "ANDROID_SDK_ROOT=$sdk_root" >> "$GITHUB_ENV"
fi
export ANDROID_HOME="$sdk_root"
export ANDROID_SDK_ROOT="$sdk_root"

if [ -n "${GITHUB_PATH:-}" ]; then
  if [ -d "$sdk_root/cmdline-tools/latest/bin" ]; then
    echo "$sdk_root/cmdline-tools/latest/bin" >> "$GITHUB_PATH"
  fi
  if [ -d "$sdk_root/platform-tools" ]; then
    echo "$sdk_root/platform-tools" >> "$GITHUB_PATH"
  fi
  bt=$(find "$sdk_root/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1 || true)
  if [ -n "${bt:-}" ]; then
    echo "$bt" >> "$GITHUB_PATH"
  fi
fi

sdkmanager=""
if [ -x "$sdk_root/cmdline-tools/latest/bin/sdkmanager" ]; then
  sdkmanager="$sdk_root/cmdline-tools/latest/bin/sdkmanager"
else
  sdkmanager=$(find "$sdk_root/cmdline-tools" -name sdkmanager -type f 2>/dev/null | sort | tail -1 || true)
fi

mkdir -p "$sdk_root/licenses"
printf '%s\n' "24333f8a63b6825ea9c5514f83c2829b004d1fee" > "$sdk_root/licenses/android-sdk-license"

if [ -n "$sdkmanager" ]; then
  yes | "$sdkmanager" --sdk_root="$sdk_root" --licenses >/dev/null || true
  if [ ! -d "$sdk_root/platforms/android-35" ] || ! find "$sdk_root/build-tools" -path '*/35*/aapt' -type f | grep -q .; then
    "$sdkmanager" --sdk_root="$sdk_root" --install "platforms;android-35" "build-tools;35.0.0"
  fi
else
  echo "sdkmanager absent — SDK préinstallé uniquement"
fi

if [ ! -d "$sdk_root/platforms/android-35" ]; then
  echo "platforms;android-35 manquant dans $sdk_root" >&2
  find "$sdk_root/platforms" -maxdepth 1 -type d -printf '%f\n' >&2 || true
  exit 1
fi
if ! find "$sdk_root/build-tools" -name aapt -type f | grep -q .; then
  echo "aapt manquant" >&2
  exit 1
fi
if ! find "$sdk_root/build-tools" -name apksigner -type f | grep -q .; then
  echo "apksigner manquant" >&2
  exit 1
fi

echo "SDK OK : $sdk_root"
find "$sdk_root/build-tools" -name apksigner -type f | sort | tail -1
