#!/usr/bin/env sh
set -eu

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

tracked_matches="$(
  git ls-files | rg "$generated_path_pattern" || true
)"

if [ -n "$tracked_matches" ]; then
  echo "Generated artifact paths are tracked:" >&2
  echo "$tracked_matches" >&2
  exit 1
fi

diff_matches="$(
  {
    git diff --name-only
    git diff --cached --name-only
  } | sort -u | rg "$generated_path_pattern" || true
)"

if [ -n "$diff_matches" ]; then
  echo "Generated artifact paths are present in the release diff:" >&2
  echo "$diff_matches" >&2
  exit 1
fi

echo "Generated artifact hygiene check passed."
