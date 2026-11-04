//! The loudness stage: every spoken reply at one level, whatever the voice.
//!
//! Voices differ by more than 10 dB in their rendered level, and one reply
//! drifts within itself. This stage runs offline on the whole buffer before it
//! is played, in three steps:
//!
//! 1. **Levelling.** A 300 ms running RMS envelope drives a gain toward the
//!    reply's own speech level, with a ratio from `levelling` (0 = off, 1 = 4:1)
//!    and at most +12 dB of boost. Samples whose envelope is below the -50 dBFS
//!    gate are silence and are not levelled.
//! 2. **Gain** to `volume_db`, measured over speech only. Gated samples are
//!    never boosted, so the noise floor between sentences stays where it was.
//! 3. **A look-ahead limiter** at -1 dBFS, for peaks the gain pushed past it.
//!    Offline, every peak is known before it arrives, so the gain ramps down
//!    ahead of it and never exceeds what that peak needs: nothing reaches the
//!    final clamp except float rounding.
//!
//! Not rodio's `Limit`, which the plan first named: it is a streaming limiter
//! that takes a logarithm and a power of every sample, and measured 5.3 ms of
//! a 10.6 ms budget-breaking run on 30 s of audio. This stage runs between
//! synthesis and playback, so its time is heard as delay.

use std::num::NonZero;

use super::speech::SpeechAudio;

/// Seconds of audio the levelling envelope averages over.
const ENVELOPE_SECONDS: f32 = 0.3;
/// Seconds of audio the level measurement averages over. Short, so that the
/// silence next to a sentence does not count as speech and pull the level down.
const MEASURE_SECONDS: f32 = 0.02;
/// Below this level a sample is silence.
const GATE_DB: f32 = -50.0;
const MAX_BOOST_DB: f32 = 12.0;
const CEILING_DB: f32 = -1.0;
/// Samples per levelling gain step; the gain is interpolated in between. The
/// envelope moves over 300 ms, so 64 samples (under 3 ms at 24 kHz) lose
/// nothing and save a power per sample.
const GAIN_STEP: usize = 64;
/// How far ahead of a peak the limiter starts to pull the gain down.
const LIMIT_ATTACK_SECONDS: f32 = 0.005;
/// How long the limiter takes to let the gain back up after a peak.
const LIMIT_RELEASE_SECONDS: f32 = 0.1;
/// A gain less than this short of 1 is 1. Recovery never quite arrives, and
/// every later sample would otherwise be scaled by what is left.
const LIMIT_SNAP: f32 = 1e-5;

/// How a reply is levelled. `volume_db` is the speech level in dBFS
/// (-30..=-12); `levelling` is the strength of the levelling (0..=1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    pub volume_db: f32,
    pub levelling: f32,
}

/// Compression ratio of the levelling: 0 → 1:1 (off), 1 → 4:1.
fn ratio(levelling: f32) -> f32 {
    1.0 + 3.0 * levelling
}

/// Bring `audio` to `s.volume_db` in place. Empty audio, a zero sample rate and
/// audio with no sample above the gate are left untouched.
pub fn process(audio: &mut SpeechAudio, s: Loudness) {
    let Some(rate) = NonZero::new(audio.sample_rate) else {
        return;
    };
    let gate = db_to_power(GATE_DB);
    let measure = window(rate, MEASURE_SECONDS);
    let Some(reference) = speech_power(&audio.samples, measure, gate) else {
        return;
    };
    let envelope = running_mean_square(&audio.samples, window(rate, ENVELOPE_SECONDS));

    // Power ratio to amplitude gain: half the exponent. A ratio of 1 gives an
    // exponent of 0, and the loop is skipped so the gain stays exactly 1.
    let exponent = 0.5 * (1.0 - 1.0 / ratio(s.levelling.clamp(0.0, 1.0)));
    if exponent > 0.0 {
        let max_boost = db_to_amplitude(MAX_BOOST_DB);
        let gain_at = |p: f32| {
            if p >= gate {
                (reference / p).powf(exponent).min(max_boost)
            } else {
                1.0
            }
        };
        let mut from = gain_at(envelope[0]);
        for (step, chunk) in audio.samples.chunks_mut(GAIN_STEP).enumerate() {
            let next = envelope
                .get((step + 1) * GAIN_STEP)
                .map_or(from, |&p| gain_at(p));
            let slope = (next - from) / chunk.len() as f32;
            for (k, x) in chunk.iter_mut().enumerate() {
                *x *= from + slope * k as f32;
            }
            from = next;
        }
    }

    let Some(level) = speech_power(&audio.samples, measure, gate) else {
        return;
    };
    let makeup = (db_to_power(s.volume_db) / level).sqrt();
    let silence_gain = makeup.min(1.0);
    for (x, &p) in audio.samples.iter_mut().zip(&envelope) {
        *x *= if p >= gate { makeup } else { silence_gain };
    }

    // The envelope is spent: it becomes the limiter's gain rather than a
    // second buffer of the reply's length.
    let mut gain = envelope;
    limit(
        &mut audio.samples,
        &mut gain,
        rate,
        db_to_amplitude(CEILING_DB),
    );
}

