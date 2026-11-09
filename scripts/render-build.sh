#!/usr/bin/env bash
# Render's build command (render.yaml, spec §10.2). Render's image has Node and npm but no
# Rust, so this installs a minimal stable toolchain with the Wasm target, then builds the way
# CI does. It also stamps the commit and build time into the footer (spec §10.4, R5).
set -euo pipefail

# Reuse a toolchain from an earlier build if one is there; otherwise install it.
cargo_env="${CARGO_HOME:-$HOME/.cargo}/env"
if [ -f "$cargo_env" ]; then
  source "$cargo_env"
fi
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs |
    sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
  source "$cargo_env"
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
