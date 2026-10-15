#!/usr/bin/env bash
# Builds dist/model-picker-<target>.tar.gz for one platform: the compiled CLI, the Pi router bundled
# into one file, and Pi's own release binary at the version package.json pins.
#   scripts/package.sh darwin-arm64     (also darwin-x64, linux-x64, linux-arm64)
set -euo pipefail
cd "$(dirname "$0")/.."

target=${1:?usage: scripts/package.sh <darwin-arm64|darwin-x64|linux-x64|linux-arm64>}
case $target in
  darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64) ;;
  *) echo "Unknown target: $target" >&2; exit 1 ;;
esac

pi_version=$(jq -r '.dependencies["@earendil-works/pi-coding-agent"]' package.json)
name=model-picker-$target
out=dist/$name
rm -rf "$out" "dist/$name.tar.gz"
mkdir -p "$out/bin"

bun build --compile --target="bun-$target" src/cli.ts --outfile "$out/bin/model-picker"
# Pi provides its own packages to extensions, so only those stay external.
bun build pi/router.ts --target=node --format=esm --external '@earendil-works/*' --outfile "$out/router.js"

pi_cache=dist/pi-$pi_version
pi_tarball=pi-$target.tar.gz
mkdir -p "$pi_cache"
if [[ ! -f $pi_cache/$pi_tarball ]]; then
  base=https://github.com/earendil-works/pi/releases/download/v$pi_version
  curl -fsSL "$base/SHA256SUMS" -o "$pi_cache/SHA256SUMS"
  curl -fsSL "$base/$pi_tarball" -o "$pi_cache/$pi_tarball.part"
  expected=$(awk -v file="$pi_tarball" '$2 == file { print $1 }' "$pi_cache/SHA256SUMS")
  actual=$(shasum -a 256 "$pi_cache/$pi_tarball.part" | awk '{ print $1 }')
  if [[ -z $expected || $expected != "$actual" ]]; then
    echo "Checksum mismatch for $pi_tarball (expected ${expected:-none}, got $actual)" >&2
    exit 1
  fi
  mv "$pi_cache/$pi_tarball.part" "$pi_cache/$pi_tarball"
fi
tar xzf "$pi_cache/$pi_tarball" -C "$out"

# Apple Silicon refuses to run unsigned binaries; re-sign ad hoc in case Bun's own signature is missing.
if [[ $target == darwin-* && $(uname -s) == Darwin ]]; then
  codesign --force --sign - "$out/bin/model-picker"
fi

cp LICENSE "$out/"
tar czf "dist/$name.tar.gz" -C dist "$name"
# Pi's bundled examples would otherwise trip this repo's typecheck and pin checks.
rm -rf "$out"
echo "dist/$name.tar.gz"
