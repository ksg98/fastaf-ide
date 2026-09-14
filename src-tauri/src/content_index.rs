//! Pre-built BM25 content index for sub-millisecond file content search.
//!
//! Unlike the grep-then-rerank approach in `fs::search_content_impl`, this
//! module builds a persistent BM25 index over all text files in a repo at
//! load time. Queries hit the in-memory index (~1ms) and then grep only the
//! top-ranked files for exact line matches — avoiding a full repo walk.
//!
//! The index is stored per-repo in `AppState::content_indices` and rebuilt on
//! `RepoChanged` events, but only when a stat-only walk finds an indexable file
//! whose mtime or size moved (`ContentIndex::is_current`) — a git-state change that
//! touches no file content must not pay for a full re-read of the repo. The
//! rebuild itself is whole-corpus, not per-file. `repo_watcher::stop_watching`
//! releases a repo's index when it is no longer in use.
//!
//! Search results need only the BM25 embeddings and their file ids. The source
//! text is deliberately dropped after each build; a future feature that needs
//! snippets or previews must read the current file from disk rather than serve
//! a stale second copy retained by the index.

use bm25::{DefaultTokenizer, Embedder, EmbedderBuilder, Language, Scorer, Tokenizer};
use dashmap::DashSet;
use ignore::WalkBuilder;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

/// Maximum file size to index (1 MB).
const MAX_FILE_SIZE: u64 = 1_048_576;

/// Minimum interval between consecutive index rebuilds for the same repo.
const REBUILD_COOLDOWN: Duration = Duration::from_secs(60);

/// Files processed between throttle checkpoints during index build.
const THROTTLE_CHECKPOINT_INTERVAL: usize = 50;
/// Poll interval while an indexer is paused waiting for searches to finish.
const THROTTLE_SEARCH_POLL: Duration = Duration::from_millis(100);
/// Unconditional sleep injected at every checkpoint so index builds don't
/// saturate CPU cores — important in debug builds where corpus construction
/// is significantly slower and runs unoptimised.
const THROTTLE_BUILD_YIELD: Duration = Duration::from_millis(10);

/// Cooperative throttle that yields CPU during index builds and gives
/// user-initiated searches a bounded head start.
#[derive(Default)]
pub struct IndexerThrottle {
    search_active: AtomicUsize,
}

/// RAII guard: increments the active-search counter on creation, decrements on drop.
/// Acquire at the top of every search handler so indexers step aside. Owns an
/// `Arc` so the guard is `'static` and can cross `spawn_blocking` boundaries.
#[must_use = "throttle guard must be held for the duration of the search"]
pub struct SearchGuard {
    throttle: Arc<IndexerThrottle>,
}

impl Drop for SearchGuard {
    fn drop(&mut self) {
        self.throttle.search_active.fetch_sub(1, Ordering::Release);
    }
}

impl IndexerThrottle {
    /// Mark a search as active for the lifetime of the returned guard.
    pub fn begin_search(self: &Arc<Self>) -> SearchGuard {
        // AcqRel pairs with the `load(Acquire)` in `checkpoint` so the
        // increment is published to indexer threads before they resume.
        self.search_active.fetch_add(1, Ordering::AcqRel);
        SearchGuard {
            throttle: Arc::clone(self),
        }
    }

    /// Called from the indexer loop every `THROTTLE_CHECKPOINT_INTERVAL` files.
    /// Defers once when a search is active, then yields unconditionally so
    /// index builds don't saturate CPU cores. A fallback grep can span the whole
    /// repository, so waiting for every search guard to drop would starve the
    /// missing index whose absence selected that fallback in the first place.
    pub fn checkpoint(&self) {
        if self.search_active.load(Ordering::Acquire) > 0 {
            std::thread::sleep(THROTTLE_SEARCH_POLL);
        }
        std::thread::sleep(THROTTLE_BUILD_YIELD);
    }
}

/// The stat-only fingerprint `is_current` compares a file against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStamp {
    /// File mtime at indexing time, in nanoseconds since the epoch.
    ///
    /// Nanoseconds, not seconds: an agent editing the same file twice inside one
    /// second is the normal case here — second granularity would report the index
    /// as still current and the edit would stay unsearchable until something else
    /// invalidated it.
    mtime: u64,
    /// File size in bytes.
    ///
    /// mtime alone misses a content replacement that preserves it, and the tools
    /// that restore files do exactly that: `cp -p`, `rsync -a`, `tar -x`, `unzip`
    /// with timestamps. The index would then serve the old text for as long as
    /// nothing else touched the file. The size is free — the walk already stats
    /// every file — and catches such a replacement whenever the length changes. A
    /// same-size, same-mtime rewrite still slips through; catching that needs the
    /// content read this check exists to avoid.
    len: u64,
}

