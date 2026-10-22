/** Convert a git remote URL (SSH or HTTPS) to a GitHub web URL, or null if not GitHub. */
export function remoteUrlToGitHub(remoteUrl: string): string | null {
	// SSH: git@github.com:owner/repo.git
	const sshMatch = remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/);
	if (sshMatch) return `https://github.com/${sshMatch[1]}`;
	// HTTPS: https://github.com/owner/repo.git
	const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/);
	if (httpsMatch) return `https://github.com/${httpsMatch[1]}`;
	return null;
}
