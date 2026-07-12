/// Reason an SSH tunnel process exited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitReason {
    AuthFailed,
    HostKeyMismatch,
    PortInUse,
    ConnectionRefused,
    NetworkDown,
    Timeout,
    UserKilled,
    Unknown(String),
}

impl ExitReason {
    /// Whether automatic retry is safe for this exit reason.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::NetworkDown | Self::Timeout | Self::ConnectionRefused
        )
    }
}

/// Classify why an SSH process exited based on its stderr output and exit code.
///
/// Stderr patterns are checked first; exit code is used as a fallback.
pub fn classify_exit(stderr: &str, exit_code: Option<i32>) -> ExitReason {
    if stderr.contains("Permission denied") || stderr.contains("Authentication failed") {
        return ExitReason::AuthFailed;
    }
    if stderr.contains("Host key verification failed")
        || stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
    {
        return ExitReason::HostKeyMismatch;
    }
    if stderr.contains("Address already in use")
        || stderr.contains("Could not request local forwarding")
    {
        return ExitReason::PortInUse;
    }
    if stderr.contains("Connection refused") {
        return ExitReason::ConnectionRefused;
    }
    if stderr.contains("Network is unreachable")
        || stderr.contains("No route to host")
        || stderr.contains("Connection timed out")
    {
        return ExitReason::NetworkDown;
    }
    if stderr.contains("Timeout, server") || stderr.contains("keepalive") {
        return ExitReason::Timeout;
    }

    // Exit codes >= 128 on Unix indicate termination by signal (128 + signal number).
    // If stderr is blank, this is a clean external kill (e.g. SIGKILL=137, SIGTERM=143).
    if exit_code.is_some_and(|code| code >= 128 && stderr.trim().is_empty()) {
        return ExitReason::UserKilled;
    }

    // Fall through to Unknown — include a short stderr snippet or the exit code.
    let snippet = if stderr.trim().is_empty() {
        exit_code.map_or_else(|| "unknown".to_owned(), |c| format!("exit code {c}"))
    } else {
        stderr.chars().take(200).collect()
    };
    ExitReason::Unknown(snippet)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_denied() {
        let stderr = "user@host: Permission denied (publickey,keyboard-interactive).";
        assert_eq!(classify_exit(stderr, Some(255)), ExitReason::AuthFailed);
    }

    #[test]
    fn host_key_changed() {
        let stderr = "@@@@@@@@@@@@@@@@@@@@@\n\
            @ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\n\
            @@@@@@@@@@@@@@@@@@@@@\n\
            IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\n\
            Host key verification failed.";
        assert_eq!(
            classify_exit(stderr, Some(255)),
            ExitReason::HostKeyMismatch
        );
    }

    #[test]
    fn port_in_use() {
        let stderr = "bind [127.0.0.1]:8080: Address already in use\n\
            channel_setup_fwd_listener_tcpip: cannot listen to port: 8080";
        assert_eq!(classify_exit(stderr, Some(255)), ExitReason::PortInUse);
    }

    #[test]
    fn connection_refused() {
        let stderr = "ssh: connect to host example.com port 22: Connection refused";
        assert_eq!(
            classify_exit(stderr, Some(255)),
            ExitReason::ConnectionRefused
        );
    }

    #[test]
    fn network_unreachable() {
        let stderr = "ssh: connect to host example.com port 22: Network is unreachable";
        assert_eq!(classify_exit(stderr, Some(255)), ExitReason::NetworkDown);
    }

    #[test]
    fn keepalive_timeout() {
        let stderr = "Timeout, server example.com not responding.";
        assert_eq!(classify_exit(stderr, Some(255)), ExitReason::Timeout);
    }

    #[test]
    fn signal_kill() {
        // SIGKILL = 9; exit code 128+9 = 137
        assert_eq!(classify_exit("", Some(137)), ExitReason::UserKilled);
    }

    #[test]
    fn unknown_with_snippet() {
        let stderr = "some weird error we don't recognize";
        match classify_exit(stderr, Some(1)) {
            ExitReason::Unknown(snippet) => {
                assert!(snippet.starts_with("some weird error"));
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn is_retryable() {
        assert!(ExitReason::NetworkDown.is_retryable());
        assert!(ExitReason::Timeout.is_retryable());
        assert!(ExitReason::ConnectionRefused.is_retryable());

        assert!(!ExitReason::AuthFailed.is_retryable());
        assert!(!ExitReason::HostKeyMismatch.is_retryable());
        assert!(!ExitReason::PortInUse.is_retryable());
        assert!(!ExitReason::UserKilled.is_retryable());
        assert!(!ExitReason::Unknown("x".to_owned()).is_retryable());
    }
}
