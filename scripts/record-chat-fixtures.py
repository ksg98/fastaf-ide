#!/usr/bin/env python3
"""Record Claude JSONL shapes without copying private payloads into the repository.

Run with --output src-tauri/src/fixtures/chat_view/recorded. Sources are read-only.
Only schema discriminants are retained. All other strings become length-matched
placeholders, IDs become fresh UUIDs, and dynamic path keys are anonymized.
"""

import argparse
import collections
import datetime
import json
import pathlib
import re
import uuid


MARKERS = (
    "<command-name>", "<command-message>", "<local-command-stdout>",
    "<local-command-caveat>", "<bash-input>", "<bash-stdout>",
    "<task-notification>", "<system-reminder>",
)
TOOLS = {"Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep",
         "Glob", "WebFetch", "WebSearch", "Agent", "Task"}
ENUMS = {"type", "role", "kind", "stop_reason", "media_type"}
ID_KEYS = {"id", "uuid", "parentUuid", "sessionId", "messageId", "tool_use_id",
           "sourceToolAssistantUUID", "agentId", "parentAgentId", "leafUuid"}


def marker(text):
    return next((m for m in MARKERS if text.startswith(m)), "")


def shape(row):
    message = row.get("message", {})
    content = message.get("content") if isinstance(message, dict) else None
    parts = [row.get("type", "missing")]
    if parts[0] not in ("user", "assistant"):
        body = row.get("attachment", {})
        parts.append(body.get("type", "") if isinstance(body, dict) else "")
        if parts[0] == "system":
            parts.append(row.get("subtype", ""))
    else:
        parts += [type(content).__name__, row.get("origin", {}).get("kind", "absent")]
        parts += [k for k in ("isMeta", "isSidechain", "isCompactSummary") if row.get(k)]
        if isinstance(content, str):
            parts.append(marker(content))
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    parts.append(type(block).__name__)
                    continue
                kind = block.get("type", "missing")
                parts.append(kind)
                if kind == "tool_result":
                    result = block.get("content")
                    parts += [type(result).__name__, str(bool(block.get("is_error")))]
                    if isinstance(result, list):
                        parts += [b.get("type", "missing") for b in result if isinstance(b, dict)]
                if kind == "thinking":
                    parts.append("empty" if not block.get("thinking") else "nonempty")
    return "|".join(parts)


