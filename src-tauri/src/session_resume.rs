//! Resume selection and profile-root verification shared by restoration and suspension.
use std::collections::HashMap;

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResumeRequest {
    pub agent_type: String,
    pub cwd: Option<String>,
    pub tuic_session: Option<String>,
    pub agent_session_id: Option<String>,
    pub launch_command: Option<String>,
}

#[derive(serde::Serialize)]
pub(crate) struct ResumeResolution {
    pub cmd: Option<String>,
    pub verified: bool,
}

// Retain shell spelling (including escaped quotes) while finding argv boundaries.
fn tokens(command: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut chars = command.chars();
    while let Some(ch) = chars.next() {
        if !cfg!(windows) && ch == '\\' && quote != Some('\'') {
            current.push(ch);
            if let Some(next) = chars.next() {
                current.push(next);
            }
        } else if matches!(ch, '\'' | '"') && (quote.is_none() || quote == Some(ch)) {
            quote = if quote.is_some() { None } else { Some(ch) };
            current.push(ch);
        } else if ch.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

fn unquote(value: &str) -> String {
    let mut result = String::new();
    let mut quote = None;
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if cfg!(windows) && ch == '"' && quote == Some('"') && chars.peek() == Some(&'"') {
            chars.next();
            result.push('"');
        } else if matches!(ch, '\'' | '"') && (quote.is_none() || quote == Some(ch)) {
            quote = if quote.is_some() { None } else { Some(ch) };
        } else if !cfg!(windows)
            && ch == '\\'
            && quote != Some('\'')
            && (quote.is_none()
                || chars
                    .peek()
                    .is_some_and(|next| matches!(next, '\\' | '"' | '$' | '`' | '\n')))
        {
            if let Some(next) = chars.next() {
                result.push(next);
            }
        } else if cfg!(windows) && ch == '^' {
            // prompt::shell_quote escapes cmd metacharacters with a caret.
            if let Some(next) = chars.next() {
                result.push(next);
            }
        } else {
            result.push(ch);
        }
    }
    result
}

/// Claude Code's bypass-permissions flag, which FastAF adds to every Claude
/// resume (see `resolve`).
const CLAUDE_SKIP_PERMISSIONS: &str = "--dangerously-skip-permissions";

pub(crate) fn resolve(request: &ResumeRequest) -> ResumeResolution {
    let agent = request.agent_type.as_str();
    let config = crate::config::load_agents_config();
    let run = config.agents.get(agent).and_then(|settings| {
        settings
            .run_configs
            .iter()
            .find(|run| run.is_default)
            .or(settings.run_configs.first())
    });
    let launch = request.launch_command.as_deref().map(tokens);
    let mut argv = launch.clone().unwrap_or_else(|| {
        run.map(|run| {
            let mut argv = tokens(&run.command);
            argv.extend(run.args.clone());
            argv
        })
        .unwrap_or_else(|| {
            vec![if agent == "cursor" {
                "cursor-agent".into()
            } else {
                agent.to_owned()
            }]
        })
    });
    let mut env: HashMap<String, String> = run.map(|run| run.env.clone()).unwrap_or_default();
    let prefix = argv
        .iter()
        .take_while(|token| {
            token.split_once('=').is_some_and(|(key, _)| {
                !key.is_empty()
                    && key.chars().enumerate().all(|(i, ch)| {
                        ch == '_' || ch.is_ascii_alphabetic() || (i > 0 && ch.is_ascii_digit())
                    })
            })
        })
        .count();
    for token in &argv[..prefix] {
        if let Some((key, value)) = token.split_once('=') {
            env.insert(key.into(), unquote(value));
        }
    }
    if launch.is_some() && prefix == 0 {
        env = config
            .agents
            .get(agent)
            .and_then(|settings| {
                settings.run_configs.iter().find(|run| {
                    [vec![run.command.clone()], run.args.clone()]
                        .concat()
                        .join(" ")
                        == request.launch_command.as_deref().unwrap_or_default()
                })
            })
            .map(|run| run.env.clone())
            .unwrap_or_default();
    }
    let discovery = matches!(
        agent,
        "claude" | "gemini" | "codex" | "grok" | "ego" | "goose"
    );
    let id = request.agent_session_id.as_deref().or_else(|| {
        (agent == "goose")
            .then_some(request.tuic_session.as_deref())
            .flatten()
    });
    let mut verified = false;
    if discovery && let (Some(id), Some(cwd)) = (id, request.cwd.as_deref()) {
        if !crate::agent_session::verify_agent_session(
            agent.into(),
            id.into(),
            cwd.into(),
            None,
            env.clone(),
        ) {
            return ResumeResolution {
                cmd: None,
                verified: false,
            };
        }
        verified = true;
    }
    let flags = match (agent, id) {
        ("claude", Some(id)) | ("gemini", Some(id)) | ("grok", Some(id)) => {
            vec!["--resume".into(), crate::prompt::shell_quote(id)]
        }
        ("codex", Some(id)) | ("ego", Some(id)) => {
            vec!["resume".into(), crate::prompt::shell_quote(id)]
        }
        ("goose", Some(id)) => vec![
            "session".into(),
            "--resume".into(),
            "--name".into(),
            crate::prompt::shell_quote(id),
        ],
        ("claude" | "grok" | "pi", _) => vec!["--continue".into()],
        ("gemini", _) => vec!["--resume".into()],
        ("codex", _) => vec!["resume".into(), "--last".into()],
        ("ego" | "cursor", _) => vec!["resume".into()],
        ("goose", _) => vec!["session".into(), "--resume".into()],
        ("opencode", _) => vec!["-c".into()],
        ("amp", _) => vec!["threads".into(), "continue".into()],
        _ => {
            return ResumeResolution {
                cmd: None,
                verified: false,
            };
        }
    };
    if argv.len() <= prefix {
        return ResumeResolution {
            cmd: None,
            verified: false,
        };
    }
    if argv
        .last()
        .is_some_and(|arg| unquote(arg).starts_with("<untrusted-content source=\"work item\">"))
    {
        argv.pop();
        if argv.last().is_some_and(|arg| arg == "--") {
            argv.pop();
        }
    }
    // Discovery rebuilds launch commands without old session selectors or task briefs.
    let mut args = flags;
    let rest: Vec<String> = argv.iter().skip(prefix + 1).cloned().collect();
    // FastAF resumes Claude in bypass-permissions mode, `--resume <id>` and
    // `--continue` alike, so a restored session comes back without a prompt.
    // Once only: the launch command or run config may already carry it.
    if agent == "claude"
        && !rest
            .iter()
            .any(|arg| unquote(arg) == CLAUDE_SKIP_PERMISSIONS)
    {
        args.push(CLAUDE_SKIP_PERMISSIONS.into());
    }
    args.extend(rest);
    let binary = unquote(&argv[prefix]);
    let args = crate::agent_hook_launch::build_agent_launch_args(agent, &binary, &args);
    let mut command: Vec<String> = env
        .iter()
        .map(|(key, value)| format!("{key}={}", crate::prompt::shell_quote(value)))
        .collect();
    command.sort();
    command.push(argv[prefix].clone());
    command.extend(args);
    ResumeResolution {
        cmd: Some(command.join(" ")),
        verified,
    }
}

/// Apply environment prefixes as process environment on every host shell.
pub(crate) fn shell_launch(command: &str) -> (HashMap<String, String>, String) {
    let argv = tokens(command);
    let mut env = HashMap::new();
    let mut cut = 0;
    for token in &argv {
        let Some((key, value)) = token.split_once('=') else {
            break;
        };
        if key.is_empty()
            || !key.chars().enumerate().all(|(i, ch)| {
                ch == '_' || ch.is_ascii_alphabetic() || (i > 0 && ch.is_ascii_digit())
            })
        {
            break;
        }
        env.insert(key.into(), unquote(value));
        cut += 1;
    }
    (env, argv[cut..].join(" "))
}

#[cfg(test)]
#[path = "session_resume_tests.rs"]
mod tests;
