import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pin } from "../src/lock.js";
import { copyTree } from "../src/files.js";
import { quotaWorkspace } from "../src/workspace.js";
import { claudeHook, claudeSettings } from "../src/claude-hook.js";
import { renderReport } from "../src/report.js";
import { createHash } from "node:crypto";
test("kernel workspace quota rejects aggregate writes and releases its namespace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillwall-quota-"));
  let lease;
  try {
    lease = await quotaWorkspace(join(dir, "mount"), 8);
    const block = Buffer.alloc(1024 * 1024, 1);
    let written = 0;
    await assert.rejects(
      async () => {
        for (let i = 0; i < 16; i++) {
          await writeFile(join(lease.path, String(i)), block);
          written++;
        }
      },
      (e) => e.code === "ENOSPC",
    );
    assert(written <= 8);
    const path = lease.path;
    await lease.close();
    await assert.rejects(readFile(join(path, "0")));
  } finally {
    if (lease) await lease.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("Claude hook preserves permission flow for pins and denies drift, unknown skills and missing config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillwall-claude-"));
  try {
    const skill = join(dir, "skill");
    await copyTree(resolve("examples/v1"), skill);
    await pin({ skill, name: "invoices", lock: join(dir, "lock.json") });
    const config = join(dir, "hook.json");
    await writeFile(
      config,
      JSON.stringify({
        schemaVersion: 1,
        lock: "lock.json",
        skills: { invoices: { path: "skill", pin: "invoices" } },
      }),
    );
    const event = {
      hook_event_name: "PreToolUse",
      tool_name: "Skill",
      tool_input: { skill: "invoices" },
    };
    const matched = await claudeHook(config, event);
    assert(!matched.hookSpecificOutput.permissionDecision);
    assert(matched.hookSpecificOutput.additionalContext.includes("verified"));
    await writeFile(join(skill, "run.py"), "changed");
    assert.equal(
      (await claudeHook(config, event)).hookSpecificOutput.permissionDecision,
      "deny",
    );
    assert.equal(
      (
        await claudeHook(config, {
          ...event,
          tool_input: { skill: "unregistered" },
        })
      ).hookSpecificOutput.permissionDecision,
      "deny",
    );
    assert.equal(
      (await claudeHook(join(dir, "missing"), event)).hookSpecificOutput
        .permissionDecision,
      "deny",
    );
    const out = join(dir, "settings.json");
    await claudeSettings({ config, out });
    const settings = JSON.parse(await readFile(out, "utf8"));
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].onFailure, "block");
    await assert.rejects(claudeSettings({ config, out }), /EEXIST/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("report explorer escapes task data and authorizes only the bundled script hash", () => {
  const run = {
    skillDigest: "abc",
    execution: { code: 0 },
    verification: { code: 0 },
    trace: {
      events: [
        {
          type: "file-read",
          target: "<img src=x onerror=alert(1)>",
          success: false,
        },
      ],
      timeline: [],
    },
    changes: [],
    toolCalls: [],
  };
  const r = {
    scenario: "<script>alert(1)</script>",
    status: "HOLD",
    reasons: ["<unsafe>"],
    uncertainties: [],
    baseline: [run],
    candidate: [run],
    addedEvents: [],
    policyViolations: [],
  };
  const html = renderReport(r);
  assert(!html.includes("<script>alert(1)</script>"));
  assert(html.includes("&lt;img"));
  assert(html.includes("activity-search"));
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1],
    hash = createHash("sha256").update(script).digest("base64");
  assert(html.includes(`script-src 'sha256-${hash}'`));
  assert(!html.includes("script-src 'unsafe-inline'"));
});
