import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../mocks/tauri";

vi.mock("../../stores/repositories", () => ({
	repositoriesStore: {
		getActive: vi.fn(() => ({ path: "/Users/dev/projects/current-repo" })),
	},
}));

import { CloneRepoDialog } from "../../components/CloneRepoDialog";

const REPOS = [
	{
		full_name: "octocat/hello",
		clone_url: "https://github.com/octocat/hello.git",
		ssh_url: "git@github.com:octocat/hello.git",
		private: true,
		description: "demo repo",
		pushed_at: "2026-07-01T00:00:00Z",
	},
	{
		full_name: "octocat/world",
		clone_url: "https://github.com/octocat/world.git",
		ssh_url: "git@github.com:octocat/world.git",
		private: false,
		description: null,
		pushed_at: null,
	},
];

/** Route mockInvoke by command name */
function routeInvoke(overrides: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
	mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
		if (overrides[cmd]) {
			return Promise.resolve(overrides[cmd](args));
		}
		switch (cmd) {
			case "github_auth_status":
				return Promise.resolve({ authenticated: true, login: "octocat" });
			case "github_list_user_repos":
				return Promise.resolve(REPOS);
			case "github_clone_repo":
				return Promise.resolve("/Users/dev/projects/hello");
			default:
				return Promise.resolve(undefined);
		}
	});
}

describe("CloneRepoDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		routeInvoke();
	});

	it("renders nothing when not visible", () => {
		const { container } = render(() => (
			<CloneRepoDialog visible={false} onClose={() => {}} onCloned={() => {}} />
		));
		expect(container.textContent).toBe("");
	});

	it("defaults destination to the active repo's parent folder", async () => {
		const { getByPlaceholderText } = render(() => (
			<CloneRepoDialog visible={true} onClose={() => {}} onCloned={() => {}} />
		));
		await waitFor(() => {
			const dest = getByPlaceholderText("Destination folder") as HTMLInputElement;
			expect(dest.value).toBe("/Users/dev/projects");
		});
	});

	it("lists repositories when authenticated and fills URL on row click", async () => {
		const { getByText, getByPlaceholderText } = render(() => (
			<CloneRepoDialog visible={true} onClose={() => {}} onCloned={() => {}} />
		));
		await waitFor(() => {
			expect(getByText("octocat/hello")).toBeTruthy();
			expect(getByText("octocat/world")).toBeTruthy();
		});
		// Private badge only on the private repo
		expect(getByText("private")).toBeTruthy();

		fireEvent.click(getByText("octocat/hello"));
		const url = getByPlaceholderText("https://github.com/owner/repo or owner/repo") as HTMLInputElement;
		expect(url.value).toBe("https://github.com/octocat/hello.git");
	});

	it("filters the repository list", async () => {
		const { getByText, queryByText, getByPlaceholderText } = render(() => (
			<CloneRepoDialog visible={true} onClose={() => {}} onCloned={() => {}} />
		));
		await waitFor(() => expect(getByText("octocat/hello")).toBeTruthy());

		fireEvent.input(getByPlaceholderText("Filter repositories…"), { target: { value: "world" } });
		expect(queryByText("octocat/hello")).toBeNull();
		expect(getByText("octocat/world")).toBeTruthy();
	});

	it("shows connect hint when not authenticated (no repo fetch)", async () => {
		routeInvoke({ github_auth_status: () => ({ authenticated: false }) });
		const { getByText } = render(() => (
			<CloneRepoDialog visible={true} onClose={() => {}} onCloned={() => {}} />
		));
		await waitFor(() => {
			expect(getByText(/Connect GitHub in Settings/)).toBeTruthy();
		});
		expect(mockInvoke).not.toHaveBeenCalledWith("github_list_user_repos", undefined);
	});

	it("clones with url + destDir and reports the new path", async () => {
		const onCloned = vi.fn();
		const onClose = vi.fn();
		const { getByText, getByPlaceholderText } = render(() => (
			<CloneRepoDialog visible={true} onClose={onClose} onCloned={onCloned} />
		));
		await waitFor(() => expect(getByText("octocat/hello")).toBeTruthy());

		fireEvent.input(getByPlaceholderText("https://github.com/owner/repo or owner/repo"), {
			target: { value: "octocat/hello" },
		});
		fireEvent.click(getByText("Clone"));

		await waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith("github_clone_repo", {
				url: "octocat/hello",
				destDir: "/Users/dev/projects",
			});
			expect(onCloned).toHaveBeenCalledWith("/Users/dev/projects/hello");
			expect(onClose).toHaveBeenCalled();
		});
	});

	it("shows the error and stays open when clone fails", async () => {
		routeInvoke({
			github_clone_repo: () => {
				throw new Error("Destination already exists: /x");
			},
		});
		const onCloned = vi.fn();
		const { getByText, getByPlaceholderText } = render(() => (
			<CloneRepoDialog visible={true} onClose={() => {}} onCloned={onCloned} />
		));
		await waitFor(() => expect(getByText("octocat/hello")).toBeTruthy());

		fireEvent.input(getByPlaceholderText("https://github.com/owner/repo or owner/repo"), {
			target: { value: "octocat/hello" },
		});
		fireEvent.click(getByText("Clone"));

		await waitFor(() => {
			expect(getByText(/Destination already exists/)).toBeTruthy();
		});
		expect(onCloned).not.toHaveBeenCalled();
	});

	it("disables Clone until both url and destination are set", async () => {
		routeInvoke({ github_auth_status: () => ({ authenticated: false }) });
		const { getByText, getByPlaceholderText } = render(() => (
			<CloneRepoDialog visible={true} onClose={() => {}} onCloned={() => {}} />
		));
		const cloneBtn = getByText("Clone") as HTMLButtonElement;
		expect(cloneBtn.disabled).toBe(true);

		fireEvent.input(getByPlaceholderText("https://github.com/owner/repo or owner/repo"), {
			target: { value: "octocat/hello" },
		});
		await waitFor(() => expect(cloneBtn.disabled).toBe(false));

		fireEvent.input(getByPlaceholderText("Destination folder"), { target: { value: "  " } });
		expect(cloneBtn.disabled).toBe(true);
	});
});
