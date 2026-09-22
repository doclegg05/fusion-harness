#!/usr/bin/env bash
set -euo pipefail
trial_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trial_mode="${1:-shadow}"
if [[ $# -gt 0 ]]; then shift; fi
case "$trial_mode" in shadow|apply) ;; *) printf '%s\n' 'Usage: run.sh [shadow|apply] [existing Pi/harness arguments]'; exit 2 ;; esac
export FH_HEADROOM_PYTHON="$trial_dir/.venv/bin/python"
export FH_HEADROOM_TOKENIZER_CACHE="$trial_dir/runtime/tokenizer-cache"
export FH_HEADROOM_ARTIFACTS="$trial_dir/runtime/artifacts"
if [[ ! -x "$FH_HEADROOM_PYTHON" ]]; then
    printf '%s\n' 'Run experiments/headroom-lossless/setup.sh first.'
    exit 1
fi
exec pi -e "$trial_dir/../../extensions/fusion-harness/fusion-harness.ts" \
    -e "$trial_dir/extension.ts" --fh-headroom "$trial_mode" --fh-headroom-tools bash "$@"
