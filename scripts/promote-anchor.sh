#!/usr/bin/env bash
# Flip the public anchor to v4.0 once its announced effective date has passed.
#
# WHY THIS EXISTS AT ALL. The hosted verifier at verify.geniegenerate.com/calculator
# builds from `releases/latest` (scripts/cf-pages-build.sh) and Cloudflare Pages
# rebuilds on PUSH, not on a GitHub release. So three things must happen together at
# the effective date, and missing any one leaves the public calculator serving the
# PREVIOUS algorithm while the new one is already paying people:
#
#   1. v4.0 stops being a pre-release, so `releases/latest` resolves to it;
#   2. the README anchor names v4.0 — the Pages build asserts the served hash appears
#      in the README, so without this the build FAILS CLOSED (which is the safety net
#      that let v4.0 be published early at all);
#   3. something pushes.
#
# Nothing does that on its own, and a human remembering a date a week later is exactly
# the failure this repo already has a workflow (verify-live) to DETECT and nothing to
# PREVENT. This is the prevention.
#
# IT DOES NOT COMPOSE THE README. The post-cutover text was written and reviewed by a
# human on 2026-09-18 and lives in anchor/README.v4.0.md; this script only swaps it in.
# An unattended job doing prose surgery on a public trust surface is how you get a
# mangled anchor nobody notices. It also refuses to act if README.md is not the exact
# file that plan was written against (anchor/README.pre-v4.0.sha256) — if someone edited
# it meanwhile, a human redoes the swap.
#
# Idempotent: safe to run every day forever. Exit 0 = nothing to do or done; 1 = it
# needs a human. Set DRY_RUN=1 to print the decision without touching anything.
set -uo pipefail
cd "$(dirname "$0")/.."

TAG=v4.0
EFFECTIVE=2026-09-25T15:05:55Z   # UTC. Announced tx 0x9fb17c2e…, block 131763757.
ID=0x892bd64ae40b3f18ca7b3e19720b52644284e227a7cbc421d6d698dd0b7391a9
POST=anchor/README.v4.0.md
PRE_SHA_FILE=anchor/README.pre-v4.0.sha256

say() { printf '%s\n' "$*"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
now_epoch() { date -u +%s; }
eff_epoch() {
    # BSD date (macOS) and GNU date (CI) disagree on parsing; try both.
    date -u -j -f %Y-%m-%dT%H:%M:%SZ "$EFFECTIVE" +%s 2>/dev/null || date -u -d "$EFFECTIVE" +%s
}

EFF=$(eff_epoch) || { say "STOP: cannot parse EFFECTIVE=$EFFECTIVE"; exit 1; }
NOW=${FAKE_NOW_EPOCH:-$(now_epoch)}

# --- already done? idempotent, and checked BEFORE the date so a manual early swap
#     is recognised rather than fought with.
if [ "$(sha README.md)" = "$(sha "$POST")" ]; then
    say "anchor already on $TAG — nothing to do"
    exit 0
fi

if [ "$NOW" -lt "$EFF" ]; then
    say "not due: $EFFECTIVE has not passed (in $(( (EFF - NOW) / 3600 ))h)"
    exit 0
fi

# --- the README must be the one the plan was written against ------------------
want="$(cat "$PRE_SHA_FILE")"
got="$(sha README.md)"
if [ "$want" != "$got" ]; then
    say "STOP: README.md changed since the v4.0 swap was prepared."
    say "      expected $want"
    say "      found    $got"
    say "      Redo the anchor edit by hand, then refresh $PRE_SHA_FILE (or delete this script)."
    exit 1
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
    say "DRY RUN: would promote $TAG to latest and swap in $POST"
    exit 0
fi

# --- 1. the release stops being a pre-release --------------------------------
if command -v gh >/dev/null 2>&1; then
    gh release edit "$TAG" --prerelease=false --latest || { say "STOP: could not promote $TAG"; exit 1; }
    say "promoted $TAG out of pre-release"
else
    say "STOP: gh is not available, cannot promote the release"; exit 1
fi

# --- 2. the README names v4.0 ------------------------------------------------
cp "$POST" README.md
say "anchor swapped to $TAG"

# --- 3. verify BEFORE handing back: what latest now serves must be what the
#        README claims. This is the same assertion cf-pages-build.sh makes at
#        build time, run here so a bad state never reaches a push.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if curl -fsSL --max-time 60 -o "$tmp/latest.wasm" \
     https://github.com/geniegenerate/reward-calculator/releases/latest/download/calculator.wasm; then
    got_id=$(node -e "
      const {keccak256}=require('./web/calculator/sha3.js');const fs=require('fs');
      process.stdout.write('0x'+keccak256(new Uint8Array(fs.readFileSync('$tmp/latest.wasm'))))")
    if [ "$got_id" != "$ID" ]; then
        say "STOP: releases/latest now serves $got_id, expected $ID"; exit 1
    fi
    grep -qF "$ID" README.md || { say "STOP: $ID is not in README.md"; exit 1; }
    say "verified: releases/latest serves $ID and the README anchor names it"
else
    say "WARN: could not re-fetch releases/latest to verify (the swap still stands; verify-live will re-check)"
fi

say "DONE — commit and push are the caller's job (the workflow does it)."
