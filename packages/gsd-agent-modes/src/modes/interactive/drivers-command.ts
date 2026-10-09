// Project/App: gsd-pi
// File Purpose: Operator /drivers command - list, stop and dismiss y-pi-gsd drivers from the session registry;
// never signals a process and never writes the registry (stop goes only through the injected DriverControlPort).

import { homedir } from "node:os";
import { basename } from "node:path";
import { type Component, padRight, Text, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { DRIVER_STATE_STYLE } from "./components/gsd-driver-liveness-widget.js";
import type { DriverListing } from "./components/gsd-driver-liveness-monitor.js";
import { formatDriverAge, sanitizeDriverText, type ClassifiedDriver } from "./components/gsd-driver-registry.js";
import { SelectSubmenu } from "./components/settings-selector.js";
import type { DriverControlPort } from "./driver-control.js";

export const DRIVERS_USAGE = "Usage: /drivers [list] | /drivers stop <n> | /drivers dismiss";
/** At most this many rows are listed; only running rows beyond the cap collapse. */
export const MAX_LISTED_DRIVERS = 20;
/** Cap for server-supplied error text echoed into the transcript. */
const MAX_ERROR_CHARS = 120;

/** The slice of the liveness monitor `/drivers` needs. */
export interface DriverLivenessCommandPort {
	listAll(): Promise<DriverListing>;
	dismissDied(): number;
}

export interface DriversCommandContext {
	driverLiveness: DriverLivenessCommandPort;
	/** Undefined in entry points that do not bind the stop port. */
	driverControl?: DriverControlPort;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	appendChatBlock(component: Component): void;
	showDriverAlert(headline: string, details?: readonly string[]): void;
	requestRender(): void;
}

/** A pre-built line, or a width-aware builder (used for head-truncated paths). */
export type DriverListingLine = string | ((width: number) => string);

/** Chat block holding the listing: every line is cut to the render width so a table row never wraps. */
export class DriverListingBlock implements Component {
	constructor(private readonly lines: readonly DriverListingLine[]) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		return this.lines.map((line) => truncateToWidth(typeof line === "function" ? line(width) : line, width, "…"));
	}

	invalidate(): void {}
}

// ---------------------------------------------------------------------------
// Last listing: index -> driver for the stoppable rows shown by the most recent `/drivers`
// ---------------------------------------------------------------------------

const lastListings = new WeakMap<object, Map<number, ClassifiedDriver>>();

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const INDENT = "  ";
const DETAIL_INDENT = 5;

function dim(text: string): string {
	return theme.fg("dim", text);
}

