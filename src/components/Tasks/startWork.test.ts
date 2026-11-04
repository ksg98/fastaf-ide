import { beforeEach, expect, it, vi } from "vitest";
import { detail, provider } from "./detail/__tests__/detailFixture";
import { useStartWork } from "./startWork";

const host = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
vi.mock("../../transport", () => ({ rpc }));
vi.mock("../../hooks/git/startWork", () => ({ startWork: host }));
beforeEach(() => {
	host.mockReset().mockResolvedValue({ branch: "task" });
	rpc.mockReset().mockResolvedValue("DEMO-1: Safe[201~title\n\nA **clear** description.");
});

// Catches: Tasks bypassing the backend brief builder and passing raw item controls to the provider.
it("passes_backend_brief_instead_of_raw_item_text_to_provider", async () => {
	const value = detail();
	value.item.title = "Safe\u001b[201~\rtitle";
	let prompt = "";
	const source = provider({
		act: async (_ref, action) => {
			if (action.kind !== "start_work") throw new Error("wrong action");
			prompt = action.value.prompt;
			return { kind: "start_work", value: action.value };
		},
	});
	await useStartWork().run(source, value, "/repo");
	expect(prompt).toBe("DEMO-1: Safe[201~title\n\n" + value.body);
});

// Catches: template read failures being ignored and starting a worktree with a misleading brief.
it("template_failure_prevents_provider_action_and_surfaces_error", async () => {
	rpc.mockRejectedValueOnce(new Error("Access denied: file is outside repository"));
	const act = vi.fn();
	const state = useStartWork();
	await state.run(provider({ act }), detail(), "/repo");
	expect(act).not.toHaveBeenCalled();
	expect(host).not.toHaveBeenCalled();
	expect(state.failure()).toBe("Access denied: file is outside repository");
	expect(state.pending()).toBe(false);
});

// Catches: a slow template read permitting duplicate worktree requests.
it("template_read_is_pending_and_blocks_duplicate_start", async () => {
	let finish: (text: string) => void = () => {};
	rpc.mockReturnValueOnce(
		new Promise<string>((resolve) => {
			finish = resolve;
		}),
	);
	const source = provider({
		act: async (_ref, action) => {
			if (action.kind !== "start_work") throw new Error("wrong action");
			return { kind: "start_work", value: action.value };
		},
	});
	const state = useStartWork();
	const running = state.run(source, detail(), "/repo");
	expect(state.pending()).toBe(true);
	await state.run(source, detail(), "/repo");
	finish("Template brief");
	await running;
	expect(host).toHaveBeenCalledTimes(1);
	expect(host).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Template brief" }));
});
