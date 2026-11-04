/** The backend binds the plugin owner and config file; requests cannot supply either. */
export type PluginSettingsAction =
	| { action: "describe" }
	| { action: "get"; paths: string[] }
	| { action: "set"; path: string; value: unknown; expectedRevision: string }
	| { action: "reset"; path: string; expectedRevision: string }
	| {
			action: "patch";
			expectedRevision: string;
			operations: Array<{ op: "set"; path: string; value: unknown } | { op: "reset"; path: string }>;
	  };

export interface PluginSettingAnnotation {
	sensitivity: "public" | "private" | "secret";
	apply: "live" | "next_session" | "service_restart" | "app_restart";
	effect: string;
	operations: Array<"get" | "set" | "reset">;
	confirmationClass: "ordinary";
}

/** Closed schema subset enforced by Rust; opaque objects and arbitrary file paths are rejected. */
export interface PluginSettingsSchema {
	type: "object" | "array" | "string" | "boolean" | "integer" | "number";
	properties?: Record<string, PluginSettingsSchema>;
	additionalProperties?: false;
	required?: string[];
	items?: PluginSettingsSchema;
	enum?: Array<string | number | boolean>;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	title?: string;
	description?: string;
	default?: unknown;
	"x-setting"?: PluginSettingAnnotation;
}

export interface PluginSettingsDefinition {
	schema: PluginSettingsSchema;
	defaults: Record<string, unknown>;
}
