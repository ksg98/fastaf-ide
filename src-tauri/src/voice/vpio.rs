//! Microphone capture through macOS voice processing.
//!
//! Barge-in needs the microphone live while the speakers are playing the
//! agent's own voice, which means something has to subtract that voice from
//! the mic signal. The reference implementation this feature is modelled on
//! gets that for free: its TTS plays inside Chromium and its microphone comes
//! from `getUserMedia`, so one audio engine owns both streams and cancels one
//! against the other with a sample-aligned reference.
//!
//! The native equivalent of that arrangement is
//! `kAudioUnitSubType_VoiceProcessingIO` — the unit FaceTime and every macOS
//! VoIP app capture through. The OS taps what the machine is playing at the
//! hardware layer and removes it from the mic signal before we ever see it,
//! with the device latency known exactly. Running our own canceller (`aec3`)
//! over a separate cpal stream instead has to *estimate* the delay between two
//! unsynchronized streams, and while that estimate converges the mic hears the
//! first word of every reply — which is precisely when a reply gets cut off
//! (issue #7).
//!
//! Voice processing also applies the OS noise suppression and, enabled below,
//! automatic gain control — the other two `getUserMedia` constraints the
//! reference implementation requests.
//!
//! Used only by voice sessions with barge-in on; dictation keeps its plain
//! cpal capture, and any failure here falls back to cpal + `aec3`.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::AtomicU32;

use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::macos_helpers::{get_audio_device_ids_for_scope, get_device_name};
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::audio_unit::{AudioUnit, Element, IOType, SampleFormat, Scope, StreamFormat};
use objc2_audio_toolbox::{
    AUVoiceIOOtherAudioDuckingConfiguration, AUVoiceIOOtherAudioDuckingLevel,
    kAUVoiceIOProperty_OtherAudioDuckingConfiguration, kAUVoiceIOProperty_VoiceProcessingEnableAGC,
    kAudioOutputUnitProperty_CurrentDevice, kAudioOutputUnitProperty_EnableIO,
    kAudioUnitProperty_StreamFormat,
};
use parking_lot::Mutex;

use crate::dictation::audio::process_audio_chunk;

/// Same rate the cpal capture delivers, so everything downstream is identical.
const SAMPLE_RATE: u32 = 16_000;

/// Microphone capture owned by the OS voice-processing unit.
///
/// Deliberately the same surface as `dictation::audio::AudioCapture` — a shared
/// sample buffer for the session thread and a level meter for `voice_status` —
/// so the listening loop cannot tell which capture is feeding it.
pub struct VpioCapture {
    audio_unit: AudioUnit,
    buffer: Arc<Mutex<VecDeque<f32>>>,
    level: Arc<AtomicU32>,
}

