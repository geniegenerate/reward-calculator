#!/usr/bin/env bash
# Cloudflare Pages build for the hosted web calculator (publish dir: web/).
# Same contract as .github/workflows/pages.yml: the served calculator.wasm is
# the GitHub release asset — byte-identical to the announced algorithm_id —
# fetched at build time (never committed), then hash-verified against the
# README's on-chain anchor. A stale release or stale README fails the build.
set -euo pipefail

curl -fsSL -o web/calculator/calculator.wasm \
  https://github.com/geniegenerate/reward-calculator/releases/latest/download/calculator.wasm

node -e "
const {keccak256} = require('./web/calculator/sha3.js');
const fs = require('fs');
const h = '0x' + keccak256(new Uint8Array(fs.readFileSync('web/calculator/calculator.wasm')));
const readme = fs.readFileSync('README.md', 'utf8');
if (!readme.includes(h)) {
  console.error('served wasm hash ' + h + ' not found in README On-chain anchor — stale release or stale README');
  process.exit(1);
}
console.log('served wasm hash ' + h + ' matches README anchor');
"
