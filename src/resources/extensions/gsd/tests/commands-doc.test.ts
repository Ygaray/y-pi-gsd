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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

import { makeTempRepo } from "./test-utils.ts";

// GSD_HOME must point at a temp dir before any project module loads (T-44-09).
const savedGsdHome = process.env.GSD_HOME;
const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-doc-home-"));
process.env.GSD_HOME = tempGsdHome;

type Mods = {
  doc: typeof import("../commands-doc.ts");
  ops: typeof import("../commands/handlers/ops.ts");
  context: typeof import("../commands/context.ts");
  dispatcher: typeof import("../commands/dispatcher.ts");
  catalog: typeof import("../commands/catalog.ts");
  core: typeof import("../commands/handlers/core.ts");
};
let mods: Mods;

before(async () => {
  mods = {
    doc: await import("../commands-doc.ts"),
    ops: await import("../commands/handlers/ops.ts"),
    context: await import("../commands/context.ts"),
    dispatcher: await import("../commands/dispatcher.ts"),
    catalog: await import("../commands/catalog.ts"),
    core: await import("../commands/handlers/core.ts"),
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

test("DOCS-01 failure (WR-05): a child that ignores SIGTERM is SIGKILLed and the run still settles", async () => {
  const dir = tmp("gsd-doc-stub-");
  writeFileSync(
    join(dir, "yahir-tn"),
    ["#!/bin/sh", "trap '' TERM", "while :; do /bin/sleep 1; done"].join("\n") + "\n",
    { mode: 0o755 },
  );
  const started = Date.now();
  const run = await withPath(`${dir}${delimiter}${pathWithoutRealYahirTn()}`, () =>
    (mods.doc.runYahirTn as (a: readonly string[], t: number, g: number) => Promise<any>)(["doc", "p", "/x.md", "--json"], 200, 300),
  );
  assert.ok(Date.now() - started < 4000, "run must settle shortly after the hard deadline");
  assert.equal(run.ok, false);
  assert.equal(run.timedOut, true);
  assert.match(mods.doc.formatRunFailure(run, 200), /did not finish within/);
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

test("DOCS-01 failure (WR-03): spoofing URLs are rejected and invisible format characters are stripped", () => {
  const { parsePublishResult, sanitizeCliText } = mods.doc;
  const wrap = (url: string) => JSON.stringify({ schema_version: 1, result: { ...GOOD_ROW, url } });
  for (const url of [
    "https://trusted.ts.net@evil.example/Doc/p/notes.html",
    "https://user:pw@h.ts.net/Doc/p/notes.html",
    "https://h.ts.net/Doc/p/\u202enotes.html",
    "https://h.ts.net/Doc/p/\u200bnotes.html",
    "https://h\u00e9.ts.net/Doc/p/notes.html",
  ]) {
    assert.equal(parsePublishResult(wrap(url), "/s").ok, false, url);
  }
  assert.equal(sanitizeCliText("a\u202eb\u200bc\u2066d\ufeffe\u009bf"), "abcdef");
});

test("DOCS-01 failure (WR-04): attacker-controlled path text never reaches notify raw", async () => {
  const root = makeProject();
  const evil = "\u001b]0;pwned\u0007\u001b[31mmissing.md";
  for (const args of [`"${evil}"`, `--bad${evil}`, `"${evil}.txt"`]) {
    const { run, calls } = successRunner();
    const ctx = await runDoc(root, args, { run });
    const msg = onlyError(ctx);
    assert.ok(!msg.includes("\u001b"), `ESC leaked for ${JSON.stringify(args)}`);
    assert.ok(!msg.includes("\u0007"), `BEL leaked for ${JSON.stringify(args)}`);
    assert.equal(calls.length, 0);
  }
  const ctx = await runDoc(root, ".planning/notes.md", {
    run: () => Promise.reject(new Error("bad \u001b[31mnews\u001b[0m")),
  });
  const msg = onlyError(ctx);
  assert.match(msg, /bad news/);
  assert.ok(!msg.includes("\u001b"), "ESC leaked from the catch-all");
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

// ─── Task 3: input completeness ─────────────────────────────────────────────


/** Every argv recorded by Task 3 successes; checked by the argv-shape invariant test. */
const recordedArgvs: string[][] = [];

/** Injected runner that records argv and returns a valid envelope echoing argv[2] as source. */
function successRunner(extra: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => {
    calls.push([...argv]);
    recordedArgvs.push([...argv]);
    return okRun(envelope({ ...GOOD_ROW, source: argv[2], ...extra }));
  };
  return { run, calls };
}

/** A state dir under <GSD_HOME>/projects, like the one ensureGsdSymlink points .gsd at. */
function makeStateDir(): string {
  const projects = join(tempGsdHome, "projects");
  mkdirSync(projects, { recursive: true });
  const dir = mkdtempSync(join(projects, "state-"));
  tempDirs.add(dir);
  return dir;
}

test("DOCS-01 input: a .gsd symlinked to GSD external state publishes its real path", async () => {
  const root = makeProject();
  const external = makeStateDir();
  writeFileSync(join(external, "STATE.md"), "# state\n");
  symlinkSync(external, join(root, ".gsd"));
  const { run, calls } = successRunner();
  const ctx = await runDoc(root, ".gsd/STATE.md", { run });
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.notifications[0].level, "success", ctx.notifications[0].message);
  assert.equal(calls[0][2], realpathSync(join(external, "STATE.md")));
});

test("DOCS-01 input: a .planning symlinked to GSD external state publishes its real path", async () => {
  const root = tmp("gsd-doc-");
  mkdirSync(join(root, ".git"));
  const external = makeStateDir();
  writeFileSync(join(external, "ROADMAP.md"), "# roadmap\n");
  symlinkSync(external, join(root, ".planning"));
  const { run, calls } = successRunner();
  const ctx = await runDoc(root, ".planning/ROADMAP.md", { run });
  assert.equal(ctx.notifications[0].level, "success", ctx.notifications[0].message);
  assert.equal(calls[0][2], realpathSync(join(external, "ROADMAP.md")));
});

test("DOCS-01 input (WR-01): a repo-shipped .planning/.gsd symlink to an arbitrary directory is rejected", async () => {
  for (const name of [".planning", ".gsd"]) {
    const root = tmp("gsd-doc-");
    mkdirSync(join(root, ".git"));
    const victim = tmp("gsd-doc-victim-");
    writeFileSync(join(victim, "private.md"), "# private\n");
    symlinkSync(victim, join(root, name));
    const { run, calls } = successRunner();
    const ctx = await runDoc(root, `${name}/private.md`, { run });
    assert.match(onlyError(ctx), /outside this project/, name);
    assert.equal(calls.length, 0, name);
  }
});

test("DOCS-01 input: a file symlink escaping the project is rejected and never spawns", async () => {
  const root = makeProject();
  const outside = tmp("gsd-doc-out-");
  writeFileSync(join(outside, "secret.md"), "secret\n");
  symlinkSync(join(outside, "secret.md"), join(root, "leak.md"));
  const { run, calls } = successRunner();
  const ctx = await runDoc(root, "leak.md", { run });
  const msg = onlyError(ctx);
  assert.match(msg, /outside this project/);
  assert.ok(msg.includes(realpathSync(join(outside, "secret.md"))), msg);
  assert.equal(calls.length, 0);
});

test("DOCS-01 input: a directory symlink escaping the project is rejected and never spawns", async () => {
  const root = makeProject();
  const outside = tmp("gsd-doc-out-");
  writeFileSync(join(outside, "x.md"), "x\n");
  symlinkSync(outside, join(root, "docs"));
  const { run, calls } = successRunner();
  const ctx = await runDoc(root, "docs/x.md", { run });
  assert.match(onlyError(ctx), /outside this project/);
  assert.equal(calls.length, 0);
});

test("DOCS-01 input: an absolute .md path in another directory is rejected and never spawns", async () => {
  const root = makeProject();
  const outside = tmp("gsd-doc-out-");
  writeFileSync(join(outside, "other.md"), "other\n");
  const { run, calls } = successRunner();
  const ctx = await runDoc(root, join(outside, "other.md"), { run });
  assert.match(onlyError(ctx), /outside this project/);
  assert.equal(calls.length, 0);
});

test("DOCS-01 input: directories, non-.md files and missing files are rejected; NOTES.MD is accepted", async () => {
  const root = makeProject();
  writeFileSync(join(root, "README.txt"), "txt\n");
  writeFileSync(join(root, "NOTES.MD"), "# upper\n");
  for (const [arg, expected] of [
    [".planning", /directory/],
    ["README.txt", /Only \.md files/],
    ["missing.md", /File not found/],
  ] as Array<[string, RegExp]>) {
    const { run, calls } = successRunner();
    const ctx = await runDoc(root, arg, { run });
    assert.match(onlyError(ctx), expected, arg);
    assert.equal(calls.length, 0, arg);
  }
  const { run, calls } = successRunner();
  const ctx = await runDoc(root, "NOTES.MD", { run });
  assert.equal(ctx.notifications[0].level, "success", ctx.notifications[0].message);
  assert.equal(calls.length, 1);
});

test("DOCS-01 input: relative paths resolve against ctx.cwd", async () => {
  const root = makeProject();
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "note.md"), "# note\n");
  const { run, calls } = successRunner();
  const ctx = makeCtx(join(root, "sub"));
  await mods.context.withCommandCwd(join(root, "sub"), () => mods.doc.handleDoc("note.md", ctx as any, { run }));
  assert.equal(ctx.notifications[0].level, "success", ctx.notifications[0].message);
  assert.equal(calls[0][2], realpathSync(join(root, "sub", "note.md")));
});

test("DOCS-01 input: --keep passes through before --json, from either side of the path", async () => {
  const root = makeProject();
  for (const args of [".planning/notes.md --keep", "--keep .planning/notes.md"]) {
    const { run, calls } = successRunner();
    const ctx = await runDoc(root, args, { run });
    assert.equal(ctx.notifications[0].level, "success", ctx.notifications[0].message);
    assert.deepEqual(calls[0].slice(-2), ["--keep", "--json"], args);
  }
});

test("DOCS-01 input: a pinned result renders Pinned with no Expires line and no pin hint", async () => {
  const root = makeProject();
  const stub = makeStub({
    stdout: envelope({ ...GOOD_ROW, pinned: true, expires_at: null }),
  });
  const ctx = await runDocStub(root, stub, ".planning/notes.md --keep");
  const note = ctx.notifications[0];
  assert.equal(note.level, "success", note.message);
  assert.match(note.message, /Pinned/);
  assert.ok(!note.message.includes("Expires:"), note.message);
  assert.ok(!note.message.includes("yahir-tn pin"), note.message);
  const inv = readInvocations(stub);
  assert.deepEqual(inv[0].slice(-2), ["--keep", "--json"]);
  recordedArgvs.push(inv[0]);
});

test("DOCS-01 input: a quoted path with a space is published whole", async () => {
  const root = makeProject();
  writeFileSync(join(root, ".planning", "my notes.md"), "# spaced\n");
  const { run, calls } = successRunner();
  const ctx = await runDoc(root, '".planning/my notes.md"', { run });
  assert.equal(ctx.notifications[0].level, "success", ctx.notifications[0].message);
  assert.ok(calls[0][2].endsWith("my notes.md"), calls[0][2]);
});

test("DOCS-01 input: unknown options, empty args and multiple paths are rejected and never spawn", async () => {
  const root = makeProject();
  writeFileSync(join(root, ".planning", "two.md"), "# two\n");
  for (const [args, expected] of [
    ["--force", /Unknown option "--force"[\s\S]*Usage: \/gsd doc/],
    ["", /Usage: \/gsd doc/],
    [".planning/notes.md .planning/two.md", /exactly one path/],
  ] as Array<[string, RegExp]>) {
    const { run, calls } = successRunner();
    const ctx = await runDoc(root, args, { run });
    assert.match(onlyError(ctx), expected, JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test("DOCS-01 input: sanitizeProjectSlug table", () => {
  const { sanitizeProjectSlug } = mods.doc;
  const long = "a1".repeat(40);
  assert.equal(sanitizeProjectSlug("y-pi-gsd"), "y-pi-gsd");
  assert.equal(sanitizeProjectSlug("My Project"), "My-Project");
  assert.equal(sanitizeProjectSlug(".hidden"), "hidden");
  assert.equal(sanitizeProjectSlug("site.html"), "site");
  assert.equal(sanitizeProjectSlug("a.HTML.htm"), "a");
  assert.equal(sanitizeProjectSlug(long), long.slice(0, 64));
  assert.equal(sanitizeProjectSlug("___"), null);
});

test("DOCS-01 input: an unsanitizable project directory name is a loud error with no spawn", async () => {
  const parent = tmp("gsd-doc-parent-");
  const root = join(parent, "___");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".planning"));
  writeFileSync(join(root, ".planning", "notes.md"), "# n\n");
  const { run, calls } = successRunner();
  const ctx = await runDoc(root, ".planning/notes.md", { run });
  assert.match(onlyError(ctx), /Cannot derive/);
  assert.equal(calls.length, 0);
});

test("DOCS-01 input: no argv element after the verb can be read as an option", () => {
  assert.ok(recordedArgvs.length >= 5, `expected recorded invocations, got ${recordedArgvs.length}`);
  for (const argv of recordedArgvs) {
    assert.equal(argv[0], "doc");
    for (const el of argv.slice(1)) {
      if (el === "--keep" || el === "--json") continue;
      assert.ok(el.startsWith("/") || /^[A-Za-z0-9]/.test(el), `option-like argv element: ${el}`);
    }
  }
});

// ─── 44-02 Task 1: registration + dispatcher tracer ─────────────────────────

test("DOCS-01 dispatcher tracer: /gsd doc through handleGSDCommand publishes once and never reaches the natural-language router", async () => {
  // No .gsd dir: the workspace-git preflight's ensureDbOpen creates no database.
  const base = makeTempRepo("gsd-doc-dispatch-");
  tempDirs.add(base);
  mkdirSync(join(base, ".planning"), { recursive: true });
  writeFileSync(join(base, ".planning", "notes.md"), "# notes\n");
  const slug = basename(base);
  const real = realpathSync(join(base, ".planning", "notes.md"));
  const url = `https://h.ts.net/Doc/${slug}/notes.html`;
  const stub = makeStub({
    stdout: envelope({
      name: `doc:${slug}/notes`,
      url,
      source: real,
      expires_at: "2026-10-16T08:00:00+00:00",
      pinned: false,
      state: "up",
    }),
  });
  const notifications: Note[] = [];
  const sent: unknown[] = [];
  const ctx = {
    cwd: base,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
      setWidget: () => {},
      setStatus: () => {},
      custom: async () => {},
    },
  };
  const pi = { sendMessage: (m: unknown) => sent.push(m) };

  await withPath(`${stub}${delimiter}${pathWithoutRealYahirTn()}`, () =>
    mods.dispatcher.handleGSDCommand("doc .planning/notes.md", ctx as any, pi as any),
  );

  assert.equal(sent.length, 0, "must not fall through to the natural-language router");
  assert.equal(notifications.length, 1, JSON.stringify(notifications));
  assert.equal(notifications[0].level, "success");
  assert.ok(notifications[0].message.split("\n")[0].includes(url), notifications[0].message);
  assert.deepEqual(readInvocations(stub), [["doc", slug, real, "--json"]]);
});

test("DOCS-01 registration: doc is in the description, the top-level catalog, showHelp full and top-level completion", () => {
  const { GSD_COMMAND_DESCRIPTION, TOP_LEVEL_SUBCOMMANDS, getGsdArgumentCompletions } = mods.catalog;
  assert.match(GSD_COMMAND_DESCRIPTION, /\|doc(\||$)/);
  assert.equal(TOP_LEVEL_SUBCOMMANDS.filter((c) => c.cmd === "doc").length, 1);

  const lines: string[] = [];
  const helpCtx = {
    ui: {
      notify(message: string) {
        lines.push(...message.split("\n"));
      },
      custom: async () => {},
    },
  };
  mods.core.showHelp(helpCtx as any, "full");
  assert.ok(lines.some((l) => /^\s+\/gsd\s+doc\b/.test(l)), "showHelp full lacks a /gsd doc line");

  assert.ok(getGsdArgumentCompletions("do").some((i) => i.value === "doc"));
});

test("DOCS-01 registration: the doc arm is exact-match", async () => {
  for (const input of ["docs", "docx notes.md"]) {
    const ctx = makeCtx(process.cwd());
    const handled = await mods.ops.handleOpsCommand(input, ctx as any, mockPi as any);
    assert.equal(handled, false, input);
    assert.equal(ctx.notifications.length, 0, input);
  }
});

// ─── 44-02 Task 2: tab-completion ───────────────────────────────────────────

/** Project with a real .planning/, a symlinked .gsd, noise dirs and files. */
function makeCompletionProject(): string {
  const base = tmp("gsd-doc-comp-");
  const external = tmp("gsd-doc-comp-ext-");
  writeFileSync(join(external, "state.md"), "# s\n");
  mkdirSync(join(base, ".planning"));
  writeFileSync(join(base, ".planning", "notes.md"), "# n\n");
  symlinkSync(external, join(base, ".gsd"));
  mkdirSync(join(base, "node_modules"));
  mkdirSync(join(base, ".git"));
  mkdirSync(join(base, "sub"));
  writeFileSync(join(base, "README.md"), "# r\n");
  writeFileSync(join(base, "notes.txt"), "x\n");
  return base;
}

const values = (items: Array<{ value: string }>) => items.map((i) => i.value);

test("DOCS-01 completion: root listing offers dirs (symlinked .gsd included) and .md files, skips noise", () => {
  const base = makeCompletionProject();
  const items = mods.catalog.getDocPathCompletions("", base);
  const v = values(items);
  for (const want of ["doc .planning/", "doc .gsd/", "doc sub/", "doc README.md"]) {
    assert.ok(v.includes(want), `${want} missing from ${JSON.stringify(v)}`);
  }
  for (const bad of ["doc node_modules/", "doc .git/", "doc notes.txt"]) {
    assert.ok(!v.includes(bad), `${bad} should be absent`);
  }
  for (const i of items) {
    if (i.value.endsWith("/")) assert.ok(i.label.endsWith("/"), i.label);
  }
});

test("DOCS-01 completion: drill-down, prefix filter and symlink target listing", () => {
  const base = makeCompletionProject();
  assert.ok(values(mods.catalog.getDocPathCompletions(".planning/", base)).includes("doc .planning/notes.md"));
  assert.deepEqual(values(mods.catalog.getDocPathCompletions(".planning/no", base)), ["doc .planning/notes.md"]);
  assert.deepEqual(values(mods.catalog.getDocPathCompletions(".gsd/", base)), ["doc .gsd/state.md"]);
});

test("DOCS-01 completion: dangling symlinks and missing directories never throw", () => {
  const base = makeCompletionProject();
  symlinkSync(join(base, "does-not-exist"), join(base, "gone.md"));
  const v = values(mods.catalog.getDocPathCompletions("", base));
  assert.ok(!v.includes("doc gone.md"), "dangling symlink must be skipped");
  assert.deepEqual(mods.catalog.getDocPathCompletions("nope/", base), []);
});

test("DOCS-01 completion: results are capped at DOC_COMPLETION_LIMIT and sorted by label", () => {
  const base = tmp("gsd-doc-comp-cap-");
  for (let i = 0; i < 60; i++) writeFileSync(join(base, `f${String(i).padStart(2, "0")}.md`), "x\n");
  const items = mods.catalog.getDocPathCompletions("", base);
  assert.equal(mods.catalog.DOC_COMPLETION_LIMIT, 50);
  assert.equal(items.length, mods.catalog.DOC_COMPLETION_LIMIT);
  const labels = items.map((i) => i.label);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)));
});

test("DOCS-01 completion: upper-case .MD files are offered", () => {
  const base = tmp("gsd-doc-comp-case-");
  writeFileSync(join(base, "NOTES.MD"), "x\n");
  assert.deepEqual(values(mods.catalog.getDocPathCompletions("", base)), ["doc NOTES.MD"]);
});

test("DOCS-01 completion: through getGsdArgumentCompletions (cwd-relative, --keep before and after the path)", () => {
  const base = makeCompletionProject();
  const savedCwd = process.cwd();
  process.chdir(base);
  try {
    const { getGsdArgumentCompletions } = mods.catalog;
    assert.ok(values(getGsdArgumentCompletions("doc ")).includes("doc .planning/"));
    assert.deepEqual(values(getGsdArgumentCompletions("doc -")), ["doc --keep"]);
    assert.ok(values(getGsdArgumentCompletions("doc .planning/notes.md ")).includes("doc .planning/notes.md --keep"));
    assert.ok(values(getGsdArgumentCompletions("doc --keep .pl")).includes("doc --keep .planning/"));
  } finally {
    process.chdir(savedCwd);
  }
});

test("DOCS-01 completion (WR-02): names that cannot round-trip through parseDocArgs are not offered", () => {
  const base = tmp("gsd-doc-comp-rt-");
  writeFileSync(join(base, "ok.md"), "x\n");
  writeFileSync(join(base, "my notes.md"), "x\n");
  writeFileSync(join(base, "-x.md"), "x\n");
  writeFileSync(join(base, "q'uote.md"), "x\n");
  writeFileSync(join(base, "esc\u001b[31m.md"), "x\n");
  mkdirSync(join(base, "sp ace"));
  mkdirSync(join(base, "sub"));
  writeFileSync(join(base, "sub", "-y.md"), "x\n");
  assert.deepEqual(values(mods.catalog.getDocPathCompletions("", base)), ["doc ok.md", "doc sub/"]);
  // Inside a directory the token starts with the dir name, so a leading dash is safe.
  assert.deepEqual(values(mods.catalog.getDocPathCompletions("sub/", base)), ["doc sub/-y.md"]);
  for (const v of values(mods.catalog.getDocPathCompletions("", base))) {
    const parsed = mods.doc.parseDocArgs(v.slice("doc ".length));
    assert.ok(parsed.ok, v);
  }
});

test("DOCS-01 completion: D-04 boundary - no pin, unpin or ls entries", () => {
  const base = tmp("gsd-doc-comp-d04-");
  const savedCwd = process.cwd();
  process.chdir(base);
  try {
    const banned = new Set(["doc pin", "doc unpin", "doc ls"]);
    for (const prefix of ["doc ", "doc p", "doc u", "doc l"]) {
      for (const v of values(mods.catalog.getGsdArgumentCompletions(prefix))) {
        assert.ok(!banned.has(v), `${prefix} offered ${v}`);
      }
    }
  } finally {
    process.chdir(savedCwd);
  }
});
