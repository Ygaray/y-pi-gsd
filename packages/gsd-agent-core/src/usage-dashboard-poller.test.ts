import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, mock, test } from "node:test";
import type { Api, Model } from "@gsd/pi-ai";
import { AuthStorage } from "@gsd/pi-coding-agent/core/auth-storage.js";
import { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { SessionManager } from "@gsd/pi-coding-agent/core/session-manager.js";
import { SettingsManager } from "@gsd/pi-coding-agent/core/settings-manager.js";
import type { RateLimitStatusRef } from "./rate-limit-status-ref.ts";
import { createAgentSession } from "./sdk.ts";
import {
	buildClaudeAuthStatusInvocation,
	claudeConfigPath,
	createUsageDashboardPoller,
	identityConsistent,
	identityMatchesLogin,
	loginCandidates,
	mapDashboardQuotaPayload,
	parseClaudeAuthStatus,
	parseClaudeConfigIdentity,
	resolveUsageDashboardBaseUrl,
	USAGE_DASHBOARD_BACKOFF_MS,
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
			return okResponse(okPayload({ claude_email: "me@example.test", claude_org_uuid: "org-test-uuid" }));
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
			call === 1 ? new Response("{}", { status: 409 }) : okResponse(okPayload({ claude_email: "a@example.test", claude_org_uuid: "org+id/1" })),
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

	test("WR-02: a teammate's account that matches on the org key is rejected, not shown as this session's quota", async () => {
		const ref: RateLimitStatusRef = {
			current: { session: { usedPercent: 5, resetsAtEpochSec: 1 }, weekly: null },
			provider: "claude-code",
			meta: { session: { source: "dashboard", observedAtMs: Date.now() } },
		};
		// The dashboard tracks exactly one account in this org, and it is a teammate's: the org key answers 200.
		const fetcher = fakeFetch(() =>
			okResponse(okPayload({ claude_org_uuid: "org-test-uuid", claude_email: "teammate@example.test", claude_account_uuid: "acct-teammate" })),
		);
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
		);
		let notified = 0;
		try {
			poller.start(() => {
				notified += 1;
			});
			await poller.refresh();
			assert.equal(fetcher.calls.length, 1);
			assert.equal(ref.current?.session, null, "the dashboard-sourced window is cleared, never replaced by the teammate's");
			assert.equal(notified, 1);
		} finally {
			poller.stop();
		}
	});

	test("WR-02: a 200 agreeing on every field both sides know is accepted, and a field the dashboard has not learned is skipped", async () => {
		const ref: RateLimitStatusRef = {};
		const fetcher = fakeFetch(() => okResponse(okPayload({ claude_email: "ME@example.test", claude_account_uuid: null })));
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

	test("identityConsistent requires agreement on every identity field present on both sides", () => {
		const id = { orgId: "Org-1", email: "me@x", accountUuid: "A-1" };
		assert.equal(identityConsistent({ claude_org_uuid: "org-1", claude_email: "ME@x", claude_account_uuid: "a-1" }, id), true);
		assert.equal(identityConsistent({ claude_org_uuid: "org-1", claude_email: null, claude_account_uuid: null }, id), true);
		assert.equal(identityConsistent({ claude_org_uuid: "org-1", claude_email: "other@x" }, id), false);
		assert.equal(identityConsistent({ claude_org_uuid: "org-2" }, id), false);
		assert.equal(identityConsistent({ claude_account_uuid: "a-2" }, id), false);
		assert.equal(identityConsistent({ claude_email: "other@x" }, { orgId: "org-1" }), true, "a field this session lacks is skipped");
		assert.equal(identityConsistent([], id), false);
		assert.equal(identityConsistent(null, id), false);
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

function failingExec(error: Error & { code?: string | number; stdout?: string | Buffer }): {
	impl: ExecFileLike;
	calls: number[];
} {
	const calls: number[] = [];
	const impl: ExecFileLike = async () => {
		calls.push(calls.length + 1);
		throw error;
	};
	return { impl, calls };
}

function exitError(code: string | number, stdout?: string | Buffer): Error & { code: string | number; stdout?: string | Buffer } {
	const error = new Error("Command failed") as Error & { code: string | number; stdout?: string | Buffer };
	error.code = code;
	if (stdout !== undefined) error.stdout = stdout;
	return error;
}

function fakeConfigReader(result: string | Error): { impl: (path: string) => Promise<string>; paths: string[] } {
	const paths: string[] = [];
	return {
		paths,
		impl: async (path) => {
			paths.push(path);
			if (result instanceof Error) throw result;
			return result;
		},
	};
}

const CONFIG_JSON = JSON.stringify({
	numStartups: 3,
	oauthAccount: { organizationUuid: "org-from-file", emailAddress: "file@example.test", accountUuid: "acct-from-file" },
});

describe("usage dashboard identity chain (D-03, RESEARCH Pitfall 8)", () => {
	afterEach(() => {
		mock.timers.reset();
	});

	test("a logged-out CLI that exits 1 with JSON on stdout makes no request and never reads the config file", async () => {
		const ref: RateLimitStatusRef = {
			current: { session: { usedPercent: 5, resetsAtEpochSec: 1 }, weekly: null },
			provider: "claude-code",
			meta: { session: { source: "dashboard", observedAtMs: Date.now() } },
		};
		const exec = failingExec(exitError(1, '{"loggedIn": false, "authMethod": "none"}'));
		const reader = fakeConfigReader(CONFIG_JSON);
		const fetcher = fakeFetch(() => okResponse());
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: exec.impl, readClaudeConfigImpl: reader.impl, env: {}, platform: "linux" },
		);
		let notified = 0;
		try {
			poller.start(() => {
				notified += 1;
			});
			await poller.refresh();
			assert.equal(fetcher.calls.length, 0);
			assert.equal(reader.paths.length, 0);
			assert.equal(ref.current?.session, null);
			assert.equal(notified, 1);
		} finally {
			poller.stop();
		}
	});

	test("a logged-in CLI that exits non-zero still yields its identity from stdout", async () => {
		const ref: RateLimitStatusRef = {};
		const exec = failingExec(exitError(1, Buffer.from(LOGGED_IN)));
		const fetcher = fakeFetch(() => okResponse());
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: exec.impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => {});
			await poller.refresh();
			assert.equal(fetcher.calls.length, 1);
			assert.equal(loginOf(fetcher.calls[0].url), "org-test-uuid");
		} finally {
			poller.stop();
		}
	});

	test("a missing CLI falls back to the oauthAccount block of .claude.json under CLAUDE_CONFIG_DIR", async () => {
		const ref: RateLimitStatusRef = {};
		const exec = failingExec(exitError("ENOENT"));
		const reader = fakeConfigReader(CONFIG_JSON);
		const fetcher = fakeFetch(() => okResponse(okPayload({ claude_org_uuid: "org-from-file" })));
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{
				fetchImpl: fetcher.impl,
				execFileImpl: exec.impl,
				readClaudeConfigImpl: reader.impl,
				env: { CLAUDE_CONFIG_DIR: "/cfg/x" },
				platform: "linux",
			},
		);
		try {
			poller.start(() => {});
			await poller.refresh();
			assert.deepEqual(reader.paths, [join("/cfg/x", ".claude.json")]);
			assert.equal(fetcher.calls.length, 1);
			assert.equal(loginOf(fetcher.calls[0].url), "org-from-file");
		} finally {
			poller.stop();
		}
	});

	test("without CLAUDE_CONFIG_DIR the fallback reads .claude.json in the home directory", async () => {
		const exec = failingExec(exitError("ENOENT"));
		const reader = fakeConfigReader(CONFIG_JSON);
		const poller = new UsageDashboardPoller(
			{ ref: {}, getProvider: () => "claude-code" },
			{
				fetchImpl: fakeFetch(() => okResponse(okPayload({ claude_org_uuid: "org-from-file" }))).impl,
				execFileImpl: exec.impl,
				readClaudeConfigImpl: reader.impl,
				env: {},
				platform: "linux",
			},
		);
		try {
			poller.start(() => {});
			await poller.refresh();
			assert.deepEqual(reader.paths, [join(homedir(), ".claude.json")]);
		} finally {
			poller.stop();
		}
	});

	test("unparseable CLI output plus an unreadable config file means no identity and no request", async () => {
		const reader = fakeConfigReader(new Error("EACCES"));
		const fetcher = fakeFetch(() => okResponse());
		const poller = new UsageDashboardPoller(
			{ ref: {}, getProvider: () => "claude-code" },
			{
				fetchImpl: fetcher.impl,
				execFileImpl: fakeExec("garbage").impl,
				readClaudeConfigImpl: reader.impl,
				env: {},
				platform: "linux",
			},
		);
		try {
			poller.start(() => {});
			await poller.refresh();
			assert.equal(reader.paths.length, 1);
			assert.equal(fetcher.calls.length, 0);
		} finally {
			poller.stop();
		}
	});

	test("claudeConfigPath and parseClaudeConfigIdentity read only the oauthAccount block", () => {
		assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: " /a/b " }), join("/a/b", ".claude.json"));
		assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: "  " }), join(homedir(), ".claude.json"));
		assert.deepEqual(parseClaudeConfigIdentity(CONFIG_JSON), {
			orgId: "org-from-file",
			email: "file@example.test",
			accountUuid: "acct-from-file",
		});
		assert.deepEqual(parseClaudeConfigIdentity(JSON.stringify({ oauthAccount: { emailAddress: "e@x" } })), { email: "e@x" });
		assert.equal(parseClaudeConfigIdentity(JSON.stringify({ oauthAccount: {} })), null);
		assert.equal(parseClaudeConfigIdentity(JSON.stringify({ oauthAccount: { emailAddress: "x".repeat(321) } })), null);
		assert.equal(parseClaudeConfigIdentity(JSON.stringify({ oauthAccount: [] })), null);
		assert.equal(parseClaudeConfigIdentity(JSON.stringify({ organizationUuid: "top-level" })), null);
		assert.equal(parseClaudeConfigIdentity("{not json"), null);
	});

	test("WR-03: stop() cancels a running claude auth status child, never reads the config file, and a restart resolves afresh", async () => {
		const signals: AbortSignal[] = [];
		const exec: ExecFileLike = (_file, _args, options) => {
			const signal = options.signal;
			assert.ok(signal, "the child is started with an AbortSignal");
			signals.push(signal);
			if (signals.length > 1) return Promise.resolve({ stdout: LOGGED_IN });
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" })), {
					once: true,
				});
			});
		};
		const reader = fakeConfigReader(CONFIG_JSON);
		const fetcher = fakeFetch(() => okResponse());
		const ref: RateLimitStatusRef = {};
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: exec, readClaudeConfigImpl: reader.impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => {});
			await waitFor(() => signals.length === 1);
			poller.stop();
			assert.equal(signals[0].aborted, true);
			await settle();
			assert.equal(reader.paths.length, 0, "an aborted lookup does not fall through to .claude.json");
			assert.equal(fetcher.calls.length, 0);

			poller.start(() => {});
			await poller.refresh();
			assert.equal(signals.length, 2, "the aborted lookup armed no back-off: the restart resolves at once");
			assert.equal(ref.current?.session?.usedPercent, 8);
		} finally {
			poller.stop();
		}
	});

	test("without an identity the CLI is not re-run before the back-off", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
		const exec = failingExec(exitError(1, '{"loggedIn": false}'));
		const poller = new UsageDashboardPoller(
			{ ref: {}, getProvider: () => "claude-code" },
			{ fetchImpl: fakeFetch(() => okResponse()).impl, execFileImpl: exec.impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => {});
			await poller.refresh();
			assert.equal(exec.calls.length, 1);

			mock.timers.tick(60_000);
			await poller.refresh();
			assert.equal(exec.calls.length, 1, "a manual refresh inside the back-off must not spawn the CLI");

			mock.timers.tick(USAGE_DASHBOARD_BACKOFF_MS);
			await poller.refresh();
			assert.equal(exec.calls.length, 2);
		} finally {
			poller.stop();
		}
	});

	test("a 404 clears dashboard windows at once, forgets the identity and re-resolves after the back-off", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
		const ref: RateLimitStatusRef = {};
		const exec = fakeExec(LOGGED_IN);
		const fetcher = fakeFetch((call) =>
			call === 2 ? new Response(JSON.stringify({ detail: "no active anthropic account" }), { status: 404 }) : okResponse(),
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
			assert.equal(ref.current?.session?.usedPercent, 8);
			assert.equal(notified, 1);

			await poller.refresh();
			assert.equal(fetcher.calls.length, 2);
			assert.equal(ref.current?.session, null);
			assert.equal(ref.current?.weekly, null);
			assert.equal(notified, 2);
			assert.equal(exec.calls.length, 1);

			mock.timers.tick(60_000);
			await poller.refresh();
			assert.equal(fetcher.calls.length, 2, "no request inside the back-off");
			assert.equal(exec.calls.length, 1);

			mock.timers.tick(USAGE_DASHBOARD_BACKOFF_MS);
			await poller.refresh();
			assert.equal(exec.calls.length, 2, "identity resolved again after the back-off");
			assert.equal(fetcher.calls.length, 3);
			assert.equal(ref.current?.session?.usedPercent, 8);
		} finally {
			poller.stop();
		}
	});
});

