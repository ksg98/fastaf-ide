//! Wait ownership for applications launched without capturing their output.

use std::io;
use std::process::Command;
use std::sync::mpsc;

/// Launch a command and reap it later without waiting for its exit here.
///
/// Returns the child PID once spawning succeeds. The wait thread is created
/// first, so failure to create a thread cannot abandon an already-spawned child.
/// The application keeps running independently of the caller and is never killed.
///
/// # Errors
/// Returns thread creation or process spawn errors.
pub fn spawn_reaped(mut command: Command) -> io::Result<u32> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("launcher-child-wait".into())
        .spawn(move || match command.spawn() {
            Ok(mut child) => {
                let pid = child.id();
                let _ = sender.send(Ok(pid));
                if let Err(error) = child.wait() {
                    tracing::warn!(source = "launcher", pid, %error, "Failed to reap launched child");
                }
            }
            Err(error) => {
                let _ = sender.send(Err(error));
            }
        })?;
    receiver
        .recv()
        .map_err(|_| io::Error::other("Launcher wait thread exited before spawning"))?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    // Catches: waiting synchronously for exit or killing an application whose
    // launcher caller has returned, instead of preserving and reaping it.
    #[test]
    fn launch_returns_while_child_lives_then_reaps_after_exit() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "kill -STOP $$; exit 7"]);
        let pid = spawn_reaped(command).unwrap() as libc::pid_t;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let mut status = 0;
            // SAFETY: only observes this test's stopped child. WUNTRACED
            // reports the stop without reaping the eventual exit.
            let stopped =
                unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG | libc::WUNTRACED) };
            assert_ne!(stopped, -1, "launched application must remain alive");
            if stopped == pid && libc::WIFSTOPPED(status) {
                break;
            }
            assert!(Instant::now() < deadline, "child did not reach stop gate");
            std::thread::sleep(Duration::from_millis(10));
        }
        // SAFETY: resumes only the child this test started.
        assert_eq!(unsafe { libc::kill(pid, libc::SIGCONT) }, 0);
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            // SAFETY: signal zero only checks existence; it cannot kill.
            if unsafe { libc::kill(pid, 0) } == -1
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                break;
            }
            assert!(Instant::now() < deadline, "launched child was not reaped");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    // Catches: reporting success when spawning fails inside the wait thread.
    #[test]
    fn launch_returns_missing_executable_error() {
        assert_eq!(
            spawn_reaped(Command::new("")).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }
}
