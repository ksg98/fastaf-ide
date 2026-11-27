/** Native descriptor used by dialog mocks for the shared backend_status read. */
export const nativeBackendStatusReply = {
	type: "backend_status",
	value: {
		backend: "native",
		label: "FastAF native",
		provenance: "automatic",
		availability: "available",
		reason: "Plans and stories are stored in FastAF. Create a plan to begin.",
		installation: null,
		version: null,
		error: null,
	},
};
