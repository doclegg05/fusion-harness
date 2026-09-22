# Headroom lossless trial

An opt-in experiment for the Fusion Harness Main role. It uses Headroom 0.38.0's local Rust compressor to compact successful JSON tool results. No HTTP proxy, provider credentials, subscription import, ML models, telemetry, long-term memory or instruction-file changes are involved.

The experiment is **off unless explicitly loaded and enabled**. Clean-room children keep their existing behavior. System/user messages, old conversation messages, fused results and ACK turns are not intercepted. Model selection and thinking levels are unchanged.

## Boundaries

- Explicit tool allowlist, successful results only, exactly one text block.
- Outputs must be 4–128 KiB JSON arrays of 20–2,000 objects with identical keys. Supported values are strings, booleans, null and safe integers.
- Read/edit/write/apply_patch tools, failed checks, failure/policy/instruction text, mixed media, nested values, decimals, duplicate keys and unsafe integers pass through unchanged.
- Headroom must emit a complete JSON table. Python reconstructs and compares every row/value, then TypeScript independently verifies it before applying. Order is preserved. JSON formatting changes; the original bytes are archived privately.
- Minimum savings are 64 tokens and 10%, including the format explanation. Counts use `o200k_base` as an estimate, not provider billing.
- Missing dependencies, timeouts, invalid responses, mismatched data or failed artifact writes return the original result. Worker budget: two seconds.
- Each result is handled once at the tool-result boundary. There is no rewrite of an older cached prefix.
- Only synthetic/public data is appropriate for the initial trial. Original artifacts are retained until you delete the selected runtime directory; there is no automatic retention cleanup.

## Setup

From the repository root, with `uv`, Python 3.13 support and Bun available:

```sh
bash experiments/headroom-lossless/setup.sh
export FH_HEADROOM_PYTHON="$PWD/experiments/headroom-lossless/.venv/bin/python"
export FH_HEADROOM_TOKENIZER_CACHE="$PWD/experiments/headroom-lossless/runtime/tokenizer-cache"
export FH_HEADROOM_ARTIFACTS="$PWD/experiments/headroom-lossless/runtime/artifacts"
```

Setup downloads dependencies and a public tokenizer file, without launching a model or altering client settings. It is not required when pointing the environment variables at the already-prepared assessment environment on this Mac. `.venv` and `runtime` are ignored by Git. The native wheel must support the machine; this trial does not build Rust from source.

## Verify and replay

```sh
bun test experiments/headroom-lossless/trial.test.ts
bun experiments/headroom-lossless/evaluate.ts
```

The three real-worker tests require the environment variables above; otherwise they are explicitly skipped. The replay runs 20 synthetic outputs through the actual adapter, validates complete reconstruction and input immutability, and writes `results.json` plus per-call metadata into the printed artifact directory. It calls no LLM.

Optional paired model check, using the existing local `qwen3.5:latest` in Ollama:

```sh
python3 experiments/headroom-lossless/evaluate_local.py \
  /absolute/path/to/evaluation-directory \
  /absolute/path/to/local-model-results.json
```

This runs 20 paired synthetic data questions with baseline and compacted context, alternating order. It neither downloads models nor contacts cloud endpoints. It records exact-answer accuracy, local prompt/output token counts and timings. These are data-reading tasks, not a coding benchmark. It temporarily loads the selected local model and releases it afterward. Keep the model idle during evaluation.

## Opt-in Main session

Start with shadow mode on a public/synthetic workspace:

```sh
bash experiments/headroom-lossless/run.sh shadow \
   --fh-config .pi/fusion-harness/model-stack-fusion.yaml
```

Use your existing stack path if it differs. The launcher sets the three environment paths for this process and explicitly loads both extensions. This command starts your normal harness and can use its configured paid providers; the offline replay above does not. Shadow mode measures eligible results but forwards originals. Change `shadow` to `apply` for a deliberate session using verified compacted results. The `bash` allowlist only admits the constrained successful JSON shape; ordinary logs and plain text pass through.

`/fh-headroom-status` shows counts and token estimates. Use your normal launch command to stop using the trial; no settings need restoration. Avoid enabling another compressor in the same route while evaluating this one.

## Files

- `extension.ts`: Pi entry point and explicit flags.
- `trial.ts`: eligibility, isolated worker, independent validation, original artifacts and metrics.
- `worker.py`: offline pinned Headroom call and JSON round-trip check.
- `trial.test.ts`: exclusion, reconstruction, failure and real-worker edge cases.
- `evaluate.ts`: paired synthetic replay.
- `evaluate_local.py`: local model comprehension check.

The trial imports Headroom as a dependency; it does not vendor Headroom source. See the dependency's Apache-2.0 license and notices if redistributing it.
