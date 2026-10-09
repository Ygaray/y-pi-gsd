import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Api, Model } from "@gsd/pi-ai";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import type { RateLimitStatusRef } from "./rate-limit-status-ref.ts";
import { createAgentSession } from "./sdk.ts";
import {
	buildClaudeAuthStatusInvocation,
	identityMatchesLogin,
	loginCandidates,
	mapDashboardQuotaPayload,
	parseClaudeAuthStatus,
	UsageDashboardPoller,
	type ExecFileLike,
	type FetchLike,
} from "./usage-dashboard-poller.ts";

const REAL_FETCH = globalThis.fetch;

before(() => {
	// Tripwire: no test in this file may reach the live dashboard through the global fetch.
	globalThis.fetch = (() => {
		throw new Error("live dashboard fetch attempted in a test");
	}) as unknown as typeof fetch;
});

after(() => {
	globalThis.fetch = REAL_FETCH;
});

const RESETS_5H = "2026-10-09T09:40:00.040863+00:00";
const RESETS_WEEKLY = "2026-10-15T16:00:00.040889+00:00";

function okPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema_version: 1,
		status: "ok",
		stale: false,
		age_s: 239,
		claude_org_uuid: "org-test-uuid",
		used_pct: 99,
		resets_at: "2030-01-01T00:00:00+00:00",
		windows: [
			{ name: "5h", used_pct: 8.0, resets_at: RESETS_5H, length_s: 18000, credit: false },
			{ name: "weekly", used_pct: 29.0, resets_at: RESETS_WEEKLY, length_s: 604800, credit: false },
			{ name: "iguana_necktie", used_pct: 0.0, resets_at: "2026-11-05T07:59:00+00:00", length_s: null, credit: true },
		],
		...overrides,
	};
}

