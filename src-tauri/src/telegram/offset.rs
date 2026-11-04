use super::config::private_open;
use super::{Error, Paths};
use std::io::{Read, Write};

/// A decimal i64 and newline fit in 20 bytes; reject oversized/corrupt cursors.
pub(super) fn read(paths: &Paths) -> Option<i64> {
    let result = (|| {
        let file = private_open(&paths.file("next_offset"), false).ok()?;
        let mut text = String::new();
        file.take(21).read_to_string(&mut text).ok()?;
        let digits = text.strip_suffix('\n').unwrap_or(&text);
        if text.len() > 20 || digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        digits.parse::<i64>().ok()
    })();
    if result.is_none() {
        // With only one cursor file, initial start and a lost file are indistinguishable.
        tracing::warn!(
            source = "telegram",
            "Telegram cursor missing or invalid; skipping backlog once; old phone messages may be lost"
        );
    }
    result
}

/// Replace only the cursor after handoff; retain no mail payload on disk.
pub(super) fn write(paths: &Paths, next: i64) -> Result<(), Error> {
    if next < 0 {
        return Err(Error::Protocol);
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(&paths.directory).map_err(|_| Error::PrivateFile)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| Error::PrivateFile)?;
    }
    writeln!(temporary, "{next}").map_err(|_| Error::PrivateFile)?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| Error::PrivateFile)?;
    temporary
        .persist(paths.file("next_offset"))
        .map_err(|_| Error::PrivateFile)?;
    #[cfg(unix)]
    std::fs::File::open(&paths.directory)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| Error::PrivateFile)?;
    Ok(())
}
