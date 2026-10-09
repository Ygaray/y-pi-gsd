/**
 * Claude-code fallback rate-limit producer: polls the loopback UsageDashboard (D-01, D-03, D-04).
 *
 * The claude-code backend sends no rate-limit response headers and the SDK only emits a
 * `rate_limit_event` when its own info changes, so before the first event the footer would show
 * `unavailable`. The UsageDashboard (127.0.0.1:8820, contract schema_version 1) already holds the
 * same 5h / weekly numbers; this producer maps them onto the shared `RateLimitStatusRef`.
 *
 * Identity (D-03): this session's login comes from `claude auth status --json`, the identity source
 * the externalCli backend has. Only when the CLI is missing, times out or prints neither logged-in nor
 * logged-out JSON does it fall back to reading `{CLAUDE_CONFIG_DIR or the home directory}/.claude.json`
 * (size-capped). That whole file is read and parsed, but only the `oauthAccount` fields
 * (organizationUuid, emailAddress, accountUuid) are kept; everything else is discarded. It never reads
 * credential or token files, and it never logs or prints identity values.
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RateLimitWindow } from "./rate-limit-headers.js";
import {
	applyDashboardReading,
	clearDashboardWindows,
	DASHBOARD_PROVIDER,
	type DashboardReading,
	expireDashboardWindows,
	type RateLimitFallbackProducer,
	type RateLimitStatusRef,
} from "./rate-limit-status-ref.js";

export const USAGE_DASHBOARD_DEFAULT_BASE_URL = "http://127.0.0.1:8820";
export const USAGE_DASHBOARD_QUOTA_PATH = "/api/quota/anthropic";
export const USAGE_DASHBOARD_POLL_MS = 60_000;
export const USAGE_DASHBOARD_FETCH_TIMEOUT_MS = 3_000;
export const USAGE_DASHBOARD_MAX_AGE_S = 600;
export const USAGE_DASHBOARD_SCHEMA_VERSION = 1;
export const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 15_000;
/** Operator override for the dashboard base URL (loopback only); `off` disables the producer. */
export const USAGE_DASHBOARD_URL_ENV = "GSD_USAGE_DASHBOARD_URL";
/** `1` prints fixed outcome tokens (never identity) on stderr. */
export const USAGE_DASHBOARD_DEBUG_ENV = "GSD_DEBUG_USAGE_DASHBOARD";
/** A response body larger than this is a failure. The real payload is about 1 KiB. */
export const USAGE_DASHBOARD_MAX_BODY_BYTES = 256 * 1024;
/** Consecutive non-accepted polls before dashboard-sourced windows are cleared. */
export const USAGE_DASHBOARD_FAILURES_BEFORE_CLEAR = 2;
/** Wait before trying again after the dashboard cannot vouch for this session (no identity, 404, all-409, fingerprint). */
export const USAGE_DASHBOARD_BACKOFF_MS = 300_000;
/** The `.claude.json` fallback is skipped when the file is larger than this. */
export const CLAUDE_CONFIG_MAX_BYTES = 8 * 1024 * 1024;

const MAX_IDENTITY_FIELD_LENGTH = 320;

export interface ClaudeIdentity {
	orgId?: string;
	email?: string;
	accountUuid?: string;
}

export type ClaudeAuthStatus = { kind: "logged-in"; identity: ClaudeIdentity } | { kind: "logged-out" } | { kind: "unknown" };

export type ExecFileLike = (
	file: string,
	args: readonly string[],
	options: { timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number; signal?: AbortSignal },
) => Promise<{ stdout: string | Buffer }>;

export type FetchLike = (
	url: string,
	init: {
		headers: Record<string, string>;
		signal: AbortSignal;
		/** Always "error": a redirect must never carry the identity-bearing query string to another origin. */
		redirect: "error";
	},
) => Promise<Response>;

