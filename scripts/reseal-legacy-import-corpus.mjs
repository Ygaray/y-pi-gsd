// Project/App: gsd-pi
// File Purpose: One-shot, idempotent re-derivation of the legacy-import test corpus's
// sealed data: every oracle.json's base_database_schema_version, and every per-case seal
// plus the totals block in corpus.json. Run at every SCHEMA_VERSION bump instead of
// hand-editing 26+ JSON files, since a transcription error there is exactly where the
// legacy-import corpus has gone stale twice before (v50/51->53, v53->55).
//
// Invoke with the same loader the scoped legacy-import tests use, so the TypeScript
// helper imports resolve:
//   node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
//     --experimental-strip-types scripts/reseal-legacy-import-corpus.mjs

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION } from "../src/resources/extensions/gsd/legacy-import-contract.ts";
import {
  legacyImportCorpusHash,
  loadLegacyImportCorpusCase,
  loadLegacyImportCorpusManifest,
} from "../src/resources/extensions/gsd/tests/helpers/legacy-import-corpus.ts";

const CORPUS_ROOT_URL = new URL(
  "../src/resources/extensions/gsd/tests/__fixtures__/legacy-import-corpus/v1/",
  import.meta.url,
);
const CORPUS_ROOT_PATH = fileURLToPath(CORPUS_ROOT_URL);

/** Reimplements the helper's module-private fileSetHash shape verbatim (see helper
 * lines 689-701): map each discovered file to {path, entry_kind, byte_size, sha256},
 * sort ascending by path, then hash with the helper's own exported legacyImportCorpusHash
 * so this script derives seals with the same function the validator checks them with. */
