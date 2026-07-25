import { appLogger } from "../stores/appLogger";
import { pluginStore } from "../stores/pluginStore";

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export function reportPluginCallbackError(pluginId: string | undefined, boundary: string, err: unknown): void {
	const id = pluginId ?? "unknown";
	const message = `${boundary} callback failed: ${errorMessage(err)}`;
	appLogger.error("plugin", `[${id}] ${message}`, err);
	if (pluginId) {
		pluginStore.getLogger(pluginId).error(message, err);
	}
}

export function guardPluginCallback<TArgs extends readonly unknown[]>(
	pluginId: string,
	boundary: string,
	callback: (...args: TArgs) => void,
): (...args: TArgs) => void {
	return (...args: TArgs) => {
		try {
			callback(...args);
		} catch (err) {
			reportPluginCallbackError(pluginId, boundary, err);
		}
	};
}

export function guardPluginAsyncCallback<TArgs extends readonly unknown[]>(
	pluginId: string,
	boundary: string,
	callback: (...args: TArgs) => void | Promise<void>,
): (...args: TArgs) => Promise<void> {
	return async (...args: TArgs) => {
		try {
			await callback(...args);
		} catch (err) {
			reportPluginCallbackError(pluginId, boundary, err);
		}
	};
}

export function guardPluginPredicate<TArgs extends readonly unknown[]>(
	pluginId: string,
	boundary: string,
	callback: ((...args: TArgs) => boolean) | undefined,
	fallback: boolean,
): ((...args: TArgs) => boolean) | undefined {
	if (!callback) return undefined;
	return (...args: TArgs) => {
		try {
			return callback(...args);
		} catch (err) {
			reportPluginCallbackError(pluginId, boundary, err);
			return fallback;
		}
	};
}