export interface UsageDashboardPollerOptions {
	/** Injected transport (tests). Default: the late-bound global `fetch`. */
	fetchImpl?: FetchLike;
	/** Injected CLI runner (tests). Default: promisified `execFile`. */
	execFileImpl?: ExecFileLike;
	/** Injected clock (tests). Default: late-bound `Date.now()`. */
	now?: () => number;
	baseUrl?: string;
	intervalMs?: number;
	fetchTimeoutMs?: number;
	backoffMs?: number;
	/** Debug sink (tests). Default: a line on stderr. Only used when GSD_DEBUG_USAGE_DASHBOARD is `1`. */
	debugLog?: (line: string) => void;
	/** Injected `.claude.json` reader (tests). Default: size-capped `fs.promises.readFile`. */
	readClaudeConfigImpl?: (path: string) => Promise<string>;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}

/** `false` disables the producer; an object injects seams. */
export type UsageDashboardOptions = false | UsageDashboardPollerOptions;

/** Validates a dashboard body and maps its 5h / weekly non-credit windows. Null unless fully trusted. */
export function mapDashboardQuotaPayload(body: unknown, nowMs: number): DashboardReading | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const payload = body as Record<string, unknown>;
	if (payload.schema_version !== USAGE_DASHBOARD_SCHEMA_VERSION) return null;
	if (payload.status !== "ok") return null;
	if (payload.stale !== false) return null;
	const ageS = payload.age_s;
	if (typeof ageS !== "number" || !Number.isFinite(ageS)) return null;
	if (ageS < 0 || ageS > USAGE_DASHBOARD_MAX_AGE_S) return null;
	if (!Array.isArray(payload.windows)) return null;

	const pick = (name: string): RateLimitWindow | null => {
		const entry = (payload.windows as unknown[]).find(
			(w): w is Record<string, unknown> =>
				!!w && typeof w === "object" && (w as Record<string, unknown>).name === name && (w as Record<string, unknown>).credit === false,
		);
		if (!entry) return null;
		const used = entry.used_pct;
		if (typeof used !== "number" || !Number.isFinite(used)) return null;
		const resetsAt = entry.resets_at;
		const parsed = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
		return {
			usedPercent: Math.min(100, Math.max(0, used)),
			resetsAtEpochSec: Number.isFinite(parsed) ? Math.round(parsed / 1000) : null,
		};
	};

	return { session: pick("5h"), weekly: pick("weekly"), observedAtMs: nowMs - ageS * 1000 };
}

/** Fixed-argument invocation of `claude auth status --json` (no shell, no interpolation). */
export function buildClaudeAuthStatusInvocation(platform: NodeJS.Platform = process.platform): {
	command: string;
	args: string[];
} {
	if (platform === "win32") {
		return { command: "cmd", args: ["/c", "claude.cmd", "auth", "status", "--json"] };
	}
	return { command: "claude", args: ["auth", "status", "--json"] };
}

function cleanIdentityField(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_IDENTITY_FIELD_LENGTH) return undefined;
	return trimmed;
}

/** Parses `claude auth status --json` stdout, treated as untrusted text. */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		return { kind: "unknown" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unknown" };
	const status = parsed as Record<string, unknown>;
	if (status.loggedIn === false) return { kind: "logged-out" };
	if (status.loggedIn !== true) return { kind: "unknown" };
	const orgId = cleanIdentityField(status.orgId);
	const email = cleanIdentityField(status.email);
	if (orgId === undefined && email === undefined) return { kind: "unknown" };
	const identity: ClaudeIdentity = {};
	if (orgId !== undefined) identity.orgId = orgId;
	if (email !== undefined) identity.email = email;
	return { kind: "logged-in", identity };
}

/** Login keys to try, in order: orgId, email, accountUuid. Non-empty only, de-duplicated case-insensitively. */
export function loginCandidates(identity: ClaudeIdentity): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of [identity.orgId, identity.email, identity.accountUuid]) {
		if (value === undefined || value.length === 0) continue;
		const folded = value.toLowerCase();
		if (seen.has(folded)) continue;
		seen.add(folded);
		out.push(value);
	}
	return out;
}

