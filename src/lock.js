import {
  readFile,
  writeFile,
  open,
  rename,
  unlink,
  lstat,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, snapshot, within, hash } from "./files.js";
import { compare } from "./compare.js";

export async function fingerprint(skill) {
  const root = resolve(skill),
    info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Skill must be a real directory.");
  await readFile(join(root, "SKILL.md"), "utf8");
  return digest(await snapshot(root, { rejectLinks: true }));
}
function validateName(name) {
  if (
    typeof name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)
  )
    throw new Error(
      "Name must contain 1–100 letters, digits, dots, underscores or hyphens.",
    );
}
async function readLock(path, missing = false) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (missing && error.code === "ENOENT")
      return { schemaVersion: 1, skills: {} };
    throw error;
  }
  if (
    value.schemaVersion !== 1 ||
    !value.skills ||
    typeof value.skills !== "object" ||
    Array.isArray(value.skills)
  )
    throw new Error("Unsupported or malformed lockfile.");
  for (const [name, entry] of Object.entries(value.skills)) {
    validateName(name);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error("Invalid lockfile digest.");
  }
  return value;
}
async function mutate(lock, protectedDirectories, operation) {
  lock = resolve(lock);
  if (protectedDirectories.some((dir) => within(lock, dir)))
    throw new Error("Lockfile must be outside skill and evidence directories.");
  const guard = `${lock}.guard`,
    temporary = join(dirname(lock), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(guard, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another lockfile operation is active; inspect the .guard file if a previous process crashed.",
      );
    throw error;
  }
  try {
    const state = await readLock(lock, true);
    const result = await operation(state);
    if (result.changed) {
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, lock);
    }
    return result;
  } finally {
    await handle.close();
    await unlink(guard);
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export async function pin({ skill, name, lock }) {
  validateName(name);
  return mutate(lock, [resolve(skill)], async (state) => {
    if (Object.hasOwn(state.skills, name))
      throw new Error(
        "Skill is already pinned. Use accept to review an update.",
      );
    const sha256 = await fingerprint(skill);
    Object.defineProperty(state.skills, name, {
      value: {
        sha256,
        acceptedAt: new Date().toISOString(),
        basis: "explicit-initial-pin",
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return { changed: true, status: "PINNED", sha256 };
  });
}
export async function verifyLock({ skill, name, lock }) {
  validateName(name);
  const state = await readLock(resolve(lock));
  if (!Object.hasOwn(state.skills, name))
    throw new Error("Skill is not pinned.");
  const actual = await fingerprint(skill),
    expected = state.skills[name].sha256;
  return { status: actual === expected ? "MATCH" : "DRIFT", expected, actual };
}
export async function accept({
  old,
  candidate,
  scenario,
  out,
  name,
  lock,
  runner,
}) {
  validateName(name);
  // Evidence is generated now; an externally supplied JSON status is never trusted.
  return mutate(
    lock,
    [resolve(old), resolve(candidate), resolve(out)],
    async (state) => {
      if (!Object.hasOwn(state.skills, name))
        throw new Error("Pin the initial version first.");
      const expected = state.skills[name].sha256;
      if ((await fingerprint(old)) !== expected)
        throw new Error("Baseline does not match the pinned skill.");
      const report = await compare({ old, candidate, scenario, out, runner });
      if (report.status !== "PASS")
        return {
          changed: false,
          status: report.status,
          report: resolve(out, "report.html"),
        };
      if (report.baseline.some((run) => run.skillDigest !== expected))
        throw new Error("Baseline changed while preparing the comparison.");
      const sha256 = report.candidate[0].skillDigest;
      if (
        report.candidate.some((run) => run.skillDigest !== sha256) ||
        (await fingerprint(candidate)) !== sha256 ||
        (await fingerprint(old)) !== expected
      )
        throw new Error(
          "Skill changed during review. Lockfile was not updated.",
        );
      const previous = state.skills[name];
      const history = [
        ...(previous.history ?? []),
        {
          sha256: previous.sha256,
          acceptedAt: previous.acceptedAt,
          basis: previous.basis,
        },
      ];
      state.skills[name] = {
        sha256,
        acceptedAt: new Date().toISOString(),
        basis: "scenario-pass",
        report: resolve(out, "report.json"),
        evidenceSha256: hash(await readFile(resolve(out, "report.json"))),
        scenarios: report.scenarios.map((c) => ({
          name: c.scenario,
          scenarioDigest: c.scenarioDigest,
          inputDigests: c.inputDigests,
        })),
        history,
      };
      return {
        changed: true,
        status: "ACCEPTED",
        sha256,
        report: resolve(out, "report.html"),
      };
    },
  );
}
