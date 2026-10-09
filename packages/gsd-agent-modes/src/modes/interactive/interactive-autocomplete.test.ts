// Project/App: gsd-pi
// File Purpose: /drivers is dispatched by the interactive input router but is not in the shared built-in command
// table, so setupAutocomplete lists it itself. This pins that discoverability (Phase 42, IN-06).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutocompleteProvider } from "@gsd/pi-tui";
import { setupAutocomplete } from "./interactive-autocomplete.js";
import type { InteractiveModeDelegateHost } from "./interactive-mode-delegate-host.js";

function makeHost(): { host: InteractiveModeDelegateHost; provider: () => AutocompleteProvider } {
	let installed: AutocompleteProvider | undefined;
	const editor = {
		setAutocompleteProvider(p: AutocompleteProvider) {
			installed = p;
		},
	};
	const host = {
		session: { promptTemplates: [], extensionRunner: undefined, resourceLoader: { getSkills: () => ({ skills: [] }) }, scopedModels: [] },
		skillCommands: new Map(),
		settingsManager: { getEnableSkillCommands: () => false, getRespectGitignoreInPicker: () => true },
		defaultEditor: editor,
		editor,
		autocompleteProvider: undefined,
	} as unknown as InteractiveModeDelegateHost;
	return { host, provider: () => installed as AutocompleteProvider };
}

const signal = new AbortController().signal;

describe("setupAutocomplete /drivers", () => {
	it("offers /drivers in slash-command completion", async () => {
		const { host, provider } = makeHost();
		setupAutocomplete(host);
		const result = await provider().getSuggestions(["/dri"], 0, 4, { signal });
		assert.ok(result, "suggestions returned");
		assert.ok(result.items.some((item) => item.value === "drivers"), JSON.stringify(result.items));
	});

	it("completes the /drivers subcommands", async () => {
		const { host, provider } = makeHost();
		setupAutocomplete(host);
		const result = await provider().getSuggestions(["/drivers s"], 0, 10, { signal });
		assert.ok(result, "suggestions returned");
		assert.deepEqual(
			result.items.map((item) => item.value),
			["stop"],
		);
	});
});
