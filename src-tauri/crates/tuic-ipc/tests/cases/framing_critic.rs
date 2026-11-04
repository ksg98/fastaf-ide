use tuic_ipc::http::ResponseDecoder;

// Catches: a bodyless response waits for EOF on a persistent connection.
#[test]
fn bodyless_status_finishes_without_content_length_or_eof() {
    for status in [204, 304] {
        let mut decoder = ResponseDecoder::default();
        decoder.push(
            format!("HTTP/1.1 {status} No Body\r\nConnection: keep-alive\r\n\r\n").as_bytes(),
        );
        let response = decoder
            .response(false)
            .unwrap()
            .expect("bodyless HTTP status must finish at headers");
        assert_eq!(response.status, status);
        assert_eq!(response.body, "");
    }
}

// Catches: split trailers are mistaken for a complete response or included in JSON.
#[test]
fn chunk_extensions_and_fragmented_trailers_return_only_payload() {
    let wire = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;x=y\r\nabc\r\n2\r\nde\r\n0\r\nChecksum: fixed\r\n\r\n";
    let mut decoder = ResponseDecoder::default();
    for (index, byte) in wire.iter().enumerate() {
        decoder.push(&[*byte]);
        let response = decoder.response(false).unwrap();
        if index + 1 < wire.len() {
            assert!(response.is_none(), "premature completion at byte {index}");
        } else {
            assert_eq!(response.unwrap().body, "abcde");
        }
    }
}

// Catches: a huge chunk size overflows offset arithmetic or returns partial success.
#[test]
fn overflowing_chunk_size_returns_error_instead_of_panicking() {
    let mut decoder = ResponseDecoder::default();
    decoder.push(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffff\r\n");
    assert!(decoder.response(true).is_err());
}
