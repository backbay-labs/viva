#!/usr/bin/env sh
set -eu

if [ ! -d agent ]; then
  echo "agent/ is missing" >&2
  exit 1
fi

matches="$(
  rg -n -i "LUCA_|Chef Luca|luca_prompt|CookingSession|Voice Lab|safety_confirm|start_cook|recipe|ingredient|allergen|pantry|fridge|\\bcook(ing|ed|s)?\\b|KB_SNAPSHOT_PATH" \
    agent packages apps \
    -g '!target' \
    -g '!docs/superpowers/plans/**' || true
)"

if [ -n "$matches" ]; then
  echo "Luca domain residue found in shipped agent/app surfaces:" >&2
  echo "$matches" >&2
  exit 1
fi
