import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseTrace, newEvents } from "../src/trace.js";
import { escapeHTML } from "../src/report.js";
import { copyTree } from "../src/files.js";
import { compare } from "../src/compare.js";
import { doctor } from "../src/sandbox.js";
test("trace records failed access and network attempts", () => {
  const t = parseTrace(
    '12 execve("/usr/bin/python3", [], []) = 0\n12 openat(AT_FDCWD, "/home/agent/.ssh/key", O_RDONLY) = -1 ENOENT (missing)\n12 connect(3, {sin_port=htons(443), sin_addr=inet_addr("203.0.113.1")}, 16) = -1 ENETUNREACH (blocked)',
    "/usr/bin/python3",
  );
  assert.equal(t.started, true);
  assert.equal(t.incomplete, 0);
  assert(
    t.events.some((e) => e.type === "network" && e.errno === "ENETUNREACH"),
  );
  assert(
    t.events.some((e) => e.target === "/home/agent/.ssh/key" && !e.success),
  );
  assert.equal(
    newEvents([], [...t.events, ...t.events]).length,
    t.events.length,
  );
});
test("unresolved trace is not complete coverage", () => {
  const t = parseTrace(
    '1 execve("/x", [], []) = 0\n1 openat(AT_FDCWD, "relative", O_RDONLY) = 3\n1 broken record',
    "/x",
  );
  assert.equal(t.incomplete, 1);
  assert(t.events.some((e) => e.type === "unresolved-file"));
});
test("report escapes executable HTML", () =>
  assert.equal(escapeHTML('<script>"&'), "&lt;script&gt;&quot;&amp;"));
test("input symlinks are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillwall-links-"));
  try {
    await mkdir(join(dir, "source"));
    await symlink("/etc/passwd", join(dir, "source", "secret"));
    await assert.rejects(
      copyTree(join(dir, "source"), join(dir, "dest")),
      /Symlinks/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("real namespace comparison passes identical skill and holds unwanted update", async (t) => {
  const health = await doctor();
  if (!health.ok) {
    if (process.env.SKILLWALL_REQUIRE_SANDBOX) assert.fail(health.reason);
    t.skip(health.reason);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "skillwall-integration-"));
  const before = await readFile("examples/workspace/invoices.json", "utf8");
  try {
    const options = {
      old: resolve("examples/v1"),
      scenario: resolve("examples/scenario.json"),
    };
    const same = await compare({
      ...options,
      candidate: options.old,
      out: join(dir, "same"),
    });
    assert.equal(same.status, "PASS");
    const update = await compare({
      ...options,
      candidate: resolve("examples/v2"),
      out: join(dir, "update"),
    });
    assert.equal(update.status, "HOLD");
    assert.equal(update.candidate[0].verification.code, 0);
    assert(update.addedEvents.some((e) => e.type === "network" && !e.success));
    assert(update.addedEvents.some((e) => e.target.includes("/.ssh/")));
    assert.equal(
      await readFile("examples/workspace/invoices.json", "utf8"),
      before,
    );
    await assert.rejects(
      compare({ ...options, candidate: options.old, out: join(dir, "same") }),
      /EEXIST/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("sandbox hides host environment and rejects writes to skill/check mounts", async (t) => {
  const health = await doctor();
  if (!health.ok) {
    if (process.env.SKILLWALL_REQUIRE_SANDBOX) assert.fail(health.reason);
    t.skip(health.reason);
    return;
  }
  const { runVersion } = await import("../src/sandbox.js");
  const { writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "skillwall-isolation-"));
  process.env.SKILLWALL_TEST_SECRET = "host-secret";
  try {
    await mkdir(join(dir, "skill"));
    await writeFile(
      join(dir, "skill", "probe.py"),
      `import os\nfrom pathlib import Path\nassert 'SKILLWALL_TEST_SECRET' not in os.environ\nassert not Path('/etc/passwd').exists()\nfor path in ['/skill/tampered', '/checks/tampered']:\n    try:\n        Path(path).write_text('bad')\n    except OSError:\n        pass\n    else:\n        raise AssertionError('read-only mount was writable')\n`,
    );
    const result = await runVersion({
      skill: join(dir, "skill"),
      fixture: resolve("examples/workspace"),
      checks: resolve("examples/checks"),
      command: ["/usr/bin/python3", "/skill/probe.py"],
      verify: null,
      directory: join(dir, "run"),
      timeoutMs: 5000,
    });
    assert.equal(result.execution.code, 0, result.execution.stderr);
  } finally {
    delete process.env.SKILLWALL_TEST_SECRET;
    await rm(dir, { recursive: true, force: true });
  }
});
