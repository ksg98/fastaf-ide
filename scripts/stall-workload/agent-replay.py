#!/usr/bin/env python3
"""Replay real recorded agent PTY output (corpus .tcap files) in a loop, with
original chunk boundaries and timing, plus optional repository churn.

Usage: agent-replay.py <profile> <repo> <tcap>... [-l]
profiles: replay | burst | churn
Not a historical workload: real agent bytes, re-paced from their own captures.
"""
import os
import random
import struct
import subprocess
import sys
import time

args = [a for a in sys.argv[1:] if a != '-l']
profile, repo, captures = args[0], args[1], args[2:]


def records(path):
    data = open(path, 'rb').read()
    if data.startswith(b'TUICCAP2\n'):
        cur = 9 + 4
    elif data.startswith(b'TUICCAP1\n'):
        cur = 9
    else:
        return [(0, data)]
    out = []
    while cur + 13 <= len(data):
        direction = data[cur]
        elapsed, length = struct.unpack_from('<QI', data, cur + 1)
        cur += 13
        chunk = data[cur:cur + length]
        cur += length
        if direction == 0:
            out.append((elapsed, chunk))
    return out


def churn(step):
    name = os.path.join(repo, 'work', f'f{step % 40}.txt')
    os.makedirs(os.path.dirname(name), exist_ok=True)
    with open(name, 'w') as f:
        f.write(f'edit {step} {time.time()}\n' * 50)
    if step % 7 == 0:
        subprocess.run(['git', '-C', repo, 'add', '-A'], capture_output=True)
        subprocess.run(['git', '-C', repo, '-c', 'user.name=load', '-c',
                        'user.email=load@example.invalid', 'commit', '-qm',
                        f'load {step}'], capture_output=True)


out = sys.stdout.buffer
rng = random.Random(" ".join(captures))  # deterministic per session
step = 0
while True:
    path = rng.choice(captures)
    recs = records(path)
    prev = None
    for elapsed, chunk in recs:
        if prev is not None:
            gap = (elapsed - prev) / 1e6
            if profile == 'burst':
                gap = min(gap, 0.005)
            time.sleep(min(max(gap, 0), 2.0))
        prev = elapsed
        out.write(chunk)
        out.flush()
        if profile == 'churn' and rng.random() < 0.02:
            step += 1
            churn(step)
    # Return to a sane screen between loops, as an agent restart would.
    out.write(b'\x1b[?1049l\x1b[0m\r\n')
    out.flush()
    time.sleep(1)
