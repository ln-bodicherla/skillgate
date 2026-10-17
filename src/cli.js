#!/usr/bin/env node
import { doctor } from "./sandbox.js";
import { pin, verifyLock, accept } from "./lock.js";
import { compare } from "./compare.js";
import { runPinned, installPinned } from "./lifecycle.js";
const help = `skillwall doctor [--runner bubblewrap|cgroup|vm] [--vm-host HOST --vm-cli PATH]
skillwall compare --old DIR --new DIR --scenario FILE --out NEW_DIRECTORY [runner options]
skillwall pin --skill DIR --name NAME --lock FILE
skillwall verify --skill DIR --name NAME --lock FILE
skillwall accept --old DIR --new DIR --scenario FILE --out NEW_DIRECTORY --name NAME --lock FILE [runner options]
skillwall run --skill DIR --name NAME --lock FILE --scenario FILE --out NEW_DIRECTORY [runner options]
skillwall claude-settings --config FILE --out NEW_SETTINGS_FILE
skillwall claude-hook --config FILE (hook JSON on stdin)
skillwall install --skill DIR --name NAME --lock FILE --store DIRECTORY
Runner options: --runner bubblewrap|cgroup|vm; cgroup: --memory-mib N --tasks-max N --cpu-percent N; vm: --vm-host HOST --vm-cli PATH [--vm-ssh-config FILE]`;
const [action, ...args] = process.argv.slice(2);
function parse(required, optional = []) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (
      !args[i].startsWith("--") ||
      ![...required, ...optional].includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      Object.hasOwn(result, key)
    )
      throw new Error("Unknown, duplicate or missing argument.");
    result[key] = args[i + 1];
  }
  if (required.some((key) => !result[key]))
    throw new Error(`Required: ${required.map((k) => "--" + k).join(" ")}`);
  return result;
}
const runnerOptions = [
  "runner",
  "vm-host",
  "vm-cli",
  "vm-ssh-config",
  "memory-mib",
  "tasks-max",
  "cpu-percent",
];
function selectedRunner(o) {
  if (!o.runner) {
    if (runnerOptions.slice(1).some((k) => o[k]))
      throw new Error("Runner options require --runner.");
    return undefined;
  }
  if (o.runner === "vm") {
    if (["memory-mib", "tasks-max", "cpu-percent"].some((k) => o[k]))
      throw new Error("cgroup options cannot be used with vm.");
    return {
      type: "vm",
      host: o["vm-host"],
      cli: o["vm-cli"],
      ...(o["vm-ssh-config"] ? { sshConfig: o["vm-ssh-config"] } : {}),
    };
  }
  if (o["vm-host"] || o["vm-cli"] || o["vm-ssh-config"])
    throw new Error("VM options require --runner vm.");
  if (o.runner === "cgroup")
    return {
      type: "cgroup",
      ...(o["memory-mib"] ? { memoryMiB: Number(o["memory-mib"]) } : {}),
      ...(o["tasks-max"] ? { tasksMax: Number(o["tasks-max"]) } : {}),
      ...(o["cpu-percent"] ? { cpuPercent: Number(o["cpu-percent"]) } : {}),
    };
  if (["memory-mib", "tasks-max", "cpu-percent"].some((k) => o[k]))
    throw new Error("Resource options require --runner cgroup.");
  return { type: o.runner };
}
try {
  let result;
  if (action === "claude-hook") {
    const o = parse(["config"]);
    const { readPacket } = await import("./vm.js");
    const { claudeHook } = await import("./claude-hook.js");
    result = await claudeHook(o.config, await readPacket(process.stdin));
  } else if (action === "claude-settings") {
    const o = parse(["config", "out"]);
    const { claudeSettings } = await import("./claude-hook.js");
    result = await claudeSettings(o);
  } else if (action === "_worker") {
    if (args.length) throw new Error("Worker takes JSON on stdin only.");
    const { readPacket, worker } = await import("./vm.js");
    result = await worker(await readPacket(process.stdin));
  } else if (action === "doctor") {
    const o = parse([], runnerOptions);
    result = await doctor(selectedRunner(o));
    process.exitCode = result.ok ? 0 : 1;
  } else if (action === "compare" || action === "accept") {
    const o = parse(
        [
          "old",
          "new",
          "scenario",
          "out",
          ...(action === "accept" ? ["name", "lock"] : []),
        ],
        runnerOptions,
      ),
      options = { ...o, candidate: o.new, runner: selectedRunner(o) };
    result = await (action === "compare" ? compare(options) : accept(options));
    if (action === "compare")
      result = {
        status: result.status,
        reasons: result.reasons,
        uncertainties: result.uncertainties,
        report: o.out + "/report.html",
      };
  } else if (["pin", "verify", "run", "install"].includes(action)) {
    const o = parse(
      [
        "skill",
        "name",
        "lock",
        ...(action === "run"
          ? ["scenario", "out"]
          : action === "install"
            ? ["store"]
            : []),
      ],
      action === "run" ? runnerOptions : [],
    );
    result = await (action === "pin"
      ? pin(o)
      : action === "verify"
        ? verifyLock(o)
        : action === "install"
          ? installPinned(o)
          : runPinned({ ...o, runner: selectedRunner(o) }));
    if (action === "run")
      result = {
        status: result.status,
        sha256: result.sha256,
        reasons: result.reasons,
        uncertainties: result.uncertainties,
        evidence: o.out + "/execution.json",
      };
  } else {
    console.log(help);
    process.exitCode = action && action !== "--help" ? 1 : 0;
  }
  if (result) {
    console.log(JSON.stringify(result, null, 2));
    if (result.status)
      process.exitCode =
        {
          CONFIGURED: 0,
          PASS: 0,
          PINNED: 0,
          MATCH: 0,
          ACCEPTED: 0,
          EXECUTED: 0,
          INSTALLED: 0,
          DRIFT: 2,
          HOLD: 2,
          INCONCLUSIVE: 3,
        }[result.status] ?? 1;
  }
} catch (error) {
  if (action === "claude-hook") {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Skillwall hook input or startup failure.",
        },
      }),
    );
    process.exitCode = 2;
  } else if (action === "_worker")
    console.log(JSON.stringify({ schemaVersion: 1, error: error.message }));
  else console.error(error.message);
  process.exitCode = 1;
}