function fileSetHash(files) {
  const rows = files
    .map((file) => ({
      path: file.path,
      entry_kind: file.entryKind,
      byte_size: file.byteSize,
      sha256: file.sha256,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return legacyImportCorpusHash(rows);
}

/** Reimplements the helper's module-private aggregateManifestTotals shape verbatim
 * (see helper lines 786-823). */
function computeTotals(cases) {
  const totals = {
    cases: cases.length,
    sources: 0,
    changes: 0,
    diagnoses: 0,
    resolutions: 0,
    create: 0,
    update: 0,
    delete: 0,
    preserve: 0,
    mapped: 0,
    preserved: 0,
    unparsed: 0,
    ignored_with_reason: 0,
    requires_user: 0,
    unsupported: 0,
    unresolved: 0,
  };
  for (const corpusCase of cases) {
    const oracle = corpusCase.oracle;
    totals.sources += oracle.sources.length;
    totals.changes += oracle.changes.length;
    totals.diagnoses += oracle.diagnoses.length;
    totals.resolutions += oracle.resolutions.length;
    for (const change of oracle.changes) totals[change.action] += 1;
    for (const source of oracle.sources) {
      const key = source.outcome === "ignored-with-reason" ? "ignored_with_reason" : source.outcome;
      totals[key] += 1;
    }
    for (const resolution of oracle.resolutions) {
      if (resolution.disposition === "requires-user") totals.requires_user += 1;
      if (resolution.disposition === "unsupported") totals.unsupported += 1;
    }
  }
  totals.unresolved = totals.requires_user + totals.unsupported;
  return totals;
}

/** Matches validateManifestCaseEntry's own `expected` derivation (helper lines 759-769). */
function computeCaseEntry(corpusCase) {
  const oracle = corpusCase.oracle;
  return {
    source_count: corpusCase.files.length,
    file_set_hash: fileSetHash(corpusCase.files),
    oracle_hash: legacyImportCorpusHash(oracle),
    source_set_hash: oracle.source_set_hash,
    change_set_hash: oracle.change_set_hash,
    diagnosis_count: oracle.diagnoses.length,
    resolution_count: oracle.resolutions.length,
    counts: oracle.counts,
  };
}

/** oracle.schema.json pins base_database_schema_version to a JSON-Schema `const` so a
 * mistyped oracle can never silently claim the wrong baseline. That const itself is a
 * schema-version literal and must move in lockstep, or every oracle rewrite above fails
 * Ajv validation with "must be equal to constant" (discovered live, not in the original
 * files_modified list - the schema file is fixture-adjacent, same drift class Task 2 owns). */
function rewriteOracleSchemaConst(changed) {
  const schemaPath = `${CORPUS_ROOT_PATH}oracle.schema.json`;
  const raw = readFileSync(schemaPath, "utf8");
  const parsed = JSON.parse(raw);
  const constHolder = parsed?.properties?.base_database_schema_version;
  if (!constHolder || typeof constHolder.const !== "number") {
    throw new Error("oracle.schema.json: properties.base_database_schema_version.const not found");
  }
  if (constHolder.const === LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION) return;
  constHolder.const = LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION;
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  writeFileSync(schemaPath, next);
  changed.push("oracle.schema.json");
}

function discoverCaseNames() {
  return readdirSync(CORPUS_ROOT_PATH, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(`${CORPUS_ROOT_PATH}${name}/oracle.json`).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Rewrites one case's oracle.json in two ways: (1) base_database_schema_version tracks
 * the live constant, and (2) every $.sources[] entry's byte_size/sha256 tracks the actual
 * discovered file on disk. (2) matters whenever a case's own source bytes changed (e.g. a
 * database re-stamp) - validateLegacyImportCorpusCase's whole-file fingerprint check (helper
 * lines 457-463) compares every source's declared byte_size/sha256 against real discovered
 * bytes unconditionally, for every case, not just the ones this bump's fixture re-stamp
 * touched. Uses the helper's own exported loadLegacyImportCorpusCase for discovery, so this
 * fingerprint is derived with the same function the validator checks it with. */
function rewriteOracleFile(caseName, changed) {
  const oraclePath = `${CORPUS_ROOT_PATH}${caseName}/oracle.json`;
  const raw = readFileSync(oraclePath, "utf8");
  const parsed = JSON.parse(raw);

  if (parsed.base_database_schema_version !== LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION) {
    parsed.base_database_schema_version = LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION;
  }

  const discovered = loadLegacyImportCorpusCase(CORPUS_ROOT_URL, caseName);
  const filesByPath = new Map(discovered.files.map((file) => [file.path, file]));
  for (const source of parsed.sources ?? []) {
    const file = filesByPath.get(source.path);
    if (!file) continue;
    if (source.byte_size !== file.byteSize) source.byte_size = file.byteSize;
    if (source.sha256 !== file.sha256) source.sha256 = file.sha256;
  }

  // The oracle self-declares a hash over its own $.sources array (validateLegacyImportCorpusCase
  // line 564); any source rewrite above must be followed by re-deriving this field or the oracle
  // fails its own internal determinism check.
  const recomputedSourceSetHash = legacyImportCorpusHash(parsed.sources ?? []);
  if (parsed.source_set_hash !== recomputedSourceSetHash) parsed.source_set_hash = recomputedSourceSetHash;

  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  if (next === raw) return;
  writeFileSync(oraclePath, next);
  changed.push(`${caseName}/oracle.json`);
}

function rewriteCorpusManifest(caseNames, changed) {
  const manifestPath = `${CORPUS_ROOT_PATH}corpus.json`;
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);

  const cases = caseNames.map((name) => loadLegacyImportCorpusCase(CORPUS_ROOT_URL, name));
  const casesByName = new Map(cases.map((corpusCase) => [corpusCase.name, corpusCase]));

  for (const entry of manifest.cases) {
    const corpusCase = casesByName.get(entry.name);
    if (!corpusCase) throw new Error(`corpus.json references unknown case: ${entry.name}`);
    const computed = computeCaseEntry(corpusCase);
    for (const key of Object.keys(computed)) entry[key] = computed[key];
  }

  const totals = computeTotals(cases);
  for (const key of Object.keys(totals)) manifest.totals[key] = totals[key];

  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (next === raw) return;
  writeFileSync(manifestPath, next);
  changed.push("corpus.json");
}

function main() {
  const caseNames = discoverCaseNames();
  if (caseNames.length === 0) {
    console.error("reseal-legacy-import-corpus: found zero corpus cases under", CORPUS_ROOT_PATH);
    console.error("This means the script failed to locate the corpus tree - failing loudly rather than reporting success.");
    process.exitCode = 1;
    return;
  }

  const changed = [];
  rewriteOracleSchemaConst(changed);
  for (const caseName of caseNames) rewriteOracleFile(caseName, changed);
  rewriteCorpusManifest(caseNames, changed);

  for (const file of changed) console.log(`changed: ${file}`);
  console.log(`reseal-legacy-import-corpus: ${caseNames.length} cases scanned, ${changed.length} files changed`);

  // Sanity check: loadLegacyImportCorpusManifest must still be able to load what we wrote.
  loadLegacyImportCorpusManifest(CORPUS_ROOT_URL);
}

main();
