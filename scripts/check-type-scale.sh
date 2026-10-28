#!/bin/sh
# Fails if an arbitrary text-[Npx] size that has a scale class reappears in src/ui.
# Scale: --text-2xs..xl in src/ui/index.css (9, 10, 11, 12, 13, 16, 22px).
cd "$(dirname "$0")/.." || exit 1
if grep -rnE 'text-\[(9|10|11|12|13|16|22)px\]' src/ui; then
  echo "check-type-scale: use text-2xs|xs|sm|md|base|lg|xl instead of text-[Npx]" >&2
  exit 1
fi
echo "type scale OK"
