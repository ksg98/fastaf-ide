import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

const script = (name: string) => readFileSync(`browser-extension/design-mode/${name}`, "utf8");

// Catches: a page that throws, rejects, logs console.error or 404s a script reaching the worker unrecorded,
// and the bridge dropping records (dedup and the cap belong to the worker's addError).
it("forwards every page failure kind, including recurring ones", async () => {
	const sendMessage = vi.fn(async (_message: { error: Record<string, unknown> }) => {});
	// happy-dom reports a different window object as the message source; deliver as a browser does.
	vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
		window.dispatchEvent(new MessageEvent("message", { data, source: window }));
	});
	const originalError = console.error;
	console.error = vi.fn();
	new Function(script("errors.js"))();
	new Function("chrome", script("errorsBridge.js"))({ runtime: { sendMessage } });
	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	window.dispatchEvent(
		new ErrorEvent("error", { message: "x is not defined", filename: "http://localhost/app.js", lineno: 7, colno: 3 }),
	);
	const rejection = new Event("unhandledrejection");
	Object.assign(rejection, { reason: new Error("rejected") });
	window.dispatchEvent(rejection);
	console.error("logged", { a: 1 });
	const broken = document.createElement("img");
	broken.src = "http://localhost/missing.js";
	document.body.append(broken);
	broken.dispatchEvent(new Event("error"));
	window.dispatchEvent(new ErrorEvent("error", { message: "x is not defined", filename: "http://localhost/app.js" }));
	await settle();
	console.error = originalError;

	const sent = sendMessage.mock.calls.map(([m]) => m.error);
	expect(sent.find((e) => e.kind === "error")).toMatchObject({
		message: "x is not defined",
		source: "http://localhost/app.js",
		line: 7,
		column: 3,
	});
	expect(sent.find((e) => e.kind === "unhandledrejection")).toMatchObject({ message: "rejected" });
	expect(sent.find((e) => e.kind === "console.error")).toMatchObject({ message: 'logged {"a":1}' });
	expect(sent.find((e) => e.kind === "resource")).toMatchObject({ source: "http://localhost/missing.js" });
	expect(sent.filter((e) => e.message === "x is not defined")).toHaveLength(2);
});

// Catches: a long-lived dev page (HMR, no reload) that has produced 50 distinct errors never reporting a 51st,
// because the bridge kept its own cap instead of leaving the cap to the worker.
it("keeps forwarding new distinct errors after fifty", async () => {
	const sendMessage = vi.fn(async (_message: { error: Record<string, unknown> }) => {});
	vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
		window.dispatchEvent(new MessageEvent("message", { data, source: window }));
	});
	new Function(script("errors.js"))();
	new Function("chrome", script("errorsBridge.js"))({ runtime: { sendMessage } });

	for (let n = 0; n < 51; n++) {
		window.dispatchEvent(new ErrorEvent("error", { message: `e${n}`, filename: "http://localhost/app.js" }));
	}
	await new Promise((resolve) => setTimeout(resolve, 20));

	expect(sendMessage.mock.calls.map(([m]) => m.error.message)).toContain("e50");
});
