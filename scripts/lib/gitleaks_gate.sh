#!/usr/bin/env bash
# Local secret-in-git gate — wraps gitleaks for the shared git hooks.
#
#   scripts/lib/gitleaks_gate.sh staged             # pre-commit: the index
#   scripts/lib/gitleaks_gate.sh push  < hook stdin # pre-push: only the commits being pushed
#   scripts/lib/gitleaks_gate.sh range <old> <new>  # ad hoc
#
# Why: the private repos sit on GitHub Free, where secret scanning and push
# protection are unavailable, and security.yml scans dependencies, not commits.
# This closes that gap at zero Actions minutes. Self-test:
# scripts/test-gitleaks-gate.sh.
#
# Fails CLOSED when gitleaks is not installed. A scanner that is missing must not
# read as "no secrets found" — that is a phantom control, and it was exactly how
# the admin CVE scan reported clean for a month while never installing.
# Escape hatches: `git push --no-verify` for a known-safe push; an inline
# `gitleaks:allow` comment for a real false positive.

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "gitleaks-gate: not inside a git repository"; exit 1; }
cd "$repo_root" || exit 1

if ! command -v gitleaks >/dev/null 2>&1; then
    echo "gitleaks-gate: gitleaks is not on PATH — refusing to pass silently."
    echo "  install: brew install gitleaks   (override once: git push --no-verify)"
    exit 1
fi

config_args=()
[ -f .gitleaks.toml ] && config_args=(--config .gitleaks.toml)
# ${x[@]+"${x[@]}"} — not plain "${config_args[@]}": macOS ships bash 3.2, where an
# EMPTY array expanded under `set -u` is an "unbound variable" error. A repo with no
# .gitleaks.toml (the config is optional by design) would then have a gate that never
# scans and refuses every commit — a control that is broken, not strict.
common=(--no-banner --redact --exit-code 1 ${config_args[@]+"${config_args[@]}"})

fail_hint() {
    echo "gitleaks-gate: credential-shaped content in what you are about to $1."
    echo "  Move it to Vault / .env (gitignored); if it is a real false positive add"
    echo "  '// gitleaks:allow' on that line. Override a known-safe push: git push --no-verify."
}

scan_range() {
    gitleaks git "${common[@]}" --log-opts="$1" . || { fail_hint "push"; return 1; }
}

case "${1:-}" in
    staged)
        gitleaks git "${common[@]}" --pre-commit --staged . || { fail_hint "commit"; exit 1; }
        ;;
    range)
        [ $# -eq 3 ] || { echo "usage: $0 range <old> <new>"; exit 2; }
        scan_range "$2..$3" || exit 1
        ;;
    push)
        zero="0000000000000000000000000000000000000000"
        status=0
        while read -r _local_ref local_sha _remote_ref remote_sha; do
            [ -z "${local_sha:-}" ] && continue
            [ "$local_sha" = "$zero" ] && continue          # ref delete — nothing to scan
            if [ "$remote_sha" = "$zero" ]; then
                # New branch on the remote: scan every commit no remote has yet.
                scan_range "$local_sha --not --remotes" || status=1
            else
                scan_range "$remote_sha..$local_sha" || status=1
            fi
        done
        exit $status
        ;;
    *)
        echo "usage: $0 staged | push | range <old> <new>"; exit 2
        ;;
esac
