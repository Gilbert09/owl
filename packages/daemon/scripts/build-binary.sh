#!/usr/bin/env bash
set -euo pipefail

# Compile the daemon into a single self-contained binary using `bun --compile`.
#
# Bun supports cross-compilation — you can produce any target from any host.
# CI runs this on ubuntu-latest and produces all five binaries in one shot.
# Developers can run it locally for their own platform only.
#
# Usage:
#   scripts/build-binary.sh                     # build for current platform
#   scripts/build-binary.sh all                 # build every supported target
#   scripts/build-binary.sh bun-darwin-arm64    # build a specific target

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT}/dist"
ENTRY="${ROOT}/src/index.ts"

# Supported targets. Keep in sync with the matrix in
# .github/workflows/build-daemon-binaries.yml.
TARGETS=(
  bun-darwin-arm64
  bun-darwin-x64
  bun-linux-x64
  bun-linux-arm64
  bun-windows-x64
)

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is not installed." >&2
  echo "  macOS/Linux: curl -fsSL https://bun.sh/install | bash" >&2
  echo "  Or in CI: uses: oven-sh/setup-bun@v1" >&2
  exit 1
fi

build_one() {
  local target="$1"
  local suffix=""
  if [[ "${target}" == *"windows"* ]]; then
    suffix=".exe"
  fi
  local out_path="${OUT_DIR}/fastowl-daemon-${target#bun-}${suffix}"
  echo "→ building ${target} (sha=${BUILD_SHA:0:7}) → ${out_path}"
  # --define bakes the SHA into the compiled binary so
  # resolveDaemonVersion() returns the right value at runtime without
  # needing a version.json on disk.
  bun build --compile --minify --sourcemap \
    --target="${target}" \
    --define 'process.env.FASTOWL_DAEMON_SHA='"\"${BUILD_SHA}\"" \
    "${ENTRY}" \
    --outfile "${out_path}"
  echo "  ok ($(du -h "${out_path}" | cut -f1))"
}

# Capture the SHA the binary is being built from. In CI,
# `GITHUB_SHA` is always set; locally we fall back to `git rev-parse`
# so dev builds still identify themselves. Baked into the binary via
# bun's --define so resolveDaemonVersion() sees it at runtime.
BUILD_SHA="${GITHUB_SHA:-$(git -C "${ROOT}/../.." rev-parse HEAD 2>/dev/null || echo unknown)}"

mkdir -p "${OUT_DIR}"

case "${1:-local}" in
  local)
    # Detect current platform → matching bun target.
    host_os="$(uname -s)"
    host_arch="$(uname -m)"
    case "${host_os}-${host_arch}" in
      Darwin-arm64) build_one bun-darwin-arm64 ;;
      Darwin-x86_64) build_one bun-darwin-x64 ;;
      Linux-x86_64) build_one bun-linux-x64 ;;
      Linux-aarch64) build_one bun-linux-arm64 ;;
      *)
        echo "error: unknown host ${host_os}-${host_arch}; specify a target explicitly" >&2
        exit 1
        ;;
    esac
    ;;
  all)
    for t in "${TARGETS[@]}"; do
      build_one "${t}"
    done
    ;;
  bun-*)
    build_one "$1"
    ;;
  *)
    echo "usage: $0 [local|all|<bun-target>]" >&2
    exit 1
    ;;
esac
