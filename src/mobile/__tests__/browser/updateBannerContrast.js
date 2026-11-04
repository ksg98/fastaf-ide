// Open /src/mobile/__tests__/browser/updateBanner.html through worktree Vite.
// Run agent-browser eval --stdin with this file at a 390x844 viewport.
// Catches: Commander overriding the banner foreground to low-contrast white.
(async () => {
	const luminance = (rgb) => rgb
		.map((v) => v / 255)
		.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
		.reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
	const rows = [];
	for (const theme of ["commander", "vscode-light"]) {
		window.setBannerTheme(theme);
		const banner = document.querySelector('[class*="updateBanner"]');
		const style = getComputedStyle(banner);
		const colors = [style.color, style.backgroundColor]
			.map((value) => luminance(value.match(/[\d.]+/g).slice(0, 3).map(Number)));
		const ratio = (Math.max(...colors) + 0.05) / (Math.min(...colors) + 0.05);
		rows.push({
			theme, color: style.color, background: style.backgroundColor, ratio,
			opacity: style.opacity, filter: style.filter, backgroundImage: style.backgroundImage,
		});
	}
	if (rows.some((row) => row.ratio < 4.5)) throw new Error(JSON.stringify(rows));
	return { webdriver: navigator.webdriver, viewport: [innerWidth, innerHeight], rows, pass: true };
})();
