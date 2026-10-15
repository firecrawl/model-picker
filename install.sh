#!/bin/sh
# Installs model-picker (`model-picker` and `mp`) on macOS or Linux from GitHub Releases:
#   curl -fsSL https://raw.githubusercontent.com/firecrawl/model-picker/main/install.sh | sh
# Run it again to update. Settings, all optional:
#   MODEL_PICKER_VERSION  a release tag such as v0.2.0 (default: the latest release)
#   MODEL_PICKER_DIR      where the files go (default: ~/.local/share/model-picker)
#   MODEL_PICKER_BIN_DIR  where the commands go (default: ~/.local/bin)

# Everything runs inside main, so a download cut off halfway runs nothing.
main() {
  set -eu
  repo=firecrawl/model-picker
  version=${MODEL_PICKER_VERSION:-latest}
  install_dir=${MODEL_PICKER_DIR:-$HOME/.local/share/model-picker}
  bin_dir=${MODEL_PICKER_BIN_DIR:-$HOME/.local/bin}
  config_dir=$HOME/.config/model-picker

  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "model-picker runs on macOS and Linux; this is $(uname -s)." ;;
  esac
  case $(uname -m) in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail "No build for $(uname -m) processors." ;;
  esac
  # A shell under Rosetta reports x86_64 on an Apple Silicon Mac; the native build is faster.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
    arch=arm64
  fi

  command -v curl >/dev/null || fail "curl is needed to download model-picker."
  if command -v sha256sum >/dev/null; then
    sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
  elif command -v shasum >/dev/null; then
    sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
  else
    fail "sha256sum or shasum is needed to check the download."
  fi

  if [ "$version" = latest ]; then
    base=https://github.com/$repo/releases/latest/download
  else
    base=https://github.com/$repo/releases/download/$version
  fi
  base=${MODEL_PICKER_BASE_URL:-$base}
  asset=model-picker-$os-$arch.tar.gz

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading $asset ($version)"
  curl -fSL --progress-bar "$base/$asset" -o "$tmp/$asset" || fail "Download failed: $base/$asset"
  curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "Download failed: $base/SHA256SUMS"

  expected=$(awk -v file="$asset" '$2 == file || $2 == "*" file { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset."
  actual=$(sha256 "$tmp/$asset")
  [ "$expected" = "$actual" ] || fail "Checksum mismatch for $asset: expected $expected, got $actual. Nothing was installed."
  say "Checksum OK"

  tar xzf "$tmp/$asset" -C "$tmp"
  mkdir -p "$(dirname "$install_dir")" "$bin_dir"
  # Swap the whole folder so an update never leaves half of an old Pi behind.
  rm -rf "$install_dir.old"
  if [ -e "$install_dir" ]; then mv "$install_dir" "$install_dir.old"; fi
  mv "$tmp/model-picker-$os-$arch" "$install_dir"
  rm -rf "$install_dir.old"
  ln -sf "$install_dir/bin/model-picker" "$bin_dir/model-picker"
  ln -sf "$install_dir/bin/model-picker" "$bin_dir/mp"

  if [ ! -e "$config_dir/.env" ]; then
    mkdir -p "$config_dir"
    (
      umask 077
      cat >"$config_dir/.env" <<'EOF'
# model-picker reads keys from here when they aren't set in your shell.
# FIRECRAWL_API_KEY=fc-...      every command; free at https://firecrawl.dev
# OPENROUTER_API_KEY=sk-or-...  chat and build; https://openrouter.ai
# SUBQ_API_KEY=...              optional; https://subq.ai
EOF
    )
  fi

  installed=$("$install_dir/bin/model-picker" --version) || fail "Installed, but $install_dir/bin/model-picker didn't run."
  say "Installed model-picker $installed to $install_dir"
  echo
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      echo "$bin_dir isn't on your PATH yet. Add this line to your shell profile (~/.zshrc or ~/.bashrc):"
      echo "  export PATH=\"$bin_dir:\$PATH\""
      echo
      ;;
  esac
  echo "Next: add your keys to $config_dir/.env, then try:"
  echo "  mp pick --min-score 45"
  echo "  mp chat"
}

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() {
  printf '\033[31merror:\033[0m %s\n' "$1" >&2
  exit 1
}

main "$@"
