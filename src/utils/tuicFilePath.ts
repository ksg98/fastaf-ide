/**
 * Decode a tuic://open or tuic://edit pathname. The first slash is the URL
 * delimiter; additional leading slashes name one POSIX root, not a network host.
 * Keep this function self-contained: the iframe SDK injects its JavaScript body.
 */
export function parseTuicFilePath(pathname: string): string {
	const path = decodeURIComponent(pathname);
	return path.startsWith("//") ? path.replace(/^\/+/, "/") : path.replace(/^\//, "");
}
