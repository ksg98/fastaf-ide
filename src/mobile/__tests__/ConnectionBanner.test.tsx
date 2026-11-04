// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionBanner } from "../components/ConnectionBanner";

afterEach(cleanup);

describe("ConnectionBanner", () => {
	// Plausible bug: a lost server shows nothing actionable, only a raw error string.
	it("offers a retry when the server is unreachable", () => {
		const onRetry = vi.fn();
		const { getByText } = render(() => <ConnectionBanner offline authError={false} onRetry={onRetry} />);
		fireEvent.click(getByText("Retry now"));
		expect(onRetry).toHaveBeenCalledOnce();
	});

	// Plausible bug: 401/403 is treated as an outage, so the user retries forever instead of signing in.
	it("links to sign-in on an auth error, without a retry button", () => {
		const { getByText, queryByText } = render(() => <ConnectionBanner offline authError onRetry={() => {}} />);
		expect(getByText("Sign in").getAttribute("href")).toContain("/mobile/login?next=");
		expect(queryByText("Retry now")).toBeNull();
	});

	it("renders nothing while connected", () => {
		const { container } = render(() => <ConnectionBanner offline={false} authError={false} onRetry={() => {}} />);
		expect(container.textContent).toBe("");
	});
});
