package rewardcalc_test

// AlgoV6 golden vectors (REWARD_SYSTEM v3.67/v3.68), held exactly as the V5 ones are. testdata/v6 holds each input and the exact
// bytes ComputeJSON must return, plus SHA256SUMS over every file. The same directory and
// this same test live in the public reward-calculator repository, so the backend's money
// path and the published calculator are held to one set of answers: a changed byte in
// either repo fails here, and the manifests must match between the two.
//
// Regenerate (a new algorithm version only): go test -run TestGoldenV6 -update ./internal/reward/rewardcalc/

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/geniegenerate/backend/internal/reward/rewardcalc"
)

const goldenDirV6 = "testdata/v6"

func TestGoldenV6(t *testing.T) {
	inputs, err := filepath.Glob(filepath.Join(goldenDirV6, "*.input.json"))
	if err != nil || len(inputs) == 0 {
		t.Fatalf("no golden inputs in %s: %v", goldenDirV6, err)
	}
	sort.Strings(inputs)
	for _, in := range inputs {
		name := strings.TrimSuffix(filepath.Base(in), ".input.json")
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(in)
			if err != nil {
				t.Fatal(err)
			}
			got, err := rewardcalc.ComputeJSON(raw)
			if err != nil {
				t.Fatalf("ComputeJSON: %v", err)
			}
			got = append(got, '\n')
			out := filepath.Join(goldenDirV6, name+".output.json")
			if *updateGolden {
				if err := os.WriteFile(out, got, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(out)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != string(want) {
				t.Fatalf("output differs from the golden vector\n got: %s\nwant: %s", got, want)
			}
		})
	}
	manifest := goldenManifestV6(t)
	path := filepath.Join(goldenDirV6, "SHA256SUMS")
	if *updateGolden {
		if err := os.WriteFile(path, []byte(manifest), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if manifest != string(want) {
		t.Fatalf("SHA256SUMS does not match the vectors:\n%s", manifest)
	}
}

// goldenManifestV6 is `sha256sum` output over every vector, in name order.
func goldenManifestV6(t *testing.T) string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(goldenDirV6, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	var b strings.Builder
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&b, "%x  %s\n", sha256.Sum256(raw), filepath.Base(f))
	}
	return b.String()
}