def sanitize(value, ids, schema_values, path=()):
    if isinstance(value, dict):
        out = {}
        for key, child in value.items():
            safe_key = key if re.fullmatch(r"[A-Za-z_][A-Za-z_0-9-]*", key) else str(uuid.uuid4())
            out[safe_key] = sanitize(child, ids, schema_values, path + (key,))
        return out
    if isinstance(value, list):
        return [sanitize(v, ids, schema_values, path + ("[]",)) for v in value]
    if not isinstance(value, str):
        return value
    key = path[-1] if path else ""
    # Input/toolUseResult/snapshot maps are arbitrary data, not discriminants.
    payload = any(p in {"input", "toolUseResult", "snapshot", "data"} for p in path)
    if not payload and (key in ENUMS or key == "subtype") and re.fullmatch(r"[\w/.-]{1,80}", value):
        schema_values.add(value)
        return value
    if key == "name" and value in TOOLS and not payload:
        schema_values.add(value)
        return value
    if key in ID_KEYS or key.lower().endswith(("uuid", "_id")) or key.endswith("Id"):
        return ids.setdefault(value, str(uuid.uuid4()))
    prefix = marker(value) if key in {"content", "text"} else ""
    if prefix:
        schema_values.add(prefix)
    return prefix + "x" * (len(value) - len(prefix))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--since", default="2026-09-07")
    parser.add_argument("--largest-path-file", type=pathlib.Path, required=True)
    args = parser.parse_args()
    cutoff = datetime.datetime.fromisoformat(args.since).replace(tzinfo=datetime.timezone.utc)
    files = sorted(p for root in (".claude-private", ".claude")
                   for p in (pathlib.Path.home() / root / "projects").rglob("*.jsonl"))
    largest = max(files, key=lambda p: p.stat().st_size)
    args.largest_path_file.write_text(str(largest))
    counts = collections.Counter()
    blocks = collections.Counter()
    shapes = collections.Counter()
    selected = {}
    malformed = 0
    scanned_files = 0
    for source in files:
        if source.stat().st_mtime < cutoff.timestamp():
            continue
        scanned_files += 1
        calls = {}
        for line in source.open(encoding="utf-8"):
            try:
                row = json.loads(line)
            except ValueError:
                malformed += 1
                continue
            timestamp = row.get("timestamp")
            if timestamp:
                try:
                    if datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00")) < cutoff:
                        continue
                except ValueError:
                    pass
            kind = row.get("type", "missing")
            counts[kind] += 1
            signature = shape(row)
            shapes[signature] += 1
            content = row.get("message", {}).get("content", [])
            preceding = []
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    blocks[f"{kind}/{block.get('type', 'missing')}"] += 1
                    if block.get("type") == "tool_use":
                        calls[block.get("id")] = row
                    elif block.get("type") == "tool_result":
                        call = calls.pop(block.get("tool_use_id"), None)
                        if call and call not in preceding:
                            preceding.append(call)
            # Prefer small *real* representatives; never trim a recorded payload.
            size = len(line) + sum(len(json.dumps(r)) for r in preceding)
            if signature not in selected or size < selected[signature][0]:
                selected[signature] = (size, preceding + [row])

    args.output.mkdir(parents=True, exist_ok=True)
    ids, schema_values, vocabulary = {}, set(), set()
    manifest = []
    for number, (signature, (_, rows)) in enumerate(sorted(selected.items())):
        name = f"shape-{number:03}.jsonl"
        sanitized = [sanitize(row, ids, schema_values) for row in rows]
        # Vocabulary comes only from payload values. Keys and enum discriminants
        # are intentionally retained protocol schema, not private prose.
        def words(value, safe):
            if isinstance(value, dict):
                for key, child in value.items():
                    words(child, safe.get(key) if isinstance(safe, dict) else None)
            elif isinstance(value, list):
                for child, replacement in zip(value, safe if isinstance(safe, list) else [None] * len(value)):
                    words(child, replacement)
            elif isinstance(value, str) and value != safe:
                vocabulary.update(w.lower() for w in re.findall(r"[A-Za-z]{4,}", value))
        for row, replacement in zip(rows, sanitized):
            words(row, replacement)
        (args.output / name).write_text("".join(json.dumps(r, ensure_ascii=True) + "\n" for r in sanitized))
        manifest.append({"file": name, "shape": signature, "rows": len(rows),
                         "source_json_bytes": sum(len(json.dumps(r).encode()) for r in rows)})

    # Compare source vocabulary without printing or persisting private words.
    # Shared schema words are the only exceptions.
    allowed = set(re.findall(r"[A-Za-z]{4,}", " ".join(schema_values))) | {"null", "true", "false"}
    for _, rows in selected.values():
        def keys(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    allowed.update(w.lower() for w in re.findall(r"[A-Za-z]{4,}", key))
                    keys(child)
            elif isinstance(value, list):
                for child in value:
                    keys(child)
        for row in rows:
            keys(row)
    patterns = sorted(vocabulary - {w.lower() for w in allowed} - {"xxxx"})
    # UUID segments and repeated placeholder letters can coincidentally be
    # source words. Normalize only those generated values for the vocabulary
    # check; schema and all retained payload bytes remain subject to it.
    audit = "\n".join(p.read_text() for p in args.output.glob("shape-*.jsonl"))
    audit = re.sub(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", "00000000", audit)
    audit = re.sub(r"x{4,}", "0000", audit)
    matches = set(re.findall(r"[A-Za-z]{4,}", audit.lower())) & set(patterns)
    if matches:
        raise RuntimeError(f"Source vocabulary privacy audit failed: {len(matches)} matches; words withheld")
    survey = {"since_utc": cutoff.isoformat(), "timestamp_policy": "Row timestamp; file mtime for undated rows",
              "files_found": len(files), "recent_files": scanned_files, "records": dict(sorted(counts.items())),
              "content_blocks": dict(sorted(blocks.items())), "shapes": dict(sorted(shapes.items())),
              "malformed_rows": malformed, "largest_bytes": largest.stat().st_size,
              "privacy_audit": {"method": "token-set intersection", "patterns": len(patterns), "matches": 0},
              "fixtures": manifest}
    (args.output / "survey.json").write_text(json.dumps(survey, indent=2) + "\n")
    print(json.dumps({"records": sum(counts.values()), "fixtures": len(manifest),
                      "largest_bytes": survey["largest_bytes"], "privacy_audit": survey["privacy_audit"]}))


if __name__ == "__main__":
    main()
