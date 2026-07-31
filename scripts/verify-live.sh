#!/usr/bin/env bash
# Verify what is ACTUALLY DEPLOYED, not what is in the repo.
#
# Cloudflare Pages rebuilds on git push, not on GitHub releases — so publishing
# a new algorithm release without a follow-up push leaves the live page serving
# the previous WASM. The build-time gate in cf-pages-build.sh cannot catch that
# (it never runs). This script closes the loop from the outside:
#
#   deployed binary  ==  latest release asset  ==  README on-chain anchor
#
# Exit 0 = the live page serves the announced algorithm. Any mismatch exits 1
# and says which of the three disagrees.
set -euo pipefail

SITE="${1:-https://verify.geniegenerate.com/calculator}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

hash_of() {
  node -e "
    const {keccak256} = require('$REPO_ROOT/web/calculator/sha3.js');
    const fs = require('fs');
    process.stdout.write('0x' + keccak256(new Uint8Array(fs.readFileSync('$1'))));
  "
}

echo "site: $SITE"

# 1. What the live page actually serves. Follow redirects so the canonical
#    domain works whether it serves directly or bounces to the Pages origin.
if ! curl -fsSL --max-time 60 -o "$TMP/deployed.wasm" "${SITE%/}/calculator.wasm"; then
  echo "FAIL: could not fetch ${SITE%/}/calculator.wasm" >&2
  exit 1
fi
DEPLOYED="$(hash_of "$TMP/deployed.wasm")"
echo "deployed : $DEPLOYED"

# 2. What the latest GitHub release publishes.
curl -fsSL --max-time 60 -o "$TMP/release.wasm" \
  https://github.com/geniegenerate/reward-calculator/releases/latest/download/calculator.wasm
RELEASE="$(hash_of "$TMP/release.wasm")"
echo "release  : $RELEASE"

# 3. What the README's on-chain anchor table claims.
if grep -qF "$DEPLOYED" "$REPO_ROOT/README.md"; then
  echo "anchor   : present in README"
else
  echo "anchor   : MISSING from README" >&2
fi

STATUS=0
if [ "$DEPLOYED" != "$RELEASE" ]; then
  echo "FAIL: the live page is NOT serving the latest release." >&2
  echo "      Push to main (or re-run the Pages build) to redeploy." >&2
  STATUS=1
fi
if ! grep -qF "$DEPLOYED" "$REPO_ROOT/README.md"; then
  echo "FAIL: the deployed algorithm_id is not in the README anchor table." >&2
  echo "      Either the README is stale, or an unannounced binary is live." >&2
  STATUS=1
fi

if [ "$STATUS" -eq 0 ]; then
  echo "OK: deployed == latest release == README anchor"
fi
exit "$STATUS"
