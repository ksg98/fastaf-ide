import { invoke } from "../invoke";

// All frontend config writers share this queue. The backend API persists the
// complete AppConfig, so overlapping load-modify-save sequences would otherwise
// lose whichever writer saves first.
let configWriteTail: Promise<void> = Promise.resolve();

export function runSerializedConfigWrite<T>(write: () => Promise<T>): Promise<T> {
	const operation = configWriteTail.then(write);
	configWriteTail = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}

export function updateAppConfig<T extends object>(mutate: (config: T) => void): Promise<T> {
	return runSerializedConfigWrite(async () => {
		const loaded = await invoke<T>("load_config");
		const config = loaded ?? ({} as T);
		mutate(config);
		await invoke("save_config", { config });
		return config;
	});
}
