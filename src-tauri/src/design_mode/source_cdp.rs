use futures_util::{Stream, StreamExt};
use serde_json::Value;
use sourcemap::{DecodedMap, SourceMap};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retained CDP path (design-mode-v2 sections 14/15)"
    )
)]
const MAX_SCRIPTS: usize = 2_000;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retained CDP path (design-mode-v2 sections 14/15)"
    )
)]
const MAX_CONCURRENT_FETCHES: usize = 4;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retained CDP path (design-mode-v2 sections 14/15)"
    )
)]
const MAX_MAP_BYTES: usize = 5 * 1024 * 1024;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retained CDP path (design-mode-v2 sections 14/15)"
    )
)]
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

pub(crate) use super::source::SourceLoc;
use super::source::clean_file;
struct ScriptEntry {
    map: SourceMap,
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Retained CDP path (design-mode-v2 sections 14/15)"
        )
    )]
    bytes: usize,
}

#[derive(Default)]
pub(crate) struct ScriptMaps {
    entries: HashMap<String, ScriptEntry>,
    order: VecDeque<String>,
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Retained CDP path (design-mode-v2 sections 14/15)"
        )
    )]
    total_bytes: usize,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retained CDP path (design-mode-v2 sections 14/15)"
    )
)]
fn decode_map(bytes: &[u8]) -> Option<SourceMap> {
    if bytes.len() > MAX_MAP_BYTES {
        return None;
    }
    match sourcemap::decode_slice(bytes).ok()? {
        DecodedMap::Regular(map) => Some(map),
        DecodedMap::Index(index) => index.flatten().ok(),
        _ => None,
    }
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retained CDP path (design-mode-v2 sections 14/15)"
    )
)]
fn loopback_url(value: &str) -> Option<url::Url> {
    let url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    match url.host_str()? {
        "localhost" | "127.0.0.1" | "[::1]" => Some(url),
        _ => None,
    }
}

impl ScriptMaps {
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Retained CDP path (design-mode-v2 sections 14/15)"
        )
    )]
    pub(crate) fn insert(&mut self, script_url: &str, bytes: &[u8]) -> bool {
        let Some(map) = decode_map(bytes) else {
            return false;
        };
        self.order.retain(|item| item != script_url);
        if let Some(old) = self.entries.remove(script_url) {
            self.total_bytes -= old.bytes;
        }
        self.total_bytes += bytes.len();
        self.order.push_back(script_url.to_owned());
        self.entries.insert(
            script_url.to_owned(),
            ScriptEntry {
                map,
                bytes: bytes.len(),
            },
        );
        while self.entries.len() > MAX_SCRIPTS || self.total_bytes > MAX_TOTAL_BYTES {
            if let Some(oldest) = self.order.pop_front() {
                if let Some(old) = self.entries.remove(&oldest) {
                    self.total_bytes -= old.bytes;
                }
            } else {
                break;
            }
        }
        true
    }

    fn lookup(&mut self, script_url: &str, line: u32, column: u32) -> Option<SourceLoc> {
        let entry = self.entries.get(script_url)?;
        let token = entry
            .map
            .lookup_token(line.checked_sub(1)?, column.checked_sub(1)?)?;
        let location = SourceLoc {
            file: clean_file(token.get_source()?),
            line: token.get_src_line() + 1,
            column: token.get_src_col() + 1,
        };
        self.order.retain(|item| item != script_url);
        self.order.push_back(script_url.to_owned());
        Some(location)
    }
}

/// One client for every map, without system proxy discovery. Measured
/// 2026-09-23 on macOS: a client per fetch cost ~0.5 s each, and proxy
/// discovery alone 1.4-11 s — a burst of hundreds of modules would take minutes.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retained CDP path (design-mode-v2 sections 14/15)"
    )
)]
fn map_client() -> Option<&'static reqwest::Client> {
    static CLIENT: std::sync::LazyLock<Option<reqwest::Client>> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            // Loopback only: a system proxy has no business seeing these.
            .no_proxy()
            .build()
            .ok()
    });
    CLIENT.as_ref()
}

