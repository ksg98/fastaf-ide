# Native throughput measurement — 2026-10-07

One targeted run on macOS, Cargo test profile (`opt-level=1`), through mbx and
the build-slot wrapper. `TUIC_CHAT_TRANSCRIPT` selected the largest local real
transcript at runtime. Its path and raw contents are not stored here.

| Path | Bytes read window | Elapsed | Process peak RSS |
| --- | ---: | ---: | ---: |
| Production first attach + snapshot | 2,097,152 | 33.528 ms | 25,722,880 bytes |
| Full file through the same reader/adapter/log + snapshot | 348,179,373 | 4,097.604 ms | 732,626,944 bytes |

Full-file throughput: **81.035 MiB/s**. The bounded log retained 2,000 of
58,778 emitted updates, totaling 1,626,077 serialized bytes. Unknown and malformed
rows were both zero. Peak RSS is the process high-water mark; the full-file mark
includes the earlier attach measurement. Full-file mode deliberately holds the
whole read buffer; normal first attach reads only the last 2 MiB.

Validation: `scripts/with-test-tmp.sh cargo nextest run --lib --run-ignored all
-E 'test(chat_view::)' --success-output immediate --failure-output immediate`
inside `src-tauri`, with `TUIC_CHAT_TRANSCRIPT` set. **30 targeted tests passed**
in 4.233 seconds of test execution. This includes all five recorded-corpus cases,
the opt-in measurement, existing adapter/view tests and the epoch critic test.
It does not claim a full-crate or release-build result.
