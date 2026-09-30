#!/bin/sh
# Loads the API entry the way Vercel's Node runtime does: every file
# transpiled on its own (no bundling), imported by plain Node ESM, then called
# through its named GET export.
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
# Then call it the way Vercel does: a named method export, Request in,
# Response out. /api/health needs no database or credentials.
node --input-type=module -e "
const api = await import('./api/index.js');
if (typeof api.GET !== 'function') throw new Error('api/index.ts must export GET (and the other methods) for Vercel');
const res = await api.GET(new Request('https://example.invalid/api/health'));
const body = await res.json();
if (res.status !== 200 || body.ok !== true) throw new Error('GET /api/health returned ' + res.status + ' ' + JSON.stringify(body));
console.log('api entry loads under Node ESM and answers GET /api/health');
"
