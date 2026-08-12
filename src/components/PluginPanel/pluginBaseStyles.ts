/**
 * Base CSS stylesheet injected into every plugin panel iframe.
 *
 * Provides a consistent foundation so plugins don't need to reinvent
 * typography, colors, buttons, inputs, cards, and tables. All values
 * use the CSS custom properties already injected by extractThemeVars().
 *
 * Plugins can override any of these styles — this is a default, not a cage.
 *
 * ─── IMPORTANT ────────────────────────────────────────────────────────
 * Iframes cannot `composes:` from the host stylesheet, so the button,
 * input, card, and toast values below are duplicated by hand from
 * src/components/shared/controls.module.css (and the .dash-stat top
 * sheen mirrors the dashboard sweep). When you touch either side of
 * this pair, update the other in the same commit — otherwise plugin
 * chrome drifts from the app-wide control vocabulary.
 * ──────────────────────────────────────────────────────────────────────
 */

export const PLUGIN_BASE_CSS = `
/* ── Reset ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* ── Root ── */
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Noto Sans, Liberation Sans, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg-primary, #ccc);
  background: var(--bg-primary, #1e1e1e);
  overflow-x: hidden;
}

/* ── Typography ── */
h1, h2, h3, h4, h5, h6 {
  color: var(--fg-primary, #ccc);
  font-weight: 600;
  line-height: 1.3;
}
h1 { font-size: 20px; margin-bottom: 12px; }
h2 { font-size: 17px; margin-bottom: 8px; }
h3 { font-size: 15px; margin-bottom: 6px; }
h4 { font-size: 13px; margin-bottom: 4px; }

p { margin-bottom: 8px; }
small { font-size: 11px; color: var(--fg-secondary, #a0a0a0); }
code {
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", monospace;
  font-size: 12px;
  background: var(--bg-tertiary, #2d2d30);
  padding: 1px 4px;
  border-radius: 3px;
}
a {
  color: var(--accent, #59a8dd);
  text-decoration: none;
}
a:hover {
  color: var(--accent-hover, #7abde5);
  text-decoration: underline;
}

/* ── Buttons ──
   Values mirror shared/controls.module.css .btn / .btnPrimary / .btnDanger.
   Iframes can't composes: — keep this block in sync when you touch
   controls.module.css. */
button, .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 26px;
  padding: 4px 12px;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  line-height: 1.2;
  color: var(--fg-secondary, #c2c2c2);
  background: var(--bg-tertiary, #202020);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s ease-out, color 0.1s ease-out,
    border-color 0.1s ease-out, box-shadow 0.1s ease-out;
}
button:hover:not(:disabled), .btn:hover:not(:disabled) {
  background: var(--bg-highlight, #282828);
  color: var(--fg-primary, #e0e0e0);
}
button:focus-visible, .btn:focus-visible {
  outline: none;
  border-color: var(--accent, #4c9df3);
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb, 76, 157, 243), 0.18);
}
button:active:not(:disabled), .btn:active:not(:disabled) {
  background: var(--bg-secondary, #1a1a1a);
}
button.primary, .btn-primary {
  background: var(--accent, #4c9df3);
  color: var(--text-on-accent, #ffffff);
  border-color: transparent;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
button.primary:hover:not(:disabled), .btn-primary:hover:not(:disabled) {
  background: var(--accent-hover, #66aefa);
  color: var(--text-on-accent, #ffffff);
}
button.danger, .btn-danger {
  background: transparent;
  color: var(--error, #ff5555);
  border-color: var(--error, #ff5555);
}
button.danger:hover:not(:disabled), .btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--error, #ff5555) 15%, transparent);
  color: var(--error, #ff5555);
  border-color: var(--error, #ff5555);
}
button:disabled, .btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── Inputs ──
   Mirrors shared/controls.module.css .input / .textarea / .select. */
input[type="text"], input[type="search"], input[type="number"],
input[type="email"], input[type="url"], input[type="password"],
textarea, select {
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
  color: var(--fg-primary, #e0e0e0);
  background: var(--bg-tertiary, #202020);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 6px;
  outline: none;
  transition: border-color 0.1s ease-out, box-shadow 0.1s ease-out;
}
input:focus, textarea:focus, select:focus {
  border-color: var(--accent, #4c9df3);
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb, 76, 157, 243), 0.18);
}
input::placeholder, textarea::placeholder {
  color: var(--fg-muted, #8c8c8c);
}

/* ── Checkboxes ── */
input[type="checkbox"] {
  accent-color: var(--accent, #59a8dd);
}

/* ── Cards ──
   Radius bumps to 10px and picks up the top-sheen gradient so plugin
   dashboards read like the built-in Cursor-style stat cards. */
.card {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, white 3%, var(--bg-secondary, #1a1a1a)),
    var(--bg-secondary, #1a1a1a)
  );
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  transition: box-shadow 0.15s ease-out, border-color 0.15s ease-out;
}
.card:hover {
  border-color: var(--border-strong, rgba(255,255,255,0.12));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 24px 64px rgba(0, 0, 0, 0.6);
}

/* ── Tables ── */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th {
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--fg-secondary, #a0a0a0);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border, #3e3e42);
}
td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border, #3e3e42);
  color: var(--fg-primary, #ccc);
}
tr:hover td {
  background: var(--bg-highlight, #37373d);
}

/* ── Badges ── */
.badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 3px;
  line-height: 1.5;
}
.badge-p1, .badge-error {
  background: var(--error, #ef4444);
  color: var(--text-on-error, #000);
}
.badge-p2, .badge-warning {
  background: var(--warning, #dcdcaa);
  color: var(--text-on-accent, #000);
}
.badge-p3, .badge-muted {
  background: var(--fg-muted, #9aa1a9);
  color: var(--text-on-accent, #000);
}
.badge-success {
  background: var(--success, #4ade80);
  color: var(--text-on-success, #000);
}
.badge-accent {
  background: var(--accent, #59a8dd);
  color: var(--text-on-accent, #000);
}

/* ── Labels ── */
label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-secondary, #a0a0a0);
  margin-bottom: 4px;
}
.hint {
  font-size: 11px;
  color: var(--fg-muted, #9aa1a9);
  margin-top: 2px;
}

/* ── Dividers ── */
hr {
  border: none;
  border-top: 1px solid var(--border, #3e3e42);
  margin: 12px 0;
}

/* ── Filter bar (common pattern) ── */
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #3e3e42);
  flex-shrink: 0;
}

/* ── Empty state ── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  color: var(--fg-muted, #9aa1a9);
  font-size: 14px;
  text-align: center;
}
.empty-state .hint {
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.7;
}

/* ── Toast notifications ──
   Glass pill styling — collapses to opaque when vibrancy is off. */
.toast {
  position: fixed;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-primary, #e0e0e0);
  background: var(--surface-overlay, var(--bg-tertiary, #202020));
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 24px 64px rgba(0, 0, 0, 0.6);
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
  z-index: 100;
}
.toast.show { opacity: 1; }
.toast.error {
  background: var(--error, #ef4444);
  color: var(--text-on-error, #000);
}
.toast.success {
  background: var(--success, #4ade80);
  color: var(--text-on-success, #000);
}

/* ── Scrollbar styling ── */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--border, #3e3e42);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--fg-muted, #9aa1a9);
}

/* ────────────────────────────────────────────────────────────────── */
/* Dashboard layout — matches the built-in Claude Usage dashboard.    */
/* Plugins that render analytics/status views should use these        */
/* classes instead of inventing inline styles. See docs/plugins-style */
/* .md for the full guide and do/don'ts.                              */
/* ────────────────────────────────────────────────────────────────── */

/* Root container — apply to the outermost element of a dashboard. */
.dashboard {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 16px 20px;
  gap: 16px;
}

/* Top bar with title + optional controls (refresh, scope selector). */
.dash-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dash-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--fg-primary, #ccc);
  margin: 0;
}
.dash-subtitle {
  font-size: 11px;
  color: var(--fg-muted, #9aa1a9);
  margin-top: 2px;
}

/* Section — logical group inside a dashboard. Stack with gap 16px. */
.dash-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dash-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-muted, #9aa1a9);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.dash-section-hint {
  font-weight: 400;
  font-size: 11px;
  text-transform: none;
  letter-spacing: normal;
  opacity: 0.6;
}

/* Stat grid — auto-fill cards for headline numbers. */
.dash-stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}
.dash-stat {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, white 3%, var(--bg-secondary, #1a1a1a)),
    var(--bg-secondary, #1a1a1a)
  );
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
.dash-stat-label {
  font-size: 10px;
  color: var(--fg-muted, #9aa1a9);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.dash-stat-value {
  font-size: 22px;
  font-weight: 600;
  color: var(--fg-primary, #ccc);
  font-variant-numeric: tabular-nums;
}
.dash-stat-sub {
  font-size: 11px;
  color: var(--fg-secondary, #a0a0a0);
}

/* Progress meter inside a stat card. */
.dash-meter {
  height: 4px;
  background: var(--bg-tertiary, #2d2d30);
  border-radius: 2px;
  overflow: hidden;
}
.dash-meter-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
  background: var(--accent, #59a8dd);
}
.dash-meter-fill.ok { background: var(--success, #4ade80); }
.dash-meter-fill.warn { background: var(--warning, #dcdcaa); }
.dash-meter-fill.critical { background: var(--error, #ef4444); }

/* Card — generic container (tables, config blocks, etc.).
   Overrides the default .card padding for dashboard-scale layouts. */
.dashboard .card {
  padding: 12px 14px;
}

/* Dashboard-scoped table tweaks: smaller header, hover row highlight. */
.dashboard table th {
  font-size: 10px;
  padding: 6px 8px;
}
.dashboard table td {
  padding: 6px 8px;
  font-size: 12px;
}
.dashboard .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
`;