function okResponse(payload: Record<string, unknown> = okPayload()): Response {
	return new Response(JSON.stringify(payload), { status: 200 });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function fakeExec(stdout: string): { impl: ExecFileLike; calls: Array<{ file: string; args: readonly string[] }> } {
	const calls: Array<{ file: string; args: readonly string[] }> = [];
	const impl: ExecFileLike = async (file, args) => {
		calls.push({ file, args });
		return { stdout };
	};
	return { impl, calls };
}

const LOGGED_IN = JSON.stringify({ loggedIn: true, orgId: "org-test-uuid", email: "me@example.test" });

function fakeFetch(
	respond: (call: number) => Promise<Response> | Response,
): { impl: FetchLike; calls: Array<{ url: string; headers: Record<string, string> }> } {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const impl: FetchLike = async (url, init) => {
		calls.push({ url, headers: init.headers });
		return respond(calls.length);
	};
	return { impl, calls };
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.ok(condition(), "condition never became true");
}

function claudeCodeModel(): Model<Api> {
	return {
		id: "claude-code-test-model",
		name: "claude-code Test Model",
		api: "openai-completions",
		provider: "claude-code",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

describe("usage dashboard poller (USAGE-01)", () => {
	test("USAGE-01 tracer: a claude-code session with a rate-limit listener shows the dashboard 5h and weekly windows through getRateLimitStatus with no SDK event", async () => {
		const tempDir = join(tmpdir(), `gsd-agent-core-usage-dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		try {
			const cwd = join(tempDir, "project");
			const agentDir = join(tempDir, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			const model = claudeCodeModel();
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			authStorage.setRuntimeApiKey(model.provider, "test-api-key");
			const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
			const exec = fakeExec(LOGGED_IN);
			const fetcher = fakeFetch(() => okResponse());
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				authStorage,
				modelRegistry,
				settingsManager: SettingsManager.create(cwd, agentDir),
				sessionManager: SessionManager.inMemory(cwd),
				usageDashboard: { fetchImpl: fetcher.impl, execFileImpl: exec.impl, env: {}, platform: "linux" },
			});
			try {
				assert.equal(session.getRateLimitStatus(), undefined);
				assert.equal(exec.calls.length, 0);
				assert.equal(fetcher.calls.length, 0);

				let notifications = 0;
				session.onRateLimitStatusChange(() => {
					notifications += 1;
				});
				await session._rateLimitFallbackProducer?.refresh();

				assert.deepEqual(session.getRateLimitStatus(), {
					session: { usedPercent: 8, resetsAtEpochSec: Math.round(Date.parse(RESETS_5H) / 1000) },
					weekly: { usedPercent: 29, resetsAtEpochSec: Math.round(Date.parse(RESETS_WEEKLY) / 1000) },
				});
				assert.equal(notifications, 1);
				assert.equal(exec.calls.length, 1);
				assert.deepEqual(exec.calls[0], { file: "claude", args: ["auth", "status", "--json"] });
				assert.equal(fetcher.calls.length, 1);
				assert.equal(fetcher.calls[0].url, "http://127.0.0.1:8820/api/quota/anthropic?login=org-test-uuid");
				assert.equal(fetcher.calls[0].headers.accept, "application/json");
				const ref = session._rateLimitStatusRef;
				assert.equal(ref?.meta?.session?.source, "dashboard");
				assert.equal(ref?.meta?.weekly?.source, "dashboard");
			} finally {
				session.dispose();
			}
		} finally {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("mapDashboardQuotaPayload accepts only schema_version 1, status ok, stale false and age_s 0..600", () => {
		const now = 1_800_000_000_000;
		assert.ok(mapDashboardQuotaPayload(okPayload(), now));
		assert.ok(mapDashboardQuotaPayload(okPayload({ age_s: 600 }), now));
		assert.ok(mapDashboardQuotaPayload(okPayload({ age_s: 0 }), now));
		for (const status of ["stale", "error", "pending", "auth_expired"]) {
			assert.equal(mapDashboardQuotaPayload(okPayload({ status }), now), null, `status ${status}`);
		}
		assert.equal(mapDashboardQuotaPayload(okPayload({ stale: true }), now), null);
		assert.equal(mapDashboardQuotaPayload(okPayload({ age_s: 601 }), now), null);
		assert.equal(mapDashboardQuotaPayload(okPayload({ age_s: -1 }), now), null);
		assert.equal(mapDashboardQuotaPayload(okPayload({ age_s: null }), now), null);
		assert.equal(mapDashboardQuotaPayload(okPayload({ age_s: Number.NaN }), now), null);
		assert.equal(mapDashboardQuotaPayload(okPayload({ schema_version: 2 }), now), null);
		assert.equal(mapDashboardQuotaPayload(okPayload({ windows: undefined }), now), null);
		assert.equal(mapDashboardQuotaPayload("ok", now), null);
		assert.equal(mapDashboardQuotaPayload(null, now), null);
		assert.equal(mapDashboardQuotaPayload([okPayload()], now), null);
	});

	test("mapDashboardQuotaPayload maps 5h and weekly non-credit windows by name and ignores credit meters, weekly-model windows and the top-level binding window", () => {
		const now = 1_800_000_000_000;
		const reading = mapDashboardQuotaPayload(okPayload(), now);
		assert.equal(reading?.session?.usedPercent, 8);
		assert.equal(reading?.weekly?.usedPercent, 29);

		const noisy = mapDashboardQuotaPayload(
			okPayload({
				windows: [
					{ name: "weekly-opus", used_pct: 77, resets_at: RESETS_WEEKLY, credit: false },
					{ name: "5h", used_pct: 55, resets_at: RESETS_5H, credit: true },
					{ name: "5h", used_pct: 8, resets_at: RESETS_5H, credit: false },
				],
			}),
			now,
		);
		assert.equal(noisy?.session?.usedPercent, 8);
		assert.equal(noisy?.weekly, null);
		assert.equal(reading?.observedAtMs, now - 239 * 1000);
	});

	test("mapDashboardQuotaPayload clamps, keeps precision and never manufactures a zero", () => {
		const now = 1_800_000_000_000;
		const one = (window: Record<string, unknown>) =>
			mapDashboardQuotaPayload(okPayload({ windows: [{ name: "5h", credit: false, ...window }] }), now)?.session;
		assert.equal(one({ used_pct: -0.5, resets_at: RESETS_5H })?.usedPercent, 0);
		assert.equal(one({ used_pct: 100.5, resets_at: RESETS_5H })?.usedPercent, 100);
		assert.equal(one({ used_pct: 8.25, resets_at: RESETS_5H })?.usedPercent, 8.25);
		assert.equal(one({ used_pct: 0.5, resets_at: RESETS_5H })?.usedPercent, 0.5);
		assert.equal(one({ used_pct: "8", resets_at: RESETS_5H }), null);
		assert.equal(one({ used_pct: Number.NaN, resets_at: RESETS_5H }), null);
		assert.equal(one({ used_pct: 8, resets_at: null })?.resetsAtEpochSec, null);
		assert.equal(one({ used_pct: 8, resets_at: "garbage" })?.resetsAtEpochSec, null);
		assert.equal(one({ used_pct: 8, resets_at: "2026-10-15T16:00:00.040889+00:00" })?.resetsAtEpochSec, 1792080000);
	});

	test("buildClaudeAuthStatusInvocation and parseClaudeAuthStatus", () => {
		assert.deepEqual(buildClaudeAuthStatusInvocation("linux"), { command: "claude", args: ["auth", "status", "--json"] });
		assert.deepEqual(buildClaudeAuthStatusInvocation("win32"), {
			command: "cmd",
			args: ["/c", "claude.cmd", "auth", "status", "--json"],
		});
		assert.deepEqual(parseClaudeAuthStatus(LOGGED_IN), {
			kind: "logged-in",
			identity: { orgId: "org-test-uuid", email: "me@example.test" },
		});
		assert.deepEqual(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false })), { kind: "logged-out" });
		assert.deepEqual(parseClaudeAuthStatus(""), { kind: "unknown" });
		assert.deepEqual(parseClaudeAuthStatus("not json"), { kind: "unknown" });
		assert.deepEqual(parseClaudeAuthStatus("[]"), { kind: "unknown" });
		assert.deepEqual(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true })), { kind: "unknown" });
	});

	test("a non-claude-code provider never spawns the CLI or requests the dashboard", async () => {
		const ref: RateLimitStatusRef = {};
		const exec = fakeExec(LOGGED_IN);
		const fetcher = fakeFetch(() => okResponse());
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "provider-b" },
			{ fetchImpl: fetcher.impl, execFileImpl: exec.impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => assert.fail("must not notify"));
			await poller.refresh();
			assert.equal(exec.calls.length, 0);
			assert.equal(fetcher.calls.length, 0);
			assert.deepEqual(ref, {});
		} finally {
			poller.stop();
		}
	});

	test("stop during an in-flight fetch drops the result and a restart is not stalled", async () => {
		const ref: RateLimitStatusRef = {};
		const exec = fakeExec(LOGGED_IN);
		const first = deferred<Response>();
		const fetcher = fakeFetch((call) =>
			call === 1 ? first.promise : okResponse(okPayload({ windows: [{ name: "5h", used_pct: 77, resets_at: RESETS_5H, credit: false }] })),
		);
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: exec.impl, env: {}, platform: "linux" },
		);
		let listenerA = 0;
		let listenerB = 0;
		try {
			poller.start(() => {
				listenerA += 1;
			});
			await waitFor(() => fetcher.calls.length === 1);
			poller.stop();
			poller.start(() => {
				listenerB += 1;
			});
			first.resolve(okResponse());
			await poller.refresh();

			assert.equal(fetcher.calls.length, 2);
			assert.equal(ref.current?.session?.usedPercent, 77);
			assert.equal(ref.current?.weekly, null);
			assert.equal(listenerA, 0);
			assert.equal(listenerB, 1);
		} finally {
			poller.stop();
		}
	});
});

function loginOf(url: string): string | null {
	return new URL(url).searchParams.get("login");
}

describe("usage dashboard login matching (D-03 / SC4)", () => {
	test("D-03 tracer: a 409 on the orgId login retries with the email login and the fingerprint-checked reading reaches the ref", async () => {
		const ref: RateLimitStatusRef = {};
		const exec = fakeExec(LOGGED_IN);
		const fetcher = fakeFetch((call) => {
			const login = loginOf(fetcher.calls[call - 1].url);
			if (login === "org-test-uuid") return new Response(JSON.stringify({ detail: "2 matches" }), { status: 409 });
			return okResponse(okPayload({ claude_email: "me@example.test", claude_org_uuid: "org-shared" }));
		});
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: exec.impl, env: {}, platform: "linux" },
		);
		let notified = 0;
		try {
			poller.start(() => {
				notified += 1;
			});
			await poller.refresh();
			assert.equal(ref.current?.session?.usedPercent, 8);
			assert.equal(ref.current?.weekly?.usedPercent, 29);
			assert.equal(fetcher.calls.length, 2);
			assert.equal(notified, 1);

			await poller.refresh();
			assert.equal(fetcher.calls.length, 3);
			assert.ok(fetcher.calls[2].url.endsWith("?login=me%40example.test"));
		} finally {
			poller.stop();
		}
	});

	test("a 200 whose identity fields do not match the login sent is rejected as misattributed", async () => {
		const ref: RateLimitStatusRef = {
			current: { session: { usedPercent: 5, resetsAtEpochSec: 1 }, weekly: null },
			provider: "claude-code",
			meta: { session: { source: "dashboard", observedAtMs: Date.now() } },
		};
		const exec = fakeExec(LOGGED_IN);
		const fetcher = fakeFetch(() =>
			okResponse(
				okPayload({
					claude_org_uuid: "other-org",
					claude_email: "other@example.test",
					claude_account_uuid: "other-acct",
				}),
			),
		);
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: exec.impl, env: {}, platform: "linux" },
		);
		let notified = 0;
		try {
			poller.start(() => {
				notified += 1;
			});
			await poller.refresh();
			assert.equal(ref.current?.session, null);
			assert.equal(ref.current?.weekly, null);
			assert.equal(notified, 1);
		} finally {
			poller.stop();
		}
	});

	test("a misattributed 200 writes nothing into an empty ref", async () => {
		const ref: RateLimitStatusRef = {};
		const fetcher = fakeFetch(() => okResponse(okPayload({ claude_org_uuid: "other-org" })));
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => assert.fail("must not notify"));
			await poller.refresh();
			assert.deepEqual(ref, {});
		} finally {
			poller.stop();
		}
	});

	test("the fingerprint match is case-insensitive", async () => {
		const ref: RateLimitStatusRef = {};
		const fetcher = fakeFetch(() => okResponse(okPayload({ claude_org_uuid: "ORG-TEST-UUID" })));
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => {});
			await poller.refresh();
			assert.equal(ref.current?.session?.usedPercent, 8);
		} finally {
			poller.stop();
		}
	});

	test("every request carries one encoded login parameter and nothing else", async () => {
		const ref: RateLimitStatusRef = {};
		const stdout = JSON.stringify({ loggedIn: true, orgId: "org+id/1", email: "a@example.test" });
		const fetcher = fakeFetch((call) =>
			call === 1 ? new Response("{}", { status: 409 }) : okResponse(okPayload({ claude_email: "a@example.test" })),
		);
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: fakeExec(stdout).impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => {});
			await poller.refresh();
			assert.equal(fetcher.calls.length, 2);
			assert.ok(fetcher.calls[0].url.endsWith("?login=org%2Bid%2F1"));
			for (const call of fetcher.calls) {
				assert.deepEqual([...new URL(call.url).searchParams.keys()], ["login"]);
				assert.ok(!call.url.includes("account_id"));
				assert.ok(!call.url.includes("fresh"));
			}
		} finally {
			poller.stop();
		}
	});

	test("every login key answering 409 writes nothing", async () => {
		const ref: RateLimitStatusRef = {};
		const fetcher = fakeFetch(() => new Response(JSON.stringify({ detail: "2 matches" }), { status: 409 }));
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => assert.fail("must not notify"));
			await poller.refresh();
			assert.equal(fetcher.calls.length, 2);
			assert.deepEqual(ref, {});
		} finally {
			poller.stop();
		}
	});

	test("loginCandidates orders orgId, email, accountUuid and de-duplicates case-insensitively", () => {
		assert.deepEqual(loginCandidates({ orgId: "O", email: "e@x", accountUuid: "A" }), ["O", "e@x", "A"]);
		assert.deepEqual(loginCandidates({ orgId: "same", email: "SAME", accountUuid: "Same" }), ["same"]);
		assert.deepEqual(loginCandidates({ email: "e@x" }), ["e@x"]);
		assert.deepEqual(loginCandidates({}), []);
	});

	test("identityMatchesLogin compares claude_org_uuid, claude_email and claude_account_uuid case-insensitively", () => {
		assert.equal(identityMatchesLogin({ claude_org_uuid: "Org-1" }, "org-1"), true);
		assert.equal(identityMatchesLogin({ claude_email: "ME@x" }, "me@X"), true);
		assert.equal(identityMatchesLogin({ claude_account_uuid: "acct" }, "ACCT"), true);
		assert.equal(identityMatchesLogin({ claude_org_uuid: null, claude_email: 5 }, "org-1"), false);
		assert.equal(identityMatchesLogin([{ claude_org_uuid: "org-1" }], "org-1"), false);
		assert.equal(identityMatchesLogin(null, "org-1"), false);
		assert.equal(identityMatchesLogin("org-1", "org-1"), false);
	});
});
