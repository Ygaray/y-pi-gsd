// Project/App: gsd-pi
// File Purpose: Operator /drivers command - list, stop and dismiss y-pi-gsd drivers from the session registry;
// never signals a process and never writes the registry (stop goes only through the injected DriverControlPort).

import { homedir } from "node:os";
import { basename } from "node:path";
import { type Component, padRight, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { DRIVER_STATE_STYLE } from "./components/gsd-driver-liveness-widget.js";
import type { DriverListing } from "./components/gsd-driver-liveness-monitor.js";
import { formatDriverAge, sanitizeDriverText, type ClassifiedDriver } from "./components/gsd-driver-registry.js";
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
	const anyDied = drivers.some((d) => d.liveness.kind === "died");
	const footer: string[] = [];
	if (stoppable.size > 0) footer.push("Stop one with /drivers stop <n>.");
	if (anyDied) footer.push("Hide died drivers with /drivers dismiss.");
	if (anyRunning || footer.length > 0) lines.push("");
	if (anyRunning) {
		lines.push(dim("● running = process alive and supervised; it does not mean the driver is making progress."));
	}
	if (footer.length > 0) lines.push(dim(footer.join(" ")));

	return { lines, stoppable };
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

	ctx.showWarning(DRIVERS_USAGE);
}
