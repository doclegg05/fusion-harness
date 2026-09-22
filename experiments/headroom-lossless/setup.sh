#!/usr/bin/env bash
set -euo pipefail
trial_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v uv >/dev/null
if [[ ! -x "$trial_dir/.venv/bin/python" ]]; then
    uv venv --python 3.13 "$trial_dir/.venv"
fi
uv pip install --python "$trial_dir/.venv/bin/python" --only-binary :all: -r "$trial_dir/requirements.txt"
mkdir -p "$trial_dir/runtime/tokenizer-cache"
# Public tokenizer asset only. Runtime compression itself is offline.
TIKTOKEN_CACHE_DIR="$trial_dir/runtime/tokenizer-cache" "$trial_dir/.venv/bin/python" -c 'import tiktoken; tiktoken.get_encoding("o200k_base")'
printf '%s\n' 'Ready. Follow README.md to run the offline replay or opt-in Pi extension.'
