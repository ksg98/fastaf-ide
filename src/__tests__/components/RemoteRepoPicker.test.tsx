import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpRpcError } from "../../transport";
import type { DirEntry } from "../../types/fs";

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc: mockRpc,
}));
vi.mock("../../stores/modalStack", () => ({ registerModal: vi.fn() }));
vi.mock("../../i18n", () => ({ t: (_key: string, fallback: string) => fallback }));

import { RemoteRepoPicker } from "../../components/RemoteRepoPicker/RemoteRepoPicker";

const dir = (name: string): DirEntry => ({
	name,
	path: name,
	is_dir: true,
	size: 0,
	modified_at: 0,
	git_status: "",
	is_ignored: false,
});

const file = (name: string): DirEntry => ({ ...dir(name), is_dir: false });

/** Listing keyed by the path asked for, so a test states the remote tree once. */
function serveTree(tree: Record<string, DirEntry[]>, home = "/") {
	mockRpc.mockImplementation((command: string, args: Record<string, unknown>) => {
		if (command === "get_home_directory") return Promise.resolve(home);
		if (command !== "list_directory") throw new Error(`unexpected command ${command}`);
		const path = args.repoPath as string;
		const entries = tree[path];
		if (!entries) return Promise.reject(new Error(`Failed to resolve repo path: ${path}`));
		return Promise.resolve(entries);
	});
}

/**
 * Each test gets its own connection id on purpose. The picker remembers where a
 * machine was last left, so a shared id would make one test's walk decide the
 * next test's starting directory — and the failure would read as a broken
 * listing rather than as the memory doing its job.
 */
let nextConnection = 0;
function open(onConfirm = vi.fn(), onClose = vi.fn()) {
	const connectionId = `conn-${++nextConnection}`;
	const utils = render(() => (
		<RemoteRepoPicker
			visible={true}
			connectionId={connectionId}
			connectionName="mac-mint"
			onClose={onClose}
			onConfirm={onConfirm}
		/>
	));
	return { ...utils, onConfirm, onClose, connectionId };
}

