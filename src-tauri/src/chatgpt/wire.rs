//! The ChatGPT subscription backend, translated to the OpenAI chat-completions wire.
//!
//! A ChatGPT Plus/Pro/Team subscription is served at
//! `https://chatgpt.com/backend-api/codex` — the endpoint Codex CLI (and every
//! tool that signs in with ChatGPT) talks to. It is a Responses API that only
//! streams, wants the ChatGPT account id in a header and `store: false` in the
//! body, and lists its models at `/models?client_version=`.
//!
//! Everything in FastAF that calls a model speaks chat completions on a base URL
//! and a key instead: genai's OpenAI adapter (AI Chat, agents, triage, Smart
//! Prompts), the dictation rewrite's raw request, and model discovery's
//! `GET {base}/models`. This module holds the two directions of that
//! translation (pure, unit-tested) plus the calls to the backend;
//! [`super::door`] serves them on loopback so none of those callers change.

use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::auth;

pub(crate) const BACKEND: &str = "https://chatgpt.com/backend-api/codex";
/// The backend hides models newer than the client asking. This is the Codex CLI
/// release the wire was checked against (2026-09-16); bump it with the wire.
pub(crate) const CLIENT_VERSION: &str = "0.153.4";
pub(crate) const ORIGINATOR: &str = "codex_cli_rs";
const DEFAULT_INSTRUCTIONS: &str = "You are a helpful assistant.";
const MODELS_CACHE_TTL: Duration = Duration::from_secs(300);

/// A failure the door answers with this HTTP status and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WireError {
    pub status: u16,
    pub message: String,
}

impl WireError {
    pub(crate) fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl From<auth::AuthError> for WireError {
    fn from(err: auth::AuthError) -> Self {
        // 403, not 401: callers map a bare 401 to "check your API key", which is
        // the wrong advice for a sign-in.
        Self::new(403, err.0)
    }
}

// ---------------------------------------------------------------------------
// Backend endpoint (overridable so tests can stand up a fake backend)
// ---------------------------------------------------------------------------

static BACKEND_OVERRIDE: RwLock<Option<String>> = RwLock::new(None);

fn backend() -> String {
    BACKEND_OVERRIDE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| BACKEND.to_string())
}

