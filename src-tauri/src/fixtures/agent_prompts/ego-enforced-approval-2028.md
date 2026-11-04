# Ego enforced command approval — 2028-6999

Captured 2026-10-18 from the installed ego binary in real TUIC session `d293f26a-02bc-4f17-9efe-ea9527f0c921`, 32 × 100, cwd `~/Gits/.tmp/fix-parity`. The installed binary reported **0.1.1** on this later launch; the earlier color/permission capture reported 0.1.0. No binary was built or replaced by this peer.

Launch: `ego --mode default --tools exec` with the existing account/configuration. The prompt requested argv `["python3", "-c", "print(987654321)"]`, not a model permission question. The CLI enforced a native `Allow run ...?` approval with Risk and y/a/n/e/d controls. A single n opened `What should it do instead? (Enter alone just says no)`, then bare Enter refused. Ego printed `Denied run ...` and `permission was refused`; the command never ran.

The TUIC capture tap was enabled before launch, filtered to this session; original geometry, ordered input/output chunks and timestamps are retained. Source: `/Users/stefano.straus/Library/Application Support/com.tuic.commander/captures/d293f26a-02bc-4f17-9efe-ea9527f0c921.tcap`.

SHA-256: `742475e1197e654defe940d37b581925c08babdd75ee6208c5d65bb3f4f5e4b2`
