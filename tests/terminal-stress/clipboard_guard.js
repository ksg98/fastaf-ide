(() => {
	"use strict";

	const state = {
		version: 1,
		installedAt: Date.now(),
		events: [],
	};

	const record = (method, value) => {
		state.events.push({
			method,
			value: typeof value === "string" ? value : null,
			itemCount: Array.isArray(value) ? value.length : null,
			timestamp: Date.now(),
			stack: new Error("clipboard guard capture").stack ?? "",
		});
	};

	const blockedWriteText = async (text) => {
		record("navigator.clipboard.writeText", String(text));
	};
	const blockedWrite = async (items) => {
		record("navigator.clipboard.write", Array.from(items ?? []));
	};
	const guardedExecCommand = function guardedExecCommand(command, ...args) {
		const normalized = String(command).toLowerCase();
		if (normalized === "copy" || normalized === "cut") {
			record(`document.execCommand(${normalized})`, null);
			return true;
		}
		return originalExecCommand?.call(this, command, ...args) ?? false;
	};

	const define = (target, property, value) => {
		if (!target) return;
		try {
			Object.defineProperty(target, property, {
				configurable: false,
				enumerable: true,
				writable: false,
				value,
			});
		} catch {
			// A browser may expose a non-configurable own property. Its prototype is
			// patched separately below, and install verification rejects any bypass.
		}
	};

	const clipboard = navigator.clipboard;
	define(clipboard, "writeText", blockedWriteText);
	define(clipboard, "write", blockedWrite);
	if (globalThis.Clipboard?.prototype) {
		define(globalThis.Clipboard.prototype, "writeText", blockedWriteText);
		define(globalThis.Clipboard.prototype, "write", blockedWrite);
	}

	const originalExecCommand = Document.prototype.execCommand;
	define(Document.prototype, "execCommand", guardedExecCommand);

	for (const type of ["copy", "cut"]) {
		addEventListener(
			type,
			(event) => {
				event.preventDefault();
				event.stopImmediatePropagation();
				record(`${type}-event`, null);
			},
			{ capture: true },
		);
	}

	state.assertInstalled = () => {
		const prototype = globalThis.Clipboard?.prototype;
		if (
			navigator.clipboard?.writeText !== blockedWriteText ||
			navigator.clipboard?.write !== blockedWrite ||
			prototype?.writeText !== blockedWriteText ||
			prototype?.write !== blockedWrite ||
			Document.prototype.execCommand !== guardedExecCommand
		) {
			throw new Error("clipboard guard installation mismatch");
		}
		return true;
	};

	Object.defineProperty(globalThis, "__tuicClipboardGuard", {
		configurable: false,
		enumerable: false,
		writable: false,
		value: state,
	});
})();
