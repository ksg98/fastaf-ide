//! Compressing the terminal stream over a link that has one.
//!
//! Every HTTP response this daemon sends is already compressed above 860 bytes
//! by `CompressionLayer`. That layer is an HTTP layer and never sees a
//! WebSocket frame, and the WebSocket is the traffic that matters: an agent
//! repainting a full screen sends the grid many times a second. Negotiated
//! WebSocket compression is not available to this stack — tungstenite 0.30,
//! behind both `axum::extract::ws` and the tunnel's client, has no
//! permessage-deflate — so the frames are compressed here, by us.
//!
//! Three decisions, each with a reason that outlives the code:
//!
//! - **The encoding is named per frame, not assumed.** Every frame on a
//!   negotiated socket carries a one-byte tag saying what it is. A frame that
//!   does not shrink is sent as it was, tagged identity, so compression can
//!   never make a frame larger than the byte it costs to describe it.
//! - **A socket that did not ask is untouched.** The tag exists only after
//!   `?compress=deflate` on the upgrade. A client written against the old
//!   framing keeps working, byte for byte, and there is nothing to negotiate
//!   badly.
//! - **The answer is on the handshake, not inferred from the question.** A
//!   server that tags its frames selects the [`DEFLATE_SUBPROTOCOL`], which RFC
//!   6455 lets it do only for a subprotocol the client offered. A client that
//!   asked and reads no subprotocol back is talking to a server that never heard
//!   of the query parameter, and reads the old framing — rather than stripping a
//!   tag byte that is really the first byte of a grid row.
//! - **A local peer never pays.** A desktop terminal on the same machine has no
//!   link to save, so a loopback socket is refused compression even if it asks.
//!   The refusal is visible rather than silent: the frames are still tagged, and
//!   every tag says identity.
//!
//! **Stateless, deliberately.** Each frame is an independent raw-deflate block
//! rather than a shared window carried across frames the way RFC 7692 does with
//! context takeover. The measurement is in `context_takeover_is_not_worth_its_state`
//! and it is the reason this module has no `Compress` living between calls: a
//! retained window buys a further reduction that a stateless block already
//! makes small in absolute terms, and it buys it with a stream that a single
//! mis-ordered or dropped frame corrupts for good. The browser decodes a
//! stateless block with one `DecompressionStream("deflate-raw")` per frame and
//! nothing to keep in sync.

use axum::extract::ws::{Message, WebSocket};
use flate2::{Compress, Compression, FlushCompress, Status};
use futures_util::stream::SplitSink;
use std::net::SocketAddr;

/// What a frame on a negotiated socket is.
///
/// The low bit is the encoding and the next bit is whether the payload is text,
/// but that is an implementation detail of the numbers — the wire contract is
/// the four values, and a reader that does not recognise one must close rather
/// than guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(super) enum FrameTag {
    /// Binary payload, as it was.
    Binary = 0x00,
    /// Binary payload, raw deflate.
    BinaryDeflate = 0x01,
    /// UTF-8 payload, as it was.
    Text = 0x02,
    /// UTF-8 payload, raw deflate.
    TextDeflate = 0x03,
}

/// The subprotocol a tagging server selects, and the client's only proof that
/// its request was heard.
///
/// Must match `wsFrameCodec.ts`'s `DEFLATE_SUBPROTOCOL`. The name is ours rather
/// than `permessage-deflate`: that one names RFC 7692, which this stack does not
/// implement and a proxy could reasonably act on.
pub(super) const DEFLATE_SUBPROTOCOL: &str = "tuic.deflate";

/// How hard to try: deflate's default, level 6.
///
/// Measured in `level_six_is_the_knee_of_the_curve` over 957 real grid frames.
/// Level 6 sends 24% fewer bytes than level 1 for 2 µs more per frame, which is
/// four orders of magnitude under the 16 ms grid tick and so not a latency
/// trade at all. Level 9 sends 6% fewer bytes than level 6 for **six times** the
/// CPU, which is.
const LEVEL: Compression = Compression::new(6);

