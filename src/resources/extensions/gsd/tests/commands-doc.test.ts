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

// ─── Task 2: failure taxonomy ───────────────────────────────────────────────

type Ctx = ReturnType<typeof makeCtx>;

/** Run handleDoc inside withCommandCwd(root) with an optional PATH / opts. */
async function runDoc(
  root: string,
  args: string,
  opts?: { run?: any; timeoutMs?: number },
  pathValue?: string,
): Promise<Ctx> {
  const ctx = makeCtx(root);
  const go = () => mods.context.withCommandCwd(root, () => mods.doc.handleDoc(args, ctx as any, opts));
  if (pathValue === undefined) await go();
  else await withPath(pathValue, go);
  return ctx;
}

/** Run handleDoc against a stub yahir-tn first on a filtered PATH. */
function runDocStub(root: string, stub: string, args: string, opts?: { run?: any; timeoutMs?: number }) {
  return runDoc(root, args, opts, `${stub}${delimiter}${pathWithoutRealYahirTn()}`);
}

function recordingRunner(result: Record<string, unknown>) {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { ok: false, exitCode: 0, stdout: "", stderr: "", ...result } as any;
  };
  return { run, calls };
}

function okRun(stdout: string) {
  return { ok: true, exitCode: 0, stdout, stderr: "" };
}

function cliError(code: number, message: string, hint: string | null): string {
  return JSON.stringify({ error: { code, message, hint } });
}

function onlyError(ctx: Ctx): string {
  assert.equal(ctx.notifications.length, 1, JSON.stringify(ctx.notifications));
  assert.equal(ctx.notifications[0].level, "error", ctx.notifications[0].message);
  return ctx.notifications[0].message;
}

test("DOCS-01 failure: ENOENT names yahir-tn, install.sh and PATH", async () => {
  const root = makeProject();
  const ctx = await runDoc(root, ".planning/notes.md", undefined, pathWithoutRealYahirTn());
  const msg = onlyError(ctx);
  assert.match(msg, /not installed or not on PATH/);
  assert.match(msg, /install\.sh/);
  assert.match(msg, /PATH/);
});

test("DOCS-01 failure: timeout says the doc may still be published and points at yahir-tn ps", async () => {
  const root = makeProject();
  const stub = makeStub({ sleepSeconds: 5 });
  const started = Date.now();
  const ctx = await runDocStub(root, stub, ".planning/notes.md", { timeoutMs: 300 });
  assert.ok(Date.now() - started < 3000, "timeout test must finish quickly");
  const msg = onlyError(ctx);
  assert.match(msg, /did not finish within/);
  assert.match(msg, /may still have been published/);
  assert.match(msg, /yahir-tn ps/);
});

test("DOCS-01 failure: exit 5 is published-but-not-served with no openable URL", async () => {
  const root = makeProject();
  const slug = basename(root);
  const hint = "The yahir-docs server isn't serving it; check the Doc row in `yahir-tn ps`.";
  const stub = makeStub({
    code: 5,
    stderr: cliError(5, `published doc:${slug}/notes but http://127.0.0.1:8765/${slug}/notes.html answered 404`, hint),
  });
  const ctx = await runDocStub(root, stub, ".planning/notes.md");
  const msg = onlyError(ctx);
  assert.match(msg, /Published but NOT served/);
  assert.match(msg, /not openable/);
  assert.match(msg, /answered 404/);
  assert.ok(msg.includes(hint), msg);
  assert.ok(!msg.includes("https://"), msg);
});

test("DOCS-01 failure: CLI JSON error is shown with exit code, message and hint", async () => {
  const root = makeProject();
  const stub = makeStub({ code: 2, stderr: cliError(2, "invalid project 'x'", "Run `yahir-tn --help`.") });
  const ctx = await runDocStub(root, stub, ".planning/notes.md");
  const msg = onlyError(ctx);
  assert.match(msg, /exit 2/);
  assert.match(msg, /invalid project/);
  assert.ok(msg.includes("Hint: Run `yahir-tn --help`."), msg);
});

test("DOCS-01 failure: unparsable stderr is cut to its last 300 characters", async () => {
  const root = makeProject();
  const tail = Array.from({ length: 300 }, (_, i) => String.fromCharCode(65 + (i % 26))).join("");
  const stub = makeStub({ code: 1, stderr: "HEADMARK" + "a".repeat(1000) + tail });
  const ctx = await runDocStub(root, stub, ".planning/notes.md");
  const msg = onlyError(ctx);
  assert.ok(msg.includes(tail), msg);
  assert.ok(!msg.includes("HEADMARK"), msg);
  assert.match(msg, /exit 1/);
});

const GOOD_ROW = {
  name: "doc:p/notes",
  url: "https://h.ts.net/Doc/p/notes.html",
  source: "/x/notes.md",
  expires_at: "2026-10-16T08:00:00+00:00",
  pinned: false,
};

