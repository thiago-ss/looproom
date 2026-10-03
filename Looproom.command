#!/bin/zsh
cd "${0:A:h}"
if ! command -v node >/dev/null; then
  print 'Looproom needs Node.js 22.13 or later. Install Node.js, then open Looproom again.'
  read '?Press Return to close. '
  exit 1
fi
node scripts/launch.mjs
result=$?
if (( result != 0 )); then
  read '?Press Return to close. '
fi
exit $result
