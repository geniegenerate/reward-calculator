# GenieGenerate Reward Calculator

The **open-source, reproducible reward calculator** behind GenieGenerate's
trustless daily-reward distribution. This is the exact program whose compiled
WebAssembly binary is anchored on-chain: `keccak256(calculator.wasm)` **is** the
`algorithm_id` published in the `RewardVerifier` contract. Anyone can rebuild the
WASM from this source, confirm the hash matches the on-chain announcement, run it
on their own exported distribution snapshot, and independently reproduce their
reward — no trust in GenieGenerate's servers required.

## On-chain anchor (v3.9)

| | |
|---|---|
| `algorithm_id` | `0x26512565c91b76c1b1401dc41d75412f490a3fc7d76aef18d8e4ed47d8ef41e9` |
| Contract (`RewardVerifier`, BSC testnet) | `0x7fFeeEa9ED233B7c50aD291A4d8044249ABF2174` |
| Announce tx | `0x45172314ccf6efc0644d21a73dd2d2088f3c935ab2ca387fec1ea52e5d5a76dc` |
| Effective | `2026-06-23T03:15:46Z` (after the contract's 7-day MIN_TIMELOCK) |

`algorithm_id = "0x" + keccak256(calculator.wasm)`. The 7-day timelock between
announcement and effectiveness exists precisely so anyone can verify this source
and its compiled artifact *before* it computes any rewards.

**v3.9** changes the newcomer-leaderboard final-loop trigger from a flat
`pool ≤ $1.00` floor to per-capita `pool ≤ $0.01 × eligible participants`; the
grid math is unchanged from v3.7. The flat floor never rescaled with field size
(at very large fields it fell below the grid's 6-decimal viability floor), so the
per-capita form makes "a sub-1¢-per-member credit isn't worth another loop" hold
at any size.

### Version history

Each announced version's WASM is published as a release on this repo; check out
the matching tag and rebuild to reproduce that version's `algorithm_id`.

| version | `algorithm_id` | effective | change |
|---|---|---|---|
| genesis | `0x4b0575ef…ceb94633b` | 2026-06-08 | initial testnet anchor |
| `v3.7` | `0xc32dbb34…731824bb` | 2026-06-16 | unclaimed grid parts return to the forwarder |
| `v3.9` | `0x26512565…d8ef41e9` | 2026-06-23 | per-capita newcomer final-loop floor |

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

## Run it — in the browser

The easiest path is the hosted web calculator at
<https://verify.geniegenerate.com/calculator> (its source is `web/calculator/`
in this repository — audit it, or open it locally). Drop the input snapshot you
exported from the app; the page hashes the WASM, runs it on your device,
recomputes both Merkle roots, and compares them against the commitment it reads
directly from the RewardVerifier contract over public BSC JSON-RPC. Nothing is
sent to GenieGenerate.

## Run it — command line

The calculator is a pure stdin → stdout filter over any WASI runtime. Its input
is the published snapshot's data with the metadata stripped: the snapshot you
export from the app (or fetch from the public
`/rewards/distributions/{date}/input-snapshot` endpoint) carries extra
provenance fields (`challenge_date`, `algorithm_id`, `input_merkle_root`,
`pool`, `newcomer_loop_config`, per-participant `pseudonym` and `_usdt` name
suffixes) that the calculator deliberately rejects (`DisallowUnknownFields`).
Map it first:

```sh
jq '{participants: [.participants[] | {ordering_key, loyalty_score,
     completion_rank, lifetime_earnings: .lifetime_earnings_usdt,
     wallet_balance: .wallet_balance_usdt, max_capacity: .max_capacity_usdt}],
     loyalty_pool: .pool.loyalty_pool, newcomer_pool: .pool.newcomer_pool}' \
  input-snapshot.json > calc-input.json

wasmtime calculator.wasm < calc-input.json > result.json
```

`result.json` is the per-participant reward result. To complete the trustless
check, rebuild the result Merkle root from it (leaf encoding below) and confirm
it equals the `result_merkle_root` committed on-chain for that distribution —
`getCommitment(challengeDate)` on the RewardVerifier contract, where
`challengeDate` is the unix timestamp of 00:00 UTC on the distribution date.

### Merkle encoding (for independent reimplementation)

Both trees use OpenZeppelin **commutative (sorted-pair) keccak256** hashing,
leaves ordered by `ordering_key` ascending, odd nodes promoted unchanged. All
USDT amounts are exact integer **micro-units** (`amount × 10^6`; the 6-dp
precision model).

- input leaf — `keccak256(abi.encode(uint64 ordering_key, uint32 loyalty_score,
  uint64 completion_rank, uint256 lifetime_earnings, uint256 wallet_balance,
  uint256 max_capacity))`
- result leaf — `keccak256(abi.encode(uint64 ordering_key,
  uint256 loyalty_reward, uint256 newcomer_reward, uint256 credited_amount,
  uint256 excess_amount, bool was_over_cap))`

A reference implementation in plain JavaScript is `web/calculator/merkle.js`.

## What's here

```
cmd/reward-calculator/main.go        # WASI entrypoint: stdin → rewardcalc.ComputeJSON → stdout
internal/reward/rewardcalc/calc.go   # the reward math (grid + newcomer loops + 6-dp truncation)
internal/reward/rewardcalc/json.go   # snapshot ⇄ result (de)serialization
go.mod / go.sum                      # pinned toolchain + the single dependency (shopspring/decimal)
web/calculator/                      # the hosted web calculator (verify.geniegenerate.com)
  index.html / app.js                #   page + verification pipeline
  merkle.js                          #   input/result leaf encoding + sorted-pair tree
  wasi.js                            #   minimal WASI preview1 shim (stdin→stdout only)
  chain.js                           #   eth_call getCommitment over public BSC RPC
  sha3.js                            #   vendored js-sha3 0.9.3 (keccak256, MIT)
```

This is the complete build closure of the published WASM — nothing else is
compiled into the artifact. The full equivalence/determinism test suite that
proves this code stays bit-locked to the production money path lives in
GenieGenerate's backend; this repository carries exactly what's needed to
rebuild and verify the on-chain artifact.