for (const [label, stdout, expected] of [
  ["non-JSON stdout", "not json at all", /non-JSON/],
  ["schema_version 2", JSON.stringify({ schema_version: 2, result: GOOD_ROW }), /schema_version/],
  [
    "raw item without url",
    JSON.stringify({ schema_version: 1, result: { name: "doc:p/notes", url_path: "/p/notes.html" } }),
    /no url/,
  ],
  [
    "http url",
    JSON.stringify({ schema_version: 1, result: { ...GOOD_ROW, url: "http://h.ts.net/Doc/x/notes.html" } }),
    /not an https URL/,
  ],
  [
    "relative url",
    JSON.stringify({ schema_version: 1, result: { ...GOOD_ROW, url: "/Doc/x/notes.html" } }),
    /not a valid URL|not an https URL/,
  ],
] as Array<[string, string, RegExp]>) {
  test(`DOCS-01 failure: bad output on exit 0 (${label}) is a loud error with no URL`, async () => {
    const root = makeProject();
    const stub = makeStub({ stdout });
    const ctx = await runDocStub(root, stub, ".planning/notes.md");
    const msg = onlyError(ctx);
    assert.match(msg, expected);
    assert.match(msg, /may have been published/);
    assert.match(msg, /yahir-tn ps/);
    assert.ok(!msg.includes("Published:"), msg);
  });
}

test("DOCS-01 failure: CLI text is stripped of ANSI escapes and control characters", async () => {
  const root = makeProject();
  const stub = makeStub({ code: 2, stderr: cliError(2, "\u001b[31mboom\u001b[0m\r\u0007", null) });
  const ctx = await runDocStub(root, stub, ".planning/notes.md");
  const msg = onlyError(ctx);
  assert.ok(msg.includes("boom"), msg);
  assert.ok(!msg.includes("\u001b"), "ESC leaked");
  assert.ok(!msg.includes("\r"), "CR leaked");
  assert.ok(!msg.includes("\u0007"), "BEL leaked");
});

test("DOCS-01 failure: parsePublishResult unit cases", () => {
  const { parsePublishResult } = mods.doc;
  const wrap = (result: unknown) => JSON.stringify({ schema_version: 1, result });
  const down = parsePublishResult(wrap({ ...GOOD_ROW, state: "down" }), "/sent.md");
  assert.equal(down.ok, true);
  const pinned = parsePublishResult(wrap({ ...GOOD_ROW, pinned: true, expires_at: null }), "/sent.md");
  assert.ok(pinned.ok && pinned.doc.pinned === true && pinned.doc.expiresAt === null);
  const noName = parsePublishResult(wrap({ url: GOOD_ROW.url }), "/sent.md");
  assert.ok(noName.ok && noName.doc.name === null && noName.doc.source === "/sent.md");
  assert.equal(parsePublishResult(wrap({ ...GOOD_ROW, url: "https://h.ts.net/a b.html" }), "/s").ok, false);
  assert.equal(parsePublishResult("null", "/s").ok, false);
  assert.equal(parsePublishResult("[]", "/s").ok, false);
  assert.equal(parsePublishResult(JSON.stringify({ schema_version: 1 }), "/s").ok, false);
});

test("DOCS-01 failure: a rejecting runner becomes one error notify", async () => {
  const root = makeProject();
  const ctx = await runDoc(root, ".planning/notes.md", { run: () => Promise.reject(new Error("kaboom")) });
  assert.match(onlyError(ctx), /failed unexpectedly: kaboom/);
});

test("DOCS-01 failure: a runner that throws synchronously becomes one error notify", async () => {
  const root = makeProject();
  const ctx = await runDoc(root, ".planning/notes.md", {
    run: () => {
      throw new Error("sync boom");
    },
  });
  assert.match(onlyError(ctx), /failed unexpectedly: sync boom/);
});

test("DOCS-01 failure: concurrent calls are independent, each reports its own file", async () => {
  const root = makeProject();
  writeFileSync(join(root, ".planning", "other.md"), "# other\n");
  const run = async (argv: readonly string[]) => {
    await new Promise((r) => setTimeout(r, 50));
    return okRun(envelope({ ...GOOD_ROW, source: argv[2], name: `doc:p/${basename(argv[2], ".md")}` }));
  };
  const ctxA = makeCtx(root);
  const ctxB = makeCtx(root);
  await mods.context.withCommandCwd(root, () =>
    Promise.all([
      mods.doc.handleDoc(".planning/notes.md", ctxA as any, { run }),
      mods.doc.handleDoc(".planning/other.md", ctxB as any, { run }),
    ]),
  );
  for (const [ctx, file] of [
    [ctxA, "notes.md"],
    [ctxB, "other.md"],
  ] as Array<[Ctx, string]>) {
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].level, "success");
    assert.ok(ctx.notifications[0].message.includes(join(realpathSync(root), ".planning", file)), ctx.notifications[0].message);
  }
});

test("DOCS-01 failure: a failed call does not affect the next call", async () => {
  const root = makeProject();
  const failing = await runDoc(root, ".planning/notes.md", {
    run: async () => ({ ok: false, exitCode: 2, stdout: "", stderr: cliError(2, "nope", null) }),
  });
  onlyError(failing);
  const ok = await runDoc(root, ".planning/notes.md", { run: async () => okRun(envelope(GOOD_ROW)) });
  assert.equal(ok.notifications.length, 1);
  assert.equal(ok.notifications[0].level, "success");
});
