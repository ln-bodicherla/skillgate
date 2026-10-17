import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pin, verifyLock, accept } from "../src/lock.js";
import { copyTree } from "../src/files.js";
import { doctor } from "../src/sandbox.js";

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "skillgate-lock-"));
  try {
    await copyTree(resolve("examples/v1"), join(dir, "skill"));
    await fn({
      dir,
      skill: join(dir, "skill"),
      lock: join(dir, "skills.lock.json"),
      name: "invoices",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("initial pin, verification and content drift detection", async () =>
  fixture(async (options) => {
    assert.equal((await pin(options)).status, "PINNED");
    assert.equal((await verifyLock(options)).status, "MATCH");
    const before = await readFile(options.lock, "utf8");
    await assert.rejects(pin(options), /already pinned/);
    await writeFile(join(options.skill, "run.py"), 'print("changed")\n');
    assert.equal((await verifyLock(options)).status, "DRIFT");
    assert.equal(await readFile(options.lock, "utf8"), before);
  }));
test("malformed state, unsafe placement and symlink skills are rejected", async () =>
  fixture(async (options) => {
    await assert.rejects(
      pin({ ...options, lock: join(options.skill, "lock.json") }),
      /outside/,
    );
    await symlink(options.skill, join(options.dir, "link"));
    await assert.rejects(
      pin({ ...options, skill: join(options.dir, "link") }),
      /real directory/,
    );
    await writeFile(options.lock, '{"schemaVersion":2,"skills":{}}');
    await assert.rejects(pin(options), /malformed/);
  }));
test("concurrent operations cannot replace an existing guard", async () =>
  fixture(async (options) => {
    await writeFile(options.lock + ".guard", "other operation");
    await assert.rejects(pin(options), /operation is active/);
    assert.equal(
      await readFile(options.lock + ".guard", "utf8"),
      "other operation",
    );
  }));
test("accept gates updates with fresh sandbox evidence and preserves lock on HOLD", async (t) => {
  const health = await doctor();
  if (!health.ok) {
    if (process.env.SKILLGATE_REQUIRE_SANDBOX) assert.fail(health.reason);
    t.skip(health.reason);
    return;
  }
  await fixture(async (options) => {
    await pin(options);
    const before = await readFile(options.lock, "utf8");
    const common = {
      old: options.skill,
      name: options.name,
      lock: options.lock,
      scenario: resolve("examples/scenario.json"),
    };
    const held = await accept({
      ...common,
      candidate: resolve("examples/v2"),
      out: join(options.dir, "held"),
    });
    assert.equal(held.status, "HOLD");
    assert.equal(await readFile(options.lock, "utf8"), before);
    const candidate = join(options.dir, "new");
    await copyTree(options.skill, candidate);
    const script = join(candidate, "run.py");
    await writeFile(
      script,
      (await readFile(script, "utf8")) + "\n# Reviewed maintenance update.\n",
    );
    const accepted = await accept({
      ...common,
      candidate,
      out: join(options.dir, "accepted"),
    });
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal(
      (await verifyLock({ ...options, skill: candidate })).status,
      "MATCH",
    );
    assert.equal((await verifyLock(options)).status, "DRIFT");
    const after = await readFile(options.lock, "utf8");
    await assert.rejects(
      accept({
        ...common,
        candidate,
        out: join(options.dir, "wrong-baseline"),
      }),
      /Baseline does not match/,
    );
    assert.equal(await readFile(options.lock, "utf8"), after);
  });
});

test("prototype-like filenames are included in pinned content", async () =>
  fixture(async (options) => {
    await pin(options);
    await writeFile(join(options.skill, "__proto__"), "must be hashed");
    assert.equal((await verifyLock(options)).status, "DRIFT");
  }));
