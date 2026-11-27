import type { JSX } from "solid-js";
import { type Component, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { cx } from "../../utils";
import { SearchField } from "../shared/SearchField";
import s from "./Dropdown.module.css";

export interface DropdownItem {
	id: string;
	label: string;
	icon?: JSX.Element;
	divider?: boolean;
	disabled?: boolean;
}

export interface DropdownProps {
	items: DropdownItem[];
	/** Enables an in-menu text filter with this accessible label. */
	searchLabel?: string;
	/** Plain words shown in the empty filter ("Search time zones"). */
	searchPlaceholder?: string;
	selected?: string;
	visible: boolean;
	onSelect: (id: string) => void;
	onClose: () => void;
	position?: "top" | "bottom";
	class?: string;
	/** Portals a viewport-clamped menu beside this trigger. */
	anchor?: () => DOMRect | undefined;
	/** Names the menu for assistive technology. */
	"aria-label"?: string;
}

/** Gap between an anchored menu and its trigger, and its margin to the viewport edge. */
const GAP = 4;
const EDGE = 8;
/** Under this much room on both sides of the trigger an anchored menu may cover it. */
const MIN_ROOM = 120;

export const Dropdown: Component<DropdownProps> = (props) => {
	let dropdownRef: HTMLDivElement | undefined;
	let searchRef: HTMLInputElement | undefined;
	const [query, setQuery] = createSignal("");
	const filteredItems = () =>
		props.items.filter((item) => !props.searchLabel || item.label.toLowerCase().includes(query().toLowerCase()));
	const [placement, setPlacement] = createSignal<JSX.CSSProperties>();
	// The side an anchored menu opened on. Chosen when it opens and when the window
	// is resized, then kept: a filter that shortens the list must not make the menu,
	// and the field being typed in, jump to the other side of the trigger.
	let opensUpward: boolean | undefined;
	createEffect(() => {
		if (!props.visible) opensUpward = undefined;
	});
	createEffect(() => {
		if (!props.visible || !props.anchor) return;
		// A filter changes the menu's height; a menu that opened upward is placed from
		// that height, so it is placed again whenever the list changes.
		void filteredItems().length;
		const place = (chooseSide = false) => {
			const anchor = props.anchor?.();
			if (!anchor || !dropdownRef) return;
			const viewport = window.visualViewport;
			const left = viewport?.offsetLeft ?? 0;
			const top = viewport?.offsetTop ?? 0;
			const width = viewport?.width ?? window.innerWidth;
			const height = viewport?.height ?? window.innerHeight;
			const menu = dropdownRef.getBoundingClientRect();
			const cap = Math.max(0, Math.min(height - 2 * EDGE, props.searchLabel ? 360 : height - 2 * EDGE));
			// What the menu would measure with no cap: its content plus its border, or the
			// box it is drawn in when that is all there is to measure.
			const content = dropdownRef.scrollHeight + dropdownRef.offsetHeight - dropdownRef.clientHeight;
			const natural = Math.min(Math.max(content, menu.height), cap);
			const below = top + height - EDGE - (anchor.bottom + GAP);
			const above = anchor.top - GAP - (top + EDGE);
			// The asked-for side while the menu fits there, else the other side, else the
			// roomier one with the menu cut to that room. It never lands on its own trigger.
			const wantTop = props.position === "top";
			if (opensUpward === undefined || chooseSide) {
				opensUpward =
					(wantTop ? above : below) >= natural
						? wantTop
						: (wantTop ? below : above) >= natural
							? !wantTop
							: above > below;
			}
			const openTop = opensUpward;
			const room = Math.max(0, openTop ? above : below);
			const x = `${Math.max(left + EDGE, Math.min(anchor.right - menu.width, left + width - menu.width - EDGE))}px`;
			const common = {
				position: "fixed",
				// The unanchored menu's 4px offset is a margin; here GAP is the whole offset.
				margin: "0",
				"min-width": "0",
				right: "auto",
				left: x,
				"max-width": `${Math.max(0, width - 2 * EDGE)}px`,
				"overflow-y": "auto",
			} as const;
			if (room < Math.min(natural, MIN_ROOM)) {
				// No usable room on either side (a window a few rows tall): cover the trigger
				// rather than open a menu too short to read.
				const desiredTop = wantTop ? anchor.top - natural - GAP : anchor.bottom + GAP;
				setPlacement({
					...common,
					bottom: "auto",
					top: `${Math.max(top + EDGE, Math.min(desiredTop, top + height - natural - EDGE))}px`,
					"max-height": `${cap}px`,
				});
				return;
			}
			// Always `left` and `top` (callers and tests read them): opening upward, the top
			// is the trigger's top less the height the menu will be drawn at.
			const maxHeight = Math.min(cap, room);
			const shown = Math.min(natural, maxHeight);
			setPlacement({
				...common,
				bottom: "auto",
				top: `${openTop ? anchor.top - GAP - shown : Math.max(top + EDGE, anchor.bottom + GAP)}px`,
				"max-height": `${maxHeight}px`,
			});
		};
		const follow = () => place();
		const resized = () => place(true);
		queueMicrotask(follow);
		window.addEventListener("resize", resized);
		window.addEventListener("scroll", follow, true);
		window.visualViewport?.addEventListener("resize", resized);
		onCleanup(() => {
			window.removeEventListener("resize", resized);
			window.removeEventListener("scroll", follow, true);
			window.visualViewport?.removeEventListener("resize", resized);
		});
	});

	const enabledItems = () =>
		dropdownRef ? [...dropdownRef.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')] : [];

	// Focus moves into the menu when it opens, so keys act on it.
	createEffect(() => {
		if (props.visible) {
			setQuery("");
			queueMicrotask(() => (searchRef ?? enabledItems()[0])?.focus());
		}
	});

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			// Handled here so hosts that stop work on Escape never see it.
			e.preventDefault();
			e.stopPropagation();
			props.onClose();
			return;
		}
		const items = enabledItems();
		if (!items.length) return;
		const current = items.indexOf(document.activeElement as HTMLElement);
		const target =
			e.key === "ArrowDown"
				? items[(current + 1) % items.length]
				: e.key === "ArrowUp"
					? items[(current <= 0 ? items.length : current) - 1]
					: e.key === "Home"
						? items[0]
						: e.key === "End"
							? items.at(-1)
							: undefined;
		if (target) {
			e.preventDefault();
			target.focus();
		} else if ((e.key === "Enter" || e.key === " ") && current >= 0) {
			e.preventDefault();
			items[current].click();
		}
	};

	// Close on click outside
	createEffect(() => {
		if (!props.visible) return;

		const handleClickOutside = (e: MouseEvent) => {
			if (dropdownRef && !dropdownRef.contains(e.target as Node)) {
				props.onClose();
			}
		};

		// Delay to avoid immediate close — use rAF instead of setTimeout
		// so cleanup can cancel the frame if the component unmounts before it fires
		let attached = false;
		const rafId = requestAnimationFrame(() => {
			document.addEventListener("click", handleClickOutside);
			attached = true;
		});

		onCleanup(() => {
			cancelAnimationFrame(rafId);
			if (attached) document.removeEventListener("click", handleClickOutside);
		});
	});

	// Close on Escape
	createEffect(() => {
		if (!props.visible) return;

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				props.onClose();
			}
		};

		document.addEventListener("keydown", handleEscape);

		onCleanup(() => {
			document.removeEventListener("keydown", handleEscape);
		});
	});

	const menu = () => (
		<Show when={props.visible}>
			<div
				ref={dropdownRef}
				style={props.anchor ? placement() : undefined}
				class={cx(s.dropdown, props.position === "top" && s.top, props.searchLabel && s.searchable, props.class)}
				role="menu"
				aria-label={props["aria-label"]}
				onKeyDown={handleKeyDown}
				data-testid="dropdown"
				data-position={props.position || "bottom"}
			>
				<Show when={props.searchLabel}>
					{/* The app's one inline filter (magnifier, clear button; Esc clears a
					    query first, a second Esc closes the menu). */}
					<div class={s.search}>
						<SearchField
							ref={(el) => {
								searchRef = el;
							}}
							aria-label={props.searchLabel}
							placeholder={props.searchPlaceholder ?? "Search"}
							value={query()}
							onInput={setQuery}
						/>
					</div>
				</Show>
				<For each={filteredItems()}>
					{(item) => (
						<Show when={!item.divider} fallback={<div class={s.divider} data-testid="dropdown-divider" />}>
							<div
								class={cx(s.item, item.id === props.selected && s.selected)}
								role="menuitem"
								tabindex="-1"
								aria-disabled={item.disabled || undefined}
								data-testid="dropdown-item"
								data-selected={item.id === props.selected || undefined}
								data-disabled={item.disabled || undefined}
								onClick={() => !item.disabled && props.onSelect(item.id)}
							>
								<Show when={item.icon}>
									<span class={s.itemIcon} data-testid="dropdown-item-icon">
										{item.icon}
									</span>
								</Show>
								<span class={s.itemLabel} data-testid="dropdown-item-label">
									{item.label}
								</span>
							</div>
						</Show>
					)}
				</For>
			</div>
		</Show>
	);
	return (
		<Show when={props.anchor} fallback={menu()}>
			<Portal>{menu()}</Portal>
		</Show>
	);
};
