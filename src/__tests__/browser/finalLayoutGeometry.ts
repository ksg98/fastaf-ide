/** Browser-mounted regression assertions for #2054-0eb2; invoke after the fixture has rendered. */
export function finalLayoutGeometry(page: string) {
	const failures: string[] = [];
	const measurements: Record<string, unknown> = {};
	const check = (condition: boolean, message: string) => {
		if (!condition) failures.push(message);
	};
	const required = <T extends HTMLElement>(selector: string): T => {
		const element = document.querySelector<T>(selector);
		if (!element) throw new Error(`Missing mounted element: ${selector}`);
		return element;
	};
	if (page === "remoteqr") {
		// Catches: native, unstyled Retry glued to the discovery error.
		const alert = required('[role="alert"]');
		const retry = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry");
		if (!retry) throw new Error("Missing Retry");
		const gap = retry.getBoundingClientRect().top - alert.getBoundingClientRect().bottom;
		const style = getComputedStyle(retry);
		measurements.retry = { gap, padding: style.padding, background: style.backgroundColor };
		check(Math.abs(gap - 8) <= 1, `Retry error gap is ${gap}px, expected 8px`);
		check(parseFloat(style.paddingLeft) >= 12, `Retry lacks shared button padding: ${style.paddingLeft}`);
		check(style.backgroundColor !== "rgba(0, 0, 0, 0)", "Retry lacks a themed button surface");
	}
	if (page === "tasks-detail") {
		// Catches: grid row stretching detaches short-field Save buttons from their controls.
		const fields = required('[aria-label="Task fields"]');
		const rows = [...fields.querySelectorAll("form")].map((form) => {
			const control = form.querySelector<HTMLElement>("input,select,textarea");
			const save = form.querySelector("button");
			if (!control || !save) throw new Error("Missing editable field or Save");
			const input = control.getBoundingClientRect();
			const button = save.getBoundingClientRect();
			return {
				name: control.getAttribute("aria-label"),
				bottomDelta: button.bottom - input.bottom,
				right: button.right,
				gap: button.left - input.right,
			};
		});
		measurements.fields = rows;
		check(rows.length >= 4, `Expected mixed-height fields, found ${rows.length}`);
		for (const row of rows) {
			check(Math.abs(row.bottomDelta) <= 1, `${row.name} Save is detached by ${row.bottomDelta}px`);
			check(row.right <= innerWidth - 12, `${row.name} Save reaches ${row.right}px at viewport ${innerWidth}`);
			check(row.gap >= 7, `${row.name} Save has no field gap`);
		}
	}
	if (page === "stories") {
		// Catches: wrapping workflow actions pull Close out of the title's top-right slot.
		const header = required('[role="dialog"] > header');
		const title = required('[role="dialog"] > header h2');
		const close = required('[aria-label="Close Plans and Stories"]');
		const headerBounds = header.getBoundingClientRect();
		const titleBounds = title.getBoundingClientRect();
		const closeBounds = close.getBoundingClientRect();
		const rightInset = parseFloat(getComputedStyle(header).paddingRight);
		measurements.close = {
			topDelta: closeBounds.top - titleBounds.top,
			rightInset: headerBounds.right - closeBounds.right,
			expectedRightInset: rightInset,
		};
		check(Math.abs(closeBounds.top - titleBounds.top) <= 1, "Stories Close leaves the title row");
		check(
			Math.abs(headerBounds.right - rightInset - closeBounds.right) <= 1,
			"Stories Close leaves the header right inset",
		);
	}
	if (page === "stories" && innerWidth <= 760) {
		// Catches: action chrome squeezes the repository into five lines and wraps New plan.
		const header = required('[role="dialog"] > header');
		const project = required('[role="dialog"] > header > div > span');
		const plan = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "New plan");
		if (!plan) throw new Error("Missing New plan");
		const range = document.createRange();
		range.selectNodeContents(plan);
		const projectHeight = project.getBoundingClientRect().height;
		const lines = range.getClientRects().length;
		measurements.stories = { headerHeight: header.getBoundingClientRect().height, projectHeight, newPlanLines: lines };
		check(projectHeight <= 20, `Repository path wraps to ${projectHeight}px`);
		check(lines === 1, `New plan wraps to ${lines} lines`);
	}
	if (page === "crash") {
		// Catches: crash fallback paints hard-coded dark surfaces over a light app theme.
		const root = required("#visual-root > div");
		const probe = document.createElement("div");
		probe.style.background = "var(--bg-primary)";
		document.body.append(probe);
		const expected = getComputedStyle(probe).backgroundColor;
		const actual = getComputedStyle(root).backgroundColor;
		probe.remove();
		measurements.crash = { expected, actual };
		check(actual === expected, `Crash surface ${actual} does not match theme ${expected}`);
	}
	return { page, viewport: [innerWidth, innerHeight], failures, measurements };
}