function tildePath(path: string): string {
	const home = homedir();
	if (home.length > 1 && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
	return path;
}

function projectName(d: ClassifiedDriver): string {
	return sanitizeDriverText(basename(d.canonicalDir)) || "-";
}

function displayPath(d: ClassifiedDriver): string {
	return sanitizeDriverText(tildePath(d.canonicalDir));
}

/** Cut from the head with a leading ellipsis so the distinguishing tail of a path stays visible. */
function headTruncate(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	let tail = text;
	while (tail.length > 0 && visibleWidth(tail) + 1 > maxWidth) tail = tail.slice(1);
	return `…${tail}`;
}

function cell(text: string, width: number, style?: (s: string) => string): string {
	const padded = padRight(text, width);
	if (!style) return padded;
	const clipped = padded.trimEnd();
	return style(clipped) + " ".repeat(Math.max(0, visibleWidth(padded) - visibleWidth(clipped)));
}

function stateCell(d: ClassifiedDriver): string {
	const style = DRIVER_STATE_STYLE[d.liveness.kind];
	const tone = style.tone;
	const text = `${style.glyph} ${style.word}`;
	const styled = (s: string): string => {
		const colored = tone === null ? dim(s) : theme.fg(tone, s);
		return d.liveness.kind === "running" ? colored : theme.bold(colored);
	};
	return cell(text, 10, styled);
}

function ageText(d: ClassifiedDriver, nowMs: number): string | null {
	const liveness = d.liveness;
	if (d.row.exit !== undefined) {
		return liveness.kind === "died" && liveness.atMs !== null ? formatDriverAge(nowMs - liveness.atMs) : null;
	}
	const startMs = Date.parse(d.row.startTime);
	return Number.isFinite(startMs) ? formatDriverAge(nowMs - startMs) : null;
}

function supervisorText(d: ClassifiedDriver): string {
	return d.supervisor === "none" ? "-" : d.supervisor;
}

function sessionText(d: ClassifiedDriver): string {
	const id = sanitizeDriverText(d.row.sessionId).slice(0, 8);
	return id.length > 0 ? id : "-";
}

function isTombstone(d: ClassifiedDriver): boolean {
	return d.row.exit !== undefined;
}

/**
 * Pick the rows to show. Every died and stale row is kept; running rows fill the remaining slots up to
 * MAX_LISTED_DRIVERS in the listing's sort order, and the rest are counted as hidden.
 */
function selectRows(drivers: readonly ClassifiedDriver[]): { shown: ClassifiedDriver[]; hiddenRunning: number } {
	const attention = drivers.filter((d) => d.liveness.kind !== "running");
	const running = drivers.filter((d) => d.liveness.kind === "running");
	const slots = Math.max(0, MAX_LISTED_DRIVERS - attention.length);
	const shownRunning = running.slice(0, slots);
	const shownSet = new Set<ClassifiedDriver>([...attention, ...shownRunning]);
	// Preserve the listing's sort order (died -> stale -> running).
	return { shown: drivers.filter((d) => shownSet.has(d)), hiddenRunning: running.length - shownRunning.length };
}

function heading(text: string): string {
	return theme.bold(text);
}

function buildListingLines(
	listing: DriverListing,
): { lines: DriverListingLine[]; stoppable: Map<number, ClassifiedDriver> } {
	const stoppable = new Map<number, ClassifiedDriver>();

	if (listing.kind === "unreadable") {
		return {
			lines: [
				heading("Drivers · this machine"),
				"  Registry unreadable (missing permissions, corrupt, or over the 256 KiB cap). Nothing was changed.",
				dim(`  ${sanitizeDriverText(tildePath(listing.path))}`),
			],
			stoppable,
		};
	}

	const { drivers } = listing;
	const nowMs = listing.nowMs ?? Date.now();
	const lines: DriverListingLine[] = [heading(`Drivers · this machine (${drivers.length})`)];
	if (drivers.length === 0) {
		lines.push("  No drivers registered. Nothing to stop.");
		return { lines, stoppable };
	}

	lines.push(dim(`${INDENT}#  STATE     PID     SESSION   AGE   SUPERVISOR  PROJECT`));

	const { shown, hiddenRunning } = selectRows(drivers);
	let nextIndex = 1;
	for (const d of shown) {
		let marker = "·";
		if (!isTombstone(d)) {
			marker = String(nextIndex);
			// Hidden running rows are never numbered, so they cannot be stopped by index until relisted.
			stoppable.set(nextIndex, d);
			nextIndex++;
		}
		const row =
			INDENT +
			cell(marker, 3) +
			stateCell(d) +
			cell(String(d.row.pid), 8) +
			cell(sessionText(d), 10) +
			cell(ageText(d, nowMs) ?? "-", 6) +
			cell(supervisorText(d), 12) +
			projectName(d);
		lines.push(row);

		const detailIndent = " ".repeat(DETAIL_INDENT);
		if (d.liveness.kind === "died") {
			const reason = `${d.dismissed ? "(dismissed) " : ""}${sanitizeDriverText(d.liveness.reason)}`;
			const exitedAge = d.liveness.atMs !== null ? formatDriverAge(nowMs - d.liveness.atMs) : null;
			const suffix = exitedAge !== null ? dim(` · exited ${exitedAge} ago`) : "";
			lines.push(`${detailIndent}${theme.fg("error", reason)}${suffix}`);
		} else {
			const path = displayPath(d);
			lines.push((width) => `${detailIndent}${dim(headTruncate(path, width - DETAIL_INDENT))}`);
		}
	}

	if (hiddenRunning > 0) lines.push(dim(`  … and ${hiddenRunning} more running`));

	const anyRunning = drivers.some((d) => d.liveness.kind === "running");
	// Only offer to hide died rows that are not already hidden.
	const anyDied = drivers.some((d) => d.liveness.kind === "died" && !d.dismissed);
	const footer: string[] = [];
	if (stoppable.size > 0) footer.push("Stop one with /drivers stop <n>.");
	// A died row with no recorded exit never ages out of the registry on its own; stopping it records the exit
	// (no signal), after which the normal retention applies. Say so, since the TUI itself cannot clear it.
	const unreconciledDied = [...stoppable.values()].some((d) => d.liveness.kind === "died");
	if (anyDied) footer.push("Hide died drivers with /drivers dismiss.");
	if (anyRunning || footer.length > 0 || unreconciledDied) lines.push("");
	if (anyRunning) {
		lines.push(dim("● running = process alive and supervised; it does not mean the driver is making progress."));
	}
	if (footer.length > 0) lines.push(dim(footer.join(" ")));
	if (unreconciledDied) {
		lines.push(dim("A died driver with no recorded exit stays listed until you record it with /drivers stop <n>."));
	}

	return { lines, stoppable };
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

function rowChangedWarning(n: number): string {
	return `Driver #${n} changed since it was listed (pid or state differs). Nothing was stopped. Run /drivers to refresh.`;
}

function noEntryWarning(n: number): string {
	return `Driver #${n} is no longer registered. Nothing was stopped. Run /drivers to refresh.`;
}

function isLiveClaim(d: ClassifiedDriver): boolean {
	return d.liveness.kind !== "died";
}

function confirmationDescription(d: ClassifiedDriver): string {
	const pid = d.row.pid;
	const project = projectName(d);
	if (!isLiveClaim(d)) {
		return `Driver pid ${pid} for ${project} is not running. This only records it as exited; no process is signalled.`;
	}
	let supervisor: string;
	if (d.supervisor === "alive" && d.row.ownerPid !== undefined) {
		supervisor = `Its supervising MCP server (pid ${d.row.ownerPid}) is still running and will report the exit.`;
	} else if (d.supervisor === "none") {
		// No ownerPid on the row (written before supervisors were recorded): the supervisor is unknown, not absent.
		supervisor = "Its supervising MCP server is unknown (older registry row).";
	} else {
		supervisor = "No supervising MCP server is running.";
	}
	return `Stops only the driver process (pid ${pid}) for ${project}, ${displayPath(d)}. ${supervisor} Its in-flight sub-processes are not tracked and may finish on their own.`;
}

async function startStop(n: number, ctx: DriversCommandContext): Promise<void> {
	const listed = lastListings.get(ctx.driverLiveness);
	if (listed === undefined) {
		ctx.showWarning("Run /drivers first, then /drivers stop <n>.");
		return;
	}
	const target = listed.get(n);
	if (target === undefined) {
		ctx.showWarning(`No stoppable driver #${n} in the last listing. Run /drivers to refresh.`);
		return;
	}
	if (ctx.driverControl === undefined) {
		ctx.showDriverAlert("\u2715 Stopping drivers is unavailable in this entry point. Nothing was stopped.", [
			"  Start y-pi-gsd with the standard y-pi-gsd command to stop drivers.",
		]);
		return;
	}

	// Re-read before confirming: the listing may be stale and a pid can be recycled (T-42-02).
	const fresh = await ctx.driverLiveness.listAll();
	if (fresh.kind === "unreadable") {
		ctx.showWarning(rowChangedWarning(n));
		return;
	}
	const current = fresh.drivers.find((d) => d.canonicalDir === target.canonicalDir);
	if (current === undefined) {
		ctx.showWarning(noEntryWarning(n));
		return;
	}
	if (
		current.row.pid !== target.row.pid ||
		current.row.startTime !== target.row.startTime ||
		isTombstone(current)
	) {
		ctx.showWarning(rowChangedWarning(n));
		return;
	}

	const live = isLiveClaim(current);
	const pid = current.row.pid;
	ctx.showSelector((done) => {
		const selector = new SelectSubmenu(
			`Stop driver #${n}?`,
			confirmationDescription(current),
			[
				{ value: "cancel", label: "Cancel, keep driver running", description: "Leave it as is" },
				{
					value: "stop",
					label: live ? `Stop driver pid ${pid}` : `Record pid ${pid} as exited`,
					description: live ? "Registry-first stop of that one pid" : "No process is signalled",
				},
			],
			// Cancel is preselected: Enter alone never stops anything.
			"cancel",
			(value) => {
				done();
				if (value === "stop") {
					void runDriverStop({ index: n, driver: current }, ctx);
				} else {
					ctx.showStatus("Stop cancelled. Nothing was stopped.");
				}
			},
			() => {
				done();
				ctx.showStatus("Stop cancelled. Nothing was stopped.");
			},
		);
		return { component: selector, focus: selector };
	});
}

function successBlock(first: string, second?: string): Text {
	const lines = [first];
	if (second !== undefined) lines.push(second);
	return new Text(lines.join("\n"), 1, 0);
}

/**
 * Execute a confirmed stop through the injected port and report an honest outcome. Never rejects. A success line
 * is printed only when the typed outcome is stopped or dead-reconciled AND a fresh re-read shows no live claim
 * for that pid (T-42-04). The TUI never signals a process and never writes the registry.
 */
export async function runDriverStop(
	target: { index: number; driver: ClassifiedDriver },
	ctx: DriversCommandContext,
): Promise<void> {
	const { index: n, driver } = target;
	const pid = driver.row.pid;
	const project = projectName(driver);

	try {
		const port = ctx.driverControl;
		if (port === undefined) {
			ctx.showDriverAlert("\u2715 Stopping drivers is unavailable in this entry point. Nothing was stopped.", [
				"  Start y-pi-gsd with the standard y-pi-gsd command to stop drivers.",
			]);
			return;
		}

		ctx.showStatus(`Stopping driver #${n} (pid ${pid})\u2026`);

		let result: Awaited<ReturnType<DriverControlPort["stopDriver"]>>;
		try {
			result = await port.stopDriver(driver.row.projectDir, { pid, startTime: driver.row.startTime });
		} catch (error) {
			const message = sanitizeDriverText(error instanceof Error ? error.message : String(error), MAX_ERROR_CHARS);
			ctx.showDriverAlert(`\u2715 Stop failed: ${message}`, ["  Nothing is confirmed stopped. Run /drivers to check."]);
			return;
		}

		switch (result.outcome) {
			case "stopped":
			case "dead-reconciled": {
				const fresh = await ctx.driverLiveness.listAll();
				if (fresh.kind === "unreadable") {
					ctx.showDriverAlert(
						`\u2715 Stop reported success for driver pid ${pid}, but the registry could not be re-read to confirm.`,
						["  Run /drivers to re-check."],
					);
					return;
				}
				const stillClaimed = fresh.drivers.some(
					(d) => d.canonicalDir === driver.canonicalDir && d.row.exit === undefined && d.row.pid === pid,
				);
				if (stillClaimed) {
					ctx.showDriverAlert(`\u2715 Stop reported success but driver pid ${pid} still looks alive.`, [
						"  Run /drivers to re-check.",
					]);
					return;
				}
				if (result.outcome === "stopped") {
					ctx.appendChatBlock(
						successBlock(
							theme.fg("success", `Stopped driver pid ${pid} \u00b7 ${project}`),
							dim("Its in-flight sub-processes are not tracked and may finish on their own."),
						),
					);
				} else {
					ctx.appendChatBlock(successBlock(`Driver pid ${pid} was not running; recorded as exited.`));
				}
				return;
			}
			case "kill-failed": {
				const error = sanitizeDriverText(result.error ?? "unknown error", MAX_ERROR_CHARS);
				ctx.showDriverAlert(`\u2715 Could not stop driver pid ${pid}: ${error}`, [
					"  The registry row was kept so you can retry. Run /drivers, then /drivers stop <n>.",
				]);
				return;
			}
			case "no-entry":
				ctx.showWarning(noEntryWarning(n));
				return;
			case "row-changed":
				ctx.showWarning(rowChangedWarning(n));
				return;
			case "busy":
				ctx.showWarning(`A start or stop for ${project} is in progress. Nothing was stopped; retry in a moment.`);
				return;
			default:
				ctx.showDriverAlert(
					`\u2715 Stop failed: unexpected result ${sanitizeDriverText(String((result as { outcome: unknown }).outcome), 40)}`,
					["  Nothing is confirmed stopped. Run /drivers to check."],
				);
		}
	} catch (error) {
		// Last-resort guard (for example a failed re-read): the caller is a fire-and-forget promise.
		const message = sanitizeDriverText(error instanceof Error ? error.message : String(error), MAX_ERROR_CHARS);
		ctx.showDriverAlert(`\u2715 Stop failed: ${message}`, ["  Nothing is confirmed stopped. Run /drivers to check."]);
	}
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

async function showListing(ctx: DriversCommandContext): Promise<void> {
	const listing = await ctx.driverLiveness.listAll();
	const { lines, stoppable } = buildListingLines(listing);
	lastListings.set(ctx.driverLiveness, stoppable);
	ctx.appendChatBlock(new DriverListingBlock(lines));
}

export async function handleDriversCommand(text: string, ctx: DriversCommandContext): Promise<void> {
	const tokens = text.trim().split(/\s+/);
	const sub = tokens[1];

	if (sub === undefined || (sub === "list" && tokens.length === 2)) {
		await showListing(ctx);
		return;
	}

	if (sub === "dismiss" && tokens.length === 2) {
		const n = ctx.driverLiveness.dismissDied();
		// Dismissal is in-memory for this TUI session only; the monitor does not request a render itself.
		ctx.showStatus(
			n > 0 ? `Dismissed ${n} died driver${n === 1 ? "" : "s"}. They stay listed in /drivers until they are cleaned up.` : "No died drivers to dismiss.",
		);
		ctx.requestRender();
		return;
	}

	if (sub === "stop" && tokens.length === 3 && /^\d+$/.test(tokens[2])) {
		await startStop(Number(tokens[2]), ctx);
		return;
	}

	ctx.showWarning(DRIVERS_USAGE);
}
