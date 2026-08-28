#!/usr/bin/env sh
set -eu

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }
command -v rg >/dev/null 2>&1 || { echo "rg is required" >&2; exit 1; }

required_ignored_paths="
.next
.turbo
node_modules
coverage
out
artifacts
apps/web/.next
apps/web/.turbo
apps/web/node_modules
apps/web/out
packages/core/.turbo
packages/core/node_modules
packages/tokens/.turbo
packages/tokens/node_modules
packages/ui-web/.turbo
packages/ui-web/node_modules
agent/target
"

missing=""
for path in $required_ignored_paths; do
  if ! git check-ignore -q -- "$path"; then
    missing="${missing}
$path"
  fi
done

if [ -n "$missing" ]; then
  echo "Generated artifact paths are not ignored:" >&2
  echo "$missing" >&2
  exit 1
fi

generated_path_pattern='(^|/)(node_modules|\.next|\.turbo|coverage|target|out|artifacts)(/|$)|(^|/)dist(/|$)|\.tsbuildinfo$'

# `rg` is run against a file, never the receiving end of a pipe, so its own
# exit status is observable directly: status 1 ("no lines selected") is the
# only acceptable no-match outcome; any other nonzero status (a real rg
# error, or -- were it ever missing mid-run -- 127) propagates as a hard
# failure instead of being coerced into an empty, passing match set. Each
# upstream `git` command writes to its own temp file as a plain top-level
# statement (never inside a pipeline whose exit status `set -e` cannot see),
# so a `git` failure aborts the script immediately via `set -e` rather than
# silently starving `rg` of input.
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

git ls-files >"$workdir/tracked-files"

tracked_rg_status=0
rg "$generated_path_pattern" "$workdir/tracked-files" >"$workdir/tracked-matches" || tracked_rg_status=$?
case "$tracked_rg_status" in
  0 | 1) ;;
  *) exit "$tracked_rg_status" ;;
esac

if [ -s "$workdir/tracked-matches" ]; then
  echo "Generated artifact paths are tracked:" >&2
  cat "$workdir/tracked-matches" >&2
  exit 1
fi

git diff --name-only >"$workdir/diff-unstaged"
git diff --cached --name-only >"$workdir/diff-staged"
sort -u "$workdir/diff-unstaged" "$workdir/diff-staged" >"$workdir/diff-files"

diff_rg_status=0
rg "$generated_path_pattern" "$workdir/diff-files" >"$workdir/diff-matches" || diff_rg_status=$?
case "$diff_rg_status" in
  0 | 1) ;;
  *) exit "$diff_rg_status" ;;
esac

if [ -s "$workdir/diff-matches" ]; then
  echo "Generated artifact paths are present in the release diff:" >&2
  cat "$workdir/diff-matches" >&2
  exit 1
fi

echo "Generated artifact hygiene check passed."
