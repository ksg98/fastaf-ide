/**
 * Disclosure chevron: points right when collapsed, down when expanded. The
 * caller rotates it via CSS (`transform: rotate(90deg)` on an `expanded`
 * class). One glyph and one size for every collapsible header, so groups,
 * repos, branches and panel sections line up in the sidebar.
 */
export const ChevronIcon = () => (
	<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
		<path d="M5.7 13.7l-.7-.7L9.3 8 5 3.7l.7-.7L10.7 8z" />
	</svg>
);