#[cfg(test)]
pub(crate) fn set_backend_override(url: Option<String>) {
    *BACKEND_OVERRIDE.write().unwrap_or_else(|e| e.into_inner()) = url;
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            // No overall timeout: a long reasoning turn streams for minutes. A
            // stalled socket still ends on the read timeout.
            .read_timeout(Duration::from_secs(300))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn backend_request(
    method: reqwest::Method,
    path: &str,
    tokens: &auth::Tokens,
    accept: &str,
) -> reqwest::RequestBuilder {
    http()
        .request(method, format!("{}{path}", backend()))
        .bearer_auth(&tokens.access_token)
        .header("ChatGPT-Account-Id", &tokens.account_id)
        .header("originator", ORIGINATOR)
        .header("OpenAI-Beta", "responses=experimental")
        .header("User-Agent", format!("{ORIGINATOR}/{CLIENT_VERSION}"))
        .header("Accept", accept)
}

fn network_error(err: reqwest::Error) -> WireError {
    WireError::new(502, format!("Could not reach ChatGPT: {err}"))
}

/// The human part of a backend error body, else a truncated body.
pub(crate) fn error_message(status: u16, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let from_json = parsed.as_ref().and_then(|v| {
        match v.get("error") {
            Some(Value::Object(err)) => err.get("message").and_then(Value::as_str),
            Some(Value::String(s)) => Some(s.as_str()),
            _ => None,
        }
        .or_else(|| v.get("detail").and_then(Value::as_str))
    });
    match from_json.filter(|m| !m.trim().is_empty()) {
        Some(message) => format!("ChatGPT answered HTTP {status}: {message}"),
        None => {
            let body: String = body.chars().take(300).collect();
            format!("ChatGPT answered HTTP {status}: {body}")
        }
    }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

static MODELS_CACHE: Mutex<Option<(Instant, Vec<Value>)>> = Mutex::new(None);

/// Forget the cached model list — a different account can see different models.
pub(crate) fn reset_models_cache() {
    *MODELS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// The backend's live model list as it sends it, cached five minutes.
pub(crate) async fn list_models() -> Result<Vec<Value>, WireError> {
    if let Some((at, models)) = MODELS_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        && at.elapsed() < MODELS_CACHE_TTL
    {
        return Ok(models.clone());
    }

    let path = format!("/models?client_version={CLIENT_VERSION}");
    let mut tokens = auth::current_tokens().await?;
    let mut response = None;
    for attempt in 0..2 {
        let resp = backend_request(reqwest::Method::GET, &path, &tokens, "application/json")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(network_error)?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            tokens = auth::force_refresh(&tokens).await?;
            continue;
        }
        response = Some(resp);
        break;
    }
    let resp = response.ok_or_else(|| WireError::new(403, "ChatGPT refused the sign-in"))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(network_error)?;
    if !(200..300).contains(&status) {
        return Err(WireError::new(status, error_message(status, &body)));
    }
    let parsed: Value = serde_json::from_str(&body)
        .map_err(|e| WireError::new(502, format!("ChatGPT sent an unreadable model list: {e}")))?;
    let models: Vec<Value> = parsed
        .get("models")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|m| m.get("slug").and_then(Value::as_str).is_some())
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if models.is_empty() {
        return Err(WireError::new(
            502,
            "ChatGPT listed no models for this account",
        ));
    }
    *MODELS_CACHE.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((Instant::now(), models.clone()));
    Ok(models)
}

/// Effort levels a backend model entry advertises. Entries are either bare
/// strings or `{ "effort": "low", "description": … }` presets.
fn advertised_efforts(model: &Value) -> Vec<String> {
    model
        .get("supported_reasoning_levels")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|level| {
                    level
                        .as_str()
                        .or_else(|| level.get("effort").and_then(Value::as_str))
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The backend list as an OpenAI `/models` document: only what Codex itself
/// lists (`visibility: list`), in the backend's order, with the reasoning
/// vocabulary in the shape `provider_registry::parse_discovered_models` reads.
pub(crate) fn models_document(models: &[Value]) -> Value {
    let data: Vec<Value> = models
        .iter()
        .filter(|m| {
            m.get("visibility")
                .and_then(Value::as_str)
                .is_none_or(|v| v == "list")
        })
        .filter_map(|m| {
            let slug = m.get("slug").and_then(Value::as_str)?;
            let mut entry = json!({
                "id": slug,
                "object": "model",
                "created": 0,
                "owned_by": "openai",
                "display_name": m.get("display_name").and_then(Value::as_str).unwrap_or(slug),
            });
            let efforts = advertised_efforts(m);
            if !efforts.is_empty() {
                let mut reasoning = json!({ "supported_efforts": efforts });
                if let Some(default) = m.get("default_reasoning_level").and_then(Value::as_str) {
                    reasoning["default_effort"] = json!(default);
                }
                entry["reasoning"] = reasoning;
            }
            Some(entry)
        })
        .collect();
    json!({ "object": "list", "data": data })
}

// ---------------------------------------------------------------------------
// Chat completions → Responses
// ---------------------------------------------------------------------------

fn new_call_id() -> String {
    format!("call_{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

fn str_field<'a>(value: Option<&'a Value>, key: &str) -> &'a str {
    value
        .and_then(|v| v.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Plain text of a chat `content`: a string, or the text parts of a part list.
fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(s) => Some(s.as_str()),
                Value::Object(_)
                    if matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("text" | "input_text" | "output_text")
                    ) =>
                {
                    part.get("text").and_then(Value::as_str)
                }
                _ => None,
            })
            .collect(),
        _ => String::new(),
    }
}

