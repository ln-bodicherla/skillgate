import { spawn } from "node:child_process";
import { mkdir, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export async function quotaWorkspace(directory, workspaceMiB = 64) {
  if (
    !Number.isInteger(workspaceMiB) ||
    workspaceMiB < 8 ||
    workspaceMiB > 1024
  )
    throw new Error("workspaceMiB must be 8–1024.");
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const helper = fileURLToPath(new URL("workspace.py", import.meta.url));
  const child = spawn(
    "/usr/bin/unshare",
    [
      "--user",
      "--map-root-user",
      "--mount",
      "--",
      "/usr/bin/python3",
      helper,
      directory,
      String(workspaceMiB * 1024 * 1024),
    ],
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-4096);
  });
  child.stdin.on("error", () => {});
  try {
    const handshake = await new Promise((yes, no) => {
      let text = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        no(new Error("Workspace namespace startup timed out."));
      }, 5000);
      child.once("error", (error) => {
        clearTimeout(timer);
        no(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        no(new Error(`Workspace quota unavailable: ${stderr}`));
      });
      child.stdout.on("data", (data) => {
        text += data;
        if (text.length > 4096) {
          clearTimeout(timer);
          no(new Error("Invalid workspace handshake."));
          return;
        }
        if (text.includes("\n")) {
          clearTimeout(timer);
          try {
            yes(JSON.parse(text.split("\n")[0]));
          } catch (error) {
            no(error);
          }
        }
      });
    });
    if (
      handshake.pid !== child.pid ||
      handshake.bytes > workspaceMiB * 1024 * 1024
    )
      throw new Error("Unexpected workspace namespace.");
    const path = `/proc/${child.pid}/root${directory}`,
      info = await statfs(path);
    if (info.bsize * info.blocks !== handshake.bytes)
      throw new Error("Workspace quota verification failed.");
    const handles = [];
    let closed = false;
    return {
      path,
      directory,
      pid: child.pid,
      bytes: handshake.bytes,
      handles,
      async close() {
        if (closed) return;
        closed = true;
        for (const handle of handles) await handle.close();
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null)
          await new Promise((resolveClose) => {
            const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolveClose();
            });
          });
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}