/** Account-fingerprint check (CR-03 pattern): a 200 must name the login that was sent. */
export function identityMatchesLogin(body: unknown, login: string): boolean {
	if (!body || typeof body !== "object" || Array.isArray(body)) return false;
	const payload = body as Record<string, unknown>;
	const wanted = login.toLowerCase();
	return ["claude_org_uuid", "claude_email", "claude_account_uuid"].some((field) => {
		const value = payload[field];
		return typeof value === "string" && value.toLowerCase() === wanted;
	});
}

/**
 * Cross-field check (WR-02). Quota windows are per account, but the org key matches every account in
 * the org, so a 200 that echoes the login is not proof it is this session's account. Every identity
 * field that both this session and the dashboard know must agree; a field either side lacks is skipped.
 */
export function identityConsistent(body: unknown, identity: ClaudeIdentity): boolean {
	if (!body || typeof body !== "object" || Array.isArray(body)) return false;
	const payload = body as Record<string, unknown>;
	const agrees = (dashboardValue: unknown, sessionValue: string | undefined): boolean =>
		sessionValue === undefined || typeof dashboardValue !== "string" || dashboardValue.toLowerCase() === sessionValue.toLowerCase();
	return (
		agrees(payload.claude_org_uuid, identity.orgId) &&
		agrees(payload.claude_email, identity.email) &&
		agrees(payload.claude_account_uuid, identity.accountUuid)
	);
}

/** `{CLAUDE_CONFIG_DIR or the home directory}/.claude.json`: where the CLI keeps the logged-in account block. */
export function claudeConfigPath(env: NodeJS.ProcessEnv): string {
	const dir = env.CLAUDE_CONFIG_DIR?.trim();
	return join(dir ? dir : homedir(), ".claude.json");
}

/** Reads only the `oauthAccount` block of a `.claude.json` text. Null when it names no account field. */
export function parseClaudeConfigIdentity(text: string): ClaudeIdentity | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const account = (parsed as Record<string, unknown>).oauthAccount;
	if (!account || typeof account !== "object" || Array.isArray(account)) return null;
	const block = account as Record<string, unknown>;
	const orgId = cleanIdentityField(block.organizationUuid);
	const email = cleanIdentityField(block.emailAddress);
	const accountUuid = cleanIdentityField(block.accountUuid);
	const identity: ClaudeIdentity = {};
	if (orgId !== undefined) identity.orgId = orgId;
	if (email !== undefined) identity.email = email;
	if (accountUuid !== undefined) identity.accountUuid = accountUuid;
	return Object.keys(identity).length > 0 ? identity : null;
}

async function readClaudeConfigCapped(path: string): Promise<string> {
	const info = await stat(path);
	if (info.size > CLAUDE_CONFIG_MAX_BYTES) throw new Error("config file too large");
	return readFile(path, "utf8");
}

function outputText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return undefined;
}

/**
 * Resolves this session's Claude identity. `claude auth status --json` first (its stdout counts even
 * when the CLI exits non-zero: a logged-out CLI exits 1 and still prints JSON). Only when the CLI is
 * missing, times out or prints neither logged-in nor logged-out JSON does it read the `oauthAccount`
 * block of `.claude.json`; an explicit `loggedIn:false` never falls back. Null when unresolved.
 * An aborted `signal` kills the child and resolves null without reading the config file (WR-03).
 */
export async function resolveClaudeIdentity(deps: {
	execFileImpl: ExecFileLike;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	readClaudeConfigImpl?: (path: string) => Promise<string>;
	signal?: AbortSignal;
}): Promise<ClaudeIdentity | null> {
	const { command, args } = buildClaudeAuthStatusInvocation(deps.platform);
	let stdout: string | undefined;
	try {
		const result = await deps.execFileImpl(command, args, {
			timeout: CLAUDE_AUTH_STATUS_TIMEOUT_MS,
			env: deps.env,
			windowsHide: true,
			maxBuffer: 64 * 1024,
			...(deps.signal ? { signal: deps.signal } : {}),
		});
		stdout = outputText(result.stdout);
	} catch (error) {
		if (deps.signal?.aborted) return null;
		stdout = outputText((error as { stdout?: unknown } | null)?.stdout);
	}
	if (stdout !== undefined) {
		const status = parseClaudeAuthStatus(stdout);
		if (status.kind === "logged-in") return status.identity;
		if (status.kind === "logged-out") return null;
	}
	try {
		const text = await (deps.readClaudeConfigImpl ?? readClaudeConfigCapped)(claudeConfigPath(deps.env));
		return parseClaudeConfigIdentity(text);
	} catch {
		return null;
	}
}

