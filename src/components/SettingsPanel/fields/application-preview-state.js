import commander from "../../../../src-tauri/src/themes/commander.json";
import paper from "../../../../src-tauri/src/themes/vscode-light.json";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
const [state, setState] = createStore({
  language: "en",
 theme: "commander", font: "JetBrains Mono", defaultFontSize: 13, fontWeight: 400, cursorStyle: "bar", shell: "", copyOnSelect: true, osc52Clipboard: true, showBlockTimestamps: true, blockFoldingEnabled: true, showScrollbarMarks: true, scrollbackReflow: true, globalHotkey: "Super+Shift+Space", issueFilter: "assigned",
  showLastPrompt: true,
  closeBehavior: "ask",
  trayIcon: "background_only",
  hideDockIcon: true,
  confirmBeforeQuit: true,
  confirmBeforeClosingTab: true,
  preventSleepWhenBusy: false,
  standbyTimeoutMinutes: 5,
  indexStrategy: "active_and_switch",
  indexMemoryBudgetMb: 1024,
  attachmentMaxBytes: 26214400,
  webviewUnloadMinutes: 10,
  autoUpdateEnabled: true,
  deferUpdateRelaunch: true,
  eagerResumeAfterUpdate: true,
  updateChannel: "stable",
  egoExecutable: "/workspace/tools/ego",
  egoProfile: "coordinator",
  aiChatWorkspace: "/workspace/long-project-name/application-development",
  ide: "vscode",
  customLaunchers: [],
  experimentalFeaturesEnabled: false,
  splitTabMode: "separate",
  tabOrderingMode: "grouped-by-type",
  tabCyclingAllTypes: false,
  tabTreeEnabled: true,
  maxTabNameLength: 25,
  chatMuteIntermediateText: true
});
export const settingsStore = new Proxy({ state, isAgentEnabled: () => true, isAcpConfigured: () => !!state.egoExecutable }, { get(target, key) {
  if (key in target) return target[key];
  return (value) => {
    const field = key.slice(3);
    setState(field[0].toLowerCase() + field.slice(1), value);
  };
} });
export const IDE_NAMES = { vscode: "VS Code", cursor: "Cursor", none: "None" };
export const updaterStore = { state: { checking: false, downloading: false, available: false, version: null, error: null, unsupported: "Illustrative fixture: update status has not been checked." }, checkForUpdate: async () => {
} };
const [repoState, setRepoState] = createStore({ repositories: {}, groups: { work: { id: "work", name: "Work", color: "#4a9eff", collapsed: false, repoOrder: [] }, personal: { id: "personal", name: "Personal projects with a longer group name", color: "#a578d4", collapsed: false, repoOrder: [] } }, groupOrder: ["work", "personal"] });
export const repositoriesStore = { state: repoState, getAllReposOrdered: () => [], renameGroup: (id, name) => {
  if (Object.values(repoState.groups).some((g) => g.id !== id && g.name === name)) return false;
  setRepoState("groups", id, "name", name);
  return true;
}, setGroupColor: (id, color) => setRepoState("groups", id, "color", color), deleteGroup: (id) => setRepoState("groupOrder", (list) => list.filter((item) => item !== id)), createGroup: () => {
} };
const [notificationState, setNotificationState] = createStore({ isAvailable: true, autoToastCards: true, config: { enabled: true, volume: 0.5, audio_device: null, sounds: { question: true, error: true, completion: true, warning: true, info: false, attention: true }, silence_remote_completions: true, toasts_in_bell: true, pr_native_notifications: true } });
export const notificationsStore = { state: notificationState, setVolume: (v) => setNotificationState("config", "volume", v), setEnabled: (v) => setNotificationState("config", "enabled", v), setSoundEnabled: (k, v) => setNotificationState("config", "sounds", k, v), setAudioDevice: (v) => setNotificationState("config", "audio_device", v), setAutoToastCards: (v) => setNotificationState("autoToastCards", v), setSilenceRemoteCompletions: (v) => setNotificationState("config", "silence_remote_completions", v), setToastsInBell: (v) => setNotificationState("config", "toasts_in_bell", v), setPrNativeNotifications: (v) => setNotificationState("config", "pr_native_notifications", v), testSound: () => {
}, reset: () => {
} };
const [enabled, setEnabled] = createSignal(true);
export const transcriptPreferences = { enabled, setEnabled };
export const tasksNotifications = { enabled: () => false, setEnabled: () => {
} };
export const uiStore = { resetLayout: () => {
} };
export const appLogger = { error: () => {
}, warn: () => {
}, info: () => {
}, debug: () => {
} };
export const isTauri = () => true;
export const isMacOS = () => true;
export const openDialog = async () => null;
export const invoke = async (cmd, args) => {
 if (cmd === "settings_action") { const path = args.request.paths?.[0]; return { revision: "illustrative-only", values: { [path]: {stored: 10, effective: 10, source: "illustrative fixture"} } }; }
 return ({ get_home_directory: "/workspace",
 list_installed_mcp_integrations: [], get_agent_mcp_status: {supported:true,installed:false,config_path:null,shared_settings_file:false}, get_cli_status: { installed: true, path: "/usr/local/bin/tuic", version_match: true, auto_updatable: true }, mdkb_status: { available: true, connected: false, binaryPath: "/usr/local/bin/mdkb", version: "fixture" }, list_audio_output_devices: [{ name: "Illustrative speakers", is_default: true }] })[cmd];
};
export const settingsRefresh = { register: reader => { let active = true; void reader.read().then(snapshot => { if (active) reader.apply(snapshot); }); return () => { active = false; }; } };
export const reportSettingsConflicts = () => {};
export const ExpertSetting = (props) => props.children;

export const rpc=async(cmd)=>({
 github_auth_status: {authenticated: true, login: "illustrative-account", avatar_url: null, source: "oauth", scopes: "repo"},
 github_diagnostics: {circuit_breaker_open: false, circuit_breaker_status: "closed", repos_not_found: [], repos_monitored: 0},
 github_list_accounts: [], github_resolve_repos: {}, circleci_token_status: {configured: false, source: "none"}
})[cmd];
export const FONT_FAMILIES = {"JetBrains Mono": "monospace"};
export const githubStore = {setPrHideDrafts:()=>{},setIssueFilter:()=>{}};
const [defaults, setDefaults] = createStore({baseBranch:"automatic",copyIgnoredFiles:false,copyUntrackedFiles:false,setupScript:"npm install",runScript:"npm run dev",archiveScript:"",worktreeStorage:"sibling",promptOnCreate:true,deleteBranchOnRemove:true,autoArchiveMerged:false,archiveRetentionDays:0,orphanCleanup:"ask",orphanCleanupCountdownSeconds:10,prMergeStrategy:"squash",afterMerge:"archive",autoFetchIntervalMinutes:0,autoDeleteOnPrClose:"off"});
export const repoDefaultsStore = new Proxy({state: defaults}, {get(target,key){ if(key in target)return target[key]; return(value)=>{const field=key.slice(3);setDefaults(field[0].toLowerCase()+field.slice(1),value);}; }});
export const owningConnectionFor=()=>undefined;
export const listen=async()=>()=>{};
export const UiLegend=()=>"Visual reference: busy, idle, attention and error states (isolated fixture).";

export const DEFAULT_THEME = "codex-dark";

export const getThemeNames = () => ({"codex-dark":"Codex Dark", commander:"Commander", "vscode-light":"Paper"});
export const getTerminalTheme = () => (new URLSearchParams(location.search).get("theme") === "light" ? paper : commander).terminal;