/// Below this, the tag byte is a bigger share of the frame than deflate can win
/// back. Matches `CompressionLayer`'s own threshold for HTTP bodies, so the two
/// halves of one connection do not disagree about what is worth compressing.
const MIN_COMPRESSED_SIZE: usize = 860;

/// Whether this socket compresses, and whether it may.
///
/// Constructed once per upgrade and then only read, so the loopback decision
/// cannot drift frame to frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WsCompression {
    /// The client did not ask. Frames go out in the original untagged framing.
    Off,
    /// The client asked and the link is worth it.
    Deflate,
    /// The client asked and the peer is on this machine. Frames are tagged —
    /// the client asked for the tagged framing and gets it — and every tag says
    /// identity.
    LoopbackIdentity,
}

impl WsCompression {
    /// Decide once, from what the client asked for and where it is.
    ///
    /// Takes the peer address rather than a `bool` so the upgrade handler has
    /// no classification left to get wrong: every caller passes the address it
    /// already extracted, and which addresses count as local is decided and
    /// tested here.
    pub(super) fn negotiate(requested: Option<&str>, peer: &SocketAddr) -> Self {
        match requested {
            // Only one encoding is offered. An unknown value is not an error:
            // the client asked for something this server does not have, and the
            // honest answer is the framing it did not ask for rather than a
            // closed socket.
            // `to_canonical` first: an IPv4 client reaching the dual-stack `[::]`
            // listener is presented as `::ffff:127.0.0.1`, which is not
            // `is_loopback` in its own right. Reading that as remote deflates
            // every frame of a tunnelled session whose ssh channel already
            // compressed it — the exact double cost this arm exists to avoid.
            Some("deflate") if peer.ip().to_canonical().is_loopback() => Self::LoopbackIdentity,
            Some("deflate") => Self::Deflate,
            _ => Self::Off,
        }
    }

    /// Whether frames on this socket carry a tag byte.
    pub(super) fn is_tagged(self) -> bool {
        !matches!(self, Self::Off)
    }
}

/// The send half of a stream WebSocket, with the socket's encoding attached.
///
/// Every frame this socket sends goes through here, so compression is a
/// property of the socket rather than something each `send` call has to
/// remember. That is the point: the three handlers in `session.rs` have
/// seventeen send sites between them, and one of them forgetting would produce
/// a frame the client cannot parse rather than a frame that is merely large.
pub(super) struct WsFrameSender {
    sink: SplitSink<WebSocket, Message>,
    mode: WsCompression,
}

impl WsFrameSender {
    pub(super) fn new(sink: SplitSink<WebSocket, Message>, mode: WsCompression) -> Self {
        Self { sink, mode }
    }

    /// Send one text frame — every JSON payload on every one of these sockets.
    pub(super) async fn text(&mut self, payload: &str) -> Result<(), axum::Error> {
        match encode_text(self.mode, payload) {
            Some(tagged) => self.send(Message::Binary(tagged.into())).await,
            None => self.send(Message::Text(payload.to_string().into())).await,
        }
    }

    /// Send one binary frame — a grid frame, on the grid socket.
    pub(super) async fn binary(&mut self, payload: Vec<u8>) -> Result<(), axum::Error> {
        match encode_binary(self.mode, &payload) {
            Some(tagged) => self.send(Message::Binary(tagged.into())).await,
            None => self.send(Message::Binary(payload.into())).await,
        }
    }

    /// Close the socket. Never tagged: a close is the WebSocket's own frame,
    /// not one of ours, and a client that cannot yet decode our tags still has
    /// to be able to see the socket go away.
    pub(super) async fn close(&mut self) -> Result<(), axum::Error> {
        self.send(Message::Close(None)).await
    }

    async fn send(&mut self, message: Message) -> Result<(), axum::Error> {
        futures_util::SinkExt::send(&mut self.sink, message).await
    }
}

/// Wrap one binary frame for a negotiated socket.
///
/// `None` when the socket is not negotiated: the caller sends what it already
/// had, which is what keeps an untouched client untouched.
fn encode_binary(mode: WsCompression, payload: &[u8]) -> Option<Vec<u8>> {
    encode(mode, payload, FrameTag::Binary, FrameTag::BinaryDeflate)
}

