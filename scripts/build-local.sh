#!/bin/sh
# Build a signed release APK on this machine and install it over the app on the phone – no push, no CI.
#
# It must be signed with the SAME key as the installed app (or Android refuses the update), so it reads
# the keystore and its password from a file outside the repo, ~/.ocm-build (never commit it):
#
#   OCM_KEYSTORE='C:/path/to/chronicle.keystore'
#   OCM_KEYSTORE_PASSWORD='…'
#   # optional: OCM_KEY_ALIAS='chronicle'  OCM_KEY_PASSWORD='…'
#
# The version is one above what the phone has, so it installs as an update. CI's run numbers keep
# counting on their own; if a later CI build has a lower number than a local one, push again or build
# here once more.
#
#   sh scripts/build-local.sh            build + install on the connected phone
#   sh scripts/build-local.sh --no-install
set -eu
cd "$(dirname "$0")/.."

CONF="${OCM_BUILD_CONF:-$HOME/.ocm-build}"
if [ -f "$CONF" ]; then
  # written with Notepad is fine: Windows line endings and a UTF-8 BOM are dropped before it is read
  eval "$(sed '1s/^\xEF\xBB\xBF//; s/\r$//' "$CONF")"
fi
: "${OCM_KEYSTORE:?set OCM_KEYSTORE in $CONF (the release keystore that signs the installed app)}"
: "${OCM_KEYSTORE_PASSWORD:?set OCM_KEYSTORE_PASSWORD in $CONF}"
[ -f "$OCM_KEYSTORE" ] || { echo "no keystore at $OCM_KEYSTORE" >&2; exit 1; }
export OCM_KEYSTORE OCM_KEYSTORE_PASSWORD
[ -n "${OCM_KEY_ALIAS:-}" ] && export OCM_KEY_ALIAS
[ -n "${OCM_KEY_PASSWORD:-}" ] && export OCM_KEY_PASSWORD

ADB="${ADB:-${LOCALAPPDATA:-}/Android/Sdk/platform-tools/adb.exe}"
[ -x "$ADB" ] || ADB=adb
install=1
[ "${1:-}" = "--no-install" ] && install=0

if [ -z "${VERSION_CODE:-}" ]; then
  cur=$("$ADB" shell dumpsys package dev.chronicle.app 2>/dev/null | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -1)
  # minutes since 2026-01-01 UTC, the same clock CI uses, so whichever build is newer is offered as the update
  VERSION_CODE=$(( $(date +%s) / 60 - 29453760 ))
  [ "$VERSION_CODE" -le "${cur:-0}" ] && VERSION_CODE=$(( ${cur:-0} + 1 ))
fi
echo "--- building version 1.0.$VERSION_CODE (code $VERSION_CODE)"

npm run build
npx cap sync android
( cd android && ./gradlew assembleRelease -PversionCode="$VERSION_CODE" )

APK=android/app/build/outputs/apk/release/app-release.apk
[ -f "$APK" ] || { echo "no APK at $APK" >&2; exit 1; }
ls -la "$APK"
if [ "$install" -eq 1 ]; then
  echo "--- installing on the phone (data is kept: same key, higher version)"
  "$ADB" install -r "$APK"
  "$ADB" shell dumpsys package dev.chronicle.app | grep -m1 versionName
fi
