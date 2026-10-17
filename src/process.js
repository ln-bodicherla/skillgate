import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
export function tool(name) {
  if (name === "strace" && process.env.SKILLWALL_STRACE)
    return resolve(process.env.SKILLWALL_STRACE);
  const local = join(project, ".tools/bin", name);
  if (existsSync(local)) return local;
  const found = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : null;
}
export async function execute(
  command,
  args,
  {
    timeoutMs = 10000,
    maxOutput = 1024 * 1024,
    tracePath = null,
    input = null,
    runner = { type: "bubblewrap" },
    onLine = null,
    fds = [],
  } = {},
) {
  if (!command) throw new Error("Required executable is unavailable.");
  let scope;
  if (runner.type === "cgroup") {
    const systemd = tool("systemd-run");
    if (!systemd)
      throw new Error("cgroup runner requires systemd-run and a user manager.");
    scope = `skillwall-${randomUUID()}.scope`;
    args = [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${scope}`,
      `--property=MemoryMax=${runner.memoryMiB}M`,
      "--property=MemorySwapMax=0",
      `--property=TasksMax=${runner.tasksMax}`,
      `--property=CPUQuota=${runner.cpuPercent}%`,
      `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1000) + 1}`,
      "--",
      command,
      ...args,
    ];
    command = systemd;
  }
  return new Promise((resolveResult, rejectResult) => {
    const stdout = [],
      stderr = [];
    let bytes = 0,
      timedOut = false,
      outputLimit = false,
      traceLimit = false,
      spawnError = null,
      closed = false,
      protocolError = null,
      lineBuffer = "",
      lineQueue = Promise.resolve(),
      interruptedSignal = null,
      killed = false;
    const decoder = new StringDecoder("utf8");
    const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
    for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(command, args, {
      detached: true,
      env,
      stdio: ["pipe", "pipe", "pipe", ...fds],
    });
    const kill = () => {
      if (killed) return;
      killed = true;
      if (scope) {
        const stop = spawn(
          "/usr/bin/systemctl",
          ["--user", "kill", "--kill-whom=all", "--signal=KILL", scope],
          { env, stdio: "ignore" },
        );
        stop.on("error", () => {});
      }
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const monitor = tracePath
      ? setInterval(() => {
          try {
            if (statSync(tracePath).size > 8 * 1024 * 1024) {
              traceLimit = true;
              kill();
            }
          } catch {}
        }, 20)
      : null;
    const collect = (list) => (data) => {
      bytes += data.length;
      if (bytes > maxOutput) {
        outputLimit = true;
        kill();
        return;
      }
      list.push(data);
    };
    child.stdout.on("data", (data) => {
      collect(stdout)(data);
      if (onLine && !killed) {
        lineBuffer += decoder.write(data);
        let end;
        while ((end = lineBuffer.indexOf("\n")) !== -1) {
          const line = lineBuffer.slice(0, end);
          lineBuffer = lineBuffer.slice(end + 1);
          lineQueue = lineQueue
            .then(async () => {
              if (protocolError || killed) return;
              const reply = await onLine(line);
              if (reply !== undefined && !child.stdin.destroyed)
                child.stdin.write(JSON.stringify(reply) + "\n");
            })
            .catch((error) => {
              protocolError = error.message;
              kill();
            });
        }
      }
    });
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", () => {});
    if (onLine) {
      if (input !== null) child.stdin.write(input);
    } else child.stdin.end(input ?? undefined);
    child.on("error", (error) => {
      spawnError = error.message;
    });
    // kill on interruption as well as timeout; do not leave tracees running.
    const interrupt = (signal) => {
      interruptedSignal = signal;
      kill();
    };
    const onInt = () => interrupt("SIGINT"),
      onTerm = () => interrupt("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    child.on("close", async (code, signal) => {
      if (closed) return;
      closed = true;
      await lineQueue;
      if (onLine && lineBuffer.trim())
        protocolError ??= "Unterminated agent protocol message.";
      clearTimeout(timer);
      if (monitor) clearInterval(monitor);
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      if (interruptedSignal) {
        rejectResult(
          new Error(`Execution interrupted by ${interruptedSignal}.`),
        );
        return;
      }
      resolveResult({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputLimit,
        traceLimit,
        spawnError,
        protocolError,
        runner: runner.type,
      });
    });
  });
}
