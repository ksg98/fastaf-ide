use super::get_pr_line_threads_impl;
use serde_json::{Value, json};

// Catches: live GraphQL bot authors lose bot=true, or outdated coordinates disappear.
// Expectations were recorded from GitHub on 2026-10-14, not derived from the mapper.
#[tokio::test]
#[ignore = "requires network and GH_TOKEN for read-only public GitHub review threads"]
async fn live_copilot_is_bot_and_outdated_thread_keeps_original_line() {
    let token = std::env::var("GH_TOKEN").expect("GH_TOKEN is required");
    assert!(!token.is_empty(), "GH_TOKEN is required");
    let scratch = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(scratch.path().join("config"));
    let state = crate::state::tests_support::make_test_app_state();
    *state.github.token.write() = Some(token);
    let mut evidence = Vec::new();
    for (name, remote, number) in [
        ("vscode", "https://github.com/microsoft/vscode.git", 341276),
        (
            "coderabbit",
            "https://github.com/mozilla-ai/any-llm.git",
            1475,
        ),
        (
            "verifiers",
            "https://github.com/PrimeIntellect-ai/verifiers.git",
            2833,
        ),
    ] {
        let path = scratch.path().join(name);
        std::fs::create_dir_all(&path).unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec!["remote", "add", "origin", remote],
        ] {
            let output = std::process::Command::new("git")
                .current_dir(&path)
                .env_remove("GH_TOKEN")
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success(), "local repository setup failed");
        }
        let page = get_pr_line_threads_impl(path.to_str().unwrap(), number, None, &state)
            .await
            .expect("read-only live review threads request failed");
        assert!(!page.has_next_page, "live oracle requires a complete page");
        if let Ok(path) = std::env::var("TUIC_LIVE_REVIEW_EVIDENCE") {
            let mut captured = evidence.clone();
            captured.push(json!({"repository":remote,"pr":number,"page":page}));
            std::fs::write(path, serde_json::to_vec_pretty(&captured).unwrap()).unwrap();
        }
        if name == "vscode" {
            let author = page
                .threads
                .iter()
                .flat_map(|t| t["comments"]["nodes"].as_array().unwrap().iter())
                .map(|c| &c["author"])
                .find(|a| a["login"] == "copilot-pull-request-reviewer")
                .expect("recorded Copilot thread must still exist");
            assert_eq!(author["bot"], true);
        } else if name == "coderabbit" {
            assert!(
                page.threads
                    .iter()
                    .any(|thread| thread["finding"]["tool"] == "code_rabbit"),
                "recorded CodeRabbit finding must still exist"
            );
        } else {
            let outdated = page
                .threads
                .iter()
                .find(|t| t["id"] == "PRRT_kwDONt9L486rlu-F")
                .expect("recorded outdated deployment.py thread must still exist");
            assert_eq!(outdated["isOutdated"], true);
            assert!(outdated["line"].is_null());
            assert_eq!(outdated["originalLine"], 148);
            let human = page
                .threads
                .iter()
                .flat_map(|t| t["comments"]["nodes"].as_array().unwrap().iter())
                .map(|c| &c["author"])
                .find(|a| a["login"] == "mikasenghaas")
                .expect("recorded human thread must still exist");
            assert_eq!(human["bot"], false);
        }
        let threads: Vec<Value> = page
            .threads
            .iter()
            .map(|t| {
                let authors: Vec<&Value> = t["comments"]["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| &c["author"])
                    .collect();
                json!({"id":t["id"], "path":t["path"], "line":t["line"],
                "originalLine":t["originalLine"], "isOutdated":t["isOutdated"], "authors":authors})
            })
            .collect();
        let prompt = crate::pr_open_threads::get_pr_open_threads_impl(
            path.to_str().unwrap(),
            number,
            &state,
        )
        .await
        .expect("read-only live open-thread prompt request failed");
        evidence.push(json!({
            "repository":remote, "pr":number, "headSha":page.head_sha,
            "threads":threads, "page":page, "openThreadsPrompt":prompt,
        }));
    }
    if let Ok(path) = std::env::var("TUIC_LIVE_REVIEW_EVIDENCE") {
        std::fs::write(path, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    }
}

// Catches: a live open-thread prompt dropping the eligible finding before agent use.
#[tokio::test]
#[ignore = "requires network and GH_TOKEN for read-only public GitHub review threads"]
async fn live_open_prompt_has_an_eligible_finding() {
    let token = std::env::var("GH_TOKEN").expect("GH_TOKEN is required");
    let scratch = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(scratch.path().join("config"));
    let state = crate::state::tests_support::make_test_app_state();
    *state.github.token.write() = Some(token);
    let owner = std::env::var("TUIC_LIVE_REVIEW_OWNER").unwrap_or_else(|_| "microsoft".into());
    let repo = std::env::var("TUIC_LIVE_REVIEW_REPO").unwrap_or_else(|_| "vscode".into());
    let remote = format!("https://github.com/{owner}/{repo}.git");
    let numbers = match std::env::var("TUIC_LIVE_REVIEW_PR") {
        Ok(number) => vec![
            number
                .parse::<i64>()
                .expect("TUIC_LIVE_REVIEW_PR must be an integer"),
        ],
        Err(_) => vec![341585, 341455],
    };
    let path = scratch.path().join("repository");
    std::fs::create_dir_all(&path).unwrap();
    for args in [
        vec!["init", "--quiet"],
        vec!["remote", "add", "origin", remote.as_str()],
    ] {
        let output = std::process::Command::new("git")
            .current_dir(&path)
            .env_remove("GH_TOKEN")
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "local repository setup failed");
    }
    let mut evidence = Vec::new();
    let mut eligible = false;
    for number in numbers {
        let page = get_pr_line_threads_impl(path.to_str().unwrap(), number, None, &state)
            .await
            .expect("read-only live review threads request failed");
        assert!(!page.has_next_page, "live oracle requires a complete page");
        let prompt = crate::pr_open_threads::get_pr_open_threads_impl(
            path.to_str().unwrap(),
            number,
            &state,
        )
        .await
        .expect("read-only live open-thread prompt request failed");
        eligible = page
            .threads
            .iter()
            .any(|thread| thread["isResolved"] == false && thread["isOutdated"] == false)
            && !prompt.contains("(no open review threads)");
        evidence.push(json!({"repository":remote,
            "pr":number,"headSha":page.head_sha,"page":page,"openThreadsPrompt":prompt,
            "eligible":eligible}));
        std::fs::write(
            std::env::var("TUIC_LIVE_REVIEW_EVIDENCE").unwrap(),
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .unwrap();
        if eligible {
            break;
        }
    }
    assert!(eligible, "all authorized public PR candidates have drifted");
}
