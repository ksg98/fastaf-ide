/** Semver 2.0.0 precedence: returns -1, 0, or 1.
 *  A leading "v" and "+build" metadata are ignored. A prerelease precedes its
 *  release (2.0.0-beta.1 < 2.0.0-beta.2 < 2.0.0); numeric identifiers compare
 *  numerically and precede alphanumeric ones. */
export function compareSemver(a: string, b: string): number {
	const parse = (v: string) => {
		const [core, ...pre] = v.replace(/^v/, "").replace(/\+.*$/, "").split("-");
		return { core: core.split(".").map(Number), pre: pre.length ? pre.join("-").split(".") : [] };
	};
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = Math.sign((pa.core[i] ?? 0) - (pb.core[i] ?? 0));
		if (d) return d;
	}
	// A release outranks any prerelease of the same core.
	if (!pa.pre.length || !pb.pre.length) return Math.sign(pb.pre.length - pa.pre.length);
	for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
		const x = pa.pre[i];
		const y = pb.pre[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const xNum = /^\d+$/.test(x);
		const yNum = /^\d+$/.test(y);
		if (xNum && yNum) {
			const d = Math.sign(Number(x) - Number(y));
			if (d) return d;
		} else if (xNum !== yNum) {
			return xNum ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

/** Precedence of two app versions. Like `compareSemver`, except that a nightly
 *  stamp (`scripts/patch-nightly-version.sh`: `<base>-nightly.<date>.t<time>`)
 *  ranks after its base: nightlies are built from main after `<base>` shipped,
 *  so 1.8.0-nightly.* is newer than 1.8.0 and older than 1.8.1, and a nightly of
 *  2.0.0-beta.1 is older than 2.0.0-beta.2. */
export function compareAppVersion(a: string, b: string): number {
	const base = (v: string) => v.replace(/-nightly\..*$/, "");
	const d = compareSemver(base(a), base(b));
	if (d) return d;
	const an = base(a) !== a;
	const bn = base(b) !== b;
	if (an !== bn) return an ? 1 : -1;
	return compareSemver(a, b);
}
