// Project/App: gsd-pi
// File Purpose: Interactive terminal footer renderer for workspace, model, usage, context, and extension status.

import { type Component, truncateToWidth } from "@gsd/pi-tui";
import type { AgentSession } from "@gsd/agent-core";
import type { ReadonlyFooterDataProvider } from "@gsd/pi-coding-agent/core/footer-data-provider.js";
import { theme, type ThemeColor } from "@gsd/pi-coding-agent/theme/theme.js";
import { providerAuthBadge, providerDisplayName } from "./model-selector.js";
import {
	badge,
	layoutFullWidthMinimalFooter,
	renderMinimalFooterLine,
	renderProgressBar,
} from "./transcript-design.js";
import {
	applyBlinkCue,
	formatGitMarkers,
	formatMeterRowSegment,
	formatMilestoneRow,
	METER_BAR_WIDTH,
	resolveMeterTone,
	sanitizeFooterText,
} from "./gsd-statusline-format.js";
import { readPlanningState } from "./gsd-state-reader.js";
import type { GsdStatusWidgetState } from "./gsd-status-widget.js";
import { isGsdStatusWidgetVisible } from "./gsd-status-widget.js";

/** Extension status keys shown in the footer center when the GSD strip is visible. */
const PRIMARY_STATUS_KEYS = ["gsd-step", "zz-notifications", "gsd-fast"] as const;

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Abbreviate cwd for the footer — `~` for home and descendants only.
 * @internal Exported for testing only.
 */
export function formatCwdForFooter(cwd: string, home = process.env.HOME ?? process.env.USERPROFILE ?? ""): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	const withForwardSep = home.endsWith("/") ? home : `${home}/`;
	const withBackSep = home.endsWith("\\") ? home : `${home}\\`;
	if (cwd.startsWith(withForwardSep) || cwd.startsWith(withBackSep)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function pickPrimaryExtensionStatus(
	statuses: ReadonlyMap<string, string>,
): { key: string; text: string } | undefined {
	for (const key of PRIMARY_STATUS_KEYS) {
		const raw = statuses.get(key);
		if (!raw) continue;
		const text = sanitizeStatusText(raw);
		if (text) return { key, text };
	}
	return undefined;
}

function formatSecondaryExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
	excludedKeys: ReadonlySet<string>,
): string {
	return Array.from(statuses.entries())
		.filter(([key]) => !excludedKeys.has(key))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter(Boolean)
		.join(" ");
}

function formatWorkspaceCenter(cwd: string, sessionName?: string): string {
	const parts = [formatCwdForFooter(cwd)];
	if (sessionName) parts.push(sessionName);
	return parts.join(" · ");
}

/**
 * Format a cost value for compact display.
 * @internal Exported for testing only.
 */
