#!/usr/bin/env sh
set -eu

# POSIX entrypoint for the agent-domain purity gate. The semantic boundary lives
# in scripts/check-agent-domain-purity.mjs; this wrapper only guarantees the
# runtime is present and that a failure is never swallowed.

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH='' cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

exec node scripts/check-agent-domain-purity.mjs
