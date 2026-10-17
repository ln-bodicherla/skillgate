import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
for (const directory of ["src", "scripts", "test"]) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith(".js")) continue;
    const result = spawnSync(
      process.execPath,
      ["--check", join(directory, file)],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log("All JavaScript syntax checks passed.");