/// A single indexed file entry.
#[derive(Debug, Clone)]
struct FileEntry {
    /// Path relative to repo root (forward-slash separated).
    rel_path: String,
    /// What the file looked like on disk when it was indexed.
    stamp: FileStamp,
}

/// A file's stat fingerprint; the mtime is `0` when unavailable.
fn file_stamp(metadata: &std::fs::Metadata) -> FileStamp {
    FileStamp {
        mtime: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_nanos() as u64),
        len: metadata.len(),
    }
}

/// Pre-built BM25 index over file contents in a single repository.
pub struct ContentIndex {
    engine: EmbeddingIndex,
    entries: Vec<FileEntry>,
    /// rel_path → index into `entries`, for `is_current`'s stamp comparison.
    path_to_idx: HashMap<String, usize>,
    /// Absolute repo root used to resolve relative paths.
    repo_root: PathBuf,
    /// Whether the index has been built at least once.
    ready: bool,
    /// When the last successful build completed.
    built_at: std::time::Instant,
    /// Files confirmed binary (rel_path → stamp). Carried across rebuilds
    /// so we skip the 8KB read probe for files whose stamp hasn't changed.
    known_binaries: HashMap<String, FileStamp>,
}

/// Result of a BM25 file-level query: ranked file paths.
#[derive(Debug, Clone)]
#[allow(dead_code)] // score exposed for future ranking/filtering by callers
pub struct RankedFile {
    pub rel_path: String,
    pub score: f32,
}

type BuildTokenCache = HashMap<(usize, usize), Vec<String>>;

/// Shares tokens between the crate's avgdl-fitting and embedding passes. The
/// pointer key is valid only while `EmbeddingIndex::build` owns the corpus; the
/// cache is cleared before it returns, avoiding a second copy of each document.
struct BuildTokenizer {
    inner: DefaultTokenizer,
    cache: Arc<parking_lot::Mutex<Option<BuildTokenCache>>>,
    #[cfg(test)]
    tokenizations: Arc<AtomicUsize>,
}

impl Tokenizer for BuildTokenizer {
    fn tokenize(&self, input_text: &str) -> Vec<String> {
        let key = (input_text.as_ptr() as usize, input_text.len());
        if let Some(tokens) = self
            .cache
            .lock()
            .as_ref()
            .and_then(|cache| cache.get(&key))
            .cloned()
        {
            return tokens;
        }

        let tokens = self.inner.tokenize(input_text);
        let mut cache = self.cache.lock();
        if let Some(cache) = cache.as_mut() {
            cache.insert(key, tokens.clone());
            #[cfg(test)]
            self.tokenizations.fetch_add(1, Ordering::Relaxed);
        }
        tokens
    }
}

/// The parts of the BM25 crate needed to rank file ids. Its higher-level
/// `SearchEngine` also retains every document string so it can return the text
/// with each result, but callers map ids back to `entries` and never use it.
struct EmbeddingIndex {
    embedder: Embedder<u32, BuildTokenizer>,
    scorer: Scorer<u32>,
    #[cfg(test)]
    build_cache: Arc<parking_lot::Mutex<Option<BuildTokenCache>>>,
    #[cfg(test)]
    build_document_tokenizations: usize,
}

impl EmbeddingIndex {
    fn build(corpus: &[String]) -> Self {
        let documents: Vec<&str> = corpus.iter().map(String::as_str).collect();
        let cache = Arc::new(parking_lot::Mutex::new(Some(HashMap::new())));
        #[cfg(test)]
        let tokenizations = Arc::new(AtomicUsize::new(0));
        let tokenizer = BuildTokenizer {
            inner: DefaultTokenizer::new(Language::English),
            cache: Arc::clone(&cache),
            #[cfg(test)]
            tokenizations: Arc::clone(&tokenizations),
        };
        let embedder = EmbedderBuilder::<u32, BuildTokenizer>::with_tokenizer_and_fit_to_corpus(
            tokenizer, &documents,
        )
        .build();
        let mut scorer = Scorer::new();
        for (id, document) in corpus.iter().enumerate() {
            scorer.upsert(&(id as u32), embedder.embed(document));
        }
        // The cache only bridges the crate's avgdl-fitting and embedding passes.
        // Queries tokenize directly, and no source text survives this point.
        drop(cache.lock().take());
        Self {
            embedder,
            scorer,
            #[cfg(test)]
            build_cache: cache,
            #[cfg(test)]
            build_document_tokenizations: tokenizations.load(Ordering::Relaxed),
        }
    }