async function settle(): Promise<void> {
	for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

const FAR_FUTURE_SEC = Math.round(Date.now() / 1000) + 86_400;

function refWithFreshSdkWeekly(): RateLimitStatusRef {
	return {
		current: { session: null, weekly: { usedPercent: 40, resetsAtEpochSec: FAR_FUTURE_SEC } },
		provider: "claude-code",
		meta: { weekly: { source: "sdk", observedAtMs: Date.now() } },
	};
}

function serverError(): Response {
	return new Response("{}", { status: 503 });
}

describe("usage dashboard degradation (D-04)", () => {
	afterEach(() => {
		mock.timers.reset();
	});

	test("one failed poll keeps the dashboard values and the second consecutive failure clears only dashboard windows", async () => {
		const ref = refWithFreshSdkWeekly();
		const fetcher = fakeFetch((call) => (call === 1 ? okResponse() : serverError()));
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
		);
		let notified = 0;
		try {
			poller.start(() => {
				notified += 1;
			});
			await poller.refresh();
			assert.equal(ref.current?.session?.usedPercent, 8);
			assert.equal(ref.current?.weekly?.usedPercent, 40, "a fresh SDK weekly window is not overwritten");
			const afterOk = notified;

			await poller.refresh();
			assert.equal(ref.current?.session?.usedPercent, 8);
			assert.equal(notified, afterOk);

			await poller.refresh();
			assert.equal(ref.current?.session, null);
			assert.equal(ref.current?.weekly?.usedPercent, 40);
			assert.equal(notified, afterOk + 1);
		} finally {
			poller.stop();
		}
	});

	test("an accepted poll resets the failure count", async () => {
		const ref: RateLimitStatusRef = {};
		const fetcher = fakeFetch((call) => (call === 2 ? okResponse() : serverError()));
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => {});
			await poller.refresh();
			await poller.refresh();
			assert.equal(ref.current?.session?.usedPercent, 8);
			await poller.refresh();
			assert.equal(fetcher.calls.length, 3);
			assert.equal(ref.current?.session?.usedPercent, 8, "fail, ok, fail leaves the value shown");
		} finally {
			poller.stop();
		}
	});

	test("each kind of non-accepted poll counts as a failure", async () => {
		const bad: Array<[string, () => Response | Promise<Response>]> = [
			["fetch rejection", () => Promise.reject(new Error("ECONNREFUSED"))],
			["HTTP 500", () => new Response("{}", { status: 500 })],
			["stale true", () => okResponse(okPayload({ stale: true }))],
			["status error", () => okResponse(okPayload({ status: "error" }))],
			["age_s 601", () => okResponse(okPayload({ age_s: 601 }))],
			["malformed JSON", () => new Response("{not json", { status: 200 })],
			["content-length over the cap", () => new Response("{}", { status: 200, headers: { "content-length": "300000" } })],
			["300 KiB body without content-length", () => new Response(`{"pad":"${"x".repeat(300 * 1024)}"}`, { status: 200 })],
		];
		for (const [label, respond] of bad) {
			const ref: RateLimitStatusRef = {
				current: { session: { usedPercent: 5, resetsAtEpochSec: FAR_FUTURE_SEC }, weekly: null },
				provider: "claude-code",
				meta: { session: { source: "dashboard", observedAtMs: Date.now() } },
			};
			const poller = new UsageDashboardPoller(
				{ ref, getProvider: () => "claude-code" },
				{ fetchImpl: async () => respond(), execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
			);
			try {
				poller.start(() => {});
				await poller.refresh();
				assert.equal(ref.current?.session?.usedPercent, 5, `${label}: one failure keeps the value`);
				await poller.refresh();
				assert.equal(ref.current?.session, null, `${label}: second consecutive failure clears it`);
			} finally {
				poller.stop();
			}
		}
	});

	test("a dashboard window observed more than 600 s ago expires on the next tick while the dashboard is unreachable", async () => {
		mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
		const ref: RateLimitStatusRef = {};
		const fetcher = fakeFetch((call) => (call === 1 ? okResponse(okPayload({ age_s: 590 })) : Promise.reject(new Error("down")) as never));
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl: fetcher.impl, execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
		);
		let notified = 0;
		try {
			poller.start(() => {
				notified += 1;
			});
			await poller.refresh();
			assert.equal(ref.current?.session?.usedPercent, 8);
			const afterOk = notified;

			mock.timers.tick(60_000);
			await settle();
			assert.equal(fetcher.calls.length, 2);
			assert.equal(ref.current?.session, null, "expired at tick start, before the failure threshold");
			assert.equal(notified, afterOk + 1);
		} finally {
			poller.stop();
		}
	});

	test("cadence: transient failures retry every 60 s and identity, 404, conflict and fingerprint failures wait 300 s", async () => {
		const run = async (
			label: string,
			make: () => { exec: ExecFileLike; execCalls: () => number; respond: (call: number, url: string) => Response },
			expected: { atStart: number; after60: number; after300: number; counter: "fetch" | "exec" },
		): Promise<void> => {
			mock.timers.reset();
			mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
			const { exec, execCalls, respond } = make();
			const fetcher = fakeFetch((call) => respond(call, fetcher.calls[call - 1].url));
			const poller = new UsageDashboardPoller(
				{ ref: {}, getProvider: () => "claude-code" },
				{ fetchImpl: fetcher.impl, execFileImpl: exec, env: {}, platform: "linux" },
			);
			const count = () => (expected.counter === "fetch" ? fetcher.calls.length : execCalls());
			try {
				poller.start(() => {});
				await settle();
				assert.equal(count(), expected.atStart, `${label}: first tick`);
				mock.timers.tick(59_999);
				await settle();
				assert.equal(count(), expected.atStart, `${label}: nothing before 60 s`);
				mock.timers.tick(1);
				await settle();
				assert.equal(count(), expected.after60, `${label}: at 60 s`);
				mock.timers.tick(240_000);
				await settle();
				assert.equal(count(), expected.after300, `${label}: at 300 s`);
			} finally {
				poller.stop();
			}
		};
		const loggedIn = () => {
			const exec = fakeExec(LOGGED_IN);
			return { exec: exec.impl, execCalls: () => exec.calls.length };
		};
		await run(
			"transient 503",
			() => ({ ...loggedIn(), respond: () => serverError() }),
			{ atStart: 1, after60: 2, after300: 3, counter: "fetch" },
		);
		const loggedOut = () => {
			const exec = failingExec(exitError(1, '{"loggedIn": false}'));
			return { exec: exec.impl, execCalls: () => exec.calls.length };
		};
		await run(
			"no identity",
			() => ({ ...loggedOut(), respond: () => okResponse() }),
			{ atStart: 1, after60: 1, after300: 2, counter: "exec" },
		);
		await run(
			"404",
			() => ({ ...loggedIn(), respond: () => new Response("{}", { status: 404 }) }),
			{ atStart: 1, after60: 1, after300: 2, counter: "fetch" },
		);
		await run(
			"all logins 409",
			() => ({ ...loggedIn(), respond: () => new Response("{}", { status: 409 }) }),
			{ atStart: 2, after60: 2, after300: 4, counter: "fetch" },
		);
		await run(
			"fingerprint mismatch",
			() => ({ ...loggedIn(), respond: () => okResponse(okPayload({ claude_org_uuid: "other" })) }),
			{ atStart: 1, after60: 1, after300: 2, counter: "fetch" },
		);
	});

	test("a request that never answers is aborted after fetchTimeoutMs and counted as a failure", async () => {
		const ref: RateLimitStatusRef = {};
		const signals: AbortSignal[] = [];
		let call = 0;
		const fetchImpl: FetchLike = (_url, init) => {
			call += 1;
			if (call === 1) return Promise.resolve(okResponse());
			signals.push(init.signal);
			return new Promise<Response>((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
			});
		};
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl, execFileImpl: fakeExec(LOGGED_IN).impl, fetchTimeoutMs: 20, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => {});
			await poller.refresh();
			assert.equal(ref.current?.session?.usedPercent, 8);
			await poller.refresh();
			assert.equal(signals[0].aborted, true);
			assert.equal(ref.current?.session?.usedPercent, 8, "one timeout alone changes nothing");
			await poller.refresh();
			assert.equal(signals[1].aborted, true);
			assert.equal(ref.current?.session, null, "two timeouts clear the dashboard window");
		} finally {
			poller.stop();
		}
	});

	test("stop aborts an in-flight request and nothing is written or notified", async () => {
		const ref: RateLimitStatusRef = {};
		const pending = deferred<Response>();
		const signals: AbortSignal[] = [];
		const fetchImpl: FetchLike = (_url, init) => {
			signals.push(init.signal);
			return pending.promise;
		};
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl, execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
		);
		poller.start(() => assert.fail("must not notify"));
		await waitFor(() => signals.length === 1);
		poller.stop();
		assert.equal(signals[0].aborted, true);
		pending.resolve(okResponse());
		await settle();
		assert.deepEqual(ref, {});
	});

	test("WR-01: every request refuses redirects so the identity-bearing URL never leaves the loopback origin", async () => {
		const ref: RateLimitStatusRef = {};
		const seen: string[] = [];
		const fetcher = fakeFetch(() => okResponse());
		const fetchImpl: FetchLike = (url, init) => {
			seen.push(init.redirect);
			return fetcher.impl(url, init);
		};
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl, execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => {});
			await poller.refresh();
			assert.deepEqual(seen, ["error"]);
			assert.equal(ref.current?.session?.usedPercent, 8);
		} finally {
			poller.stop();
		}
	});

	test("WR-01: a fetch that rejects because it hit a redirect is a transient failure and writes nothing", async () => {
		const ref: RateLimitStatusRef = {};
		const fetchImpl: FetchLike = async () => {
			throw new TypeError("fetch failed: unexpected redirect");
		};
		const poller = new UsageDashboardPoller(
			{ ref, getProvider: () => "claude-code" },
			{ fetchImpl, execFileImpl: fakeExec(LOGGED_IN).impl, env: {}, platform: "linux" },
		);
		try {
			poller.start(() => assert.fail("must not notify"));
			await poller.refresh();
			assert.deepEqual(ref, {});
		} finally {
			poller.stop();
		}
	});
});

