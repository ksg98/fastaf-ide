(() => {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 1;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	function rgba(value) {
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = value;
		ctx.fillRect(0, 0, 1, 1);
		return [...ctx.getImageData(0, 0, 1, 1).data];
	}
	const mix = (fg, bg, alpha) => fg.slice(0, 3).map((v, i) => v * alpha + bg[i] * (1 - alpha));
	function background(el) {
		if (!el) return [255, 255, 255];
		const own = rgba(getComputedStyle(el).backgroundColor);
		return mix(own, background(el.parentElement), own[3] / 255);
	}
	const lum = (rgb) => rgb.map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
		.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
	const rows = [];
	for (const selector of ['[class*="_agent_"]', '[class*="_badge_"][class*="_question_"]']) {
		const el = document.querySelector(selector);
		if (!el) throw new Error(`Missing ${selector}`);
		const style = getComputedStyle(el);
		for (const opacity of style.animationName === "none" ? [1] : [1, 0.5]) {
			const parent = background(el.parentElement);
			const bg = mix(background(el), parent, opacity);
			const fg = mix(rgba(style.color), parent, opacity);
			const luminances = [lum(fg), lum(bg)];
			rows.push({ text: el.textContent, color: style.color, background: style.backgroundColor,
				paintedBackground: bg, opacity, animation: style.animationName,
				ratio: (Math.max(...luminances) + 0.05) / (Math.min(...luminances) + 0.05) });
		}
	}
	return { theme: document.documentElement.dataset.theme, viewport: [innerWidth, innerHeight], rows };
})();