/// Fetch without holding the ScriptMaps mutex: a slow local dev server must not
/// block an inspect click while it resolves a source frame.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retained CDP path (design-mode-v2 sections 14/15)"
    )
)]
pub(crate) async fn fetch_source_map(script_url: &str, source_map_url: &str) -> Option<Vec<u8>> {
    if source_map_url.starts_with("data:") {
        if source_map_url.len() > MAX_MAP_BYTES * 2 {
            return None;
        }
        let decoded = sourcemap::decode_data_url(source_map_url).ok()?;
        let map = match decoded {
            DecodedMap::Regular(map) => map,
            DecodedMap::Index(index) => index.flatten().ok()?,
            _ => return None,
        };
        let mut bytes = Vec::new();
        map.to_writer(&mut bytes).ok()?;
        (bytes.len() <= MAX_MAP_BYTES).then_some(bytes)
    } else {
        let script = loopback_url(script_url)?;
        let resolved = script.join(source_map_url).ok()?;
        loopback_url(resolved.as_str())?;
        let response = map_client()?.get(resolved).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_MAP_BYTES as u64)
        {
            return None;
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.ok()?;
            if bytes.len().saturating_add(chunk.len()) > MAX_MAP_BYTES {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        Some(bytes)
    }
}

/// What the source-map loader needs to know about the inspected page.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retained CDP path (design-mode-v2 sections 14/15)"
    )
)]
pub(crate) enum PageEvent {
    /// The main frame committed a navigation to this URL.
    Navigated(String),
    ScriptParsed {
        url: String,
        source_map_url: String,
        has_source_url: bool,
    },
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Retained CDP path (design-mode-v2 sections 14/15)"
    )
)]
fn origin_of(value: &str) -> Option<url::Origin> {
    url::Url::parse(value)
        .ok()
        .map(|url| url.origin())
        .filter(url::Origin::is_tuple)
}

/// Loads the source map of every script the page announces. A dev server
/// announces hundreds of modules in one burst, so network fetches queue behind
/// four permits instead of being dropped; `data:` maps cost no request and
/// decode inline. The page controls script URLs (`//# sourceURL=`), so a map is
/// fetched only for a script served by the dev server or by the page's own
/// origin: otherwise any site could make TUICommander send GETs to loopback.
pub(crate) async fn load_maps<S>(
    mut events: S,
    maps: Arc<Mutex<ScriptMaps>>,
    dev_server_url: Option<String>,
    page_url: Option<String>,
) where
    S: Stream<Item = PageEvent> + Unpin,
{
    let dev_origin = dev_server_url.as_deref().and_then(origin_of);
    let mut page_origin = page_url.as_deref().and_then(origin_of);
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_FETCHES));
    let mut jobs = tokio::task::JoinSet::new();
    let log_failure = |result: Result<(), tokio::task::JoinError>| {
        if let Err(error) = result {
            tracing::warn!(%error, "Design Mode source-map task failed");
        }
    };
    while let Some(event) = events.next().await {
        while let Some(result) = jobs.try_join_next() {
            log_failure(result);
        }
        let (script_url, map_url, has_source_url) = match event {
            PageEvent::Navigated(url) => {
                page_origin = origin_of(&url);
                continue;
            }
            PageEvent::ScriptParsed {
                url,
                source_map_url,
                has_source_url,
            } => (url, source_map_url, has_source_url),
        };
        if map_url.starts_with("data:") {
            if let Some(bytes) = fetch_source_map(&script_url, &map_url).await {
                maps.lock().await.insert(&script_url, &bytes);
            }
            continue;
        }
        let origin = origin_of(&script_url);
        if has_source_url || origin.is_none() || (origin != dev_origin && origin != page_origin) {
            continue;
        }
        if jobs.len() >= MAX_SCRIPTS {
            tracing::debug!(script_url, "Design Mode source-map queue is full");
            continue;
        }
        let permits = permits.clone();
        let maps = maps.clone();
        jobs.spawn(async move {
            let Ok(_permit) = permits.acquire_owned().await else {
                return;
            };
            if let Some(bytes) = fetch_source_map(&script_url, &map_url).await {
                maps.lock().await.insert(&script_url, &bytes);
            }
        });
    }
    while let Some(result) = jobs.join_next().await {
        log_failure(result);
    }
}

