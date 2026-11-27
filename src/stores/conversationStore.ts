/**
 * Unified conversation store — merges aiChatStore and aiAgentStore.
 *
 * Per-terminal architecture: each terminal gets its own PerTerminalConversationState
 * keyed by tuicSession/id. Proxy accessors (messages, isStreaming, etc.) route through
 * activeConversation() so all callers remain unchanged.
 *
 * Both chat (assisted) and agent (autonomous) modes now drive the same Tauri command
 * `start_conversation`. Events arrive via Channel<ConversationEvent> and are applied
 * to the matching terminal's state.
 */

import type { Accessor, Setter } from "solid-js";
import { batch, createSignal } from "solid-js";
import { invoke } from "../invoke";
import { isTauri } from "../transport";
import { openConversationStream } from "../utils/aiStream";
import { appLogger } from "./appLogger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Where a user turn stands with the backend. Absent once the turn was taken.
 * - "sending": submitted, not confirmed yet.
 * - "not_sent": the backend refused the submission; nothing ran.
 * - "no_reply": the turn started and failed before it produced an answer.
 * The last two keep the payload on screen for a retry. None of them is saved.
 */
export type MessageDelivery = "sending" | "not_sent" | "no_reply";

export interface ConversationMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
	/** Identity inside this window, so the panel can address one message. Never saved. */
	localId?: number;
	delivery?: MessageDelivery;
	/** Why a failed turn got no answer. */
	failure?: string;
	/** What the turn was sent with, so a retry sends the same payload. */
	turn?: TurnOptions;
}

/** True for a turn that failed and still holds its payload for a retry. */
export function isFailedDelivery(message: ConversationMessage): boolean {
	return message.delivery === "not_sent" || message.delivery === "no_reply";
}

/** What a chat is doing, for the dot that says so. */
export type ChatActivity = "working" | "waiting" | "idle";

/** Outcome of `forkConversation`. "saved": the branch went to History because a turn is still running here. */
export type ForkOutcome = "forked" | "saved" | "nothing" | "failed";

/** Outcome of `newConversation`. */
export type NewConversationOutcome = "started" | "busy" | "empty";

/** Re-exported as AiChatMessage for backward compat */
export type AiChatMessage = ConversationMessage;

interface ChatUsage {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	cachedTokens?: number;
	cacheCreationTokens?: number;
	costUsd?: number;
}

export type AgentState = "running" | "paused" | "completed" | "cancelled" | "error" | "idle";

export type ToolCallEntry =
	| { status: "pending"; toolName: string; args: Record<string, unknown>; startedAt: number }
	| {
			status: "done";
			toolName: string;
			args: Record<string, unknown>;
			startedAt: number;
			result: { success: boolean; output: string };
			duration: number;
	  };

/** An agent task as it was submitted. */
export interface AgentGoal {
	goal: string;
	unrestricted: boolean;
	turn?: TurnOptions;
}

export interface PendingApproval {
	sessionId: string;
	command: string;
	reason: string;
	/** One-time id from the `needs_approval` event; the backend refuses an answer without it. */
	approvalId?: string;
}

// Backend conversation types (mirror ai_agent::conversation)
interface BackendChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
}
interface BackendConversationMeta {
	id: string;
	title: string;
	session_id?: string | null;
	created: number;
	updated: number;
	message_count: number;
	provider?: string;
	model?: string;
}
interface BackendConversation {
	meta: BackendConversationMeta;
	messages: BackendChatMessage[];
	schema_version?: number;
}

export type ConversationMeta = BackendConversationMeta;

// ConversationEvent variants from Rust (tag = "type", rename_all = "snake_case")
type ConversationEvent =
	| { type: "thinking"; iteration: number }
	| { type: "text_chunk"; text: string }
	| { type: "reasoning_chunk"; text: string }
	| { type: "tool_call"; tool_name: string; args: Record<string, unknown> }
	| { type: "tool_result"; tool_name: string; success: boolean; output: string }
	| { type: "needs_approval"; tool_name: string; command: string; reason: string; approval_id: string }
	| { type: "bypassed"; tool_name: string }
	| { type: "paused" }
	| { type: "resumed" }
	| { type: "rate_limited"; wait_ms: number }
	| { type: "retrying"; attempt: number; wait_ms: number; reason: string }
	| { type: "compacted"; elided: number; before_tokens: number }
	| { type: "error"; message: string }
	| { type: "completed"; reason: string; usage: { input_tokens: number; output_tokens: number } | null };

// Legacy AgentEvent for backward compat with old agent-loop-event listener (removed in 1617)
type LegacyAgentEvent =
	| { type: "started"; session_id: string }
	| { type: "thinking"; session_id: string; iteration: number }
	| { type: "text_chunk"; session_id: string; text: string }
	| { type: "reasoning_chunk"; session_id: string; text: string }
	| { type: "tool_call"; session_id: string; tool_name: string; args: Record<string, unknown> }
	| { type: "tool_result"; session_id: string; tool_name: string; success: boolean; output: string }
	| {
			type: "needs_approval";
			session_id: string;
			tool_name: string;
			command: string;
			reason: string;
			approval_id?: string;
	  }
	| { type: "paused"; session_id: string }
	| { type: "resumed"; session_id: string }
	| { type: "rate_limited"; session_id: string; wait_ms: number }
	| { type: "error"; session_id: string; message: string }
	| { type: "completed"; session_id: string; iterations: number; reason: string };

/** Conversation mode: "assisted" = chat streaming, "autonomous" = agent with tool cards */
type ConversationMode = "assisted" | "autonomous";

