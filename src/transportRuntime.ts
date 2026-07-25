export interface TransportLogger {
	debug(source: "network", message: string, data?: unknown): void;
	warn(source: "network", message: string, data?: unknown): void;
}

const noopLogger: TransportLogger = {
	debug() {},
	warn() {},
};

let logger: TransportLogger = noopLogger;
let remoteBaseUrlLookup: (connectionId: string) => string | undefined = () => undefined;

export function setTransportLogger(nextLogger: TransportLogger): void {
	logger = nextLogger;
}

export function setRemoteBaseUrlLookup(lookup: (connectionId: string) => string | undefined): void {
	remoteBaseUrlLookup = lookup;
}

export function transportLogger(): TransportLogger {
	return logger;
}

export function getRemoteBaseUrl(connectionId: string): string | undefined {
	return remoteBaseUrlLookup(connectionId);
}

const LOG_PAYLOAD_PREVIEW = 500;

export function previewLogPayload(value: string): string {
	return value.length > LOG_PAYLOAD_PREVIEW ? `${value.slice(0, LOG_PAYLOAD_PREVIEW)}...` : value;
}
