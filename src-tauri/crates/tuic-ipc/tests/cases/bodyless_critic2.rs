use tuic_ipc::http::ResponseDecoder;

// Catches: an interim 100 Continue is returned as the final response and the real
// reply that follows it is dropped (RFC 9112 6.3: 1xx other than 101 is interim).
#[test]
fn interim_100_continue_is_skipped_for_the_final_response() {
    let mut decoder = ResponseDecoder::default();
    decoder.push(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    let response = decoder
        .response(false)
        .unwrap()
        .expect("final response is complete");
    assert_eq!(response.status, 200);
    assert_eq!(response.body, "ok");
}

// Catches: final ordinary bodies being discarded after informational headers.
#[test]
fn interim_responses_preserve_fragmented_final_content_length_body() {
    for status in [100, 102, 103, 199] {
        let wire = format!(
            "HTTP/1.1 {status} Interim\r\nContent-Length: 999\r\n\r\nHTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-Final: Yes\r\n\r\nhello"
        );
        let mut decoder = ResponseDecoder::default();
        for (index, byte) in wire.bytes().enumerate() {
            decoder.push(&[byte]);
            let response = decoder.response(false).unwrap();
            if index + 1 < wire.len() {
                assert!(response.is_none(), "{status}: final response still pending");
            } else {
                let response = response.expect("final response complete");
                assert_eq!(response.status, 200);
                assert_eq!(response.body, "hello");
                assert_eq!(response.header("x-final"), Some("Yes"));
                assert_eq!(response.header("content-length"), Some("5"));
            }
        }
    }
}

// Catches: accepting an interim-only response, or swallowing a truncated final reply at EOF.
#[test]
fn interim_response_requires_a_complete_final_response_before_eof() {
    for tail in [
        "",
        "HTTP/1.1 200 OK\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\no",
    ] {
        let mut decoder = ResponseDecoder::default();
        decoder.push(format!("HTTP/1.1 100 Continue\r\n\r\n{tail}").as_bytes());
        assert!(decoder.response(false).unwrap().is_none());
        assert_eq!(
            decoder.response(true).unwrap_err().kind(),
            std::io::ErrorKind::UnexpectedEof
        );
    }
}

// Catches: skipping interim headers also skipping the final chunked or bodyless boundary.
#[test]
fn interim_response_preserves_final_chunked_and_bodyless_boundaries() {
    for (final_reply, status, body) in [
        (
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n",
            200,
            "ok",
        ),
        ("HTTP/1.1 204 No Content\r\n\r\n", 204, ""),
        ("HTTP/1.1 304 Not Modified\r\n\r\n", 304, ""),
        (
            "HTTP/1.1 101 Switching Protocols\r\n\r\nupgraded bytes",
            101,
            "",
        ),
    ] {
        let mut decoder = ResponseDecoder::default();
        decoder.push(format!("HTTP/1.1 103 Early Hints\r\n\r\n{final_reply}").as_bytes());
        let response = decoder
            .response(false)
            .unwrap()
            .expect("final boundary complete");
        assert_eq!(response.status, status);
        assert_eq!(response.body, body);
    }
}

// Catches: a 204/304 short-circuit that also swallows a truncated header section at EOF.
#[test]
fn bodyless_status_with_truncated_headers_at_eof_is_an_error() {
    for status in [204, 304] {
        let mut decoder = ResponseDecoder::default();
        decoder.push(format!("HTTP/1.1 {status} X\r\nConnection: keep-alive\r\n").as_bytes());
        assert!(decoder.response(false).unwrap().is_none());
        assert!(decoder.response(true).is_err());
    }
}

// Catches: status-class check applied to a non-1xx neighbour (199/200, 203/205, 303/305).
#[test]
fn statuses_next_to_the_bodyless_set_still_wait_for_their_body() {
    for status in [200, 203, 205, 303, 305, 99] {
        let mut decoder = ResponseDecoder::default();
        decoder.push(format!("HTTP/1.1 {status} X\r\nContent-Length: 3\r\n\r\n").as_bytes());
        assert!(
            decoder.response(false).unwrap().is_none(),
            "{status} must wait"
        );
        assert!(decoder.response(true).is_err(), "{status} truncated");
    }
}