fn parse_frame(frame: &str) -> Option<(&str, u32, u32)> {
    let frame = frame.trim().trim_end_matches(')');
    let (before_col, col) = frame.rsplit_once(':')?;
    let (before_line, line) = before_col.rsplit_once(':')?;
    let url = before_line
        .rsplit_once('(')
        .map_or(before_line, |(_, url)| url)
        .split_whitespace()
        .last()?;
    Some((url, line.parse().ok()?, col.parse().ok()?))
}

pub(crate) fn resolve(hints: &Value, maps: &mut ScriptMaps) -> Option<SourceLoc> {
    if let Some(stack) = hints.get("reactStack").and_then(Value::as_str) {
        for frame in stack.lines() {
            if frame.contains("react_stack_bottom_frame") {
                break;
            }
            if frame.contains("jsxDEV") {
                continue;
            }
            if let Some((url, line, column)) = parse_frame(frame)
                && let Some(location) = maps.lookup(url, line, column)
            {
                return Some(location);
            }
        }
    }
    super::source::resolve(hints)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PLAIN: &[u8] = include_bytes!("../fixtures/design_mode/plain.map");
    const INDEX: &[u8] = include_bytes!("../fixtures/design_mode/index.map");
    const STACK: &str = include_str!("../fixtures/design_mode/react.stack");
    const SCRIPT: &str = "http://127.0.0.1:5173/src/App.js";

    #[test]
    fn stack_skips_jsxdev_and_stops_at_react_bottom() {
        let mut maps = ScriptMaps::default();
        assert!(maps.insert(SCRIPT, PLAIN));
        maps.insert("http://127.0.0.1:5173/should-not-resolve.js", INDEX);
        assert_eq!(
            resolve(&json!({"reactStack": STACK}), &mut maps),
            Some(SourceLoc {
                file: "src/App.tsx".into(),
                line: 1,
                column: 1,
            })
        );
        assert_eq!(
            resolve(
                &json!({"reactStack": "at jsxDEV (http://127.0.0.1:5173/src/App.js:1:1)\n at react_stack_bottom_frame (x:1:1)\n at Parent (http://127.0.0.1:5173/should-not-resolve.js:1:1)"}),
                &mut maps
            ),
            None
        );
    }

    #[test]
    fn plain_index_and_inline_maps_resolve() {
        let mut maps = ScriptMaps::default();
        assert!(maps.insert(SCRIPT, PLAIN));
        assert_eq!(maps.lookup(SCRIPT, 1, 1).unwrap().file, "src/App.tsx");
        assert!(maps.insert(SCRIPT, INDEX));
        assert_eq!(maps.lookup(SCRIPT, 1, 1).unwrap().file, "src/Indexed.tsx");
    }

    #[test]
    fn fallbacks_are_ordered_and_unknown_scripts_do_not_resolve() {
        let mut maps = ScriptMaps::default();
        let hints = json!({"reactStack": "at App (http://127.0.0.1:5173/unknown.js:1:1)", "reactSource": {"fileName": "webpack-internal:///src/React.tsx", "lineNumber": 5, "columnNumber": 7}, "svelteLoc": {"file": "turbopack:///src/Svelte.svelte", "line": 8}, "vueFile": "src/Vue.vue"});
        assert_eq!(resolve(&hints, &mut maps).unwrap().file, "/src/React.tsx");
        assert_eq!(
            resolve(
                &json!({"svelteLoc": hints["svelteLoc"], "vueFile": hints["vueFile"]}),
                &mut maps
            )
            .unwrap()
            .file,
            "/src/Svelte.svelte"
        );
        assert_eq!(
            resolve(&json!({"vueFile": "src/Vue.vue"}), &mut maps)
                .unwrap()
                .file,
            "src/Vue.vue"
        );
        assert_eq!(
            resolve(
                &json!({"reactStack": "at App (http://127.0.0.1:5173/unknown.js:1:1)"}),
                &mut maps
            ),
            None
        );
    }

    /// Serves `PLAIN` for every request after `delay`, counting requests, so
    /// concurrent fetches really overlap.
    async fn map_server(delay: Duration) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0; 1024];
                    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                        match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => request.extend_from_slice(&buffer[..read]),
                        }
                    }
                    tokio::time::sleep(delay).await;
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        PLAIN.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(PLAIN).await;
                });
            }
        });
        (origin, hits)
    }

    fn script(url: &str, map: &str) -> PageEvent {
        PageEvent::ScriptParsed {
            url: url.to_owned(),
            source_map_url: map.to_owned(),
            has_source_url: false,
        }
    }

    #[tokio::test]
    async fn a_burst_of_parsed_scripts_loads_every_map_not_just_the_first_four() {
        let (origin, hits) = map_server(Duration::from_millis(100)).await;
        let events: Vec<_> = (0..12)
            .map(|n| script(&format!("{origin}/src/{n}.js"), &format!("{n}.js.map")))
            .collect();
        let maps = Arc::new(Mutex::new(ScriptMaps::default()));
        load_maps(
            futures_util::stream::iter(events),
            maps.clone(),
            Some(origin.clone()),
            None,
        )
        .await;
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 12);
        let mut maps = maps.lock().await;
        for n in 0..12 {
            assert!(
                maps.lookup(&format!("{origin}/src/{n}.js"), 1, 1).is_some(),
                "map {n} was dropped"
            );
        }
    }

    #[tokio::test]
    async fn maps_are_fetched_only_for_the_dev_server_or_page_origin() {
        let (dev, dev_hits) = map_server(Duration::ZERO).await;
        let (other, other_hits) = map_server(Duration::ZERO).await;
        let (navigated, navigated_hits) = map_server(Duration::ZERO).await;
        let events = vec![
            // A hostile page names another loopback service as its script URL.
            script(&format!("{other}/x.js"), "/side-effect"),
            // eval() with `//# sourceURL=` pointing at the dev server itself.
            PageEvent::ScriptParsed {
                url: format!("{dev}/forged.js"),
                source_map_url: "/forged.map".into(),
                has_source_url: true,
            },
            script(&format!("{dev}/src/App.js"), "App.js.map"),
            script(&format!("{navigated}/app.js"), "app.js.map"),
            PageEvent::Navigated(format!("{navigated}/index.html")),
            script(&format!("{navigated}/app.js"), "app.js.map"),
        ];
        let maps = Arc::new(Mutex::new(ScriptMaps::default()));
        load_maps(
            futures_util::stream::iter(events),
            maps.clone(),
            Some(dev.clone()),
            None,
        )
        .await;
        use std::sync::atomic::Ordering::SeqCst;
        assert_eq!(
            other_hits.load(SeqCst),
            0,
            "unrelated loopback origin was fetched"
        );
        assert_eq!(
            dev_hits.load(SeqCst),
            1,
            "only the real dev-server script is fetched"
        );
        assert_eq!(
            navigated_hits.load(SeqCst),
            1,
            "the page origin counts after navigation"
        );
        let mut maps = maps.lock().await;
        assert!(maps.lookup(&format!("{dev}/src/App.js"), 1, 1).is_some());
        assert!(maps.lookup(&format!("{dev}/forged.js"), 1, 1).is_none());
    }

    #[tokio::test]
    async fn inline_maps_load_for_eval_scripts_without_a_request() {
        use base64::Engine as _;
        let body = br#"{"version":3,"sources":["src/Inline.tsx"],"names":[],"mappings":"AAAA"}"#;
        let map = format!(
            "data:application/json;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(body)
        );
        let events = vec![PageEvent::ScriptParsed {
            url: "webpack-internal:///./src/Inline.tsx".into(),
            source_map_url: map,
            has_source_url: true,
        }];
        let maps = Arc::new(Mutex::new(ScriptMaps::default()));
        load_maps(futures_util::stream::iter(events), maps.clone(), None, None).await;
        assert_eq!(
            maps.lock()
                .await
                .lookup("webpack-internal:///./src/Inline.tsx", 1, 1)
                .unwrap()
                .file,
            "src/Inline.tsx"
        );
    }

    #[test]
    fn cache_limits_and_loopback_guard() {
        let mut maps = ScriptMaps::default();
        for n in 0..=MAX_SCRIPTS {
            assert!(maps.insert(&format!("http://127.0.0.1:5173/{n}.js"), PLAIN));
        }
        assert_eq!(maps.entries.len(), MAX_SCRIPTS);
        assert!(!maps.entries.contains_key("http://127.0.0.1:5173/0.js"));
        assert!(loopback_url("https://example.com/app.js").is_none());
        assert!(loopback_url("http://127.0.0.1.evil.com/app.js").is_none());
    }
}
