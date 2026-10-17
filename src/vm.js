// Transport to a user-provisioned disposable Linux VM. SSH host keys are mandatory.
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  readdir,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { snapshot, hash } from "./files.js";
import { execute, tool } from "./process.js";
import { commandOK, relativePath, normalizeRunner } from "./config.js";
const MAX_PACKET = 32 * 1024 * 1024,
  MAX_DATA = 16 * 1024 * 1024;
export async function readPacket(stream) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_PACKET) throw new Error("VM packet exceeds 32 MiB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function packTree(root) {
  const tree = await snapshot(root, { rejectLinks: true }),
    files = [];
  let bytes = 0;
  for (const [path, info] of Object.entries(tree)) {
    bytes += info.bytes;
    if (bytes > MAX_DATA)
      throw new Error("VM transfer exceeds 16 MiB per directory.");
    files.push({
      path,
      data: (await readFile(join(root, path))).toString("base64"),
      sha256: info.sha256,
      executable: info.executable,
    });
  }
  return files;
}
export async function unpackTree(files, root) {
  if (!Array.isArray(files) || files.length > 2000)
    throw new Error("Invalid VM file list.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const seen = new Set();
  let total = 0;
  for (const file of files) {
    if (
      !file ||
      !relativePath(file.path) ||
      file.path === "." ||
      seen.has(file.path) ||
      typeof file.data !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
    )
      throw new Error("Unsafe VM file entry.");
    seen.add(file.path);
    const data = Buffer.from(file.data, "base64");
    total += data.length;
    if (
      total > MAX_DATA ||
      data.length > 8 * 1024 * 1024 ||
      hash(data) !== file.sha256
    )
      throw new Error("VM file size or digest mismatch.");
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, {
      flag: "wx",
      mode: file.executable ? 0o700 : 0o600,
    });
  }
}
async function remote(runner, request, timeoutMs) {
  runner = normalizeRunner(runner);
  const ssh = tool("ssh");
  if (!ssh) throw new Error("VM runner requires ssh.");
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > MAX_PACKET)
    throw new Error("VM request exceeds 32 MiB.");
  const result = await execute(
    ssh,
    [
      ...(runner.sshConfig ? ["-F", runner.sshConfig] : []),
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=1",
      runner.host,
      "/usr/bin/node",
      runner.cli,
      "_worker",
    ],
    { input, timeoutMs, maxOutput: MAX_PACKET },
  );
  if (result.code !== 0 || result.outputLimit || result.timedOut)
    throw new Error(
      `VM execution failed: ${result.stderr || result.stdout || result.spawnError || "transport terminated"}`,
    );
  const response = JSON.parse(result.stdout);
  if (response.schemaVersion !== 1 || response.error)
    throw new Error(
      `VM worker error: ${response.error || "unsupported protocol"}`,
    );
  return response;
}
export async function vmDoctor(runner) {
  try {
    const r = await remote(
      runner,
      { schemaVersion: 1, operation: "doctor" },
      10000,
    );
    return { ...r.health, runner };
  } catch (error) {
    return {
      ok: false,
      reason: error.message,
      runner,
      tools: { ssh: tool("ssh") },
    };
  }
}
export async function runInVM(options) {
  const request = {
    schemaVersion: 1,
    operation: "run",
    skill: await packTree(options.skill),
    fixture: await packTree(options.fixture),
    checks: await packTree(options.checks),
    command: options.command,
    verify: options.verify,
    adapter: options.adapter,
    timeoutMs: options.timeoutMs,
    workspaceMiB: options.workspaceMiB,
    expectedDigest: options.expectedDigest,
    policy: options.policy,
    allowedWrites: options.allowedWrites,
  };
  const response = await remote(
    options.runner,
    request,
    options.timeoutMs * 2 + 15000,
  );
  if (
    !response.report ||
    !Array.isArray(response.report.trace?.events) ||
    !Array.isArray(response.report.changes)
  )
    throw new Error("Malformed VM evidence.");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await unpackTree(response.traces, join(options.directory, "guest-traces"));
  response.report.runner = options.runner;
  await writeFile(
    join(options.directory, "run.json"),
    JSON.stringify(response.report, null, 2),
  );
  return response.report;
}
export async function worker(request) {
  if (!request || request.schemaVersion !== 1)
    throw new Error("Unsupported worker protocol.");
  const { doctor, runVersion } = await import("./sandbox.js");
  if (request.operation === "doctor")
    return { schemaVersion: 1, health: await doctor() };
  if (
    request.operation !== "run" ||
    (!request.adapter && !commandOK(request.command)) ||
    !commandOK(request.verify) ||
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < 500 ||
    request.timeoutMs > 30000
  )
    throw new Error("Invalid worker request.");
  const health = await doctor();
  if (!health.ok) throw new Error(health.reason);
  const dir = await mkdtemp(join(tmpdir(), "skillgate-worker-"));
  try {
    for (const name of ["skill", "fixture", "checks"])
      await unpackTree(request[name], join(dir, name));
    const directory = join(dir, "run");
    const report = await runVersion({
      skill: join(dir, "skill"),
      fixture: join(dir, "fixture"),
      checks: join(dir, "checks"),
      command: request.command,
      verify: request.verify,
      adapter: request.adapter,
      timeoutMs: request.timeoutMs,
      workspaceMiB: request.workspaceMiB,
      expectedDigest: request.expectedDigest,
      policy: request.policy,
      allowedWrites: request.allowedWrites,
      directory,
    });
    const traces = [];
    let total = 0;
    for (const name of await readdir(directory)) {
      if (!/^trace(?:-\d+)?\.log$/.test(name)) continue;
      const data = await readFile(join(directory, name));
      total += data.length;
      if (total > MAX_DATA) throw new Error("VM traces exceed transfer limit.");
      traces.push({
        path: name,
        data: data.toString("base64"),
        sha256: hash(data),
        executable: false,
      });
    }
    return { schemaVersion: 1, report, traces };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
