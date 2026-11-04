"""The upstream revisions the Pocket TTS catalogue is pinned to.

Shared by `verify_voices.py` and `gen_voice_catalogue.py`, so the voices the
gate renders are the voices the generator pins. The Rust side
(`voice_revision!` and the revision constants in
`src-tauri/crates/tuic-dictation/src/speech/assets.rs`) is pinned by the tests there.
"""

# The ONNX export, pinned like `POCKET_ONNX_REVISION` in `speech/assets.rs`.
ONNX_REPO = "KevinAHM/pocket-tts-onnx"
ONNX_REVISION = "58a6d00cf13d239b6748cb0769f35c580a8f606c"

# The voice revision each language is pinned to, by its Hugging Face name.
# French stays at the older revision: the `french_24l` voices at 8843db76 add a
# `self_attn/pad` tensor per layer and carry a KV cache for a newer model than
# the ONNX export above, and every one of them renders 0.72 s (EOS on the first
# frame) — in the reference runtime and in the app's engine alike. The ones at
# 00eac05e render normally.
VOICES_REPO = "kyutai/pocket-tts-without-voice-cloning"
VOICES_REVISIONS = {
    "italian": "8843db76457a91db32077edf8dfcd1c0e3e755fd",
    "english_2026-04": "8843db76457a91db32077edf8dfcd1c0e3e755fd",
    "french_24l": "00eac05ed3d16bdc3f6b5d598874019c34a89214",
    "german": "8843db76457a91db32077edf8dfcd1c0e3e755fd",
    "portuguese": "8843db76457a91db32077edf8dfcd1c0e3e755fd",
    "spanish": "8843db76457a91db32077edf8dfcd1c0e3e755fd",
}

# The voice each language ships with, in its payload in `assets.rs`.
DEFAULT_VOICES = {
    "italian": "giovanni",
    "english_2026-04": "alba",
    "french_24l": "estelle",
    "german": "juergen",
    "portuguese": "rafael",
    "spanish": "lola",
}

# The name the app installs a language under, where it differs from the name
# Hugging Face files it under (`Kind::Language.language` in `assets.rs`).
INSTALLED_AS = {"english_2026-04": "english", "french_24l": "french"}

VOICES_PER_LANGUAGE = 26
