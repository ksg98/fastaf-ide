//! HTTP/1.1 framing used by both blocking CLI and asynchronous bridge adapters.

use std::io;

/// Parsed response, preserving header value casing and raw headers.
#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
    pub raw_headers: String,
}

impl Response {
    /// Case-insensitive lookup; values retain their original spelling.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// Whether the response status is successful.
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Encode a request without assuming a particular stream implementation.
pub fn request(method: &str, path: &str, body: Option<&str>, headers: &[(&str, &str)]) -> Vec<u8> {
    let content = body.unwrap_or("");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\n");
    if body.is_some() {
        request.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            content.len()
        ));
    }
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("Connection: close\r\n\r\n");
    request.push_str(content);
    request.into_bytes()
}

/// Allow repeated progress hints while bounding reads that never reach a final reply.
const MAX_INTERIM_RESPONSES: usize = 32;
/// Bound each status/header section, including its terminator, without limiting bodies.
const MAX_HEADER_BYTES: usize = 64 * 1024;

/// Accumulate stream fragments and finish at the declared body boundary, not EOF.
#[derive(Default)]
pub struct ResponseDecoder {
    bytes: Vec<u8>,
    interim_responses: usize,
}

impl ResponseDecoder {
    /// Add bytes received by either transport adapter.
    pub fn push(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }

    /// Parse a complete response, or return None while more bytes are needed.
    pub fn response(&mut self, eof: bool) -> io::Result<Option<Response>> {
        loop {
            let Some(header_end) = self.bytes[..self.bytes.len().min(MAX_HEADER_BYTES)]
                .windows(4)
                .position(|bytes| bytes == b"\r\n\r\n")
            else {
                if self.bytes.len() >= MAX_HEADER_BYTES {
                    return Err(invalid("HTTP response headers exceed 64 KiB"));
                }
                return if eof { Err(incomplete()) } else { Ok(None) };
            };
            let raw_headers = String::from_utf8_lossy(&self.bytes[..header_end]).into_owned();
            let status = raw_headers
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|status| status.parse().ok())
                .ok_or_else(|| invalid("invalid HTTP response status"))?;
            // RFC 9110 section 15.2: informational replies precede the final response.
            // 101 switches protocols and therefore ends HTTP response parsing.
            if (100..200).contains(&status) && status != 101 {
                if self.interim_responses >= MAX_INTERIM_RESPONSES {
                    return Err(invalid("HTTP response exceeds 32 interim replies"));
                }
                self.interim_responses += 1;
                self.bytes.drain(..header_end + 4);
                continue;
            }
            let headers: Vec<(String, String)> = raw_headers
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
                .collect();
            let body_bytes = &self.bytes[header_end + 4..];
            let chunked = headers.iter().any(|(key, value)| {
                key == "transfer-encoding"
                    && value
                        .split(',')
                        .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"))
            });
            // RFC 9112 section 6.3: these boundaries precede all framing headers.
            let body = if matches!(status, 101 | 204 | 304) {
                Vec::new()
            } else if chunked {
                match chunked_body(body_bytes)? {
                    Some(body) => body,
                    None if eof => return Err(incomplete()),
                    None => return Ok(None),
                }
            } else if let Some((_, length)) =
                headers.iter().find(|(key, _)| key == "content-length")
            {
                let length: usize = length
                    .parse()
                    .map_err(|_| invalid("invalid Content-Length"))?;
                if body_bytes.len() < length {
                    return if eof { Err(incomplete()) } else { Ok(None) };
                }
                body_bytes[..length].to_vec()
            } else if eof {
                body_bytes.to_vec()
            } else {
                return Ok(None);
            };
            return Ok(Some(Response {
                status,
                body: String::from_utf8_lossy(&body).into_owned(),
                headers,
                raw_headers,
            }));
        }
    }
}

fn incomplete() -> io::Error {
    io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "response ended before a complete final HTTP response",
    )
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn chunked_body(bytes: &[u8]) -> io::Result<Option<Vec<u8>>> {
    let mut cursor = 0;
    let mut body = Vec::new();
    loop {
        let Some(end) = bytes[cursor..].windows(2).position(|pair| pair == b"\r\n") else {
            return Ok(None);
        };
        let size = std::str::from_utf8(&bytes[cursor..cursor + end])
            .map_err(|_| invalid("invalid chunk size"))?;
        let size = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| invalid("invalid chunk size"))?;
        cursor += end + 2;
        if size == 0 {
            // Consume the empty trailer or the entire trailer section.
            if bytes[cursor..].starts_with(b"\r\n")
                || bytes[cursor..].windows(4).any(|bytes| bytes == b"\r\n\r\n")
            {
                return Ok(Some(body));
            }
            return Ok(None);
        }
        let end = cursor
            .checked_add(size)
            .ok_or_else(|| invalid("chunk size overflow"))?;
        let framed_end = end
            .checked_add(2)
            .ok_or_else(|| invalid("chunk size overflow"))?;
        if bytes.len() < framed_end {
            return Ok(None);
        }
        if &bytes[end..framed_end] != b"\r\n" {
            return Err(invalid("invalid chunk terminator"));
        }
        body.extend_from_slice(&bytes[cursor..end]);
        cursor = framed_end;
    }
}