/// Wrap one text frame for a negotiated socket.
///
/// A negotiated socket carries text as a tagged **binary** message: deflate
/// output is not UTF-8, and a frame whose type changed with its size would be
/// two shapes for one thing. The tag says it is text, so the client decodes it
/// back to a string either way.
fn encode_text(mode: WsCompression, payload: &str) -> Option<Vec<u8>> {
    encode(
        mode,
        payload.as_bytes(),
        FrameTag::Text,
        FrameTag::TextDeflate,
    )
}

fn encode(
    mode: WsCompression,
    payload: &[u8],
    plain: FrameTag,
    compressed: FrameTag,
) -> Option<Vec<u8>> {
    if !mode.is_tagged() {
        return None;
    }
    if mode == WsCompression::Deflate
        && let Some(deflated) = worth_deflating(payload, LEVEL)
    {
        return Some(tagged(compressed, &deflated));
    }
    Some(tagged(plain, payload))
}

/// The deflated frame, but only when sending it is an improvement.
///
/// The tag byte is on both sides of the comparison, so it cancels — which is
/// the point: a frame that deflates to exactly its own length would otherwise
/// go out one byte larger for nothing.
fn worth_deflating(payload: &[u8], level: Compression) -> Option<Vec<u8>> {
    if payload.len() < MIN_COMPRESSED_SIZE {
        return None;
    }
    deflate(payload, level).filter(|deflated| deflated.len() < payload.len())
}

fn tagged(tag: FrameTag, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 1);
    out.push(tag as u8);
    out.extend_from_slice(payload);
    out
}

