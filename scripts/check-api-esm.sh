#!/bin/sh
# Loads the API entry the way Vercel's Node runtime does: every file
# transpiled on its own (no bundling), then imported by plain Node ESM.
# Bun and Vite resolve extensionless relative imports and JSON without import
# attributes; Node does not, and on Vercel that failure takes down every
# /api route at once. This catches it before a deploy does.
set -e
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
FILES=$(find api src/server src/shared data -name '*.ts' ! -name '*.test.ts')
./node_modules/.bin/esbuild $FILES --outdir="$OUT" --outbase=. --format=esm --platform=node --log-level=error
find data -name '*.json' | while read -r f; do
  mkdir -p "$OUT/$(dirname "$f")"
  cp "$f" "$OUT/$f"
done
echo '{"type":"module"}' > "$OUT/package.json"
ln -s "$PWD/node_modules" "$OUT/node_modules"
cd "$OUT"
node -e "import('./api/index.js').then(() => console.log('api entry loads under Node ESM')).catch((e) => { console.error(e.message); process.exit(1) })"
