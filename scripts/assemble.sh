#!/bin/sh
# Assembles the extension into the folder given (load it unpacked): the open files of this repository,
# the compiled solvers from wasm/ (hash-checked), onnxruntime-web from npm at the version and
# integrity hash pnpm-lock.yaml pins, and the models downloaded from the release models.release
# names (hash-checked against models.SHA256SUMS). Needs node, pnpm and gh (signed in, or GH_TOKEN).
#
#   sh scripts/assemble.sh dist/neucap
set -eu
cd "$(dirname "$0")/.."
out=${1:?usage: assemble.sh <folder>}
repo=${NEUCAP_REPO:-nanbiz/neucap}

(cd wasm && sha256sum -c SHA256SUMS)

rm -rf "$out"
mkdir -p "$out/ort" "$out/models"
cp manifest.json sw.js detect.js patterns.js "$out/"
cp -r ui icons wasm "$out/"
rm "$out/wasm/SHA256SUMS" "$out/wasm/BUILT_FROM"

pnpm install --frozen-lockfile --silent --config.strict-dep-builds=false
ort=node_modules/onnxruntime-web/dist
cp "$ort/ort.webgpu.bundle.min.mjs" "$ort/ort-wasm-simd-threaded.asyncify.wasm" "$out/ort/"

cache=${NEUCAP_MODELS:-"${TMPDIR:-/tmp}/neucap-models"}
mkdir -p "$cache"
if ! (cd "$cache" && sha256sum -c --quiet "$OLDPWD/models.SHA256SUMS" 2>/dev/null); then
  gh release download "$(cat models.release)" --repo "$repo" --dir "$cache" --pattern '*.onnx' --clobber
  (cd "$cache" && sha256sum -c "$OLDPWD/models.SHA256SUMS")
fi
cp "$cache"/*.onnx "$out/models/"
node model-info.mjs "$out/models"
echo "assembled $out"
