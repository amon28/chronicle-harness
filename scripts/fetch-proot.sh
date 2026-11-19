#!/usr/bin/env bash
# Fetches proot (from the Termux package repository) and turns it into native libraries the app is allowed to run:
# Android only lets an app execute files that ship inside the APK as lib*.so. Output: android/app/src/main/jniLibs/arm64-v8a/
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=android/app/src/main/jniLibs/arm64-v8a
REPO=https://packages.termux.dev/apt/termux-main
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if [ -f "$OUT/libproot.so" ] && [ -f "$OUT/libtalloc.so" ] && [ -f "$OUT/libandroid-shmem.so" ] && [ -f "$OUT/libproot-loader.so" ]; then echo "proot libraries already present"; exit 0; fi
command -v patchelf >/dev/null || pip install --quiet patchelf
curl -fsSL "$REPO/dists/stable/main/binary-aarch64/Packages" -o "$TMP/Packages"
fetch() { # package name → extracted into $TMP/<name>
  local file
  file=$(awk -v p="$1" '$1=="Package:"{cur=$2} $1=="Filename:" && cur==p {print $2; exit}' "$TMP/Packages")
  [ -n "$file" ] || { echo "package $1 not found" >&2; exit 1; }
  curl -fsSL "$REPO/$file" -o "$TMP/$1.deb"
  mkdir -p "$TMP/$1" && (cd "$TMP/$1" && ar x "../$1.deb" && tar xf data.tar.*)
}
for p in proot libtalloc libandroid-shmem; do fetch "$p"; done
USR=data/data/com.termux/files/usr
mkdir -p "$OUT"
cp "$TMP/proot/$USR/bin/proot" "$OUT/libproot.so"
cp "$TMP/proot/$USR/libexec/proot/loader" "$OUT/libproot-loader.so"
cp "$(ls "$TMP"/libtalloc/$USR/lib/libtalloc.so.*.* | head -1)" "$OUT/libtalloc.so"
cp "$(ls "$TMP"/libandroid-shmem/$USR/lib/libandroid-shmem.so | head -1)" "$OUT/libandroid-shmem.so"
# the dynamic linker looks libraries up by file name inside the app's lib folder
patchelf --set-soname libtalloc.so "$OUT/libtalloc.so"
patchelf --replace-needed libtalloc.so.2 libtalloc.so --remove-rpath "$OUT/libproot.so"
patchelf --remove-rpath "$OUT/libtalloc.so" "$OUT/libandroid-shmem.so" 2>/dev/null || true
chmod 755 "$OUT"/*.so
echo "proot ready:"; ls -l "$OUT"
