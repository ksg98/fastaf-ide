use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::Emitter;
#[cfg(feature = "desktop")]
use tauri::State;

// ---------------------------------------------------------------------------
// Per-repo LLM triage session — persistent conversation + diff hash cache
// ---------------------------------------------------------------------------

const MAX_SESSION_MESSAGES: usize = 100;
const SESSION_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug)]
enum MsgRole {
    User,
    Assistant,
}

#[derive(Clone, Debug)]
struct SessionMsg {
    role: MsgRole,
    content: String,
}

struct TriageSession {
    messages: Vec<SessionMsg>,
    file_hashes: HashMap<String, u64>,
    classifications: HashMap<String, FileClassification>,
    summary: Option<String>,
    file_set_hash: u64,
    model: String,
    created_at: std::time::Instant,
    /// PR-review only: the head SHA this session's conversation was built
    /// against. `None` for working-tree triage sessions, which have no PR
    /// head to track. A new commit on the PR changes this and invalidates
    /// the cached conversation (see `run_pr_review_impl`).
    head_sha: Option<String>,
}

impl TriageSession {
    fn new(model: String) -> Self {
        Self {
            messages: Vec::new(),
            file_hashes: HashMap::new(),
            classifications: HashMap::new(),
            summary: None,
            file_set_hash: 0,
            model,
            created_at: std::time::Instant::now(),
            head_sha: None,
        }
    }

    fn is_valid(&self, model: &str) -> bool {
        self.model == model
            && self.messages.len() < MAX_SESSION_MESSAGES
            && self.created_at.elapsed() < SESSION_TTL
    }
}

fn triage_sessions() -> &'static Mutex<HashMap<String, TriageSession>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, TriageSession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// PR-review LLM sessions, keyed by `{repo_path}#{pr_number}` — one entry
/// per open PR, not per commit. Kept separate from the working-tree triage
/// store so a re-review of an unchanged PR head reuses its multi-turn
/// context (and per-file hash cache) without colliding with, or being
/// pruned by, working-tree triage.
///
/// The key deliberately excludes `head_sha`: keying by commit would leak a
/// new entry on every push to the PR (head_sha changes each commit) with
/// nothing ever removing stale ones. Instead the current head_sha is
/// stored on the session itself (`TriageSession::head_sha`) and checked by
/// `run_pr_review_impl`, which discards (overwrites) the cached session
/// when the PR has moved to a new commit. This bounds the map by open-PR
/// count instead of growing forever.
fn pr_review_sessions() -> &'static Mutex<HashMap<String, TriageSession>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, TriageSession>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Build the `pr_review_sessions` key from repo + PR number.
fn pr_review_session_key(repo_path: &str, pr_number: i64) -> String {
    format!("{repo_path}#{pr_number}")
}