/// Keep every sample at or below `ceiling` with a gain that moves smoothly.
///
/// Each sample's own need is `ceiling / |x|`. A forward pass lets the gain
/// recover from a dip no faster than the release; a backward pass makes it
/// start down before the dip no faster than the attack. Both only lower the
/// gain, so it never exceeds what any sample needs — and below the ceiling it
/// stays exactly 1. `gain` is scratch of the same length as `samples`.
fn limit(samples: &mut [f32], gain: &mut [f32], rate: NonZero<u32>, ceiling: f32) {
    if samples.iter().all(|x| x.abs() <= ceiling) {
        return;
    }
    let recovery = |seconds: f32| 1.0 - (-1.0 / (seconds * rate.get() as f32)).exp();
    let release = recovery(LIMIT_RELEASE_SECONDS);
    let attack = recovery(LIMIT_ATTACK_SECONDS);
    for (g, &x) in gain.iter_mut().zip(samples.iter()) {
        let a = x.abs();
        *g = if a > ceiling { ceiling / a } else { 1.0 };
    }
    recover::<false>(gain, release);
    recover::<true>(gain, attack);
    for (x, &g) in samples.iter_mut().zip(gain.iter()) {
        *x = (*x * g).clamp(-ceiling, ceiling);
    }
}

/// Let each gain rise toward 1 from its neighbour no faster than `rate`:
/// from the one before it, or with `BACKWARD` from the one after it.
///
/// The recursion runs on the deficit `1 - gain`: near 1 a step on the gain
/// itself is below one f32 ulp and would stall short of unity. Step by step
/// it is `d[k] = max(need[k], snap(d[k-1] * keep))`, and unrolled that is the
/// largest of every earlier need decayed by its distance. A block of `LANES`
/// computes that maximum from its own needs and the deficit carried in, so the
/// only dependency from one block to the next is one multiply: a sample-serial
/// chain would cost its latency per sample.
// Both reductions evaluate every lane so the fixed-size block remains branch-free
// and can be vectorized; short-circuiting changes the audio processing budget.
#[expect(
    clippy::needless_bitwise_bool,
    reason = "branch-free SIMD lane reductions"
)]
fn recover<const BACKWARD: bool>(gain: &mut [f32], rate: f32) {
    const LANES: usize = 8;
    let keep = 1.0 - rate;
    // `decay[j]` is `keep^j`; `spread[i][j]` carries lane `i` into lane `j > i`.
    let mut decay = [1.0f32; LANES + 1];
    for j in 1..=LANES {
        decay[j] = decay[j - 1] * keep;
    }
    let mut spread = [[0.0f32; LANES]; LANES];
    for (i, row) in spread.iter_mut().enumerate() {
        for (j, s) in row.iter_mut().enumerate().skip(i + 1) {
            *s = decay[j - i];
        }
    }
    let snap = |d: f32| if d < LIMIT_SNAP { 0.0 } else { d };
    let mut carried = 0.0f32;
    let mut block = |chunk: &mut [f32; LANES]| {
        // Lane `j` is the `j`-th step in the direction of travel.
        let lane = |j: usize| if BACKWARD { LANES - 1 - j } else { j };
        let mut need = [0.0f32; LANES];
        for (j, d) in need.iter_mut().enumerate() {
            *d = 1.0 - chunk[lane(j)];
        }
        // Each need at least what the one before it decays to: then every
        // deficit is its own need, and the gains are already the answer. This
        // is a run of unity with nothing carried, and the attack pass through
        // a release tail, which rises toward the peak faster than it decays.
        let mut before = [carried; LANES];
        before[1..].copy_from_slice(&need[..LANES - 1]);
        if need
            .iter()
            .zip(&before)
            .fold(true, |held, (&d, &b)| held & (d >= b * keep))
        {
            carried = need[LANES - 1];
            return;
        }
        let mut risen = [0.0f32; LANES];
        for (j, r) in risen.iter_mut().enumerate() {
            *r = carried * decay[j + 1];
        }
        // Inside a release tail no sample needs anything: only the carry moves.
        if need.iter().fold(false, |any, &d| any | (d > 0.0)) {
            for (&d, row) in need.iter().zip(&spread) {
                for (r, &s) in risen.iter_mut().zip(row) {
                    *r = r.max(d * s);
                }
            }
        }
        for (j, (&d, &r)) in need.iter().zip(&risen).enumerate() {
            let deficit = d.max(snap(r));
            chunk[lane(j)] = 1.0 - deficit;
            carried = deficit;
        }
    };
    // Whole blocks, then the rest padded with unity after it in the
    // direction of travel, where it needs nothing and carries nothing on.
    let mut padded = [1.0f32; LANES];
    if BACKWARD {
        let mut blocks = gain.rchunks_exact_mut(LANES);
        blocks.by_ref().for_each(|b| block(b.try_into().unwrap()));
        let rest = blocks.into_remainder();
        let len = rest.len();
        padded[LANES - len..].copy_from_slice(rest);
        block(&mut padded);
        rest.copy_from_slice(&padded[LANES - len..]);
    } else {
        let (blocks, rest) = gain.as_chunks_mut::<LANES>();
        blocks.iter_mut().for_each(&mut block);
        let len = rest.len();
        padded[..len].copy_from_slice(rest);
        block(&mut padded);
        rest.copy_from_slice(&padded[..len]);
    }
}

