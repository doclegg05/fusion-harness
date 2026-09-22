"""One-shot, offline Headroom adapter. Never calls a model or runs a proxy."""
import json
import os
import socket
import sys

os.environ.update(HEADROOM_OFFLINE="1", HEADROOM_BEACON="off", DO_NOT_TRACK="1",
                  HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                  LITELLM_LOCAL_MODEL_COST_MAP="True")


def no_network(*args, **kwargs):
    raise RuntimeError("network disabled in compression worker")


socket.socket = no_network
socket.create_connection = no_network
PREFIX = "Lossless JSON table: map each row to the ordered schema names; all rows retained.\n"


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def compact(text):
    from importlib.metadata import version
    if version("headroom-ai") != "0.38.0":
        raise ValueError("requires tested Headroom 0.38.0")
    original = json.loads(text, object_pairs_hook=unique_object)
    if not isinstance(original, list) or not 20 <= len(original) <= 2000:
        return {"changed": False, "reason": "unsupported-shape"}
    keys = list(original[0]) if isinstance(original[0], dict) else []
    if not keys or any(not isinstance(row, dict) or set(row) != set(keys) for row in original):
        return {"changed": False, "reason": "nonuniform-rows"}
    for row in original:
        for value in row.values():
            if value is not None and type(value) not in (str, bool, int):
                return {"changed": False, "reason": "unsupported-value"}
            if type(value) is int and abs(value) > 2**53 - 1:
                return {"changed": False, "reason": "unsafe-integer"}
    from headroom._core import SmartCrusher, SmartCrusherConfig
    from tiktoken import get_encoding
    crusher = SmartCrusher.with_compaction_format(SmartCrusherConfig(
        lossless_only=True, enable_ccr_marker=False, dedup_identical_items=False,
        use_feedback_hints=False), "json")
    result = crusher.crush(text)
    table = json.loads(result.compressed)
    if isinstance(table, str):
        table = json.loads(table)
    if not isinstance(table, dict) or table.get("_compaction") != "table":
        return {"changed": False, "reason": "no-table"}
    names = [field["name"] for field in table["_schema"]]
    if len(set(names)) != len(names) or set(names) != set(keys):
        raise ValueError("schema changed")
    rows = table["_rows"]
    if table.get("_kept") != len(original) or table.get("_total") != len(original):
        raise ValueError("row count changed")
    if len(rows) != len(original) or any(len(row) != len(names) for row in rows):
        raise ValueError("invalid rows")
    decoded = [dict(zip(names, row, strict=True)) for row in rows]
    if canonical(decoded) != canonical(original):
        raise ValueError("round trip failed")
    content = PREFIX + canonical(table)
    tokenizer = get_encoding("o200k_base")
    before = len(tokenizer.encode(text, disallowed_special=()))
    after = len(tokenizer.encode(content, disallowed_special=()))
    if after >= before or before - after < 64 or after > before * 0.90:
        return {"changed": False, "reason": "insufficient-savings", "before": before, "after": after}
    return {"changed": True, "reason": "verified-table", "content": content,
            "before": before, "after": after, "rows": len(rows)}


if __name__ == "__main__":
    try:
        data = sys.stdin.buffer.read(300_001)
        if len(data) > 300_000:
            raise ValueError("request too large")
        request = json.loads(data)
        result = compact(request["text"])
    except Exception:
        result = {"changed": False, "reason": "worker-rejected"}
    print(json.dumps(result, ensure_ascii=False))