export interface PerTerminalConversationState {
	// Chat state (formerly aiChatStore)
	messages: Accessor<ConversationMessage[]>;
	setMessages: Setter<ConversationMessage[]>;
	isStreaming: Accessor<boolean>;
	setIsStreaming: Setter<boolean>;
	streamingText: Accessor<string>;
	setStreamingText: Setter<string>;
	error: Accessor<string | null>;
	setError: Setter<string | null>;
	chatId: Accessor<string>;
	setChatId: Setter<string>;
	sessionUsage: Accessor<ChatUsage | null>;
	setSessionUsage: Setter<ChatUsage | null>;
	// Agent state (formerly aiAgentStore)
	agentState: Accessor<AgentState>;
	setAgentState: Setter<AgentState>;
	currentIteration: Accessor<number>;
	setCurrentIteration: Setter<number>;
	toolCalls: Accessor<ToolCallEntry[]>;
	setToolCalls: Setter<ToolCallEntry[]>;
	textChunks: Accessor<string>;
	setTextChunks: Setter<string>;
	reasoningChunks: Accessor<string>;
	setReasoningChunks: Setter<string>;
	pendingApproval: Accessor<PendingApproval | null>;
	setPendingApproval: Setter<PendingApproval | null>;
	agentError: Accessor<string | null>;
	setAgentError: Setter<string | null>;
	completionReason: Accessor<string | null>;
	setCompletionReason: Setter<string | null>;
	unrestricted: Accessor<boolean>;
	setUnrestricted: Setter<boolean>;
	isThinking: Accessor<boolean>;
	setIsThinking: Setter<boolean>;
	/** Messages up to this `localId` are hidden from the view (Cmd/Ctrl+K). They stay saved. */
	clearedThrough: Accessor<number>;
	setClearedThrough: Setter<number>;
	/** The task of the last agent run, kept so a failed run can be started again. */
	agentGoal: Accessor<AgentGoal | null>;
	setAgentGoal: Setter<AgentGoal | null>;
	// Bookkeeping
	currentMode: ConversationMode | null;
	activeSessionId: string | null;
	/** `localId` of the user message the running assisted turn answers. */
	turnMessageId: number | null;
	/** Saved title to keep (a loaded conversation, a fork); null derives it from the first user turn. */
	title: string | null;
	persistTimer: ReturnType<typeof setTimeout> | null;
	initialized: boolean;
	// Browser/PWA only: disposer for the active conversation token-stream WS.
	// Desktop uses a Tauri Channel (auto-cleaned), so this stays null there.
	conversationStreamDispose: (() => void) | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 100;
const MAX_TOOL_CALLS = 500;
const PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_KEY = "__default__";

// ---------------------------------------------------------------------------
// Per-terminal state map
// ---------------------------------------------------------------------------

const stateMap = new Map<string, PerTerminalConversationState>();
const [activeKey, setActiveKey] = createSignal<string>(DEFAULT_KEY);

/** Source of `ConversationMessage.localId`: increasing, so "everything up to here" is one number. */
let nextLocalId = 1;

/** Title prefix of a conversation branched from another one. */
const FORK_PREFIX = "Fork: ";

function generateChatId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function createState(): PerTerminalConversationState {
	const [messages, setMessages] = createSignal<ConversationMessage[]>([]);
	const [isStreaming, setIsStreaming] = createSignal(false);
	const [streamingText, setStreamingText] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [chatId, setChatId] = createSignal(generateChatId());
	const [sessionUsage, setSessionUsage] = createSignal<ChatUsage | null>(null);
	const [agentState, setAgentState] = createSignal<AgentState>("idle");
	const [currentIteration, setCurrentIteration] = createSignal(0);
	const [toolCalls, setToolCalls] = createSignal<ToolCallEntry[]>([]);
	const [textChunks, setTextChunks] = createSignal("");
	const [reasoningChunks, setReasoningChunks] = createSignal("");
	const [pendingApproval, setPendingApproval] = createSignal<PendingApproval | null>(null);
	const [agentError, setAgentError] = createSignal<string | null>(null);
	const [completionReason, setCompletionReason] = createSignal<string | null>(null);
	const [unrestricted, setUnrestricted] = createSignal(false);
	const [isThinking, setIsThinking] = createSignal(false);
	const [clearedThrough, setClearedThrough] = createSignal(0);
	const [agentGoal, setAgentGoal] = createSignal<AgentGoal | null>(null);
	return {
		messages,
		setMessages,
		isStreaming,
		setIsStreaming,
		streamingText,
		setStreamingText,
		error,
		setError,
		chatId,
		setChatId,
		sessionUsage,
		setSessionUsage,
		agentState,
		setAgentState,
		currentIteration,
		setCurrentIteration,
		toolCalls,
		setToolCalls,
		textChunks,
		setTextChunks,
		reasoningChunks,
		setReasoningChunks,
		pendingApproval,
		setPendingApproval,
		agentError,
		setAgentError,
		completionReason,
		setCompletionReason,
		unrestricted,
		setUnrestricted,
		isThinking,
		setIsThinking,
		clearedThrough,
		setClearedThrough,
		agentGoal,
		setAgentGoal,
		currentMode: null,
		activeSessionId: null,
		turnMessageId: null,
		title: null,
		persistTimer: null,
		initialized: false,
		conversationStreamDispose: null,
	};
}

/** Close the active browser conversation token-stream WS, if any. No-op on
 * desktop (Channel transport) and when no stream is open. */
function closeConversationStream(s: PerTerminalConversationState): void {
	if (s.conversationStreamDispose) {
		s.conversationStreamDispose();
		s.conversationStreamDispose = null;
	}
}

function getOrCreate(key: string): PerTerminalConversationState {
	let s = stateMap.get(key);
	if (!s) {
		s = createState();
		stateMap.set(key, s);
	}
	return s;
}

function activeConversation(): PerTerminalConversationState {
	return getOrCreate(activeKey());
}

function setActiveTerminal(key: string): void {
	setActiveKey(key);
}

// ---------------------------------------------------------------------------
// Convenience accessors — proxy through activeConversation()
// ---------------------------------------------------------------------------

function messages(): ConversationMessage[] {
	return activeConversation().messages();
}
function isStreaming(): boolean {
	return activeConversation().isStreaming();
}
function streamingText(): string {
	return activeConversation().streamingText();
}
function error(): string | null {
	return activeConversation().error();
}
function chatId(): string {
	return activeConversation().chatId();
}
function sessionUsage(): ChatUsage | null {
	return activeConversation().sessionUsage();
}
function agentState(): AgentState {
	return activeConversation().agentState();
}
function currentIteration(): number {
	return activeConversation().currentIteration();
}
function toolCalls(): ToolCallEntry[] {
	return activeConversation().toolCalls();
}
function textChunks(): string {
	return activeConversation().textChunks();
}
function reasoningChunks(): string {
	return activeConversation().reasoningChunks();
}
function pendingApproval(): PendingApproval | null {
	return activeConversation().pendingApproval();
}
function agentError(): string | null {
	return activeConversation().agentError();
}
function completionReason(): string | null {
	return activeConversation().completionReason();
}
function unrestricted(): boolean {
	return activeConversation().unrestricted();
}
function setUnrestricted(value: boolean): void {
	activeConversation().setUnrestricted(value);
}
function isThinking(): boolean {
	return activeConversation().isThinking();
}
function agentGoal(): AgentGoal | null {
	return activeConversation().agentGoal();
}

/** The messages on screen: everything after the last "clear view". */
function visibleMessages(): ConversationMessage[] {
	const s = activeConversation();
	const cleared = s.clearedThrough();
	const all = s.messages();
	return cleared > 0 ? all.filter((message) => (message.localId ?? 0) > cleared) : all;
}

function isBusy(s: PerTerminalConversationState): boolean {
	return s.isStreaming() || s.agentState() === "running" || s.agentState() === "paused";
}

function activityOf(s: PerTerminalConversationState): ChatActivity {
	// An open approval or a paused run is waiting on the user, whatever else is in flight.
	if (s.pendingApproval() || s.agentState() === "paused") return "waiting";
	if (s.isStreaming() || s.agentState() === "running") return "working";
	return "idle";
}

/** What the active terminal's chat is doing. */
function chatActivity(): ChatActivity {
	return activityOf(activeConversation());
}

/** What the chat holding conversation `id` is doing, in whichever terminal has it open. */
function chatActivityOf(id: string): ChatActivity {
	for (const s of stateMap.values()) {
		if (s.chatId() === id) return activityOf(s);
	}
	return "idle";
}

// ---------------------------------------------------------------------------
// Message management
// ---------------------------------------------------------------------------

/** Append one message to a conversation and return its `localId`. */
function appendMessage(
	s: PerTerminalConversationState,
	message: Omit<ConversationMessage, "timestamp" | "localId">,
): number {
	const localId = nextLocalId++;
	s.setMessages((prev) => {
		const next = [...prev, { ...message, timestamp: Date.now(), localId }];
		return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
	});
	return localId;
}

/** Replace the fields of one message, leaving every other message object untouched. */
function patchMessage(s: PerTerminalConversationState, localId: number, patch: Partial<ConversationMessage>): void {
	s.setMessages((prev) => prev.map((message) => (message.localId === localId ? { ...message, ...patch } : message)));
}

/** Messages read from disk get identities of their own in this window. */
function adoptMessages(messages: BackendChatMessage[]): ConversationMessage[] {
	return messages
		.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
		.map((m) => ({
			role: m.role as ConversationMessage["role"],
			content: m.content ?? "",
			timestamp: m.timestamp,
			localId: nextLocalId++,
		}))
		.slice(-MAX_MESSAGES);
}

function addMessage(role: ConversationMessage["role"], content: string): void {
	const key = activeKey();
	appendMessage(getOrCreate(key), { role, content });
	schedulePersist(key);
}

function addUserMessage(content: string): void {
	addMessage("user", content);
}
function addAssistantMessage(content: string): void {
	addMessage("assistant", content);
}
function addSystemMessage(content: string): void {
	addMessage("system", content);
}

function accumulateUsage(usage: ChatUsage): void {
	const s = activeConversation();
	s.setSessionUsage((prev) => ({
		promptTokens: (prev?.promptTokens ?? 0) + (usage.promptTokens ?? 0),
		completionTokens: (prev?.completionTokens ?? 0) + (usage.completionTokens ?? 0),
		totalTokens: (prev?.totalTokens ?? 0) + (usage.totalTokens ?? 0),
		cachedTokens: (prev?.cachedTokens ?? 0) + (usage.cachedTokens ?? 0),
		cacheCreationTokens: (prev?.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
		costUsd: usage.costUsd != null ? (prev?.costUsd ?? 0) + usage.costUsd : prev?.costUsd,
	}));
}

function clearHistory(): void {
	const s = activeConversation();
	if (s.persistTimer) {
		clearTimeout(s.persistTimer);
		s.persistTimer = null;
	}
	batch(() => {
		s.setMessages([]);
		s.setStreamingText("");
		s.setIsStreaming(false);
		s.setError(null);
		s.setSessionUsage(null);
		s.setClearedThrough(0);
	});
	s.title = null;
	const oldId = s.chatId();
	void (async () => {
		try {
			await invoke("delete_conversation", { id: oldId });
			const newId = await invoke<string>("new_conversation_id");
			s.setChatId(newId);
		} catch (e) {
			appLogger.warn("conversation", "clearHistory: backend wipe failed", { error: String(e) });
		}
	})();
}

// ---------------------------------------------------------------------------
// Persistence (debounced autosave + init load)
// ---------------------------------------------------------------------------

function schedulePersist(key?: string): void {
	const resolvedKey = key ?? activeKey();
	const s = getOrCreate(resolvedKey);
	if (s.persistTimer) clearTimeout(s.persistTimer);
	s.persistTimer = setTimeout(() => {
		s.persistTimer = null;
		void persistNow(resolvedKey);
	}, PERSIST_DEBOUNCE_MS);
}

/** The turns the backend took. A turn still being sent, or one that failed, is not history yet. */
function deliveredMessages(s: PerTerminalConversationState): ConversationMessage[] {
	return s.messages().filter((message) => !message.delivery);
}

/** A fork keeps the title it was given; any other conversation is titled from its first user turn. */
function keptTitle(saved: string | undefined): string | null {
	return saved?.startsWith(FORK_PREFIX) ? saved : null;
}

/** The title a conversation is saved under when nothing fixed one: its first user turn. */
function derivedTitle(msgs: ConversationMessage[]): string {
	const firstUser = msgs.find((m) => m.role === "user");
	const content = firstUser?.content ?? "";
	// An attached image is a path marker in the text; a title is the words around it.
	const words = content.replace(/\[image:\s*[^\]\r\n]+\]/g, " ");
	const title = words.slice(0, 60).replace(/\s+/g, " ").trim();
	return title || (words.length < content.length ? "Image" : "New chat");
}

/** Write `msgs` as conversation `id`. Throws when the backend refuses, so each caller decides what that means. */
async function saveConversation(key: string, id: string, title: string, msgs: ConversationMessage[]): Promise<void> {
	const now = Date.now();
	let provider: string | undefined;
	let model: string | undefined;
	try {
		const cfg = await invoke<{ provider: string; model: string }>("load_ai_chat_config");
		provider = cfg.provider || undefined;
		model = cfg.model || undefined;
	} catch (e) {
		appLogger.debug("conversation", "load_ai_chat_config unavailable, omitting provider metadata", {
			error: String(e),
		});
	}
	const conv: BackendConversation = {
		meta: {
			id,
			title,
			session_id: key === DEFAULT_KEY ? null : key,
			created: msgs[0]?.timestamp ?? now,
			updated: now,
			message_count: msgs.length,
			provider,
			model,
		},
		messages: msgs.map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
		schema_version: 1,
	};
	await invoke("save_conversation", { conversation: conv });
}

async function persistNow(key?: string): Promise<void> {
	const resolvedKey = key ?? activeKey();
	const s = getOrCreate(resolvedKey);
	const msgs = deliveredMessages(s);
	if (msgs.length === 0) return;
	try {
		await saveConversation(resolvedKey, s.chatId(), s.title ?? derivedTitle(msgs), msgs);
	} catch (e) {
		appLogger.warn("conversation", "persistNow failed", { error: String(e) });
	}
}

async function initFromDisk(tuicSession?: string): Promise<void> {
	const s = activeConversation();
	if (s.initialized) return;
	s.initialized = true;
	try {
		if (tuicSession) {
			try {
				const metas = await invoke<BackendConversationMeta[]>("list_conversations");
				const match = metas
					.filter((m) => m.session_id === tuicSession)
					.reduce<BackendConversationMeta | undefined>(
						(best, m) => (!best || m.updated > best.updated ? m : best),
						undefined,
					);
				if (match) {
					const conv = await invoke<BackendConversation>("load_conversation", { id: match.id });
					batch(() => {
						s.setChatId(conv.meta.id);
						s.setMessages(adoptMessages(conv.messages));
						s.setStreamingText("");
						s.setIsStreaming(false);
						s.setError(null);
						s.setClearedThrough(0);
					});
					s.title = keptTitle(conv.meta.title);
					return;
				}
			} catch (e) {
				appLogger.info("conversation", "no saved conversation for session, starting new", {
					tuicSession,
					error: String(e),
				});
			}
			const newId = await invoke<string>("new_conversation_id");
			s.setChatId(newId);
			return;
		}
		const newId = await invoke<string>("new_conversation_id");
		s.setChatId(newId);
	} catch (e) {
		appLogger.warn("conversation", "initFromDisk failed", { error: String(e) });
	}
}

// ---------------------------------------------------------------------------
// ConversationEvent handler (Channel-based, used by both chat and agent)
// ---------------------------------------------------------------------------

function applyConversationEvent(s: PerTerminalConversationState, event: ConversationEvent, ownerKey?: string): void {
	const mode = s.currentMode ?? "assisted";
	switch (event.type) {
		case "thinking":
			s.setCurrentIteration(event.iteration);
			// Only an agent run is an agent state. An Ask turn used to be marked
			// "running" here and nothing ever took it back, so after one question
			// the thread showed "Agent running" for good and Agent mode refused to
			// start. An Ask turn is busy through `isStreaming` alone.
			if (mode === "autonomous") s.setAgentState("running");
			s.setIsThinking(true);
			break;

		case "text_chunk":
			s.setIsThinking(false);
			if (mode === "autonomous") {
				s.setTextChunks((prev) => prev + event.text);
			} else {
				s.setStreamingText((prev) => prev + event.text);
			}
			notifyDelta(event.text);
			break;

		case "reasoning_chunk":
			// Extended-thinking stream (Opus 4.7+). Accumulate for the disclosure;
			// reset happens at the start of each new user turn (see sendMessage).
			s.setReasoningChunks((prev) => prev + event.text);
			break;

		case "tool_call": {
			s.setIsThinking(false);
			const entry: ToolCallEntry = {
				status: "pending",
				toolName: event.tool_name,
				args: event.args as Record<string, unknown>,
				startedAt: Date.now(),
			};
			s.setToolCalls((prev) => {
				const next = [...prev, entry];
				return next.length > MAX_TOOL_CALLS ? next.slice(next.length - MAX_TOOL_CALLS) : next;
			});
			notifyToolCall(event.tool_name, entry.args);
			break;
		}

		case "tool_result":
			s.setToolCalls((prev) => {
				const updated = [...prev];
				for (let i = updated.length - 1; i >= 0; i--) {
					if (updated[i].toolName === event.tool_name && updated[i].status === "pending") {
						updated[i] = {
							...updated[i],
							status: "done",
							result: { success: event.success, output: event.output },
							duration: Date.now() - updated[i].startedAt,
						};
						break;
					}
				}
				return updated;
			});
			break;

		case "needs_approval":
			if (s.activeSessionId) {
				s.setPendingApproval({
					sessionId: s.activeSessionId,
					command: event.command,
					reason: event.reason,
					approvalId: event.approval_id,
				});
			} else {
				appLogger.warn("conversation", "needs_approval event dropped — no active session");
			}
			break;

		case "bypassed":
			// Silently skip — bypassed tools run without approval
			break;

		case "paused":
			s.setAgentState("paused");
			s.setIsThinking(false);
			break;

		case "resumed":
			s.setAgentState("running");
			s.setIsThinking(false);
			break;

		case "rate_limited":
			appLogger.info("conversation", `Rate limited, waiting ${event.wait_ms}ms`);
			break;

		case "retrying":
			appLogger.info(
				"conversation",
				`Retrying LLM call (attempt ${event.attempt}) in ${event.wait_ms}ms: ${event.reason}`,
			);
			break;

		case "compacted":
			appLogger.info(
				"conversation",
				`History compacted: elided ${event.elided} old tool result(s) at ${event.before_tokens} tokens`,
			);
			break;

		case "error":
			// Same as completion for observers: the turn is over, so whatever a
			// chunker is holding must not leak into the next one.
			notifyTurnEnd();
			batch(() => {
				s.setIsThinking(false);
				if (mode === "autonomous") {
					s.setAgentState("error");
					s.setAgentError(event.message);
				} else {
					s.setIsStreaming(false);
					s.setStreamingText("");
					s.setError(event.message);
					// The question got no answer: it stays in the thread with its
					// payload, marked, so it can be sent again as it was.
					failTurn(s, "no_reply", event.message);
				}
			});
			if (mode !== "autonomous") schedulePersist(ownerKey ?? activeKey());
			break;

		case "completed": {
			const usage = event.usage;
			s.setIsThinking(false);
			notifyTurnEnd();
			if (usage) {
				appLogger.info("conversation", `usage: input=${usage.input_tokens} output=${usage.output_tokens}`);
				accumulateUsageForState(s, usage);
			}
			if (mode === "autonomous") {
				batch(() => {
					s.setAgentState("completed");
					s.setCompletionReason(event.reason);
				});
			} else {
				const full = s.streamingText();
				const cutShort = truncatedReason(event.reason);
				batch(() => {
					s.setIsStreaming(false);
					s.setStreamingText("");
					s.turnMessageId = null;
					if (full) appendMessage(s, { role: "assistant", content: full });
					// Assisted mode used to drop `reason` on the floor, so a turn
					// the backend cut off mid-thought was indistinguishable from
					// one that finished — the chat just stopped after the last
					// tool result with nothing to explain it.
					if (cutShort) s.setError(cutShort);
				});
				if (cutShort) appLogger.warn("conversation", "Assisted turn ended early", { reason: event.reason });
				schedulePersist(ownerKey ?? activeKey());
			}
			break;
		}
	}
}

/**
 * Turn a backend completion reason into something worth showing the user, or
 * null when the turn ended normally.
 *
 * The backend reports why a turn stopped, but only two of those reasons mean
 * "finished". The rest cut the turn off with work still pending, and reporting
 * them as a clean finish is what made a truncated reply look like the model
 * simply had nothing more to say.
 */
function truncatedReason(reason: string): string | null {
	if (reason === "end_turn" || reason === "cancelled") return null;
	if (reason === "max_iterations") {
		return "The reply stopped early: it reached the tool-step limit for chat. Switch to autonomous mode for longer tool chains.";
	}
	if (reason === "timeout") return "The reply stopped early: the turn ran out of time.";
	if (reason.startsWith("repetition_detected")) {
		return "The reply stopped early: the model repeated the same tool call too many times.";
	}
	if (reason.endsWith("rate_limit") || reason.endsWith("limit")) {
		return "The reply stopped early: a rate limit was reached.";
	}
	return `The reply stopped early (${reason}).`;
}

function accumulateUsageForState(
	s: PerTerminalConversationState,
	usage: { input_tokens: number; output_tokens: number },
): void {
	s.setSessionUsage((prev) => ({
		promptTokens: (prev?.promptTokens ?? 0) + usage.input_tokens,
		completionTokens: (prev?.completionTokens ?? 0) + usage.output_tokens,
		totalTokens: (prev?.totalTokens ?? 0) + usage.input_tokens + usage.output_tokens,
		cachedTokens: prev?.cachedTokens,
		cacheCreationTokens: prev?.cacheCreationTokens,
		costUsd: prev?.costUsd,
	}));
}

// ---------------------------------------------------------------------------
// Conversation control
// ---------------------------------------------------------------------------

/**
 * Per-turn overrides chosen in the chat header. Both are optional; omitting one
 * lets the backend fall through to the slot model's setting and then the global
 * AI-chat config.
 */
export interface TurnOptions {
	modelOverride?: string;
	reasoningEffort?: string;
}

/** Drop empty strings so an unset picker doesn't override the configured default. */
export function turnParams(opts?: TurnOptions): Record<string, string> {
	const params: Record<string, string> = {};
	if (opts?.modelOverride?.trim()) params.modelOverride = opts.modelOverride.trim();
	if (opts?.reasoningEffort?.trim()) params.reasoningEffort = opts.reasoningEffort.trim();
	return params;
}

async function sendMessage(text: string, sessionId: string | null, opts?: TurnOptions): Promise<void> {
	const s = activeConversation();
	if (s.isStreaming()) return;
	if (!sessionId) {
		s.setError("No terminal attached — focus a terminal first");
		return;
	}

	const capturedKey = activeKey();
	// On screen at once, marked as still on its way: it becomes part of the
	// conversation, and of the saved history, when the backend takes the turn.
	const localId = appendMessage(s, { role: "user", content: text, delivery: "sending", turn: opts });
	await runAssistedTurn(s, capturedKey, localId, text, sessionId, opts);
}

/** Mark the user turn `localId` as taken by the backend. Safe to call more than once. */
function confirmDelivery(s: PerTerminalConversationState, key: string, localId: number): void {
	const message = s.messages().find((candidate) => candidate.localId === localId);
	if (message?.delivery !== "sending") return;
	patchMessage(s, localId, { delivery: undefined });
	schedulePersist(key);
}

/** The running assisted turn ended without an answer: keep its question, marked, for a retry. */
function failTurn(s: PerTerminalConversationState, delivery: "not_sent" | "no_reply", failure: string): void {
	const localId = s.turnMessageId;
	s.turnMessageId = null;
	if (localId == null) return;
	patchMessage(s, localId, { delivery, failure });
}

/** Run one Ask turn for the user message `localId`, which is already in the thread as "sending". */
async function runAssistedTurn(
	s: PerTerminalConversationState,
	capturedKey: string,
	localId: number,
	text: string,
	sessionId: string,
	opts?: TurnOptions,
): Promise<void> {
	batch(() => {
		s.setError(null);
		s.setIsStreaming(true);
		s.setStreamingText("");
		s.setReasoningChunks("");
	});
	s.currentMode = "assisted";
	s.activeSessionId = sessionId;
	s.turnMessageId = localId;
	// The first event proves the turn was taken as surely as the command's own
	// answer does, and over a WebSocket it is the only proof there is.
	const onEvent = (event: ConversationEvent) => {
		confirmDelivery(s, capturedKey, localId);
		applyConversationEvent(s, event, capturedKey);
	};

	try {
		if (isTauri()) {
			const { invoke: coreInvoke, Channel } = await import("@tauri-apps/api/core");
			const channel = new Channel<ConversationEvent>();
			channel.onmessage = onEvent;
			await coreInvoke("start_conversation", {
				sessionId,
				message: text,
				autonomy: "assisted",
				...turnParams(opts),
				onEvent: channel,
			});
			confirmDelivery(s, capturedKey, localId);
		} else {
			// Browser/PWA: dedicated WS carries the token stream (event-bridge plan Step 5).
			closeConversationStream(s); // drop any orphaned prior stream first
			s.conversationStreamDispose = openConversationStream<ConversationEvent>(
				sessionId,
				{ message: text, autonomy: "assisted", ...turnParams(opts) },
				onEvent,
				() => onConversationStreamClosed(s, capturedKey),
			);
		}
	} catch (e) {
		batch(() => {
			s.setIsStreaming(false);
			s.setStreamingText("");
			s.setError(String(e));
			failTurn(s, "not_sent", String(e));
		});
		appLogger.warn("conversation", "start_conversation (assisted) failed", { error: String(e) });
	}
}

/**
 * Send a failed turn again, as it was: same text, same model and effort. It
 * leaves its old place and goes to the end of the thread, where its answer
 * will land. The composer and whatever is typed in it are not touched.
 */
async function retryMessage(localId: number, sessionId: string | null): Promise<void> {
	const key = activeKey();
	const s = getOrCreate(key);
	if (s.isStreaming()) return;
	const failed = s.messages().find((message) => message.localId === localId && isFailedDelivery(message));
	if (!failed) return;
	if (!sessionId) {
		s.setError("No terminal attached — focus a terminal first");
		return;
	}
	const retriedId = nextLocalId++;
	const retried: ConversationMessage = {
		role: "user",
		content: failed.content,
		timestamp: Date.now(),
		localId: retriedId,
		delivery: "sending",
		turn: failed.turn,
	};
	s.setMessages((prev) => [...prev.filter((message) => message.localId !== localId), retried]);
	await runAssistedTurn(s, key, retriedId, failed.content, sessionId, failed.turn);
}

/** Drop a failed turn the user does not want to send again. */
function discardMessage(localId: number): void {
	const s = activeConversation();
	const failed = s.messages().find((message) => message.localId === localId && isFailedDelivery(message));
	if (!failed) return;
	batch(() => {
		s.setMessages((prev) => prev.filter((message) => message.localId !== localId));
		if (s.error() === failed.failure) s.setError(null);
	});
}

async function cancelStream(): Promise<void> {
	const s = activeConversation();
	if (!s.isStreaming()) return;
	if (!s.activeSessionId) return;
	try {
		// Wrapper invoke: Tauri IPC on desktop, HTTP (COMMAND_TABLE) in browser.
		// The conversation's terminal event then arrives over the active stream.
		await invoke("cancel_conversation", { sessionId: s.activeSessionId });
	} catch (e) {
		appLogger.warn("conversation", "cancel_conversation failed", { error: String(e) });
	}
}

async function startAgent(
	sessionId: string,
	goal: string,
	isUnrestricted?: boolean,
	opts?: TurnOptions,
): Promise<void> {
	const s = activeConversation();
	const capturedKey = activeKey();
	if (s.agentState() === "running" || s.agentState() === "paused") return;

	batch(() => {
		s.setAgentState("running");
		s.setToolCalls([]);
		s.setTextChunks("");
		s.setReasoningChunks("");
		s.setAgentError(null);
		s.setCompletionReason(null);
		s.setCurrentIteration(0);
		s.setPendingApproval(null);
		s.setIsThinking(false);
		// The task as submitted: a run that fails can be started again from it.
		s.setAgentGoal({ goal, unrestricted: !!isUnrestricted, turn: opts });
	});
	s.currentMode = "autonomous";
	s.activeSessionId = sessionId;

	const bypassed = isUnrestricted ? ["*"] : [];

	try {
		if (isTauri()) {
			const { invoke: coreInvoke, Channel } = await import("@tauri-apps/api/core");
			const onEvent = new Channel<ConversationEvent>();
			onEvent.onmessage = (event) => applyConversationEvent(s, event, capturedKey);
			await coreInvoke("start_conversation", {
				sessionId,
				message: goal,
				autonomy: "autonomous",
				bypassedTools: bypassed,
				...turnParams(opts),
				onEvent,
			});
		} else {
			// Browser/PWA: dedicated WS carries the agent token stream (event-bridge plan Step 5).
			closeConversationStream(s); // drop any orphaned prior stream first
			s.conversationStreamDispose = openConversationStream<ConversationEvent>(
				sessionId,
				{ message: goal, autonomy: "autonomous", bypassedTools: bypassed, ...turnParams(opts) },
				(event) => applyConversationEvent(s, event, capturedKey),
				() => onConversationStreamClosed(s, capturedKey),
			);
		}
	} catch (e) {
		batch(() => {
			s.setAgentState("error");
			s.setAgentError(String(e));
		});
		appLogger.warn("conversation", "start_conversation (autonomous) failed", { error: String(e) });
	}
}

/** Handle an unexpected browser WS drop: clear our disposer handle, and if the
 * stream was still active (no Completed/Error frame arrived), surface a synthetic
 * error so the UI doesn't wedge in a perpetual "streaming"/"running" state. A
 * close right after a terminal frame is expected — `isStreaming`/`agentState`
 * are already settled, so we stay quiet. */
function onConversationStreamClosed(s: PerTerminalConversationState, ownerKey: string): void {
	s.conversationStreamDispose = null;
	if (s.isStreaming() || s.agentState() === "running") {
		applyConversationEvent(s, { type: "error", message: "Stream connection lost" }, ownerKey);
	}
}

async function cancelAgent(sessionId: string): Promise<void> {
	const s = activeConversation();
	try {
		await invoke("cancel_conversation", { sessionId });
		s.setAgentState("cancelled");
	} catch (e) {
		s.setAgentState("error");
		s.setAgentError(String(e));
		appLogger.warn("conversation", "cancel_conversation failed", { error: String(e) });
	}
}

async function pauseAgent(sessionId: string): Promise<void> {
	const s = activeConversation();
	try {
		await invoke("pause_conversation", { sessionId });
		s.setAgentState("paused");
	} catch (e) {
		s.setAgentState("error");
		s.setAgentError(String(e));
		appLogger.warn("conversation", "pause_conversation failed", { error: String(e) });
	}
}

async function resumeAgent(sessionId: string): Promise<void> {
	const s = activeConversation();
	try {
		await invoke("resume_conversation", { sessionId });
		s.setAgentState("running");
	} catch (e) {
		s.setAgentState("error");
		s.setAgentError(String(e));
		appLogger.warn("conversation", "resume_conversation failed", { error: String(e) });
	}
}

/** Answer the approval on screen. It quotes that request's one-time id, so the
 * backend can refuse it if a newer request has taken its place. */
async function approveAction(sessionId: string, approved: boolean): Promise<void> {
	const s = activeConversation();
	const pending = s.pendingApproval();
	const approvalId = pending?.sessionId === sessionId ? (pending.approvalId ?? null) : null;
	try {
		await invoke("approve_conversation_action", { sessionId, approved, approvalId });
		s.setPendingApproval(null);
	} catch (e) {
		// The request it answered is gone (answered, cancelled or replaced): drop
		// the stale card; the run itself is unaffected.
		if (String(e).includes("no longer pending")) {
			if (s.pendingApproval() === pending) s.setPendingApproval(null);
			appLogger.info("conversation", "approval answered a request that is no longer pending");
			return;
		}
		s.setAgentState("error");
		s.setAgentError(String(e));
		appLogger.warn("conversation", "approve_conversation_action failed", { error: String(e) });
	}
}

/** Start the last agent task again after a failed run, with the options it was submitted with. */
async function retryAgent(sessionId: string | null): Promise<void> {
	const s = activeConversation();
	const last = s.agentGoal();
	if (!last || !sessionId || s.agentState() !== "error") return;
	await startAgent(sessionId, last.goal, last.unrestricted, last.turn);
}

function resetAgent(): void {
	const s = activeConversation();
	batch(() => {
		s.setAgentGoal(null);
		s.setAgentState("idle");
		s.setToolCalls([]);
		s.setTextChunks("");
		s.setReasoningChunks("");
		s.setAgentError(null);
		s.setCompletionReason(null);
		s.setCurrentIteration(0);
		s.setPendingApproval(null);
		s.setIsThinking(false);
	});
}

// ---------------------------------------------------------------------------
// Legacy event processing (backward compat with old agent-loop-event — removed in 1617)
// ---------------------------------------------------------------------------

function isLegacyAgentEvent(v: unknown): v is LegacyAgentEvent {
	return typeof v === "object" && v !== null && "type" in v && typeof (v as { type: unknown }).type === "string";
}

function processEvent(raw: unknown): void {
	if (!isLegacyAgentEvent(raw)) return;
	const s = activeConversation();
	const event = raw;
	switch (event.type) {
		case "started":
			s.setAgentState("running");
			break;
		case "thinking":
			s.setCurrentIteration(event.iteration);
			break;
		case "text_chunk":
			s.setTextChunks((prev) => prev + event.text);
			break;
		case "reasoning_chunk":
			s.setReasoningChunks((prev) => prev + event.text);
			break;
		case "tool_call": {
			const entry: ToolCallEntry = {
				status: "pending",
				toolName: event.tool_name,
				args: event.args,
				startedAt: Date.now(),
			};
			s.setToolCalls((prev) => {
				const next = [...prev, entry];
				return next.length > MAX_TOOL_CALLS ? next.slice(next.length - MAX_TOOL_CALLS) : next;
			});
			notifyToolCall(event.tool_name, entry.args);
			break;
		}
		case "tool_result":
			s.setToolCalls((prev) => {
				const updated = [...prev];
				for (let i = updated.length - 1; i >= 0; i--) {
					if (updated[i].toolName === event.tool_name && updated[i].status === "pending") {
						updated[i] = {
							...updated[i],
							status: "done",
							result: { success: event.success, output: event.output },
							duration: Date.now() - updated[i].startedAt,
						};
						break;
					}
				}
				return updated;
			});
			break;
		case "needs_approval":
			s.setPendingApproval({
				sessionId: event.session_id,
				command: event.command,
				reason: event.reason,
				approvalId: event.approval_id,
			});
			break;
		case "paused":
			s.setAgentState("paused");
			break;
		case "resumed":
			s.setAgentState("running");
			break;
		case "rate_limited":
			appLogger.info("conversation", `Rate limited, waiting ${event.wait_ms}ms`);
			break;
		case "error":
			batch(() => {
				s.setAgentState("error");
				s.setAgentError(event.message);
			});
			break;
		case "completed":
			batch(() => {
				s.setAgentState("completed");
				s.setCompletionReason(event.reason);
			});
			break;
	}
}

// ---------------------------------------------------------------------------
// Terminal lifecycle
// ---------------------------------------------------------------------------

/**
 * Drop a terminal's cached "already read from disk" mark so the next switch to
 * it re-reads the conversation. Needed when another window owned that
 * conversation and changed it: `initFromDisk` skips a state it has already
 * initialized, so without this the terminal keeps showing what it had before.
 */
function invalidateTerminal(key: string): void {
	const s = stateMap.get(key);
	if (s) s.initialized = false;
}

async function onTerminalClose(key: string): Promise<void> {
	const s = stateMap.get(key);
	if (!s) return;

	if (s.persistTimer) {
		clearTimeout(s.persistTimer);
		s.persistTimer = null;
	}

	// Browser/PWA: the terminal is gone, so close the token-stream WS rather than
	// leak it waiting for a terminal frame that no one will consume.
	closeConversationStream(s);

	if ((s.isStreaming() || s.agentState() === "running") && s.activeSessionId) {
		try {
			await invoke("cancel_conversation", { sessionId: s.activeSessionId });
		} catch (e) {
			appLogger.warn("conversation", "onTerminalClose: cancel_conversation failed", { error: String(e) });
		}
	}

	if (s.messages().length > 0) {
		await persistNow(key);
	}

	stateMap.delete(key);
}

// ---------------------------------------------------------------------------
// Chat ID helpers
// ---------------------------------------------------------------------------

function resetChatId(): void {
	activeConversation().setChatId(generateChatId());
}

function setChatId(id: string): void {
	activeConversation().setChatId(id);
}

function setError(e: string | null): void {
	activeConversation().setError(e);
}

// ---------------------------------------------------------------------------
// Reply observers
// ---------------------------------------------------------------------------

/**
 * Callbacks fired as the assistant's reply streams. Voice mode uses these to
 * push deltas into a sentence chunker and speak them; polling `streamingText()`
 * in an effect would work too, but would re-derive the delta on every render.
 */
type ReplyObserver = {
	onDelta?: (text: string) => void;
	onTurnEnd?: () => void;
	/** The assistant called a tool. Talk mode turns the ones that act on a terminal into chips. */
	onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
};

const replyObservers = new Set<ReplyObserver>();

/** Subscribe to streamed reply text. Returns an unsubscribe function. */
function observeReply(observer: ReplyObserver): () => void {
	replyObservers.add(observer);
	return () => replyObservers.delete(observer);
}

function notifyDelta(text: string): void {
	// An observer that throws must not break the chat stream it is watching.
	for (const observer of replyObservers) {
		try {
			observer.onDelta?.(text);
		} catch (e) {
			appLogger.warn("conversation", "reply observer failed", { error: String(e) });
		}
	}
}

function notifyTurnEnd(): void {
	for (const observer of replyObservers) {
		try {
			observer.onTurnEnd?.();
		} catch (e) {
			appLogger.warn("conversation", "reply observer failed", { error: String(e) });
		}
	}
}

function notifyToolCall(toolName: string, args: Record<string, unknown>): void {
	for (const observer of replyObservers) {
		try {
			observer.onToolCall?.(toolName, args);
		} catch (e) {
			appLogger.warn("conversation", "reply observer failed", { error: String(e) });
		}
	}
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function listAllConversations(): Promise<ConversationMeta[]> {
	try {
		return await invoke<BackendConversationMeta[]>("list_conversations");
	} catch (e) {
		appLogger.warn("conversation", "listAllConversations failed", { error: String(e) });
		return [];
	}
}

async function loadConversation(id: string): Promise<void> {
	const s = activeConversation();
	// What the conversation held when the read started. A read only speaks for a
	// conversation that has not moved on since: a detached window hydrates on
	// mount without waiting for the disk, so a send can overtake the read, and
	// applying it afterwards would erase the user's turn and drop the streaming
	// flag — leaving the reply to land on a history that never asked anything.
	const before = s.messages();
	try {
		const conv = await invoke<BackendConversation>("load_conversation", { id });
		if (s.messages() !== before) {
			appLogger.info("conversation", "loadConversation: dropped a read the conversation outran", { id });
			return;
		}
		batch(() => {
			s.setChatId(conv.meta.id);
			s.setMessages(adoptMessages(conv.messages));
			s.setStreamingText("");
			s.setIsStreaming(false);
			s.setError(null);
			s.setClearedThrough(0);
		});
		s.title = keptTitle(conv.meta.title);
	} catch (e) {
		appLogger.warn("conversation", "loadConversation failed", { id, error: String(e) });
	}
}

/** A fresh conversation id; a local one when the backend cannot be asked, never the id in use. */
async function freshConversationId(): Promise<string> {
	try {
		const id = await invoke<string>("new_conversation_id");
		if (typeof id === "string" && id) return id;
	} catch (e) {
		appLogger.warn("conversation", "new_conversation_id failed, using a local id", { error: String(e) });
	}
	return generateChatId();
}

/** Put a conversation on screen in place of the current one, with nothing in flight. */
function showConversation(s: PerTerminalConversationState, id: string, messages: ConversationMessage[]): void {
	batch(() => {
		s.setChatId(id);
		s.setMessages(messages);
		s.setStreamingText("");
		s.setIsStreaming(false);
		s.setError(null);
		s.setSessionUsage(null);
		s.setClearedThrough(0);
		s.setAgentGoal(null);
		s.setAgentState("idle");
		s.setToolCalls([]);
		s.setTextChunks("");
		s.setReasoningChunks("");
		s.setAgentError(null);
		s.setCompletionReason(null);
		s.setCurrentIteration(0);
		s.setPendingApproval(null);
		s.setIsThinking(false);
	});
	s.turnMessageId = null;
}

/**
 * Start a new conversation in the active terminal. The one on screen is saved
 * first and stays in History; nothing is deleted. Refused while a turn runs.
 */
async function newConversation(): Promise<NewConversationOutcome> {
	const key = activeKey();
	const s = getOrCreate(key);
	if (isBusy(s)) return "busy";
	if (s.messages().length === 0 && s.toolCalls().length === 0 && !s.textChunks()) return "empty";
	if (s.persistTimer) {
		clearTimeout(s.persistTimer);
		s.persistTimer = null;
	}
	await persistNow(key);
	const id = await freshConversationId();
	// A send can start while the save is in the air; that turn keeps its conversation.
	if (isBusy(s)) return "busy";
	showConversation(s, id, []);
	s.title = null;
	return "started";
}

/**
 * Hide what is on screen without touching what is saved: the messages stay in
 * the conversation and in History, and opening it from there shows them again.
 * A turn that is running keeps running. Returns false when nothing was hidden.
 */
function clearView(): boolean {
	const s = activeConversation();
	const last = s.messages().reduce((max, message) => Math.max(max, message.localId ?? 0), 0);
	const finishedRun = ["completed", "cancelled", "error"].includes(s.agentState());
	if (last <= s.clearedThrough() && !finishedRun) return false;
	s.setClearedThrough(last);
	// A finished agent run is view state only (its output is never saved): it goes with the view.
	if (finishedRun) resetAgent();
	return true;
}

/**
 * Branch the conversation after a completed answer: the turns up to it become
 * a new conversation, the original stays in History. With `atLocalId` the cut
 * is that answer; without it, the last answer that completed. A turn that is
 * still being sent, failed, or is streaming is never part of a branch.
 *
 * One conversation runs per terminal, so while a turn is running here the
 * branch is saved to History ("saved") instead of being opened ("forked").
 */
async function forkConversation(atLocalId?: number): Promise<ForkOutcome> {
	const key = activeKey();
	const s = getOrCreate(key);
	const delivered = deliveredMessages(s);
	const cut =
		atLocalId == null
			? delivered.findLastIndex((message) => message.role === "assistant")
			: delivered.findIndex((message) => message.localId === atLocalId && message.role === "assistant");
	if (cut < 0) return "nothing";
	const prefix = delivered.slice(0, cut + 1);
	const base = s.title ?? derivedTitle(prefix);
	const title = base.startsWith(FORK_PREFIX) ? base : `${FORK_PREFIX}${base}`;
	const id = await freshConversationId();
	try {
		if (isBusy(s)) {
			await saveConversation(key, id, title, prefix);
			return "saved";
		}
		if (s.persistTimer) {
			clearTimeout(s.persistTimer);
			s.persistTimer = null;
		}
		await persistNow(key);
		await saveConversation(key, id, title, prefix);
	} catch (e) {
		appLogger.warn("conversation", "forkConversation: saving the branch failed", { error: String(e) });
		return "failed";
	}
	// A send can start while the saves are in the air; that turn keeps its conversation.
	if (isBusy(s)) return "saved";
	showConversation(
		s,
		id,
		prefix.map((message) => ({ ...message, localId: nextLocalId++ })),
	);
	s.title = title;
	return "forked";
}

// ---------------------------------------------------------------------------
// Streaming helpers (backward compat shims for tests)
// ---------------------------------------------------------------------------

function setStreaming(v: boolean): void {
	activeConversation().setIsStreaming(v);
}
function appendStreamChunk(text: string): void {
	activeConversation().setStreamingText((prev) => prev + text);
}
function finalizeStream(fullText: string): void {
	const s = activeConversation();
	batch(() => {
		s.setIsStreaming(false);
		s.setStreamingText("");
		addAssistantMessage(fullText);
	});
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const conversationStore = {
	// Per-terminal API
	activeConversation,
	getOrCreate,
	setActiveTerminal,
	invalidateTerminal,
	onTerminalClose,

	// Reactive getters (proxy through activeConversation)
	messages,
	isStreaming,
	streamingText,
	error,
	chatId,
	sessionUsage,
	agentState,
	currentIteration,
	toolCalls,
	textChunks,
	reasoningChunks,
	pendingApproval,
	agentError,
	completionReason,
	unrestricted,
	setUnrestricted,
	isThinking,
	agentGoal,
	visibleMessages,
	chatActivity,
	chatActivityOf,

	// Chat actions
	addUserMessage,
	addAssistantMessage,
	addSystemMessage,
	accumulateUsage,
	clearHistory,
	setStreaming,
	appendStreamChunk,
	finalizeStream,
	sendMessage,
	retryMessage,
	discardMessage,
	cancelStream,
	setError,
	newConversation,
	clearView,
	forkConversation,
	resetChatId,
	setChatId,

	// Agent actions
	startAgent,
	cancelAgent,
	pauseAgent,
	resumeAgent,
	approveAction,
	retryAgent,
	reset: resetAgent,

	// Legacy event processing (removed in 1617)
	processEvent,

	// Persistence
	initFromDisk,
	persistNow,

	// Reply observers (voice mode)
	observeReply,

	// History
	listAllConversations,
	loadConversation,
};
