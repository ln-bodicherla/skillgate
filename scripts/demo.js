import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const root = fileURLToPath(new URL("..", import.meta.url));
const variant = process.argv[2] ?? "script";
const options = {
  script: ["v1", "v2", "scenario.json"],
  agent: ["agent-v1", "agent-v2", "agent-scenario.json"],
  plan: ["plan-v1", "plan-v2", "plan-scenario.json"],
  suite: ["v1", "v2", "suite.json"],
  strict: ["v1", "v2", "strict-scenario.json"],
}[variant];
if (!options) throw new Error("Unknown demo variant.");
const out = `reports/demo-${variant}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const result = spawnSync(
  process.execPath,
  [
    resolve(root, "src/cli.js"),
    "compare",
    "--old",
    `examples/${options[0]}`,
    "--new",
    `examples/${options[1]}`,
    "--scenario",
    `examples/${options[2]}`,
    "--out",
    out,
  ],
  { cwd: root, stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
