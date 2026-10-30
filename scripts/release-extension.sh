#!/usr/bin/env bash
set -euo pipefail
# Build the extension zip and publish it through the board: apps/web/public/extension/<file> + latest.json,
# which GET /api/extension serves and the installed extension checks on open. Notes — one argument per line.
# Usage: scripts/release-extension.sh "что нового 1" "что нового 2"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
EXT=$ROOT/apps/extension
OUT=$ROOT/apps/web/public/extension
VER=$(node -p "require('$EXT/package.json').version")
[ "$#" -gt 0 ] || { echo "нужны строки «что нового» аргументами" >&2; exit 1; }

(cd "$EXT" && npm run zip >/dev/null)
ZIP="$EXT/.output/thextension-$VER-chrome.zip"
[ -s "$ZIP" ] || { echo "архив не собран: $ZIP" >&2; exit 1; }

mkdir -p "$OUT"
rm -f "$OUT"/tester-huester-*.zip # only the newest build is offered; older ones live in git history
FILE="tester-huester-$VER.zip"
cp "$ZIP" "$OUT/$FILE"
cp "$ZIP" "$ROOT/th-extension-chrome-mv3.zip" # the old download path keeps working
OUT="$OUT" node -e '
const [ver, file, ...notes] = process.argv.slice(1)
const fs = require("fs")
fs.writeFileSync(process.env.OUT + "/latest.json", JSON.stringify({ version: ver, file, notes, releasedAt: new Date().toISOString() }, null, 2) + "\n")
' "$VER" "$FILE" "$@"
echo "опубликовано: $OUT/$FILE (версия $VER)"
