#!/bin/zsh
set -e
cd "${0:A:h}"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  print 'Install Node.js 22.13 or later, then open Looproom again.'
  read '?Press Return to close. '
  exit 1
fi
[[ -d node_modules ]] || npm ci
npm run build
node scripts/launch.mjs