impl VpioCapture {
    /// Open the default (or named) microphone through voice processing and
    /// start capturing 16 kHz mono into the shared buffer.
    pub fn start(preferred_device: Option<&str>) -> Result<Self, String> {
        let mut unit = AudioUnit::new_uninitialized(IOType::VoiceProcessingIO)
            .map_err(|e| format!("Failed to create the voice-processing unit: {e}"))?;

        // Input on element 1, output element 0 off — playback stays on rodio.
        // The canceller's reference is the system output tap, not this unit's
        // render path, so nothing needs to be routed through it.
        let enable: u32 = 1;
        let disable: u32 = 0;
        unit.set_property(
            kAudioOutputUnitProperty_EnableIO,
            Scope::Input,
            Element::Input,
            Some(&enable),
        )
        .map_err(|e| format!("Failed to enable voice-processing input: {e}"))?;
        unit.set_property(
            kAudioOutputUnitProperty_EnableIO,
            Scope::Output,
            Element::Output,
            Some(&disable),
        )
        .map_err(|e| format!("Failed to disable voice-processing output: {e}"))?;

        // The Dictation tab's microphone choice applies here too. Falling back
        // to the default device on a stale name matches what cpal capture does.
        if let Some(device_id) = preferred_device.and_then(resolve_input_device) {
            unit.set_property(
                kAudioOutputUnitProperty_CurrentDevice,
                Scope::Global,
                Element::Output,
                Some(&device_id),
            )
            .map_err(|e| format!("Failed to select the microphone: {e}"))?;
        }

        // AGC, matching the reference implementation's autoGainControl: true.
        let _ = unit.set_property(
            kAUVoiceIOProperty_VoiceProcessingEnableAGC,
            Scope::Global,
            Element::Output,
            Some(&enable),
        );

        // Voice processing ducks "other audio" by default — and the agent's own
        // speech through rodio is other audio, so the default would quieten
        // every reply while the mic listens to it. Minimum ducking keeps the
        // replies at full volume; the property is macOS 14+, and on older
        // systems the default mild ducking is merely cosmetic, so a failure
        // here is ignored.
        let ducking = AUVoiceIOOtherAudioDuckingConfiguration {
            mEnableAdvancedDucking: 0,
            mDuckingLevel: AUVoiceIOOtherAudioDuckingLevel::Min,
        };
        let _ = unit.set_property(
            kAUVoiceIOProperty_OtherAudioDuckingConfiguration,
            Scope::Global,
            Element::Output,
            Some(&ducking),
        );

        // Ask for the pipeline's native format directly; the unit resamples
        // internally from whatever the hardware runs at. Must happen before
        // initialize — unlike a plain HAL unit, voice processing locks its
        // client format at initialization ("Property not writable" after).
        let format = StreamFormat {
            sample_rate: f64::from(SAMPLE_RATE),
            sample_format: SampleFormat::F32,
            flags: LinearPcmFlags::IS_FLOAT | LinearPcmFlags::IS_PACKED,
            channels: 1,
        };
        unit.set_property(
            kAudioUnitProperty_StreamFormat,
            Scope::Output,
            Element::Input,
            Some(&format.to_asbd()),
        )
        .map_err(|e| format!("Failed to set the capture format: {e}"))?;
        // The output element's client format must agree with the input's even
        // though the element itself is disabled — voice processing runs one
        // clock through both and refuses to initialize on a mismatch
        // ("Failed initialization" with no further detail, found empirically).
        unit.set_property(
            kAudioUnitProperty_StreamFormat,
            Scope::Input,
            Element::Output,
            Some(&format.to_asbd()),
        )
        .map_err(|e| format!("Failed to set the render-side format: {e}"))?;

        unit.initialize()
            .map_err(|e| format!("Failed to initialize voice processing: {e}"))?;

        let buffer: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
        let level = Arc::new(AtomicU32::new(0));

        let cb_buffer = Arc::clone(&buffer);
        let cb_level = Arc::clone(&level);
        // Scratch buffers owned by the callback, as in the cpal path — the
        // audio thread must not allocate per callback.
        let mut mono_buf: Vec<f32> = Vec::new();
        let mut resample_buf: Vec<f32> = Vec::new();
        unit.set_input_callback(move |args: render_callback::Args<data::Interleaved<f32>>| {
            let samples = args.num_frames.min(args.data.buffer.len());
            process_audio_chunk(
                &args.data.buffer[..samples],
                SAMPLE_RATE,
                1,
                &cb_buffer,
                &cb_level,
                &mut mono_buf,
                &mut resample_buf,
            );
            Ok(())
        })
        .map_err(|e| format!("Failed to install the capture callback: {e}"))?;

        unit.start()
            .map_err(|e| format!("Failed to start voice processing: {e}"))?;

        Ok(Self {
            audio_unit: unit,
            buffer,
            level,
        })
    }

    /// The shared sample buffer the session thread drains.
    pub fn buffer_handle(&self) -> Arc<Mutex<VecDeque<f32>>> {
        Arc::clone(&self.buffer)
    }

    /// Current microphone level for the UI meter, 0..=1.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(std::sync::atomic::Ordering::Relaxed))
    }
}

impl Drop for VpioCapture {
    fn drop(&mut self) {
        // AudioUnit's own Drop uninitializes and disposes; stopping first keeps
        // the teardown orderly while the render thread is still live.
        let _ = self.audio_unit.stop();
    }
}

/// Find an input device by the name the Dictation settings store.
fn resolve_input_device(name: &str) -> Option<u32> {
    let ids = get_audio_device_ids_for_scope(Scope::Input).ok()?;
    ids.into_iter()
        .find(|id| get_device_name(*id).is_ok_and(|n| n == name))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Proves the whole chain on real hardware: the voice-processing unit
    /// opens, accepts the 16 kHz mono format, starts, and its callback delivers
    /// samples into the shared buffer. Ignored because it touches the audio
    /// device (and microphone TCC) — run manually with:
    /// `cargo test --lib voice::vpio -- --ignored`
    #[test]
    #[ignore = "opens the real microphone through VoiceProcessingIO"]
    fn live_voice_processing_capture_delivers_samples() {
        let capture = VpioCapture::start(None).expect("voice processing should open");
        let buffer = capture.buffer_handle();
        // ~40 callbacks at 10 ms a piece; even a denied-TCC stream delivers
        // (zeroed) frames, so an empty buffer means the unit never ran.
        std::thread::sleep(std::time::Duration::from_millis(400));
        let collected = buffer.lock().len();
        assert!(
            collected > 16_000 / 10,
            "expected at least 100ms of samples from the callback, got {collected}"
        );
    }
}
