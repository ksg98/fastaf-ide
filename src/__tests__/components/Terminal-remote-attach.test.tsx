import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const { createSession, attachedOwners } = vi.hoisted(() => ({
	createSession: vi.fn().mockResolvedValue("remote-session"),
	attachedOwners: [] as Array<string | undefined>,
}));

vi.mock("../../hooks/usePty", () => ({
	usePty: () => ({ createSession, resize: vi.fn(), close: vi.fn(), getKittyFlags: vi.fn().mockResolvedValue(0) }),
}));
vi.mock("../../stores/agentConfigs", () => ({
	ensureAgentConfigsForRepo: vi.fn().mockResolvedValue({ getEnvFlags: () => ({}) }),
	agentConfigsForRepo: () => ({ getEnvFlags: () => ({}) }),
}));
vi.mock("../../components/Terminal/glyphCache", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../components/Terminal/glyphCache")>()),
	getSharedMetrics: () => ({ cellWidth: 8, cellHeight: 16 }),
}));
vi.mock("../../components/Terminal/CanvasTerminal", async () => {
	const { onMount } = await import("solid-js");
	const { getSessionConnection } = await import("../../transportRuntime");
	return {
		default: (props: { sessionId: string }) => {
			onMount(() => attachedOwners.push(getSessionConnection(props.sessionId)));
			return <div data-testid="attached-canvas" />;
		},
	};
});

import { Terminal } from "../../components/Terminal/Terminal";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { HttpRpcError } from "../../transport";

describe("remote terminal attachment", () => {
	async function open(path: string, connectionId?: string) {
		repositoriesStore._testSetHydrated(true);
		vi.useFakeTimers();
		repositoriesStore.add({ path, displayName: "repo", connectionId });
		vi.clearAllTimers();
		vi.useRealTimers();
		const id = terminalsStore.add({
			sessionId: null,
			cwd: path,
			repoPath: path,
			name: "shell",
			fontSize: 13,
			awaitingInput: null,
		});
		attachedOwners.length = 0;
		const oldRaf = globalThis.requestAnimationFrame;
		const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
		const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
		Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
		globalThis.requestAnimationFrame = (cb) => {
			cb(0);
			return 1;
		};
		try {
			const view = render(() => <Terminal id={id} cwd={path} alwaysVisible />);
			return { ...view, id };
		} finally {
			globalThis.requestAnimationFrame = oldRaf;
			if (width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
			if (height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
		}
	}

	// Catches: the canvas mounts before its session has a remote owner and attaches to local IPC.
	it("binds a newly created remote PTY to its machine before the canvas mounts", async () => {
		await open("/home/stefano/omi-local-stack", "mac-mint");
		await waitFor(() => expect(attachedOwners).toEqual(["mac-mint"]));
	});

	// Catches: remote title frames arrive but Terminal still waits for local IPC titles.
	it("applies remote title and reset notifications while protecting a custom name", async () => {
		const transport = await import("../../transport");
		let onTitle: ((title: string) => void) | undefined;
		const subscribe = vi.spyOn(transport, "subscribePty").mockImplementation(async (_id, _data, _exit, options) => {
			if (options && typeof options !== "function") onTitle = options.onTitle;
			return Object.assign(() => {}, { pause: () => {}, resume: () => {} });
		});
		let unmount: (() => void) | undefined;
		try {
			const view = await open("/remote/title-repo", "title-host");
			unmount = view.unmount;
			await waitFor(() => expect(onTitle).toBeTypeOf("function"));
			onTitle!("Claude Code");
			expect(terminalsStore.get(view.id)?.name).toBe("Claude Code");
			onTitle!("");
			expect(terminalsStore.get(view.id)?.name).toBe("shell");
			terminalsStore.update(view.id, { name: "My tab", nameIsCustom: true });
			onTitle!("Claude Code");
			expect(terminalsStore.get(view.id)?.name).toBe("My tab");
		} finally {
			unmount?.();
			subscribe.mockRestore();
		}
	});

	// Catches: the ownership fix accidentally assigns the selected remote machine to local PTYs.
	it("keeps a newly created local PTY on the local transport", async () => {
		createSession.mockResolvedValueOnce("local-session");
		await open("/Users/stefano/Gits/local");
		await waitFor(() => expect(attachedOwners).toEqual([undefined]));
	});

	// Catches: a rejected remote create request only reaches the log, leaving an empty pane.
	it("shows a failed remote spawn in the terminal instead of a blank pane", async () => {
		createSession.mockRejectedValueOnce(new Error("Failed to spawn PTY: No such file or directory"));
		const { container } = await open("/home/stefano/missing", "mac-mint");
		await waitFor(() => expect(container.textContent).toContain("Failed to spawn PTY: No such file or directory"));
		expect(attachedOwners).toEqual([]);
	});

	// Catches: the terminal prints the transport's raw 500 JSON rather than the daemon error.
	it("shows the daemon's missing-directory message without raw HTTP JSON", async () => {
		createSession.mockRejectedValueOnce(
			new HttpRpcError("create_session", 500, '{"error":"Working directory does not exist"}'),
		);
		const { container } = await open("/home/stefano/missing", "mac-mint");
		await waitFor(() => expect(container.textContent).toContain("Working directory does not exist"));
		expect(container.textContent).not.toContain("RPC create_session failed: 500");
	});
});
