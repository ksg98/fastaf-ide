import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { Composer } from "../../components/AIChatPanel/Composer";
import { aiChatDraft } from "../../components/AIChatPanel/draft";
import { CommentOverlay } from "../../components/MarkdownTab/CommentOverlay";
import { ContentRenderer } from "../../components/ui/ContentRenderer";
import { ReviewableMarkdown } from "../../mobile/components/ReviewableMarkdown";
import "../../global.css";
import fileStyles from "../../mobile/screens/FilesScreen.module.css";
import mdStyles from "../../components/MarkdownTab/MarkdownTab.module.css";

// Browser-only visual fixture: real selection, source mapping, draft and composer;
// no ACP process, filesystem write or network is needed to stage a reference.
const mobile = new URLSearchParams(location.search).has("mobile");
if (mobile) await import("../../mobile/mobile.css");
const source = "# PR map\n\nSelect a row to discuss it.\n\n| Item | Decision |\n| --- | --- |\n| First | Repeated |\n| Second | **Repeated** |\n";
const session = "markdown-reference-visual";
const [chatOpen, setChatOpen] = createSignal(!mobile);
const [contentEl, setContentEl] = createSignal();
let sent = 0;
const chat = {
  phase: () => "live", sessionId: () => session, connectionId: () => "visual", busy: () => false,
  configOptions: () => [], capabilities: () => ({}), operatingRepo: () => "/repo", pinnedRepo: () => null,
  queuedPrompts: () => [], toggleRepoPin: () => {}, cancelQueued: async () => {},
  cancel: async () => {}, ensureStarted: async () => session, send: async () => { sent++; },
};
aiChatDraft.activate(session);
aiChatDraft.set("Please explain this decision.");
const reference = { source, path: "/repo/map.md", insert: (value) => {
  aiChatDraft.insertReference(session, value);
  setChatOpen(true);
} };
render(() => <main style={{ display: "flex", "flex-direction": mobile ? "column" : "row", gap: "24px", padding: "24px", height: "100dvh" }}>
  <section class={mobile ? fileStyles.markdownView : undefined} style={{ flex: "1", "min-width": "0" }}>
    <Show when={mobile} fallback={<div class={mdStyles.content} ref={setContentEl}><ContentRenderer content={source} commentableBlocks /></div>}>
      <ReviewableMarkdown content={source} imageSrc={value => value} onCheckboxToggle={() => {}}
        onSaveBlockComment={async () => false} onSaveInlineComment={async () => false} chatReference={reference} />
    </Show>
    <Show when={!mobile && contentEl()}><CommentOverlay contentRef={contentEl()} onSave={() => false} onDelete={() => false} chatReference={reference} /></Show>
  </section>
  <Show when={chatOpen()}><section style={{ width: mobile ? "100%" : "440px", "min-width": "0" }}><h2>AI Chat</h2><Composer chat={chat} mobileAttachments={mobile} /></section></Show>
</main>, document.getElementById("root"));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
await frame(); await frame();
const cell = document.querySelector("tbody tr:last-child td:last-child strong");
const range = document.createRange();
range.selectNodeContents(cell);
window.getSelection().removeAllRanges();
window.getSelection().addRange(range);
cell.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
document.dispatchEvent(new Event("selectionchange"));
await frame();
const action = document.querySelector('[aria-label="Send to AI Chat"]');
if (!action) throw new Error("Selection action missing");
if (new URLSearchParams(location.search).has("filled")) { action.click(); await frame(); await frame(); }
const result = document.createElement("pre");
result.id = "reference-result";
result.hidden = true;
result.textContent = JSON.stringify({ action: !!action, draft: aiChatDraft.text(), sent, focused: document.activeElement?.tagName === "TEXTAREA", overflow: document.documentElement.scrollWidth > innerWidth });
document.body.append(result);
