// Project/App: gsd-pi
// File Purpose: Read-only liveness monitor for spawned y-pi-gsd drivers. It turns the shared registry
// (`session-instances.json`) into a widget snapshot, raises one death alert record per driver death, and
// never writes the registry and never signals a process (RD-RESEARCH-OPEN 3). Dismissal and alert state
// live in memory only.

import { basename } from "node:path";
import {
	classifyDrivers,
	createProcessProbes,
	driverRegistryPath,
	formatDriverAge,
	isDriverVisible,
	readDriverRegistry,
	sanitizeDriverText,
	summarizeDrivers,
	type ClassifiedDriver,
	type ClassifyContext,
	type DriverProcessProbes,
	type DriverRegistryRead,
	type DriverSummary,
} from "./gsd-driver-registry.js";

/** Widget refresh cadence (UI-SPEC U1). */
export const DRIVER_WIDGET_REFRESH_MS = 3000;
/** A registry read younger than this is reused by `refresh()` (never by `listAll()`). */
export const REGISTRY_CACHE_TTL_MS = 2000;
/** At most this many age-prefixed death alerts are emitted for deaths that predate the TUI session. */
export const MAX_STARTUP_DEATH_ALERTS = 3;

export type DriverWidgetSnapshot =
	| { kind: "pending" }
	| { kind: "unreadable"; path: string }
	| { kind: "summary"; summary: DriverSummary; nowMs: number };

export type DriverListing =
	| { kind: "ok"; path: string; drivers: ClassifiedDriver[]; /** Clock reading the listing was classified at (ages in /drivers use it). */ nowMs?: number }
	| { kind: "unreadable"; path: string; why: string };

/** Plain, already-sanitised chat alert text. The host styles and appends it; it never goes through showError. */
export interface DriverDeathAlert {
	headline: string;
	details: string[];
}

export interface DriverLivenessMonitorOptions {
	projectRoot: string;
	registryPath?: string;
	probes?: DriverProcessProbes;
	now?: () => number;
	onAlert?: (alert: DriverDeathAlert) => void;
}

/**
 * Age text the widget displays for a driver: time since `exit.at` for a death, otherwise the live-claim age.
 * Shared by the widget (render) and the monitor (change signature) so they cannot disagree.
 */
export function driverAgeText(d: ClassifiedDriver, nowMs: number): string | null {
	const liveness = d.liveness;
	if (liveness.kind === "died") return liveness.atMs === null ? null : formatDriverAge(nowMs - liveness.atMs);
	return formatDriverAge(liveness.sinceMs);
}