export function formatPromptCost(cost: number): string {
	if (cost < 0.001) return `$${cost.toFixed(4)}`;
	if (cost < 0.01) return `$${cost.toFixed(3)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

/**
 * Footer component — one minimal status line (branch, model, context, cost).
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
		private readonly getGsdStatus?: () => GsdStatusWidgetState,
	) {}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	invalidate(): void {}

	dispose(): void {}

	render(width: number): string[] {
		const state = this.session.state;
		const gsdState = this.getGsdStatus?.();

		const usageTotals = this.session.sessionManager.getUsageTotals();
		const totalInput = usageTotals.input;
		const totalOutput = usageTotals.output;
		const totalCacheRead = usageTotals.cacheRead;
		const totalCacheWrite = usageTotals.cacheWrite;
		const totalCost = usageTotals.cost;

		const displayModel = state.activeInferenceModel ?? state.model;
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? displayModel?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(0) : "?";

		const branch = this.footerData.getGitBranch();
		const modelName = displayModel?.id || "no-model";

		const inputSide = totalInput + totalCacheRead + totalCacheWrite;
		let cacheSegment: string | undefined;
		if (totalCacheRead > 0 && inputSide > 0) {
			const cachedPct = Math.round((totalCacheRead / inputSide) * 100);
			cacheSegment = theme.fg("success", `${cachedPct}%↺`);
		}

		let costSegment: string | undefined;
		const usingSubscription = displayModel ? this.session.modelRegistry.isUsingOAuth(displayModel) : false;
		if (totalCost || usingSubscription) {
			const costLabel = usingSubscription ? `$${totalCost.toFixed(2)}*` : `$${totalCost.toFixed(2)}`;
			costSegment = theme.fg("warning", costLabel);
		}

		const gsdWidgetVisible = gsdState ? isGsdStatusWidgetVisible(gsdState, width) : false;
		const gsdSegment = gsdWidgetVisible ? undefined : badge("● GSD", "default");

		const extensionStatuses = this.footerData.getExtensionStatuses();
		const primaryStatus = gsdWidgetVisible ? pickPrimaryExtensionStatus(extensionStatuses) : undefined;
		const secondaryExtText = formatSecondaryExtensionStatuses(
			extensionStatuses,
			primaryStatus ? new Set([primaryStatus.key]) : new Set(),
		);

		let providerSuffix = "";
		if (this.footerData.getAvailableProviderCount() > 1 && displayModel) {
			const authMode = this.session.modelRegistry.getProviderAuthMode(displayModel.provider);
			const authLabel = providerAuthBadge(authMode);
			const providerLabel = providerDisplayName(displayModel.provider);
			providerSuffix = authLabel ? `${providerLabel} ${authLabel}` : providerLabel;
		}

		const barTone = resolveMeterTone(contextPercentValue);
		// resolveMeterTone only ever returns success/warning/contextOrange/error — a literal subset of
		// both StatusTone and ThemeColor. The percent label colors directly by that literal name (unlike
		// the bar fill, which goes through renderProgressBar's toneColor() remap) — RESEARCH Pitfall 3.
		const pctLabel = theme.fg(barTone as ThemeColor, contextPercent === "?" ? "?" : `${contextPercent}%`);
		const contextTokens = contextUsage?.tokens;
		const tokenHint =
			contextPercent === "?" || contextTokens == null
				? ""
				: theme.fg("dim", ` ${formatTokens(contextTokens)}/${formatTokens(contextWindow)}`);
		const pct = contextPercent === "?" ? 0 : contextPercentValue;
		const contextBar = renderProgressBar(pct, 100, METER_BAR_WIDTH, barTone);
		const autoHint = this.autoCompactEnabled ? theme.fg("dim", " (auto)") : "";
		let contextMetric = `${contextBar} ${pctLabel}${tokenHint}${autoHint}`;
		if (barTone === "error") contextMetric = applyBlinkCue(contextMetric);
		const contextRowSegment = `${theme.fg("dim", "context:")} ${contextMetric}`;

		const branchSegment = branch
			? `${theme.fg("dim", sanitizeFooterText(branch))}${formatGitMarkers(this.footerData.getGitStatus())}`
			: undefined;

		const leftSegments = [gsdSegment, branchSegment, theme.fg("text", modelName)].filter(
			(segment): segment is string => !!segment,
		);

		const rightSegments = [
			cacheSegment,
			costSegment,
			providerSuffix ? theme.fg("dim", providerSuffix) : undefined,
			secondaryExtText ? theme.fg("dim", secondaryExtText) : undefined,
		].filter((segment): segment is string => !!segment);

		const cwd = gsdState?.cwd ?? process.cwd();
		const sessionName = this.session.sessionManager.getSessionName() ?? gsdState?.sessionName;
		const centerSource = gsdWidgetVisible
			? primaryStatus?.text
			: formatWorkspaceCenter(cwd, sessionName);

		const line1 = layoutFullWidthMinimalFooter(leftSegments, rightSegments, width, (budget) => {
			if (!centerSource) return "";
			const styled = gsdWidgetVisible
				? theme.fg("text", centerSource)
				: theme.fg("dim", centerSource);
			return truncateToWidth(styled, budget, "…");
		});

		const nowEpochSec = Math.floor(Date.now() / 1000);
		const rateLimits = this.session.getRateLimitStatus();
		const sessionRowSegment = formatMeterRowSegment("session", rateLimits?.session ?? null, nowEpochSec);
		const weeklyRowSegment = formatMeterRowSegment("weekly", rateLimits?.weekly ?? null, nowEpochSec);

		const row2Separator = theme.fg("dim", " · ");
		const row2Segments = [contextRowSegment, sessionRowSegment, weeklyRowSegment].filter(
			(segment): segment is string => !!segment,
		);
		const line2 = row2Segments.join(row2Separator);

		const planningState = readPlanningState(cwd);
		const line3 = formatMilestoneRow(planningState);

		const lines = [...renderMinimalFooterLine(line1, width), ...renderMinimalFooterLine(line2, width)];
		if (line3) {
			// Own `renderMinimalFooterLine` call, never sharing row 1/2's truncation budget — this
			// independent per-row truncation is the entire mechanism behind ROADMAP SC-5.
			lines.push(...renderMinimalFooterLine(line3, width));
		}
		return lines;
	}
}