const execFileAsync = promisify(execFile);

const defaultExecFile: ExecFileLike = (file, args, options) =>
	execFileAsync(file, [...args], { ...options, encoding: "utf8" });

/**
 * The dashboard base URL, or null when the producer must stay off. The session identity is sent in the
 * query string, so only loopback http(s) origins qualify: no credentials, path, query or fragment.
 * `off` (any case) is the kill switch.
 */
export function resolveUsageDashboardBaseUrl(explicit: string | undefined, env: NodeJS.ProcessEnv): string | null {
	const raw = explicit?.trim() || env[USAGE_DASHBOARD_URL_ENV]?.trim() || USAGE_DASHBOARD_DEFAULT_BASE_URL;
	if (raw.toLowerCase() === "off") return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.username !== "" || url.password !== "") return null;
	if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]" && url.hostname !== "::1") return null;
	if (url.pathname !== "" && url.pathname !== "/") return null;
	if (url.search !== "" || url.hash !== "") return null;
	return `${url.protocol}//${url.host}`;
}

/** Reads a response body as text, giving up (null) once it exceeds `maxBytes`. */
async function readBoundedText(res: Response, maxBytes: number): Promise<string | null> {
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		try {
			await res.body?.cancel();
		} catch {
			// nothing to release
		}
		return null;
	}
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			try {
				await reader.cancel();
			} catch {
				// nothing to release
			}
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export class UsageDashboardPoller implements RateLimitFallbackProducer {
	private readonly ref: RateLimitStatusRef;
	private readonly getProvider: () => string | undefined;
	private readonly fetchImpl: FetchLike;
	private readonly execFileImpl: ExecFileLike;
	private readonly now: () => number;
	/** Null = the configured base is not a loopback origin (or `off`): the poller stays inert. */
	private readonly baseUrl: string | null;
	private readonly intervalMs: number;
	private readonly fetchTimeoutMs: number;
	private readonly backoffMs: number;
	private readonly readClaudeConfigImpl: ((path: string) => Promise<string>) | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly debugLog: (line: string) => void;
	private readonly platform: NodeJS.Platform;

	private running = false;
	private generation = 0;
	private inFlight: { gen: number; promise: Promise<void> } | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopController: AbortController | undefined;
	private onChange: (() => void) | undefined;
	/** undefined = not resolved yet; null = resolved, no identity. Cached for the poller's life (D-03: once). */
	private identity: ClaudeIdentity | null | undefined;
	/** The login key that last produced an accepted 200; tried first on later ticks. */
	private preferredLogin: string | undefined;
	/** While identity is null, the earliest time the CLI may be run again. */
	private identityRetryAtMs = 0;
	private consecutiveFailures = 0;

	constructor(
		core: { ref: RateLimitStatusRef; getProvider: () => string | undefined },
		options: UsageDashboardPollerOptions = {},
	) {
		this.ref = core.ref;
		this.getProvider = core.getProvider;
		this.fetchImpl = options.fetchImpl ?? defaultFetch;
		this.execFileImpl = options.execFileImpl ?? defaultExecFile;
		this.now = options.now ?? (() => Date.now());
		this.env = options.env ?? process.env;
		this.baseUrl = resolveUsageDashboardBaseUrl(options.baseUrl, this.env);
		this.debugLog = options.debugLog ?? ((line) => void process.stderr.write(`${line}\n`));
		this.intervalMs = options.intervalMs ?? USAGE_DASHBOARD_POLL_MS;
		this.fetchTimeoutMs = options.fetchTimeoutMs ?? USAGE_DASHBOARD_FETCH_TIMEOUT_MS;
		this.backoffMs = options.backoffMs ?? USAGE_DASHBOARD_BACKOFF_MS;
		this.readClaudeConfigImpl = options.readClaudeConfigImpl;
		this.platform = options.platform ?? process.platform;
	}

	start(onChange: () => void): void {
		if (this.running || this.baseUrl === null) return;
		this.running = true;
		this.generation += 1;
		this.onChange = onChange;
		this.stopController = new AbortController();
		void this.refresh();
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		this.generation += 1;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.stopController?.abort();
		this.stopController = undefined;
		this.onChange = undefined;
	}

	refresh(): Promise<void> {
		if (!this.running) return Promise.resolve();
		if (this.inFlight && this.inFlight.gen === this.generation) return this.inFlight.promise;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		const gen = this.generation;
		const entry: { gen: number; promise: Promise<void> } = {
			gen,
			promise: this.runTick(gen).then((delay) => {
				if (this.inFlight === entry) this.inFlight = undefined;
				if (gen === this.generation && this.running) this.schedule(delay);
			}),
		};
		this.inFlight = entry;
		return entry.promise;
	}

	private schedule(ms: number): void {
		if (!this.running) return;
		this.timer = setTimeout(() => void this.refresh(), ms);
		this.timer.unref?.();
	}

	/** Never rejects: a timer callback must not throw or leave an unhandled rejection. */
	private async runTick(gen: number): Promise<number> {
		try {
			return await this.tick(gen);
		} catch {
			this.debug("failure: network");
			return this.transientFailure(gen);
		}
	}

	/** Emits a fixed outcome token. Never pass identity fields, URLs or response text. */
	private debug(token: string): void {
		if (this.env[USAGE_DASHBOARD_DEBUG_ENV] !== "1") return;
		this.debugLog(`[usage-dashboard] ${token}`);
	}

	private notifyIf(changed: boolean, token: string): void {
		if (!changed) return;
		this.debug(token);
		this.onChange?.();
	}

	private async tick(gen: number): Promise<number> {
		const delay = this.intervalMs;
		// Whatever else happens, a dashboard number never outlives the dashboard's own trust limit.
		this.notifyIf(expireDashboardWindows(this.ref, this.now(), USAGE_DASHBOARD_MAX_AGE_S * 1000), "expired: dashboard windows");

		const controller = this.stopController;
		const baseUrl = this.baseUrl;
		if (!controller || baseUrl === null) return delay;
		if (this.getProvider() !== DASHBOARD_PROVIDER) {
			this.debug("idle: provider");
			return delay;
		}

		if (this.identity === null && this.now() < this.identityRetryAtMs) {
			return this.identityRetryAtMs - this.now();
		}
		if (!this.identity) {
			const resolved = await resolveClaudeIdentity({
				execFileImpl: this.execFileImpl,
				env: this.env,
				platform: this.platform,
				readClaudeConfigImpl: this.readClaudeConfigImpl,
				signal: controller.signal,
			});
			if (gen !== this.generation) {
				// Stopped while resolving: keep a real identity, but never arm the back-off for an aborted lookup.
				if (resolved) this.identity = resolved;
				return delay;
			}
			this.identity = resolved;
			if (!this.identity) this.identityRetryAtMs = this.now() + this.backoffMs;
			this.debug(this.identity ? "identity: resolved" : "identity: unresolved");
			if (!this.identity) return this.dropUnvouched();
		}
		const identity = this.identity;
		const candidates = loginCandidates(identity);
		if (candidates.length === 0) return this.dropUnvouched();
		const preferred = this.preferredLogin?.toLowerCase();
		const ordered = [
			...candidates.filter((c) => c.toLowerCase() === preferred),
			...candidates.filter((c) => c.toLowerCase() !== preferred),
		];

		for (const login of ordered) {
			const url = `${baseUrl}${USAGE_DASHBOARD_QUOTA_PATH}?login=${encodeURIComponent(login)}`;
			this.debug("request");
			const res = await this.fetchImpl(url, {
				headers: { accept: "application/json" },
				redirect: "error", // a redirect is a failure; it is never followed with the identity attached
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.fetchTimeoutMs)]),
			});
			if (gen !== this.generation) return delay;
			this.debug(`http ${res.status}`);
			if (res.status === 404) {
				// This identity is unknown to the dashboard (or the operator logged in as someone else).
				void res.body?.cancel().catch(() => {});
				this.debug("not-found");
				return this.forgetIdentity();
			}
			if (res.status === 409) {
				// More than one account matches this key: try the next one.
				void res.body?.cancel().catch(() => {});
				continue;
			}
			if (!res.ok) {
				void res.body?.cancel().catch(() => {});
				this.debug("failure: network");
				return this.transientFailure(gen);
			}
			const text = await readBoundedText(res, USAGE_DASHBOARD_MAX_BODY_BYTES);
			if (gen !== this.generation) return delay;
			let body: unknown;
			try {
				body = text === null ? undefined : JSON.parse(text);
			} catch {
				body = undefined;
			}
			if (body === undefined) {
				this.debug("failure: body");
				return this.transientFailure(gen);
			}
			if (!identityMatchesLogin(body, login) || !identityConsistent(body, identity)) {
				this.debug("rejected: fingerprint");
				return this.dropUnvouched();
			}

			const reading = mapDashboardQuotaPayload(body, this.now());
			if (!reading) {
				this.debug("rejected: payload");
				return this.transientFailure(gen);
			}
			// Switched away from claude-code while the request was in flight.
			if (this.getProvider() !== DASHBOARD_PROVIDER) return delay;
			this.preferredLogin = login;
			this.consecutiveFailures = 0;
			this.debug("accepted");
			if (applyDashboardReading(this.ref, reading, this.now())) this.onChange?.();
			return delay;
		}
		// Every key matched more than one account: no way to tell which one is ours.
		this.debug("conflict: all logins");
		return this.dropUnvouched();
	}

	/** A poll that produced nothing usable: one is tolerated, the second in a row clears the dashboard values. */
	private transientFailure(gen: number): number {
		if (gen !== this.generation) return this.intervalMs;
		this.consecutiveFailures += 1;
		if (this.consecutiveFailures >= USAGE_DASHBOARD_FAILURES_BEFORE_CLEAR) {
			this.notifyIf(clearDashboardWindows(this.ref), "cleared: dashboard windows");
		}
		return this.intervalMs;
	}

	/** The dashboard cannot vouch for this session's account: show nothing rather than a neighbour's numbers. */
	private dropUnvouched(): number {
		this.consecutiveFailures = 0;
		this.notifyIf(clearDashboardWindows(this.ref), "cleared: dashboard windows");
		return this.backoffMs;
	}

	/** 404: forget the cached identity so it is resolved again after the back-off. */
	private forgetIdentity(): number {
		const wait = this.dropUnvouched();
		this.identity = null;
		this.preferredLogin = undefined;
		this.identityRetryAtMs = this.now() + this.backoffMs;
		return wait;
	}
}

export function createUsageDashboardPoller(
	options: UsageDashboardOptions | undefined,
	core: { ref: RateLimitStatusRef; getProvider: () => string | undefined },
): UsageDashboardPoller | undefined {
	if (options === false) return undefined;
	const env = options?.env ?? process.env;
	if (resolveUsageDashboardBaseUrl(options?.baseUrl, env) === null) {
		// `off` is a deliberate switch; anything else that resolved to null was a rejected override (typo, non-loopback).
		const override = options?.baseUrl?.trim() || env[USAGE_DASHBOARD_URL_ENV]?.trim();
		if (override && override.toLowerCase() !== "off" && env[USAGE_DASHBOARD_DEBUG_ENV] === "1") {
			const log = options?.debugLog ?? ((line: string) => void process.stderr.write(`${line}\n`));
			log("[usage-dashboard] disabled: base-url"); // fixed token only: the rejected URL is never echoed
		}
		return undefined;
	}
	return new UsageDashboardPoller(core, options ?? {});
}