    fn search(&self, query: &str, limit: usize) -> Vec<bm25::ScoredDocument<u32>> {
        let query = self.embedder.embed(query);
        self.scorer
            .matches(&query)
            .into_iter()
            .take(limit)
            .collect()
    }
}

impl ContentIndex {
    /// Create an empty, not-yet-built index for a repo.
    pub fn empty(repo_root: PathBuf) -> Self {
        Self {
            engine: EmbeddingIndex::build(&[]),
            entries: Vec::new(),
            path_to_idx: HashMap::new(),
            repo_root,
            ready: false,
            built_at: std::time::Instant::now(),
            known_binaries: HashMap::new(),
        }
    }

    /// Build (or rebuild) the full index by walking the repo.
    ///
    /// This is I/O-heavy and should be called from `spawn_blocking`. Respects
    /// .gitignore, skips binary files and files > 1 MB. When `throttle` is
    /// provided, the walker yields cooperatively every `THROTTLE_CHECKPOINT_INTERVAL`
    /// files and briefly defers to an active search at each checkpoint. Pass
    /// `None` for tests or one-shot builds where throttling is irrelevant.
    pub fn build(
        repo_root: PathBuf,
        throttle: Option<&IndexerThrottle>,
        prior_binaries: HashMap<String, FileStamp>,
    ) -> Self {
        let canonical = repo_root
            .canonicalize()
            .unwrap_or_else(|_| repo_root.clone());

        let mut entries = Vec::new();
        let mut corpus = Vec::new();
        let mut path_to_idx = HashMap::new();
        let mut known_binaries = HashMap::new();

        let walker = Self::walker(&canonical);

        let mut processed: usize = 0;
        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                continue;
            }

            processed += 1;
            if let Some(t) = throttle
                && processed.is_multiple_of(THROTTLE_CHECKPOINT_INTERVAL)
            {
                t.checkpoint();
            }

            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            if metadata.len() > MAX_FILE_SIZE {
                continue;
            }

            let rel_path = match entry.path().strip_prefix(&canonical) {
                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };

            let stamp = file_stamp(&metadata);

            // Skip binary files — use cached result if the stamp is unchanged
            if let Some(&cached) = prior_binaries.get(&rel_path)
                && cached == stamp
            {
                known_binaries.insert(rel_path, stamp);
                continue;
            }
            if is_binary(entry.path()) {
                known_binaries.insert(rel_path, stamp);
                continue;
            }

            let content = match std::fs::read_to_string(entry.path()) {
                Ok(c) => c,
                // Unreadable or not UTF-8 (Latin-1 text with no null byte in the
                // probed 8 KB gets here). Record it as unindexable: `is_current`
                // requires every file on disk to be accounted for, so a file in
                // neither map would report the index stale on every single event
                // for the life of the repo.
                Err(_) => {
                    known_binaries.insert(rel_path, stamp);
                    continue;
                }
            };

            let idx = entries.len();
            path_to_idx.insert(rel_path.clone(), idx);

            // BM25 document: filename + content for searchability
            corpus.push(format!("{}\n{}", rel_path, content));