fn window(rate: NonZero<u32>, seconds: f32) -> usize {
    ((rate.get() as f32 * seconds) as usize).max(1)
}

/// Units of power per unit of the fixed-point squares the running sums add.
/// Integer sums are exact, so what enters the window leaves it bit for bit and
/// nothing drifts; an integer add is also a shorter dependency chain than an
/// f64 one. 2^32 resolves -96 dBFS, far below the gate, and a 0.3 s window of
/// full-scale samples boosted 12 dB stays 2^14 below overflow.
const FIXED_SCALE: f32 = (1u64 << 32) as f32;

/// Squared in f32: the scale is a power of two and only moves the exponent,
/// and an f32 square vectorises at twice the width of an f64 one.
fn fixed_square(x: f32) -> i64 {
    (x * x * FIXED_SCALE) as i64
}

/// Call `each(start, sums)` for every run of samples from `start`, with each
/// sample's sum of fixed-point squares over a centred window of `width`
/// samples, O(n) with a running sum. Outside the buffer counts as silence, so
/// the first and last words of a reply are levelled like a word after a pause.
///
/// Worked a chunk at a time: the squares entering and leaving the window are
/// differenced without a branch per sample, and the running sum is a prefix
/// over groups of `GROUP`, so both vectorise and one add per group is serial.
fn for_each_window_sum(samples: &[f32], width: usize, mut each: impl FnMut(usize, &[i64])) {
    const CHUNK: usize = 256;
    const GROUP: usize = 8;
    let half = width / 2;
    let n = samples.len();
    let mut sum: i64 = samples[..half.min(n)]
        .iter()
        .map(|&x| fixed_square(x))
        .fold(0, i64::wrapping_add);
    let mut diff = [0i64; CHUNK];
    for start in (0..n).step_by(CHUNK) {
        let len = CHUNK.min(n - start);
        diff.fill(0);
        // Sample `start + k + half` enters and `start + k - half - 1` leaves.
        let entering = samples.get(start + half..).unwrap_or_default();
        for (d, &x) in diff[..len].iter_mut().zip(entering) {
            *d = fixed_square(x);
        }
        let first_leaving = (half + 1).saturating_sub(start).min(len);
        let from = (start + first_leaving).saturating_sub(half + 1);
        let leaving = &samples[from..from + len - first_leaving];
        for (d, &x) in diff[first_leaving..len].iter_mut().zip(leaving) {
            // Wrapping, so a non-finite sample cannot panic: it saturates the
            // square, and what it adds it takes back when it leaves.
            *d = d.wrapping_sub(fixed_square(x));
        }
        for group in diff.as_chunks_mut::<GROUP>().0 {
            let mut step = 1;
            while step < GROUP {
                for j in (step..GROUP).rev() {
                    group[j] = group[j].wrapping_add(group[j - step]);
                }
                step *= 2;
            }
            for d in group.iter_mut() {
                *d = d.wrapping_add(sum);
            }
            sum = group[GROUP - 1];
        }
        each(start, &diff[..len]);
    }
}