/// A user message's parts as Responses input parts (text, images, files).
fn user_parts(content: Option<&Value>) -> Vec<Value> {
    let mut out = Vec::new();
    match content {
        Some(Value::String(s)) => out.push(json!({ "type": "input_text", "text": s })),
        Some(Value::Array(parts)) => {
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("text" | "input_text") => out.push(json!({
                        "type": "input_text",
                        "text": part.get("text").and_then(Value::as_str).unwrap_or_default(),
                    })),
                    Some("image_url" | "input_image") => {
                        let image = part.get("image_url");
                        let url = image
                            .and_then(|i| {
                                i.get("url").and_then(Value::as_str).or_else(|| i.as_str())
                            })
                            .unwrap_or_default();
                        if !url.is_empty() {
                            let detail = image
                                .and_then(|i| i.get("detail"))
                                .or_else(|| part.get("detail"))
                                .and_then(Value::as_str)
                                .unwrap_or("auto");
                            out.push(json!({ "type": "input_image", "image_url": url, "detail": detail }));
                        }
                    }
                    Some("file") => {
                        let file = part.get("file");
                        let data = str_field(file, "file_data");
                        if !data.is_empty() {
                            out.push(json!({
                                "type": "input_file",
                                "filename": str_field(file, "filename"),
                                "file_data": data,
                            }));
                        }
                    }
                    _ => {
                        if let Some(s) = part.as_str() {
                            out.push(json!({ "type": "input_text", "text": s }));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    if out.is_empty() {
        out.push(json!({ "type": "input_text", "text": "" }));
    }
    out
}

fn arguments_string(arguments: Option<&Value>) -> String {
    match arguments {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => "{}".to_string(),
        Some(other) => other.to_string(),
    }
}

/// A stable cache key for one conversation: the same instructions and opening
/// message hash the same on every turn, so the backend's prompt cache hits.
fn prompt_cache_key(instructions: &str, input: &[Value]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(instructions.as_bytes());
    if let Some(first) = input.first() {
        hasher.update(first.to_string().as_bytes());
    }
    format!("fastaf-{}", &hex::encode(hasher.finalize())[..32])
}

/// A chat-completions request → the Responses turn the backend takes.
///
/// Built from a whitelist: sampling knobs (`temperature`, `top_p`…) and token
/// limits have no place on this backend and are refused if sent, so they are
/// dropped rather than forwarded.
pub(crate) fn chat_to_responses(body: &Value) -> Value {
    let mut instructions: Vec<String> = Vec::new();
    let mut input: Vec<Value> = Vec::new();

    for message in body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let content = message.get("content");
        match message.get("role").and_then(Value::as_str) {
            Some("system" | "developer") => {
                let text = text_of(content);
                if !text.trim().is_empty() {
                    instructions.push(text);
                }
            }
            Some("user") => input.push(json!({
                "type": "message",
                "role": "user",
                "content": user_parts(content),
            })),
            Some("assistant") => {
                let text = text_of(content);
                if !text.is_empty() {
                    input.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
                for call in message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let function = call.get("function");
                    let call_id = call
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(String::from)
                        .unwrap_or_else(new_call_id);
                    input.push(json!({
                        "type": "function_call",
                        "call_id": call_id,
                        "name": str_field(function, "name"),
                        "arguments": arguments_string(function.and_then(|f| f.get("arguments"))),
                    }));
                }
            }
            Some("tool") => input.push(json!({
                "type": "function_call_output",
                "call_id": message.get("tool_call_id").and_then(Value::as_str).unwrap_or_default(),
                "output": text_of(content),
            })),
            _ => {}
        }
    }

    let tools: Vec<Value> = body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| match tool.get("type").and_then(Value::as_str) {
            Some("function") => {
                let function = tool.get("function");
                Some(json!({
                    "type": "function",
                    "name": str_field(function, "name"),
                    "description": str_field(function, "description"),
                    "parameters": function
                        .and_then(|f| f.get("parameters"))
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                    "strict": false,
                }))
            }
            _ => None,
        })
        .collect();

    let tool_choice = match body.get("tool_choice") {
        Some(Value::String(s)) if matches!(s.as_str(), "auto" | "none" | "required") => {
            Some(json!(s))
        }
        Some(choice @ Value::Object(_))
            if choice.get("type").and_then(Value::as_str) == Some("function") =>
        {
            Some(json!({ "type": "function", "name": str_field(choice.get("function"), "name") }))
        }
        _ if !tools.is_empty() => Some(json!("auto")),
        _ => None,
    };

    let instructions = if instructions.is_empty() {
        DEFAULT_INSTRUCTIONS.to_string()
    } else {
        instructions.join("\n\n")
    };
    let cache_key = prompt_cache_key(&instructions, &input);

    let mut out = json!({
        "model": body.get("model").and_then(Value::as_str).unwrap_or_default(),
        "instructions": instructions,
        "input": input,
        "tools": tools,
        "parallel_tool_calls": true,
        "store": false,
        "stream": true,
        "prompt_cache_key": cache_key,
    });
    if let Some(choice) = tool_choice {
        out["tool_choice"] = choice;
    }
    if let Some(effort) = body
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
    {
        out["reasoning"] = json!({ "effort": effort });
    }
    let mut text = serde_json::Map::new();
    if let Some(verbosity) = body.get("verbosity").and_then(Value::as_str) {
        text.insert("verbosity".into(), json!(verbosity));
    }
    if let Some(format) = body.get("response_format") {
        match format.get("type").and_then(Value::as_str) {
            Some("json_schema") => {
                let spec = format.get("json_schema");
                text.insert(
                    "format".into(),
                    json!({
                        "type": "json_schema",
                        "name": spec.and_then(|s| s.get("name")).and_then(Value::as_str).unwrap_or("answer"),
                        "schema": spec.and_then(|s| s.get("schema")).cloned().unwrap_or_else(|| json!({})),
                        "strict": spec.and_then(|s| s.get("strict")).and_then(Value::as_bool).unwrap_or(false),
                    }),
                );
            }
            Some("json_object") => {
                text.insert("format".into(), json!({ "type": "json_object" }));
            }
            _ => {}
        }
    }
    if !text.is_empty() {
        out["text"] = Value::Object(text);
    }
    out
}

// ---------------------------------------------------------------------------
// Responses → chat completions
// ---------------------------------------------------------------------------

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// Responses usage → chat-completions usage.
pub(crate) fn usage_to_chat(usage: &Value) -> Value {
    let prompt = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completion = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let total = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(prompt + completion);
    let mut out = json!({
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
    });
    if let Some(cached) = usage
        .pointer("/input_tokens_details/cached_tokens")
        .and_then(Value::as_u64)
    {
        out["prompt_tokens_details"] = json!({ "cached_tokens": cached });
    }
    if let Some(reasoning) = usage
        .pointer("/output_tokens_details/reasoning_tokens")
        .and_then(Value::as_u64)
    {
        out["completion_tokens_details"] = json!({ "reasoning_tokens": reasoning });
    }
    out
}

fn function_call_of(item: &Value) -> Value {
    let call_id = item
        .get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(String::from)
        .unwrap_or_else(new_call_id);
    json!({
        "id": call_id,
        "type": "function",
        "function": {
            "name": item.get("name").and_then(Value::as_str).unwrap_or_default(),
            "arguments": arguments_string(item.get("arguments")),
        },
    })
}

/// A finished turn's output items → the assistant message and finish reason.
pub(crate) fn items_to_chat_message(items: &[Value], incomplete: bool) -> (Value, &'static str) {
    let mut text = String::new();
    let mut calls = Vec::new();
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => text.push_str(&text_of(item.get("content"))),
            Some("function_call") => calls.push(function_call_of(item)),
            _ => {}
        }
    }
    let mut message = json!({
        "role": "assistant",
        "content": if text.is_empty() && !calls.is_empty() { Value::Null } else { json!(text) },
    });
    let finish = if !calls.is_empty() {
        message["tool_calls"] = json!(calls);
        "tool_calls"
    } else if incomplete {
        "length"
    } else {
        "stop"
    };
    (message, finish)
}

