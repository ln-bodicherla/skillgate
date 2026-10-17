import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  packTree,
  unpackTree,
  readPacket,
  worker,
  vmDoctor,
} from "../src/vm.js";
import { doctor } from "../src/sandbox.js";
import { execute } from "../src/process.js";
import { digest, snapshot, hash } from "../src/files.js";
test("VM transfer round-trips verified content and rejects path traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillwall-packet-"));
  try {
    const files = await packTree(resolve("examples/v1"));
    await unpackTree(files, join(dir, "copy"));
    assert.equal(
      digest(await snapshot(join(dir, "copy"))),
      digest(await snapshot(resolve("examples/v1"))),
    );
    await assert.rejects(
      unpackTree(
        [{ path: "../escape", data: "", sha256: hash("") }],
        join(dir, "bad"),
      ),
      /Unsafe/,
    );
    await assert.rejects(
      unpackTree(
        [{ path: "file", data: "YQ==", sha256: hash("wrong") }],
        join(dir, "digest"),
      ),
      /digest/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("worker packets reject unsupported operations and invalid commands", async () => {
  await assert.rejects(worker({ schemaVersion: 2 }), /Unsupported/);
  await assert.rejects(
    worker({ schemaVersion: 1, operation: "run", command: ["relative"] }),
    /Invalid/,
  );
  assert.deepEqual(await readPacket(Readable.from([Buffer.from('{"a":1}')])), {
    a: 1,
  });
});
test("VM host configuration fails closed before starting SSH", async () => {
  const result = await vmDoctor({
    type: "vm",
    host: "host; touch bad",
    cli: "/app/cli.js",
  });
  assert.equal(result.ok, false);
});
test("guest worker performs real sandbox execution through the stdin protocol", async (t) => {
  const health = await doctor();
  if (!health.ok) {
    if (process.env.SKILLWALL_REQUIRE_SANDBOX) assert.fail(health.reason);
    t.skip(health.reason);
    return;
  }
  const request = {
    schemaVersion: 1,
    operation: "run",
    skill: await packTree(resolve("examples/v1")),
    fixture: await packTree(resolve("examples/workspace")),
    checks: await packTree(resolve("examples/checks")),
    command: ["/usr/bin/python3", "/skill/run.py"],
    verify: ["/usr/bin/python3", "/checks/verify.py"],
    timeoutMs: 5000,
  };
  const result = await execute(
    process.execPath,
    [resolve("src/cli.js"), "_worker"],
    {
      input: JSON.stringify(request),
      timeoutMs: 10000,
      maxOutput: 4 * 1024 * 1024,
    },
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const response = JSON.parse(result.stdout);
  assert.equal(response.report.execution.code, 0);
  assert.equal(response.report.verification.code, 0);
  assert(response.traces.length > 0);
});
