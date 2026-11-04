import QRCode from "qrcode";

/** Shared black-on-white rendering for reliable phone scanning. */
export function qrCodeDataUrl(url: string): Promise<string> {
	return QRCode.toDataURL(url, { width: 320, margin: 2, color: { dark: "#000000", light: "#ffffff" } });
}