describe("RemoteRepoPicker", () => {
	beforeEach(() => {
		mockRpc.mockReset();
		// The picker remembers where each machine was left, in module scope. Give
		// every test its own machine id so one test's walk cannot seed the next.
		vi.resetModules();
	});

	it("lists the remote machine's directories, routed to that connection", async () => {
		serveTree({ "/": [dir("home"), dir("etc"), file("vmlinuz")] });
		const { findByText, queryByText, connectionId } = open();

		await findByText("home");
		expect(queryByText("etc")).toBeTruthy();
		// A picker for a *repository* offers directories only: a file can never be
		// the answer, and listing files buries the ones that can.
		expect(queryByText("vmlinuz")).toBeNull();

		expect(mockRpc).toHaveBeenCalledWith("list_directory", { repoPath: "/", subdir: "" }, connectionId);
	});

	// Catches: the picker assumes / or a Linux /home path on every remote machine.
	it("starts at the home directory reported by a macOS remote host", async () => {
		serveTree({ "/Users/stefano": [dir("Gits")] }, "/Users/stefano");
		const { findByText, connectionId } = open();
		await findByText("Gits");
		expect(mockRpc).toHaveBeenCalledWith("get_home_directory", {}, connectionId);
		expect(mockRpc).toHaveBeenCalledWith("list_directory", { repoPath: "/Users/stefano", subdir: "" }, connectionId);
		expect(mockRpc).not.toHaveBeenCalledWith("list_directory", { repoPath: "/", subdir: "" }, connectionId);
	});

	// Catches: a failed home lookup leaves the picker loading forever and prevents a known path.
	it("allows a typed path when the remote home lookup fails", async () => {
		serveTree({ "/Users/stefano": [dir("Gits")] });
		const original = mockRpc.getMockImplementation()!;
		mockRpc.mockImplementation((command: string, args: Record<string, unknown>, id: string) =>
			command === "get_home_directory"
				? Promise.reject(new HttpRpcError("get_home_directory", 503, '{"error":"Host temporarily unavailable"}'))
				: original(command, args, id),
		);
		const { findByText, container, queryByText } = open();
		await findByText("Could not find this machine's home directory: Host temporarily unavailable");
		expect(queryByText(/RPC get_home_directory failed/)).toBeNull();
		const input = container.querySelector("input") as HTMLInputElement;
		fireEvent.input(input, { target: { value: "/Users/stefano" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await findByText("Gits");
	});

	// Catches: a rejected HTML home response is hidden or copied into the path input.
	it("shows the transport HTML error and leaves the home body out of the path", async () => {
		const message =
			"RPC get_home_directory: expected JSON from http://verification.test/system/home-directory, received text/html";
		mockRpc.mockRejectedValue(new Error(message));
		const { findByText, container } = open();
		await findByText(`Could not find this machine's home directory: Error: ${message}`);
		expect((container.querySelector("input") as HTMLInputElement).value).toBe("/");
	});

	// Catches: reopening a connection discards the last browsed remote folder.
	it("reopens at the last directory visited on that connection", async () => {
		serveTree({ "/": [dir("home")], "/home": [dir("stefano")] });
		const connectionId = `conn-${++nextConnection}`;
		const props = { visible: true, connectionId, connectionName: "mac-mint", onClose: vi.fn(), onConfirm: vi.fn() };
		const first = render(() => <RemoteRepoPicker {...props} />);
		fireEvent.click(await first.findByText("home"));
		await first.findByText("stefano");
		first.unmount();
		mockRpc.mockClear();
		const second = render(() => <RemoteRepoPicker {...props} />);
		await second.findByText("stefano");
		expect(mockRpc).toHaveBeenCalledWith("list_directory", { repoPath: "/home", subdir: "" }, connectionId);
		expect(mockRpc).not.toHaveBeenCalledWith("get_home_directory", {}, connectionId);
	});

	// Catches: a late home response from the previous machine replaces the current machine's listing.
	it("ignores a stale home response after the selected connection changes", async () => {
		const oldId = `conn-${++nextConnection}`;
		const newId = `conn-${++nextConnection}`;
		let finishOld!: (home: string) => void;
		mockRpc.mockImplementation((command: string, args: Record<string, unknown>, id: string) => {
			if (command === "get_home_directory" && id === oldId)
				return new Promise<string>((resolve) => {
					finishOld = resolve;
				});
			if (command === "get_home_directory") return Promise.resolve("/Users/new");
			if (command === "list_directory" && args.repoPath === "/Users/new") return Promise.resolve([dir("new-repo")]);
			if (command === "list_directory" && args.repoPath === "/Users/old") return Promise.resolve([dir("old-repo")]);
			throw new Error(`unexpected ${command}`);
		});
		const [connectionId, setConnectionId] = createSignal(oldId);
		const view = render(() => (
			<RemoteRepoPicker
				visible
				connectionId={connectionId()}
				connectionName="host"
				onClose={vi.fn()}
				onConfirm={vi.fn()}
			/>
		));
		setConnectionId(newId);
		await view.findByText("new-repo");
		finishOld("/Users/old");
		await Promise.resolve();
		await Promise.resolve();
		expect(view.queryByText("old-repo")).toBeNull();
		expect(mockRpc).not.toHaveBeenCalledWith("list_directory", { repoPath: "/Users/old", subdir: "" }, oldId);
	});

	// Catches: a late error from a prior machine overwrites the current listing.
	it("ignores a stale home error after the selected connection changes", async () => {
		const oldId = `conn-${++nextConnection}`;
		const newId = `conn-${++nextConnection}`;
		let failOld!: (error: Error) => void;
		mockRpc.mockImplementation((command: string, args: Record<string, unknown>, id: string) => {
			if (command === "get_home_directory" && id === oldId)
				return new Promise<string>((_resolve, reject) => {
					failOld = reject;
				});
			if (command === "get_home_directory") return Promise.resolve("/Users/new");
			if (command === "list_directory" && args.repoPath === "/Users/new") return Promise.resolve([dir("new-repo")]);
			throw new Error(`unexpected ${command}`);
		});
		const [connectionId, setConnectionId] = createSignal(oldId);
		const view = render(() => (
			<RemoteRepoPicker
				visible
				connectionId={connectionId()}
				connectionName="host"
				onClose={vi.fn()}
				onConfirm={vi.fn()}
			/>
		));
		setConnectionId(newId);
		await view.findByText("new-repo");
		failOld(new Error("old host failed"));
		await Promise.resolve();
		await Promise.resolve();
		expect(view.queryByText("old host failed")).toBeNull();
	});

	// Catches: a hidden picker probes the remote host before the user opens it.
	it("does not browse a connection while the picker is hidden", async () => {
		serveTree({ "/Users/stefano": [dir("Gits")] }, "/Users/stefano");
		const [visible, setVisible] = createSignal(false);
		const connectionId = `conn-${++nextConnection}`;
		const view = render(() => (
			<RemoteRepoPicker
				visible={visible()}
				connectionId={connectionId}
				connectionName="host"
				onClose={vi.fn()}
				onConfirm={vi.fn()}
			/>
		));
		expect(mockRpc).not.toHaveBeenCalled();
		setVisible(true);
		await view.findByText("Gits");
	});

	// Catches: a home response arriving after close starts a hidden directory listing.
	it("ignores a home response after the picker closes", async () => {
		let finishHome!: (home: string) => void;
		mockRpc.mockImplementation((command: string) => {
			if (command === "get_home_directory")
				return new Promise<string>((resolve) => {
					finishHome = resolve;
				});
			if (command === "list_directory") return Promise.resolve([dir("should-not-load")]);
			throw new Error(`unexpected ${command}`);
		});
		const [visible, setVisible] = createSignal(true);
		const connectionId = `conn-${++nextConnection}`;
		const view = render(() => (
			<RemoteRepoPicker
				visible={visible()}
				connectionId={connectionId}
				connectionName="host"
				onClose={vi.fn()}
				onConfirm={vi.fn()}
			/>
		));
		setVisible(false);
		finishHome("/Users/stefano");
		await Promise.resolve();
		await Promise.resolve();
		expect(mockRpc).not.toHaveBeenCalledWith("list_directory", expect.anything(), connectionId);
		expect(view.queryByText("should-not-load")).toBeNull();
	});

	// Catches: a 500 response appears as raw JSON or traps the picker in the denied folder.
	it("explains a denied folder and still allows a typed path and upward navigation", async () => {
		serveTree({ "/Users/stefano": [dir("private")], "/Users": [dir("stefano")] }, "/Users/stefano");
		const original = mockRpc.getMockImplementation()!;
		mockRpc.mockImplementation((command: string, args: Record<string, unknown>, id: string) =>
			command === "list_directory" && args.repoPath === "/Users/stefano/private"
				? Promise.reject(
						new HttpRpcError(
							"list_directory",
							500,
							'{"error":"Failed to read directory: Permission denied (os error 13)"}',
						),
					)
				: original(command, args, id),
		);
		const { findByText, container, queryByText } = open();
		fireEvent.click(await findByText("private"));
		await findByText("Failed to read directory: Permission denied (os error 13)");
		expect(queryByText(/RPC list_directory failed/)).toBeNull();
		const input = container.querySelector("input") as HTMLInputElement;
		fireEvent.input(input, { target: { value: "/Users" } });
		fireEvent.keyDown(input, { key: "Enter" });
		await findByText("stefano");
		fireEvent.click(await findByText(".."));
		expect(mockRpc).toHaveBeenCalledWith("list_directory", { repoPath: "/", subdir: "" }, expect.any(String));
	});

	// Catches: denying the initial home listing leaves the picker at / with no Up action.
	it("can go to the parent when the initial home directory is denied", async () => {
		serveTree({ "/": [dir("home")] }, "/home");
		const original = mockRpc.getMockImplementation()!;
		mockRpc.mockImplementation((command: string, args: Record<string, unknown>, id: string) =>
			command === "list_directory" && args.repoPath === "/home"
				? Promise.reject(new HttpRpcError("list_directory", 500, '{"error":"Permission denied"}'))
				: original(command, args, id),
		);
		const view = open();
		await view.findByText("Permission denied");
		fireEvent.click(await view.findByText(".."));
		await view.findByText("home");
	});

	it("walks into a directory and confirms the path it is showing", async () => {
		serveTree({
			"/": [dir("home")],
			"/home": [dir("stefano")],
			"/home/stefano": [dir("Gits")],
		});
		const { findByText, onConfirm } = open();

		fireEvent.click(await findByText("home"));
		fireEvent.click(await findByText("stefano"));
		await findByText("Gits");

		fireEvent.click(await findByText("Add This Folder"));
		// The confirmed value is the absolute path *on the remote machine*, which is
		// the only spelling `get_repo_info` can resolve there.
		expect(onConfirm).toHaveBeenCalledWith("/home/stefano");
	});

	it("goes back up without leaving the machine's root", async () => {
		serveTree({ "/": [dir("home")], "/home": [dir("stefano")] });
		const { findByText, queryByText } = open();

		// At the root there is nothing above: no ".." row to click into a path the
		// daemon cannot resolve.
		await findByText("home");
		expect(queryByText("..")).toBeNull();

		fireEvent.click(await findByText("home"));
		fireEvent.click(await findByText(".."));
		await findByText("home");
		expect(queryByText("..")).toBeNull();
	});

	it("reports the daemon's own failure instead of an empty folder", async () => {
		serveTree({ "/": [dir("home")] });
		const { findByText, container } = open();

		await findByText("home");
		const input = container.querySelector("input") as HTMLInputElement;
		fireEvent.input(input, { target: { value: "/nope" } });
		fireEvent.keyDown(input, { key: "Enter" });

		// A path that is not there and a machine that stopped answering are
		// different failures; rewriting them into "no subfolders" hides both.
		await waitFor(() => expect(container.textContent).toContain("Failed to resolve repo path: /nope"));
	});

	it("jumps to a typed path, because the field is an escape hatch and not a filter", async () => {
		serveTree({ "/": [dir("home")], "/home/stefano/Gits": [dir("tuicommander")] });
		const { findByText, container, onConfirm } = open();

		await findByText("home");
		const input = container.querySelector("input") as HTMLInputElement;
		fireEvent.input(input, { target: { value: "/home/stefano/Gits" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await findByText("tuicommander");
		fireEvent.click(await findByText("Add This Folder"));
		expect(onConfirm).toHaveBeenCalledWith("/home/stefano/Gits");
	});
});

// Catches: a browser picker routes the serving machine through a nonexistent remote connection.
describe("current-server repository picker", () => {
	it("browses server home, confirms a directory and cancels without registering", async () => {
		serveTree({ "/server-home": [dir("projects"), file("notes.txt")], "/server-home/projects": [] }, "/server-home");
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		const view = render(() => (
			<RemoteRepoPicker visible connectionName="tuic.test:9876" onConfirm={onConfirm} onClose={onClose} />
		));
		await view.findByText("projects");
		expect(view.queryByText("notes.txt")).toBeNull();
		expect(mockRpc).toHaveBeenCalledWith("get_home_directory", {}, "");
		expect(mockRpc).toHaveBeenCalledWith("list_directory", { repoPath: "/server-home", subdir: "" }, "");
		fireEvent.click(view.getByText("projects"));
		await waitFor(() => expect(view.getByRole("textbox")).toHaveValue("/server-home/projects"));
		fireEvent.click(view.getByText("Add This Folder"));
		expect(onConfirm).toHaveBeenCalledWith("/server-home/projects");
		fireEvent.click(view.getByText("Cancel"));
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});
});
