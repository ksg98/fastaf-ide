# Claude consumed choices with no replacement

Recorded on 2026-10-19 from real Claude Code v2.1.286 in isolated headless
instance `fix2029`, session `8acf09af-25b9-43eb-be14-3d68b84a0672`.
The unchanged TUICCAP2 file records 24 rows by 80 columns, output chunks and
user input. Capture began before startup output. The first request asks for
Reply alpha / Reply beta and asks Claude to answer the subsequent selection
with ACK only. A trusted mobile tap submits Reply alpha. Claude answers ACK
without another suggestion marker. Before the submitted-prompt boundary fix,
settled REST republishes the historical first list despite the input clear.

SHA-256: `0e95d406c566e9c88431d1090f617b859266d0a153d2fc778c6ec838243e9ce2`.
