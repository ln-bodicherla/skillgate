import { mkdir, writeFile, mkdtemp, rename, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { verifyLock, fingerprint } from "./lock.js";
import { loadScenario } from "./config.js";
import { within, copyTree } from "./files.js";
import { doctor, runVersion } from "./sandbox.js";
import { decide } from "./compare.js";
export async function runPinned({ skill, name, lock, scenario, out, runner }) {
  skill = resolve(skill);
  out = resolve(out);
  const config = await loadScenario(scenario, runner),
    pin = await verifyLock({ skill, name, lock });
  if (pin.status !== "MATCH")
    throw new Error("Skill has drifted from its pin; execution refused.");
  if (
    [skill, config.workspace, config.checks].some(
      (p) => within(out, p) || within(p, out),
    )
  )
    throw new Error("Run output must be separate from inputs.");
  const health = await doctor(config.runner);
  if (!health.ok) throw new Error(`Sandbox unavailable: ${health.reason}`);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out, { mode: 0o700 });
  const run = await runVersion({
    skill,
    expectedDigest: pin.expected,
    fixture: config.workspace,
    checks: config.checks,
    command: config.command,
    verify: config.verify,
    adapter: config.adapter,
    runner: config.runner,
    policy: config.policy,
    allowedWrites: config.allowedWrites,
    timeoutMs: config.timeoutMs,
    workspaceMiB: config.workspaceMiB,
    directory: join(out, "execution"),
  });
  const decision = decide([run], [run], config.allowedWrites, config.policy);
  const result = {
    schemaVersion: 1,
    ...decision,
    status: decision.status === "PASS" ? "EXECUTED" : decision.status,
    sha256: pin.expected,
    run,
  };
  await writeFile(join(out, "execution.json"), JSON.stringify(result, null, 2));
  return result;
}
export async function installPinned({ skill, name, lock, store }) {
  const pin = await verifyLock({ skill, name, lock });
  if (pin.status !== "MATCH")
    throw new Error("Skill has drifted; installation refused.");
  store = resolve(store);
  skill = resolve(skill);
  if (
    within(store, skill) ||
    within(skill, store) ||
    within(resolve(lock), store)
  )
    throw new Error("Store must be separate from skill and lockfile.");
  await mkdir(store, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(store, ".staging-")),
    destination = join(store, pin.expected);
  try {
    const copied = await copyTree(skill, temporary);
    if (copied.digest !== pin.expected)
      throw new Error("Skill changed during installation.");
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      if ((await fingerprint(destination)) !== pin.expected)
        throw new Error("Existing store entry has drifted.");
    }
    return { status: "INSTALLED", sha256: pin.expected, path: destination };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
