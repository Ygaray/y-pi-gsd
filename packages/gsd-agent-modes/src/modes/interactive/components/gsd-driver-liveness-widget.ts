// Project/App: gsd-pi
// File Purpose: One-row driver liveness indicator (OBS-01): running / stale / DIED for the spawned y-pi-gsd
// driver, rendered from the monitor's last snapshot. A sibling of the status widget, not a field on it
// (D-02): turn progress and driver liveness stay separate signals. render() does no I/O; the timer only
// asks the read-only monitor to refresh.

import { alignRight, padRight, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { theme } from "@gsd/pi-coding-agent/theme/theme.js";
import { AnimatedComponent } from "./animated-component.js";
import { sanitizeDriverText } from "./gsd-driver-registry.js";
import {
	DRIVER_WIDGET_REFRESH_MS,
	driverAgeText,
	type DriverLivenessMonitor,
	type DriverWidgetSnapshot,
} from "./gsd-driver-liveness-monitor.js";
import { badge } from "./transcript-design.js";

type StateKey = "running" | "stale" | "died";
type StateTone = "success" | "warning" | "error";

export interface DriverStateStyle {
	glyph: string;
	word: string;
	/** `null` means the theme's dim foreground (absence of data is not an error). */
	tone: StateTone | null;
}

/** Single tone map shared by the widget, the /drivers table and the alerts so they cannot disagree. */
export const DRIVER_STATE_STYLE = {
	running: { glyph: "●", word: "running", tone: "success" },
	stale: { glyph: "◐", word: "stale", tone: "warning" },
	died: { glyph: "✕", word: "DIED", tone: "error" },
	unreadable: { glyph: "○", word: "registry unreadable", tone: null },
} as const satisfies Record<string, DriverStateStyle>;

const FULL_WIDTH_MIN = 60;
const COMPACT_WIDTH_MIN = 16;

function padLine(line: string, width: number): string {
	return padRight(truncateToWidth(line, width, "…"), width);
}

function dim(text: string): string {
	return theme.fg("dim", text);
}

function toneText(text: string, tone: StateTone | null): string {
	return tone === null ? dim(text) : theme.fg(tone, text);
}

function sep(): string {
	return dim(" · ");
}

function styledBadge(state: StateKey, short: boolean): string {
	const style = DRIVER_STATE_STYLE[state];
	const text = `${style.glyph} ${short ? "" : "DRIVER "}${style.word}`;
	// The calm state is not shouted; stale and DIED are bold.
	return badge(state === "running" ? text : theme.bold(text), style.tone);
}

function othersText(count: number): string {
	return count === 1 ? "1 other driver needs attention" : `${count} other drivers need attention`;
}

/** One optional segment of the left side; `rank` is the full-tier drop order (primary segments are never dropped). */
interface Segment {
	rank: 2 | 3 | 4 | null;
	text: string;
}

interface Layout {
	state: StateKey | "unreadable";
	/** Badge state: the worst related row, else the worst of the other rows. */
	badgeState: StateKey;
	segments: Segment[];
	/** Plain hint text, already dim-styled; null when none. */
	hint: string | null;
	/** Primary detail for the compact tier. */
	primary: string | null;
}

function buildLayout(snapshot: Extract<DriverWidgetSnapshot, { kind: "summary" }>): Layout | null {
	const { summary, nowMs } = snapshot;
	if (summary.kind === "none") return null;
	const { worst, relatedCount, others } = summary;

	const othersSeg: Segment | null =
		others.count > 0 && others.worst !== null
			? { rank: 4, text: toneText(othersText(others.count), DRIVER_STATE_STYLE[others.worst].tone) }
			: null;
	const moreSeg: Segment | null = relatedCount > 1 ? { rank: 4, text: dim(`+${relatedCount - 1} more`) } : null;
	const tail = [moreSeg, othersSeg].filter((s): s is Segment => s !== null);

	if (worst === null) {
		const worstOther = others.worst ?? "stale";
		const text = othersSeg?.text ?? "";
		return {
			state: worstOther,
			badgeState: worstOther,
			segments: [{ rank: null, text }],
			hint: dim("/drivers"),
			primary: text,
		};
	}

	const liveness = worst.liveness;
	const age = driverAgeText(worst, nowMs);
	const pidText = `pid ${worst.row.pid}`;

	if (liveness.kind === "running") {
		const pidSeg: Segment = { rank: null, text: dim(pidText) };
		const segments: Segment[] = [pidSeg];
		if (age !== null) segments.push({ rank: 2, text: dim(`up ${age}`) });
		segments.push(...tail);
		return {
			state: "running",
			badgeState: "running",
			segments,
			hint: others.count > 0 ? dim("/drivers") : null,
			primary: pidSeg.text,
		};
	}

	if (liveness.kind === "stale") {
		const cause =
			liveness.why === "supervisor-gone"
				? "supervisor gone, driver unwatched"
				: age === null
					? "still starting"
					: `still starting after ${age}`;
		const detail: Segment = { rank: null, text: theme.fg("warning", cause) };
		const segments: Segment[] = [detail, { rank: 3, text: dim(pidText) }];
		if (liveness.why === "supervisor-gone" && age !== null) segments.push({ rank: 2, text: dim(`up ${age}`) });
		segments.push(...tail);
		return { state: "stale", badgeState: "stale", segments, hint: dim("/drivers"), primary: detail.text };
	}

	const reason = sanitizeDriverText(liveness.reason);
	const detail: Segment = { rank: null, text: theme.fg("error", reason) };
	const segments: Segment[] = [detail];
	let hint: string;
	if (liveness.reconciled) {
		segments.push({ rank: 3, text: dim(pidText) });
		hint = dim(age === null ? "/drivers" : `${age} ago · /drivers`);
	} else {
		// The pid is already inside the fixed unreconciled reason.
		hint = dim("/drivers");
	}
	segments.push(...tail);
	return { state: "died", badgeState: "died", segments, hint, primary: detail.text };
}

function composeLeft(badgeText: string, segments: readonly Segment[]): string {
	return badgeText + segments.map((s) => sep() + s.text).join("");
}

/**
 * Pure one-row render of a monitor snapshot. `[]` while pending, when nothing relates to this project, and for
 * width <= 0; exactly one line otherwise (fixed height, #2333). Never claims progress: "running" means the
 * process is alive and supervised.
 */
export function renderDriverLivenessLine(snapshot: DriverWidgetSnapshot, width: number): string[] {
	if (!Number.isFinite(width) || width <= 0) return [];
	if (snapshot.kind === "pending") return [];

	if (snapshot.kind === "unreadable") {
		const style = DRIVER_STATE_STYLE.unreadable;
		const full = `${style.glyph} DRIVER ${style.word}${" · cannot show driver status"}`;
		const short = `${style.glyph} ${style.word}`;
		return [padLine(dim(width >= FULL_WIDTH_MIN ? full : short), width)];
	}

	const layout = buildLayout(snapshot);
	if (layout === null) return [];

	if (width < COMPACT_WIDTH_MIN) return [padLine(styledBadge(layout.badgeState, true), width)];

	if (width < FULL_WIDTH_MIN) {
		const left =
			layout.primary === null || layout.primary === ""
				? styledBadge(layout.badgeState, true)
				: styledBadge(layout.badgeState, true) + sep() + layout.primary;
		return [padLine(left, width)];
	}

	return [padLine(layoutFull(layout, width), width)];
}

function layoutFull(layout: Layout, width: number): string {
	const badgeText = styledBadge(layout.badgeState, false);
	const kept = [...layout.segments];
	const hint = layout.hint;

	const fits = (withHint: boolean): boolean => {
		const left = composeLeft(badgeText, kept);
		const hintWidth = withHint && hint !== null ? 1 + visibleWidth(hint) : 0;
		return visibleWidth(left) + hintWidth <= width;
	};

	let showHint = hint !== null;
	if (!fits(showHint)) {
		showHint = false;
		for (const rank of [2, 3, 4] as const) {
			if (fits(false)) break;
			for (let i = kept.length - 1; i >= 0; i--) {
				if (kept[i].rank === rank) kept.splice(i, 1);
			}
		}
	}

	const left = composeLeft(badgeText, kept);
	return showHint && hint !== null ? alignRight(left, hint, width) : left;
}

/** Sibling of the status widget: shows the machine's driver liveness in one fixed row. */
export class DriverLivenessWidget extends AnimatedComponent {
	private kicking = false;
	private disposed = false;

	constructor(private readonly monitor: DriverLivenessMonitor) {
		super();
	}

	/** Refresh immediately, then every DRIVER_WIDGET_REFRESH_MS on an unref'd timer. */
	start(requestRender: () => void): void {
		this.disposed = false;
		void this.kick(requestRender);
		this.startAnimation(
			DRIVER_WIDGET_REFRESH_MS,
			() => {
				void this.kick(requestRender);
				return { render: false };
			},
			requestRender,
		);
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	private async kick(requestRender: () => void): Promise<void> {
		if (this.kicking) return;
		this.kicking = true;
		try {
			const changed = await this.monitor.refresh();
			if (changed && !this.disposed) {
				this.invalidate();
				requestRender();
			}
		} catch {
			// refresh never rejects; a failing render request must not surface here either
		} finally {
			this.kicking = false;
		}
	}

	render(width: number): string[] {
		return renderDriverLivenessLine(this.monitor.getSnapshot(), width);
	}
}
