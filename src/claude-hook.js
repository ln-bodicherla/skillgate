import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyLock } from "./lock.js";
export async function claudeHook(configPath, event) {
  const deny = (reason) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Skillwall: " + reason,
    },
  });
  try {
    if (event?.hook_event_name !== "PreToolUse" || event.tool_name !== "Skill")
      return {};
    const info = await readFile(configPath, "utf8");
    if (info.length > 65536)
      throw new Error("Hook configuration is too large.");
    const config = JSON.parse(info),
      base = dirname(resolve(configPath));
    if (
      config.schemaVersion !== 1 ||
      typeof config.lock !== "string" ||
      !config.skills ||
      typeof config.skills !== "object"
    )
      throw new Error("Invalid hook configuration.");
    const name = event.tool_input?.skill?.replace(/^\//, "");
    if (typeof name !== "string" || !Object.hasOwn(config.skills, name))
      return deny(
        "Unregistered skill invocation. Register and pin this skill before use.",
      );
    const entry = config.skills[name];
    if (typeof entry.path !== "string" || typeof entry.pin !== "string")
      throw new Error("Invalid skill mapping.");
    const result = await verifyLock({
      skill: resolve(base, entry.path),
      name: entry.pin,
      lock: resolve(base, config.lock),
    });
    if (result.status !== "MATCH")
      return deny(
        `${name} changed after it was pinned. Review the update before invoking it.`,
      );
    // Do not return allow: retain Claude's normal permission flow.
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `Skillwall verified ${name} at ${result.expected}. This content pin does not certify safety.`,
      },
    };
  } catch (error) {
    return deny("Pin verification failed: " + error.message);
  }
}
export async function claudeSettings({ config, out }) {
  const cli = fileURLToPath(new URL("cli.js", import.meta.url));
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Skill",
          hooks: [
            {
              type: "command",
              command: process.execPath,
              args: [cli, "claude-hook", "--config", resolve(config)],
              timeout: 10,
              onFailure: "block",
            },
          ],
        },
      ],
    },
  };
  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(out, JSON.stringify(settings, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return {
    status: "CONFIGURED",
    settings: resolve(out),
    note: "Use Claude Code 2.1.295+ with --settings pointing at this file. This gates explicit Skill tool invocations, not arbitrary file reads.",
  };
}
