# GenieGenerate Reward Calculator

The **open-source, reproducible reward calculator** behind GenieGenerate's
trustless daily-reward distribution. This is the exact program whose compiled
WebAssembly binary is anchored on-chain: `keccak256(calculator.wasm)` **is** the
`algorithm_id` published in the `RewardVerifier` contract. Anyone can rebuild the
WASM from this source, confirm the hash matches the on-chain announcement, run it
on their own exported distribution snapshot, and independently reproduce their
reward — no trust in GenieGenerate's servers required.

## On-chain anchor (v3.7)

| | |
|---|---|
| `algorithm_id` | `0xc32dbb34adccc93bf871e725b6afbfc7a8343377600dd79b4b4a8771731824bb` |
| Contract (`RewardVerifier`, BSC testnet) | `0x7fFeeEa9ED233B7c50aD291A4d8044249ABF2174` |
| Announce tx | `0xda72a5d2dd4212aad6781db0625717bad5904a1a60a627b53625f5e80cf1f0ee` |
| Effective | `2026-06-16T19:01:15Z` (after the contract's 7-day MIN_TIMELOCK) |

`algorithm_id = "0x" + keccak256(calculator.wasm)`. The 7-day timelock between
announcement and effectiveness exists precisely so anyone can verify this source
and its compiled artifact *before* it computes any rewards.

## Reproducible build

The WASM bytes — and therefore the `algorithm_id` — depend on the Go toolchain
and the module path, so both are pinned. Build with:

```sh
GOTOOLCHAIN=go1.25.11 CGO_ENABLED=0 GOOS=wasip1 GOARCH=wasm \
  go build -trimpath -buildvcs=false -o calculator.wasm ./cmd/reward-calculator
```

- **`GOTOOLCHAIN=go1.25.11`** — a different Go version produces different WASM
  bytes (hence a different `algorithm_id`). `go.mod` pins `toolchain go1.25.11`;
  the toolchain is auto-downloaded if you don't have it. Treat a toolchain bump
  like an algorithm change.
- **`-trimpath`** — strips local filesystem paths, leaving only the module-
  relative import paths in the binary. This is why the build is identical across
  machines, and why the module path below must not change.
- **module path** — `go.mod` declares `module github.com/geniegenerate/backend`.
  `-trimpath` bakes import paths (e.g. `.../internal/reward/rewardcalc`) into the
  binary, so the module path is part of the hash. It is intentionally kept as the
  origin module path even though this repo is named `reward-calculator`.
- **`CGO_ENABLED=0`, `-buildvcs=false`** — no C linkage, no embedded VCS stamp,
  so nothing host-specific leaks into the bytes.

### Confirm the hash

```sh
# foundry
cast keccak "$(xxd -p -c0 calculator.wasm)"

# or python (pycryptodome)
python3 -c "from Crypto.Hash import keccak; h=keccak.new(digest_bits=256); \
h.update(open('calculator.wasm','rb').read()); print('0x'+h.hexdigest())"
```

The output must equal the `algorithm_id` above and the value announced on-chain.
Note: `keccak256` is **not** the same as SHA3-256 — use a keccak implementation.

## Run it

The calculator is a pure stdin → stdout filter over any WASI runtime:

```sh
wasmtime calculator.wasm < input-snapshot.json > result.json
```

`input-snapshot.json` is the pseudonymized distribution snapshot you export from
the app (or fetch from the public `/rewards/distributions/{date}/input-snapshot`
endpoint). `result.json` is the per-participant reward result. To complete the
trustless check, rebuild the Merkle root from `result.json` and confirm it equals
the `result_merkle_root` committed on-chain for that distribution.

## What's here

```
cmd/reward-calculator/main.go        # WASI entrypoint: stdin → rewardcalc.ComputeJSON → stdout
internal/reward/rewardcalc/calc.go   # the reward math (grid + newcomer loops + 6-dp truncation)
internal/reward/rewardcalc/json.go   # snapshot ⇄ result (de)serialization
go.mod / go.sum                      # pinned toolchain + the single dependency (shopspring/decimal)
```

This is the complete build closure of the published WASM — nothing else is
compiled into the artifact. The full equivalence/determinism test suite that
proves this code stays bit-locked to the production money path lives in
GenieGenerate's backend; this repository carries exactly what's needed to
rebuild and verify the on-chain artifact.
