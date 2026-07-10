#!/usr/bin/env bash
# cron-smoke.sh — one add → list → remove roundtrip against the real scheduler this OS provides
# (or Modal, via extra flags). Driven by cron-smoke.yml; runs locally too — schedulers are keyed
# by id, and remove restores the state add created.
#
# usage: cron-smoke.sh <path/to/cli/index.ts> [extra `loop cron` flags, e.g. --backend modal]
set -euo pipefail

cli="${1:?usage: cron-smoke.sh <path/to/cli/index.ts> [extra flags...]}"
shift
# Absolute before cd — callers pass a repo-relative path, and Windows' $GITHUB_WORKSPACE
# spelling never enters the script.
cli="$(cd "$(dirname "$cli")" && pwd)/$(basename "$cli")"

work="$(mktemp -d)"
cd "$work"

added="$(bun "$cli" cron add "0 8 * * *" --until settled "$@")"
echo "$added"
# `added <id>  <expr>  <dir>  <lifetime>` — the id is word 2.
id="$(echo "$added" | awk '{print $2}')"
test -n "$id"

bun "$cli" cron list "$@" | tee list.out
grep -F "$id" list.out >/dev/null

bun "$cli" cron remove "$id" "$@"

if bun "$cli" cron list "$@" | grep -F "$id"; then
  echo "cron-smoke: entry $id still listed after remove" >&2
  exit 1
fi
echo "cron-smoke: roundtrip ok ($id)"
