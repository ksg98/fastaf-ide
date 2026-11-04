/** Shared desktop/mobile availability: the host must name an ego executable. */
export function isAcpConfigured(egoExecutable: string | null | undefined): boolean {
	return (egoExecutable ?? "").trim().length > 0;
}
