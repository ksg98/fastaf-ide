//! Byte-cursor reads of an append-only JSONL transcript.
//!
//! Three readers share the arithmetic: the subagent lane cursor, the parent
//! spawn cursor (both in `subagent_map`) and the chat view tail
//! (`chat_view`). It lives once because a second copy is a second chance to
//! consume a half-written row.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// What a cursor advance found.
pub(crate) struct Appended {
    /// Only whole lines. A partial trailing line stays unread.
    pub text: String,
    /// The file shrank, so everything parsed from it before is gone.
    pub restarted: bool,
}

/// Read the complete lines appended to `path` since `offset`, advancing it.
pub(crate) fn read_appended(path: &Path, offset: &mut u64) -> std::io::Result<Appended> {
    let len = std::fs::metadata(path)?.len();
    // Truncated or rotated. A stale offset would start reading from the middle
    // of a line, so the only safe answer is to start over.
    let restarted = len < *offset;
    if restarted {
        *offset = 0;
    }
    if len == *offset {
        return Ok(Appended {
            text: String::new(),
            restarted,
        });
    }

    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(*offset))?;
    let mut chunk = String::new();
    file.take(len - *offset).read_to_string(&mut chunk)?;

    // Stop at the last newline: anything after it is a row Claude is still
    // writing. Consuming it would parse garbage now and skip the real row when
    // it lands.
    let Some(end) = chunk.rfind('\n') else {
        return Ok(Appended {
            text: String::new(),
            restarted,
        });
    };
    chunk.truncate(end + 1);
    *offset += chunk.len() as u64;
    Ok(Appended {
        text: chunk,
        restarted,
    })
}

/// First read of a transcript that may be tens of MB: only the last `window`
/// bytes, from the first whole line inside them, and `offset` set past the last
/// complete line. Everything earlier is never read.
///
/// A file no longer than `window` is read whole, so a short transcript loses
/// nothing. `restarted` is always false: there is no earlier state to drop.
pub(crate) fn read_last_window(
    path: &Path,
    offset: &mut u64,
    window: u64,
) -> std::io::Result<Appended> {
    let len = std::fs::metadata(path)?.len();
    let start = len.saturating_sub(window);
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(len - start).read_to_end(&mut bytes)?;

    // A cut in the middle of a row leaves a partial first line. `\n` is ASCII,
    // so the byte after it is a character boundary.
    let first = if start == 0 {
        0
    } else {
        bytes
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |i| i + 1)
    };
    let last = bytes
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(first, |i| i + 1)
        .max(first);
    *offset = start + last as u64;
    Ok(Appended {
        text: String::from_utf8_lossy(&bytes[first..last]).into_owned(),
        restarted: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::write(path, text).expect("write");
    }

    /// A 31 MB transcript must not be read from byte 0 on first attach.
    #[test]
    fn last_window_skips_the_partial_first_line_and_starts_inside_the_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("t.jsonl");
        write(&path, "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n");
        let mut offset = 0;
        // 15 bytes: cuts the middle of line b.
        let read = read_last_window(&path, &mut offset, 15).expect("read");
        assert_eq!(read.text, "cccccccccc\n");
        assert_eq!(offset, 33, "cursor sits at EOF");
        // The cursor then continues with plain appends.
        write(&path, "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\ndd\n");
        let more = read_appended(&path, &mut offset).expect("read");
        assert_eq!(more.text, "dd\n");
    }

    #[test]
    fn last_window_reads_a_short_file_whole() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("t.jsonl");
        write(&path, "one\ntwo\n");
        let mut offset = 0;
        let read = read_last_window(&path, &mut offset, 1024).expect("read");
        assert_eq!(read.text, "one\ntwo\n");
        assert_eq!(offset, 8);
    }

    /// A row still being written at attach time must be read once it lands.
    #[test]
    fn last_window_leaves_a_partial_trailing_line_for_the_next_read() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("t.jsonl");
        write(&path, "one\ntw");
        let mut offset = 0;
        let read = read_last_window(&path, &mut offset, 1024).expect("read");
        assert_eq!(read.text, "one\n");
        write(&path, "one\ntwo\n");
        assert_eq!(
            read_appended(&path, &mut offset).expect("read").text,
            "two\n"
        );
    }

    /// A window cut inside a multi-byte character must not corrupt the rows.
    #[test]
    fn last_window_never_splits_a_multibyte_character() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("t.jsonl");
        write(&path, "héllo wörld\nsecond\n");
        let mut offset = 0;
        let read = read_last_window(&path, &mut offset, 10).expect("read");
        assert_eq!(read.text, "second\n");
    }
}
