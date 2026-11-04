import { buildHttpUrl } from "../transport";
import { getRemoteBaseUrl, getSessionConnection, withRemoteToken } from "../transportRuntime";

export interface AttachmentReceipt {
	path: string;
	size: number;
	notice?: string;
}

export async function uploadAttachment(
	file: File,
	target: { kind: "pty"; id: string } | { kind: "acp"; id: string; session: string },
): Promise<AttachmentReceipt> {
	const connection = target.kind === "pty" ? getSessionConnection(target.id) : undefined;
	const baseUrl = connection ? getRemoteBaseUrl(connection) : undefined;
	if (connection && !baseUrl) throw new Error("Remote session is not connected");
	const query = new URLSearchParams({ kind: target.kind, id: target.id, name: file.name });
	if (target.kind === "acp") query.set("session", target.session);
	const url = withRemoteToken(buildHttpUrl(`/attachments/upload?${query}`, baseUrl), connection);
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => null);
		const reason =
			typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
				? body.error
				: `Attachment upload failed (${response.status})`;
		throw new Error(reason);
	}
	const receipt: unknown = await response.json();
	if (
		typeof receipt !== "object" ||
		receipt === null ||
		!("path" in receipt) ||
		typeof receipt.path !== "string" ||
		!("size" in receipt) ||
		typeof receipt.size !== "number" ||
		!Number.isSafeInteger(receipt.size)
	) {
		throw new Error("Attachment server returned an invalid receipt");
	}
	return {
		path: receipt.path,
		size: receipt.size,
		notice: "notice" in receipt && typeof receipt.notice === "string" ? receipt.notice : undefined,
	};
}
