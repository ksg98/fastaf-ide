//! The loopback door: the ChatGPT subscription as an OpenAI-compatible endpoint.
//!
//! A small axum server on `127.0.0.1:<free port>`, behind a per-process bearer
//! key, serving:
//!
//! - `GET  /v1/models` — the backend's live list ([`wire::models_document`])
//! - `POST /v1/chat/completions` — one Responses turn per request, streamed or not
//!
//! The provider registry hands this URL and key to every caller of a
//! `chat_gpt` provider, so genai, the dictation rewrite and model discovery
//! work unchanged. It runs on its own thread and runtime, started on first use
//! from any context (sync or async, Tauri or headless) — `resolve_model` is
//! sync and cannot spawn onto a runtime it may not be inside.

use std::sync::Mutex;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde_json::{Value, json};

use super::wire::{self, ChunkWriter, WireError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Door {
    pub port: u16,
    pub key: String,
}

impl Door {
    /// Base URL with the trailing slash genai needs to join `chat/completions`.
    pub(crate) fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/v1/", self.port)
    }
}

static DOOR: Mutex<Option<Door>> = Mutex::new(None);

/// The open door, opening it on first call.
pub(crate) fn ensure() -> Result<Door, String> {
    let mut door = DOOR.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(open) = door.as_ref() {
        return Ok(open.clone());
    }

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Could not open the ChatGPT endpoint: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Could not open the ChatGPT endpoint: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not open the ChatGPT endpoint: {e}"))?
        .port();
    let mut key_bytes = [0u8; 32];
    rand::fill(&mut key_bytes);
    let key = hex::encode(key_bytes);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("chatgpt-door")
        .enable_all()
        .build()
        .map_err(|e| format!("Could not start the ChatGPT endpoint: {e}"))?;
    let router = router(key.clone());
    std::thread::Builder::new()
        .name("chatgpt-door".to_string())
        .spawn(move || {
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(e) => {
                        tracing::error!(source = "chatgpt", error = %e, "ChatGPT endpoint failed to listen");
                        return;
                    }
                };
                if let Err(e) = axum::serve(listener, router).await {
                    tracing::error!(source = "chatgpt", error = %e, "ChatGPT endpoint stopped");
                }
            });
        })
        .map_err(|e| format!("Could not start the ChatGPT endpoint: {e}"))?;

    tracing::info!(
        source = "chatgpt",
        port,
        "ChatGPT endpoint open on loopback"
    );
    let open = Door { port, key };
    *door = Some(open.clone());
    Ok(open)
}

pub(crate) fn router(key: String) -> axum::Router {
    axum::Router::new()
        .route("/v1/models", axum::routing::get(models))
        .route(
            "/v1/chat/completions",
            axum::routing::post(chat_completions),
        )
        .layer(axum::middleware::from_fn_with_state(key, require_key))
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024))
}

fn openai_error(status: u16, message: &str) -> Response {
    let status = StatusCode::from_u16(status)
        .ok()
        .filter(|s| s.is_client_error() || s.is_server_error())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let kind = if status.is_client_error() {
        "invalid_request_error"
    } else {
        "server_error"
    };
    (
        status,
        Json(json!({ "error": { "message": message, "type": kind, "code": "chatgpt" } })),
    )
        .into_response()
}

impl IntoResponse for WireError {
    fn into_response(self) -> Response {
        openai_error(self.status, &self.message)
    }
}

