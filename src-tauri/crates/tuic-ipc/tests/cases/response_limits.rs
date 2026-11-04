use std::io::ErrorKind;
use tuic_ipc::http::ResponseDecoder;

const INTERIM: &[u8] = b"HTTP/1.1 103 Early Hints\r\n\r\n";
const FINAL: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";

// Catches: endless interim trickles resetting a per-read timeout or a per-call counter.
#[test]
fn interim_limit_persists_across_reads_and_repeated_polls() {
    let mut decoder = ResponseDecoder::default();
    for _ in 0..32 {
        decoder.push(INTERIM);
        assert!(decoder.response(false).unwrap().is_none());
        assert!(decoder.response(false).unwrap().is_none());
    }
    decoder.push(INTERIM);
    assert_eq!(
        decoder.response(false).unwrap_err().kind(),
        ErrorKind::InvalidData
    );
}

// Catches: off-by-one limits rejecting a final reply after exactly 32 interims.
#[test]
fn exactly_32_interims_allow_a_final_response_in_one_read_or_many() {
    for coalesced in [false, true] {
        let mut decoder = ResponseDecoder::default();
        for _ in 0..32 {
            decoder.push(INTERIM);
            if !coalesced {
                assert!(decoder.response(false).unwrap().is_none());
            }
        }
        decoder.push(FINAL);
        assert_eq!(decoder.response(false).unwrap().unwrap().status, 200);
    }
}

fn header(size: usize, complete: bool) -> Vec<u8> {
    let mut wire = b"HTTP/1.1 204 No Content\r\nX-Pad: ".to_vec();
    wire.resize(size - if complete { 4 } else { 0 }, b'a');
    if complete {
        wire.extend_from_slice(b"\r\n\r\n");
    }
    wire
}

// Catches: oversized headers accepted because the terminator is present, or absent forever.
#[test]
fn oversized_complete_and_unterminated_headers_are_invalid_data() {
    for complete in [false, true] {
        for interim_first in [false, true] {
            let mut decoder = ResponseDecoder::default();
            if interim_first {
                decoder.push(INTERIM);
            }
            decoder.push(&header(64 * 1024 + 1, complete));
            assert_eq!(
                decoder.response(false).unwrap_err().kind(),
                ErrorKind::InvalidData
            );
            assert_eq!(
                decoder.response(true).unwrap_err().kind(),
                ErrorKind::InvalidData
            );
        }
    }
}

// Catches: a trickled header accumulating beyond the cap without a terminating CRLF.
#[test]
fn incomplete_header_cannot_accumulate_past_64_kib() {
    let mut decoder = ResponseDecoder::default();
    decoder.push(&header(64 * 1024 - 1, false));
    assert!(decoder.response(false).unwrap().is_none());
    decoder.push(b"a");
    assert_eq!(
        decoder.response(false).unwrap_err().kind(),
        ErrorKind::InvalidData
    );
}

// Catches: counting body bytes toward the header cap or rejecting the exact valid boundary.
#[test]
fn header_limit_accepts_exact_boundary_and_does_not_limit_body_bytes() {
    let mut decoder = ResponseDecoder::default();
    decoder.push(&header(64 * 1024, true));
    assert_eq!(decoder.response(false).unwrap().unwrap().status, 204);

    let mut decoder = ResponseDecoder::default();
    let body = "b".repeat(64 * 1024 + 1);
    decoder.push(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
    assert_eq!(decoder.response(false).unwrap().unwrap().body, body);
}

// Catches: reporting absent final headers as a truncated Content-Length body.
#[test]
fn eof_without_final_headers_reports_incomplete_final_response() {
    let mut decoder = ResponseDecoder::default();
    decoder.push(INTERIM);
    let error = decoder.response(true).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::UnexpectedEof);
    assert_eq!(
        error.to_string(),
        "response ended before a complete final HTTP response"
    );
}
