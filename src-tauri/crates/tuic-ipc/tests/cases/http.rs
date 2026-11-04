use tuic_ipc::http::{ResponseDecoder, request};

// Catches: waiting for EOF, dropping case-sensitive session values, or splitting UTF-8 chunks.
#[test]
fn ipc_framing_preserves_response_boundaries_and_header_values() {
    for wire in [
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nMcp-Session-Id: AbC\r\n\r\n\xe2\x82\xac".as_slice(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nMcp-Session-Id: AbC\r\n\r\n1;x=1\r\n\xe2\r\n2\r\n\x82\xac\r\n0\r\n\r\n".as_slice(),
    ] {
        let mut decoder = ResponseDecoder::default();
        for (index, byte) in wire.iter().enumerate() {
            decoder.push(&[*byte]);
            let response = decoder.response(false).unwrap();
            if index + 1 < wire.len() {
                assert!(response.is_none());
            } else {
                let response = response.expect("declared body must finish without EOF");
                assert_eq!(response.body, "€");
                assert_eq!(response.header("MCP-SESSION-ID"), Some("AbC"));
                assert_eq!(response.status, 200);
            }
        }
    }
}

// Catches: silently accepting a truncated or malformed length-delimited response.
#[test]
fn ipc_framing_rejects_truncated_and_invalid_bodies() {
    for wire in [
        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nx".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Length: bad\r\n\r\nx".as_slice(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\nx".as_slice(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nxXX".as_slice(),
    ] {
        let mut decoder = ResponseDecoder::default();
        decoder.push(wire);
        assert!(decoder.response(true).is_err(), "{wire:?}");
    }
}

// Catches: emitting a character count instead of the UTF-8 byte length in MCP POSTs.
#[test]
fn ipc_post_counts_utf8_bytes_and_keeps_identity_headers() {
    assert_eq!(
        request("POST", "/mcp", Some("é"), &[("x-tuic-session", "peer")]),
        b"POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nx-tuic-session: peer\r\nConnection: close\r\n\r\n\xc3\xa9"
    );
}

// Catches: bodyless status framing is overridden by length/chunked headers or trailing bytes.
#[test]
fn ipc_bodyless_status_ignores_body_framing_and_trailing_bytes() {
    for status in [101, 204, 304] {
        for framing in [
            "",
            "Content-Length: 123\r\n",
            "Transfer-Encoding: chunked\r\n",
        ] {
            let wire = format!("HTTP/1.1 {status} No Body\r\n{framing}\r\n");
            let mut decoder = ResponseDecoder::default();
            decoder.push(&wire.as_bytes()[..wire.len() - 1]);
            assert!(
                decoder.response(false).unwrap().is_none(),
                "headers are incomplete"
            );
            decoder.push(&wire.as_bytes()[wire.len() - 1..]);
            let response = decoder
                .response(false)
                .unwrap()
                .expect("bodyless status ends at headers");
            assert_eq!(response.status, status);
            assert_eq!(response.body, "");
            decoder.push(b"not a body");
            assert_eq!(decoder.response(true).unwrap().unwrap().body, "");
        }
    }
}