/// One raw-deflate block, or `None` if the compressor could not finish it.
///
/// `None` is not an error anyone needs told about: the caller sends the frame
/// as it was, which is a correct frame. Propagating it would turn a missed
/// saving into a dropped screen repaint.
///
/// Takes the level rather than reading `LEVEL` so the measurement below can
/// sweep it through the same code production runs.
fn deflate(payload: &[u8], level: Compression) -> Option<Vec<u8>> {
    let mut compress = Compress::new(level, false);
    // The bound deflate itself guarantees for incompressible input, so a frame
    // of random bytes cannot make this reallocate mid-stream.
    let mut out = Vec::with_capacity(payload.len() + payload.len() / 1000 + 64);
    match compress.compress_vec(payload, &mut out, FlushCompress::Finish) {
        Ok(Status::StreamEnd) => Some(out),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Something a deflate window can actually work on, the way a terminal row
    /// full of one style is.
    fn compressible(len: usize) -> Vec<u8> {
        b"the same row, again and again, and again "
            .iter()
            .copied()
            .cycle()
            .take(len)
            .collect()
    }

    /// Bytes with no structure to find. A counter through a bad hash is enough:
    /// deflate has nothing to say about it, and the test does not depend on a
    /// random seed.
    fn incompressible(len: usize) -> Vec<u8> {
        let mut state: u64 = 0x2545_F491_4F6C_DD1D;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect()
    }

    fn tag_of(frame: &[u8]) -> u8 {
        frame[0]
    }

    /// A browser on this machine, or a client arriving through the SSH tunnel —
    /// the tunnel's local ssh process is what connects, so both look like this.
    fn local() -> SocketAddr {
        "127.0.0.1:51234".parse().expect("a literal address")
    }

    /// A Tailscale peer: a real link, and the case this module exists for.
    fn remote() -> SocketAddr {
        "100.64.1.42:51234".parse().expect("a literal address")
    }

    #[test]
    fn a_socket_that_did_not_ask_is_left_alone() {
        let mode = WsCompression::negotiate(None, &remote());
        // Not "an identity frame": a client written against the old framing has
        // no tag byte to strip, so the only safe answer is to change nothing.
        assert_eq!(encode_binary(mode, &compressible(4096)), None);
        assert_eq!(encode_text(mode, "hello"), None);
    }

    #[test]
    fn an_unknown_encoding_is_answered_with_the_old_framing() {
        // The client asked for something this server does not have. Closing the
        // socket would be a worse answer than the stream it can still read.
        assert_eq!(
            WsCompression::negotiate(Some("brotli"), &remote()),
            WsCompression::Off
        );
        assert_eq!(
            WsCompression::negotiate(Some(""), &remote()),
            WsCompression::Off
        );
    }

    /// Which addresses are local, spelled out. The IPv6 row is the one that
    /// matters: a browser on `localhost` reaches this server over `::1` as
    /// often as over `127.0.0.1`, and treating that as remote would deflate
    /// every frame of every local session for a link that is not there.
    ///
    /// `::ffff:127.0.0.1` is the same row a third time: the listener binds
    /// `[::]`, so an IPv4 peer — the tunnel's own ssh process included — arrives
    /// wearing an IPv4-mapped IPv6 address that `Ipv6Addr::is_loopback` says
    /// nothing about.
    #[test]
    fn a_peer_is_local_or_it_is_not() {
        for local in [
            "127.0.0.1:1",
            "127.9.9.9:1",
            "[::1]:1",
            "[::ffff:127.0.0.1]:1",
        ] {
            let peer = local.parse().expect("a literal address");
            assert_eq!(
                WsCompression::negotiate(Some("deflate"), &peer),
                WsCompression::LoopbackIdentity,
                "{local} is on this machine"
            );
        }
        for far in [
            "100.64.1.42:1",
            "192.168.1.5:1",
            "[fd7a:115c::1]:1",
            "[::ffff:100.64.1.42]:1",
        ] {
            let peer = far.parse().expect("a literal address");
            assert_eq!(
                WsCompression::negotiate(Some("deflate"), &peer),
                WsCompression::Deflate,
                "{far} is across a link"
            );
        }
    }

    #[test]
    fn a_local_peer_pays_no_cpu_for_a_link_it_does_not_have() {
        let mode = WsCompression::negotiate(Some("deflate"), &local());
        assert_eq!(mode, WsCompression::LoopbackIdentity);

        let payload = compressible(64 * 1024);
        let frame = encode_binary(mode, &payload).expect("a socket that asked is tagged");

        // Tagged, because the client asked for the tagged framing and must be
        // able to read the answer — but never deflated.
        assert_eq!(tag_of(&frame), FrameTag::Binary as u8);
        assert_eq!(&frame[1..], &payload[..]);

        // The text half of the same promise. A JSON payload large enough to
        // deflate still goes out as it was, and the bytes after the tag are the
        // string — so the client's `TextDecoder` over `frame[1..]` reads it back
        // without an inflate step that would have nothing to do.
        let text = String::from_utf8(compressible(64 * 1024)).expect("ascii");
        let frame = encode_text(mode, &text).expect("a socket that asked is tagged");
        assert_eq!(tag_of(&frame), FrameTag::Text as u8);
        assert_eq!(&frame[1..], text.as_bytes());
    }

    #[test]
    fn a_remote_peer_gets_a_frame_that_names_its_encoding() {
        let mode = WsCompression::negotiate(Some("deflate"), &remote());
        let payload = compressible(64 * 1024);

        let frame = encode_binary(mode, &payload).expect("negotiated");

        assert_eq!(tag_of(&frame), FrameTag::BinaryDeflate as u8);
        assert!(
            frame.len() < payload.len() / 4,
            "a screen of repeated rows must compress hard: {} from {}",
            frame.len(),
            payload.len()
        );
    }

    #[test]
    fn a_frame_that_does_not_shrink_is_sent_as_it_is() {
        let mode = WsCompression::negotiate(Some("deflate"), &remote());
        let payload = incompressible(16 * 1024);

        let frame = encode_binary(mode, &payload).expect("negotiated");

        // Deflate adds a header and a stored-block wrapper to input it cannot
        // model. Sending that would spend CPU to make the frame bigger.
        assert_eq!(tag_of(&frame), FrameTag::Binary as u8);
        assert_eq!(&frame[1..], &payload[..]);
        assert_eq!(frame.len(), payload.len() + 1);
    }

    #[test]
    fn a_small_frame_is_not_worth_the_attempt() {
        let mode = WsCompression::negotiate(Some("deflate"), &remote());
        let payload = compressible(MIN_COMPRESSED_SIZE - 1);

        let frame = encode_binary(mode, &payload).expect("negotiated");

        assert_eq!(tag_of(&frame), FrameTag::Binary as u8);
    }

    #[test]
    fn text_keeps_its_kind_through_both_encodings() {
        let mode = WsCompression::negotiate(Some("deflate"), &remote());

        let small = encode_text(mode, "{\"type\":\"exit\"}").expect("negotiated");
        assert_eq!(tag_of(&small), FrameTag::Text as u8);
        assert_eq!(&small[1..], b"{\"type\":\"exit\"}");

        let big = String::from_utf8(compressible(64 * 1024)).expect("ascii");
        let large = encode_text(mode, &big).expect("negotiated");
        // A client reading this must still end up with a string, so the tag has
        // to survive compression rather than being inferred from the WS opcode.
        assert_eq!(tag_of(&large), FrameTag::TextDeflate as u8);
    }

    /// Inflate one deflated frame the way the browser does: over `frame[1..]`,
    /// as a raw deflate block with no zlib wrapper.
    fn inflated(frame: &[u8]) -> Vec<u8> {
        use flate2::read::DeflateDecoder;
        use std::io::Read;

        let mut out = Vec::new();
        DeflateDecoder::new(&frame[1..])
            .read_to_end(&mut out)
            .expect("a raw deflate block the browser's DecompressionStream also reads");
        out
    }

    /// Both deflating tags, because they are two encoders as far as a reader is
    /// concerned: `TextDeflate` is the one whose output has to survive being
    /// turned back into a `String`, and asserting only on bytes would not say
    /// that it does.
    #[test]
    fn what_comes_out_is_what_went_in() {
        let mode = WsCompression::negotiate(Some("deflate"), &remote());

        let payload = compressible(64 * 1024);
        let frame = encode_binary(mode, &payload).expect("negotiated");
        assert_eq!(tag_of(&frame), FrameTag::BinaryDeflate as u8);
        assert_eq!(inflated(&frame), payload);

        let text = String::from_utf8(compressible(64 * 1024)).expect("ascii");
        let frame = encode_text(mode, &text).expect("negotiated");
        assert_eq!(tag_of(&frame), FrameTag::TextDeflate as u8);
        assert_eq!(
            String::from_utf8(inflated(&frame)).expect("text survives its encoding"),
            text
        );
    }
}

/// The numbers behind the two choices this module makes, taken on a real
/// session rather than on a synthetic buffer.
///
/// Story 794-832e asks for the choice between compressing our own frames and
/// replacing the WebSocket implementation to be made on measured bytes and
/// measured latency. Replacing it means `yawc` — the only Rust WebSocket crate
/// with RFC 7692 and an axum extractor — and RFC 7692 with context takeover is
/// exactly a deflate stream with a sync flush per message, so the alternative
/// can be measured without adopting it.
#[cfg(test)]
mod measurement {
    use super::*;
    use crate::pty_capture::{CaptureDirection, decode_capture};
    use crate::terminal_grid::TerminalGrid;
    use std::time::{Duration, Instant};

    /// A real agent session: codex painting a background terminal, 150 KB of
    /// output. Committed, so the measurement is reproducible by anyone reading
    /// the story rather than only on the machine that first ran it.
    const CAPTURE: &[u8] = include_bytes!(
        "../fixtures/agent_prompts/codex-0.154-background-terminal-false-ready.tcap"
    );

    /// The grid ticker's period, the same constant `terminal_grid`'s own replay
    /// helper uses. Frames are taken on this boundary so the replay batches the
    /// same chunks into the same frame a live session would; sampling per chunk
    /// would split one repaint across several frames and measure a workload that
    /// never happens.
    const TICK_US: u64 = 16_000;

    /// The geometry the capture was taken at. It carries none of its own — it
    /// predates TUICCAP2 — so the number comes from the fixture's other reader,
    /// `pty::tests::codex_0154_false_ready_real_captures_stay_protocol_busy`.
    /// Guessing it would change how many rows every frame holds and so every
    /// byte count below.
    const GEOMETRY: (u16, u16) = (63, 160);

    /// Fast, default, and as hard as deflate goes.
    const LEVELS: [Compression; 3] = [
        Compression::new(1),
        Compression::new(6),
        Compression::new(9),
    ];

    /// What a socket would actually send for one session.
    struct Frames {
        /// Every dirty-row frame, in order, as `serialize_dirty_rows` produced it.
        dirty: Vec<Vec<u8>>,
        /// One full-screen repaint — what a resync sends, and the frame whose
        /// added latency the story asks about.
        full: Vec<u8>,
    }

    fn replay() -> Frames {
        let capture = decode_capture(CAPTURE).expect("a decodable committed fixture");
        let (rows, cols) = capture.geometry.unwrap_or(GEOMETRY);
        let mut grid = TerminalGrid::new(rows, cols, 10_000);
        let mut dirty = Vec::new();
        let mut tick = 0u64;

        for rec in capture.records {
            if rec.direction != CaptureDirection::Output {
                continue;
            }
            grid.process(&rec.data);
            if rec.elapsed_us / TICK_US > tick {
                tick = rec.elapsed_us / TICK_US;
                let frame = grid.serialize_dirty_rows();
                if !frame.is_empty() {
                    dirty.push(frame);
                }
            }
        }
        let frame = grid.serialize_dirty_rows();
        if !frame.is_empty() {
            dirty.push(frame);
        }

        Frames {
            full: grid.serialize_full_frame(),
            dirty,
        }
    }

    /// One RFC 7692 message on a stream that keeps its window: deflate the
    /// payload into the shared compressor and sync-flush it.
    ///
    /// `compress_vec` writes into the vector's spare capacity and never grows
    /// it, so the reserve is part of the contract rather than an optimisation.
    fn sync_flush(compress: &mut Compress, input: &[u8], out: &mut Vec<u8>) {
        let mut consumed = 0usize;
        loop {
            out.reserve(input.len() / 2 + 1024);
            let before_in = compress.total_in();
            let before_out = compress.total_out();
            compress
                .compress_vec(&input[consumed..], out, FlushCompress::Sync)
                .expect("a sync flush into memory cannot fail");
            consumed += (compress.total_in() - before_in) as usize;
            if consumed == input.len() && compress.total_out() == before_out {
                return;
            }
        }
    }

    /// Bytes this strategy puts on the wire for a frame sequence, and the wall
    /// time it spent producing them.
    struct Cost {
        bytes: usize,
        time: Duration,
    }

    /// What this module does: an independent block per frame, identity when it
    /// does not shrink, plus the tag byte.
    fn stateless(frames: &[Vec<u8>], level: Compression) -> Cost {
        let started = Instant::now();
        let bytes = frames
            .iter()
            .map(|frame| match worth_deflating(frame, level) {
                Some(deflated) => deflated.len() + 1,
                None => frame.len() + 1,
            })
            .sum();
        Cost {
            bytes,
            time: started.elapsed(),
        }
    }

    /// What permessage-deflate with context takeover does: one window for the
    /// whole socket, a sync flush per message, no tag byte because the
    /// WebSocket's own RSV1 bit carries the encoding.
    fn context_takeover(frames: &[Vec<u8>]) -> Cost {
        let started = Instant::now();
        let mut compress = Compress::new(LEVEL, false);
        let mut bytes = 0usize;
        let mut out = Vec::new();
        for frame in frames {
            out.clear();
            sync_flush(&mut compress, frame, &mut out);
            bytes += out.len();
        }
        Cost {
            bytes,
            time: started.elapsed(),
        }
    }

    fn total(frames: &[Vec<u8>]) -> usize {
        frames.iter().map(Vec::len).sum()
    }

    fn percent_of(part: usize, whole: usize) -> f64 {
        100.0 * part as f64 / whole as f64
    }

    /// **Criterion 2, the bytes half.** Deterministic: deflate's output size for
    /// a given input and level does not vary by machine, so this is a plain test
    /// rather than a benchmark, and it fails if the trade-off it records ever
    /// stops holding.
    #[test]
    fn context_takeover_is_not_worth_its_state() {
        let frames = replay();
        let raw = total(&frames.dirty);
        let ours = stateless(&frames.dirty, LEVEL);
        let theirs = context_takeover(&frames.dirty);

        // `stateless` measures the rule rather than calling `encode_binary`, so
        // that the sweep below can vary the level. Prove the two agree, or the
        // numbers describe a server nobody is running.
        let through_the_encoder: usize = frames
            .dirty
            .iter()
            .map(|frame| {
                encode_binary(WsCompression::Deflate, frame)
                    .expect("a negotiated socket always produces a frame")
                    .len()
            })
            .sum();
        assert_eq!(through_the_encoder, ours.bytes);

        println!(
            "{} dirty frames, {} raw bytes\n  stateless (this module)  {:>8} bytes  {:>5.1}% of raw\n  context takeover (yawc)  {:>8} bytes  {:>5.1}% of raw\n  takeover buys a further   {:>7} bytes  {:>5.1}% of raw",
            frames.dirty.len(),
            raw,
            ours.bytes,
            percent_of(ours.bytes, raw),
            theirs.bytes,
            percent_of(theirs.bytes, raw),
            ours.bytes - theirs.bytes,
            percent_of(ours.bytes - theirs.bytes, raw),
        );

        // The decision, stated as an assertion so it cannot quietly stop being
        // true: a stateless block already takes the stream well below half, so
        // the link is no longer the bottleneck either way.
        assert!(
            ours.bytes * 2 < raw,
            "stateless deflate must at least halve the stream: {} from {raw}",
            ours.bytes
        );
        // And what the shared window adds on top is small enough that it does
        // not pay for a WebSocket implementation swap plus a stream where one
        // dropped frame corrupts every frame after it.
        assert!(
            ours.bytes - theirs.bytes < raw / 10,
            "context takeover buys {} more bytes of a {raw}-byte stream — if it ever exceeds a tenth, re-open the yawc question",
            ours.bytes - theirs.bytes
        );
    }

    /// **Criterion 2, the latency half**, and where `LEVEL` comes from.
    ///
    /// A benchmark: it reports wall time, so it is `#[ignore]`d and never
    /// asserts on a clock. Run it when the trade-off needs re-deciding:
    ///
    /// ```text
    /// cargo nextest run --lib -E 'test(level_six_is_the_knee_of_the_curve)' \
    ///   --run-ignored ignored-only --no-capture
    /// ```
    #[test]
    #[ignore = "benchmark: reports wall time, asserts nothing about it"]
    fn level_six_is_the_knee_of_the_curve() {
        let frames = replay();
        let raw = total(&frames.dirty);

        println!(
            "\nfull-screen repaint: {} raw bytes — the frame a resync sends",
            frames.full.len()
        );
        for level in LEVELS {
            // Best of many: the interesting number is the cost of the work, not
            // the cost of whatever else the machine was doing during one run.
            let mut best = Duration::MAX;
            let mut size = 0usize;
            for _ in 0..200 {
                let started = Instant::now();
                let deflated = deflate(&frames.full, level).expect("deflate into memory");
                best = best.min(started.elapsed());
                size = deflated.len();
            }
            println!(
                "  level {}: {size:>7} bytes ({:>5.2}% of raw), +{:>7.3} ms added latency",
                level.level(),
                percent_of(size, frames.full.len()),
                best.as_secs_f64() * 1000.0,
            );
        }

        println!("\n{} dirty frames, {raw} raw bytes", frames.dirty.len());
        for level in LEVELS {
            let cost = stateless(&frames.dirty, level);
            println!(
                "  stateless level {}: {:>8} bytes ({:>5.2}% of raw) in {:>7.3} ms",
                level.level(),
                cost.bytes,
                percent_of(cost.bytes, raw),
                cost.time.as_secs_f64() * 1000.0,
            );
        }
        let theirs = context_takeover(&frames.dirty);
        println!(
            "  context takeover:  {:>8} bytes ({:>5.2}% of raw) in {:>7.3} ms",
            theirs.bytes,
            percent_of(theirs.bytes, raw),
            theirs.time.as_secs_f64() * 1000.0,
        );
    }
}
