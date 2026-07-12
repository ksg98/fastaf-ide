import { describe, expect, it } from "vitest";
import type { DiscoveredProject, DiscoveredSession } from "../../components/ImportDialog";
import { MAX_IMPORTED_SESSIONS, toSavedTerminals } from "../../utils/importSessions";

function session(overrides: Partial<DiscoveredSession> = {}): DiscoveredSession {
	return {
		id: "af467730-5e79-49d9-8a17-ebd94c99f262",
		path: "/Users/k/.claude/projects/x/session.jsonl",
		title: "fix the bug",
		agent: "claude",
		modifiedMs: 1000,
		...overrides,
	};
}

function project(sessions: DiscoveredSession[]): DiscoveredProject {
	return {
		path: "/Users/k/repo",
		name: "repo",
		agents: ["claude"],
		sessionCount: sessions.length,
		lastActiveMs: sessions[0]?.modifiedMs ?? 0,
		alreadyImported: false,
		sessions,
	};
}

describe("toSavedTerminals", () => {
	it("maps a session to a SavedTerminal with resume fields", () => {
		const result = toSavedTerminals(project([session()]), 13);
		expect(result).toEqual([
			{
				name: "fix the bug",
				cwd: "/Users/k/repo",
				fontSize: 13,
				agentType: "claude",
				agentSessionId: "af467730-5e79-49d9-8a17-ebd94c99f262",
				tuicSession: null,
				agentLaunchCommand: null,
			},
		]);
	});

	it("caps at MAX_IMPORTED_SESSIONS newest sessions", () => {
		const sessions = Array.from({ length: 5 }, (_, i) => session({ id: `id-${i}`, modifiedMs: 5000 - i }));
		const result = toSavedTerminals(project(sessions), 13);
		expect(result).toHaveLength(MAX_IMPORTED_SESSIONS);
		// Sessions arrive newest-first — the first 3 are kept
		expect(result.map((t) => t.agentSessionId)).toEqual(["id-0", "id-1", "id-2"]);
	});

	it("filters out non-resumable agents (cursor, superset)", () => {
		const sessions = [
			session({ id: "c1", agent: "cursor" }),
			session({ id: "k1", agent: "claude" }),
			session({ id: "s1", agent: "superset" }),
			session({ id: "x1", agent: "codex" }),
		];
		const result = toSavedTerminals(project(sessions), 13);
		expect(result.map((t) => t.agentType)).toEqual(["claude", "codex"]);
	});

	it("falls back to the project name when the session has no title", () => {
		const result = toSavedTerminals(project([session({ title: "" })]), 13);
		expect(result[0].name).toBe("repo");
	});

	it("uses the provided default font size", () => {
		const result = toSavedTerminals(project([session()]), 18);
		expect(result[0].fontSize).toBe(18);
	});
});
