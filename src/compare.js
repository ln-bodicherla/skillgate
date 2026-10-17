import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { copyTree, within, hash } from "./files.js";
import { doctor, runVersion } from "./sandbox.js";
import { newEvents } from "./trace.js";
import { renderReport, renderSARIF } from "./report.js";
import { loadScenario, scenarioPaths, normalizePolicy } from "./config.js";
import { violations, significantNewEvent } from "./policy.js";
export function decide(
  oldRuns,
  newRuns,
  allowedWrites,
  policy = normalizePolicy({}),
) {
  const reasons = [],
    uncertain = [],
    policyViolations = [];
  for (const [label, runs] of [
    ["baseline", oldRuns],
    ["candidate", newRuns],
  ]) {
    for (const run of runs) {
      const failed =
        run.execution.code !== 0 ||
        run.execution.timedOut ||
        run.execution.outputLimit ||
        run.execution.traceLimit ||
        run.execution.protocolError ||
        run.artifactError ||
        !run.verification ||
        run.verification.code !== 0 ||
        run.verification.timedOut ||
        run.verification.outputLimit;
      if (failed)
        (label === "baseline" ? uncertain : reasons).push(
          `${label}: execution, artifact inspection, or verification failed`,
        );
      if (
        !run.trace.started ||
        run.trace.incomplete ||
        run.trace.events.some(
          (e) =>
            e.type === "unresolved-file" || e.target.includes("(unresolved"),
        )
      )
        uncertain.push(`${label}: trace coverage is incomplete`);
      if (
        run.changes.some(
          (c) => !allowedWrites.includes(c.path) || c.after?.unsafe,
        )
      )
        (label === "baseline" ? uncertain : reasons).push(
          `${label}: unexpected workspace change`,
        );
      const v = violations(run, policy);
      policyViolations.push(...v.map((e) => ({ version: label, ...e })));
      if (v.length)
        (label === "baseline" ? uncertain : reasons).push(
          `${label}: permission policy violation`,
        );
    }
    const signatures = runs.map((r) =>
      JSON.stringify({
        events: r.trace.events,
        changes: r.changes,
        stdout: r.execution.stdout,
        tools: r.toolCalls ?? [],
      }),
    );
    if (new Set(signatures).size > 1)
      uncertain.push(`${label}: repeated runs differ`);
  }
  const added = newEvents(
    oldRuns.flatMap((r) => r.trace.events),
    newRuns.flatMap((r) => r.trace.events),
  );
  if (added.some((e) => significantNewEvent(e, policy, allowedWrites)))
    reasons.push(
      "Candidate introduces observed file, network, or process activity",
    );
  if (
    !policy.allowOutputChanges &&
    (JSON.stringify(oldRuns[0].changes) !==
      JSON.stringify(newRuns[0].changes) ||
      oldRuns[0].execution.stdout !== newRuns[0].execution.stdout)
  )
    reasons.push("Candidate produces different output");
  const toolSignature = (r) =>
    JSON.stringify(
      (r.toolCalls ?? []).map((c) => ({
        name: c.name,
        command: c.command,
        code: c.code,
      })),
    );
  if (toolSignature(oldRuns[0]) !== toolSignature(newRuns[0]))
    reasons.push("Candidate changes recorded tool calls");
  return {
    status: reasons.length
      ? "HOLD"
      : uncertain.length
        ? "INCONCLUSIVE"
        : "PASS",
    reasons: [...new Set(reasons)],
    uncertainties: [...new Set(uncertain)],
    addedEvents: added,
    policyViolations: [
      ...new Map(policyViolations.map((e) => [JSON.stringify(e), e])).values(),
    ],
  };
}
async function runCase({ config, old, candidate, out }) {
  const sources = [old, candidate, config.workspace, config.checks],
    frozen = [],
    inputDigests = [];
  await mkdir(out, { recursive: true, mode: 0o700 });
  for (let i = 0; i < sources.length; i++) {
    const path = join(out, `input-${i}`),
      copied = await copyTree(sources[i], path);
    frozen.push(path);
    inputDigests.push(copied.digest);
  }
  const runs = [[], []];
  for (let version = 0; version < 2; version++)
    for (let i = 0; i < config.repetitions; i++)
      runs[version].push(
        await runVersion({
          skill: frozen[version],
          fixture: frozen[2],
          checks: frozen[3],
          command: config.command,
          verify: config.verify,
          adapter: config.adapter,
          runner: config.runner,
          policy: config.policy,
          allowedWrites: config.allowedWrites,
          directory: join(
            out,
            `${version ? "candidate" : "baseline"}-${i + 1}`,
          ),
          timeoutMs: config.timeoutMs,
          workspaceMiB: config.workspaceMiB,
        }),
      );
  return {
    scenario: config.name || "Unnamed scenario",
    ...decide(...runs, config.allowedWrites, config.policy),
    baseline: runs[0],
    candidate: runs[1],
    policy: config.policy,
    runner: config.runner,
    inputDigests,
    scenarioDigest: hash(JSON.stringify(config)),
  };
}
export async function compare({ old, candidate, scenario, out, runner }) {
  old = resolve(old);
  candidate = resolve(candidate);
  out = resolve(out);
  const paths = await scenarioPaths(resolve(scenario)),
    configs = [];
  for (const path of paths) configs.push(await loadScenario(path, runner));
  const sources = [
    old,
    candidate,
    ...configs.flatMap((c) => [c.workspace, c.checks]),
  ];
  if (sources.some((p) => within(out, p) || within(p, out)))
    throw new Error(
      "Report directory must be separate from all input directories.",
    );
  for (const p of [old, candidate]) await readFile(join(p, "SKILL.md"), "utf8");
  for (const selected of new Map(
    configs.map((c) => [JSON.stringify(c.runner), c.runner]),
  ).values()) {
    const health = await doctor(selected);
    if (!health.ok) throw new Error(`Sandbox unavailable: ${health.reason}`);
  }
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out, { mode: 0o700 });
  const cases = [];
  for (let i = 0; i < configs.length; i++)
    cases.push(
      await runCase({
        config: configs[i],
        old,
        candidate,
        out: configs.length === 1 ? out : join(out, `scenario-${i + 1}`),
      }),
    );
  const decision =
    cases.length === 1
      ? cases[0]
      : {
          scenario: `Scenario suite (${cases.length})`,
          status: cases.some((c) => c.status === "HOLD")
            ? "HOLD"
            : cases.some((c) => c.status === "INCONCLUSIVE")
              ? "INCONCLUSIVE"
              : "PASS",
          reasons: cases.flatMap((c) =>
            c.reasons.map((r) => `${c.scenario}: ${r}`),
          ),
          uncertainties: cases.flatMap((c) =>
            c.uncertainties.map((r) => `${c.scenario}: ${r}`),
          ),
          baseline: cases.flatMap((c) => c.baseline),
          candidate: cases.flatMap((c) => c.candidate),
          addedEvents: newEvents(
            [],
            cases.flatMap((c) => c.addedEvents),
          ),
          policyViolations: cases.flatMap((c) => c.policyViolations),
        };
  const report = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    ...decision,
    scenarios: cases,
    scope:
      "Observations apply only to these scenarios. PASS is not a safety certification. Tool-plan adapters execute actual sandboxed commands; no LLM determinism is implied.",
  };
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(out, "report.html"), renderReport(report));
  await writeFile(
    join(out, "report.sarif"),
    JSON.stringify(renderSARIF(report), null, 2),
  );
  return report;
}
