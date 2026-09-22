# Shared compact workspace tools

One read-only `compact_workspace` tool, with the same core used by CLI, Pi and MCP clients such as Codex. Large outputs are reduced **before** they enter the model context. There are no model calls, provider changes, proxy interception, or background network listeners. MCP uses local stdio.

Prefer this tool for large source reads, broad searches, saved logs, and JSON data. Use native tools when their output is already concise: snapshot metadata can cost more tokens than a small result. Existing native tools remain available. Installing the adapter does not intercept their output.

## Operations

| Operation | Input | Returned evidence |
|---|---|---|
| `search` | `query`, optional `path` and `limit` | Literal ripgrep matches, captured/omitted counts, completeness, retrievable match records |
| `read` | `path`, optional `startLine` and `limit` | Numbered excerpt, source hash, omission status, original snapshot |
| `log` | `path` to an existing log | Failure-like lines and adjacent context, ending lines, omission status; never a pass/fail verdict |
| `json` | `path` | Existing Headroom verified lossless table, original JSON, or snapshot-only when too large |
| `json` count | `path`, `field`, scalar `value` | Exact count using parsed JSON own-field equality, total rows, original snapshot |
| `retrieve` | `artifact`, optional `offset` | Exact text page, `nextOffset`, and source-changed indicator where available |

All paths are relative to the configured workspace. `budget` defaults to approximately 6,000 characters and supports 2,000–16,000. JSON encoding and metadata add overhead; this is not a token limit. Read/search `limit` defaults to 40 and is capped at 200. Long lines can be clipped with an explicit marker; retrieve the source snapshot for full text.

Source reads are capped at 2 MiB, require UTF-8 text and reject binary content. Search is capped at 10 seconds and 2 MiB of captured output. It skips hidden, ignored, binary and >2 MiB files and does not follow directory symlinks. `complete` means the search finished within that declared scope, not that every file on disk was searched. Search snapshots retain all captured match records, excluding ripgrep timing events; they are not a coherent snapshot of the entire repository. Repeat a search after source edits.

The log operation analyzes saved text, not a running process. A log can omit errors or show stale results; verify the runner's actual exit status separately. Highlights are intentionally lossy and always accompanied by the original. The tool runs no test command and has no shell-execution operation.

Headroom is used only for `json`, through the already-tested adapter in `../headroom-lossless`. Its eligibility and independent reconstruction checks still apply. Missing Python dependencies or unsupported data retain the original; if that exceeds the response budget, the tool returns an explicit snapshot-only result. It never returns a chopped JSON table as complete. Do not add this tool to another compressor's allowlist.

## Setup

From the Fusion Harness repository root:

```sh
npm ci --ignore-scripts --prefix experiments/compact-tools
bash experiments/headroom-lossless/setup.sh
```

Node/Bun, ripgrep, and the existing Headroom Python environment are required for full functionality. Plain reads, searches, logs and JSON counts work without Headroom. Set `COMPACT_RG` to an absolute ripgrep executable if a desktop client's PATH does not include it. Existing `FH_HEADROOM_PYTHON` and `FH_HEADROOM_TOKENIZER_CACHE` overrides are honored. The default Python path handles Windows virtualenv layout, but Windows execution has not been tested.

### Pi

Install the local package for this project:

```sh
pi install -l ./experiments/compact-tools
```

Start Pi with the project trusted, or use `/reload` in a running trusted Pi session. For this installed Pi version, `pi --approve` explicitly enables project resources for that invocation; `pi list --approve` verifies the package. Untrusted project sessions ignore project-local packages. The package adds the tool to the current project's Main session; clean-room Fusion children still use `--no-extensions`. It does not alter the model stack or authoritative fusion/ACK content.

Remove with `pi remove -l ./experiments/compact-tools`.

### Codex and other MCP clients

For Codex, run the following from the repository root. It registers a server whose workspace is fixed to this repository, even when Codex is working elsewhere:

```sh
codex mcp add fusion_compact --env COMPACT_RG="$(command -v rg)" -- \
  "$(command -v bun)" "$PWD/experiments/compact-tools/mcp.ts" "$PWD"
```

The configured root appears in the tool description. Choose a different root deliberately when setting up another workspace. Do not assume this registration serves every project. MCP configuration is machine-local; repeat setup on the Windows machine using its executable and repository paths.

Refresh the MCP server in the Codex client or start a new session to discover the new tool. Registration does not change the available tool inventory of an already-running conversation. Other stdio MCP clients can launch the same executable with `mcp.ts` and the workspace root as arguments. Remove the Codex registration with `codex mcp remove fusion_compact`.

### Direct CLI (available immediately)

```sh
printf '%s\n' '{"operation":"search","path":"extensions/fusion-harness","query":"ACK FUSION"}' \
  | bun experiments/compact-tools/cli.ts "$PWD"
```

Requests arrive as JSON on stdin, which avoids embedding content in shell commands. CLI errors return nonzero; MCP errors use `isError`; Pi errors are surfaced as tool errors.

## Snapshots and measurements

Snapshots and metadata-only `metrics.jsonl` live under ignored `runtime/<workspace-hash>/`. Original contents are stored as private files (0600 inside 0700 directories), without application-level encryption. They persist across clients/restarts until manually removed; there is no automatic expiration. Stop clients before clearing this runtime directory. Missing/corrupted artifacts return an error, never a fabricated original.

Snapshot identifiers are content-addressed and partitioned by canonical workspace path. Retrieval reports when a source has changed or disappeared and still returns the saved version. Paths outside the configured root and symlink escapes are rejected. This is a local single-user tool, not an OS sandbox or a multi-user service. Returned repository content remains untrusted data.

Metrics record bytes and elapsed time, not provider tokens or billing. They include retrieval calls so repeated fetching is visible. No payloads are copied into the metrics log; snapshots themselves contain the original text. Never interpret summed source bytes as billable savings.

## Verification

```sh
bun test experiments/compact-tools/core.test.ts
PI_EXTENSION_LOADER=/absolute/path/to/pi-coding-agent/dist/core/extensions/loader.js \
  bun experiments/compact-tools/verify-adapters.ts
```

The adapter check loads the extension using the installed Pi loader, starts the real MCP stdio server/client, invokes the CLI, and compares identical requests. It checks source isolation flags, ACK references, actual harness test output, and two synthetic JSON tasks. It also retrieves originals through MCP. Its test artifacts remain in ignored runtime storage.

This proves transport and task-evidence parity, not live model behavior or subscription savings. The baseline uses full source/log/JSON and normal `rg -n` output; an optimized native line read can be just as small or smaller. The tiny search example intentionally exposes metadata overhead. Count complete model turns, retrievals and retries before making end-to-end savings claims.
