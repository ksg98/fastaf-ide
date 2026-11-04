use std::io::ErrorKind;
use tuic_ipc::http::ResponseDecoder;

fn decode(wire: &[u8], eof: bool) -> std::io::Result<Option<tuic_ipc::http::Response>> {
    let mut decoder = ResponseDecoder::default();
    decoder.push(wire);
    decoder.response(eof)
}

// Catches: a 101 that follows an interim 100 is skipped like an interim (or its trailing
// upgraded-protocol bytes are read as a body) instead of ending HTTP parsing.
#[test]
fn switching_protocols_after_an_interim_is_final_and_bodyless() {
    let wire = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 101 Switching Protocols\r\nContent-Length: 50\r\nUpgrade: x\r\n\r\n\x00\x01raw upgraded bytes";
    let response = decode(wire, false).unwrap().expect("101 is final");
    assert_eq!(response.status, 101);
    assert_eq!(response.body, "");
    assert_eq!(response.header("upgrade"), Some("x"));
}

// Catches: bodyless finals (204/304) after an interim waiting for Content-Length/EOF.
#[test]
fn bodyless_final_after_interim_finishes_at_its_headers() {
    for status in [204, 304] {
        let wire = format!(
            "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 {status} X\r\nContent-Length: 77\r\n\r\n"
        );
        let response = decode(wire.as_bytes(), false)
            .unwrap()
            .expect("bodyless final");
        assert_eq!(response.status, status);
        assert_eq!(response.body, "");
    }
}

// Catches: EOF after only interim responses returning Ok/empty success or hanging.
#[test]
fn eof_with_only_interims_is_unexpected_eof() {
    for wire in [
        &b"HTTP/1.1 100 Continue\r\n\r\n"[..],
        b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early\r\n\r\n",
        b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 5\r\n",
        b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe",
        b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nab",
    ] {
        let error = decode(wire, true).expect_err("no complete final response");
        assert_eq!(error.kind(), ErrorKind::UnexpectedEof, "{wire:?}");
        // Not at EOF yet the same bytes must simply wait.
        assert!(decode(wire, false).unwrap().is_none(), "{wire:?}");
    }
}

// Catches: garbage following an interim being skipped silently or panicking.
#[test]
fn malformed_message_after_an_interim_is_invalid_data() {
    for wire in [
        &b"HTTP/1.1 100 Continue\r\n\r\ngarbage\r\n\r\n"[..],
        b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 abc OK\r\n\r\n",
        b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1\r\n\r\n",
        b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: nope\r\n\r\n",
    ] {
        let error = decode(wire, false).expect_err("malformed");
        assert_eq!(error.kind(), ErrorKind::InvalidData, "{wire:?}");
    }
}

// Catches: a malformed *interim* status line (non-numeric / missing) being treated as skippable.
#[test]
fn malformed_interim_status_is_rejected() {
    for wire in [
        &b"HTTP/1.1 1xx Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"[..],
        b"HTTP/1.1\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
        b"\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
    ] {
        let error = decode(wire, false).expect_err("malformed first message");
        assert_eq!(error.kind(), ErrorKind::InvalidData, "{wire:?}");
    }
}

// Catches: interim headers (Link, mcp-session-id) leaking into the final response's
// header list / raw_headers, which the bridge scans for mcp-session-id.
#[test]
fn final_response_does_not_inherit_interim_headers() {
    let wire = b"HTTP/1.1 103 Early Hints\r\nMcp-Session-Id: from-interim\r\nLink: </a>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx";
    let response = decode(wire, false).unwrap().unwrap();
    assert_eq!(response.header("mcp-session-id"), None);
    assert_eq!(response.header("link"), None);
    assert!(
        !response.raw_headers.contains("103"),
        "{}",
        response.raw_headers
    );
    assert!(!response.raw_headers.contains("from-interim"));
    assert!(response.raw_headers.starts_with("HTTP/1.1 200"));
}

// Catches: an interim's own framing headers (chunked / Content-Length) consuming
// or corrupting the final response that follows it.
#[test]
fn interim_framing_headers_do_not_consume_the_final_response() {
    let wire = b"HTTP/1.1 102 Processing\r\nTransfer-Encoding: chunked\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
    let response = decode(wire, false).unwrap().unwrap();
    assert_eq!((response.status, response.body.as_str()), (200, "ok"));
}

// Catches: split-point dependence: an interim + chunked final with trailers must decode
// identically wherever the two reads are cut, and must never complete early.
#[test]
fn interim_plus_chunked_final_is_independent_of_the_split_point() {
    let wire = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\nX-T: 1\r\n\r\n";
    for split in 0..=wire.len() {
        let mut decoder = ResponseDecoder::default();
        decoder.push(&wire[..split]);
        let first = decoder.response(false).unwrap();
        if split < wire.len() {
            assert!(first.is_none(), "split {split} completed early");
        }
        decoder.push(&wire[split..]);
        let response = decoder.response(false).unwrap().expect("complete");
        assert_eq!(response.body, "ok", "split {split}");
    }
}

// Catches: unbounded interim draining when a peer floods one read with progress replies.
#[test]
fn thousands_of_interims_in_one_read_then_final() {
    let mut wire = Vec::new();
    for index in 0..5000 {
        let status = [100, 102, 103][index % 3];
        wire.extend_from_slice(format!("HTTP/1.1 {status} I\r\n\r\n").as_bytes());
    }
    wire.extend_from_slice(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nz");
    assert_eq!(
        decode(&wire, false).unwrap_err().kind(),
        ErrorKind::InvalidData
    );
}

// Catches: the drain being skipped on re-polling (response() called repeatedly while
// the final is pending, then again once complete) and the result changing between calls.
#[test]
fn repeated_polling_is_stable_across_the_interim_drain() {
    let mut decoder = ResponseDecoder::default();
    decoder.push(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\na");
    for _ in 0..3 {
        assert!(decoder.response(false).unwrap().is_none());
    }
    decoder.push(b"bc");
    for _ in 0..3 {
        let response = decoder.response(false).unwrap().unwrap();
        assert_eq!((response.status, response.body.as_str()), (200, "abc"));
    }
}

// Catches: a final response without any length framing finishing early once an interim
// was skipped (it must wait for EOF, then take everything after the headers).
#[test]
fn unframed_final_after_interim_waits_for_eof() {
    let wire = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n\r\nbody";
    assert!(decode(wire, false).unwrap().is_none());
    assert_eq!(decode(wire, true).unwrap().unwrap().body, "body");
}

// Catches: the 1xx range boundaries (99 / 200) being classified as interim.
#[test]
fn only_100_to_199_except_101_is_interim() {
    for status in [100, 102, 150, 199] {
        let wire =
            format!("HTTP/1.1 {status} X\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        assert_eq!(decode(wire.as_bytes(), false).unwrap().unwrap().status, 200);
    }
    for status in [200, 201, 299, 300, 404, 500] {
        let wire = format!(
            "HTTP/1.1 {status} X\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
        );
        assert_eq!(
            decode(wire.as_bytes(), false).unwrap().unwrap().status,
            status
        );
    }
}