/// The error a `response.failed` / `error` event carries.
fn event_error(event: &Value) -> WireError {
    let err = event
        .pointer("/response/error")
        .or_else(|| event.get("error"))
        .unwrap_or(event);
    let message = err
        .get("message")
        .or_else(|| err.get("code"))
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| err.to_string().chars().take(300).collect());
    WireError::new(502, format!("ChatGPT failed the turn: {message}"))
}

/// Turns backend events into chat-completion SSE chunks, one event at a time.
pub(crate) struct ChunkWriter {
    id: String,
    model: String,
    created: u64,
    tool_calls: usize,
    usage: Option<Value>,
    incomplete: bool,
}

impl ChunkWriter {
    pub(crate) fn new(model: &str) -> Self {
        Self {
            id: format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
            model: model.to_string(),
            created: unix_now(),
            tool_calls: 0,
            usage: None,
            incomplete: false,
        }
    }

    fn chunk(&self, delta: Value, finish: Option<&str>, usage: Option<Value>) -> String {
        let mut payload = json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
        });
        if let Some(usage) = usage {
            payload["usage"] = usage;
        }
        format!("data: {payload}\n\n")
    }

    pub(crate) fn start(&self) -> String {
        self.chunk(json!({ "role": "assistant", "content": "" }), None, None)
    }

    /// Chunks for one backend event; an `Err` ends the stream.
    pub(crate) fn on_event(&mut self, event: &Value) -> Result<Vec<String>, WireError> {
        let delta = || {
            event
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default()
        };
        match event.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") if !delta().is_empty() => {
                Ok(vec![self.chunk(json!({ "content": delta() }), None, None)])
            }
            Some("response.reasoning_summary_text.delta" | "response.reasoning_text.delta")
                if !delta().is_empty() =>
            {
                Ok(vec![self.chunk(
                    json!({ "reasoning_content": delta() }),
                    None,
                    None,
                )])
            }
            Some("response.output_item.done")
                if event.pointer("/item/type").and_then(Value::as_str) == Some("function_call") =>
            {
                let mut call = function_call_of(&event["item"]);
                call["index"] = json!(self.tool_calls);
                self.tool_calls += 1;
                Ok(vec![self.chunk(
                    json!({ "tool_calls": [call] }),
                    None,
                    None,
                )])
            }
            Some("response.completed") => {
                self.usage = event.pointer("/response/usage").cloned();
                Ok(Vec::new())
            }
            Some("response.incomplete") => {
                self.incomplete = true;
                self.usage = event.pointer("/response/usage").cloned();
                Ok(Vec::new())
            }
            Some("response.failed" | "error") => Err(event_error(event)),
            _ => Ok(Vec::new()),
        }
    }

    pub(crate) fn finish(&self) -> Vec<String> {
        let reason = if self.tool_calls > 0 {
            "tool_calls"
        } else if self.incomplete {
            "length"
        } else {
            "stop"
        };
        let usage = self.usage.as_ref().map(usage_to_chat);
        vec![
            self.chunk(json!({}), Some(reason), usage),
            "data: [DONE]\n\n".to_string(),
        ]
    }

    /// The SSE chunk that reports a mid-stream failure to the client.
    pub(crate) fn error_chunk(err: &WireError) -> String {
        format!(
            "data: {}\n\n",
            json!({ "error": { "message": err.message, "type": "server_error", "code": "chatgpt" } })
        )
    }
}

