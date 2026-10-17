import { readFile } from "node:fs/promises";
import { dirname, resolve, posix } from "node:path";
export const commandOK = (c) =>
  Array.isArray(c) &&
  c.length > 0 &&
  c.length <= 100 &&
  c.every(
    (v) => typeof v === "string" && v.length <= 8192 && !v.includes("\0"),
  ) &&
  c[0].startsWith("/");
export function relativePath(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !p.includes("\0") &&
    !p.startsWith("/") &&
    !p.split("/").includes("..") &&
    posix.normalize(p) === p
  );
}
function paths(value, field, absolute = true) {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some(
      (p) =>
        typeof p !== "string" ||
        !p ||
        p === "." ||
        p.includes("\0") ||
        (absolute
          ? !p.startsWith("/") || posix.normalize(p) !== p
          : !relativePath(p)),
    )
  )
    throw new Error(`${field} contains invalid paths.`);
  return [...new Set(value)];
}
export function normalizeRunner(r = { type: "bubblewrap" }) {
  if (!r || typeof r !== "object" || Array.isArray(r))
    throw new Error("Invalid runner.");
  if (r.type === "bubblewrap") {
    if (Object.keys(r).some((k) => k !== "type"))
      throw new Error("Unknown bubblewrap runner option.");
    return { type: "bubblewrap" };
  }
  if (r.type === "vm") {
    if (
      Object.keys(r).some(
        (k) => !["type", "host", "cli", "sshConfig"].includes(k),
      ) ||
      typeof r.host !== "string" ||
      !/^[a-zA-Z0-9_.@:-]+$/.test(r.host) ||
      r.host.startsWith("-") ||
      typeof r.cli !== "string" ||
      !/^\/[a-zA-Z0-9_./-]+$/.test(r.cli)
    )
      throw new Error(
        "VM runner requires an SSH host and an absolute cli path without shell metacharacters.",
      );
    if (
      r.sshConfig !== undefined &&
      (typeof r.sshConfig !== "string" ||
        !r.sshConfig.startsWith("/") ||
        r.sshConfig.includes("\0"))
    )
      throw new Error("Invalid SSH config path.");
    return {
      type: "vm",
      host: r.host,
      cli: r.cli,
      ...(r.sshConfig ? { sshConfig: r.sshConfig } : {}),
    };
  }
  if (
    r.type !== "cgroup" ||
    Object.keys(r).some(
      (k) => !["type", "memoryMiB", "tasksMax", "cpuPercent"].includes(k),
    )
  )
    throw new Error("Unsupported runner.");
  const result = {
    type: "cgroup",
    memoryMiB: r.memoryMiB ?? 256,
    tasksMax: r.tasksMax ?? 64,
    cpuPercent: r.cpuPercent ?? 100,
  };
  for (const [key, min, max] of [
    ["memoryMiB", 64, 16384],
    ["tasksMax", 8, 512],
    ["cpuPercent", 10, 400],
  ])
    if (
      !Number.isInteger(result[key]) ||
      result[key] < min ||
      result[key] > max
    )
      throw new Error(`Invalid runner ${key}.`);
  return result;
}
export function normalizePolicy(config) {
  const p = config.policy ?? {};
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some(
      (k) =>
        ![
          "deniedReads",
          "allowedProcesses",
          "allowNewReads",
          "allowNewProcesses",
          "allowOutputChanges",
          "enforceWrites",
          "network",
        ].includes(k),
    )
  )
    throw new Error("Unknown policy field.");
  if (p.network !== undefined && p.network !== "deny")
    throw new Error(
      "Only network: deny is supported; network access is never enabled.",
    );
  for (const key of [
    "allowNewReads",
    "allowNewProcesses",
    "allowOutputChanges",
    "enforceWrites",
  ])
    if (p[key] !== undefined && typeof p[key] !== "boolean")
      throw new Error(`${key} must be boolean.`);
  return {
    network: "deny",
    enforceWrites: p.enforceWrites ?? false,
    deniedReads: paths(
      p.deniedReads ?? [
        "/home/agent/.ssh",
        "/home/agent/.aws",
        "/home/agent/.config",
      ],
      "deniedReads",
    ),
    allowedProcesses:
      p.allowedProcesses === undefined
        ? null
        : paths(p.allowedProcesses, "allowedProcesses"),
    allowNewReads: p.allowNewReads ?? false,
    allowNewProcesses: p.allowNewProcesses ?? false,
    allowOutputChanges: p.allowOutputChanges ?? false,
  };
}
export async function loadScenario(path, runnerOverride) {
  path = resolve(path);
  const base = dirname(path),
    c = JSON.parse(await readFile(path, "utf8"));
  if (!c || typeof c !== "object" || Array.isArray(c))
    throw new Error("Scenario must be an object.");
  if (
    Object.keys(c).some(
      (k) =>
        ![
          "name",
          "workspace",
          "checks",
          "command",
          "verify",
          "adapter",
          "allowedWrites",
          "timeoutMs",
          "repetitions",
          "workspaceMiB",
          "policy",
          "runner",
        ].includes(k),
    )
  )
    throw new Error("Unknown scenario field.");
  if (
    c.adapter !== undefined &&
    (!c.adapter ||
      !["tool-plan", "agent"].includes(c.adapter.type) ||
      (c.adapter.type === "tool-plan"
        ? !relativePath(c.adapter.file)
        : !commandOK(c.command)) ||
      Object.keys(c.adapter).some(
        (k) =>
          !(
            c.adapter.type === "tool-plan" ? ["type", "file"] : ["type"]
          ).includes(k),
      ))
  )
    throw new Error(
      "Adapter must specify tool-plan with a relative file, or agent with a command.",
    );
  if ((!c.adapter && !commandOK(c.command)) || !commandOK(c.verify))
    throw new Error(
      "command and verify must be argument arrays with absolute executables.",
    );
  if (
    c.workspaceMiB !== undefined &&
    (!Number.isInteger(c.workspaceMiB) ||
      c.workspaceMiB < 8 ||
      c.workspaceMiB > 1024)
  )
    throw new Error("workspaceMiB must be 8–1024.");
  const allowedWrites = paths(c.allowedWrites, "allowedWrites", false);
  const timeoutMs = c.timeoutMs ?? 10000,
    repetitions = c.repetitions ?? 2;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 500 ||
    timeoutMs > 30000 ||
    !Number.isInteger(repetitions) ||
    repetitions < 2 ||
    repetitions > 5
  )
    throw new Error("Use timeoutMs 500–30000 and repetitions 2–5.");
  if (
    typeof c.workspace !== "string" ||
    !c.workspace ||
    c.workspace.includes("\0") ||
    typeof c.checks !== "string" ||
    !c.checks ||
    c.checks.includes("\0")
  )
    throw new Error("workspace and checks directories are required.");
  if (c.name !== undefined && typeof c.name !== "string")
    throw new Error("Scenario name must be a string.");
  return {
    ...c,
    allowedWrites,
    timeoutMs,
    workspaceMiB: c.workspaceMiB ?? 64,
    repetitions,
    policy: normalizePolicy(c),
    runner: normalizeRunner(runnerOverride ?? c.runner),
    workspace: resolve(base, c.workspace),
    checks: resolve(base, c.checks),
  };
}
export async function scenarioPaths(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a scenario or suite object.");
  if (!Object.hasOwn(value, "scenarios")) return [resolve(path)];
  if (Object.keys(value).some((k) => k !== "scenarios"))
    throw new Error("Unknown suite field.");
  if (
    !Array.isArray(value.scenarios) ||
    !value.scenarios.length ||
    value.scenarios.length > 20 ||
    value.scenarios.some((p) => typeof p !== "string")
  )
    throw new Error("Suite requires 1–20 scenario paths.");
  return value.scenarios.map((p) => resolve(dirname(resolve(path)), p));
}