function snapshotSignature(snapshot: DriverWidgetSnapshot): string {
	if (snapshot.kind !== "summary") return snapshot.kind;
	const { summary, nowMs } = snapshot;
	if (summary.kind === "none") return "none";
	const worst = summary.worst;
	const worstPart =
		worst === null
			? "-"
			: [
					worst.rowKey,
					worst.liveness.kind,
					worst.liveness.kind === "stale" ? worst.liveness.why : "",
					worst.liveness.kind === "died" ? worst.liveness.reason : "",
					driverAgeText(worst, nowMs) ?? "?",
				].join("|");
	return `drivers#${worstPart}#${summary.relatedCount}#${summary.others.count}#${summary.others.worst ?? "-"}`;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function localClock(ms: number): string {
	const date = new Date(ms);
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function deathAlert(d: ClassifiedDriver, headlinePrefix: string): DriverDeathAlert {
	const liveness = d.liveness;
	const reason = liveness.kind === "died" ? sanitizeDriverText(liveness.reason) : "";
	const parts = [`  pid ${d.row.pid}`, `project ${sanitizeDriverText(basename(d.canonicalDir))}`];
	if (liveness.kind === "died" && liveness.atMs !== null) parts.push(localClock(liveness.atMs));
	parts.push("/drivers for details");
	return { headline: `${headlinePrefix}${reason}`, details: [parts.join(" · ")] };
}

export class DriverLivenessMonitor {
	private readonly projectRoot: string;
	private readonly registryPathOverride: string | undefined;
	private readonly probes: DriverProcessProbes;
	private readonly now: () => number;
	private readonly onAlert: ((alert: DriverDeathAlert) => void) | undefined;

	private snapshot: DriverWidgetSnapshot = { kind: "pending" };
	private lastSignature = "";
	private inFlight: Promise<boolean> | null = null;
	private cached: { path: string; atMs: number; read: DriverRegistryRead } | null = null;
	/** Dismissed death identities (driverRowKey) for this TUI session only; never persisted. */
	private readonly dismissed = new Set<string>();
	/** Death identities already announced in this session (dedupe key: canonicalDir|pid|startTime). */
	private readonly alerted = new Set<string>();
	private startupDone = false;
	private lastDrivers: ClassifiedDriver[] = [];
	private lastNowMs = 0;

	constructor(options: DriverLivenessMonitorOptions) {
		this.projectRoot = options.projectRoot;
		this.registryPathOverride = options.registryPath;
		this.probes = options.probes ?? createProcessProbes();
		this.now = options.now ?? Date.now;
		this.onAlert = options.onAlert;
	}

	getSnapshot(): DriverWidgetSnapshot {
		return this.snapshot;
	}

	/** Re-read (or reuse a young read of) the registry and recompute the snapshot. Never rejects. */
	refresh(): Promise<boolean> {
		if (this.inFlight) return this.inFlight;
		const promise: Promise<boolean> = this.doRefresh().finally(() => {
			if (this.inFlight === promise) this.inFlight = null;
		});
		this.inFlight = promise;
		return promise;
	}

	private registryPath(): string {
		return this.registryPathOverride ?? driverRegistryPath();
	}

	private classifyContext(nowMs: number): ClassifyContext {
		const probes = this.probes;
		return {
			nowMs,
			isPidAlive: (pid) => probes.isPidAlive(pid),
			getStartTimeMs: (pid) => probes.getStartTimeMs(pid),
			isOwnerAlive: (ownerPid) => probes.isOwnerAlive(ownerPid),
		};
	}

	private async doRefresh(): Promise<boolean> {
		try {
			const path = this.registryPath();
			const nowMs = this.now();
			let read: DriverRegistryRead;
			if (this.cached !== null && this.cached.path === path && nowMs - this.cached.atMs < REGISTRY_CACHE_TTL_MS) {
				read = this.cached.read;
			} else {
				read = readDriverRegistry(path);
				this.cached = { path, atMs: nowMs, read };
			}

			if (read.kind === "unreadable") {
				return this.publish({ kind: "unreadable", path });
			}

			// Tombstone pids are never probed: only live-claim rows get a start-time prefetch.
			const livePids = read.entries.filter((e) => e.row.exit === undefined).map((e) => e.row.pid);
			await this.probes.prefetchStartTimes([...new Set(livePids)]);

			const drivers = classifyDrivers(read.entries, {
				ctx: this.classifyContext(nowMs),
				projectRoot: this.projectRoot,
				dismissed: this.dismissed,
			});
			this.lastDrivers = drivers;
			this.lastNowMs = nowMs;
			this.detectDeaths(drivers, nowMs);
			const summary = summarizeDrivers(drivers, nowMs);
			return this.publish({ kind: "summary", summary, nowMs });
		} catch {
			return false;
		}
	}

	private publish(snapshot: DriverWidgetSnapshot): boolean {
		this.snapshot = snapshot;
		const signature = snapshotSignature(snapshot);
		const changed = signature !== this.lastSignature;
		this.lastSignature = signature;
		return changed;
	}

	private emit(alert: DriverDeathAlert): void {
		try {
			this.onAlert?.(alert);
		} catch {
			// an alert sink failure must never break the refresh
		}
	}

	/**
	 * One alert per visible death, ever (per session). Deaths already present on the first successful read are
	 * capped at MAX_STARTUP_DEATH_ALERTS age-prefixed alerts plus one summary; later deaths alert immediately.
	 */
	private detectDeaths(drivers: readonly ClassifiedDriver[], nowMs: number): void {
		const fresh: ClassifiedDriver[] = [];
		for (const d of drivers) {
			if (d.liveness.kind !== "died" || !isDriverVisible(d, nowMs) || this.alerted.has(d.rowKey)) continue;
			this.alerted.add(d.rowKey);
			fresh.push(d);
		}

		if (this.startupDone) {
			for (const d of fresh) this.emit(deathAlert(d, "\u2715 Driver died: "));
			return;
		}
		this.startupDone = true;

		const exitedAt = (d: ClassifiedDriver): number =>
			d.liveness.kind === "died" && d.liveness.atMs !== null ? d.liveness.atMs : Number.NEGATIVE_INFINITY;
		fresh.sort((a, b) => Number(b.related) - Number(a.related) || exitedAt(b) - exitedAt(a));

		for (const d of fresh.slice(0, MAX_STARTUP_DEATH_ALERTS)) {
			const age = driverAgeText(d, nowMs);
			this.emit(deathAlert(d, age === null ? "\u2715 Driver died: " : `\u2715 Driver died ${age} ago: `));
		}
		const remaining = fresh.length - MAX_STARTUP_DEATH_ALERTS;
		if (remaining > 0) {
			this.emit({
				headline: remaining === 1 ? "\u2715 1 more driver died; run /drivers" : `\u2715 ${remaining} more drivers died; run /drivers`,
				details: [],
			});
		}
	}

	/**
	 * Hide every currently visible died row (related or not) from the widget for this TUI session. In memory only:
	 * the registry is never written. Returns how many were dismissed.
	 */
	dismissDied(): number {
		let count = 0;
		for (const d of this.lastDrivers) {
			if (d.liveness.kind === "died" && isDriverVisible(d, this.lastNowMs)) {
				this.dismissed.add(d.rowKey);
				count++;
			}
		}
		if (count > 0) {
			this.lastDrivers = this.lastDrivers.map((d) => (this.dismissed.has(d.rowKey) ? { ...d, dismissed: true } : d));
			if (this.snapshot.kind === "summary") {
				// lastSignature is left stale on purpose so the next refresh reports a change and the widget repaints.
				this.snapshot = {
					kind: "summary",
					summary: summarizeDrivers(this.lastDrivers, this.lastNowMs),
					nowMs: this.lastNowMs,
				};
			}
		}
		return count;
	}

	/**
	 * Fresh, machine-wide, classified listing for `/drivers`: always re-reads (bypassing the cache), sorted died
	 * (newest exit first, unknown last) -> stale -> running (oldest first). Emits no alerts.
	 */
	async listAll(): Promise<DriverListing> {
		const path = this.registryPath();
		const nowMs = this.now();
		const read = readDriverRegistry(path);
		this.cached = { path, atMs: nowMs, read };
		if (read.kind === "unreadable") return { kind: "unreadable", path, why: read.why };

		const livePids = read.entries.filter((e) => e.row.exit === undefined).map((e) => e.row.pid);
		await this.probes.prefetchStartTimes([...new Set(livePids)]);

		const drivers = classifyDrivers(read.entries, {
			ctx: this.classifyContext(nowMs),
			projectRoot: this.projectRoot,
			dismissed: this.dismissed,
		});
		const rank = { died: 0, stale: 1, running: 2 } as const;
		const diedAt = (d: ClassifiedDriver): number =>
			d.liveness.kind === "died" && d.liveness.atMs !== null ? d.liveness.atMs : Number.NEGATIVE_INFINITY;
		const since = (d: ClassifiedDriver): number =>
			d.liveness.kind !== "died" && d.liveness.sinceMs !== null ? d.liveness.sinceMs : Number.NEGATIVE_INFINITY;
		drivers.sort((a, b) => {
			const byKind = rank[a.liveness.kind] - rank[b.liveness.kind];
			if (byKind !== 0) return byKind;
			if (a.liveness.kind === "died") return diedAt(b) - diedAt(a);
			return since(b) - since(a);
		});
		return { kind: "ok", path, drivers, nowMs };
	}
}
