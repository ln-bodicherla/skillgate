import { createHash } from "node:crypto";
import { reportCSS, reportScript } from "./report-ui.js";
export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const e = escapeHTML;
const pretty = (v) => `<pre>${e(JSON.stringify(v, null, 2))}</pre>`;
const badge = (s) =>
  `<span class="badge ${["PASS", "HOLD", "INCONCLUSIVE"].includes(s) ? s : ""}">● ${e(s)}</span>`;
const bytes = (n) =>
  n == null
    ? "Not recorded"
    : n < 1024
      ? n + " B"
      : n < 1048576
        ? (n / 1024).toFixed(1) + " KB"
        : (n / 1048576).toFixed(1) + " MB";
function table(headers, rows, empty = "No observations in this category.") {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${e(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<div class="panel empty">${e(empty)}</div>`;
}
export function renderReport(r) {
  const cases = r.scenarios ?? [r],
    runs = cases.flatMap((c) => [...c.baseline, ...c.candidate]),
    verified = runs.filter(
      (x) => x.verification?.code === 0 && !x.verification?.timedOut,
    ).length,
    newEvents = cases.flatMap((c) => c.addedEvents ?? []),
    violations = cases.flatMap((c) => c.policyViolations ?? []),
    blocked = newEvents.filter((x) => !x.success).length;
  const scriptHash = createHash("sha256").update(reportScript).digest("base64");
  const verdict =
    r.status === "PASS"
      ? "No review findings observed"
      : r.status === "HOLD"
        ? "Review before accepting this update"
        : "More evidence is needed";
  const explanation =
    r.status === "HOLD" && verified === runs.length
      ? "Task checks passed, but the update changed behavior. Review the findings before accepting it."
      : r.status === "PASS"
        ? "The tested versions behaved consistently within these scenarios. Untested behavior remains outside this result."
        : "Inspect the findings and coverage notes below. A passing task result alone does not approve an update.";
  const activity = cases.flatMap((c, i) => {
    const fresh = new Set((c.addedEvents ?? []).map((x) => JSON.stringify(x)));
    return (c.candidate[0].trace.events ?? []).map(
      (event) =>
        `<tr data-activity data-new="${fresh.has(JSON.stringify(event))}" data-blocked="${!event.success}" data-kind="${e(event.type)}" class="${fresh.has(JSON.stringify(event)) ? "new-event" : ""}"><td>${e(c.scenario)}<br>${fresh.has(JSON.stringify(event)) ? '<span class="pill blocked">New in update</span>' : ""}</td><td><span class="pill">${e(event.type)}</span></td><td><code>${e(event.target)}</code></td><td><span class="pill ${event.success ? "ok" : "blocked"}">${event.success ? "Succeeded" : "Denied / failed"}</span><br><span class="muted">${e(event.errno)}</span></td></tr>`,
    );
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'"><title>${e(r.status)} · Skill Update Firewall</title><style>${reportCSS}</style></head><body><aside><div class="brand"><i>◇</i>Skillwall</div><small>Update review</small><nav><a href="#overview">Overview</a><a href="#findings">Review findings</a><a href="#activity">Activity explorer</a><a href="#scenarios">Scenario evidence</a></nav><div class="sidebar-note">LOCAL EVIDENCE REPORT<br>No external assets or analytics.<br><br>PASS applies only to the tested scenarios.</div></aside><main><header><div class="eyebrow">Skill Update Firewall / Review report</div><div class="links"><a class="button" href="report.json">JSON evidence ↗</a><a class="button" href="report.sarif">SARIF ↗</a></div></header><section class="hero" id="overview"><div>${badge(r.status)}<h1>${e(r.scenario)}</h1><p>${e(explanation)}</p><p style="font-size:11px">${e(r.createdAt ?? "")} · ${cases.length} scenario${cases.length === 1 ? "" : "s"} · ${runs.length} isolated repetitions</p></div><div class="decision ${e(r.status)}"><small>UPDATE DECISION</small><strong>${e(r.status)}</strong><small>${e(verdict)}</small></div></section><div class="stats"><div class="stat"><span>New observations</span><strong class="accent">${newEvents.length}</strong><span>${blocked} denied or failed attempts</span></div><div class="stat"><span>Policy findings</span><strong>${violations.length}</strong><span>Unique per scenario and version</span></div><div class="stat"><span>Task verification</span><strong>${verified}<span> / ${runs.length}</span></strong><span>Passing checks across all repetitions</span></div><div class="stat"><span>Coverage notes</span><strong>${r.uncertainties.length}</strong><span>${r.uncertainties.length ? "Review uncertainty before approval" : "No known parsing or repeatability gaps"}</span></div></div><section id="findings"><div class="section-heading"><h2>What needs your attention</h2><span class="muted">Decision evidence</span></div><div class="grid"><div class="panel"><h3>Review findings</h3>${r.reasons.length ? r.reasons.map((reason, i) => `<div class="finding"><span class="number">${i + 1}</span><div>${e(reason)}</div></div>`).join("") : "<p>No differences requiring review were observed.</p>"}${r.uncertainties.map((note) => `<div class="finding"><span class="number">?</span><div>${e(note)}<p>This limits the decision; it is not evidence of safe behavior.</p></div></div>`).join("")}</div><div class="panel"><h3>Isolation and scope</h3><div class="row"><span>Network access</span><b>Isolated namespace</b></div><div class="row"><span>Skills / verification checks</span><b>Read-only</b></div><div class="row"><span>Host home / credentials</span><b>Not mounted</b></div><div class="row"><span>Execution backends</span><b>${e([...new Set(cases.map((c) => c.runner?.type ?? "bubblewrap"))].join(", "))}</b></div><div class="row"><span>Workspace write enforcement</span><b>${cases.every((c) => c.policy?.enforceWrites) ? "Exact writable file mounts" : "Observe disposable workspace"}</b></div><div class="note">Task correctness and permission review are separate checks. Denied attempts still matter; a blocked request can reveal an unwanted change.</div></div></div></section><section id="activity"><div class="section-heading"><h2>Activity explorer</h2><span id="match-count" class="muted" aria-live="polite"></span></div><p>Normalized candidate observations from the first repetition of each scenario. Repeated events are deduplicated; raw traces retain more detail.</p><div class="toolbar"><input id="activity-search" type="search" aria-label="Search observed activity" placeholder="Search paths, endpoints, scenarios or errors…"><select id="activity-filter" aria-label="Filter observed activity"><option value="all">All observations</option><option value="new">New in update</option><option value="blocked">Denied / failed attempts</option><option value="network">Network</option><option value="process">Processes</option><option value="file-read">File reads</option><option value="file-write">File writes</option></select></div>${table(["Scenario", "Activity", "Target", "Observed outcome"], activity)}</section><section id="scenarios"><h2>Scenario evidence</h2>${cases
    .map((c, i) => {
      const base = c.baseline[0],
        candidate = c.candidate[0],
        prefix = cases.length > 1 ? `scenario-${i + 1}/` : "";
      const changes = [
        ...new Set([
          ...base.changes.map((x) => x.path),
          ...candidate.changes.map((x) => x.path),
        ]),
      ].map((path) => {
        const a = base.changes.find((x) => x.path === path),
          b = candidate.changes.find((x) => x.path === path);
        return `<tr><td><code>${e(path)}</code></td><td>${e(a?.operation ?? "Unchanged")}<br><span class="muted">${bytes(a?.after?.bytes)}</span></td><td>${e(b?.operation ?? "Unchanged")}<br><span class="muted">${bytes(b?.after?.bytes)}</span></td><td>${a?.after?.sha256 === b?.after?.sha256 ? "Same content" : "Different / additional output"}</td></tr>`;
      });
      return `<section class="scenario"><div class="section-heading"><h3>${i + 1}. ${e(c.scenario)}</h3>${badge(c.status)}</div><div class="hashes"><div class="hash"><label>BASELINE CONTENT</label><code>${e(base.skillDigest)}</code></div><div class="hash"><label>CANDIDATE CONTENT</label><code>${e(candidate.skillDigest)}</code></div></div><h3>Output changes, side by side</h3>${table(["Path", "Baseline", "Candidate", "Comparison"], changes, "No workspace changes observed.")}<h3>Permission findings</h3>${table(
        ["Version", "Rule", "Target", "Outcome"],
        (c.policyViolations ?? []).map(
          (v) =>
            `<tr><td>${e(v.version)}</td><td>${e(v.rule)}</td><td><code>${e(v.target)}</code></td><td>${v.success ? "Succeeded" : "Denied / failed"} ${e(v.errno)}</td></tr>`,
        ),
        "No explicit policy violations observed.",
      )}<details><summary>Executed tool calls · ${candidate.toolCalls?.length ?? 0} candidate calls</summary>${pretty(candidate.toolCalls ?? [])}</details><details><summary>Verification, limits and per-run evidence</summary>${table(
        ["Version / run", "Execution", "Verification", "Evidence"],
        [
          ["baseline", c.baseline],
          ["candidate", c.candidate],
        ].flatMap(([label, list]) =>
          list.map(
            (run, j) =>
              `<tr><td>${label} ${j + 1}</td><td>Exit ${e(run.execution.code)}${run.execution.timedOut ? " · timeout" : ""}</td><td>${run.verification?.code === 0 ? "Passed" : "Failed / unavailable"}</td><td><a href="${prefix}${label}-${j + 1}/run.json">Run JSON ↗</a> · Workspace quota: ${bytes(run.workspaceQuotaBytes)}</td></tr>`,
          ),
        ),
      )}${pretty({ policy: c.policy, runner: c.runner, inputDigests: c.inputDigests, scenarioDigest: c.scenarioDigest })}</details><details><summary>Candidate trace sequence · first repetition</summary>${pretty(candidate.trace.timeline ?? [])}</details></section>`;
    })
    .join(
      "",
    )}</section><footer>${e(r.scope)}<br>Trace decoding is best effort. No report certifies an arbitrary skill as safe. Review sensitive task data before sharing this file.</footer></main><script>${reportScript}</script></body></html>`;
}
export function renderSARIF(r) {
  const rules = [
    {
      id: "update-held",
      shortDescription: { text: "Skill update requires review" },
    },
    {
      id: "coverage-incomplete",
      shortDescription: { text: "Scenario coverage is inconclusive" },
    },
  ];
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: { driver: { name: "skill-update-firewall", rules } },
        results: [
          ...r.reasons.map((text) => ({
            ruleId: "update-held",
            level: "error",
            message: { text },
          })),
          ...r.uncertainties.map((text) => ({
            ruleId: "coverage-incomplete",
            level: "warning",
            message: { text },
          })),
        ],
        properties: { decision: r.status },
      },
    ],
  };
}
