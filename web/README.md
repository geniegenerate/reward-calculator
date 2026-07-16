# Web calculator — hosting

Static site for <https://verify.geniegenerate.com/calculator>. No build step, no
framework, no external dependencies — everything the page loads is in this
directory so the whole trust surface is auditable in one place.

`calculator.wasm` is intentionally **not** committed anywhere in this repo (the
binary's distribution channel is GitHub releases, whose asset hash equals the
on-chain `algorithm_id`). Deployment downloads the release asset into the page
directory, which guarantees the page serves byte-identical code to the
announced artifact.

## Cloudflare Pages settings

- **Build command:**
  `curl -fsSL -o web/calculator/calculator.wasm https://github.com/geniegenerate/reward-calculator/releases/latest/download/calculator.wasm`
- **Build output directory:** `web`
- **Custom domain:** `verify.geniegenerate.com`

Deploy check after every algorithm release: open the page and confirm the
`keccak256(calculator.wasm)` it displays equals the newly announced
`algorithm_id` (the page computes it from the served bytes, so a stale deploy
is immediately visible).
