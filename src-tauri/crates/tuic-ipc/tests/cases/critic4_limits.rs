use std::io::ErrorKind;
use tuic_ipc::http::ResponseDecoder;

const CAP: usize = 64 * 1024;

/// Header section of exactly `total` bytes including the CRLFCRLF terminator.
fn section(status_line: &str, total: usize) -> Vec<u8> {
    let mut s = format!("{status_line}\r\nX-Pad: ").into_bytes();
    let tail = b"\r\n\r\n";
    assert!(s.len() + tail.len() <= total);
    s.resize(total - tail.len(), b'a');
    s.extend_from_slice(tail);
    assert_eq!(s.len(), total);
    s
}

fn interim() -> &'static [u8] {
    b"HTTP/1.1 102 Processing\r\n\r\n"
}

// Catches: an interim split byte-by-byte is counted more than once or the counter is bumped on
// an incomplete section.
#[test]
fn byte_split_interims_count_once_each() {
    let mut d = ResponseDecoder::default();
    for _ in 0..32 {
        for b in interim() {
            d.push(&[*b]);
            assert!(d.response(false).unwrap().is_none());
        }
    }
    d.push(b"HTTP/1.1 204 No Content\r\n\r\n");
    assert_eq!(d.response(false).unwrap().unwrap().status, 204);
}

// Catches: 101 (a final response) is counted against / rejected by the interim budget.
#[test]
fn switching_protocols_after_32_interims_is_final_not_interim() {
    let mut d = ResponseDecoder::default();
    for _ in 0..32 {
        d.push(interim());
    }
    d.push(b"HTTP/1.1 101 Switching Protocols\r\n\r\n");
    assert_eq!(d.response(false).unwrap().unwrap().status, 101);
}

// Catches: terminator straddling the cap boundary is accepted (cap excludes terminator).
#[test]
fn header_one_byte_over_cap_is_rejected() {
    let mut d = ResponseDecoder::default();
    d.push(&section("HTTP/1.1 200 OK", CAP + 1));
    let e = d.response(false).unwrap_err();
    assert_eq!(e.kind(), ErrorKind::InvalidData);
}

// Catches: every terminator offset around the boundary classified wrongly.
#[test]
fn terminator_offsets_around_cap() {
    for total in [CAP - 1, CAP, CAP + 1, CAP + 2, CAP + 3, CAP + 4] {
        let mut d = ResponseDecoder::default();
        d.push(&section("HTTP/1.1 200 OK", total));
        let r = d.response(true);
        if total <= CAP {
            assert_eq!(r.unwrap().unwrap().status, 200, "total {total}");
        } else {
            assert_eq!(
                r.unwrap_err().kind(),
                ErrorKind::InvalidData,
                "total {total}"
            );
        }
    }
}

// Catches: a header split over 4096-byte reads (real client read size) is rejected early or
// accepted late; the cap works across reads.
#[test]
fn header_split_across_reads_cap_boundaries() {
    for (total, ok) in [(CAP, true), (CAP + 1, false)] {
        let w = section("HTTP/1.1 200 OK", total);
        let mut d = ResponseDecoder::default();
        let mut result = None;
        for chunk in w.chunks(4096) {
            d.push(chunk);
            match d.response(false) {
                Ok(None) => {}
                other => {
                    result = Some(other);
                    break;
                }
            }
        }
        if ok {
            // body-by-eof response: still pending until eof, never an error
            assert!(result.is_none() || result.unwrap().is_ok());
            assert_eq!(d.response(true).unwrap().unwrap().status, 200);
        } else {
            assert_eq!(result.unwrap().unwrap_err().kind(), ErrorKind::InvalidData);
        }
    }
}

// Catches: body bytes counted as header for chunked bodies, including pending partial chunks
// with a buffer past the cap.
#[test]
fn chunked_body_larger_than_cap_is_accepted() {
    let n = CAP * 2;
    let mut w = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
    w.extend_from_slice(format!("{n:x}\r\n").as_bytes());
    w.extend(std::iter::repeat_n(b'x', n));
    w.extend_from_slice(b"\r\n0\r\n\r\n");
    let mut d = ResponseDecoder::default();
    for chunk in w.chunks(4096) {
        d.push(chunk);
        let _ = d.response(false).unwrap();
    }
    assert_eq!(d.response(false).unwrap().unwrap().body.len(), n);
}

// Catches: cap applied to the whole buffer rather than per section (interim + final each at cap).
#[test]
fn cap_is_per_section_not_per_buffer() {
    let mut d = ResponseDecoder::default();
    d.push(&section("HTTP/1.1 102 Processing", CAP));
    d.push(&section("HTTP/1.1 200 OK", CAP));
    d.push(b"");
    let r = d.response(true).unwrap().unwrap();
    assert_eq!(r.status, 200);
}

// Catches: interim section over the cap is skipped instead of rejected.
#[test]
fn oversized_interim_section_is_rejected() {
    let mut d = ResponseDecoder::default();
    d.push(&section("HTTP/1.1 102 Processing", CAP + 1));
    d.push(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    assert_eq!(
        d.response(false).unwrap_err().kind(),
        ErrorKind::InvalidData
    );
}

// Catches: final headers that follow an interim in the same buffer, where the remaining bytes
// (after drain) exceed the cap, are mis-measured.
#[test]
fn small_final_headers_after_interim_with_huge_trailing_buffer() {
    let mut d = ResponseDecoder::default();
    d.push(interim());
    let mut w = b"HTTP/1.1 200 OK\r\nContent-Length: 200000\r\n\r\n".to_vec();
    w.extend(std::iter::repeat_n(b'x', 200000));
    d.push(&w);
    assert_eq!(d.response(false).unwrap().unwrap().body.len(), 200000);
}

// Catches: EOF variant/message wrong. Empty and short buffers and exhausted interims are
// UnexpectedEof; an over-cap unterminated buffer is InvalidData even at EOF.
#[test]
fn eof_error_variants() {
    let mut d = ResponseDecoder::default();
    let e = d.response(true).unwrap_err();
    assert_eq!(e.kind(), ErrorKind::UnexpectedEof);

    let mut d = ResponseDecoder::default();
    d.push(b"HTTP/1.1 200 OK\r\nX: y");
    assert_eq!(
        d.response(true).unwrap_err().kind(),
        ErrorKind::UnexpectedEof
    );

    let mut d = ResponseDecoder::default();
    for _ in 0..32 {
        d.push(interim());
    }
    assert_eq!(
        d.response(true).unwrap_err().kind(),
        ErrorKind::UnexpectedEof
    );

    let mut d = ResponseDecoder::default();
    let mut w = b"HTTP/1.1 200 OK\r\nX: ".to_vec();
    w.resize(CAP, b'a');
    d.push(&w);
    assert_eq!(d.response(true).unwrap_err().kind(), ErrorKind::InvalidData);
}

// Catches: each decoder carries its own budget (a Default decoder is fresh).
#[test]
fn fresh_decoder_has_full_budget() {
    for _ in 0..2 {
        let mut d = ResponseDecoder::default();
        for _ in 0..32 {
            d.push(interim());
        }
        d.push(b"HTTP/1.1 204 No Content\r\n\r\n");
        assert_eq!(d.response(false).unwrap().unwrap().status, 204);
    }
}
