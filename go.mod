module github.com/geniegenerate/backend

go 1.25.0

// Pinned so the reward-calculator WASM (keccak256 = on-chain algorithm_id) is
// reproducible byte-for-byte across machines. Changing this can change the WASM
// bytes → a new algorithm_id; treat a toolchain bump like an algorithm change.
toolchain go1.25.11

require github.com/shopspring/decimal v1.4.0
