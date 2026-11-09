import { describe, expect, it } from "vitest";
import { env } from "@reactive-resume/env/server";
import { auth, OAUTH_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS } from "./config";

describe("social provider signup policy", () => {
	it.each(["google", "github", "linkedin"] as const)(
		"allows implicit signup through %s while honoring the global signup restriction",
		(provider) => {
			// Better Auth 1.7 allows a lazy `() => config` form; ours are always static objects.
			const config = auth.options.socialProviders?.[provider];
			if (typeof config === "function") throw new TypeError(`${provider} provider config should be a static object`);

			expect(config).not.toHaveProperty("disableImplicitSignUp");
			expect(config?.disableSignUp).toBe(env.FLAG_DISABLE_SIGNUPS);
		},
	);
});

describe("session freshness", () => {
	it("disables the freshness gate so provider unlinking works for week-old sessions", () => {
		expect(auth.options.session?.freshAge).toBe(0);
	});
});

describe("oauth provider refresh rotation", () => {
	it("replays a lost refresh response instead of revoking the grant", () => {
		const plugin = auth.options.plugins?.find((p) => p.id === "oauth-provider") as
			| { options?: { refreshTokenReuseInterval?: number } }
			| undefined;

		expect(plugin?.options?.refreshTokenReuseInterval).toBe(OAUTH_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS);
		expect(OAUTH_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS).toBeGreaterThan(0);
	});
});
