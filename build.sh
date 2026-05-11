#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

mkdir -p artifacts
cargo build-sbf --manifest-path "$ROOT_DIR/Cargo.toml" --sbf-out-dir "$ROOT_DIR/artifacts"

echo "Built artifacts:"
ls -la "$ROOT_DIR/artifacts"
