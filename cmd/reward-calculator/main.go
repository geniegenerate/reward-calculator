//go:build wasip1

// Command reward-calculator is the published, open-source reward verifier.
//
// It is a trivial shell around rewardcalc.ComputeJSON: read the committed input
// snapshot JSON from stdin, write the result JSON to stdout. keccak256 of the
// compiled WASM binary is the on-chain algorithm_id, so this exact code is what
// a third party runs to independently reproduce a distribution.
//
// Build (wasip1, runnable via wasmtime/wasmer or any WASI runtime):
//
//	GOOS=wasip1 GOARCH=wasm go build -o reward-calculator.wasm ./cmd/reward-calculator
//	wasmtime reward-calculator.wasm < input-snapshot.json > result.json
//
// The browser (js/wasm) web calculator uses a separate syscall/js wrapper around
// the same rewardcalc package — out of scope for this entrypoint.
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/geniegenerate/backend/internal/reward/rewardcalc"
)

func main() {
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read stdin:", err)
		os.Exit(1)
	}
	output, err := rewardcalc.ComputeJSON(input)
	if err != nil {
		fmt.Fprintln(os.Stderr, "compute:", err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(output); err != nil {
		fmt.Fprintln(os.Stderr, "write stdout:", err)
		os.Exit(1)
	}
}
