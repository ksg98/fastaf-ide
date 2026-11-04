import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockListen, locales } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
	mockListen: vi.fn().mockResolvedValue(vi.fn()),
	/** Only `en.json` ships today, so the real list would hide the picker. The
	 * picker tests offer a second locale with no catalog; `t()` stays real. */
	locales: ["en", "it"],
}));

vi.mock("../../i18n", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../i18n")>()),
	AVAILABLE_LOCALES: locales,
}));

vi.mock("../../invoke", () => ({
	invoke: mockInvoke,
	listen: mockListen,
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GeneralTab } from "../../components/SettingsPanel/tabs/GeneralTab";
import { AVAILABLE_LOCALES, locale, localeName, setLocale, t } from "../../i18n";
import { settingsStore } from "../../stores/settings";

/** The picker, found through its rendered label so it cannot be confused with
 * the other selects the tab renders (IDE, update channel). */
function languageSelect(container: HTMLElement): HTMLSelectElement {
	const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent === "Language");
	const select = label?.htmlFor ? container.querySelector(`#${label.htmlFor}`) : null;
	if (!select) throw new Error("language select not found");
	return select as HTMLSelectElement;
}

/** A string the picker must retranslate.
 *
 * Why this exists at all: `en.json` is generated from the call sites, so every
 * catalog value equals its inline fallback byte-for-byte. Switching the locale
 * therefore cannot change what an ordinary `t()` site renders — the two sides
 * `t()` chooses between hold the same text — and a test that picked a real UI
 * string could only ever assert that nothing moved. The probe breaks that tie
 * by pairing a key that IS in `en.json` with a fallback that is deliberately
 * not the English text, so the rendered value names which side `t()` resolved
 * from: the fallback means "no catalog for this locale", "Shell" means "read
 * from `en.json`". That is what makes the switch observable in the DOM.
 *
 * The mismatch is safe: `i18nKeyCollisions.test.ts` skips `src/__tests__`, so
 * this fallback is never read as a UI string competing with the real one. */
const Probe = () => <span data-testid="probe">{t("general.label.shell", "UNTRANSLATED FALLBACK")}</span>;

/** Resolve every command the tab's onMount may issue so nothing rejects. */
function invokeImpl(config: Record<string, unknown> = {}) {
	return (cmd: string) => {
		if (cmd === "load_config") return Promise.resolve({ ...config });
		return Promise.resolve(undefined);
	};
}

describe("GeneralTab language picker", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockImplementation(invokeImpl());
		mockListen.mockResolvedValue(vi.fn());
	});

	afterEach(() => {
		cleanup();
		locales.splice(0, locales.length, "en", "it");
		setLocale("en");
		vi.useRealTimers();
	});

	it("hides the picker while only one locale is available", () => {
		locales.splice(0, locales.length, "en");
		const { container } = render(() => <GeneralTab />);
		const labels = Array.from(container.querySelectorAll("label")).map((el) => el.textContent);
		expect(labels).not.toContain("Language");
		// Non-vacuity: the tab rendered, so the absence above is meaningful.
		const headings = Array.from(container.querySelectorAll("h3")).map((el) => el.textContent);
		expect(headings).toContain("Confirmations");
	});

	it("offers one option per locale that has a catalog", () => {
		const { container } = render(() => <GeneralTab />);
		const values = Array.from(languageSelect(container).options).map((o) => o.value);
		expect(values).toEqual([...AVAILABLE_LOCALES]);
		expect(values).toContain("en");
	});

	it("names each locale in its own language", () => {
		const { container } = render(() => <GeneralTab />);
		const labels = Array.from(languageSelect(container).options).map((o) => o.textContent);
		expect(labels).toEqual(AVAILABLE_LOCALES.map((code) => localeName(code)));
		expect(labels).toContain("English");
	});

	it("shows the locale the config was loaded with", async () => {
		mockInvoke.mockImplementation(invokeImpl({ language: "en" }));
		await settingsStore.hydrate();
		const { container } = render(() => <GeneralTab />);
		expect(languageSelect(container).value).toBe("en");
	});

	it("retranslates a rendered string when a locale is picked", async () => {
		// Start on a locale with no catalog, so every t() renders its fallback.
		// This is a real state, not a contrivance: config.json keeps whatever
		// language it was last saved with, including one whose catalog is gone.
		mockInvoke.mockImplementation(invokeImpl({ language: "zz" }));
		await settingsStore.hydrate();

		const { container, getByTestId } = render(() => (
			<>
				<GeneralTab />
				<Probe />
			</>
		));
		expect(locale()).toBe("zz");
		expect(getByTestId("probe").textContent).toBe("UNTRANSLATED FALLBACK");

		fireEvent.change(languageSelect(container), { target: { value: "en" } });

		await waitFor(() => expect(getByTestId("probe").textContent).toBe("Shell"));
		expect(locale()).toBe("en");
	});

	it("persists the picked locale through the config save", async () => {
		vi.useFakeTimers();
		mockInvoke.mockImplementation(invokeImpl({ language: "zz" }));
		await settingsStore.hydrate();

		const { container } = render(() => <GeneralTab />);
		mockInvoke.mockClear();
		fireEvent.change(languageSelect(container), { target: { value: "en" } });

		// The store debounces its writes, so nothing is saved until the timer runs.
		expect(mockInvoke.mock.calls.filter(([cmd]) => cmd === "save_config")).toEqual([]);
		await vi.advanceTimersByTimeAsync(600);

		const saved = mockInvoke.mock.calls.filter(([cmd]) => cmd === "save_config");
		expect(saved).toHaveLength(1);
		expect((saved[0][1] as { config: { language: string } }).config.language).toBe("en");
	});
});

// FastAF's AI Chat runs on its built-in engine, so General carries none of
// upstream's ego fields (profile, AI Chat workspace).
describe("GeneralTab without ego fields", () => {
	beforeEach(() => {
		mockInvoke.mockImplementation(invokeImpl());
	});

	afterEach(() => {
		settingsStore._testCancelPendingSave();
		cleanup();
	});

	it("renders no ego profile or AI Chat workspace field", () => {
		const { container } = render(() => <GeneralTab />);
		const labels = Array.from(container.querySelectorAll("label")).map((el) => el.textContent);
		expect(labels).not.toContain("ego profile");
		expect(labels).not.toContain("AI Chat workspace");
	});
});