/// A whole non-streamed chat completion from a finished turn.
pub(crate) fn chat_completion(
    model: &str,
    items: &[Value],
    usage: &Value,
    incomplete: bool,
) -> Value {
    let (message, finish) = items_to_chat_message(items, incomplete);
    json!({
        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
        "object": "chat.completion",
        "created": unix_now(),
        "model": model,
        "choices": [{ "index": 0, "message": message, "finish_reason": finish }],
        "usage": usage_to_chat(usage),
    })
}

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

/// Splits a byte stream into SSE event payloads (the joined `data:` lines).
///
/// No line-length cap: a single event can be very large (a finished output
/// item repeats the whole message), which line readers with a limit refuse.
#[derive(Default)]
pub(crate) struct SseDecoder {
    buf: Vec<u8>,
    data: Vec<String>,
}

impl SseDecoder {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            self.line(line.trim_end_matches(['\n', '\r']), &mut events);
        }
        events
    }

    pub(crate) fn finish(&mut self) -> Vec<String> {
        let mut events = Vec::new();
        if !self.buf.is_empty() {
            let rest = std::mem::take(&mut self.buf);
            let rest = String::from_utf8_lossy(&rest);
            self.line(rest.trim_end_matches(['\n', '\r']), &mut events);
        }
        self.line("", &mut events);
        events
    }

    fn line(&mut self, line: &str, events: &mut Vec<String>) {
        if line.is_empty() {
            if !self.data.is_empty() {
                events.push(self.data.join("\n"));
                self.data.clear();
            }
        } else if let Some(data) = line.strip_prefix("data:") {
            self.data
                .push(data.strip_prefix(' ').unwrap_or(data).to_string());
        }
    }
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/// POST one turn. A 401 refreshes the sign-in once and retries; any other
/// non-2xx is an error before a single byte streams, so the door can answer
/// with a real status instead of a broken stream.
pub(crate) async fn open_turn(body: &Value) -> Result<reqwest::Response, WireError> {
    let mut tokens = auth::current_tokens().await?;
    for attempt in 0..2 {
        let resp = backend_request(
            reqwest::Method::POST,
            "/responses",
            &tokens,
            "text/event-stream",
        )
        .json(body)
        .send()
        .await
        .map_err(network_error)?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            tokens = auth::force_refresh(&tokens).await?;
            continue;
        }
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(WireError::new(
                status.as_u16(),
                error_message(status.as_u16(), &text),
            ));
        }
        return Ok(resp);
    }
    Err(WireError::new(403, "ChatGPT refused the sign-in"))
}

/// The events of an opened turn, parsed.
pub(crate) fn turn_events(resp: reqwest::Response) -> impl Stream<Item = Result<Value, WireError>> {
    async_stream::stream! {
        let mut decoder = SseDecoder::default();
        let mut bytes = resp.bytes_stream();
        while let Some(chunk) = bytes.next().await {
            match chunk {
                Ok(chunk) => {
                    for payload in decoder.push(&chunk) {
                        if let Some(event) = parse_event(&payload) {
                            yield Ok(event);
                        }
                    }
                }
                Err(e) => {
                    yield Err(WireError::new(502, format!("ChatGPT stream broke: {e}")));
                    return;
                }
            }
        }
        for payload in decoder.finish() {
            if let Some(event) = parse_event(&payload) {
                yield Ok(event);
            }
        }
    }
}

