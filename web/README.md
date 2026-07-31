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

- **Build command:** `bash scripts/cf-pages-build.sh`
  (fetches the latest release asset **and** hash-verifies it against the
  README's on-chain anchor — a bare `curl` would drop that gate and let a stale
  or mismatched binary ship)
- **Build output directory:** `web`
- **Production branch:** `main` — Cloudflare rebuilds on push to it
- **Custom domain:** `verify.geniegenerate.com`

## Publishing a new algorithm version

Cloudflare builds on **git push**, not on GitHub releases, so publishing a
release alone does **not** redeploy the page — it would keep serving the
previous WASM. The release checklist is therefore:

1. Publish the GitHub release with the new `calculator.wasm`.
2. Update this repo's README on-chain anchor table with the new
   `algorithm_id`, and **push** — that push is what triggers the rebuild, and
   the build fails if the two disagree.
3. Confirm: `./scripts/verify-live.sh` (checks the deployed page's served
   binary against the latest release and the README anchor).

Step 3 is also worth running on its own any time you want assurance the live
page is serving the announced algorithm; it is the only check that looks at
what is *actually deployed* rather than what is in the repo.