fn hash_diff(diff: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    diff.hash(&mut hasher);
    hasher.finish()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileClassification {
    pub path: String,
    pub relevance: Relevance,
    pub category: Category,
    pub risk: Risk,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<Finding>,
    pub source: ClassificationSource,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Finding {
    pub path: String,
    pub line: Option<u32>,
    pub hunk: Option<String>,
    pub severity: Severity,
    pub message: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Bug,
    Risk,
    Nit,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Relevance {
    High = 0,
    Medium = 1,
    Low = 2,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    BusinessLogic,
    ApiSurface,
    Schema,
    Config,
    Test,
    Boilerplate,
    Style,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Risk {
    BreakingChange,
    BehavioralChange,
    Cosmetic,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClassificationSource {
    Heuristic,
    Llm,
}

#[derive(Debug, Clone, Serialize)]
pub struct TriageResult {
    pub summary: Option<String>,
    pub files: Vec<FileClassification>,
    pub llm_used: bool,
    pub llm_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnifiedDiffFile {
    pub path: String,
    pub diff: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrReviewResult {
    pub repo_path: String,
    pub pr_number: i64,
    pub head_sha: String,
    pub summary: Option<String>,
    pub files: Vec<FileClassification>,
    pub llm_used: bool,
    pub llm_model: Option<String>,
}

// ---------------------------------------------------------------------------
// Heuristic classification rules
// ---------------------------------------------------------------------------
//
// Files matched here skip the LLM entirely — saves tokens and latency.
// Only classify files that are UNAMBIGUOUSLY a certain category regardless
// of what other files changed. Tests are deliberately NOT here because
// their relevance depends on context (a test for the main feature change
// is medium, not low).
//
// Categories:
//   1. Lock files         → low/boilerplate   (auto-generated dependency manifests)
//   2. Generated code     → low/boilerplate   (protobuf, codegen, etc.)
//   3. CI/CD configs      → low/config        (pipelines, workflows — unless large)
//   4. Documentation      → low/style         (markdown, txt, license)
//   5. Static assets      → low/style         (images, fonts, icons)
//   6. SQL migrations     → HIGH/schema       (always review database changes)
//   7. Minor config edits → low/config        (≤5 lines in known config files)
//   8. Formatting-only    → low/style         (prettier, rustfmt config files)
// ---------------------------------------------------------------------------

// 1. Lock files — auto-generated, never need human review
const LOCK_FILES: &[&str] = &[
    "Cargo.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Gemfile.lock",
    "poetry.lock",
    "go.sum",
    "Pipfile.lock",
    "composer.lock",
    "flake.lock",
    "bun.lockb",
    "shrinkwrap.json",
];

// 7. Config files — low relevance when edits are minor (≤5 lines)
const CONFIG_FILES: &[&str] = &[
    "Cargo.toml",
    "package.json",
    "tsconfig.json",
    "tauri.conf.json",
    ".env.example",
    "Makefile",
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "biome.json",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.yaml",
    ".prettierrc",
    ".prettierrc.json",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".nvmrc",
    ".node-version",
    ".tool-versions",
    "rust-toolchain.toml",
    "renovate.json",
    "dependabot.yml",
    "turbo.json",
    "nx.json",
    "lerna.json",
    "jest.config.ts",
    "jest.config.js",
    "vitest.config.ts",
    "vitest.config.js",
    "babel.config.js",
    "rollup.config.js",
    "vite.config.ts",
    "webpack.config.js",
];

// 3. CI/CD pipeline files — low relevance unless large changes
const CI_PATTERNS: &[&str] = &[
    ".github/workflows/",
    ".github/actions/",
    ".gitlab-ci",
    "Jenkinsfile",
    ".circleci/",
    ".travis.yml",
    "azure-pipelines",
    "bitbucket-pipelines",
    ".buildkite/",
];

// 8. Formatting/linting config — cosmetic by definition
const FORMAT_CONFIG_FILES: &[&str] = &[
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yaml",
    ".prettierignore",
    ".eslintignore",
    "rustfmt.toml",
    ".rustfmt.toml",
    "biome.json",
    ".editorconfig",
    ".clang-format",
    "stylua.toml",
    ".stylelintrc",
    ".stylelintrc.json",
];

// 5. Static assets — binary or non-code, never need LLM
const ASSET_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "avif", "woff", "woff2", "ttf", "eot",
    "otf", "mp3", "mp4", "wav", "ogg", "webm", "pdf", "zip", "tar", "gz",
];

// 4. Documentation extensions
const DOC_EXTENSIONS: &[&str] = &["md", "mdx", "txt", "rst", "adoc"];

const DOC_FILES: &[&str] = &[
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "CHANGELOG",
    "CHANGELOG.md",
    "CONTRIBUTING",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
];

fn make(
    path: &str,
    relevance: Relevance,
    category: Category,
    risk: Risk,
    summary: &str,
) -> FileClassification {
    FileClassification {
        path: path.to_string(),
        relevance,
        category,
        risk,
        summary: summary.to_string(),
        findings: Vec::new(),
        source: ClassificationSource::Heuristic,
        additions: 0,
        deletions: 0,
    }
}

fn is_generated(path: &str, filename: &str) -> bool {
    path.contains("__generated__")
        || path.contains("/generated/")
        || path.contains("/dist/")
        || path.contains("/build/")
        || path.contains("node_modules/")
        || filename.ends_with(".pb.go")
        || filename.ends_with(".pb.rs")
        || filename.ends_with(".g.dart")
        || filename.ends_with(".gen.ts")
        || filename.ends_with(".generated.ts")
        || filename.ends_with(".d.ts")
        || filename.ends_with(".min.js")
        || filename.ends_with(".min.css")
        || filename == "schema.graphql"
}

fn is_migration(path: &str, ext: &str) -> bool {
    if ext != "sql" {
        return false;
    }
    path.contains("/migrations/")
        || path.contains("/migration/")
        || path.starts_with("migrations/")
        || path.starts_with("migration/")
}

fn is_ci_file(path: &str) -> bool {
    CI_PATTERNS.iter().any(|p| path.contains(p))
}

fn is_doc_file(_path: &str, filename: &str, ext: &str) -> bool {
    DOC_FILES.contains(&filename) || DOC_EXTENSIONS.contains(&ext)
}

fn is_asset(ext: &str) -> bool {
    ASSET_EXTENSIONS.contains(&ext)
}

/// Classify a file by path/stats alone. Returns `None` if the file needs LLM.
///
/// Design: only intercept files that are UNAMBIGUOUSLY classifiable.
/// Tests are intentionally left for the LLM — a test covering the main
/// feature change is medium, not low. Only the LLM sees the full context.
pub fn heuristic_classify(
    path: &str,
    additions: u32,
    deletions: u32,
) -> Option<FileClassification> {
    let filename = Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let ext = ext.as_str();

    // 1. Lock files — always low, never interesting
    if LOCK_FILES.contains(&filename) {
        return Some(make(
            path,
            Relevance::Low,
            Category::Boilerplate,
            Risk::Cosmetic,
            "Lock file updated",
        ));
    }

    // 2. Generated/vendored code — machine output
    if is_generated(path, filename) {
        return Some(make(
            path,
            Relevance::Low,
            Category::Boilerplate,
            Risk::Cosmetic,
            "Generated file updated",
        ));
    }

    // 3. CI/CD pipeline config
    if is_ci_file(path) {
        return Some(make(
            path,
            Relevance::Low,
            Category::Config,
            Risk::Cosmetic,
            "CI/CD pipeline change",
        ));
    }

    // 4. Documentation and legal
    if is_doc_file(path, filename, ext) {
        return Some(make(
            path,
            Relevance::Low,
            Category::Style,
            Risk::Cosmetic,
            "Documentation updated",
        ));
    }

    // 5. Static assets (images, fonts, media)
    if is_asset(ext) {
        return Some(make(
            path,
            Relevance::Low,
            Category::Style,
            Risk::Cosmetic,
            "Static asset updated",
        ));
    }

    // 6. SQL migrations — ALWAYS high, schema changes need review
    if is_migration(path, ext) {
        return Some(make(
            path,
            Relevance::High,
            Category::Schema,
            Risk::BehavioralChange,
            "Database migration",
        ));
    }

    // 7. Config files with minor edits (≤5 lines)
    if CONFIG_FILES.contains(&filename) && additions + deletions <= 5 {
        return Some(make(
            path,
            Relevance::Low,
            Category::Config,
            Risk::Cosmetic,
            "Minor config change",
        ));
    }

    // 8. Formatting/linting config files
    if FORMAT_CONFIG_FILES.contains(&filename) {
        return Some(make(
            path,
            Relevance::Low,
            Category::Style,
            Risk::Cosmetic,
            "Formatting config updated",
        ));
    }

    // Not classifiable by heuristic — send to LLM for context-aware analysis
    None
}

// ---------------------------------------------------------------------------
// LLM classification
// ---------------------------------------------------------------------------

const MAX_LINES_PER_FILE: usize = 300;
const MAX_FILES_TO_LLM: usize = 30;
const LLM_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SummaryLine {
    summary: String,
}

#[derive(Deserialize)]
struct FileLine {
    path: String,
    relevance: Relevance,
    category: Category,
    risk: Risk,
    summary: String,
}

#[derive(Deserialize)]
struct FileFindingsLine {
    path: String,
    summary: String,
    findings: Vec<Finding>,
}

struct LlmParsed {
    summary: Option<String>,
    files: Vec<FileClassification>,
}

const DEFAULT_FINDING_CONFIDENCE_THRESHOLD: f32 = 0.7;

pub(crate) fn finding_confidence_threshold() -> f32 {
    std::env::var("TUIC_REVIEW_CONFIDENCE_THRESHOLD")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| (0.0..=1.0).contains(v))
        .unwrap_or(DEFAULT_FINDING_CONFIDENCE_THRESHOLD)
}

pub(crate) fn filter_findings_by_confidence(findings: &[Finding], threshold: f32) -> Vec<Finding> {
    findings
        .iter()
        .filter(|f| f.confidence.is_finite() && f.confidence >= threshold && f.confidence <= 1.0)
        .cloned()
        .collect()
}

pub(crate) fn relevance_from_findings(findings: &[Finding]) -> Relevance {
    if findings.iter().any(|f| f.severity == Severity::Bug) {
        Relevance::High
    } else if findings.iter().any(|f| f.severity == Severity::Risk) {
        Relevance::Medium
    } else {
        Relevance::Low
    }
}

fn category_risk_from_findings(findings: &[Finding]) -> (Category, Risk) {
    // Any actionable finding (bug or risk) marks the file as a behavioral change
    // in business logic; a file with only nits is cosmetic/style.
    if findings
        .iter()
        .any(|f| matches!(f.severity, Severity::Bug | Severity::Risk))
    {
        (Category::BusinessLogic, Risk::BehavioralChange)
    } else {
        (Category::Style, Risk::Cosmetic)
    }
}

fn classification_from_findings_line(f: FileFindingsLine) -> Option<FileClassification> {
    if f.findings.iter().any(|finding| {
        !finding.confidence.is_finite() || !(0.0..=1.0).contains(&finding.confidence)
    }) {
        return None;
    }
    let findings = filter_findings_by_confidence(&f.findings, finding_confidence_threshold());
    if findings.iter().any(|finding| finding.path != f.path) {
        return None;
    }
    let relevance = relevance_from_findings(&findings);
    let (category, risk) = category_risk_from_findings(&findings);
    Some(FileClassification {
        path: f.path,
        relevance,
        category,
        risk,
        summary: f.summary,
        findings,
        source: ClassificationSource::Llm,
        additions: 0,
        deletions: 0,
    })
}

/// Extract the JSON payload from a possibly fenced/prose-wrapped LLM response.
/// Shared by the triage JSONL parser, `changelog`, and `improvement_scan`.
pub(crate) fn extract_json(text: &str) -> &str {
    let trimmed = text.trim();
    // Strip markdown code fences: ```json\n{...}\n``` or ```\n{...}\n```
    if let Some(rest) = trimmed.strip_prefix("```") {
        let inner = rest.strip_prefix("json").unwrap_or(rest);
        let inner = inner.strip_suffix("```").unwrap_or(inner);
        return inner.trim();
    }
    // Find first '{' ... last '}' if the LLM added preamble/postamble text
    if let Some(start) = trimmed.find('{')
        && let Some(end) = trimmed.rfind('}')
        && end > start
    {
        return &trimmed[start..=end];
    }
    trimmed
}

fn parse_jsonl_line(line: &str) -> JsonlParsed {
    let json = extract_json(line);
    if json.is_empty() {
        return JsonlParsed::Skip;
    }
    if let Ok(s) = serde_json::from_str::<SummaryLine>(json)
        && !s.summary.is_empty()
    {
        return JsonlParsed::Summary(s.summary);
    }
    if let Ok(f) = serde_json::from_str::<FileLine>(json) {
        return JsonlParsed::File(FileClassification {
            path: f.path,
            relevance: f.relevance,
            category: f.category,
            risk: f.risk,
            summary: f.summary,
            findings: Vec::new(),
            source: ClassificationSource::Llm,
            additions: 0,
            deletions: 0,
        });
    }
    if let Ok(f) = serde_json::from_str::<FileFindingsLine>(json)
        && let Some(fc) = classification_from_findings_line(f)
    {
        return JsonlParsed::File(fc);
    }
    JsonlParsed::Skip
}

enum JsonlParsed {
    Summary(String),
    File(FileClassification),
    Skip,
}

// ---------------------------------------------------------------------------
// Diff content signal extraction — powers the fallback heuristic
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct DiffSignals {
    api_surface_added: u32,
    api_surface_removed: u32,
    test_signals: u32,
    schema_signals: u32,
    auth_signals: u32,
    hunk_context: Option<String>,
    hunk_count: u32,
}

fn analyze_diff(diff: &str) -> DiffSignals {
    let mut s = DiffSignals::default();
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("@@ ") {
            s.hunk_count += 1;
            if let Some(ctx) = rest.split("@@ ").nth(1) {
                let ctx = ctx.trim();
                if !ctx.is_empty() {
                    let name = ctx.split('(').next().unwrap_or(ctx).trim();
                    let name = name.split_whitespace().last().unwrap_or(name);
                    if !name.is_empty() && s.hunk_context.is_none() {
                        s.hunk_context = Some(name.to_string());
                    }
                }
            }
            continue;
        }
        let (added, content) = if let Some(rest) = line.strip_prefix('+') {
            (true, rest)
        } else if let Some(rest) = line.strip_prefix('-') {
            (false, rest)
        } else {
            continue;
        };
        let trimmed = content.trim_start();
        // API surface — Rust
        if trimmed.starts_with("pub fn ")
            || trimmed.starts_with("pub struct ")
            || trimmed.starts_with("pub enum ")
            || trimmed.starts_with("pub trait ")
            || trimmed.starts_with("pub type ")
            || trimmed.starts_with("pub mod ")
            || trimmed.starts_with("pub const ")
        {
            if added {
                s.api_surface_added += 1;
            } else {
                s.api_surface_removed += 1;
            }
        }
        // API surface — TS/JS
        if trimmed.starts_with("export ") {
            if added {
                s.api_surface_added += 1;
            } else {
                s.api_surface_removed += 1;
            }
        }
        // API surface — Go (exported = uppercase first letter after "func ")
        if let Some(rest) = trimmed.strip_prefix("func ") {
            let first = rest.chars().next().unwrap_or('a');
            if first.is_ascii_uppercase() {
                if added {
                    s.api_surface_added += 1;
                } else {
                    s.api_surface_removed += 1;
                }
            }
        }
        // API surface — Java
        if trimmed.starts_with("public ") || trimmed.starts_with("protected ") {
            if added {
                s.api_surface_added += 1;
            } else {
                s.api_surface_removed += 1;
            }
        }
        // Test signals
        if trimmed.contains("#[test]")
            || trimmed.contains("#[cfg(test)]")
            || trimmed.contains("describe(")
            || trimmed.contains("it(")
            || trimmed.contains("test(")
            || trimmed.contains("assert")
        {
            s.test_signals += 1;
        }
        // Schema/SQL signals
        let upper = trimmed.to_ascii_uppercase();
        if upper.starts_with("CREATE TABLE")
            || upper.starts_with("ALTER TABLE")
            || upper.starts_with("DROP ")
            || upper.starts_with("INSERT ")
            || upper.starts_with("UPDATE ")
            || upper.starts_with("DELETE ")
        {
            s.schema_signals += 1;
        }
        // Auth/security signals
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("password")
            || lower.contains("secret")
            || lower.contains("token")
            || lower.contains("encrypt")
            || lower.contains("decrypt")
            || lower.contains("auth")
        {
            s.auth_signals += 1;
        }
    }
    s
}

fn build_fallback_summary(signals: &DiffSignals, additions: u32, deletions: u32) -> String {
    let lines_str = format!("+{additions} -{deletions} lines");

    if signals.api_surface_removed > 0 {
        let ctx = signals
            .hunk_context
            .as_deref()
            .map(|c| format!(" in {c}"))
            .unwrap_or_default();
        return format!("Removed public API{ctx}; {lines_str}");
    }
    if signals.schema_signals > 0 {
        return format!("Schema change; {lines_str}");
    }
    if signals.api_surface_added > 0 {
        let n = signals.api_surface_added;
        let ctx = signals
            .hunk_context
            .as_deref()
            .map(|c| format!(" in {c}"))
            .unwrap_or_default();
        return format!(
            "{n} public symbol{}{ctx}; {lines_str}",
            if n == 1 { " added" } else { "s added" }
        );
    }
    if let Some(ctx) = signals.hunk_context.as_deref() {
        return format!("Changed {ctx}; {lines_str}");
    }
    let h = signals.hunk_count;
    format!("{lines_str} in {h} hunk{}", if h == 1 { "" } else { "s" })
}

fn fallback_classification(
    path: &str,
    diff: Option<&str>,
    additions: u32,
    deletions: u32,
) -> FileClassification {
    let filename = Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let ext = ext.as_str();

    let (mut category, mut risk) = if is_test_file(path, filename) {
        (Category::Test, Risk::BehavioralChange)
    } else if is_style_file(ext) {
        (Category::Style, Risk::Cosmetic)
    } else if is_ignore_file(filename) || CONFIG_FILES.contains(&filename) {
        (Category::Config, Risk::Cosmetic)
    } else {
        (Category::BusinessLogic, Risk::BehavioralChange)
    };

    let mut relevance = Relevance::Medium;
    let mut summary = String::new();

    if let Some(diff_text) = diff {
        let signals = analyze_diff(diff_text);

        // Priority chain: Schema > ApiSurface > Test > path-based default
        if signals.schema_signals > 0 {
            category = Category::Schema;
            risk = Risk::BehavioralChange;
            relevance = Relevance::High;
        } else if signals.api_surface_added > 0 || signals.api_surface_removed > 0 {
            category = Category::ApiSurface;
            relevance = Relevance::High;
            if signals.api_surface_removed > 0 {
                risk = Risk::BreakingChange;
            }
        } else if signals.test_signals > 0 && category != Category::Test {
            category = Category::Test;
        }

        if signals.auth_signals > 0 {
            relevance = Relevance::High;
            if risk == Risk::Cosmetic {
                risk = Risk::BehavioralChange;
            }
        }
        let total = additions.saturating_add(deletions);
        if total > 20
            && deletions > 0
            && (f64::from(deletions) / f64::from(total)) > 0.5
            && !matches!(
                category,
                Category::Style | Category::Test | Category::Config
            )
        {
            risk = Risk::BreakingChange;
        }

        summary = build_fallback_summary(&signals, additions, deletions);
    }

    FileClassification {
        path: path.to_string(),
        relevance,
        category,
        risk,
        summary,
        findings: Vec::new(),
        source: ClassificationSource::Heuristic,
        additions,
        deletions,
    }
}

fn is_test_file(path: &str, filename: &str) -> bool {
    path.contains("__tests__/")
        || path.contains("/__test__/")
        || filename.contains(".test.")
        || filename.contains(".spec.")
        || filename.ends_with("_test.go")
        || filename.ends_with("_test.rs")
}

fn is_style_file(ext: &str) -> bool {
    matches!(ext, "css" | "scss" | "sass" | "less" | "styl")
}

fn is_ignore_file(filename: &str) -> bool {
    filename.starts_with('.') && filename.ends_with("ignore")
}

pub(crate) fn default_system_prompt() -> &'static str {
    MULTI_TURN_SYSTEM_PROMPT
}

const MULTI_TURN_SYSTEM_PROMPT: &str = "\
You are a senior code reviewer triaging a changeset. \
I'll show the file list first, then each file's diff one at a time. \
Keep context across turns — relate files to each other.\n\n\
RESPONSES — always a single JSON line, nothing else:\n\n\
When I show the file list:\n\
{\"summary\": \"2-3 sentence changeset overview\"}\n\n\
When I show a file diff:\n\
{\"path\": \"...\", \"summary\": \"one sentence\", \"findings\": [\
{\"path\": \"...\", \"line\": 123, \"hunk\": \"optional hunk/context\", \
\"severity\": \"bug|risk|nit\", \"message\": \"actionable review finding\", \
\"confidence\": 0.0}]}\n\n\
Rules: findings are line-level and actionable. \
Use severity=bug for likely defects, risk for plausible regressions, nit for minor cleanup. \
Use confidence 0.0-1.0; omit low-confidence speculation by using confidence below 0.7. \
If no actionable finding exists, return an empty findings array. \
Relate files to each other. ONLY output the JSON line.";

/// Builds the overview user message for the first turn of a multi-turn session.
/// Includes file list + any heuristic-classified file names for context.
fn build_overview(llm_files: &[&str], heuristic_names: &[(&str, &str)]) -> String {
    let mut msg = String::from("Changeset overview — files to review:\n");
    for path in llm_files {
        msg.push_str(&format!("  {path}\n"));
    }
    if !heuristic_names.is_empty() {
        msg.push_str("\nPre-classified by heuristic (no diff needed):\n");
        for (path, category) in heuristic_names {
            msg.push_str(&format!("  {path}  [{category}]\n"));
        }
    }
    msg.push_str("\nRespond with the changeset summary JSON.");
    msg
}

/// Builds the user message for a single file turn.
fn build_file_msg(path: &str, diff: &str, additions: u32, deletions: u32) -> String {
    let lines: Vec<&str> = diff.lines().collect();
    let truncated = lines[..lines.len().min(MAX_LINES_PER_FILE)].join("\n");
    let truncation_note = if lines.len() > MAX_LINES_PER_FILE {
        format!("\n[... truncated at {} lines]", MAX_LINES_PER_FILE)
    } else {
        String::new()
    };
    format!(
        "<file path=\"{path}\" +{additions} -{deletions}>\n{truncated}{truncation_note}\n</file>\n\nReview this file and return line-level findings."
    )
}

pub(crate) fn split_unified_diff(diff: &str) -> Vec<UnifiedDiffFile> {
    let mut files = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_lines: Vec<String> = Vec::new();
    let mut additions = 0u32;
    let mut deletions = 0u32;

    let flush = |files: &mut Vec<UnifiedDiffFile>,
                 current_path: &mut Option<String>,
                 current_lines: &mut Vec<String>,
                 additions: &mut u32,
                 deletions: &mut u32| {
        if let Some(path) = current_path.take() {
            files.push(UnifiedDiffFile {
                path,
                diff: current_lines.join("\n"),
                additions: *additions,
                deletions: *deletions,
            });
        }
        current_lines.clear();
        *additions = 0;
        *deletions = 0;
    };

    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            flush(
                &mut files,
                &mut current_path,
                &mut current_lines,
                &mut additions,
                &mut deletions,
            );
            let path = rest
                .split_whitespace()
                .nth(1)
                .or_else(|| rest.split_whitespace().next())
                .unwrap_or("")
                .trim_start_matches("b/")
                .trim_start_matches("a/")
                .to_string();
            current_path = (!path.is_empty()).then_some(path);
        }
        if current_path.is_some() {
            if line.starts_with('+') && !line.starts_with("+++") {
                additions = additions.saturating_add(1);
            } else if line.starts_with('-') && !line.starts_with("---") {
                deletions = deletions.saturating_add(1);
            }
            current_lines.push(line.to_string());
        }
    }
    flush(
        &mut files,
        &mut current_path,
        &mut current_lines,
        &mut additions,
        &mut deletions,
    );
    files
}

/// Builds a ChatRequest from session history + a new user message, placing
/// CacheControl::Ephemeral on the system prompt, an optional midpoint message
/// (when history > 40 messages), and the final user message.
fn build_chat_request(
    session: &TriageSession,
    new_user_msg: &str,
    system_prompt: &str,
) -> genai::chat::ChatRequest {
    use genai::chat::{CacheControl, ChatMessage, ChatRequest, MessageOptions};

    // System message with cache hint — stable across turns
    let system_msg = ChatMessage::system(system_prompt)
        .with_options(MessageOptions::from(CacheControl::Ephemeral));
    let mut req = ChatRequest::default().append_message(system_msg);

    let midpoint = session.messages.len() / 2;
    for (i, msg) in session.messages.iter().enumerate() {
        let cm = match msg.role {
            MsgRole::User => ChatMessage::user(&msg.content),
            MsgRole::Assistant => ChatMessage::assistant(&msg.content),
        };
        // Add midpoint cache breakpoint for long sessions (> 40 messages)
        let cm = if session.messages.len() > 40 && i == midpoint {
            cm.with_options(MessageOptions::from(CacheControl::Ephemeral))
        } else {
            cm
        };
        req = req.append_message(cm);
    }

    let final_user =
        ChatMessage::user(new_user_msg).with_options(MessageOptions::from(CacheControl::Ephemeral));
    req.append_message(final_user)
}

// ---------------------------------------------------------------------------
// Tool definitions and dispatch for multi-turn triage
// ---------------------------------------------------------------------------

const MAX_READ_LINES: usize = 1000;

/// JSON schemas for tools the LLM can call during multi-turn triage.
pub fn triage_tool_definitions() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "read_file",
            "description": "Read the full content of a file in the repo. Use when a diff is truncated or you need more context to classify a file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Repo-relative file path"
                    }
                },
                "required": ["path"]
            }
        },
        {
            "name": "read_file_range",
            "description": "Read a specific line range from a file in the repo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Repo-relative file path"
                    },
                    "start_line": {
                        "type": "integer",
                        "description": "1-based start line (inclusive)"
                    },
                    "end_line": {
                        "type": "integer",
                        "description": "1-based end line (inclusive)"
                    }
                },
                "required": ["path", "start_line", "end_line"]
            }
        }
    ])
}

