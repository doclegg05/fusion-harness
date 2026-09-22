"""Paired synthetic-data task check against an already-installed local Ollama model.

Usage: python evaluate_local.py REPLAY_DIRECTORY OUTPUT_JSON
Requires FH_HEADROOM_PYTHON and FH_HEADROOM_TOKENIZER_CACHE for the worker.
Never downloads a model, reads provider credentials, or contacts a cloud endpoint.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

MODEL = "qwen3.5:latest"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(messages):
    payload = {"model": MODEL, "messages": messages, "stream": False, "format": "json",
               "think": False, "keep_alive": "5m",
               "options": {"temperature": 0, "seed": 1, "num_ctx": 8192, "num_predict": 256}}
    request = urllib.request.Request("http://127.0.0.1:11434/api/chat",
                                     data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
    with opener.open(request, timeout=60) as response:
        return json.load(response)


def main():
    folder, output = map(Path, sys.argv[1:3])
    sources = [(p, json.loads(p.read_text())) for p in folder.glob("*.original.json")]
    sources.sort(key=lambda pair: int(pair[1][0]["filePath"].split("area-")[1].split("/")[0]))
    if len(sources) != 20:
        raise ValueError("expected exactly 20 synthetic replay fixtures")
    for n, (_, rows) in enumerate(sources):
        if rows[0]["filePath"] != f"src/area-{n}/component-0.ts":
            raise ValueError("not the expected synthetic corpus")
    results = []
    if "--resume" in sys.argv[3:]:
        previous = json.loads(output.read_text())
        if previous.get("model") != MODEL:
            raise ValueError("resume model mismatch")
        results = previous["pairs"]
        if [pair["case"] for pair in results] != list(range(1, len(results) + 1)):
            raise ValueError("resume cases must be contiguous")
    started = time.monotonic()
    call([{"role": "user", "content": 'Return {"ready":true}'}])  # exclude model loading from paired timings
    worker = Path(__file__).with_name("worker.py")
    for n, (source, rows) in enumerate(sources):
        if n < len(results):
            continue
        if time.monotonic() - started > 600:
            break
        raw = source.read_text()
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(folder),
               "TIKTOKEN_CACHE_DIR": os.environ["FH_HEADROOM_TOKENIZER_CACHE"]}
        compact = json.loads(subprocess.run([os.environ["FH_HEADROOM_PYTHON"], str(worker)],
                    input=json.dumps({"text": raw}), text=True, capture_output=True,
                    env=env, timeout=5, check=True).stdout)
        if not compact.get("changed"):
            raise ValueError("expected verified compression")
        target = rows[(n * 11 + 17) % len(rows)]
        kind = n % 4
        if kind == 0:
            question = f'For symbolName {target["symbolName"]}, return filePath, lineNumber and annotation.'
            expected = {k: target[k] for k in ("filePath", "lineNumber", "annotation")}
        elif kind == 1:
            question = 'Return rowCount, firstSymbol and lastSymbol. Preserve input order.'
            expected = {"rowCount": len(rows), "firstSymbol": rows[0]["symbolName"], "lastSymbol": rows[-1]["symbolName"]}
        elif kind == 2:
            question = 'Return visibleCount (visible=true) and nullCount (annotation=null). Count every row.'
            expected = {"visibleCount": sum(row["visible"] for row in rows), "nullCount": sum(row["annotation"] is None for row in rows)}
        else:
            question = f'For symbolName {target["symbolName"]}, return visible and category.'
            expected = {k: target[k] for k in ("visible", "category")}
        pair = {"case": n + 1, "question": question, "expected": expected}
        # Alternate order so the same mode does not always receive a warm prefix.
        modes = [("baseline", raw), ("compressed", compact["content"])]
        if n % 2:
            modes.reverse()
        for label, content in modes:
            tick = time.monotonic()
            reply = call([{"role": "system", "content": "Answer the question from the supplied data. Return only a JSON object with the requested keys. No commentary."},
                          {"role": "user", "content": question + "\nDATA:\n" + content}])
            answer = reply.get("message", {}).get("content", "")
            try:
                parsed = json.loads(answer)
            except ValueError:
                parsed = None
            pair[label] = {"correct": parsed == expected, "answer": parsed,
                "elapsedSeconds": round(time.monotonic() - tick, 3),
                "promptTokens": reply.get("prompt_eval_count"), "outputTokens": reply.get("eval_count"),
                "promptEvalNanoseconds": reply.get("prompt_eval_duration")}
        results.append(pair)
        report = {"model": MODEL, "kind": "local synthetic data tasks; not full coding tasks or a cloud billing benchmark",
                  "completedPairs": len(results), "baselineCorrect": sum(p["baseline"]["correct"] for p in results),
                  "compressedCorrect": sum(p["compressed"]["correct"] for p in results), "pairs": results}
        output.write_text(json.dumps(report, indent=2) + "\n")
        print(f'pair {n+1}/20: baseline={pair["baseline"]["correct"]}, compressed={pair["compressed"]["correct"]}', flush=True)
    # Release only the model this evaluation loaded; no changes to installed models.
    request = urllib.request.Request("http://127.0.0.1:11434/api/generate", data=json.dumps({"model": MODEL, "keep_alive": 0}).encode(), headers={"Content-Type": "application/json"})
    opener.open(request, timeout=10).close()


if __name__ == "__main__":
    main()
