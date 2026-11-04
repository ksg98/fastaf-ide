# Claude full-screen suggestion repaint

Recorded on 2026-10-19 from real Claude Code v2.1.286 in isolated headless
instance `fix2029`, session `76b08ff7-19c9-41e9-aa65-9b7c79e194cb`.
The unchanged TUICCAP2 file records 24 rows by 80 columns, output chunks and
user input. Capture began before startup output. The first response offers
Reply alpha / Reply beta. A trusted mobile tap submits Reply alpha; the next
response offers Test another marker / Test the 💬 prefix / Done testing.
A full repaint includes both lists. Before the parser fix, settled REST
incorrectly republishes the first list.

SHA-256: `510e639e6f4a1709b3993f1635f9bde8497804f692c4c31a5ef6d00c691d5705`.
