import type { Accessor, Setter } from "solid-js";
import { invoke } from "../../invoke";
import { activityStore } from "../../stores/activityStore";
import { appLogger } from "../../stores/appLogger";
import { notificationsStore } from "../../stores/notifications";
import { repositoriesStore } from "../../stores/repositories";
import { tasksStore } from "../../stores/tasks";
import { terminalsStore } from "../../stores/terminals";
import { reportActionError } from "../../utils/reportActionError";
import { getShellFamily, sendCommand } from "../../utils/sendCommand";

interface BackgroundGitRunnerDeps {
	setStatusInfo: (message: string) => void;
	runningGitOps: Accessor<Set<string>>;
	setRunningGitOps: Setter<Set<string>>;
}

/** Runs the sidebar's Pull/Push in the background with task tracking and notifications. */
export function createBackgroundGitRunner(deps: BackgroundGitRunnerDeps) {
	const { setStatusInfo, runningGitOps, setRunningGitOps } = deps;

	/** Patterns in stderr that indicate the command needs interactive terminal input */
	const NEEDS_TERMINAL_PATTERNS = [
		/terminal prompts disabled/i, // GIT_TERMINAL_PROMPT=0 rejection
		/could not read Username/i, // HTTP credential prompt blocked
		/could not read Password/i,
		/Permission denied.*publickey/i, // SSH auth failed (askpass cancelled/missing)
		/Host key verification failed/i,
		/Please make sure you have the correct access rights/i,
	];

	/** Fall back to running a git command in the active terminal */
	const fallbackToTerminal = async (repoPath: string, args: string[]) => {
		const active = terminalsStore.getActive();
		const sessionId = active?.sessionId;
		if (!sessionId) return;
		const cmd = `cd ${JSON.stringify(repoPath)} && git ${args.join(" ")}`;
		// Route through sendCommand (never raw text+\r) so the Enter registers
		// even when the active terminal is an Ink-based agent in raw mode.
		const agentType = terminalsStore.getAgentTypeForSession(sessionId);
		const shellFamily = await getShellFamily(sessionId);
		try {
			await sendCommand(
				(data) => invoke("write_pty", { sessionId, data }),
				cmd,
				agentType,
				shellFamily,
				true,
				sessionId,
			);
			setStatusInfo(`git ${args[0]} requires auth — running in terminal`);
		} catch (err) {
			appLogger.error(
				"network",
				`git fallback to terminal failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	/** Run a git command in the background via Rust, with task tracking and notifications.
	 *  Falls back to terminal if the command needs interactive authentication. */
	const handleBackgroundGit = async (repoPath: string, op: string, args: string[]) => {
		// Prevent duplicate runs of the same op
		if (runningGitOps().has(op)) return;
		setRunningGitOps((prev) => new Set([...prev, op]));

		const taskId = tasksStore.create({
			name: `git ${op}`,
			description: `Running git ${args.join(" ")} in ${repoPath}`,
			agentType: "git",
		});
		tasksStore.start(taskId, `git-${op}-${Date.now()}`);
		setStatusInfo(`Running git ${op}...`);

		try {
			const result = await invoke("run_git_command", { path: repoPath, args });
			const { success, stdout, stderr } = result as {
				success: boolean;
				stdout: string;
				stderr: string;
				exit_code: number;
			};

			if (success) {
				tasksStore.complete(taskId, 0);
				repositoriesStore.bumpRevision(repoPath);
				// Show meaningful output: prefer stderr (git progress goes there), fall back to stdout
				const output = (stderr.trim() || stdout.trim()).split("\n").pop()?.trim();
				const summary = output ? `git ${op}: ${output}` : `git ${op} completed`;
				setStatusInfo(summary);
				appLogger.info("app", `[Notify] completion — git ${op} succeeded`);
				notificationsStore.playCompletion();
				activityStore.addItem({
					id: `git-${op}-${Date.now()}`,
					pluginId: "core",
					sectionId: "git-ops",
					title: `git ${op}`,
					subtitle: output || "completed",
					icon: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm3.78 5.97l-4.5 4.5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06L6.75 8.88l3.97-3.97a.75.75 0 1 1 1.06 1.06z"/></svg>',
					severity: "success",
					repoPath,
					dismissible: true,
				});
			} else if (NEEDS_TERMINAL_PATTERNS.some((p) => p.test(stderr))) {
				// Auth or interactive prompt needed — cancel background task, run in terminal
				tasksStore.cancel(taskId);
				void fallbackToTerminal(repoPath, args);
			} else {
				const errMsg = stderr.trim() || `git ${op} failed`;
				tasksStore.fail(taskId, errMsg);
				reportActionError(setStatusInfo, `git ${op} failed: ${errMsg}`);
				appLogger.info("app", `[Notify] error — git ${op} failed: ${errMsg}`);
				notificationsStore.playError();
				activityStore.addItem({
					id: `git-${op}-${Date.now()}`,
					pluginId: "core",
					sectionId: "git-ops",
					title: `git ${op} failed`,
					subtitle: errMsg,
					icon: '<svg viewBox="0 0 16 16" width="14" height="14" fill="#f85149"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm3.36 10.3a.75.75 0 0 1-1.06 1.06L8 9.06l-2.3 2.3a.75.75 0 0 1-1.06-1.06L6.94 8 4.64 5.7a.75.75 0 0 1 1.06-1.06L8 6.94l2.3-2.3a.75.75 0 0 1 1.06 1.06L9.06 8l2.3 2.3z"/></svg>',
					severity: "error",
					repoPath,
					dismissible: true,
				});
			}
		} catch (err) {
			tasksStore.fail(taskId, String(err));
			reportActionError(setStatusInfo, `git ${op} error: ${err}`);
			appLogger.info("app", `[Notify] error — git ${op} exception: ${err}`);
			notificationsStore.playError();
		} finally {
			setRunningGitOps((prev) => {
				const next = new Set(prev);
				next.delete(op);
				return next;
			});
		}
	};

	return handleBackgroundGit;
}
