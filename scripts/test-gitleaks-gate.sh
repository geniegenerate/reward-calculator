#!/usr/bin/env bash
# Tests for scripts/lib/gitleaks_gate.sh — the local secret-in-git gate that
# runs in this repo's pre-commit (staged) and pre-push (pushed range) hooks.
#
#   ./scripts/test-gitleaks-gate.sh
#
# Why this gate exists: the private repos are on GitHub Free, where secret
# scanning and push protection are not available, and the monthly security.yml
# scans dependencies, not commits. Until now nothing anywhere looked at commit
# CONTENT for a pasted token. A full-history gitleaks run on 2026-09-05 found
# only fixtures and placeholders — this gate keeps it that way at zero Actions
# minutes.
#
# The assertions encode the ways a hook like this silently stops working:
#   (a) it must be ABLE to fail — a fresh commit carrying a credential-shaped
#       string goes red, a clean commit passes;
#   (b) the repo's own .gitleaks.toml is what the gate reads — a fixture path
#       the allowlist names passes with the very same string;
#   (c) staged mode (pre-commit) sees the index, not HEAD;
#   (d) push mode reads the hook's stdin: an existing remote ref scans only
#       remote..local; a NEW branch (all-zero remote sha) scans the commits no
#       remote has; a ref delete (all-zero local sha) is a no-op;
#   (e) the output never prints the secret it found (redaction is on);
#   (f) a missing gitleaks binary FAILS CLOSED — a scanner that is not
#       installed must not read as "no secrets" (landmine: phantom control).

set -uo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
GATE="$REPO_ROOT/scripts/lib/gitleaks_gate.sh"
CONFIG="$REPO_ROOT/.gitleaks.toml"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "✅ $1"; }
bad() {
  fail=$((fail + 1))
  echo "❌ $1"
  [ $# -gt 1 ] && printf '     %s\n' "${@:2}"
  return 0
}

[ -x "$GATE" ] || { bad "gate script missing or not executable: $GATE"; echo; echo "$pass passed, $fail failed"; exit 1; }
[ -f "$CONFIG" ] || { bad "repo config missing: $CONFIG"; echo; echo "$pass passed, $fail failed"; exit 1; }
command -v gitleaks >/dev/null 2>&1 || { bad "gitleaks not on PATH (brew install gitleaks)"; echo; echo "$pass passed, $fail failed"; exit 1; }

# A credential-shaped string gitleaks' default aws-access-token rule matches
# (AKIA + 16 of [A-Z2-7]). Random so no stopword allowlist can swallow it.
fake_secret() { printf 'AKIA%s' "$(LC_ALL=C tr -dc 'A-Z2-7' </dev/urandom | head -c 16)"; }
ZERO="0000000000000000000000000000000000000000"

# ── fixture repo: a bare origin + a clone with one pushed clean commit ────────
git init -q --bare "$tmp/origin.git"
git init -q "$tmp/work"
cd "$tmp/work"
git config user.email t@t; git config user.name t; git config commit.gpgsign false
git remote add origin "$tmp/origin.git"
cp "$CONFIG" .gitleaks.toml
echo "hello" > README.md
git add -A && git commit -qm "clean" && git push -q -u origin HEAD
BASE="$(git rev-parse HEAD)"

# $1 = label, $2 = expected exit, then the command
expect_exit() {
  local label="$1" want="$2"; shift 2
  local out got
  out="$("$@" 2>&1)"; got=$?
  if [ "$got" -eq "$want" ]; then ok "$label (exit $got)"; else bad "$label — expected exit $want, got $got" "$out"; fi
  LAST_OUT="$out"
}

echo "── (a) able to fail ──"
expect_exit "clean range passes" 0 "$GATE" range "$BASE" HEAD
S1="$(fake_secret)"
mkdir -p internal && printf 'aws_key = "%s"\n' "$S1" > internal/config.go
git add -A && git commit -qm "leak"
LEAK="$(git rev-parse HEAD)"
expect_exit "range with a leaked credential fails" 1 "$GATE" range "$BASE" HEAD

echo "── (e) redaction ──"
if printf '%s' "$LAST_OUT" | grep -q "$S1"; then bad "the secret itself was printed"; else ok "secret redacted in output"; fi

echo "── (b) repo allowlist ──"
mkdir -p internal
printf 'token = "%s"\n' "$S1" > internal/probe_test.go
git add -A && git commit -qm "fixture"
expect_exit "same string under an allowlisted test path passes" 0 "$GATE" range "$LEAK" HEAD

echo "── (c) staged mode ──"
S2="$(fake_secret)"
printf 'k = "%s"\n' "$S2" > internal/other.go
git add internal/other.go
expect_exit "staged secret fails" 1 "$GATE" staged
git reset -q internal/other.go && rm internal/other.go
echo "fine" > internal/fine.go && git add internal/fine.go
expect_exit "staged clean passes" 0 "$GATE" staged
git reset -q internal/fine.go && rm internal/fine.go

echo "── (d) push mode via stdin ──"
# existing remote ref: origin has BASE, local has BASE..HEAD (leak + fixture)
line="refs/heads/main $(git rev-parse HEAD) refs/heads/main $BASE"
expect_exit "push to existing ref scans remote..local and fails" 1 bash -c "printf '%s\n' '$line' | '$GATE' push"
# leak commit already on the remote → only the fixture commit is new → passes
git push -q origin "$LEAK:refs/heads/main" 2>/dev/null
line="refs/heads/main $(git rev-parse HEAD) refs/heads/main $LEAK"
expect_exit "push scans ONLY the new commits (leak already remote)" 0 bash -c "printf '%s\n' '$line' | '$GATE' push"
# new branch: all-zero remote sha → scan commits no remote has
git checkout -q -b feature
S3="$(fake_secret)"
printf 'x = "%s"\n' "$S3" > internal/feat.go && git add -A && git commit -qm "feat leak"
line="refs/heads/feature $(git rev-parse HEAD) refs/heads/feature $ZERO"
expect_exit "push of a NEW branch scans its unpushed commits and fails" 1 bash -c "printf '%s\n' '$line' | '$GATE' push"
# ref delete: all-zero local sha → nothing to scan
line="(delete) $ZERO refs/heads/feature $(git rev-parse HEAD)"
expect_exit "ref delete is a no-op" 0 bash -c "printf '%s\n' '$line' | '$GATE' push"
expect_exit "empty stdin (nothing to push) is a no-op" 0 bash -c "printf '' | '$GATE' push"

echo "── (f) missing binary fails closed ──"
expect_exit "no gitleaks on PATH → exit 1 with install hint" 1 env PATH=/usr/bin:/bin "$GATE" range "$BASE" HEAD
if printf '%s' "$LAST_OUT" | grep -qi "brew install gitleaks"; then ok "install hint printed"; else bad "no install hint in output" "$LAST_OUT"; fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
