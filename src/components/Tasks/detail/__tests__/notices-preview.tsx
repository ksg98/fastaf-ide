/** Isolated visual fixture: real settings and notice service, captured IPC; no live backend. */
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import "../../../../global.css";
import "../../../../styles.css";
import { notifyPrTransition } from "../../../../services/prNativeNotifications";
import { uiStore } from "../../../../stores/ui";
import { NotificationsTab } from "../../../SettingsPanel/tabs/NotificationsTab";
import { TasksDetail } from "../TasksDetail";
import { detail, provider } from "./detailFixture";
import "./preview.css";

const [notice, setNotice] = createSignal<{ title: string; body: string }>();
Object.defineProperty(document, "hasFocus", { value: () => false });
Object.defineProperty(window.Notification, "requestPermission", { value: async () => "granted" });
(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
	invoke: async (command: string, args: Record<string, unknown>) => {
		if (command === "show_native_notification") {
			setNotice(args as { title: string; body: string });
			return;
		}
		if (command.includes("request_permission")) return "granted";
		if (command === "load_ui_prefs") return {};
		if (command === "compare_work_item_comments")
			return { snapshot: { latest: 1, ids: [], count: null }, notify: false };
		return null;
	},
};
await uiStore.hydrate();
function Preview() {
	return (
		<>
			<div class="fixture-controls">
				<button
					type="button"
					onClick={() =>
						notifyPrTransition({
							repoName: "example/app",
							prNumber: 42,
							title: "Repair login",
							type: "ci_failed",
							url: "https://github.com/example/app/pull/42",
							linkedItem: { ...detail().item, state: null },
						})
					}
				>
					Capture linked check notice
				</button>
			</div>
			<div style={{ display: "grid", "grid-template-columns": "1fr 1fr", overflow: "auto", height: "100%" }}>
				<NotificationsTab />
				<div>
					<TasksDetail provider={provider()} reference={detail().item.reference} />
					<Show when={notice()}>
						{(value) => (
							<section
								aria-label="Captured native notice"
								style={{ padding: "16px", background: "var(--bg-secondary)", border: "1px solid var(--border)" }}
							>
								<h3>{value().title}</h3>
								<p>{value().body}</p>
								<small>Captured native IPC payload — not a live OS notification</small>
							</section>
						)}
					</Show>
				</div>
			</div>
		</>
	);
}
const root = document.getElementById("root");
if (root) render(() => <Preview />, root);
