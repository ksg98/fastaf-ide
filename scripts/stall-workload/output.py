#!/usr/bin/env python3
"""Bounded, paced synthetic agent-like PTY output; not historical agent evidence."""
import os
import sys
import time

# The PTY shell launcher appends -l; this is deliberately accepted, not a login shell.
seconds = float(os.environ.get('STALL_SECONDS', '15'))
columns = int(os.environ.get('STALL_COLUMNS', '220'))
lines = int(os.environ.get('STALL_LINES_PER_TICK', '12'))
start = time.monotonic()
step = 0
print('Synthetic workload: source listing, Unicode status, and tool progress. Not a real agent.', flush=True)
# Allow the frontend subscription and geometry to settle before output starts.
time.sleep(2)
while time.monotonic() - start < seconds + 2:
    text = []
    for row in range(lines):
        prefix = f'{step:05d}:{row:02d}  \x1b[36m✻ Working\x1b[0m  '
        body = 'const result = await inspect(source); // café e\u0301 λ → 界 ⚙︎  '
        text.append(prefix + (body * 6)[:max(1, columns - 26)] + '\r\n')
    sys.stdout.write(''.join(text))
    sys.stdout.flush()
    step += 1
    time.sleep(0.1)
# Stay alive briefly so the final recording is not dominated by terminal teardown.
time.sleep(5)