            entries.push(FileEntry { rel_path, stamp });
        }

        let engine = EmbeddingIndex::build(&corpus);

        Self {
            engine,
            entries,
            path_to_idx,
            repo_root: canonical,
            ready: true,
            built_at: std::time::Instant::now(),
            known_binaries,
        }
    }

    /// The repo walk both `build` and `is_current` must agree on — same ignore
    /// rules, same pruning — so the currency check can never disagree with the
    /// build about which files the index is supposed to cover.
    fn walker(canonical_root: &Path) -> ignore::Walk {
        WalkBuilder::new(canonical_root)
            .hidden(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .filter_entry(|e| !crate::fs::is_always_excluded_dir(e))
            .build()
    }

    /// Whether the index still reflects the repo on disk: a stat-only walk, no
    /// file reads and no corpus construction.
    ///
    /// Most `RepoChanged` events do not touch indexable content — `git add`,
    /// `git commit`, a stash, a ref move all emit one while every working-tree
    /// file is byte-for-byte unchanged — and each of those otherwise paid for a
    /// full re-read of the repo plus a complete BM25 rebuild, once a minute for
    /// as long as the events kept coming.
    pub fn is_current(&self) -> bool {
        if !self.ready {
            return false;
        }
        let mut matched = 0usize;
        for entry in Self::walker(&self.repo_root) {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.len() > MAX_FILE_SIZE {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(&self.repo_root) else {
                continue;
            };
            let rel_path = rel.to_string_lossy().replace('\\', "/");
            let known = self
                .path_to_idx
                .get(&rel_path)
                .and_then(|&i| self.entries.get(i))
                .map(|e| e.stamp)
                .or_else(|| self.known_binaries.get(&rel_path).copied());
            // A file we have never seen, or one whose mtime or size moved: stale.
            if known != Some(file_stamp(&metadata)) {
                return false;
            }
            matched += 1;
        }
        // Every file we hold must still be on disk, or something was deleted.
        matched == self.entries.len() + self.known_binaries.len()
    }

    /// Whether the index has been built at least once.
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// Query the index, returning up to `limit` ranked file paths.
    ///
    /// Returns empty if the index is not yet built or the query is empty.
    pub fn search(&self, query: &str, limit: usize) -> Vec<RankedFile> {
        if !self.ready || query.trim().is_empty() {
            return Vec::new();
        }

        self.engine
            .search(query, limit)
            .into_iter()
            .filter_map(|r| {
                self.entries.get(r.id as usize).map(|e| RankedFile {
                    rel_path: e.rel_path.clone(),
                    score: r.score,
                })
            })
            .collect()
    }

    /// Absolute path for a relative path in this repo.
    pub fn absolute_path(&self, rel_path: &str) -> PathBuf {
        self.repo_root.join(rel_path)
    }

    /// Number of indexed files.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// The custom engine retains embeddings and ids only; there is no document
    /// store whose byte count could grow with the source corpus.
    #[cfg(test)]
    fn retained_document_text_bytes(&self) -> usize {
        self.engine
            .build_cache
            .lock()
            .as_ref()
            .map_or(0, |cache| cache.values().flatten().map(String::len).sum())
    }

    #[cfg(test)]
    fn build_document_tokenizations(&self) -> usize {
        self.engine.build_document_tokenizations
    }
}

// ---------------------------------------------------------------------------
// Background index builder — subscribes to RepoChanged events
// ---------------------------------------------------------------------------

/// Spawn a blocking index build and log any panic in the Tokio blocking pool.
/// Without this supervisor the `JoinHandle` would be dropped, silently
/// swallowing panics (e.g. allocation failure, poisoned locks) and leaving
/// the index in a stale/empty state with no diagnostic.
///
/// `rt` must be a handle to the Tokio runtime — callers that may run on the
/// Tauri main thread (which has no implicit runtime context) MUST pass this
/// explicitly rather than relying on `Handle::current()`.
///
/// When `in_flight` is provided, the repo key is removed on completion
/// (success or panic) so future rebuilds are not permanently blocked.
fn spawn_build<F>(
    rt: &tokio::runtime::Handle,
    repo: String,
    build_fn: F,
    in_flight: Option<Arc<DashSet<String>>>,
    sem: Arc<tokio::sync::Semaphore>,
) where
    F: FnOnce() + Send + 'static,
{
    let rt = rt.clone();
    rt.clone().spawn(async move {
        // Acquire global build semaphore (permits=1) to serialize concurrent builds.
        // Callers do not need to coordinate — whichever acquires first runs, others queue.
        let _permit = sem.acquire_owned().await.ok();
        let handle = rt.spawn_blocking(build_fn);
        if let Err(e) = handle.await {
            tracing::error!(repo = %repo, error = ?e, "content index build task panicked");
        }
        if let Some(set) = in_flight {
            set.remove(&repo);
        }
        // _permit drops here, releasing the semaphore for the next queued build
    });
}

/// Ensure a content index exists for the given repo, building it in background
/// if needed. Returns immediately — callers should check `is_ready()`.
///
/// Uses `state.index_in_flight` to prevent duplicate concurrent builds: if a
/// build is already running (started by this function or by `rebuild_index`),
/// the call returns the existing placeholder without spawning a second task.
pub fn ensure_index(
    state: &Arc<crate::state::AppState>,
    repo_path: &str,
) -> Arc<parking_lot::RwLock<ContentIndex>> {
    use dashmap::mapref::entry::Entry;

    // Atomically check-and-insert: if the entry already exists return it,
    // otherwise insert a placeholder and proceed to spawn the build.
    let index = match state.content_indices.entry(repo_path.to_string()) {
        Entry::Occupied(e) => return Arc::clone(e.get()),
        Entry::Vacant(e) => {
            let idx = Arc::new(parking_lot::RwLock::new(ContentIndex::empty(
                PathBuf::from(repo_path),
            )));
            e.insert(Arc::clone(&idx));
            idx
            // Entry (and its shard lock) is dropped here before we spawn.
        }
    };

    // Guard against a concurrent rebuild_index for the same repo.
    // If the key is already in in_flight (e.g. RepoChanged fired first),
    // the placeholder is in the map but no second build is needed.
    if !state.index_in_flight.insert(repo_path.to_string()) {
        return index;
    }

    let index_ref = Arc::clone(&index);
    let repo = repo_path.to_string();
    let throttle = Arc::clone(&state.indexer_throttle);
    let in_flight = Arc::clone(&state.index_in_flight);
    let sem = Arc::clone(&state.index_build_sem);
    let repo_for_log = repo.clone();
    #[cfg(feature = "desktop")]
    let rt = tauri::async_runtime::handle();
    #[cfg(not(feature = "desktop"))]
    let rt = tokio::runtime::Handle::current();

    spawn_build(
        #[cfg(feature = "desktop")]
        rt.inner(),
        #[cfg(not(feature = "desktop"))]
        &rt,
        repo_for_log,
        move || {
            let built = ContentIndex::build(PathBuf::from(&repo), Some(&throttle), HashMap::new());
            *index_ref.write() = built;
            tracing::info!(repo = %repo, "content index built");
        },
        Some(in_flight),
        sem,
    );

    index
}

/// Rebuild the content index for a repo (called on RepoChanged events).
/// Runs in background, does not block. Skips if a build is already in-flight
/// for this repo (via `state.index_in_flight`) — the next `RepoChanged` will
/// pick up any missed changes.
pub fn rebuild_index(state: &Arc<crate::state::AppState>, repo_path: &str) {
    let in_flight = &state.index_in_flight;
    let index = if let Some(existing) = state.content_indices.get(repo_path) {
        Arc::clone(existing.value())
    } else {
        return;
    };

    {
        let idx = index.read();
        if idx.ready && idx.built_at.elapsed() < REBUILD_COOLDOWN {
            tracing::trace!(repo = %repo_path, "content index rebuild skipped (cooldown)");
            return;
        }
    }

    if !in_flight.insert(repo_path.to_string()) {
        tracing::debug!(repo = %repo_path, "content index rebuild skipped (already in-flight)");
        return;
    }

    let repo = repo_path.to_string();
    let throttle = Arc::clone(&state.indexer_throttle);
    let sem = Arc::clone(&state.index_build_sem);
    let repo_for_log = repo.clone();
    #[cfg(feature = "desktop")]
    let rt = tauri::async_runtime::handle();
    #[cfg(not(feature = "desktop"))]
    let rt = tokio::runtime::Handle::current();

    spawn_build(
        #[cfg(feature = "desktop")]
        rt.inner(),
        #[cfg(not(feature = "desktop"))]
        &rt,
        repo_for_log,
        move || rebuild_in_place(&index, &repo, Some(&throttle)),
        Some(Arc::clone(in_flight)),
        sem,
    );
}

/// Re-index `repo` into `index`, unless the index already reflects what is on
/// disk. Blocking — runs on the build pool.
///
/// The currency check is why this exists as its own function: it is the whole
/// point of the rebuild path and has to be testable without a 60-second cooldown
/// and a background task in the way.
fn rebuild_in_place(
    index: &parking_lot::RwLock<ContentIndex>,
    repo: &str,
    throttle: Option<&IndexerThrottle>,
) {
    let prior_binaries = {
        let idx = index.read();
        if idx.is_current() {
            tracing::debug!(repo = %repo, "content index rebuild skipped (no indexable change)");
            return;
        }
        idx.known_binaries.clone()
    };
    let built = ContentIndex::build(PathBuf::from(repo), throttle, prior_binaries);
    *index.write() = built;
    tracing::debug!(repo = %repo, "content index rebuilt");
}

/// Spawn a background task that listens to the event bus and rebuilds
/// content indices when repos change. Should be called once at startup.
pub fn spawn_content_index_updater(state: Arc<crate::state::AppState>) {
    let mut rx = state.event_bus.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                // Both kinds, deliberately: a `git checkout` is git-state and
                // rewrites indexable files wholesale, so narrowing this to
                // working-tree would leave the index describing the old branch.
                Ok(crate::state::AppEvent::RepoChanged { repo_path, .. }) => {
                    // The in-memory cache, NOT `load_app_config()`: that holds the
                    // config mutex and a cross-process *file* lock across the whole
                    // read, and this arm runs on every RepoChanged — hundreds an
                    // hour per repo. `state.config` is kept current by every save.
                    if state.config.read().index_strategy != "disabled" {
                        rebuild_index(&state, &repo_path);
                    }
                }
                Ok(other) => {
                    // Other AppEvent variants intentionally ignored by the
                    // content_index updater — trace so new variants are
                    // visible in debug builds.
                    tracing::trace!(source = "content_index", ?other, "ignored event");
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(source = "content_index", lagged = n, "event bus lagged");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Check if a file is binary by reading the first 8 KB for null bytes.
fn is_binary(path: &Path) -> bool {
    use std::io::Read;
    let mut buf = [0u8; 8192];
    match std::fs::File::open(path).and_then(|mut f| f.read(&mut buf)) {
        Ok(n) => buf[..n].contains(&0u8),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Create a temp repo directory with some text files for testing.
    fn make_test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Create a few text files with known content
        fs::write(
            root.join("main.rs"),
            "fn main() {\n    println!(\"hello world\");\n}\n",
        )
        .unwrap();
        fs::write(
            root.join("lib.rs"),
            "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
        )
        .unwrap();
        fs::write(
            root.join("search.rs"),
            "use bm25::SearchEngine;\nfn search_content(query: &str) {\n    // BM25 search implementation\n}\n",
        ).unwrap();
        fs::write(
            root.join("README.md"),
            "# My Project\n\nA project about search and indexing.\n",
        )
        .unwrap();

        // Create a subdirectory with a file
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/utils.rs"),
            "pub fn format_result(s: &str) -> String {\n    s.to_uppercase()\n}\n",
        )
        .unwrap();

        dir
    }

    #[test]
    fn build_indexes_text_files() {
        let repo = make_test_repo();
        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());

        assert!(index.is_ready());
        assert_eq!(index.len(), 5); // main.rs, lib.rs, search.rs, README.md, src/utils.rs
    }

    #[test]
    fn build_does_not_retain_document_text() {
        let repo = make_test_repo();
        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());

        assert_eq!(
            index.retained_document_text_bytes(),
            0,
            "search needs embeddings and file ids, not a second in-memory copy of every file"
        );
    }

    #[test]
    fn build_tokenizes_each_document_once() {
        let repo = make_test_repo();
        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());

        assert_eq!(
            index.build_document_tokenizations(),
            index.len(),
            "fitting avgdl and creating embeddings must share the first tokenization"
        );
    }

    #[test]
    fn search_finds_relevant_file() {
        let repo = make_test_repo();
        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());

        let results = index.search("BM25 search implementation", 5);
        assert!(!results.is_empty());
        assert_eq!(results[0].rel_path, "search.rs");
    }

    #[test]
    fn search_ranks_by_relevance() {
        let repo = make_test_repo();
        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());

        // "println hello" should rank main.rs first
        let results = index.search("println hello", 5);
        assert!(!results.is_empty());
        assert_eq!(results[0].rel_path, "main.rs");
    }

    #[test]
    fn search_empty_query_returns_nothing() {
        let repo = make_test_repo();
        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());

        assert!(index.search("", 5).is_empty());
        assert!(index.search("   ", 5).is_empty());
    }

    #[test]
    fn empty_index_returns_nothing() {
        let index = ContentIndex::empty(PathBuf::from("/nonexistent"));
        assert!(!index.is_ready());
        assert!(index.search("anything", 5).is_empty());
    }

    #[test]
    fn a_fallback_search_guard_cannot_starve_an_index_checkpoint() {
        let throttle = Arc::new(IndexerThrottle::default());
        let guard = throttle.begin_search();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            throttle.checkpoint();
            tx.send(()).unwrap();
        });

        let completed_while_search_was_active = rx
            .recv_timeout(THROTTLE_SEARCH_POLL * 2 + Duration::from_millis(100))
            .is_ok();
        drop(guard);
        worker.join().unwrap();

        assert!(
            completed_while_search_was_active,
            "a long fallback grep must defer the build briefly, not pause it until grep completes"
        );
    }

    #[test]
    fn skips_binary_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        fs::write(root.join("text.rs"), "fn hello() {}").unwrap();
        // Binary file: contains null bytes
        fs::write(root.join("binary.bin"), b"\x00\x01\x02\x03").unwrap();

        let index = ContentIndex::build(root.to_path_buf(), None, HashMap::new());
        assert_eq!(index.len(), 1); // only text.rs
    }

    #[test]
    fn skips_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        fs::write(root.join("small.rs"), "fn small() {}").unwrap();
        // File > 1 MB
        let large = "x".repeat(MAX_FILE_SIZE as usize + 1);
        fs::write(root.join("large.txt"), large).unwrap();

        let index = ContentIndex::build(root.to_path_buf(), None, HashMap::new());
        assert_eq!(index.len(), 1); // only small.rs
    }

    #[test]
    fn absolute_path_resolves_correctly() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("test.rs"), "fn test() {}").unwrap();

        let index = ContentIndex::build(root.to_path_buf(), None, HashMap::new());
        let abs = index.absolute_path("test.rs");
        assert!(abs.ends_with("test.rs"));
        assert!(abs.is_absolute());
    }

    #[test]
    fn search_finds_file_in_subdirectory() {
        let repo = make_test_repo();
        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());

        let results = index.search("format_result to_uppercase", 5);
        assert!(!results.is_empty());
        assert_eq!(results[0].rel_path, "src/utils.rs");
    }

    #[test]
    fn skips_dot_git_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        fs::write(root.join("real.rs"), "fn real() {}").unwrap();
        // Simulate .git internals (normally not in .gitignore)
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(root.join(".git/objects/pack.txt"), "pack data here").unwrap();

        let index = ContentIndex::build(root.to_path_buf(), None, HashMap::new());
        assert_eq!(index.len(), 1); // only real.rs
        assert!(index.search("pack data", 5).is_empty());
    }

    /// Most `RepoChanged` events do not touch indexable content: `git add`,
    /// `git commit`, a stash, a branch ref move — every git-state change emits one
    /// while the working tree's bytes are unchanged. Each of those used to
    /// schedule a full re-read of every text file in the repo plus a complete BM25
    /// corpus rebuild, once a minute, forever. A stat-only walk answers "did
    /// anything indexable change" for a fraction of the cost.
    #[test]
    fn is_current_detects_edits_additions_and_deletions() {
        let repo = make_test_repo();
        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());

        assert!(
            index.is_current(),
            "nothing changed since the build — a rebuild would be pure waste"
        );

        fs::write(repo.path().join("main.rs"), "fn main() { /* edited */ }").unwrap();
        assert!(
            !index.is_current(),
            "an edited indexed file must invalidate"
        );

        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());
        fs::write(repo.path().join("brand_new.rs"), "fn brand_new() {}").unwrap();
        assert!(!index.is_current(), "a new file must invalidate");

        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());
        fs::remove_file(repo.path().join("brand_new.rs")).unwrap();
        assert!(!index.is_current(), "a deleted file must invalidate");
    }

    /// A file the build could not decode is in neither `entries` nor
    /// `known_binaries`, so `is_current` would count it as never-seen and report
    /// stale forever — silently reverting this repo to a full rebuild a minute,
    /// with nothing to show why. Latin-1 text whose first 8 KB has no null byte
    /// is exactly that: not binary by the probe, not valid UTF-8 either.
    #[test]
    fn is_current_is_stable_for_a_file_that_cannot_be_decoded() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("ok.rs"), "fn ok() {}").unwrap();
        // No null bytes (so `is_binary` says text) but invalid UTF-8 past 8 KB.
        let mut latin1 = vec![b'a'; 9000];
        latin1.extend_from_slice(&[0xE9, 0xE8, 0xFF]);
        fs::write(root.join("latin1.txt"), &latin1).unwrap();

        let index = ContentIndex::build(root.to_path_buf(), None, HashMap::new());
        assert!(
            index.is_current(),
            "an undecodable file must not make the index look permanently stale"
        );
    }

    /// An edit landing in the same wall-clock second as the build must still
    /// invalidate. Second-granularity mtimes silently miss those, and an agent
    /// editing a file twice in a second is the normal case here.
    #[test]
    fn is_current_detects_a_same_second_edit() {
        let repo = make_test_repo();
        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());
        fs::write(repo.path().join("lib.rs"), "pub fn add() -> i32 { 0 }").unwrap();
        assert!(
            !index.is_current(),
            "an edit within the same second as the build must invalidate"
        );
    }

    /// A restore that preserves timestamps — `cp -p`, `rsync -a`, `tar -x`,
    /// unpacking a build cache — replaces the content while leaving mtime exactly
    /// as the build recorded it. On mtime alone the index reports itself current
    /// and keeps serving the old text for as long as nothing else touches the
    /// file. The size is stat'd by the same walk, so comparing it costs nothing.
    #[test]
    fn is_current_detects_a_replacement_that_preserved_the_mtime() {
        let repo = make_test_repo();
        let target = repo.path().join("main.rs");
        let original_mtime = fs::metadata(&target).unwrap().modified().unwrap();

        let index = ContentIndex::build(repo.path().to_path_buf(), None, HashMap::new());
        assert!(index.is_current());

        // Different content, different length, mtime restored to the indexed value.
        fs::write(
            &target,
            "fn main() { println!(\"restored from an archive\"); }",
        )
        .unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&target)
            .unwrap()
            .set_modified(original_mtime)
            .unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().modified().unwrap(),
            original_mtime,
            "the test must actually restore the mtime, or it proves nothing"
        );

        assert!(
            !index.is_current(),
            "content replaced under a preserved mtime must invalidate"
        );
    }

    #[test]
    fn rebuild_in_place_leaves_an_unchanged_index_alone() {
        let repo = make_test_repo();
        let repo_path = repo.path().to_string_lossy().to_string();
        let index = parking_lot::RwLock::new(ContentIndex::build(
            repo.path().to_path_buf(),
            None,
            HashMap::new(),
        ));
        let built_at = index.read().built_at;

        rebuild_in_place(&index, &repo_path, None);
        assert_eq!(
            index.read().built_at,
            built_at,
            "an unchanged repo must not be re-indexed"
        );

        fs::write(repo.path().join("main.rs"), "fn main() { /* edited */ }").unwrap();
        rebuild_in_place(&index, &repo_path, None);
        assert!(
            index.read().built_at > built_at,
            "a real content change must still be re-indexed"
        );
    }

    /// The updater must read `index_strategy` from the in-memory config, not from
    /// disk. `load_app_config` takes the in-process config mutex AND a
    /// cross-process file lock for the whole read, and this ran once per
    /// `RepoChanged` — hundreds of times an hour during a working-tree storm,
    /// serialising against every other config reader and writer in both the
    /// release app and a `make dev` build sharing the config dir.
    #[tokio::test]
    async fn repo_changed_reads_index_strategy_from_the_in_memory_config() {
        let cfg_dir = tempfile::tempdir().unwrap();
        // On-disk config keeps indexing enabled (the default), so reading the
        // file instead of the cache is observable as a rebuild that should not
        // have happened.
        let _guard = crate::config::set_config_dir_override(cfg_dir.path().to_path_buf());

        let repo = make_test_repo();
        let repo_path = repo.path().to_string_lossy().to_string();
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        state.config.write().index_strategy = "disabled".to_string();
        let index = Arc::new(parking_lot::RwLock::new(ContentIndex::empty(
            repo.path().to_path_buf(),
        )));
        state
            .content_indices
            .insert(repo_path.clone(), Arc::clone(&index));

        spawn_content_index_updater(Arc::clone(&state));
        // Let the subscriber attach before the send — a broadcast delivers only
        // to receivers that already exist.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = state.event_bus.send(crate::state::AppEvent::RepoChanged {
            repo_path: repo_path.clone(),
            kind: crate::repo_watcher::RepoChangeKind::WorkingTree,
        });
        tokio::time::sleep(Duration::from_millis(500)).await;

        assert!(
            !index.read().is_ready(),
            "index_strategy=disabled in the live config must suppress the rebuild"
        );
    }

    #[test]
    fn query_is_sub_millisecond() {
        // Create a repo with 200 files to simulate realistic conditions
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        for i in 0..200 {
            let content = format!(
                "// File {i}\nfn function_{i}() {{\n    let value = {};\n    println!(\"result: {{}}\", value);\n}}\n",
                i * 42
            );
            fs::write(root.join(format!("file_{i}.rs")), content).unwrap();
        }

        let index = ContentIndex::build(root.to_path_buf(), None, HashMap::new());
        assert_eq!(index.len(), 200);

        // Warm up
        let _ = index.search("function value", 50);

        // Measure query time (10 iterations)
        let start = std::time::Instant::now();
        let iterations = 10;
        for _ in 0..iterations {
            let _ = index.search("function value println result", 50);
        }
        let elapsed = start.elapsed();
        let avg_us = elapsed.as_micros() / iterations;

        // Each query should be under 5ms (generous for CI, typically ~0.1ms)
        assert!(
            avg_us < 5000,
            "Average query time {avg_us}µs exceeds 5ms threshold"
        );
    }
}
