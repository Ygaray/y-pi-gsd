/**
 * Claude-code fallback rate-limit producer: polls the loopback UsageDashboard (D-01, D-03, D-04).
 *
 * The claude-code backend sends no rate-limit response headers and the SDK only emits a
 * `rate_limit_event` when its own info changes, so before the first event the footer would show
 * `unavailable`. The UsageDashboard (127.0.0.1:8820, contract schema_version 1) already holds the
 * same 5h / weekly numbers; this producer maps them onto the shared `RateLimitStatusRef`.
 *
 * Identity (D-03): this session's login comes from `claude auth status --json` -- the only
 * identity source the externalCli backend has. This module reads nothing else and never touches
 * credential files.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RateLimitWindow } from "./rate-limit-headers.js";
import {
	applyDashboardReading,
	clearDashboardWindows,
	DASHBOARD_PROVIDER,
	type DashboardReading,
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
	options: { timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string | Buffer }>;

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

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

/** Resolves this session's Claude identity through the CLI. Null when it cannot be established. */
export async function resolveClaudeIdentity(deps: {
	execFileImpl: ExecFileLike;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
}): Promise<ClaudeIdentity | null> {
	const { command, args } = buildClaudeAuthStatusInvocation(deps.platform);
	try {
		const { stdout } = await deps.execFileImpl(command, args, {
			timeout: CLAUDE_AUTH_STATUS_TIMEOUT_MS,
			env: deps.env,
			windowsHide: true,
			maxBuffer: 64 * 1024,
		});
		const text = typeof stdout === "string" ? stdout : stdout.toString("utf8");
		const status = parseClaudeAuthStatus(text);
		return status.kind === "logged-in" ? status.identity : null;
	} catch {
		return null;
	}
}

const execFileAsync = promisify(execFile);

const defaultExecFile: ExecFileLike = (file, args, options) =>
	execFileAsync(file, [...args], { ...options, encoding: "utf8" });

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export class UsageDashboardPoller implements RateLimitFallbackProducer {
	private readonly ref: RateLimitStatusRef;
	private readonly getProvider: () => string | undefined;
	private readonly fetchImpl: FetchLike;
	private readonly execFileImpl: ExecFileLike;
	private readonly now: () => number;
	private readonly baseUrl: string;
	private readonly intervalMs: number;
	private readonly fetchTimeoutMs: number;
	private readonly env: NodeJS.ProcessEnv;
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

	constructor(
		core: { ref: RateLimitStatusRef; getProvider: () => string | undefined },
		options: UsageDashboardPollerOptions = {},
	) {
		this.ref = core.ref;
		this.getProvider = core.getProvider;
		this.fetchImpl = options.fetchImpl ?? defaultFetch;
		this.execFileImpl = options.execFileImpl ?? defaultExecFile;
		this.now = options.now ?? (() => Date.now());
		this.baseUrl = (options.baseUrl ?? USAGE_DASHBOARD_DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.intervalMs = options.intervalMs ?? USAGE_DASHBOARD_POLL_MS;
		this.fetchTimeoutMs = options.fetchTimeoutMs ?? USAGE_DASHBOARD_FETCH_TIMEOUT_MS;
		this.env = options.env ?? process.env;
		this.platform = options.platform ?? process.platform;
	}

	start(onChange: () => void): void {
		if (this.running) return;
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
			return this.intervalMs;
		}
	}

	private async tick(gen: number): Promise<number> {
		const delay = this.intervalMs;
		const controller = this.stopController;
		if (!controller) return delay;
		if (this.getProvider() !== DASHBOARD_PROVIDER) return delay;

		if (this.identity === undefined) {
			this.identity = await resolveClaudeIdentity({
				execFileImpl: this.execFileImpl,
				env: this.env,
				platform: this.platform,
			});
			if (gen !== this.generation) return delay;
		}
		const identity = this.identity;
		if (!identity) return delay;
		const candidates = loginCandidates(identity);
		if (candidates.length === 0) return delay;
		const preferred = this.preferredLogin?.toLowerCase();
		const ordered = [
			...candidates.filter((c) => c.toLowerCase() === preferred),
			...candidates.filter((c) => c.toLowerCase() !== preferred),
		];

		for (const login of ordered) {
			const url = `${this.baseUrl}${USAGE_DASHBOARD_QUOTA_PATH}?login=${encodeURIComponent(login)}`;
			const res = await this.fetchImpl(url, {
				headers: { accept: "application/json" },
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.fetchTimeoutMs)]),
			});
			if (gen !== this.generation) return delay;
			if (res.status === 409) {
				// More than one account matches this key: try the next one.
				void res.body?.cancel().catch(() => {});
				continue;
			}
			if (!res.ok) return delay;
			const body: unknown = await res.json();
			if (gen !== this.generation) return delay;
			if (!identityMatchesLogin(body, login)) return this.dropUnvouched(delay);

			const reading = mapDashboardQuotaPayload(body, this.now());
			if (!reading) return delay;
			// Switched away from claude-code while the request was in flight.
			if (this.getProvider() !== DASHBOARD_PROVIDER) return delay;
			this.preferredLogin = login;
			if (applyDashboardReading(this.ref, reading, this.now())) this.onChange?.();
			return delay;
		}
		// Every key matched more than one account: no way to tell which one is ours.
		return this.dropUnvouched(delay);
	}

	/** The dashboard cannot vouch for this session's account: show nothing rather than a neighbour's numbers. */
	private dropUnvouched(delay: number): number {
		if (clearDashboardWindows(this.ref)) this.onChange?.();
		return delay;
	}
}

export function createUsageDashboardPoller(
	options: UsageDashboardOptions | undefined,
	core: { ref: RateLimitStatusRef; getProvider: () => string | undefined },
): UsageDashboardPoller | undefined {
	if (options === false) return undefined;
	return new UsageDashboardPoller(core, options ?? {});
}
