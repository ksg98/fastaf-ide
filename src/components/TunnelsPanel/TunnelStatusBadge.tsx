import type { Component } from "solid-js";
import type { TunnelStatus } from "../../stores/tunnels";

const STATUS_COLORS: Record<string, string> = {
	starting: "var(--fg-warning, #e5a100)",
	connected: "var(--accent-green, #22c55e)",
	reconnecting: "var(--fg-warning, #e5a100)",
	stopped: "var(--fg-muted)",
	error: "var(--accent-red, #ef4444)",
};

export const TunnelStatusBadge: Component<{ status?: TunnelStatus }> = (props) => {
	const color = () => (props.status ? (STATUS_COLORS[props.status.type] ?? "var(--fg-muted)") : "var(--fg-muted)");
	const label = () => {
		if (!props.status) return "stopped";
		if (props.status.type === "reconnecting") return `reconnecting (#${props.status.attempt})`;
		return props.status.type;
	};

	return (
		<span style={{ display: "inline-flex", "align-items": "center", gap: "5px", "font-size": "11px" }}>
			<span
				style={{
					width: "7px",
					height: "7px",
					"border-radius": "50%",
					background: color(),
					"flex-shrink": "0",
				}}
			/>
			<span style={{ color: "var(--fg-secondary)" }}>{label()}</span>
		</span>
	);
};
