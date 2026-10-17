import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizePolicy, normalizeRunner } from "../src/config.js";
import { violations } from "../src/policy.js";
import { parseTrace } from "../src/trace.js";
import { renderSARIF } from "../src/report.js";
import { compare, decide } from "../src/compare.js";
import { doctor, runVersion } from "../src/sandbox.js";
import { pin, verifyLock } from "../src/lock.js";
import { runPinned, installPinned } from "../src/lifecycle.js";
import { copyTree } from "../src/files.js";
import { execute } from "../src/process.js";

async function temp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "skillgate-feature-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function ready(t, runner) {
  const health = await doctor(runner);
  if (health.ok) return true;
  if (
    process.env.SKILLGATE_REQUIRE_SANDBOX &&
    (!runner || runner.type === "bubblewrap")
  )
    assert.fail(health.reason);
  t.skip(health.reason);
  return false;
}
test("policy validation rejects unsupported network grants and misspelled rules", () => {
  assert.throws(
    () => normalizePolicy({ policy: { network: "allow" } }),
    /never enabled/,
  );
  assert.throws(
    () => normalizePolicy({ policy: { allowNewRead: true } }),
    /Unknown/,
  );
  assert.throws(
    () => normalizePolicy({ policy: { deniedReads: ["relative"] } }),
    /invalid/,
  );
  assert.throws(
    () => normalizeRunner({ type: "cgroup", memoryMiB: 1 }),
    /memoryMiB/,
  );
  assert.throws(
    () =>
      normalizeRunner({ type: "vm", host: "-oProxyCommand=x", cli: "/tmp/a" }),
    /requires/,
  );
});
test("explicit policies detect identical forbidden activity in both versions", () => {
  const policy = normalizePolicy({
    policy: { allowedProcesses: ["/usr/bin/python3"] },
  });
  const run = {
    execution: { code: 0, stdout: "" },
    verification: { code: 0 },
    trace: {
      started: true,
      incomplete: 0,
      events: [
        { type: "network", target: "203.0.113.1:443", success: false },
        { type: "file-read", target: "/home/agent/.ssh/id", success: false },
      ],
    },
    changes: [],
  };
  assert.equal(violations(run, policy).length, 2);
  assert.equal(decide([run], [run], [], policy).status, "HOLD");
});
test("relative dirfds, rename destinations and readlink output decode correctly", () => {
  const trace = parseTrace(
    '1 execve("/x", [], []) = 0\n1 openat(AT_FDCWD</workspace>, "input.json", O_RDONLY) = 3</workspace/input.json>\n1 renameat(4</workspace>, "old.txt", 4</workspace>, "new.txt") = 0\n1 readlinkat(AT_FDCWD</workspace>, "/usr/bin/python3", "python3.14", 100) = 10',
    "/x",
  );
  assert(trace.events.some((e) => e.target === "/workspace/input.json"));
  assert(
    trace.events.some(
      (e) => e.type === "file-write" && e.target === "/workspace/new.txt",
    ),
  );
  assert(!trace.events.some((e) => e.type === "unresolved-file"));
});
test("truncated path strings remain incomplete evidence", () => {
  assert.equal(
    parseTrace(
      '1 execve("/x", [], []) = 0\n1 openat(AT_FDCWD, "/long"..., O_RDONLY) = -1 ENOENT (missing)',
      "/x",
    ).incomplete,
    1,
  );
});
test("process timeout and output bounds terminate execution", async () => {
  const timed = await execute(
    "/usr/bin/python3",
    ["-c", "import time;time.sleep(10)"],
    { timeoutMs: 100 },
  );
  assert(timed.timedOut);
  const loud = await execute(
    "/usr/bin/python3",
    ["-c", 'print("x" * 200000)'],
    { timeoutMs: 3000, maxOutput: 1000 },
  );
  assert(loud.outputLimit);
});
test("scenario suite and relative paths pass real sandbox comparisons", async (t) => {
  if (!(await ready(t))) return;
  await temp(async (dir) => {
    const r = await compare({
      old: "examples/v1",
      candidate: "examples/v1",
      scenario: "examples/suite.json",
      out: join(dir, "suite"),
    });
    assert.equal(r.status, "PASS");
    assert.equal(r.scenarios.length, 2);
    assert.equal(renderSARIF(r).runs[0].results.length, 0);
    assert(
      (await readFile(join(dir, "suite", "report.html"), "utf8")).includes(
        "Relative workspace paths",
      ),
    );
  });
});
test("tool-plan and interactive agent record actual executed tool calls", async (t) => {
  if (!(await ready(t))) return;
  await temp(async (dir) => {
    for (const [name, scenario] of [
      ["plan", "plan-scenario.json"],
      ["agent", "agent-scenario.json"],
    ]) {
      const r = await compare({
        old: `examples/${name}-v1`,
        candidate: `examples/${name}-v1`,
        scenario: `examples/${scenario}`,
        out: join(dir, name),
      });
      assert.equal(r.status, "PASS", JSON.stringify(r.uncertainties));
      assert.equal(r.candidate[0].toolCalls.length, name === "agent" ? 2 : 1);
      assert(r.candidate[0].toolCalls.every((call) => call.code === 0));
    }
    const update = await compare({
      old: "examples/agent-v1",
      candidate: "examples/agent-v2",
      scenario: "examples/agent-scenario.json",
      out: join(dir, "held"),
    });
    assert.equal(update.status, "HOLD");
    assert(update.policyViolations.some((e) => e.rule === "network-denied"));
  });
});
test("run and content-addressed installation enforce the pin", async (t) => {
  if (!(await ready(t))) return;
  await temp(async (dir) => {
    const skill = join(dir, "skill");
    await copyTree(resolve("examples/v1"), skill);
    const options = {
      skill,
      name: "invoices",
      lock: join(dir, "skills.lock.json"),
    };
    await pin(options);
    const installed = await installPinned({
      ...options,
      store: join(dir, "store"),
    });
    assert.equal(installed.status, "INSTALLED");
    assert.equal(
      (await verifyLock({ ...options, skill: installed.path })).status,
      "MATCH",
    );
    assert.equal(
      (await installPinned({ ...options, store: join(dir, "store") })).path,
      installed.path,
    );
    const result = await runPinned({
      ...options,
      scenario: resolve("examples/scenario.json"),
      out: join(dir, "run"),
    });
    assert.equal(result.status, "EXECUTED");
    await writeFile(join(skill, "run.py"), 'raise Exception("must never run")');
    await assert.rejects(
      runPinned({
        ...options,
        scenario: "examples/scenario.json",
        out: join(dir, "drifted"),
      }),
      /execution refused/,
    );
    await assert.rejects(
      installPinned({ ...options, store: join(dir, "store") }),
      /installation refused/,
    );
  });
});
test("expected digest is checked before sandbox execution", async (t) => {
  if (!(await ready(t))) return;
  await temp(async (dir) => {
    await assert.rejects(
      runVersion({
        skill: resolve("examples/v1"),
        fixture: resolve("examples/workspace"),
        checks: resolve("examples/checks"),
        command: ["/usr/bin/false"],
        verify: null,
        directory: join(dir, "run"),
        timeoutMs: 1000,
        expectedDigest: "0".repeat(64),
      }),
      /execution refused/,
    );
  });
});
test("cgroup runner applies aggregate memory and process limits", async (t) => {
  const runner = {
    type: "cgroup",
    memoryMiB: 64,
    tasksMax: 16,
    cpuPercent: 100,
  };
  if (!(await ready(t, runner))) return;
  await temp(async (dir) => {
    const skill = join(dir, "skill");
    await mkdir(skill);
    await writeFile(
      join(skill, "oom.py"),
      "block = bytearray(128 * 1024 * 1024)\n",
    );
    const r = await runVersion({
      skill,
      fixture: resolve("examples/workspace"),
      checks: resolve("examples/checks"),
      command: ["/usr/bin/python3", "/skill/oom.py"],
      verify: null,
      runner,
      directory: join(dir, "run"),
      timeoutMs: 5000,
    });
    assert.notEqual(
      r.execution.code,
      0,
      "allocation larger than the entire cgroup must fail",
    );
    assert(
      !r.execution.timedOut,
      "memory failure should occur before the timeout",
    );
  });
});
test("strict write policy enforces exact writable files in the namespace", async (t) => {
  if (!(await ready(t))) return;
  await temp(async (dir) => {
    const skill = join(dir, "skill");
    await mkdir(skill);
    await writeFile(
      join(skill, "probe.py"),
      `from pathlib import Path\nPath('/workspace/result.txt').write_text('Total: 400\\n')\ntry:\n    Path('/workspace/not-allowed.txt').write_text('bad')\nexcept OSError:\n    pass\nelse:\n    raise AssertionError('unexpected write succeeded')\n`,
    );
    const run = await runVersion({
      skill,
      fixture: resolve("examples/workspace"),
      checks: resolve("examples/checks"),
      command: ["/usr/bin/python3", "/skill/probe.py"],
      verify: ["/usr/bin/python3", "/checks/verify.py"],
      policy: { enforceWrites: true },
      allowedWrites: ["result.txt"],
      directory: join(dir, "run"),
      timeoutMs: 5000,
    });
    assert.equal(run.execution.code, 0, run.execution.stderr);
    assert.equal(run.verification.code, 0);
    assert(
      run.trace.events.some(
        (e) => e.target === "/workspace/not-allowed.txt" && !e.success,
      ),
    );
  });
});

test("resolved symlink aliases and read-write opens retain sensitive reads", () => {
  const trace = parseTrace(
    '1 execve("/x", [], []) = 0\n1 openat(AT_FDCWD</workspace>, "/proc/self/root/workspace/private", O_RDWR) = 3</workspace/private>',
    "/x",
  );
  assert(
    trace.events.some(
      (e) => e.type === "file-read" && e.target === "/workspace/private",
    ),
  );
  assert.equal(
    violations(
      { trace },
      normalizePolicy({ policy: { deniedReads: ["/workspace/private"] } }),
    ).length,
    1,
  );
});
