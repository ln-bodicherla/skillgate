# Scenarios and permission policies

A scenario describes a task, fixture, trusted verifier and review policy. Paths to workspace/checks are relative to the scenario file. Commands are argument arrays with absolute executable paths. The controller copies the skill to `/skill`, task fixtures to `/workspace`, and trusted checks to `/checks`. Working directory is `/workspace`. Skills must contain `SKILL.md`; its presence does not cause an LLM to interpret it.

```json
{
  "name": "Invoice summary",
  "workspace": "workspace",
  "checks": "checks",
  "command": ["/usr/bin/python3", "/skill/run.py"],
  "verify": ["/usr/bin/python3", "/checks/verify.py"],
  "allowedWrites": ["result.txt"],
  "timeoutMs": 10000,
  "repetitions": 2,
  "policy": {
    "network": "deny",
    "deniedReads": ["/home/agent/.ssh", "/workspace/private"],
    "allowedProcesses": ["/usr/bin/python3"],
    "enforceWrites": false,
    "allowNewReads": false,
    "allowNewProcesses": false,
    "allowOutputChanges": false
  },
  "runner": { "type": "bubblewrap" }
}
```

Verification is mandatory and runs in its own sandbox after successful execution. It must exit 0. The skill cannot modify the checks, and verification cannot write workspace files. `timeoutMs` is 500–30000 for execution and separately for verification. Agent/tool-plan execution shares one execution wall-time budget. Comparison performs 2–5 repetitions per version. `run` performs the configured task once.

`allowedWrites` lists exact relative file paths, not glob patterns. Changes outside it are findings. When `enforceWrites` is true, output files are created if absent and mounted writable into an otherwise read-only workspace. Preparation is recorded as `preparedWritableFiles`; artifact changes are measured after preparation. Atomic rename/delete of an output mountpoint is unsupported. This mode can break tools that replace files atomically; use a suitable scenario or the default observation mode.

`deniedReads` matches normalized absolute paths and descendants. Defaults protect `/home/agent/.ssh`, `/home/agent/.aws` and `/home/agent/.config`. An explicit list replaces defaults. `allowedProcesses`, when present, lists exact executable paths, including the initial script/agent executable. These are review rules; they do not filter syscalls during execution. Host secrets are absent regardless of these rules.

Network is always isolated; the only accepted network policy is `deny`. Any observed network operation is a policy finding, including denied attempts and Unix socket operations. There is no hostname allowlist or network grant.

The three review relaxations allow new non-denied reads, new allowed process paths, or different output content after successful verification. They do not grant runtime permissions. Tool-call changes still require review. Unknown policy keys are errors.

## Scenario suites

A suite references 1–20 scenario files:

```json
{ "scenarios": ["scenario.json", "relative-scenario.json"] }
```

Each scenario receives fresh copies and is evaluated independently. HOLD takes precedence over INCONCLUSIVE; every scenario must PASS to accept a new pin. Reports retain each scenario's evidence and input digests. See `examples/suite.json`.

## Runner selection

The scenario may select a runner. CLI `--runner` options override it for the invocation, including every scenario in a suite. See [runners](runners.md).

## Output contract

Version comparisons produce `report.json` (schema version 2), `report.html`, and `report.sarif`. Each case includes normalized policy, runner, scenario digest, four input digests (old skill, candidate skill, fixture, checks), repetitions and decisions. Run evidence includes execution/verification status, content hashes, tool calls, normalized events, a bounded activity sequence and raw trace files. Activity sequences are per traced invocation and are not a globally synchronized chronology for interactive agents.

New event comparisons ignore PID values and duplicates. Repetition signatures compare normalized activity, file changes, stdout and recorded tools. Variability causes INCONCLUSIVE unless concrete HOLD findings exist. This detects some nondeterminism; it is not deterministic replay of a model.
