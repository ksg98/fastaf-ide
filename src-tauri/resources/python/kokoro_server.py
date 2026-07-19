#!/usr/bin/env python3
"""Kokoro TTS sidecar (mlx-audio, Apple Silicon).

NDJSON protocol over stdio:
  stdin : {"cmd":"speak","id":1,"text":"...","voice":"af_heart","speed":1.0}
          {"cmd":"cancel"}
          {"cmd":"shutdown"}
  stdout: {"type":"status","state":"loading|ready|error|stopped",...}
          {"type":"audio","id":1,"sr":24000,"b64":"<little-endian int16 PCM>"}
          {"type":"done","id":1}
          {"type":"error","id":1,"message":"..."}
          {"type":"cancelled"}

Run via: uv run --no-project --python 3.12 \
  --with "mlx-audio==0.4.4" --with "misaki[en]" python kokoro_server.py
"""

import base64
import json
import os
import queue
import sys
import threading

# The NDJSON protocol owns fd 1. Libraries (misaki/spacy download models via a
# pip subprocess on first use) print to stdout, which would corrupt it — so
# keep a private dup of the real stdout and point fd 1 at stderr for everyone
# else, including child processes.
_protocol_fd = os.dup(1)
os.dup2(2, 1)
_protocol_out = os.fdopen(_protocol_fd, "w", buffering=1)
sys.stdout = sys.stderr

_out_lock = threading.Lock()


def emit(obj):
    with _out_lock:
        _protocol_out.write(json.dumps(obj) + "\n")
        _protocol_out.flush()


MODEL_ID = os.environ.get("KOKORO_MODEL", "mlx-community/Kokoro-82M-bf16")

emit({"type": "status", "state": "loading", "model": MODEL_ID})
try:
    import numpy as np
    from mlx_audio.tts.utils import load_model

    MODEL = load_model(MODEL_ID)
    # Warm up: first generation triggers misaki's spacy model download and MLX
    # kernel compilation — do it now so 'ready' means instant speech.
    for _ in MODEL.generate(text="Hi.", voice="af_heart", speed=1.0, lang_code="a"):
        pass
    emit({"type": "status", "state": "ready"})
except Exception as e:  # noqa: BLE001 - report anything to the host app
    emit({"type": "status", "state": "error", "message": f"{type(e).__name__}: {e}"})
    sys.exit(1)

jobs = queue.Queue()
gen_lock = threading.Lock()
gen_id = 0  # bumped by cancel; worker drops chunks of stale generations


def synthesize(job, my_gen):
    req_id = job.get("id")
    text = (job.get("text") or "").strip()
    if not text:
        emit({"type": "done", "id": req_id})
        return
    kwargs = dict(
        text=text,
        voice=job.get("voice") or "af_heart",
        speed=float(job.get("speed") or 1.0),
        lang_code=job.get("lang_code") or "a",
    )
    try:
        try:
            results = MODEL.generate(**kwargs, stream=True, streaming_interval=0.5)
        except TypeError:
            # older mlx-audio without streaming kwargs; still yields per segment
            results = MODEL.generate(**kwargs)
        for result in results:
            with gen_lock:
                if gen_id != my_gen:
                    break
            audio = np.asarray(result.audio, dtype=np.float32).reshape(-1)
            if audio.size == 0:
                continue
            sr = int(getattr(result, "sample_rate", 24000) or 24000)
            pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
            emit(
                {
                    "type": "audio",
                    "id": req_id,
                    "sr": sr,
                    "b64": base64.b64encode(pcm.tobytes()).decode("ascii"),
                }
            )
        emit({"type": "done", "id": req_id})
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "id": req_id, "message": f"{type(e).__name__}: {e}"})


def worker():
    while True:
        job = jobs.get()
        if job is None:
            return
        with gen_lock:
            my_gen = gen_id
        synthesize(job, my_gen)


worker_thread = threading.Thread(target=worker, daemon=True)
worker_thread.start()


def drain_jobs():
    while True:
        try:
            jobs.get_nowait()
        except queue.Empty:
            return


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    cmd = msg.get("cmd")
    if cmd == "speak":
        jobs.put(msg)
    elif cmd == "cancel":
        with gen_lock:
            gen_id += 1
        drain_jobs()
        emit({"type": "cancelled"})
    elif cmd == "shutdown":
        break

# EOF/shutdown: let already-queued jobs finish, then exit
jobs.put(None)
worker_thread.join(timeout=120)
emit({"type": "status", "state": "stopped"})
