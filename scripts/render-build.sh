#!/usr/bin/env bash
# Render's build command (render.yaml, spec §10.2). On Render it installs a minimal stable Rust
# toolchain with the Wasm target, then builds the way CI does. It also stamps the commit and
# build time into the footer (spec §10.4, R5).
set -euo pipefail

if [ -n "${RENDER:-}" ]; then
  # Render's image has Rust, but in a read-only /usr/local/rustup where rustup cannot add the
  # Wasm target. Keep a toolchain of our own in the build cache instead: Render keeps
  # $XDG_CACHE_HOME between builds, so only the first build downloads it.
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}"
  export RUSTUP_HOME="$cache_dir/rustup"
  export CARGO_HOME="$cache_dir/cargo"
  export PATH="$CARGO_HOME/bin:$PATH"
  if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    # -y also accepts rustup's warning about the preinstalled Rust on PATH.
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
      sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
  fi
else
  # Locally, use the developer's rustup, even when ~/.cargo/bin is not on PATH.
  cargo_env="${CARGO_HOME:-$HOME/.cargo}/env"
  if [ -f "$cargo_env" ]; then
    source "$cargo_env"
  fi
fi
# Idempotent: brings a reused toolchain up to the current stable, as CI uses, and adds the
# Wasm target. The build needs the toolchain, not a newer rustup.
rustup toolchain install stable --profile minimal --target wasm32-unknown-unknown --no-self-update
rustc --version

npm ci
npm run build:wasm # also enforces the 50 kB Wasm budget

# Render sets RENDER_GIT_COMMIT; the fallback lets the script run in any git checkout.
commit="${RENDER_GIT_COMMIT:-$(git rev-parse HEAD)}"
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Building commit ${commit} at ${built_at}"
# The local binary directly: npx would re-quote the arguments through another shell.
./node_modules/.bin/ng build --configuration production \
  --define "BUILD_COMMIT='${commit}'" \
  --define "BUILD_TIME='${built_at}'"