/// Dispatch a tool call synchronously. Safe to call from a blocking context.
/// Returns the tool result as a string (content or error message).
pub fn dispatch_tool(tool_name: &str, args: &serde_json::Value, repo_path: &str) -> String {
    match tool_name {
        "read_file" => {
            let Some(path) = args["path"].as_str() else {
                return "error: missing path argument".to_string();
            };
            read_file_impl(repo_path, path, None, None)
        }
        "read_file_range" => {
            let Some(path) = args["path"].as_str() else {
                return "error: missing path argument".to_string();
            };
            let start = args["start_line"].as_u64().map(|n| n as usize);
            let end = args["end_line"].as_u64().map(|n| n as usize);
            read_file_impl(repo_path, path, start, end)
        }
        _ => format!("error: unknown tool '{tool_name}'"),
    }
}

fn read_file_impl(
    repo_path: &str,
    path: &str,
    start_line: Option<usize>,
    end_line: Option<usize>,
) -> String {
    let repo_canonical = match std::fs::canonicalize(repo_path) {
        Ok(p) => p,
        Err(e) => return format!("error: cannot resolve repo path: {e}"),
    };
    let file_path = std::path::Path::new(repo_path).join(path);
    let file_canonical = match std::fs::canonicalize(&file_path) {
        Ok(p) => p,
        Err(e) => return format!("error: {e}"),
    };
    if !file_canonical.starts_with(&repo_canonical) {
        return "error: path outside repository".to_string();
    }

    let bytes = match std::fs::read(&file_canonical) {
        Ok(b) => b,
        Err(e) => return format!("error: {e}"),
    };

    if bytes.contains(&0u8) {
        return "error: binary file".to_string();
    }

    let text = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(_) => return "error: binary file".to_string(),
    };

    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();

    let (start, end) = match (start_line, end_line) {
        (Some(s), Some(e)) => {
            let s = s.saturating_sub(1).min(total);
            let e = e.min(total);
            (s, e)
        }
        _ => (0, total),
    };

    let selected = &lines[start..end];
    let truncate_at = selected.len().min(MAX_READ_LINES);
    let mut result = selected[..truncate_at].join("\n");
    if selected.len() > MAX_READ_LINES {
        result.push_str(&format!("\n[truncated at {MAX_READ_LINES} lines]"));
    }
    result
}

// ---------------------------------------------------------------------------
// Multi-turn classification engine
// ---------------------------------------------------------------------------

const MAX_TOOL_CALLS_PER_TURN: usize = 3;

fn build_genai_tools() -> Vec<genai::chat::Tool> {
    let defs = triage_tool_definitions();
    defs.as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|t| {
            let name = t["name"].as_str()?;
            let mut tool = genai::chat::Tool::new(name);
            if let Some(desc) = t["description"].as_str() {
                tool = tool.with_description(desc);
            }
            if let Some(schema) = t.get("inputSchema") {
                tool = tool.with_schema(schema.clone());
            }
            Some(tool)
        })
        .collect()
}

/// Execute a single LLM turn: send user message, handle up to MAX_TOOL_CALLS_PER_TURN
/// tool call round-trips, return the final text response. Updates session.messages.
async fn do_turn(
    client: &genai::Client,
    model: &str,
    session: &mut TriageSession,
    user_msg: String,
    repo_path: &str,
    tools: &[genai::chat::Tool],
    system_prompt: &str,
) -> Option<String> {
    use genai::chat::{ChatOptions, ToolResponse};

    let chat_options = ChatOptions::default().with_capture_tool_calls(true);
    let mut req = build_chat_request(session, &user_msg, system_prompt).with_tools(tools.to_vec());

    for _ in 0..=MAX_TOOL_CALLS_PER_TURN {
        let response = match tokio::time::timeout(
            LLM_TIMEOUT,
            client.exec_chat(model, req.clone(), Some(&chat_options)),
        )
        .await
        {
            Ok(Ok(resp)) => resp,
            _ => return None,
        };

        let text = response.first_text().map(|s| s.to_string());
        let tool_calls = response.into_tool_calls();

        if tool_calls.is_empty() {
            session.messages.push(SessionMsg {
                role: MsgRole::User,
                content: user_msg,
            });
            if let Some(ref t) = text {
                session.messages.push(SessionMsg {
                    role: MsgRole::Assistant,
                    content: t.clone(),
                });
            }
            return text;
        }

        req = req.append_message(tool_calls.clone());
        for tc in &tool_calls {
            let output = dispatch_tool(&tc.fn_name, &tc.fn_arguments, repo_path);
            req = req.append_message(ToolResponse::new(&tc.call_id, output));
        }
    }

    session.messages.push(SessionMsg {
        role: MsgRole::User,
        content: user_msg,
    });
    None
}

/// Where per-file review progress is streamed. The multi-turn engine is shared
/// between working-tree triage and PR review; only the emitted event differs.
#[cfg(feature = "desktop")]
enum ProgressSink<'a> {
    /// Working-tree triage → `DiffTriageProgress` ("triage-progress").
    Triage { app: &'a tauri::AppHandle },
    /// PR review → `ReviewProgress` ("review-progress"), keyed by PR number so
    /// it never pollutes the working-tree triage panel.
    PrReview {
        app: Option<&'a tauri::AppHandle>,
        state: &'a crate::AppState,
        pr_number: i64,
    },
}

#[cfg(feature = "desktop")]
impl ProgressSink<'_> {
    #[allow(clippy::too_many_arguments)]
    fn emit(
        &self,
        repo_path: &str,
        summary: Option<&str>,
        files: &[FileClassification],
        phase: &'static str,
        done: bool,
        llm_used: bool,
        llm_model: Option<&str>,
    ) {
        match self {
            ProgressSink::Triage { app } => {
                emit_progress(
                    app, repo_path, summary, files, phase, done, llm_used, llm_model,
                );
            }
            ProgressSink::PrReview {
                app,
                state,
                pr_number,
            } => {
                let payload = serde_json::json!({
                    "pr_number": pr_number,
                    "summary": summary,
                    "files": files,
                    "phase": phase,
                    "done": done,
                    "llm_used": llm_used,
                    "llm_model": llm_model,
                });
                // Desktop window event (native listener), if a handle exists.
                if let Some(app) = app {
                    let _ = app.emit(
                        "review-progress",
                        serde_json::json!({ "repo_path": repo_path, "payload": payload }),
                    );
                }
                // Event bus → SSE bridge (browser/PWA parity). Dual-emit: there
                // is no bus→window forwarder, so both paths are required.
                let _ = state
                    .event_bus
                    .send(crate::state::AppEvent::ReviewProgress {
                        repo_path: repo_path.to_string(),
                        payload,
                    });
            }
        }
    }
}

