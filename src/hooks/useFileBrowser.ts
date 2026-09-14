import { invoke } from "../invoke";
import { appLogger } from "../stores/appLogger";
import type { ContentSearchBatch, DirEntry } from "../types/fs";
import { listenContentSearch, newContentSearchId, startContentSearch } from "../utils/contentSearch";

export interface ContentSearchOptions {
	caseSensitive?: boolean;
	useRegex?: boolean;
	wholeWord?: boolean;
	limit?: number;
}

/** Hook wrapping Rust fs commands for the file browser */
export function useFileBrowser() {
	async function listDirectory(repoPath: string, subdir: string): Promise<DirEntry[]> {
		return await invoke<DirEntry[]>("list_directory", { repoPath, subdir });
	}

	async function searchFiles(repoPath: string, query: string, limit?: number): Promise<DirEntry[]> {
		return await invoke<DirEntry[]>("search_files", { repoPath, query, limit: limit ?? 200 });
	}

	async function readFile(repoPath: string, file: string): Promise<string> {
		return await invoke<string>("fs_read_file", { repoPath, file });
	}

	async function writeFile(repoPath: string, file: string, content: string): Promise<void> {
		await invoke("write_file", { repoPath, file, content });
	}

	/** Create a new empty file (VS Code "New File"). Creates parent dirs as needed
	 *  and fails if the file already exists (never truncates). */
	async function createFile(repoPath: string, file: string): Promise<void> {
		await invoke("create_file", { repoPath, file });
	}

	async function createDirectory(repoPath: string, dir: string): Promise<void> {
		await invoke("create_directory", { repoPath, dir });
	}

	async function deletePath(repoPath: string, path: string): Promise<void> {
		await invoke("delete_path", { repoPath, path });
	}

	async function renamePath(repoPath: string, from: string, to: string): Promise<void> {
		await invoke("rename_path", { repoPath, from, to });
	}

	async function copyPath(repoPath: string, from: string, to: string): Promise<void> {
		await invoke("copy_path", { repoPath, from, to });
	}

	/** Copy a file by absolute paths — supports pasting across different repos. */
	async function copyPathAbs(from: string, to: string): Promise<void> {
		await invoke("copy_path_abs", { from, to });
	}

	/** Move a file by absolute paths — supports cut+paste across different repos. */
	async function movePathAbs(from: string, to: string): Promise<void> {
		await invoke("move_path_abs", { from, to });
	}

	async function addToGitignore(repoPath: string, pattern: string): Promise<void> {
		await invoke("add_to_gitignore", { repoPath, pattern });
	}

	/**
	 * Start a streaming content search and subscribe to its results.
	 *
	 * Subscribing and starting are one call because the two must share a
	 * correlation id: `content-search-batch` is a global event and the command
	 * palette, the file browser and the markdown panel all listen to it, so a
	 * subscription that is not tied to a specific search collects other panels'
	 * matches. The returned function unsubscribes.
	 *
	 * Resolves once the subscription exists, NOT once the search finishes. Over
	 * HTTP the command answers inline, so awaiting it would withhold the
	 * unsubscribe hook for the whole search — a panel closed or a query retyped
	 * meanwhile could not cancel, and its handler would fire into a disposed
	 * component. A failure to start is reported through `onError`, the same path
	 * a backend search error takes.
	 */
	async function searchContent(
		repoPath: string,
		query: string,
		handlers: { onBatch: (batch: ContentSearchBatch) => void; onError?: (message: string) => void },
		opts?: ContentSearchOptions,
	): Promise<() => void> {
		const searchId = newContentSearchId();
		const unlisten = await listenContentSearch(searchId, handlers);
		startContentSearch(
			"search_content",
			{
				repoPath,
				query,
				caseSensitive: opts?.caseSensitive ?? false,
				useRegex: opts?.useRegex ?? false,
				wholeWord: opts?.wholeWord ?? false,
				limit: opts?.limit,
			},
			searchId,
		).catch((e) => {
			const message = e instanceof Error ? e.message : String(e);
			appLogger.error("files", "content search failed to start", { repoPath, message });
			handlers.onError?.(message);
		});
		return unlisten;
	}

	return {
		listDirectory,
		searchFiles,
		readFile,
		writeFile,
		createFile,
		createDirectory,
		deletePath,
		renamePath,
		copyPath,
		copyPathAbs,
		movePathAbs,
		addToGitignore,
		searchContent,
	};
}
