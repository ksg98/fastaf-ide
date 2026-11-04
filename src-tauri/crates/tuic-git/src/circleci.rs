#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CircleCiJob {
    pub vcs: String,
    pub org: String,
    pub repo: String,
    pub build_num: u64,
}

/// Where the active CircleCI token was found. The token itself never crosses a
/// transport boundary.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenSource {
    Vault,
    Env,
    CliConfig,
    None,
}

fn is_safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn vcs_slug(segment: &str) -> Option<&'static str> {
    match segment {
        "gh" | "github" => Some("gh"),
        "bb" | "bitbucket" => Some("bb"),
        _ => None,
    }
}

pub fn parse_check_url(value: &str) -> Option<CircleCiJob> {
    let url = url::Url::parse(value).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let segments: Vec<_> = url.path_segments()?.collect();

    let (vcs, org, repo, build_num) = match (host.as_str(), segments.as_slice()) {
        ("circleci.com", [vcs, org, repo, build_num]) => (*vcs, *org, *repo, *build_num),
        (
            "app.circleci.com",
            [
                "pipelines",
                vcs,
                org,
                repo,
                _,
                "workflows",
                _,
                "jobs",
                build_num,
            ],
        ) => (*vcs, *org, *repo, *build_num),
        _ => return None,
    };

    if !is_safe_segment(org) || !is_safe_segment(repo) {
        return None;
    }
    Some(CircleCiJob {
        vcs: vcs_slug(vcs)?.to_string(),
        org: org.to_string(),
        repo: repo.to_string(),
        build_num: build_num.parse().ok()?,
    })
}