#[cfg(feature = "desktop")]
/// Multi-turn LLM classification: overview turn + per-file turns with tool use.
/// Skips unchanged files (hash match). Updates session in place.
#[allow(clippy::too_many_arguments)]
async fn classify_multi_turn(
    client: &genai::Client,
    model: &str,
    session: &mut TriageSession,
    files: &[(String, String, u32, u32)],
    heuristic_names: &[(&str, &str)],
    sink: &ProgressSink<'_>,
    repo_path: &str,
    stats: &HashMap<&str, (u32, u32)>,
    system_prompt: &str,
) -> LlmParsed {
    let tools = build_genai_tools();
    let file_paths: Vec<&str> = files.iter().map(|(p, _, _, _)| p.as_str()).collect();

    // Detect file-set change and reset summary so LLM gets a fresh overview
    let mut fsh = std::collections::hash_map::DefaultHasher::new();
    for p in &file_paths {
        p.hash(&mut fsh);
    }
    let current_fsh = fsh.finish();
    if current_fsh != session.file_set_hash {
        session.summary = None;
        session.file_set_hash = current_fsh;
    }

    if session.summary.is_none() {
        let overview_msg = build_overview(&file_paths, heuristic_names);
        if let Some(text) = do_turn(
            client,
            model,
            session,
            overview_msg,
            repo_path,
            &tools,
            system_prompt,
        )
        .await
            && let JsonlParsed::Summary(s) = parse_jsonl_line(&text)
        {
            session.summary = Some(s.clone());
            sink.emit(
                repo_path,
                Some(&s),
                &[],
                "llm-overview",
                false,
                true,
                Some(model),
            );
        }
    }

    let mut classified = Vec::new();

    for (path, diff, additions, deletions) in files {
        let h = hash_diff(diff);

        if session.file_hashes.get(path.as_str()).copied() == Some(h)
            && let Some(cached) = session.classifications.get(path.as_str())
        {
            let mut fc = cached.clone();
            fc.additions = *additions;
            fc.deletions = *deletions;
            sink.emit(
                repo_path,
                session.summary.as_deref(),
                &[fc.clone()],
                "cached",
                false,
                true,
                Some(model),
            );
            classified.push(fc);
            continue;
        }

        let file_msg = build_file_msg(path, diff, *additions, *deletions);
        let mut fc = match do_turn(
            client,
            model,
            session,
            file_msg,
            repo_path,
            &tools,
            system_prompt,
        )
        .await
        {
            Some(text) => match parse_jsonl_line(&text) {
                JsonlParsed::File(mut fc) => {
                    fc.path = path.clone();
                    fc.additions = *additions;
                    fc.deletions = *deletions;
                    fc
                }
                _ => {
                    tracing::warn!(
                        "triage: LLM response for {path} did not parse as file classification: {text:?}"
                    );
                    fallback_classification(path, Some(diff), *additions, *deletions)
                }
            },
            None => {
                tracing::warn!("triage: LLM returned no response for {path} (timeout or error)");
                fallback_classification(path, Some(diff), *additions, *deletions)
            }
        };

        if let Some(&(a, d)) = stats.get(fc.path.as_str()) {
            fc.additions = a;
            fc.deletions = d;
        }

        let phase = if fc.source == ClassificationSource::Llm {
            session.file_hashes.insert(path.clone(), h);
            session.classifications.insert(path.clone(), fc.clone());
            "llm-file"
        } else {
            "fallback"
        };
        sink.emit(
            repo_path,
            session.summary.as_deref(),
            &[fc.clone()],
            phase,
            false,
            true,
            Some(model),
        );
        classified.push(fc);
    }

    LlmParsed {
        summary: session.summary.clone(),
        files: classified,
    }
}

#[cfg(feature = "desktop")]
#[derive(Debug, Clone, Serialize)]
struct TriageProgress {
    repo_path: String,
    summary: Option<String>,
    files: Vec<FileClassification>,
    phase: &'static str,
    done: bool,
    llm_used: bool,
    llm_model: Option<String>,
}

#[cfg(feature = "desktop")]
#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &tauri::AppHandle,
    repo_path: &str,
    summary: Option<&str>,
    files: &[FileClassification],
    phase: &'static str,
    done: bool,
    llm_used: bool,
    llm_model: Option<&str>,
) {
    // Desktop window event (native Tauri listener).
    let _ = app.emit(
        "triage-progress",
        TriageProgress {
            repo_path: repo_path.to_string(),
            summary: summary.map(String::from),
            files: files.to_vec(),
            phase,
            done,
            llm_used,
            llm_model: llm_model.map(String::from),
        },
    );
    // Event bus → SSE bridge (browser/PWA parity). Dual-emit: there is no
    // bus→window forwarder, so both paths are required.
    use tauri::Manager;
    let state = app.state::<std::sync::Arc<crate::AppState>>();
    let _ = state
        .event_bus
        .send(crate::state::AppEvent::DiffTriageProgress {
            repo_path: repo_path.to_string(),
            summary: summary.map(String::from),
            files: files.to_vec(),
            phase: phase.to_string(),
            done,
            llm_used,
            llm_model: llm_model.map(String::from),
        });
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn run_diff_triage(
    app: tauri::AppHandle,
    repo_path: String,
    refresh: Option<bool>,
) -> Result<TriageResult, String> {
    let changed_files = crate::git::get_changed_files(repo_path.clone(), None).await?;
    if changed_files.is_empty() {
        if let Ok(mut sessions) = triage_sessions().lock() {
            sessions.remove(&repo_path);
        }
        emit_progress(&app, &repo_path, None, &[], "done", true, false, None);
        return Ok(TriageResult {
            summary: None,
            files: vec![],
            llm_used: false,
            llm_model: None,
        });
    }

    let mut heuristic: Vec<FileClassification> = Vec::new();
    let mut needs_llm: Vec<(String, u32, u32, bool)> = Vec::new();

    for f in &changed_files {
        if let Some(c) = heuristic_classify(&f.path, f.additions, f.deletions) {
            heuristic.push(c);
        } else {
            let is_untracked = f.status == "?";
            needs_llm.push((f.path.clone(), f.additions, f.deletions, is_untracked));
        }
    }

    let stats: HashMap<&str, (u32, u32)> = changed_files
        .iter()
        .map(|f| (f.path.as_str(), (f.additions, f.deletions)))
        .collect();
    for c in &mut heuristic {
        if let Some(&(a, d)) = stats.get(c.path.as_str()) {
            c.additions = a;
            c.deletions = d;
        }
    }

    // Emit heuristic results immediately so UI is responsive
    if !heuristic.is_empty() {
        emit_progress(
            &app,
            &repo_path,
            None,
            &heuristic,
            if needs_llm.is_empty() {
                "done"
            } else {
                "heuristic"
            },
            needs_llm.is_empty(),
            false,
            None,
        );
    }

    if needs_llm.is_empty() {
        heuristic.sort_by_key(|a| a.relevance);
        return Ok(TriageResult {
            summary: None,
            files: heuristic,
            llm_used: false,
            llm_model: None,
        });
    }

    // Resolve LLM provider early — if not configured, abort instead of faking results
    let registry = crate::provider_registry::load_registry();
    let resolved_slot = crate::provider_registry::resolve_slot(
        &registry,
        crate::provider_registry::SlotName::Triage,
    );
    let resolved = resolved_slot.map_err(|e| {
        format!("No AI provider configured for triage. Set the Triage slot in Settings → Providers. ({e})")
    })?;
    let model_name_for_session = resolved.config.model.clone();

    // Fetch all diffs in a single git call (1 subprocess, not N)
    let llm_candidates: Vec<_> = needs_llm.iter().take(MAX_FILES_TO_LLM).collect();
    let bulk_files: Vec<(String, bool)> = llm_candidates
        .iter()
        .map(|(path, _, _, is_untracked)| (path.clone(), *is_untracked))
        .collect();
    let all_diffs = match crate::git::get_bulk_diffs(repo_path.clone(), bulk_files).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("triage: get_bulk_diffs failed, proceeding without diffs: {e}");
            Default::default()
        }
    };

    // Take existing session (invalidate first if refresh=true), or create fresh
    let mut session = {
        let mut sessions = triage_sessions().lock().unwrap_or_else(|e| e.into_inner());
        if refresh.unwrap_or(false) {
            sessions.remove(&repo_path);
        }
        if sessions
            .get(&repo_path)
            .is_some_and(|s| s.is_valid(&model_name_for_session))
        {
            sessions
                .remove(&repo_path)
                .unwrap_or_else(|| TriageSession::new(model_name_for_session.clone()))
        } else {
            sessions.remove(&repo_path);
            TriageSession::new(model_name_for_session.clone())
        }
    };

    // Build (path, diff, additions, deletions) for all LLM candidates
    let files_with_diffs: Vec<(String, String, u32, u32)> = llm_candidates
        .iter()
        .map(|(path, additions, deletions, _)| {
            let diff = all_diffs.get(path).cloned().unwrap_or_default();
            (path.to_string(), diff, *additions, *deletions)
        })
        .collect();

    // Heuristic context for the overview turn: (path, category label)
    let heuristic_labels: Vec<(String, String)> = heuristic
        .iter()
        .map(|c| {
            let label = serde_json::to_value(c.category)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            (c.path.clone(), label)
        })
        .collect();
    let heuristic_names: Vec<(&str, &str)> = heuristic_labels
        .iter()
        .map(|(p, l)| (p.as_str(), l.as_str()))
        .collect();

    let mut all_classified = heuristic;

    let client = crate::llm_api::build_client(&resolved.config, &resolved.api_key);
    let model_name = resolved.config.model.clone();

    let prompts_config = crate::config::load_ai_prompts();
    let system_prompt = prompts_config
        .diff_triage_system_prompt
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(MULTI_TURN_SYSTEM_PROMPT);

    let parsed = classify_multi_turn(
        &client,
        &model_name,
        &mut session,
        &files_with_diffs,
        &heuristic_names,
        &ProgressSink::Triage { app: &app },
        &repo_path,
        &stats,
        system_prompt,
    )
    .await;

    let changeset_summary = parsed.summary.clone();
    emit_progress(
        &app,
        &repo_path,
        changeset_summary.as_deref(),
        &[],
        "done",
        true,
        true,
        Some(&model_name),
    );
    all_classified.extend(parsed.files);

    // Prune session entries for files no longer in the changeset
    let current_paths: std::collections::HashSet<&str> =
        changed_files.iter().map(|f| f.path.as_str()).collect();
    session
        .file_hashes
        .retain(|k, _| current_paths.contains(k.as_str()));
    session
        .classifications
        .retain(|k, _| current_paths.contains(k.as_str()));

    // Store session back
    if let Ok(mut sessions) = triage_sessions().lock() {
        sessions.insert(repo_path.clone(), session);
    }

    for (path, additions, deletions, _) in needs_llm.iter().skip(MAX_FILES_TO_LLM) {
        all_classified.push(fallback_classification(path, None, *additions, *deletions));
    }

    for c in &mut all_classified {
        if let Some(&(a, d)) = stats.get(c.path.as_str()) {
            c.additions = a;
            c.deletions = d;
        }
    }

    all_classified.sort_by_key(|a| a.relevance);
    Ok(TriageResult {
        summary: changeset_summary,
        files: all_classified,
        llm_used: true,
        llm_model: Some(model_name),
    })
}