/// Length-independent comparison, so the key cannot be probed byte by byte.
fn same_key(presented: &[u8], expected: &[u8]) -> bool {
    presented.len() == expected.len()
        && presented
            .iter()
            .zip(expected)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

async fn require_key(
    State(key): State<String>,
    headers: HeaderMap,
    req: Request,
    next: Next,
) -> Response {
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default()
        .trim();
    if !same_key(presented.as_bytes(), key.as_bytes()) {
        return openai_error(401, "This endpoint only answers FastAF itself");
    }
    next.run(req).await
}

async fn models() -> Response {
    match wire::list_models().await {
        Ok(models) => Json(wire::models_document(&models)).into_response(),
        Err(e) => e.into_response(),
    }
}

async fn chat_completions(body: Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return openai_error(400, "The request body is not JSON");
    };
    if body
        .get("messages")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty)
    {
        return openai_error(400, "messages is required");
    }
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let turn = wire::chat_to_responses(&body);

    if body.get("stream").and_then(Value::as_bool) != Some(true) {
        return match wire::run_turn(&turn).await {
            Ok((items, usage, incomplete)) => {
                Json(wire::chat_completion(&model, &items, &usage, incomplete)).into_response()
            }
            Err(e) => e.into_response(),
        };
    }

    // Open the turn before answering, so a refused request (not signed in,
    // usage limit, unknown model) is a real HTTP error, not a broken stream.
    let resp = match wire::open_turn(&turn).await {
        Ok(resp) => resp,
        Err(e) => return e.into_response(),
    };
    let stream = async_stream::stream! {
        let mut writer = ChunkWriter::new(&model);
        yield Ok::<_, std::convert::Infallible>(Bytes::from(writer.start()));
        let events = wire::turn_events(resp);
        futures_util::pin_mut!(events);
        while let Some(event) = events.next().await {
            let chunks = event.and_then(|event| writer.on_event(&event));
            match chunks {
                Ok(chunks) => {
                    for chunk in chunks {
                        yield Ok(Bytes::from(chunk));
                    }
                }
                Err(e) => {
                    tracing::warn!(source = "chatgpt", error = %e.message, "ChatGPT turn failed mid-stream");
                    yield Ok(Bytes::from(ChunkWriter::error_chunk(&e)));
                    return;
                }
            }
        }
        for chunk in writer.finish() {
            yield Ok(Bytes::from(chunk));
        }
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| openai_error(500, "Could not build the stream"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chatgpt::auth;
    use serial_test::serial;

    #[test]
    fn same_key_compares_whole_keys() {
        assert!(same_key(b"abc", b"abc"));
        assert!(!same_key(b"abd", b"abc"));
        assert!(!same_key(b"ab", b"abc"));
        assert!(!same_key(b"", b"abc"));
    }

    /// A fake Codex backend: `/models`, and `/responses` answering one text
    /// delta or one tool call depending on whether tools were offered.
    async fn fake_backend() -> (String, std::sync::Arc<Mutex<Vec<(HeaderMap, Value)>>>) {
        let seen = std::sync::Arc::new(Mutex::new(Vec::<(HeaderMap, Value)>::new()));
        let seen_in = seen.clone();
        let app = axum::Router::new()
            .route(
                "/models",
                axum::routing::get(|| async {
                    Json(json!({ "models": [
                        { "slug": "gpt-test", "display_name": "GPT Test", "visibility": "list",
                          "supported_reasoning_levels": [{ "effort": "low" }, { "effort": "high" }],
                          "default_reasoning_level": "low" },
                        { "slug": "hidden", "visibility": "hide" },
                    ]}))
                }),
            )
            .route(
                "/responses",
                axum::routing::post(move |headers: HeaderMap, Json(body): Json<Value>| {
                    let seen = seen_in.clone();
                    async move {
                        let with_tools = body["tools"].as_array().is_some_and(|t| !t.is_empty());
                        seen.lock().unwrap().push((headers, body));
                        let events = if with_tools {
                            vec![
                                json!({ "type": "response.created" }),
                                json!({ "type": "response.output_item.done", "item": {
                                    "type": "function_call", "call_id": "call_a", "name": "lookup", "arguments": "{\"q\":\"x\"}"
                                }}),
                                json!({ "type": "response.completed", "response": { "output": [], "usage": { "input_tokens": 7, "output_tokens": 3 } } }),
                            ]
                        } else {
                            vec![
                                json!({ "type": "response.output_text.delta", "delta": "Hel" }),
                                json!({ "type": "response.output_text.delta", "delta": "lo" }),
                                json!({ "type": "response.output_item.done", "item": {
                                    "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Hello" }]
                                }}),
                                json!({ "type": "response.completed", "response": { "output": [], "usage": { "input_tokens": 5, "output_tokens": 2 } } }),
                            ]
                        };
                        let sse = events.iter().fold(String::new(), |mut sse, e| {
                            use std::fmt::Write as _;
                            let _ = write!(sse, "event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap());
                            sse
                        });
                        ([(header::CONTENT_TYPE, "text/event-stream")], sse)
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, seen)
    }

    fn signed_in() {
        let mut tokens = auth::tests::fake_tokens(u64::MAX / 2);
        tokens.account_id = "acct-door".to_string();
        auth::save_blocking(&tokens).unwrap();
        wire::reset_models_cache();
    }

    fn genai_client(door: &Door) -> genai::Client {
        crate::llm_api::build_client(
            &crate::llm_api::LlmApiConfig {
                provider: "chatgpt".to_string(),
                model: "gpt-test".to_string(),
                base_url: Some(door.base_url()),
            },
            &door.key,
        )
    }

    #[tokio::test]
    #[serial(chatgpt)]
    async fn genai_chats_through_the_door_streamed_and_not() {
        use genai::chat::{ChatMessage, ChatOptions, ChatRequest, ChatStreamEvent, Tool};

        let (backend, seen) = fake_backend().await;
        wire::set_backend_override(Some(backend));
        signed_in();
        let door = ensure().unwrap();
        let client = genai_client(&door);

        // Not streamed.
        let request = ChatRequest::default()
            .with_system("Be brief.")
            .append_message(ChatMessage::user("hi"));
        let options = ChatOptions::default()
            .with_temperature(0.3)
            .with_max_tokens(50);
        let answer = client
            .exec_chat("gpt-test", request.clone(), Some(&options))
            .await
            .unwrap();
        assert_eq!(answer.first_text(), Some("Hello"));
        assert_eq!(answer.usage.total_tokens, Some(7));

        {
            let seen = seen.lock().unwrap();
            let (headers, body) = seen.last().unwrap();
            assert_eq!(headers["chatgpt-account-id"], "acct-door");
            assert_eq!(headers["originator"], wire::ORIGINATOR);
            assert!(
                headers["authorization"]
                    .to_str()
                    .unwrap()
                    .starts_with("Bearer ")
            );
            assert_eq!(body["instructions"], "Be brief.");
            assert_eq!(body["store"], false);
            assert!(body.get("temperature").is_none());
            assert!(body.get("max_output_tokens").is_none());
        }

        // Streamed text.
        let options = ChatOptions::default()
            .with_capture_content(true)
            .with_capture_usage(true);
        let mut stream = client
            .exec_chat_stream("gpt-test", request, Some(&options))
            .await
            .unwrap()
            .stream;
        let mut text = String::new();
        let mut usage_total = None;
        while let Some(event) = stream.next().await {
            match event.unwrap() {
                ChatStreamEvent::Chunk(chunk) => text.push_str(&chunk.content),
                ChatStreamEvent::End(end) => {
                    usage_total = end.captured_usage.and_then(|u| u.total_tokens);
                }
                _ => {}
            }
        }
        assert_eq!(text, "Hello");
        assert_eq!(usage_total, Some(7));

        // Streamed tool call.
        let tool_request = ChatRequest::default()
            .append_message(ChatMessage::user("look it up"))
            .with_tools(vec![Tool::new("lookup").with_schema(json!({
                "type": "object", "properties": { "q": { "type": "string" } }
            }))]);
        let options = ChatOptions::default().with_capture_tool_calls(true);
        let mut stream = client
            .exec_chat_stream("gpt-test", tool_request, Some(&options))
            .await
            .unwrap()
            .stream;
        let mut calls = Vec::new();
        while let Some(event) = stream.next().await {
            if let ChatStreamEvent::End(end) = event.unwrap()
                && let Some(captured) = end.captured_tool_calls()
            {
                calls.extend(captured.into_iter().cloned());
            }
        }
        assert_eq!(calls.len(), 1, "one tool call captured");
        assert_eq!(calls[0].call_id, "call_a");
        assert_eq!(calls[0].fn_name, "lookup");
        assert_eq!(calls[0].fn_arguments, json!({ "q": "x" }));

        wire::set_backend_override(None);
    }

    #[tokio::test]
    #[serial(chatgpt)]
    async fn models_are_listed_for_discovery_and_the_key_is_required() {
        let (backend, _) = fake_backend().await;
        wire::set_backend_override(Some(backend));
        signed_in();
        let door = ensure().unwrap();
        let http = reqwest::Client::new();

        let refused = http
            .get(format!("{}models", door.base_url()))
            .send()
            .await
            .unwrap();
        assert_eq!(refused.status(), 401);

        let doc: Value = http
            .get(format!("{}models", door.base_url()))
            .bearer_auth(&door.key)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let models = crate::provider_registry::parse_discovered_models(&doc);
        assert_eq!(models.len(), 1, "hidden models stay hidden");
        assert_eq!(models[0].id, "gpt-test");
        assert_eq!(models[0].default_effort.as_deref(), Some("low"));

        wire::set_backend_override(None);
    }

    #[tokio::test]
    #[serial(chatgpt)]
    async fn signed_out_is_a_403_with_a_sign_in_hint() {
        auth::sign_out().await.unwrap();
        let door = ensure().unwrap();
        let resp = reqwest::Client::new()
            .post(format!("{}chat/completions", door.base_url()))
            .bearer_auth(&door.key)
            .json(&json!({ "model": "m", "messages": [{ "role": "user", "content": "x" }], "stream": true }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 403);
        let body: Value = resp.json().await.unwrap();
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Settings › Providers"),
            "{body}"
        );
    }
}