describe("usage dashboard transport safety (T-43-06, T-43-08)", () => {
	test("resolveUsageDashboardBaseUrl accepts only loopback http(s) bases and honours the off switch", () => {
		const base = (explicit: string | undefined, env: NodeJS.ProcessEnv = {}) => resolveUsageDashboardBaseUrl(explicit, env);
		assert.equal(base(undefined), "http://127.0.0.1:8820");
		assert.equal(base(""), "http://127.0.0.1:8820");
		assert.equal(base("   "), "http://127.0.0.1:8820");
		assert.equal(base("http://localhost:9000/"), "http://localhost:9000");
		assert.equal(base("http://[::1]:8820"), "http://[::1]:8820");
		assert.equal(base("https://127.0.0.1:8820"), "https://127.0.0.1:8820");
		assert.equal(base("off"), null);
		assert.equal(base("OFF"), null);
		assert.equal(base(undefined, { GSD_USAGE_DASHBOARD_URL: "Off" }), null);
		assert.equal(base(undefined, { GSD_USAGE_DASHBOARD_URL: "http://localhost:9001" }), "http://localhost:9001");
		assert.equal(base("http://127.0.0.1:7000", { GSD_USAGE_DASHBOARD_URL: "http://localhost:9001" }), "http://127.0.0.1:7000");
		for (const rejected of [
			"http://example.com:8820",
			"http://10.0.0.5:8820",
			"http://127.0.0.1.evil.test",
			"http://user:pw@127.0.0.1:8820",
			"http://127.0.0.1:8820/api",
			"http://127.0.0.1:8820/?x=1",
			"http://127.0.0.1:8820/#frag",
			"file:///tmp/x",
			"ftp://127.0.0.1",
			"not a url",
		]) {
			assert.equal(base(rejected), null, rejected);
			assert.equal(base(undefined, { GSD_USAGE_DASHBOARD_URL: rejected }), null, `env ${rejected}`);
		}
	});

	test("createUsageDashboardPoller returns undefined when disabled by option, kill switch or a non-loopback URL, and a directly built poller with a remote base never requests", async () => {
		const core = { ref: {} as RateLimitStatusRef, getProvider: () => "claude-code" as string | undefined };
		assert.equal(createUsageDashboardPoller(false, core), undefined);
		assert.equal(createUsageDashboardPoller({ baseUrl: "http://example.com:8820" }, core), undefined);
		assert.equal(createUsageDashboardPoller({ baseUrl: "off" }, core), undefined);
		assert.equal(createUsageDashboardPoller({ env: { GSD_USAGE_DASHBOARD_URL: "off" } }, core), undefined);
		assert.equal(createUsageDashboardPoller({ env: { GSD_USAGE_DASHBOARD_URL: "http://10.0.0.5:8820" } }, core), undefined);
		assert.ok(createUsageDashboardPoller({ env: {} }, core));

		// IN-02: a rejected override is distinguishable from "off" in the debug output, and never echoes the URL.
		const lines: string[] = [];
		const debugEnv = { GSD_DEBUG_USAGE_DASHBOARD: "1" };
		const debugLog = (line: string) => lines.push(line);
		assert.equal(createUsageDashboardPoller({ env: { ...debugEnv, GSD_USAGE_DASHBOARD_URL: "http://dashboard.lan:8820" }, debugLog }, core), undefined);
		assert.deepEqual(lines, ["[usage-dashboard] disabled: base-url"]);
		assert.equal(createUsageDashboardPoller({ baseUrl: "off", env: debugEnv, debugLog }, core), undefined);
		assert.equal(createUsageDashboardPoller({ env: { ...debugEnv, GSD_USAGE_DASHBOARD_URL: "OFF" }, debugLog }, core), undefined);
		assert.equal(lines.length, 1, "the kill switch stays silent");
		assert.equal(createUsageDashboardPoller({ env: { GSD_USAGE_DASHBOARD_URL: "http://dashboard.lan:8820" }, debugLog }, core), undefined);
		assert.equal(lines.length, 1, "nothing is printed without the debug flag");

		const exec = fakeExec(LOGGED_IN);
		const fetcher = fakeFetch(() => okResponse());
		const remote = new UsageDashboardPoller(core, {
			baseUrl: "http://example.com:8820",
			fetchImpl: fetcher.impl,
			execFileImpl: exec.impl,
			env: {},
			platform: "linux",
		});
		try {
			remote.start(() => assert.fail("must not notify"));
			await remote.refresh();
			assert.equal(fetcher.calls.length, 0);
			assert.equal(exec.calls.length, 0);
		} finally {
			remote.stop();
		}
	});

	test("debug output is silent by default and never contains identity values when enabled", async () => {
		const run = async (env: NodeJS.ProcessEnv): Promise<string[]> => {
			const lines: string[] = [];
			const fetcher = fakeFetch((call) => {
				if (call === 1) return new Response("{}", { status: 409 });
				if (call === 2) return okResponse(okPayload({ claude_email: "me@example.test" }));
				return new Response("{}", { status: 404 });
			});
			const poller = new UsageDashboardPoller(
				{ ref: {}, getProvider: () => "claude-code" },
				{
					fetchImpl: fetcher.impl,
					execFileImpl: fakeExec(LOGGED_IN).impl,
					env,
					platform: "linux",
					debugLog: (line) => lines.push(line),
				},
			);
			try {
				poller.start(() => {});
				await poller.refresh();
				await poller.refresh();
				assert.equal(fetcher.calls.length, 3);
			} finally {
				poller.stop();
			}
			return lines;
		};
		assert.deepEqual(await run({}), []);
		assert.deepEqual(await run({ GSD_DEBUG_USAGE_DASHBOARD: "0" }), []);
		const lines = await run({ GSD_DEBUG_USAGE_DASHBOARD: "1" });
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(line.startsWith("[usage-dashboard] "), line);
			for (const forbidden of ["org-test-uuid", "me@example.test", "%40", "login", "?"]) {
				assert.ok(!line.includes(forbidden), `${JSON.stringify(line)} contains ${forbidden}`);
			}
		}
		assert.ok(lines.includes("[usage-dashboard] accepted"));
		assert.ok(lines.includes("[usage-dashboard] not-found"));
	});
});
