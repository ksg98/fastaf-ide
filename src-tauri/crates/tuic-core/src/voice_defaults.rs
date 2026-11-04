//! Voice configuration defaults available without a native audio backend.
/// Historical RMS floor, paired with the no-speech probability gate.
pub const DEFAULT_RMS_THRESHOLD: f32 = 0.001;
/// whisper.cpp's own `no_speech_thold` default.
pub const DEFAULT_NO_SPEECH_THRESHOLD: f32 = 0.6;