fn running_mean_square(samples: &[f32], width: usize) -> Vec<f32> {
    let per_unit = (1.0 / (width as f64 * f64::from(FIXED_SCALE))) as f32;
    let mut out = Vec::with_capacity(samples.len());
    for_each_window_sum(samples, width, |_, sums| {
        out.extend(sums.iter().map(|&s| s as f32 * per_unit));
    });
    out
}

/// Mean power of the samples whose short envelope is above the gate, or `None`
/// when there are none.
fn speech_power(samples: &[f32], width: usize, gate: f32) -> Option<f32> {
    let threshold = (f64::from(gate) * width as f64 * f64::from(FIXED_SCALE)).ceil() as i64;
    let (mut sum, mut count) = (0i64, 0usize);
    for_each_window_sum(samples, width, |start, sums| {
        for (&x, &s) in samples[start..].iter().zip(sums) {
            let speech = s >= threshold;
            sum = sum.wrapping_add(if speech { fixed_square(x) } else { 0 });
            count += usize::from(speech);
        }
    });
    (count > 0 && sum > 0).then(|| (sum as f64 / f64::from(FIXED_SCALE) / count as f64) as f32)
}

fn db_to_power(db: f32) -> f32 {
    10f32.powf(db / 10.0)
}

fn db_to_amplitude(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;
    use std::time::Instant;

    const RATE: u32 = 24_000;
    const DEFAULT: Loudness = Loudness {
        volume_db: -18.0,
        levelling: 0.67,
    };

    fn samples(seconds: f32) -> usize {
        (RATE as f32 * seconds) as usize
    }

    /// A sine at `rms_db` dBFS RMS.
    fn sine(freq: f32, rms_db: f32, seconds: f32) -> Vec<f32> {
        let amplitude = db_to_amplitude(rms_db) * 2f32.sqrt();
        (0..samples(seconds))
            .map(|i| amplitude * (2.0 * PI * freq * i as f32 / RATE as f32).sin())
            .collect()
    }

    fn rms_db(samples: &[f32]) -> f32 {
        let power = samples
            .iter()
            .map(|&x| (x as f64) * (x as f64))
            .sum::<f64>()
            / samples.len() as f64;
        10.0 * (power.log10() as f32)
    }

    fn audio(samples: Vec<f32>) -> SpeechAudio {
        SpeechAudio {
            samples,
            sample_rate: RATE,
        }
    }

    /// Two one-second bursts at `a` and `b` dBFS, each after half a second of
    /// `floor`, with half a second of `floor` at the end. Returns the audio and
    /// the sample ranges of the two bursts.
    fn two_bursts(
        a: f32,
        b: f32,
        floor: &dyn Fn(f32) -> Vec<f32>,
    ) -> (Vec<f32>, [std::ops::Range<usize>; 2]) {
        let mut out = floor(0.5);
        let first = out.len()..out.len() + samples(1.0);
        out.extend(sine(440.0, a, 1.0));
        out.extend(floor(1.0));
        let second = out.len()..out.len() + samples(1.0);
        out.extend(sine(440.0, b, 1.0));
        out.extend(floor(0.5));
        (out, [first, second])
    }

    fn zeros(seconds: f32) -> Vec<f32> {
        vec![0.0; samples(seconds)]
    }

    #[test]
    fn a_quiet_reply_comes_out_at_the_configured_level() {
        // A voice that renders 14 dB too quiet is the case the stage exists
        // for: without it, the user turns the system volume up for one voice
        // and is shouted at by the next.
        let (input, bursts) = two_bursts(-32.0, -32.0, &zeros);
        let mut reply = audio(input);
        process(&mut reply, DEFAULT);
        for burst in bursts {
            let level = rms_db(&reply.samples[burst]);
            assert!(
                (level - DEFAULT.volume_db).abs() <= 1.0,
                "burst at {level} dBFS, target {} dBFS",
                DEFAULT.volume_db
            );
        }
    }

    #[test]
    fn no_sample_ends_above_minus_one_dbfs() {
        // A transient at full scale inside quiet speech: the gain that lifts the
        // speech would clip it, and the loudest setting leaves no headroom.
        let mut input = sine(440.0, -32.0, 2.0);
        let click = samples(1.0);
        input[click..click + 24].fill(0.99);
        input[click + 24..click + 48].fill(-0.99);
        let mut reply = audio(input);
        process(
            &mut reply,
            Loudness {
                volume_db: -12.0,
                levelling: 1.0,
            },
        );
        let peak = reply.samples.iter().fold(0f32, |m, &x| m.max(x.abs()));
        assert!(
            peak <= db_to_amplitude(CEILING_DB),
            "peak {} dBFS",
            20.0 * peak.log10()
        );
    }

    #[test]
    fn the_limiter_lets_go_of_the_speech_after_a_peak() {
        // Recovery toward 1 in f32 stalls one ulp short of it, so without a
        // snap every sample after the first peak is scaled by 0.99999994 and
        // the recovery pass runs to the end of the reply.
        let ceiling = db_to_amplitude(CEILING_DB);
        let mut input = sine(440.0, -20.0, 5.0);
        input[samples(1.0)..samples(1.0) + 24].fill(0.99);
        let expected = input.clone();
        let mut gain = vec![0.0; input.len()];
        limit(&mut input, &mut gain, NonZero::new(RATE).unwrap(), ceiling);
        let after = samples(3.0);
        assert_eq!(input[after..], expected[after..]);
        assert!(input[samples(1.0)] <= ceiling);
    }

    #[test]
    fn the_running_mean_square_is_the_mean_over_its_window() {
        // The running sum is kept a chunk and a group at a time, so every
        // edge — the buffer's ends, the chunks, a window wider than a chunk or
        // than the whole buffer — must still give the plain windowed mean.
        let input: Vec<f32> = (0..1000)
            .map(|i| ((i * 37 % 101) as f32 - 50.0) / 60.0)
            .collect();
        for width in [1, 2, 7, 480, 999, 2500] {
            let half = width / 2;
            let actual = running_mean_square(&input, width);
            assert_eq!(actual.len(), input.len());
            for (i, &p) in actual.iter().enumerate() {
                let window = i.saturating_sub(half)..(i + half).min(input.len() - 1) + 1;
                let sum: f64 = input[window].iter().map(|&x| f64::from(x * x)).sum();
                let expected = (sum / width as f64) as f32;
                assert!(
                    (p - expected).abs() <= expected * 1e-5 + 1e-9,
                    "width {width}, sample {i}: {p}, expected {expected}"
                );
            }
        }
    }

    #[test]
    fn block_recovery_matches_the_step_by_step_recursion() {
        // The block scan is only an evaluation order of the recursion, so it
        // must agree with it wherever the dips fall against the block edges,
        // including dips inside a recovery, runs shorter than a block and a
        // tail that is not a whole block.
        fn step_by_step(gain: &mut [f32], rate: f32, backward: bool) {
            let mut deficit = 0.0f32;
            let mut each = |g: &mut f32| {
                let risen = deficit * (1.0 - rate);
                deficit = if risen < LIMIT_SNAP { 0.0 } else { risen };
                deficit = deficit.max(1.0 - *g);
                *g = 1.0 - deficit;
            };
            if backward {
                gain.iter_mut().rev().for_each(&mut each);
            } else {
                gain.iter_mut().for_each(&mut each);
            }
        }
        let mut gain = vec![1.0f32; 3 * 1000 + 5];
        for (at, g) in [
            (0, 0.5),
            (3, 0.9),
            (7, 0.2),
            (8, 0.95),
            (40, 0.3),
            (41, 0.1),
        ] {
            gain[at] = g;
        }
        for at in (100..gain.len()).step_by(97) {
            gain[at] = 0.4 + (at % 7) as f32 * 0.08;
        }
        *gain.last_mut().unwrap() = 0.6;
        for rate in [0.01, 0.3] {
            let mut expected = gain.clone();
            step_by_step(&mut expected, rate, false);
            step_by_step(&mut expected, rate, true);
            let mut actual = gain.clone();
            recover::<false>(&mut actual, rate);
            recover::<true>(&mut actual, rate);
            for (i, (&a, &e)) in actual.iter().zip(&expected).enumerate() {
                // One epsilon: the need goes through `1 - (1 - g)`, and the
                // final clamp of `limit` absorbs that rounding.
                assert!(
                    a <= gain[i] + f32::EPSILON,
                    "sample {i}: gain {a} above its need {}",
                    gain[i]
                );
                assert!((a - e).abs() <= 1e-5, "sample {i}: {a}, step by step {e}");
                assert_eq!(
                    a.to_bits() == 1.0_f32.to_bits(),
                    e.to_bits() == 1.0_f32.to_bits(),
                    "sample {i}: {a}, step by step {e}"
                );
            }
        }
    }

    #[test]
    fn the_noise_floor_between_sentences_is_not_boosted() {
        // A -60 dBFS hum in the pauses. Lifting it with the speech would turn
        // every pause into audible hiss.
        let floor = |seconds: f32| sine(100.0, -60.0, seconds);
        let (input, bursts) = two_bursts(-32.0, -32.0, &floor);
        // The middle of the pause: far enough from both bursts that the
        // envelope window holds nothing but the floor.
        let pause = bursts[0].end + samples(0.25)..bursts[1].start - samples(0.25);
        let before = rms_db(&input[pause.clone()]);
        let mut reply = audio(input);
        process(&mut reply, DEFAULT);
        let after = rms_db(&reply.samples[pause]);
        assert!(
            (after - before).abs() < 0.1,
            "floor moved from {before} to {after} dBFS"
        );
    }

    #[test]
    fn levelling_off_is_a_pure_gain() {
        // With levelling at 0 the user asked for a volume knob and nothing
        // else: the 8 dB between the two bursts must survive, sample by sample.
        let (input, bursts) = two_bursts(-32.0, -40.0, &zeros);
        let mut reply = audio(input.clone());
        process(
            &mut reply,
            Loudness {
                volume_db: -18.0,
                levelling: 0.0,
            },
        );
        let gain = reply.samples[bursts[0].start + 100] / input[bursts[0].start + 100];
        assert!(gain > 1.0, "the quiet reply was not lifted: gain {gain}");
        for burst in bursts.clone() {
            for i in burst.filter(|&i| input[i].abs() > 1e-3) {
                let g = reply.samples[i] / input[i];
                assert!(
                    (g - gain).abs() <= gain * 1e-4,
                    "gain {g} at sample {i}, expected {gain}"
                );
            }
        }
        assert!(
            (rms_db(&input[bursts[0].clone()]) - rms_db(&input[bursts[1].clone()]) - 8.0).abs()
                < 0.01
        );
    }

    // Instrumentation changes the work being timed; this check is for normal builds.
    #[cfg(not(coverage))]
    #[test]
    fn processing_time_grows_linearly_with_reply_length() {
        // The stage runs between synthesis and playback, so its time is heard
        // as delay before the reply starts. A full-scale click in every
        // sentence, so the limiter does real work rather than skipping.
        // Wall-clock budgets fail on a loaded host; the ratio of the best of
        // several runs at two lengths does not: ~10x for linear work, ~100x
        // for quadratic.
        let reply = |seconds: f32| {
            let mut input = Vec::new();
            while input.len() < samples(seconds) {
                let mut sentence = sine(220.0, -30.0, 2.0);
                sentence[samples(1.0)..samples(1.0) + 24].fill(0.99);
                input.extend(sentence);
                input.extend(zeros(0.5));
            }
            input.truncate(samples(seconds));
            input
        };
        let best_of_five = |input: Vec<f32>| {
            (0..5)
                .map(|_| {
                    let mut reply = audio(input.clone());
                    let started = Instant::now();
                    process(&mut reply, DEFAULT);
                    started.elapsed()
                })
                .min()
                .unwrap()
        };
        let short = best_of_five(reply(3.0));
        let long = best_of_five(reply(30.0));
        eprintln!("loudness: 3 s took {short:?}, 30 s took {long:?}");
        assert!(
            long < short * 40,
            "30 s took {long:?} against {short:?} for 3 s: not linear"
        );
    }

    #[test]
    fn empty_and_silent_audio_are_unchanged() {
        for input in [Vec::new(), zeros(1.0)] {
            let mut reply = audio(input.clone());
            process(&mut reply, DEFAULT);
            assert_eq!(reply, audio(input));
        }
        let mut zero_rate = SpeechAudio {
            samples: sine(440.0, -32.0, 0.1),
            sample_rate: 0,
        };
        let before = zero_rate.clone();
        process(&mut zero_rate, DEFAULT);
        assert_eq!(
            zero_rate, before,
            "a zero rate gives the envelope no time base"
        );
    }
}
