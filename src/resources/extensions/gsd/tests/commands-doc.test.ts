// Project/App: gsd-pi
// File Purpose: DOCS-01 — /gsd doc publish path against a stub yahir-tn on a filtered
// PATH plus an injected runner for parser and validation cases. No automated test can
// resolve or run the real yahir-tn (it writes the operator's real yahir-docs store).

import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

// GSD_HOME must point at a temp dir before any project module loads (T-44-09).
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-doc-home-"));
process.env.GSD_HOME = tempGsdHome;

type Mods = {
  doc: typeof import("../commands-doc.ts");
  ops: typeof import("../commands/handlers/ops.ts");
  context: typeof import("../commands/context.ts");
};
let mods: Mods;

before(async () => {
  mods = {
    doc: await import("../commands-doc.ts"),
    ops: await import("../commands/handlers/ops.ts"),
    context: await import("../commands/context.ts"),
  };
});

after(() => {
  if (savedGsdHome === undefined) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = savedGsdHome;
  rmSync(tempGsdHome, { recursive: true, force: true });
});

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

/** Temp project: empty .git (so projectRoot resolves to itself), .planning/notes.md. */
function makeProject(): string {
  const root = tmp("gsd-doc-");
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".planning"));
  writeFileSync(join(root, ".planning", "notes.md"), "# notes\n");
  return root;
}

interface StubOptions {
  stdout?: string;
  stderr?: string;
  code?: number;
  sleepSeconds?: number;
}

/** Stub yahir-tn in its own temp dir; returns the dir (put it first on PATH). */
function makeStub(opts: StubOptions = {}): string {
  const dir = tmp("gsd-doc-stub-");
  writeFileSync(join(dir, "stdout"), opts.stdout ?? "");
  writeFileSync(join(dir, "stderr"), opts.stderr ?? "");
  writeFileSync(join(dir, "code"), String(opts.code ?? 0));
  const lines = [
    "#!/bin/sh",
    `for a in "$@"; do printf '%s\\n' "$a" >> "${dir}/argv.log"; done`,
    `printf '%s\\n' '--end--' >> "${dir}/argv.log"`,
  ];
  if (opts.sleepSeconds) {
    lines.push(`exec /bin/sleep ${opts.sleepSeconds}`);
  } else {
    lines.push(`/bin/cat "${dir}/stdout"`, `/bin/cat "${dir}/stderr" >&2`, `exit $(/bin/cat "${dir}/code")`);
  }
  writeFileSync(join(dir, "yahir-tn"), lines.join("\n") + "\n", { mode: 0o755 });
  return dir;
}

function readInvocations(stubDir: string): string[][] {
  const log = join(stubDir, "argv.log");
  if (!existsSync(log)) return [];
  const out: string[][] = [];
  let cur: string[] = [];
  for (const line of readFileSync(log, "utf-8").split("\n")) {
    if (line === "--end--") {
      out.push(cur);
      cur = [];
    } else if (line !== "") {
      cur.push(line);
    }
  }
  return out;
}

/** Current PATH minus every directory that holds an entry named yahir-tn. */
function pathWithoutRealYahirTn(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d !== "" && !existsSync(join(d, "yahir-tn")))
    .join(delimiter);
}

async function withPath<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
}

interface Note {
  message: string;
  level: string;
}

function makeCtx(cwd: string) {
  const notifications: Note[] = [];
  return {
    cwd,
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
  };
}

const mockPi = {
  registerCommand() {},
  registerTool() {},
  registerShortcut() {},
  on() {},
  sendMessage() {},
};

function envelope(result: Record<string, unknown>): string {
  return JSON.stringify({ schema_version: 1, generated_at: "2026-10-09T08:00:00+00:00", result }, null, 2);
}

test("DOCS-01 tracer: /gsd doc routes through handleOpsCommand to yahir-tn doc and shows the https URL first", async () => {
  const root = makeProject();
  const slug = basename(root);
  const real = realpathSync(join(root, ".planning", "notes.md"));
  const url = `https://h.ts.net/Doc/${slug}/notes.html`;
  const name = `doc:${slug}/notes`;
  const stub = makeStub({
    stdout: envelope({
      name,
      url,
      source: real,
      expires_at: "2026-10-16T08:00:00+00:00",
      pinned: false,
      state: "up",
    }),
  });
  const ctx = makeCtx(root);

  const handled = await withPath(`${stub}${delimiter}${pathWithoutRealYahirTn()}`, () =>
    mods.context.withCommandCwd(root, () =>
      mods.ops.handleOpsCommand("doc .planning/notes.md", ctx as any, mockPi as any),
    ),
  );

  assert.equal(handled, true);
  assert.deepEqual(readInvocations(stub), [["doc", slug, real, "--json"]]);
  assert.equal(ctx.notifications.length, 1, JSON.stringify(ctx.notifications));
  const note = ctx.notifications[0];
  assert.equal(note.level, "success");
  assert.ok(note.message.split("\n")[0].includes(url), note.message);
  const positions = [url, real, "Expires:", name, `yahir-tn pin ${name}`].map((s) => note.message.indexOf(s));
  assert.ok(positions.every((p) => p >= 0), note.message);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "fields out of order");
});
