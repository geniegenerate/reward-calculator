package rewardcalc

import (
	"bytes"
	"encoding/json"
)

// ComputeJSON is the canonical byte-in / byte-out entrypoint: it decodes a
// committed input snapshot, runs Compute, and encodes the result. The WASM
// binary is a trivial stdin→ComputeJSON→stdout shell around this function, so
// the exact same code path is exercised by native Go tests and by the published
// calculator. Decoding uses DisallowUnknownFields so a snapshot carrying fields
// the algorithm does not understand is rejected rather than silently ignored.
func ComputeJSON(inputJSON []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(inputJSON))
	dec.DisallowUnknownFields()

	var in Input
	if err := dec.Decode(&in); err != nil {
		return nil, err
	}

	out := Compute(in)
	return json.Marshal(out)
}