fn parse_event(payload: &str) -> Option<Value> {
    if payload.trim().is_empty() || payload.trim() == "[DONE]" {
        return None;
    }
    serde_json::from_str::<Value>(payload)
        .ok()
        .filter(Value::is_object)
}

/// A whole turn: its output items (from `response.output_item.done` — this
/// backend's `response.completed` carries usage but an empty output), usage,
/// and whether it stopped short.
pub(crate) async fn run_turn(body: &Value) -> Result<(Vec<Value>, Value, bool), WireError> {
    let resp = open_turn(body).await?;
    let events = turn_events(resp);
    futures_util::pin_mut!(events);
    let mut items = Vec::new();
    let mut usage = json!({});
    let mut incomplete = false;
    while let Some(event) = events.next().await {
        let event = event?;
        match event.get("type").and_then(Value::as_str) {
            Some("response.output_item.done") => {
                if let Some(item) = event.get("item").filter(|i| i.is_object()) {
                    items.push(item.clone());
                }
            }
            Some("response.completed") => {
                usage = event.pointer("/response/usage").cloned().unwrap_or(usage);
            }
            Some("response.incomplete") => {
                incomplete = true;
                usage = event.pointer("/response/usage").cloned().unwrap_or(usage);
            }
            Some("response.failed" | "error") => return Err(event_error(&event)),
            _ => {}
        }
    }
    Ok((items, usage, incomplete))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_messages_become_instructions_and_the_rest_input() {
        let body = json!({
            "model": "gpt-5.6-terra",
            "messages": [
                { "role": "system", "content": "Be brief." },
                { "role": "developer", "content": [{ "type": "text", "text": "No emoji." }] },
                { "role": "user", "content": "hi" },
            ],
        });
        let out = chat_to_responses(&body);
        assert_eq!(out["model"], "gpt-5.6-terra");
        assert_eq!(out["instructions"], "Be brief.\n\nNo emoji.");
        assert_eq!(out["store"], false);
        assert_eq!(out["stream"], true);
        assert_eq!(
            out["input"],
            json!([{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }])
        );
        assert!(out.get("tool_choice").is_none(), "no tools, no tool_choice");
    }

    #[test]
    fn missing_system_prompt_gets_default_instructions() {
        let out = chat_to_responses(
            &json!({ "model": "m", "messages": [{ "role": "user", "content": "x" }] }),
        );
        assert_eq!(out["instructions"], DEFAULT_INSTRUCTIONS);
    }

    #[test]
    fn tool_round_trip_maps_calls_and_outputs() {
        let body = json!({
            "model": "m",
            "messages": [
                { "role": "user", "content": "weather?" },
                { "role": "assistant", "content": "", "tool_calls": [
                    { "id": "call_1", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"Oslo\"}" } }
                ]},
                { "role": "tool", "tool_call_id": "call_1", "content": "rain" },
            ],
            "tools": [{ "type": "function", "function": {
                "name": "get_weather", "description": "Weather", "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
            }}],
            "tool_choice": { "type": "function", "function": { "name": "get_weather" } },
        });
        let out = chat_to_responses(&body);
        let input = out["input"].as_array().unwrap();
        assert_eq!(input.len(), 3, "empty assistant text is not an input item");
        assert_eq!(
            input[1],
            json!({ "type": "function_call", "call_id": "call_1", "name": "get_weather", "arguments": "{\"city\":\"Oslo\"}" })
        );
        assert_eq!(
            input[2],
            json!({ "type": "function_call_output", "call_id": "call_1", "output": "rain" })
        );
        assert_eq!(out["tools"][0]["name"], "get_weather");
        assert_eq!(
            out["tools"][0]["parameters"]["properties"]["city"]["type"],
            "string"
        );
        assert_eq!(
            out["tool_choice"],
            json!({ "type": "function", "name": "get_weather" })
        );
    }

    #[test]
    fn tools_without_a_choice_default_to_auto() {
        let out = chat_to_responses(&json!({
            "model": "m",
            "messages": [{ "role": "user", "content": "x" }],
            "tools": [{ "type": "function", "function": { "name": "t" } }],
        }));
        assert_eq!(out["tool_choice"], "auto");
        assert_eq!(
            out["tools"][0]["parameters"],
            json!({ "type": "object", "properties": {} })
        );
    }

    #[test]
    fn sampling_knobs_and_token_limits_are_dropped() {
        let out = chat_to_responses(&json!({
            "model": "m",
            "messages": [{ "role": "user", "content": "x" }],
            "temperature": 0.7,
            "top_p": 0.9,
            "max_tokens": 100,
            "max_completion_tokens": 100,
            "stream_options": { "include_usage": true },
            "reasoning_effort": "high",
            "verbosity": "low",
        }));
        for dropped in [
            "temperature",
            "top_p",
            "max_tokens",
            "max_completion_tokens",
            "max_output_tokens",
            "stream_options",
            "reasoning_effort",
            "verbosity",
        ] {
            assert!(
                out.get(dropped).is_none(),
                "{dropped} must not reach the backend"
            );
        }
        assert_eq!(out["reasoning"], json!({ "effort": "high" }));
        assert_eq!(out["text"], json!({ "verbosity": "low" }));
    }

    #[test]
    fn json_schema_response_format_maps_to_text_format() {
        let out = chat_to_responses(&json!({
            "model": "m",
            "messages": [{ "role": "user", "content": "x" }],
            "response_format": { "type": "json_schema", "json_schema": { "name": "out", "schema": { "type": "object" }, "strict": true } },
        }));
        assert_eq!(
            out["text"]["format"],
            json!({ "type": "json_schema", "name": "out", "schema": { "type": "object" }, "strict": true })
        );
    }

    #[test]
    fn user_images_and_files_become_input_parts() {
        let out = chat_to_responses(&json!({
            "model": "m",
            "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "look" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
                { "type": "file", "file": { "filename": "a.pdf", "file_data": "data:application/pdf;base64,BBB" } },
            ]}],
        }));
        assert_eq!(
            out["input"][0]["content"],
            json!([
                { "type": "input_text", "text": "look" },
                { "type": "input_image", "image_url": "data:image/png;base64,AAA", "detail": "auto" },
                { "type": "input_file", "filename": "a.pdf", "file_data": "data:application/pdf;base64,BBB" },
            ])
        );
    }

    #[test]
    fn prompt_cache_key_is_stable_across_turns_of_one_conversation() {
        let first = chat_to_responses(&json!({ "model": "m", "messages": [
            { "role": "system", "content": "s" }, { "role": "user", "content": "hello" }
        ]}));
        let later = chat_to_responses(&json!({ "model": "m", "messages": [
            { "role": "system", "content": "s" }, { "role": "user", "content": "hello" },
            { "role": "assistant", "content": "hi" }, { "role": "user", "content": "more" }
        ]}));
        let other = chat_to_responses(&json!({ "model": "m", "messages": [
            { "role": "system", "content": "s" }, { "role": "user", "content": "different" }
        ]}));
        assert_eq!(first["prompt_cache_key"], later["prompt_cache_key"]);
        assert_ne!(first["prompt_cache_key"], other["prompt_cache_key"]);
    }

    #[test]
    fn items_become_an_assistant_message() {
        let items = vec![
            json!({ "type": "reasoning", "summary": [] }),
            json!({ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Hello" }] }),
        ];
        let (message, finish) = items_to_chat_message(&items, false);
        assert_eq!(message, json!({ "role": "assistant", "content": "Hello" }));
        assert_eq!(finish, "stop");

        let (_, finish) = items_to_chat_message(&items, true);
        assert_eq!(finish, "length");
    }

    #[test]
    fn function_call_items_become_tool_calls() {
        let items = vec![
            json!({ "type": "function_call", "call_id": "call_9", "name": "f", "arguments": "{}" }),
        ];
        let (message, finish) = items_to_chat_message(&items, false);
        assert_eq!(finish, "tool_calls");
        assert_eq!(message["content"], Value::Null);
        assert_eq!(
            message["tool_calls"],
            json!([{ "id": "call_9", "type": "function", "function": { "name": "f", "arguments": "{}" } }])
        );
    }

    #[test]
    fn usage_maps_with_details() {
        let usage = usage_to_chat(&json!({
            "input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
            "input_tokens_details": { "cached_tokens": 4 },
            "output_tokens_details": { "reasoning_tokens": 2 },
        }));
        assert_eq!(
            usage,
            json!({
                "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
                "prompt_tokens_details": { "cached_tokens": 4 },
                "completion_tokens_details": { "reasoning_tokens": 2 },
            })
        );
    }

    fn chunk_json(chunk: &str) -> Value {
        serde_json::from_str(chunk.strip_prefix("data: ").unwrap().trim()).unwrap()
    }

    #[test]
    fn chunk_writer_streams_text_tool_calls_and_usage() {
        let mut writer = ChunkWriter::new("m");
        assert_eq!(
            chunk_json(&writer.start())["choices"][0]["delta"]["role"],
            "assistant"
        );

        let text = writer
            .on_event(&json!({ "type": "response.output_text.delta", "delta": "Hi" }))
            .unwrap();
        assert_eq!(chunk_json(&text[0])["choices"][0]["delta"]["content"], "Hi");

        let thinking = writer
            .on_event(&json!({ "type": "response.reasoning_summary_text.delta", "delta": "hmm" }))
            .unwrap();
        assert_eq!(
            chunk_json(&thinking[0])["choices"][0]["delta"]["reasoning_content"],
            "hmm"
        );

        let call = writer
            .on_event(&json!({ "type": "response.output_item.done", "item": {
                "type": "function_call", "call_id": "c1", "name": "f", "arguments": "{\"a\":1}"
            }}))
            .unwrap();
        let call = chunk_json(&call[0]);
        assert_eq!(call["choices"][0]["delta"]["tool_calls"][0]["index"], 0);
        assert_eq!(call["choices"][0]["delta"]["tool_calls"][0]["id"], "c1");
        assert_eq!(
            call["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
            "{\"a\":1}"
        );

        // A finished message item repeats text already streamed — no chunk.
        assert!(
            writer
                .on_event(&json!({ "type": "response.output_item.done", "item": { "type": "message", "content": [] } }))
                .unwrap()
                .is_empty()
        );
        assert!(
            writer
                .on_event(&json!({ "type": "response.completed", "response": { "usage": { "input_tokens": 3, "output_tokens": 2 } } }))
                .unwrap()
                .is_empty()
        );

        let tail = writer.finish();
        let last = chunk_json(&tail[0]);
        assert_eq!(last["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(last["usage"]["total_tokens"], 5);
        assert_eq!(tail[1], "data: [DONE]\n\n");
    }

    #[test]
    fn chunk_writer_fails_on_a_failed_response() {
        let mut writer = ChunkWriter::new("m");
        let err = writer
            .on_event(&json!({ "type": "response.failed", "response": { "error": { "message": "usage limit reached" } } }))
            .unwrap_err();
        assert!(
            err.message.contains("usage limit reached"),
            "{}",
            err.message
        );
    }

    #[test]
    fn sse_decoder_handles_split_chunks_crlf_and_huge_lines() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(b"event: x\r\ndata: {\"a\":").is_empty());
        assert_eq!(
            decoder.push(b"1}\r\n\r\ndata: [DONE]\n\n"),
            vec!["{\"a\":1}", "[DONE]"]
        );

        let big = "x".repeat(3 * 1024 * 1024);
        let events = decoder.push(format!("data: {big}\n\n").as_bytes());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].len(), big.len());

        assert!(decoder.push(b"data: tail").is_empty());
        assert_eq!(decoder.finish(), vec!["tail"]);
    }

    #[test]
    fn models_document_lists_only_listed_models_with_reasoning() {
        let models = vec![
            json!({
                "slug": "gpt-6-astra", "display_name": "GPT-6 Astra", "visibility": "list", "priority": 1,
                "supported_reasoning_levels": [{ "effort": "low", "description": "" }, { "effort": "high", "description": "" }],
                "default_reasoning_level": "high",
            }),
            json!({ "slug": "codex-auto-review", "visibility": "hide" }),
            json!({ "slug": "gpt-5.5" }),
        ];
        let doc = models_document(&models);
        let data = doc["data"].as_array().unwrap();
        assert_eq!(data.len(), 2);
        assert_eq!(data[0]["id"], "gpt-6-astra");
        assert_eq!(
            data[0]["reasoning"],
            json!({ "supported_efforts": ["low", "high"], "default_effort": "high" })
        );
        assert!(data[1].get("reasoning").is_none());

        let parsed = crate::provider_registry::parse_discovered_models(&doc);
        assert_eq!(
            parsed[0].effort_options.as_deref(),
            Some(&["low".to_string(), "high".to_string()][..])
        );
        assert_eq!(parsed[0].default_effort.as_deref(), Some("high"));
    }

    #[test]
    fn error_message_prefers_the_json_message() {
        assert_eq!(
            error_message(
                429,
                r#"{"error":{"message":"You've hit your usage limit"}}"#
            ),
            "ChatGPT answered HTTP 429: You've hit your usage limit"
        );
        assert_eq!(
            error_message(400, r#"{"detail":"Unsupported parameter: temperature"}"#),
            "ChatGPT answered HTTP 400: Unsupported parameter: temperature"
        );
        assert_eq!(
            error_message(502, "bad gateway"),
            "ChatGPT answered HTTP 502: bad gateway"
        );
    }
}
