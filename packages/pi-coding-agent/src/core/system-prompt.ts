/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { toPosixPath } from "../utils/path-display.js";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Whether to include a per-call date/time line in the prompt. */
	includeDateTime?: boolean;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		includeDateTime = false,
	} = options;
	const resolvedCwd = toPosixPath(cwd ?? process.cwd());
	const date = new Date().toISOString().slice(0, 10);
	const dateTimeLine = includeDateTime
		? `\nCurrent date and time: ${new Date().toLocaleString("en-US", {
				weekday: "long",
				year: "numeric",
				month: "long",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				timeZoneName: "short",
			})}`
		: "";

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		prompt += dateTimeLine;
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${resolvedCwd}`;

		if (promptGuidelines && promptGuidelines.length > 0) {
			prompt += "\n\n";
			for (const guideline of promptGuidelines) {
				prompt += `${guideline}\n`;
			}
		}

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = toPosixPath(getReadmePath());
	const docsPath = toPosixPath(getDocsPath());
	const examplesPath = toPosixPath(getExamplesPath());

	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const toolsList = tools.length > 0 ? `- ${tools.join(", ")}` : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasEdit = tools.includes("edit");
	const hasWrite = tools.includes("write");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	if (hasRead && (hasEdit || hasWrite)) {
		addGuideline(
			"Use read to examine relevant existing files before editing or overwriting. Before write creates or replaces a file, verify the target path; if it exists, read it first. Use read instead of cat or sed for file inspection.",
		);
	}

	if (hasEdit) {
		addGuideline("Use edit for precise changes (old text must match exactly)");
	}

	if (hasWrite) {
		addGuideline("Use write only for new files or complete rewrites after verifying the target path");
	}



	if (hasEdit || hasWrite) {
		addGuideline(
			"When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
		);
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

When asked about pi internals (SDK, extensions, themes, skills, TUI), read the docs at ${readmePath}, ${docsPath}, and ${examplesPath}; follow cross-references to related docs.`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	prompt += dateTimeLine;
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${resolvedCwd}`;

	return prompt;
}