/// Review a PR's unified diff with the same multi-turn engine as working-tree
/// triage, but on the **Main** slot. The diff is fetched once, split per file,
/// heuristic-filtered (boilerplate skips the LLM), and the remainder fed to the
/// engine. The multi-turn session is keyed by `(repo, pr_number)` — one entry
/// per open PR — with `head_sha` (a content hash of the diff) tracked on the
/// session itself rather than in the key: a re-review of an unchanged head
/// reuses context and the per-file hash cache for free, while a new commit
/// (different head_sha) discards the stale conversation and starts fresh
/// under the same key, keeping the session map bounded by open-PR count.
#[cfg(feature = "desktop")]
pub(crate) async fn run_pr_review_impl(
    repo_path: String,
    pr_number: i64,
    state: &crate::AppState,
) -> Result<PrReviewResult, String> {
    let diff = crate::github::get_pr_diff_impl(&repo_path, pr_number, state).await?;
    let head_sha = format!("{:016x}", hash_diff(&diff));

    // Split + heuristic pre-filter (shared with working-tree triage).
    let mut heuristic: Vec<FileClassification> = Vec::new();
    let mut needs_llm: Vec<(String, String, u32, u32)> = Vec::new();
    for f in split_unified_diff(&diff) {
        if let Some(c) = heuristic_classify(&f.path, f.additions, f.deletions) {
            heuristic.push(c);
        } else {
            needs_llm.push((f.path, f.diff, f.additions, f.deletions));
        }
    }

    // Nothing needs the LLM (pure boilerplate / empty diff) — return heuristics.
    if needs_llm.is_empty() {
        heuristic.sort_by_key(|a| a.relevance);
        let n = heuristic.len();
        return Ok(PrReviewResult {
            repo_path,
            pr_number,
            head_sha,
            summary: Some(format!(
                "Reviewed {n} file{}",
                if n == 1 { "" } else { "s" }
            )),
            files: heuristic,
            llm_used: false,
            llm_model: None,
        });
    }

    // Resolve the Main slot — PR review is an on-demand, higher-quality pass.
    let registry = crate::provider_registry::load_registry();
    let resolved = crate::provider_registry::resolve_slot(
        &registry,
        crate::provider_registry::SlotName::Main,
    )
    .map_err(|e| {
        format!(
            "No AI provider configured for review. Set the Main slot in Settings → Providers. ({e})"
        )
    })?;
    let model_name = resolved.config.model.clone();

    // Files beyond the per-pass cap fall back to heuristic classification so the
    // result still lists every changed file (matches working-tree triage).
    let llm_files: Vec<(String, String, u32, u32)> =
        needs_llm.iter().take(MAX_FILES_TO_LLM).cloned().collect();
    let overflow: Vec<FileClassification> = needs_llm
        .iter()
        .skip(MAX_FILES_TO_LLM)
        .map(|(path, d, a, del)| fallback_classification(path, Some(d), *a, *del))
        .collect();

    let stats: HashMap<&str, (u32, u32)> = llm_files
        .iter()
        .map(|(p, _, a, d)| (p.as_str(), (*a, *d)))
        .collect();
    let heuristic_labels: Vec<(String, String)> = heuristic
        .iter()
        .map(|c| {
            let label = serde_json::to_value(c.category)
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            (c.path.clone(), label)
        })
        .collect();
    let heuristic_names: Vec<(&str, &str)> = heuristic_labels
        .iter()
        .map(|(p, l)| (p.as_str(), l.as_str()))
        .collect();

    // Reuse the multi-turn session for this (repo, pr) if fresh AND still on
    // the same head_sha — a new commit on the PR invalidates the cached
    // conversation just like a stale model/TTL would, and the fresh session
    // overwrites the same key rather than leaking a new one.
    let session_key = pr_review_session_key(&repo_path, pr_number);
    let mut session = {
        let mut sessions = pr_review_sessions()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if sessions.get(&session_key).is_some_and(|s| {
            s.is_valid(&model_name) && s.head_sha.as_deref() == Some(head_sha.as_str())
        }) {
            sessions
                .remove(&session_key)
                .unwrap_or_else(|| TriageSession::new(model_name.clone()))
        } else {
            sessions.remove(&session_key);
            TriageSession::new(model_name.clone())
        }
    };
    session.head_sha = Some(head_sha.clone());

    let client = crate::llm_api::build_client(&resolved.config, &resolved.api_key);
    let prompts_config = crate::config::load_ai_prompts();
    let system_prompt = prompts_config
        .diff_triage_system_prompt
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(MULTI_TURN_SYSTEM_PROMPT);

    let app = state.app_handle.read().clone();
    let sink = ProgressSink::PrReview {
        app: app.as_ref(),
        state,
        pr_number,
    };

    let parsed = classify_multi_turn(
        &client,
        &model_name,
        &mut session,
        &llm_files,
        &heuristic_names,
        &sink,
        &repo_path,
        &stats,
        system_prompt,
    )
    .await;

    // Prune session entries for files no longer in this PR, then store it back.
    let current_paths: std::collections::HashSet<&str> =
        llm_files.iter().map(|(p, _, _, _)| p.as_str()).collect();
    session
        .file_hashes
        .retain(|k, _| current_paths.contains(k.as_str()));
    session
        .classifications
        .retain(|k, _| current_paths.contains(k.as_str()));
    if let Ok(mut sessions) = pr_review_sessions().lock() {
        sessions.insert(session_key, session);
    }

    let summary = parsed.summary.clone();
    let mut files = heuristic;
    files.extend(parsed.files);
    files.extend(overflow);
    files.sort_by_key(|a| a.relevance);

    sink.emit(
        &repo_path,
        summary.as_deref(),
        &[],
        "done",
        true,
        true,
        Some(&model_name),
    );

    Ok(PrReviewResult {
        repo_path,
        pr_number,
        head_sha,
        summary,
        files,
        llm_used: true,
        llm_model: Some(model_name),
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn run_pr_review(
    repo_path: String,
    pr_number: i64,
    state: State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<PrReviewResult, String> {
    let state = state.inner().clone();
    run_pr_review_impl(repo_path, pr_number, &state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classify(path: &str) -> Option<FileClassification> {
        heuristic_classify(path, 10, 5)
    }

    #[test]
    fn lock_files_are_boilerplate() {
        for path in &[
            "Cargo.lock",
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock",
            "some/nested/Cargo.lock",
        ] {
            let c = classify(path).unwrap_or_else(|| panic!("expected classification for {path}"));
            assert_eq!(c.relevance, Relevance::Low, "{path}");
            assert_eq!(c.category, Category::Boilerplate, "{path}");
            assert_eq!(c.risk, Risk::Cosmetic, "{path}");
        }
    }

    #[test]
    fn test_files_go_to_llm() {
        for path in &[
            "src/__tests__/foo.test.ts",
            "src/components/Terminal.test.tsx",
            "src-tauri/src/pty_test.rs",
            "tests/integration_test.rs",
            "spec/models/user_spec.rb",
        ] {
            assert!(
                classify(path).is_none(),
                "{path} should go to LLM for context-aware classification"
            );
        }
    }

    #[test]
    fn ci_files_are_low_config() {
        for path in &[
            ".github/workflows/ci.yml",
            ".github/actions/setup/action.yml",
            ".circleci/config.yml",
        ] {
            let c = classify(path).unwrap_or_else(|| panic!("expected classification for {path}"));
            assert_eq!(c.relevance, Relevance::Low, "{path}");
            assert_eq!(c.category, Category::Config, "{path}");
        }
    }

    #[test]
    fn doc_files_are_low_style() {
        for path in &[
            "README.md",
            "docs/architecture.md",
            "CHANGELOG.md",
            "LICENSE",
            "CONTRIBUTING.md",
            "notes.txt",
        ] {
            let c = classify(path).unwrap_or_else(|| panic!("expected classification for {path}"));
            assert_eq!(c.relevance, Relevance::Low, "{path}");
            assert_eq!(c.category, Category::Style, "{path}");
        }
    }

    #[test]
    fn asset_files_are_low_style() {
        for path in &[
            "src/assets/logo.png",
            "public/favicon.ico",
            "fonts/Inter.woff2",
            "docs/screenshot.jpg",
        ] {
            let c = classify(path).unwrap_or_else(|| panic!("expected classification for {path}"));
            assert_eq!(c.relevance, Relevance::Low, "{path}");
            assert_eq!(c.category, Category::Style, "{path}");
        }
    }

    #[test]
    fn format_config_files_are_low() {
        for path in &[
            "rustfmt.toml",
            ".prettierrc",
            ".prettierignore",
            ".editorconfig",
        ] {
            let c = classify(path).unwrap_or_else(|| panic!("expected classification for {path}"));
            assert_eq!(c.relevance, Relevance::Low, "{path}");
            assert_eq!(c.category, Category::Style, "{path}");
        }
    }

    #[test]
    fn migrations_are_high_relevance() {
        for path in &[
            "migrations/001_create_users.sql",
            "db/migrations/20260428_add_column.sql",
            "migration/schema.sql",
        ] {
            let c = classify(path).unwrap_or_else(|| panic!("expected classification for {path}"));
            assert_eq!(c.relevance, Relevance::High, "{path}");
            assert_eq!(c.category, Category::Schema, "{path}");
            assert_eq!(c.risk, Risk::BehavioralChange, "{path}");
        }
    }

    #[test]
    fn generated_files_are_boilerplate() {
        for path in &[
            "proto/__generated__/api.ts",
            "src/generated/types.ts",
            "api/service.pb.go",
            "src/bindings.pb.rs",
            "lib/models.g.dart",
        ] {
            let c = classify(path).unwrap_or_else(|| panic!("expected classification for {path}"));
            assert_eq!(c.relevance, Relevance::Low, "{path}");
            assert_eq!(c.category, Category::Boilerplate, "{path}");
        }
    }

    #[test]
    fn small_config_changes_are_low_relevance() {
        let c = heuristic_classify("Cargo.toml", 2, 1).expect("should classify");
        assert_eq!(c.relevance, Relevance::Low);
        assert_eq!(c.category, Category::Config);
        assert_eq!(c.risk, Risk::Cosmetic);

        let c = heuristic_classify("package.json", 1, 1).expect("should classify");
        assert_eq!(c.category, Category::Config);
    }

    #[test]
    fn large_config_changes_need_llm() {
        assert!(
            heuristic_classify("Cargo.toml", 20, 10).is_none(),
            "large config change should need LLM"
        );
        assert!(
            heuristic_classify("package.json", 50, 0).is_none(),
            "large package.json change should need LLM"
        );
    }

    #[test]
    fn source_files_go_to_llm() {
        assert!(classify("src/main.rs").is_none());
        assert!(classify("src/components/App.tsx").is_none());
        assert!(classify("src-tauri/src/git.rs").is_none());
        assert!(classify("lib/utils/parser.go").is_none());
    }

    #[test]
    fn all_heuristic_results_have_heuristic_source() {
        let paths = &[
            "Cargo.lock",
            "migrations/001.sql",
            "proto/__generated__/api.ts",
            "README.md",
            ".github/workflows/ci.yml",
        ];
        for path in paths {
            let c = classify(path).unwrap();
            assert_eq!(c.source, ClassificationSource::Heuristic, "{path}");
        }
    }

    #[test]
    fn non_sql_migrations_need_llm() {
        assert!(
            classify("migrations/001_create_users.py").is_none(),
            "non-SQL migration should need LLM"
        );
    }

    #[test]
    fn path_is_preserved_in_classification() {
        let c = classify("deep/nested/path/Cargo.lock").unwrap();
        assert_eq!(c.path, "deep/nested/path/Cargo.lock");
    }

    #[test]
    fn parse_jsonl_summary_line() {
        match parse_jsonl_line(r#"{"summary": "Refactored config API"}"#) {
            JsonlParsed::Summary(s) => assert_eq!(s, "Refactored config API"),
            _ => panic!("expected Summary"),
        }
    }

    #[test]
    fn parse_jsonl_file_line() {
        let line = r#"{"path": "src/config.rs", "relevance": "high", "category": "api-surface", "risk": "breaking-change", "summary": "Changed public API"}"#;
        match parse_jsonl_line(line) {
            JsonlParsed::File(fc) => {
                assert_eq!(fc.path, "src/config.rs");
                assert_eq!(fc.relevance, Relevance::High);
                assert_eq!(fc.category, Category::ApiSurface);
                assert_eq!(fc.risk, Risk::BreakingChange);
                assert!(fc.findings.is_empty());
                assert_eq!(fc.source, ClassificationSource::Llm);
            }
            _ => panic!("expected File"),
        }
    }

    #[test]
    fn parse_jsonl_findings_line() {
        let line = r#"{"path":"src/config.rs","summary":"Found one issue","findings":[{"path":"src/config.rs","line":42,"hunk":"@@ fn load @@","severity":"bug","message":"Missing error handling","confidence":0.91},{"path":"src/config.rs","line":50,"hunk":null,"severity":"nit","message":"Rename temp var","confidence":0.61}]}"#;
        match parse_jsonl_line(line) {
            JsonlParsed::File(fc) => {
                assert_eq!(fc.path, "src/config.rs");
                assert_eq!(fc.summary, "Found one issue");
                assert_eq!(fc.relevance, Relevance::High);
                assert_eq!(fc.category, Category::BusinessLogic);
                assert_eq!(fc.risk, Risk::BehavioralChange);
                assert_eq!(fc.findings.len(), 1, "confidence gate keeps >=0.7 only");
                assert_eq!(fc.findings[0].severity, Severity::Bug);
            }
            _ => panic!("expected findings file"),
        }
    }

    #[test]
    fn parse_jsonl_findings_rejects_bad_severity_and_confidence() {
        assert!(matches!(
            parse_jsonl_line(
                r#"{"path":"a.rs","summary":"x","findings":[{"path":"a.rs","line":1,"hunk":null,"severity":"oops","message":"x","confidence":0.9}]}"#
            ),
            JsonlParsed::Skip
        ));
        assert!(matches!(
            parse_jsonl_line(
                r#"{"path":"a.rs","summary":"x","findings":[{"path":"a.rs","line":1,"hunk":null,"severity":"risk","message":"x","confidence":1.2}]}"#
            ),
            JsonlParsed::Skip
        ));
    }

    #[test]
    fn parse_jsonl_rejects_findings_with_mismatched_path() {
        // Nested finding declares a path different from the outer file's
        // `path` — reject the line rather than silently attributing the
        // finding to the wrong file. Confidence (0.9) is kept well above the
        // default 0.7 gate so the finding survives the confidence filter and
        // actually reaches the path-mismatch guard.
        assert!(matches!(
            parse_jsonl_line(
                r#"{"path":"a.rs","summary":"x","findings":[{"path":"b.rs","line":1,"hunk":null,"severity":"bug","message":"x","confidence":0.9}]}"#
            ),
            JsonlParsed::Skip
        ));
    }

    #[test]
    fn findings_all_below_confidence_or_nit_only_yields_style_cosmetic() {
        // Every finding is below the confidence gate — filtered out entirely,
        // but the file classification itself must still come through as
        // Style/Cosmetic with an empty findings list (not dropped).
        match parse_jsonl_line(
            r#"{"path":"a.rs","summary":"low confidence","findings":[{"path":"a.rs","line":1,"hunk":null,"severity":"bug","message":"x","confidence":0.2}]}"#,
        ) {
            JsonlParsed::File(fc) => {
                assert!(
                    fc.findings.is_empty(),
                    "below-threshold finding must be filtered out"
                );
                assert_eq!(fc.category, Category::Style);
                assert_eq!(fc.risk, Risk::Cosmetic);
                assert_eq!(fc.relevance, Relevance::Low);
            }
            _ => panic!("expected File even when all findings are filtered out"),
        }

        // Every remaining finding is Nit severity (still above the confidence
        // gate) — nits alone are style/cosmetic, not business-logic.
        match parse_jsonl_line(
            r#"{"path":"b.rs","summary":"nit only","findings":[{"path":"b.rs","line":2,"hunk":null,"severity":"nit","message":"y","confidence":0.95}]}"#,
        ) {
            JsonlParsed::File(fc) => {
                assert_eq!(fc.findings.len(), 1, "nit finding above threshold is kept");
                assert_eq!(fc.category, Category::Style);
                assert_eq!(fc.risk, Risk::Cosmetic);
            }
            _ => panic!("expected File for nit-only findings"),
        }
    }

    // --- finding_confidence_threshold tests ---
    // Must run serially: TUIC_REVIEW_CONFIDENCE_THRESHOLD is process-global
    // env state (same pattern as resolve_github_token's env-var tests).

    #[test]
    #[serial_test::serial]
    fn finding_confidence_threshold_valid_override() {
        unsafe {
            std::env::set_var("TUIC_REVIEW_CONFIDENCE_THRESHOLD", "0.4");
        }
        assert_eq!(finding_confidence_threshold(), 0.4);
        unsafe {
            std::env::remove_var("TUIC_REVIEW_CONFIDENCE_THRESHOLD");
        }
    }

    #[test]
    #[serial_test::serial]
    fn finding_confidence_threshold_out_of_range_falls_back_to_default() {
        unsafe {
            std::env::set_var("TUIC_REVIEW_CONFIDENCE_THRESHOLD", "1.5");
        }
        assert_eq!(
            finding_confidence_threshold(),
            DEFAULT_FINDING_CONFIDENCE_THRESHOLD
        );

        unsafe {
            std::env::set_var("TUIC_REVIEW_CONFIDENCE_THRESHOLD", "-0.1");
        }
        assert_eq!(
            finding_confidence_threshold(),
            DEFAULT_FINDING_CONFIDENCE_THRESHOLD
        );

        unsafe {
            std::env::remove_var("TUIC_REVIEW_CONFIDENCE_THRESHOLD");
        }
    }

    #[test]
    #[serial_test::serial]
    fn finding_confidence_threshold_unparseable_falls_back_to_default() {
        unsafe {
            std::env::set_var("TUIC_REVIEW_CONFIDENCE_THRESHOLD", "not-a-number");
        }
        assert_eq!(
            finding_confidence_threshold(),
            DEFAULT_FINDING_CONFIDENCE_THRESHOLD
        );
        unsafe {
            std::env::remove_var("TUIC_REVIEW_CONFIDENCE_THRESHOLD");
        }
    }

    #[test]
    fn relevance_from_findings_maps_highest_severity() {
        let mk = |severity| Finding {
            path: "a.rs".to_string(),
            line: Some(1),
            hunk: None,
            severity,
            message: "x".to_string(),
            confidence: 0.9,
        };
        assert_eq!(
            relevance_from_findings(&[mk(Severity::Nit)]),
            Relevance::Low
        );
        assert_eq!(
            relevance_from_findings(&[mk(Severity::Nit), mk(Severity::Risk)]),
            Relevance::Medium
        );
        assert_eq!(
            relevance_from_findings(&[mk(Severity::Risk), mk(Severity::Bug)]),
            Relevance::High
        );
    }

    #[test]
    fn parse_jsonl_empty_and_malformed() {
        assert!(matches!(parse_jsonl_line(""), JsonlParsed::Skip));
        assert!(matches!(parse_jsonl_line("  \n"), JsonlParsed::Skip));
        assert!(matches!(
            parse_jsonl_line("not json at all"),
            JsonlParsed::Skip
        ));
        assert!(matches!(
            parse_jsonl_line("{\"bad\": true}"),
            JsonlParsed::Skip
        ));
    }

    #[test]
    fn parse_jsonl_markdown_code_fence() {
        let fenced = "```json\n{\"path\": \"src/foo.rs\", \"relevance\": \"medium\", \"category\": \"business-logic\", \"risk\": \"cosmetic\", \"summary\": \"Stuff\"}\n```";
        match parse_jsonl_line(fenced) {
            JsonlParsed::File(fc) => assert_eq!(fc.path, "src/foo.rs"),
            _ => panic!("expected File from fenced JSON"),
        }
    }

    #[test]
    fn parse_jsonl_preamble_text() {
        let with_preamble = "Here is my analysis:\n{\"path\": \"src/bar.rs\", \"relevance\": \"high\", \"category\": \"api-surface\", \"risk\": \"breaking-change\", \"summary\": \"API change\"}";
        match parse_jsonl_line(with_preamble) {
            JsonlParsed::File(fc) => {
                assert_eq!(fc.path, "src/bar.rs");
                assert_eq!(fc.category, Category::ApiSurface);
            }
            _ => panic!("expected File from text with preamble"),
        }
    }

    #[test]
    fn parse_jsonl_summary_in_code_fence() {
        let fenced = "```\n{\"summary\": \"Big refactor of config\"}\n```";
        match parse_jsonl_line(fenced) {
            JsonlParsed::Summary(s) => assert_eq!(s, "Big refactor of config"),
            _ => panic!("expected Summary from fenced JSON"),
        }
    }

    #[test]
    fn extract_json_plain() {
        assert_eq!(extract_json(r#"{"a": 1}"#), r#"{"a": 1}"#);
    }

    #[test]
    fn extract_json_fenced() {
        assert_eq!(extract_json("```json\n{\"a\": 1}\n```"), "{\"a\": 1}",);
    }

    #[test]
    fn extract_json_with_preamble() {
        assert_eq!(extract_json("Here: {\"a\": 1} done"), "{\"a\": 1}",);
    }

    #[test]
    fn build_overview_includes_llm_files() {
        let msg = build_overview(&["src/main.rs", "src/lib.rs"], &[]);
        assert!(msg.contains("src/main.rs"));
        assert!(msg.contains("src/lib.rs"));
        assert!(msg.contains("changeset summary JSON"));
        assert!(!msg.contains("Pre-classified"));
    }

    #[test]
    fn build_overview_includes_heuristic_context() {
        let msg = build_overview(
            &["src/app.rs"],
            &[
                ("Cargo.lock", "boilerplate"),
                (".github/workflows/ci.yml", "config"),
            ],
        );
        assert!(msg.contains("Pre-classified by heuristic"));
        assert!(msg.contains("Cargo.lock"));
        assert!(msg.contains("boilerplate"));
        assert!(msg.contains(".github/workflows/ci.yml"));
    }

    #[test]
    fn build_file_msg_truncates_long_diffs() {
        let long_diff = (0..500)
            .map(|i| format!("+line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let msg = build_file_msg("big.rs", &long_diff, 500, 0);
        assert!(msg.contains("[... truncated at"));
        let line_count = msg.lines().filter(|l| l.starts_with("+line")).count();
        assert_eq!(line_count, MAX_LINES_PER_FILE);
    }

    #[test]
    fn build_file_msg_short_diff_no_truncation() {
        let msg = build_file_msg("small.rs", "+fn foo() {}", 1, 0);
        assert!(!msg.contains("truncated"));
        assert!(msg.contains("+fn foo()"));
        assert!(msg.contains(r#"path="small.rs""#));
    }

    #[test]
    fn split_unified_diff_splits_files_and_counts_changed_lines() {
        let diff = "\
diff --git a/src/a.rs b/src/a.rs
index 111..222 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,2 +1,3 @@
 unchanged
+added
-removed
diff --git a/src/b.rs b/src/b.rs
--- a/src/b.rs
+++ b/src/b.rs
@@ -1 +1 @@
-old
+new";
        let files = split_unified_diff(diff);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/a.rs");
        assert_eq!(files[0].additions, 1);
        assert_eq!(files[0].deletions, 1);
        assert!(files[0].diff.contains("diff --git a/src/a.rs b/src/a.rs"));
        assert_eq!(files[1].path, "src/b.rs");
        assert_eq!(files[1].additions, 1);
        assert_eq!(files[1].deletions, 1);
    }

    #[test]
    fn pr_review_session_key_combines_repo_and_pr() {
        let key = pr_review_session_key("/work/repo", 128);
        assert_eq!(key, "/work/repo#128");
        // Distinct PRs on the same repo never collide.
        assert_ne!(
            pr_review_session_key("/work/repo", 128),
            pr_review_session_key("/work/repo", 129)
        );
        // Same (repo, pr) always keys the same, regardless of commit — the
        // map is bounded by open-PR count, not by every push (head_sha is
        // tracked on the session itself, not the key; see PERF-1).
        assert_eq!(
            pr_review_session_key("/work/repo", 128),
            pr_review_session_key("/work/repo", 128)
        );
    }

    #[test]
    fn session_head_sha_starts_none_and_can_be_set() {
        // New sessions (working-tree or PR) start with no head_sha tracked.
        let mut s = TriageSession::new("haiku".to_string());
        assert_eq!(s.head_sha, None);
        // run_pr_review_impl stamps it after taking/creating a session.
        s.head_sha = Some("deadbeef".to_string());
        assert_eq!(s.head_sha.as_deref(), Some("deadbeef"));
    }

    #[test]
    fn build_chat_request_cache_control_on_system_and_last() {
        let session = TriageSession::new("haiku".to_string());
        let req = build_chat_request(&session, "classify this file", MULTI_TURN_SYSTEM_PROMPT);
        // system_msg + final_user = 2 messages (no session history)
        assert_eq!(req.messages.len(), 2);
        // Both system and final user have cache options
        assert!(
            req.messages[0].options.is_some(),
            "system msg must have CacheControl"
        );
        assert!(
            req.messages[1].options.is_some(),
            "final user msg must have CacheControl"
        );
    }

    #[test]
    fn build_chat_request_midpoint_cache_for_long_sessions() {
        let mut session = TriageSession::new("haiku".to_string());
        // Add 42 messages to trigger midpoint caching (> 40)
        for i in 0..42 {
            session.messages.push(SessionMsg {
                role: if i % 2 == 0 {
                    MsgRole::User
                } else {
                    MsgRole::Assistant
                },
                content: format!("msg {i}"),
            });
        }
        let req = build_chat_request(&session, "new msg", MULTI_TURN_SYSTEM_PROMPT);
        // system (idx 0) + 42 session msgs + final user = 44 total
        assert_eq!(req.messages.len(), 44);
        let cached_count = req.messages.iter().filter(|m| m.options.is_some()).count();
        // system + midpoint session msg + final user = 3 with cache options
        assert_eq!(
            cached_count, 3,
            "expected system + midpoint + final to have cache options; got {cached_count}"
        );
        // midpoint of 42 session msgs = index 21 in session → index 22 in req.messages
        assert!(
            req.messages[22].options.is_some(),
            "midpoint session msg must have cache options"
        );
    }

    #[test]
    fn build_chat_request_uses_custom_system_prompt() {
        let session = TriageSession::new("haiku".to_string());
        let custom = "You are a custom reviewer.";
        let req = build_chat_request(&session, "classify this", custom);
        assert_eq!(req.messages.len(), 2);
        let first_text = req.messages[0].content.first_text().unwrap();
        assert_eq!(first_text, custom);
    }

    #[test]
    fn default_system_prompt_returns_const() {
        assert_eq!(default_system_prompt(), MULTI_TURN_SYSTEM_PROMPT);
    }

    #[test]
    fn session_is_valid_checks_model() {
        let s = TriageSession::new("haiku".to_string());
        assert!(s.is_valid("haiku"));
        assert!(!s.is_valid("sonnet"));
    }

    #[test]
    fn session_is_valid_message_cap() {
        let mut s = TriageSession::new("haiku".to_string());
        for i in 0..MAX_SESSION_MESSAGES {
            s.messages.push(SessionMsg {
                role: MsgRole::User,
                content: format!("msg {i}"),
            });
        }
        assert!(!s.is_valid("haiku"));
    }

    #[test]
    fn session_hash_based_file_skip() {
        let mut s = TriageSession::new("haiku".to_string());
        let h = hash_diff("some diff content");
        let fc = FileClassification {
            path: "src/foo.rs".to_string(),
            relevance: Relevance::High,
            category: Category::BusinessLogic,
            risk: Risk::BehavioralChange,
            summary: "does stuff".to_string(),
            findings: Vec::new(),
            source: ClassificationSource::Llm,
            additions: 10,
            deletions: 2,
        };
        s.file_hashes.insert("src/foo.rs".to_string(), h);
        s.classifications.insert("src/foo.rs".to_string(), fc);

        // Same hash → cache hit
        assert!(
            s.file_hashes
                .get("src/foo.rs")
                .filter(|&&ch| ch == h)
                .is_some()
        );
        // Different hash → miss
        let other = hash_diff("different diff");
        assert!(
            s.file_hashes
                .get("src/foo.rs")
                .filter(|&&ch| ch == other)
                .is_none()
        );
    }

    #[test]
    fn fallback_source_files_are_business_logic() {
        let c = fallback_classification("src/main.rs", None, 0, 0);
        assert_eq!(c.relevance, Relevance::Medium);
        assert_eq!(c.category, Category::BusinessLogic);
    }

    #[test]
    fn fallback_test_files_are_test() {
        for path in &[
            "src/__tests__/foo.test.ts",
            "src/components/Terminal.test.tsx",
            "tests/integration_test.rs",
            "spec/models/user.spec.js",
            "pkg/handler_test.go",
        ] {
            let c = fallback_classification(path, None, 0, 0);
            assert_eq!(c.category, Category::Test, "{path}");
            assert_eq!(c.risk, Risk::BehavioralChange, "{path}");
        }
    }

    #[test]
    fn fallback_css_files_are_style() {
        for path in &[
            "src/components/Panel.module.css",
            "styles/global.scss",
            "src/theme.less",
        ] {
            let c = fallback_classification(path, None, 0, 0);
            assert_eq!(c.category, Category::Style, "{path}");
            assert_eq!(c.risk, Risk::Cosmetic, "{path}");
        }
    }

    #[test]
    fn fallback_ignore_files_are_config() {
        for path in &["src-tauri/.taurignore", ".dockerignore", ".gitignore"] {
            let c = fallback_classification(path, None, 0, 0);
            assert_eq!(c.category, Category::Config, "{path}");
            assert_eq!(c.risk, Risk::Cosmetic, "{path}");
        }
    }

    // ── fallback_classification with diff content ─────────────────────────────

    #[test]
    fn fallback_with_pub_fn_diff_is_api_surface() {
        let diff = "@@ -1,3 +1,5 @@ mod handler\n+pub fn handle_request(req: Request) -> Response {\n+    todo!()\n+}";
        let c = fallback_classification("src/handler.rs", Some(diff), 3, 0);
        assert_eq!(
            c.category,
            Category::ApiSurface,
            "pub fn should → ApiSurface"
        );
        assert_eq!(c.relevance, Relevance::High);
    }

    #[test]
    fn fallback_with_pub_fn_removal_is_breaking() {
        let diff = "-pub fn old_api() {}";
        let c = fallback_classification("src/api.rs", Some(diff), 0, 5);
        assert_eq!(
            c.risk,
            Risk::BreakingChange,
            "removal of pub fn → BreakingChange"
        );
    }

    #[test]
    fn fallback_with_ts_export_is_api_surface() {
        let diff = "+export function doThing() {}";
        let c = fallback_classification("src/utils.ts", Some(diff), 5, 0);
        assert_eq!(c.category, Category::ApiSurface);
    }

    #[test]
    fn fallback_with_test_signals_is_test_category() {
        let diff = "+#[test]\n+fn it_works() {\n+    assert_eq!(1, 1);\n+}";
        let c = fallback_classification("src/handler.rs", Some(diff), 4, 0);
        assert_eq!(c.category, Category::Test, "test signals should → Test");
    }

    #[test]
    fn fallback_with_sql_is_schema() {
        let diff = "+ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';";
        let c = fallback_classification("src/db.rs", Some(diff), 1, 0);
        assert_eq!(c.category, Category::Schema);
        assert_eq!(c.risk, Risk::BehavioralChange);
    }

    #[test]
    fn fallback_with_heavy_deletions_is_breaking() {
        // 5 additions, 30 deletions — ratio > 0.5 and total > 20
        let diff = (0..5)
            .map(|i| format!("+line{i}"))
            .chain((0..30).map(|i| format!("-old{i}")))
            .collect::<Vec<_>>()
            .join("\n");
        let c = fallback_classification("src/core.rs", Some(&diff), 5, 30);
        assert_eq!(
            c.risk,
            Risk::BreakingChange,
            "heavy deletions → BreakingChange"
        );
    }

    #[test]
    fn fallback_with_auth_is_high_relevance() {
        let diff = "+let password = req.body.password;";
        let c = fallback_classification("src/login.rs", Some(diff), 1, 0);
        assert_eq!(c.relevance, Relevance::High, "auth signal → High relevance");
    }

    #[test]
    fn fallback_with_hunk_context_generates_summary() {
        let diff = "@@ -10,5 +10,7 @@ fn process_event\n+    do_stuff();";
        let c = fallback_classification("src/events.rs", Some(diff), 1, 0);
        assert!(
            !c.summary.is_empty(),
            "should generate a summary from hunk context"
        );
    }

    #[test]
    fn fallback_none_diff_no_summary() {
        let c = fallback_classification("src/main.rs", None, 0, 0);
        assert!(c.summary.is_empty(), "no diff → empty summary");
    }

    // ── signal cascade interaction tests ─────────────────────────────────────

    #[test]
    fn fallback_schema_wins_over_api_surface() {
        let diff = "+pub fn run_migration() {\n+    CREATE TABLE users (id INT);\n+}";
        let c = fallback_classification("src/db.rs", Some(diff), 3, 0);
        assert_eq!(
            c.category,
            Category::Schema,
            "Schema has priority over ApiSurface"
        );
        assert_eq!(c.relevance, Relevance::High);
    }

    #[test]
    fn fallback_schema_wins_over_test_signals() {
        let diff =
            "+ALTER TABLE users ADD COLUMN x TEXT;\n+#[test]\n+fn verify() { assert!(true); }";
        let c = fallback_classification("src/db.rs", Some(diff), 3, 0);
        assert_eq!(
            c.category,
            Category::Schema,
            "Schema has priority over Test"
        );
    }

    #[test]
    fn fallback_api_surface_wins_over_test_signals() {
        let diff = "+export function createTestUser() {}\n+describe('user', () => {});";
        let c = fallback_classification("tests/helpers.ts", Some(diff), 5, 0);
        assert_eq!(
            c.category,
            Category::ApiSurface,
            "ApiSurface has priority over Test"
        );
    }

    #[test]
    fn fallback_auth_in_style_file_upgrades_risk() {
        let diff = "+.password-input { color: red; }";
        let c = fallback_classification("styles/auth.scss", Some(diff), 2, 0);
        assert_eq!(c.relevance, Relevance::High);
        assert_eq!(
            c.risk,
            Risk::BehavioralChange,
            "auth upgrades Cosmetic → BehavioralChange"
        );
    }

    #[test]
    fn fallback_heavy_deletions_not_breaking_for_style() {
        let diff = (0..5)
            .map(|i| format!("+a{i}"))
            .chain((0..30).map(|i| format!("-b{i}")))
            .collect::<Vec<_>>()
            .join("\n");
        let c = fallback_classification("styles/theme.css", Some(&diff), 5, 30);
        assert_eq!(c.category, Category::Style);
        assert_ne!(
            c.risk,
            Risk::BreakingChange,
            "deletion ratio should not fire on Style"
        );
    }

    #[test]
    fn fallback_heavy_deletions_boundary_total_20_does_not_trigger() {
        let diff = (0..9)
            .map(|i| format!("+a{i}"))
            .chain((0..11).map(|i| format!("-b{i}")))
            .collect::<Vec<_>>()
            .join("\n");
        let c = fallback_classification("src/core.rs", Some(&diff), 9, 11);
        assert_ne!(
            c.risk,
            Risk::BreakingChange,
            "total=20 should not trigger (need >20)"
        );
    }

    #[test]
    fn serialization_roundtrip() {
        let c = classify("Cargo.lock").unwrap();
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"relevance\":\"low\""));
        assert!(json.contains("\"category\":\"boilerplate\""));
        assert!(json.contains("\"risk\":\"cosmetic\""));
        assert!(json.contains("\"source\":\"heuristic\""));

        let c = classify("migrations/001.sql").unwrap();
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"risk\":\"behavioral-change\""));
        assert!(json.contains("\"category\":\"schema\""));
    }

    // -- dispatch_tool tests --------------------------------------------------

    fn make_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.rs"), "fn main() {}\n").unwrap();
        let sub = dir.path().join("src");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("lib.rs"), "pub fn greet() {}\n").unwrap();
        dir
    }

    #[test]
    fn dispatch_tool_read_file_valid() {
        let repo = make_repo();
        let args = serde_json::json!({"path": "hello.rs"});
        let result = dispatch_tool("read_file", &args, repo.path().to_str().unwrap());
        assert_eq!(result, "fn main() {}");
    }

    #[test]
    fn dispatch_tool_read_file_nested() {
        let repo = make_repo();
        let args = serde_json::json!({"path": "src/lib.rs"});
        let result = dispatch_tool("read_file", &args, repo.path().to_str().unwrap());
        assert_eq!(result, "pub fn greet() {}");
    }

    #[test]
    fn dispatch_tool_read_file_missing_path_arg() {
        let repo = make_repo();
        let args = serde_json::json!({});
        let result = dispatch_tool("read_file", &args, repo.path().to_str().unwrap());
        assert!(
            result.starts_with("error:"),
            "expected error, got: {result}"
        );
    }

    #[test]
    fn dispatch_tool_read_file_nonexistent() {
        let repo = make_repo();
        let args = serde_json::json!({"path": "nope.rs"});
        let result = dispatch_tool("read_file", &args, repo.path().to_str().unwrap());
        assert!(
            result.starts_with("error:"),
            "expected error, got: {result}"
        );
    }

    #[test]
    fn dispatch_tool_path_outside_repo_rejected() {
        let repo = make_repo();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();
        let outside_name = outside.path().file_name().unwrap().to_str().unwrap();
        let relative = format!("../{outside_name}/secret.txt");
        let args = serde_json::json!({"path": relative});
        let result = dispatch_tool("read_file", &args, repo.path().to_str().unwrap());
        assert_eq!(result, "error: path outside repository");
    }

    #[test]
    fn dispatch_tool_binary_file_rejected() {
        let repo = make_repo();
        std::fs::write(repo.path().join("image.bin"), b"\x89PNG\r\n\x1a\n\x00\x00").unwrap();
        let args = serde_json::json!({"path": "image.bin"});
        let result = dispatch_tool("read_file", &args, repo.path().to_str().unwrap());
        assert_eq!(result, "error: binary file");
    }

    #[test]
    fn dispatch_tool_truncates_at_1000_lines() {
        let repo = make_repo();
        let content: String = (0..1500)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(repo.path().join("big.txt"), &content).unwrap();
        let args = serde_json::json!({"path": "big.txt"});
        let result = dispatch_tool("read_file", &args, repo.path().to_str().unwrap());
        assert!(result.ends_with(&format!("[truncated at {MAX_READ_LINES} lines]")));
        let line_count = result.lines().count();
        assert_eq!(line_count, MAX_READ_LINES + 1); // 1000 content + 1 truncation notice
    }

    #[test]
    fn dispatch_tool_no_truncation_under_limit() {
        let repo = make_repo();
        let content: String = (0..50)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(repo.path().join("small.txt"), &content).unwrap();
        let args = serde_json::json!({"path": "small.txt"});
        let result = dispatch_tool("read_file", &args, repo.path().to_str().unwrap());
        assert!(!result.contains("truncated"));
        assert_eq!(result.lines().count(), 50);
    }

    #[test]
    fn dispatch_tool_read_file_range() {
        let repo = make_repo();
        let content: String = (1..=20)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(repo.path().join("range.txt"), &content).unwrap();
        let args = serde_json::json!({"path": "range.txt", "start_line": 5, "end_line": 10});
        let result = dispatch_tool("read_file_range", &args, repo.path().to_str().unwrap());
        let lines: Vec<&str> = result.lines().collect();
        assert_eq!(lines.len(), 6); // lines 5..=10
        assert_eq!(lines[0], "line 5");
        assert_eq!(lines[5], "line 10");
    }

    #[test]
    fn dispatch_tool_read_file_range_clamps() {
        let repo = make_repo();
        let content = "one\ntwo\nthree\n";
        std::fs::write(repo.path().join("short.txt"), content).unwrap();
        let args = serde_json::json!({"path": "short.txt", "start_line": 2, "end_line": 999});
        let result = dispatch_tool("read_file_range", &args, repo.path().to_str().unwrap());
        let lines: Vec<&str> = result.lines().collect();
        assert_eq!(lines.len(), 2); // lines 2..=3 (clamped)
        assert_eq!(lines[0], "two");
        assert_eq!(lines[1], "three");
    }

    #[test]
    fn dispatch_tool_unknown_tool() {
        let repo = make_repo();
        let args = serde_json::json!({"path": "hello.rs"});
        let result = dispatch_tool("delete_file", &args, repo.path().to_str().unwrap());
        assert!(result.contains("unknown tool"), "got: {result}");
    }

    #[test]
    fn triage_tool_definitions_schema_valid() {
        let defs = triage_tool_definitions();
        let arr = defs.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["name"], "read_file");
        assert_eq!(arr[1]["name"], "read_file_range");
        assert!(arr[0]["inputSchema"]["properties"]["path"].is_object());
        assert!(arr[1]["inputSchema"]["properties"]["start_line"].is_object());
        assert!(arr[1]["inputSchema"]["properties"]["end_line"].is_object());
    }

    /// Simulates the tool call round-trip: LLM emits a ToolCall → dispatch → ToolResponse.
    /// Verifies that dispatch_tool output can be wrapped in ToolResponse and the content is correct.
    #[test]
    fn tool_call_round_trip_read_file() {
        use genai::chat::{ToolCall, ToolResponse};

        let repo = make_repo();
        let tc = ToolCall {
            call_id: "call_001".to_string(),
            fn_name: "read_file".to_string(),
            fn_arguments: serde_json::json!({"path": "hello.rs"}),
            thought_signatures: None,
        };

        let output = dispatch_tool(&tc.fn_name, &tc.fn_arguments, repo.path().to_str().unwrap());
        assert_eq!(
            output, "fn main() {}",
            "dispatch_tool returned unexpected content"
        );

        // Verify ToolResponse can be constructed (round-trip complete)
        let response = ToolResponse::new(&tc.call_id, output.clone());
        assert_eq!(response.call_id, "call_001");
        assert_eq!(response.content, output);
    }

    #[test]
    fn tool_call_round_trip_read_file_range() {
        use genai::chat::{ToolCall, ToolResponse};

        let repo = make_repo();
        let content: String = (1..=10)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(repo.path().join("numbered.txt"), &content).unwrap();

        let tc = ToolCall {
            call_id: "call_002".to_string(),
            fn_name: "read_file_range".to_string(),
            fn_arguments: serde_json::json!({"path": "numbered.txt", "start_line": 3, "end_line": 5}),
            thought_signatures: None,
        };

        let output = dispatch_tool(&tc.fn_name, &tc.fn_arguments, repo.path().to_str().unwrap());
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines, vec!["line 3", "line 4", "line 5"]);

        let response = ToolResponse::new(&tc.call_id, output);
        assert_eq!(response.call_id, "call_002");
    }

    #[test]
    fn tool_call_round_trip_path_traversal_rejected() {
        use genai::chat::{ToolCall, ToolResponse};

        let repo = make_repo();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();
        let outside_name = outside.path().file_name().unwrap().to_str().unwrap();

        let tc = ToolCall {
            call_id: "call_003".to_string(),
            fn_name: "read_file".to_string(),
            fn_arguments: serde_json::json!({"path": format!("../{outside_name}/secret.txt")}),
            thought_signatures: None,
        };

        let output = dispatch_tool(&tc.fn_name, &tc.fn_arguments, repo.path().to_str().unwrap());
        assert_eq!(output, "error: path outside repository");

        // Even on error, ToolResponse wraps the error message back to the LLM
        let response = ToolResponse::new(&tc.call_id, output.clone());
        assert_eq!(response.content, output);
    }

    // ── analyze_diff tests ───────────────────────────────────────────────────

    #[test]
    fn analyze_diff_rust_pub_fn_added() {
        let diff = "+pub fn handle_request() -> Result<()> {";
        let s = analyze_diff(diff);
        assert_eq!(s.api_surface_added, 1);
        assert_eq!(s.api_surface_removed, 0);
    }

    #[test]
    fn analyze_diff_rust_pub_fn_removed() {
        let diff = "-pub fn old_handler() {}";
        let s = analyze_diff(diff);
        assert_eq!(s.api_surface_removed, 1);
        assert_eq!(s.api_surface_added, 0);
    }

    #[test]
    fn analyze_diff_rust_pub_variants() {
        let diff = "+pub struct Foo {}\n+pub enum Bar {}\n+pub trait Baz {}";
        let s = analyze_diff(diff);
        assert_eq!(s.api_surface_added, 3);
    }

    #[test]
    fn analyze_diff_ts_export_added() {
        let diff = "+export function doSomething() {}\n+export const VALUE = 42;";
        let s = analyze_diff(diff);
        assert_eq!(s.api_surface_added, 2);
    }

    #[test]
    fn analyze_diff_ts_export_default_added() {
        let diff = "+export default class MyClass {}";
        let s = analyze_diff(diff);
        assert_eq!(s.api_surface_added, 1);
    }

    #[test]
    fn analyze_diff_go_exported_func_added() {
        let diff = "+func HandleRequest(w http.ResponseWriter) {}";
        let s = analyze_diff(diff);
        assert_eq!(s.api_surface_added, 1);
    }

    #[test]
    fn analyze_diff_go_unexported_func_ignored() {
        let diff = "+func handleRequest(w http.ResponseWriter) {}";
        let s = analyze_diff(diff);
        assert_eq!(s.api_surface_added, 0);
    }

    #[test]
    fn analyze_diff_test_patterns() {
        let diff = "+#[test]\n+fn it_does_stuff() {}\n+assert_eq!(a, b);";
        let s = analyze_diff(diff);
        assert!(s.test_signals >= 2);
    }

    #[test]
    fn analyze_diff_test_js_patterns() {
        let diff = "+describe('foo', () => {\n+  it('does thing', () => {\n+    expect(x).toBe(y);\n+  });\n+});";
        let s = analyze_diff(diff);
        assert!(s.test_signals >= 2, "describe( and it( are test signals");
    }

    #[test]
    fn analyze_diff_sql_patterns() {
        let diff = "+ALTER TABLE users ADD COLUMN role TEXT;";
        let s = analyze_diff(diff);
        assert!(s.schema_signals >= 1);
    }

    #[test]
    fn analyze_diff_create_table() {
        let diff = "+CREATE TABLE sessions (id UUID PRIMARY KEY);";
        let s = analyze_diff(diff);
        assert!(s.schema_signals >= 1);
    }

    #[test]
    fn analyze_diff_auth_patterns() {
        let diff = "+let password = req.body.password;\n+let secret = env::var(\"SECRET\");";
        let s = analyze_diff(diff);
        assert!(s.auth_signals >= 2);
    }

    #[test]
    fn analyze_diff_hunk_header_extracts_context() {
        let diff =
            "@@ -10,5 +10,7 @@ fn process_event(event: &Event) -> Result<()> {\n+    do_stuff();";
        let s = analyze_diff(diff);
        assert!(s.hunk_context.is_some());
        assert!(s.hunk_context.as_deref().unwrap().contains("process_event"));
    }

    #[test]
    fn analyze_diff_hunk_header_no_context() {
        let diff = "@@ -10,5 +10,7 @@\n+    do_stuff();";
        let s = analyze_diff(diff);
        assert!(s.hunk_context.is_none());
    }

    #[test]
    fn analyze_diff_empty_returns_zeroes() {
        let s = analyze_diff("");
        assert_eq!(s.api_surface_added, 0);
        assert_eq!(s.api_surface_removed, 0);
        assert_eq!(s.test_signals, 0);
        assert_eq!(s.schema_signals, 0);
        assert_eq!(s.auth_signals, 0);
        assert!(s.hunk_context.is_none());
    }

    #[test]
    fn analyze_diff_context_lines_not_counted() {
        // lines starting with space (context) should not trigger any signals
        let diff = " pub fn existing() {}\n pub struct OldType {}";
        let s = analyze_diff(diff);
        assert_eq!(s.api_surface_added, 0);
        assert_eq!(s.api_surface_removed, 0);
    }

    // ── build_fallback_summary tests ─────────────────────────────────────────

    #[test]
    fn fallback_summary_api_removed_with_context() {
        let signals = DiffSignals {
            api_surface_added: 0,
            api_surface_removed: 1,
            test_signals: 0,
            schema_signals: 0,
            auth_signals: 0,
            hunk_context: Some("handle_request".to_string()),
            hunk_count: 1,
        };
        let s = build_fallback_summary(&signals, 2, 14);
        assert!(
            s.contains("Removed") && s.contains("handle_request"),
            "got: {s}"
        );
        assert!(s.contains("+2") && s.contains("-14"), "got: {s}");
    }

    #[test]
    fn fallback_summary_api_removed_no_context() {
        let signals = DiffSignals {
            api_surface_added: 0,
            api_surface_removed: 1,
            test_signals: 0,
            schema_signals: 0,
            auth_signals: 0,
            hunk_context: None,
            hunk_count: 1,
        };
        let s = build_fallback_summary(&signals, 2, 14);
        assert!(s.contains("Removed"), "got: {s}");
    }

    #[test]
    fn fallback_summary_schema_change() {
        let signals = DiffSignals {
            api_surface_added: 0,
            api_surface_removed: 0,
            test_signals: 0,
            schema_signals: 1,
            auth_signals: 0,
            hunk_context: None,
            hunk_count: 1,
        };
        let s = build_fallback_summary(&signals, 5, 2);
        assert!(s.contains("Schema") || s.contains("schema"), "got: {s}");
    }

    #[test]
    fn fallback_summary_api_added() {
        let signals = DiffSignals {
            api_surface_added: 2,
            api_surface_removed: 0,
            test_signals: 0,
            schema_signals: 0,
            auth_signals: 0,
            hunk_context: None,
            hunk_count: 1,
        };
        let s = build_fallback_summary(&signals, 20, 0);
        assert!(
            s.contains("2")
                && (s.contains("public") || s.contains("symbol") || s.contains("added")),
            "got: {s}"
        );
    }

    #[test]
    fn fallback_summary_context_only() {
        let signals = DiffSignals {
            api_surface_added: 0,
            api_surface_removed: 0,
            test_signals: 0,
            schema_signals: 0,
            auth_signals: 0,
            hunk_context: Some("process_event".to_string()),
            hunk_count: 1,
        };
        let s = build_fallback_summary(&signals, 9, 7);
        assert!(s.contains("process_event"), "got: {s}");
    }

    #[test]
    fn fallback_summary_stats_only() {
        let signals = DiffSignals {
            api_surface_added: 0,
            api_surface_removed: 0,
            test_signals: 0,
            schema_signals: 0,
            auth_signals: 0,
            hunk_context: None,
            hunk_count: 2,
        };
        let s = build_fallback_summary(&signals, 3, 0);
        assert!(s.contains("+3"), "got: {s}");
        assert!(s.contains("hunk") || s.contains("2"), "got: {s}");
    }
}
