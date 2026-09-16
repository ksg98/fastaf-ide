import { type Component, createSignal, onMount, Show } from "solid-js";
import { appLogger } from "../../../stores/appLogger";
import { chatgptAuthStore } from "../../../stores/chatgptAuth";
import { writeClipboard } from "../../../utils/clipboard";
import { handleOpenUrl } from "../../../utils/openUrl";
import s from "../Settings.module.css";
import c from "./ChatGptSignIn.module.css";

/** "Plus" from "plus", "Team" from "team" — the plan as ChatGPT names it. */
function planLabel(plan: string | null): string {
	return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "";
}

/**
 * The account row on a ChatGPT provider card: sign in (browser, or a code to
 * type when the callback port is taken), who is signed in, sign out. The
 * sign-in itself runs in Rust; this only shows its state.
 */
export const ChatGptSignIn: Component = () => {
	const auth = chatgptAuthStore;
	const status = () => auth.state.status;
	const [copied, setCopied] = createSignal(false);

	onMount(() => void auth.refresh());

	async function copyCode(code: string) {
		try {
			await writeClipboard(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (e) {
			appLogger.warn("settings", `Could not copy the ChatGPT sign-in code: ${String(e)}`);
		}
	}

	async function signIn() {
		const prompt = await auth.startLogin();
		if (!prompt) return;
		if (prompt.code) await copyCode(prompt.code);
		handleOpenUrl(prompt.url);
	}

	return (
		<div class={c.account} data-testid="chatgpt-sign-in">
			<Show when={status().error}>
				<div class={c.error} data-testid="chatgpt-error">
					{status().error}
				</div>
			</Show>

			<Show
				when={status().pending}
				fallback={
					<Show
						when={status().signed_in}
						fallback={
							<>
								<div class={s.passwordRow}>
									<button
										class={s.saveBtn}
										data-testid="chatgpt-sign-in-btn"
										onClick={signIn}
										disabled={auth.state.busy}
									>
										{auth.state.busy ? "Starting…" : "Sign in with ChatGPT"}
									</button>
								</div>
								<div class={s.hint}>
									Uses your ChatGPT Plus, Pro or Team plan instead of an API key. Calls count against that plan's
									limits.
								</div>
							</>
						}
					>
						<div class={s.passwordRow}>
							<span class={c.who} data-testid="chatgpt-account">
								Signed in as {status().email ?? "your ChatGPT account"}
								<Show when={status().plan}>
									<span class={s.hintInline}> · {planLabel(status().plan)}</span>
								</Show>
							</span>
							<button
								class={s.testBtn}
								data-testid="chatgpt-sign-out-btn"
								onClick={() => void auth.logout()}
								disabled={auth.state.busy}
							>
								Sign out
							</button>
						</div>
					</Show>
				}
			>
				{(prompt) => (
					<div data-testid="chatgpt-pending">
						<Show when={prompt().code} fallback={<div class={c.label}>Finish signing in in your browser…</div>}>
							{(code) => (
								<>
									<div class={c.label}>Enter this code on the OpenAI page:</div>
									<div class={c.code} data-testid="chatgpt-code">
										{code()}
									</div>
								</>
							)}
						</Show>
						<div class={s.passwordRow}>
							<Show when={prompt().code}>
								{(code) => (
									<button class={s.testBtn} onClick={() => void copyCode(code())}>
										{copied() ? "Copied" : "Copy code"}
									</button>
								)}
							</Show>
							<button class={s.testBtn} data-testid="chatgpt-open-page" onClick={() => handleOpenUrl(prompt().url)}>
								Open sign-in page
							</button>
							<button class={s.testBtn} data-testid="chatgpt-cancel-btn" onClick={() => void auth.cancelLogin()}>
								Cancel
							</button>
						</div>
					</div>
				)}
			</Show>
		</div>
	);
};
