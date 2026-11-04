import { transportLogger } from "../transportRuntime";
import { randomId } from "../utils/randomId";
import type { ResyncReason, SubscribeEventsOptions, Unsubscribe } from "./types";

type Handlers = Record<string, (payload: unknown) => void>;
interface Consumer {
	handlers: Handlers;
	onResync?: SubscribeEventsOptions["onResync"];
	connected: boolean;
	needsResync: boolean;
}

// Both browser APIs share this registry: sharing just subscribeEvents leaves
// listen() (dictation, speech, settings) competing for the same HTTP/1.1 slots.
const streams = new Map<string, SharedStream>();

class SharedStream {
	readonly consumers = new Set<Consumer>();
	private id = randomId("s");
	private source: EventSource | null = null;
	private readonly attached = new Set<string>();
	private covered = new Set<string>();
	private urlTypes = new Set<string>();
	private queued = false;
	private update: object | null = null;
	private generation = 0;
	private opened = false;

	constructor(private readonly base: string) {}

	private types(): string[] {
		return [...new Set([...this.consumers].flatMap((consumer) => Object.keys(consumer.handlers)))].sort();
	}

	private notify(consumer: Consumer, reason: ResyncReason): void {
		try {
			consumer.onResync?.(reason);
		} catch {
			transportLogger().warn("network", "SSE resync handler failed");
		}
	}

	private catchUp(): void {
		if (!this.opened) return;
		for (const consumer of this.consumers) {
			if (!consumer.needsResync || Object.keys(consumer.handlers).some((type) => !this.covered.has(type))) continue;
			consumer.needsResync = false;
			const reason = consumer.connected ? "reconnect" : "connect";
			consumer.connected = true;
			this.notify(consumer, reason);
		}
	}

	ensure(): void {
		if (this.queued) return;
		this.queued = true;
		setTimeout(() => {
			this.queued = false;
			if (!this.consumers.size) return;
			if (!this.source || this.source.readyState === EventSource.CLOSED) this.open();
			else this.widen();
		}, 0);
	}

	private open(): void {
		if (!this.consumers.size) return;
		this.source?.close();
		this.id = randomId("s");
		this.generation++;
		this.update = null;
		this.opened = false;
		const types = this.types();
		this.covered = new Set(types);
		this.urlTypes = new Set(types);
		this.attached.clear();
		const source = new EventSource(
			`${this.base}/events?types=${encodeURIComponent(types.join(","))}&stream_id=${encodeURIComponent(this.id)}`,
		);
		this.source = source;
		this.attach(types);
		source.addEventListener("lagged", () => {
			for (const consumer of this.consumers) this.notify(consumer, "lagged");
		});
		source.onopen = () => {
			if (this.source !== source) return;
			// Auto-reconnect replays the URL, not the widened server-side filter.
			this.generation++;
			this.covered = new Set(this.urlTypes);
			this.opened = true;
			for (const consumer of this.consumers) {
				consumer.needsResync = true;
			}
			this.widen();
		};
		source.onerror = () => {
			if (this.source !== source) return;
			this.opened = false;
			transportLogger().debug("network", "SSE connection error — will auto-reconnect");
		};
	}

	private attach(types: string[]): void {
		for (const type of types) {
			if (this.attached.has(type)) continue;
			this.attached.add(type);
			const source = this.source;
			source?.addEventListener(type, ((event: MessageEvent) => {
				if (this.source !== source) return;
				let payload: unknown;
				try {
					payload = JSON.parse(event.data);
				} catch {
					transportLogger().warn("network", `Failed to parse SSE event "${type}"`);
					return;
				}
				this.emit(type, payload);
			}) as EventListener);
		}
	}

	emit(type: string, payload: unknown): void {
		for (const consumer of [...this.consumers]) {
			if (!this.consumers.has(consumer)) continue;
			try {
				consumer.handlers[type]?.(payload);
			} catch {
				transportLogger().warn("network", `SSE handler failed for "${type}"`);
			}
		}
	}

	private widen(): void {
		const types = this.types();
		this.attach(types);
		if (types.every((type) => this.covered.has(type))) {
			this.catchUp();
			return;
		}
		if (this.update) return;
		const update = {};
		this.update = update;
		const generation = this.generation;
		// Serialize updates: two out-of-order POSTs must never narrow the filter.
		void fetch(`${this.base}/events/types`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ stream_id: this.id, types }),
		})
			.then((response) => {
				if (this.update !== update || !this.consumers.size) return;
				this.update = null;
				if (generation !== this.generation) {
					this.widen();
					return;
				}
				if (!response.ok) {
					this.open();
					return;
				}
				this.covered = new Set(types);
				this.widen();
			})
			.catch(() => {
				if (this.update !== update || !this.consumers.size) return;
				this.update = null;
				if (generation === this.generation) this.open();
				else this.widen();
			});
	}

	remove(consumer: Consumer): void {
		this.consumers.delete(consumer);
		if (this.consumers.size) return;
		this.generation++;
		this.source?.close();
		this.source = null;
		streams.delete(this.base);
	}
}

function backendKey(baseUrl?: string): string {
	const origin = typeof window !== "undefined" ? window.location.origin : "";
	return (baseUrl || origin).replace(/\/+$/, "");
}

export function subscribeSse(handlers: Handlers, options: SubscribeEventsOptions = {}): Unsubscribe {
	if (!Object.keys(handlers).length) return () => {};
	const key = backendKey(options.baseUrl);
	let stream = streams.get(key);
	if (!stream) {
		stream = new SharedStream(key);
		streams.set(key, stream);
	}
	const consumer: Consumer = { handlers, onResync: options.onResync, connected: false, needsResync: true };
	stream.consumers.add(consumer);
	stream.ensure();
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		stream.remove(consumer);
	};
}

export function emitSseLocalEvent(type: string, payload: unknown): void {
	streams.get(backendKey())?.emit(type, payload);
}
