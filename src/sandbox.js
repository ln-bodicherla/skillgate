import { existsSync, statSync } from "node:fs";
import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { copyTree, snapshot, changes } from "./files.js";
import { parseTrace, newEvents } from "./trace.js";
import { quotaWorkspace } from "./workspace.js";
import { tool, execute } from "./process.js";
import { commandOK, relativePath, normalizeRunner } from "./config.js";
export { tool } from "./process.js";
function layout() {
  const args = [
    "--unshare-all",
    "--unshare-user",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--disable-userns",
    "--assert-userns-disabled",
    "--size",
    "33554432",
    "--tmpfs",
    "/",
    "--ro-bind",
    "/usr",
    "/usr",
  ];
  for (const p of ["/bin", "/lib", "/lib64", "/sbin"])
    if (existsSync(p)) args.push("--ro-bind", p, p);
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    "33554432",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/home/agent",
    "--clearenv",
    "--setenv",
    "HOME",
    "/home/agent",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "PYTHONDONTWRITEBYTECODE",
    "1",
  );
  return args;
}
export async function doctor(runner = { type: "bubblewrap" }) {
  runner = normalizeRunner(runner);
  if (runner.type === "vm") {
    const { vmDoctor } = await import("./vm.js");
    return vmDoctor(runner);
  }
  if (process.getuid?.() === 0)
    return {
      ok: false,
      reason: "Run as an unprivileged user, not root.",
      tools: {},
    };
  if (process.platform !== "linux")
    return { ok: false, reason: "Linux is required.", tools: {} };
  const tools = Object.fromEntries(
    [
      "bwrap",
      "strace",
      "prlimit",
      "unshare",
      "nsenter",
      "python3",
      ...(runner.type === "cgroup" ? ["systemd-run"] : []),
    ].map((n) => [n, tool(n)]),
  );
  if (Object.values(tools).some((v) => !v))
    return {
      ok: false,
      reason:
        "Install bubblewrap, strace, util-linux and the selected runner tools. No unsandboxed fallback exists.",
      tools,
    };
  const probe = await execute(
    tools.strace,
    [
      "-qq",
      "-f",
      "-yy",
      "-o",
      "/dev/null",
      tools.bwrap,
      ...layout(),
      "--",
      "/usr/bin/true",
    ],
    { timeoutMs: 5000, runner },
  );
  if (probe.code === 0) {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "skillwall-doctor-"));
    let lease;
    try {
      lease = await quotaWorkspace(join(dir, "mount"), 8);
    } catch (error) {
      return { ok: false, reason: error.message, tools, runner };
    } finally {
      if (lease) await lease.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  return {
    ok: probe.code === 0,
    reason: probe.code === 0 ? null : probe.stderr || probe.spawnError,
    tools,
    runner,
  };
}
export async function runVersion(options) {
  const {
    skill,
    fixture,
    checks,
    command,
    verify,
    directory,
    timeoutMs,
    adapter,
  } = options;
  const runner = normalizeRunner(options.runner);
  if (runner.type === "vm") {
    const { runInVM } = await import("./vm.js");
    return runInVM({ ...options, runner });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lease = await quotaWorkspace(
    join(directory, "workspace-mount"),
    options.workspaceMiB ?? 64,
  );
  try {
    return await runLocalVersion(options, runner, lease);
  } finally {
    await lease.close();
  }
}
async function runLocalVersion(options, runner, lease) {
  const {
    skill,
    fixture,
    checks,
    command,
    verify,
    directory,
    timeoutMs,
    adapter,
  } = options;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const skillCopy = join(directory, "skill"),
    workspace = lease.path,
    checkCopy = join(directory, "checks");
  const copied = await copyTree(skill, skillCopy);
  if (options.expectedDigest && copied.digest !== options.expectedDigest)
    throw new Error("Skill does not match the pin; execution refused.");
  await copyTree(fixture, workspace);
  await copyTree(checks, checkCopy);
  const writableFiles = [];
  if (options.policy?.enforceWrites) {
    for (const path of options.allowedWrites ?? []) {
      if (!relativePath(path) || path === ".")
        throw new Error("Invalid writable file path.");
      const full = join(workspace, path);
      await mkdir(dirname(full), { recursive: true });
      const handle = await open(full, "a");
      await handle.close();
      writableFiles.push({ source: full, target: "/workspace/" + path });
    }
  }
  const workspaceBinding = lease.directory;
  const enter = [
    tool("nsenter"),
    "--preserve-credentials",
    "--user=/proc/" + lease.pid + "/ns/user",
    "--mount=/proc/" + lease.pid + "/ns/mnt",
    "--",
  ];
  const before = await snapshot(workspace),
    limits = [
      "--cpu=10:10",
      "--fsize=8388608:8388608",
      "--nofile=128:128",
      "--core=0:0",
      "--",
    ];
  const args = layout();
  args.push(
    "--ro-bind",
    skillCopy,
    "/skill",
    options.policy?.enforceWrites ? "--ro-bind" : "--bind",
    workspaceBinding,
    "/workspace",
    "--ro-bind",
    checkCopy,
    "/checks",
    "--chdir",
    "/workspace",
  );
  for (const file of writableFiles)
    args.push(
      "--bind",
      file.source.replace(lease.path, lease.directory),
      file.target,
    );
  const runs = [],
    traces = [],
    toolCalls = [],
    start = Date.now();
  let step = 0;
  async function invoke(call, readOnly = false, interactive = null) {
    if (!commandOK(call.command)) throw new Error("Invalid tool command.");
    const tracePath = join(directory, `trace-${++step}.log`),
      remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0)
      return {
        code: null,
        timedOut: true,
        stdout: "",
        stderr: "Execution wall-time limit reached.",
      };
    const mounts = readOnly
      ? args.map((a, i) =>
          a === "--bind" &&
          (args[i + 2] === "/workspace" ||
            args[i + 2]?.startsWith("/workspace/"))
            ? "--ro-bind"
            : a,
        )
      : args;
    const result = await execute(
      tool("strace"),
      [
        "-qq",
        "-f",
        "-yy",
        "-s",
        "4096",
        "-e",
        "trace=%file,%network,%process,io_uring_setup",
        "-o",
        tracePath,
        ...enter,
        tool("prlimit"),
        ...limits,
        tool("bwrap"),
        ...mounts,
        "--",
        ...call.command,
      ],
      {
        timeoutMs: remaining,
        tracePath,
        runner,
        ...(interactive
          ? {
              onLine: interactive,
              input:
                JSON.stringify({
                  type: "start",
                  skill: "/skill/SKILL.md",
                  workspace: "/workspace",
                  maxToolCalls: 16,
                }) + "\n",
            }
          : {}),
      },
    );
    try {
      if (result.traceLimit || statSync(tracePath).size > 8 * 1024 * 1024)
        throw new Error("Trace exceeds inspection limit.");
      traces.push(
        parseTrace(await readFile(tracePath, "utf8"), call.command[0]),
      );
    } catch (error) {
      traces.push({
        started: false,
        incomplete: 1,
        events: [],
        timeline: [],
        error: error.message,
      });
    }
    return result;
  }
  const record = async (call) => {
    const result = await invoke(call);
    runs.push(result);
    toolCalls.push({
      name: call.name,
      command: call.command,
      code: result.code,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return result;
  };
  if (adapter?.type === "agent") {
    let finished = false,
      count = 0;
    const agentResult = await invoke({ command }, true, async (line) => {
      if (finished) throw new Error("Agent sent a message after finish.");
      const message = JSON.parse(line);
      if (message.type === "finish") {
        finished = true;
        return { type: "finished" };
      }
      if (
        message.type !== "tool" ||
        ++count > 16 ||
        typeof message.name !== "string" ||
        !/^[-a-zA-Z0-9_.]{1,100}$/.test(message.name) ||
        !commandOK(message.command)
      )
        throw new Error("Invalid or excessive agent tool request.");
      const result = await record(message);
      return {
        type: "tool-result",
        name: message.name,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    });
    if (!finished)
      agentResult.protocolError ??= "Agent exited without finishing.";
    runs.push(agentResult);
  } else if (adapter) {
    if (adapter.type !== "tool-plan" || !relativePath(adapter.file))
      throw new Error("Unsupported adapter.");
    const plan = JSON.parse(
      await readFile(join(skillCopy, adapter.file), "utf8"),
    );
    if (
      !Array.isArray(plan.calls) ||
      plan.calls.length < 1 ||
      plan.calls.length > 16 ||
      plan.calls.some(
        (c) =>
          !c ||
          !commandOK(c.command) ||
          typeof c.name !== "string" ||
          !/^[-a-zA-Z0-9_.]{1,100}$/.test(c.name),
      )
    )
      throw new Error("Tool plan requires 1–16 named command calls.");
    for (const call of plan.calls) {
      const result = await record(call);
      if (result.code !== 0 || result.timedOut || result.outputLimit) break;
    }
  } else runs.push(await invoke({ command }));
  const failed = runs.find(
    (r) => r.code !== 0 || r.timedOut || r.outputLimit || r.protocolError,
  );
  const execution = {
    ...(failed ?? runs.at(-1)),
    stdout: runs.map((r) => r.stdout).join(""),
    stderr: runs.map((r) => r.stderr).join(""),
    timedOut: runs.some((r) => r.timedOut),
    outputLimit: runs.some((r) => r.outputLimit),
    traceLimit: runs.some((r) => r.traceLimit),
    protocolError: runs.find((r) => r.protocolError)?.protocolError ?? null,
  };
  const trace = {
    started: traces.length === step && traces.every((t) => t.started),
    incomplete: traces.reduce((n, t) => n + t.incomplete, 0),
    events: newEvents(
      [],
      traces.flatMap((t) => t.events),
    ),
    timeline: traces.flatMap((t) => t.timeline || []).slice(0, 10000),
  };
  let after = {},
    artifactError = null;
  try {
    after = await snapshot(workspace);
  } catch (error) {
    artifactError = error.message;
  }
  let verification = null;
  if (
    verify &&
    execution.code === 0 &&
    !execution.protocolError &&
    !artifactError
  ) {
    const v = layout();
    v.push(
      "--ro-bind",
      workspaceBinding,
      "/workspace",
      "--ro-bind",
      checkCopy,
      "/checks",
      "--chdir",
      "/workspace",
      "--",
      ...verify,
    );
    verification = await execute(
      enter[0],
      [...enter.slice(1), tool("prlimit"), ...limits, tool("bwrap"), ...v],
      { timeoutMs, runner },
    );
  }
  let artifactExported = false;
  if (!artifactError && !Object.values(after).some((info) => info.unsafe)) {
    await copyTree(workspace, join(directory, "workspace"));
    artifactExported = true;
  }
  const report = {
    workspaceQuotaBytes: lease.bytes,
    artifactExported,
    skillDigest: copied.digest,
    execution,
    verification,
    trace,
    toolCalls,
    changes: artifactError ? [] : changes(before, after),
    artifactError,
    runner,
    preparedWritableFiles: writableFiles.map((f) => f.target),
  };
  await writeFile(join(directory, "run.json"), JSON.stringify(report, null, 2));
  return report;
}
