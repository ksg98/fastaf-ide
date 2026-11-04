use super::*;
use std::io::Read;

impl PromptReceipt {
    pub fn capture(
        prompt: &str,
        source: &str,
        args: &[String],
        cwd: Option<&str>,
        queued: bool,
    ) -> Self {
        let mut receipt = Self::default();
        if queued || args.iter().any(|arg| arg.contains(prompt)) && !prompt.is_empty() {
            receipt.push(PromptSection::captured(
                "Launch brief",
                source,
                prompt,
                if queued { "queued" } else { "sent" },
            ));
        } else {
            receipt.push(PromptSection::unavailable(
                "Launch brief",
                "No brief observed in the final argv",
            ));
        }
        // Parse only flags whose value TUIC actually supplies; a positional file
        // or the agent's automatic AGENTS.md discovery is not an instruction receipt.
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            if arg == "--" {
                break;
            }
            let (flag, inline) = arg
                .split_once('=')
                .map_or((arg.as_str(), None), |(k, v)| (k, Some(v)));
            if !matches!(
                flag,
                "--append-system-prompt"
                    | "--system-prompt"
                    | "--append-system-prompt-file"
                    | "--system-prompt-file"
            ) {
                continue;
            }
            if receipt.sections.len() >= SECTION_COUNT_CAP {
                receipt.capture_limited = true;
                break;
            }
            let value = inline.or_else(|| args.next().map(String::as_str));
            let Some(value) = value else {
                continue;
            };
            if flag.ends_with("-file") {
                let path = std::path::PathBuf::from(crate::cli::expand_tilde(value));
                let path = if path.is_absolute() {
                    path
                } else {
                    std::path::PathBuf::from(
                        cwd.map(crate::cli::expand_tilde)
                            .unwrap_or_else(|| ".".into()),
                    )
                    .join(path)
                };
                let source = path.to_string_lossy();
                let snapshot = (|| {
                    let metadata = std::fs::metadata(&path)?;
                    if !metadata.is_file() || metadata.len() > FILE_READ_CAP {
                        return Err(std::io::Error::other(
                            "instruction file outside snapshot bounds",
                        ));
                    }
                    let mut options = std::fs::OpenOptions::new();
                    options.read(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.custom_flags(libc::O_NONBLOCK);
                    }
                    let file = options.open(&path)?;
                    let metadata = file.metadata()?;
                    if !metadata.is_file() || metadata.len() > FILE_READ_CAP {
                        return Err(std::io::Error::other(
                            "instruction file outside snapshot bounds",
                        ));
                    }
                    let mut text = String::new();
                    file.take(FILE_READ_CAP + 1).read_to_string(&mut text)?;
                    if text.len() as u64 > FILE_READ_CAP {
                        return Err(std::io::Error::other(
                            "instruction file grew past snapshot bound",
                        ));
                    }
                    Ok(text)
                })();
                receipt.push(match snapshot {
                    Ok(text) => PromptSection::captured(
                        "Instruction file snapshot",
                        &source,
                        &text,
                        "file_snapshot",
                    ),
                    Err(_) => PromptSection::unavailable(
                        "Instruction file (unreadable or over 1 MiB)",
                        &source,
                    ),
                });
            } else {
                receipt.push(PromptSection::captured(
                    "System instruction argument",
                    flag,
                    value,
                    "sent",
                ));
            }
        }
        receipt
    }

    pub(super) fn push(&mut self, mut section: PromptSection) {
        if section.status == "served" {
            self.merge_served(section);
            return;
        }
        if self.sections.len() >= SECTION_COUNT_CAP {
            self.capture_limited = true;
            return;
        }
        let used: usize = self.sections.iter().map(|s| s.text.len()).sum();
        let remaining = RECEIPT_BYTE_CAP.saturating_sub(used);
        if section.text.len() > remaining {
            section.truncated = true;
            truncate_utf8(&mut section.text, remaining);
        }
        self.sections.push(section);
    }

    /// Every bridge reconnect serves a fresh response whose text embeds live
    /// state (peer count, repos). Keying on the text made each change a new
    /// row, so a served row is keyed by its label: the newest body replaces
    /// the older one and the row counts the observations. It bypasses the
    /// section and byte caps because at most one row exists per label and
    /// the section cap already bounds its size; launch rows are never evicted.
    fn merge_served(&mut self, mut section: PromptSection) {
        let Some(row) = self
            .sections
            .iter_mut()
            .find(|s| s.status == "served" && s.label == section.label)
        else {
            self.sections.push(section);
            return;
        };
        row.count += section.count;
        row.first_seen_ms = row.first_seen_ms.min(section.first_seen_ms);
        if section.last_seen_ms >= row.last_seen_ms {
            section.count = row.count;
            section.first_seen_ms = row.first_seen_ms;
            *row = section;
        }
    }

    pub fn mark_brief_sent(&mut self) {
        if let Some(section) = self
            .sections
            .iter_mut()
            .find(|s| s.label == "Launch brief" && s.status == "queued")
        {
            section.status = "sent".into();
        }
    }
}
