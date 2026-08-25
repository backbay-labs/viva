#!/usr/bin/env sh
set -eu

# Legacy domain residue gate: proves the removed Chef Luca / cooking vocabulary
# is absent from the shipped agent and application surfaces. It is a vocabulary
# check only; it does not prove live behavior or domain purity.

command -v rg >/dev/null 2>&1 || { echo "rg is required" >&2; exit 1; }
command -v mktemp >/dev/null 2>&1 || { echo "mktemp is required" >&2; exit 1; }

search_roots="agent packages apps"

for search_root in ${search_roots}; do
  if [ ! -d "${search_root}" ]; then
    echo "legacy domain residue gate cannot traverse required search root: ${search_root}" >&2
    exit 1
  fi
done

residue_pattern="LUCA_|Chef Luca|luca_prompt|CookingSession|Voice Lab|safety_confirm|start_cook|recipe|ingredient|allergen|pantry|fridge|\\bcook(ing|ed|s)?\\b|KB_SNAPSHOT_PATH"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

rg_status=0
# shellcheck disable=SC2086
rg -n -i "${residue_pattern}" ${search_roots} \
  -g '!target' \
  >"${workdir}/matches" 2>"${workdir}/errors" || rg_status=$?

case "${rg_status}" in
  0)
    echo "Luca domain residue found in shipped agent/app surfaces:" >&2
    cat "${workdir}/matches" >&2
    exit 1
    ;;
  1) ;;
  *)
    echo "rg failed with exit status ${rg_status} while scanning for legacy domain residue:" >&2
    cat "${workdir}/errors" >&2
    exit "${rg_status}"
    ;;
esac

echo "Legacy domain residue check passed."
