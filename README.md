# SkillGate

**A firewall for AI agent skill updates: it catches when an update quietly changes what a skill _does_, not just what it outputs.**

## What it means

AI agents (Claude Code, Codex and others) load **skills**: folders of instructions and scripts that teach them a task. Skills get updated, and an update can still produce the right answer while also doing something new behind your back.

SkillGate runs the old and new versions of a skill side by side in an isolated sandbox, on the same task, and compares what each one actually did:

| It checks                     | Example of what it catches                    |
| ----------------------------- | --------------------------------------------- |
| Files read                    | The update starts reading `~/.ssh` or `.env`  |
| Network attempts              | The update tries to contact an outside server |
| Programs started              | The update launches `curl` or a shell         |
| Files written                 | The update leaves an extra file behind        |
| Whether the task still passes | The update breaks the expected output         |

Then it gives one decision:

- **PASS**: the new version behaved like the old one in every tested scenario.
- **HOLD**: the behavior changed. The report shows exactly what changed, so you can decide whether to accept it.

Once you accept a version, SkillGate **pins** its exact content. If the skill changes later without a review, SkillGate flags it as drift, and the optional Claude Code hook blocks it from running.

In one line: **SkillGate runs the old and new versions of a skill side by side in a sandbox and holds the update if the new one starts doing things the old one didn't, even when its output still looks correct.**

PASS means "no change observed in the tested scenarios", not "certified safe". See [decisions and limits](#decisions-and-limits).

## Details

SkillGate is a local, open-source CLI that compares skill versions in disposable Linux sandboxes, checks permission policies, and pins accepted content. It supports scripts, recorded tool plans, and interactive agents that request tools through a JSON-lines protocol. The core has no npm dependencies or LLM API requirement.

## Get it from GitHub

```sh
git clone https://github.com/ln-bodicherla/skillgate.git
cd skillgate
node src/cli.js doctor
node scripts/demo.js agent
```

No npm registry package or npm login is needed. The agent demo intentionally returns HOLD (exit 2). Source archives are also available through GitHub Releases.

## Start here

Requires Node.js 22+, Linux, a recent Bubblewrap with `--disable-userns` and `--size`, strace with `-yy`, util-linux (`prlimit`, `unshare`, `nsenter`), and Python 3 for the workspace helper and examples. Unprivileged user namespaces and ptrace must work. Do not run as root. A configured VM runner can move execution to a Linux guest.

On Debian/Ubuntu, the OS packages are `bubblewrap strace util-linux python3`. Install them with your usual package manager. If strace is unavailable, `scripts/bootstrap-strace.sh` builds a checksum-pinned release under `.tools/` without installing system packages.

```sh
node src/cli.js doctor
npm run check
npm test
npm run demo
```

The demo intentionally returns **HOLD (exit 2)**. Open the printed `report.html` path. Both versions produce the correct invoice total, but the update attempts a credential read and an isolated network connection and creates an unexpected file. Each demo invocation creates a new report directory.

For an identical-version PASS:

```sh
node src/cli.js compare \
  --old examples/v1 --new examples/v1 \
  --scenario examples/scenario.json --out reports/first-pass
```

Always use a fresh output directory. Reports contain JSON, a standalone HTML review, SARIF findings, per-run evidence, raw traces and local run workspaces. They may contain task data; review them before sharing.

## What is implemented

| Feature                 | Behavior                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Version comparison      | Frozen input copies, isolated workspaces, mandatory output verification, 2–5 repetitions                                  |
| Permission policies     | Sensitive read rules, process allowlists, denied network activity, configurable review rules                              |
| Strict workspace writes | Optional read-only workspace with exact writable file mounts                                                              |
| Scenario suites         | Up to 20 scenarios; every scenario must pass for acceptance                                                               |
| Tool recording          | Static tool plans and an interactive agent protocol; controller records executed tool calls                               |
| Tracing                 | File, process and network attempts; directory-fd path decoding; resolved open paths; bounded activity sequences           |
| Resource limits         | Wall time, output and trace bounds, per-file/CPU limits, bounded sandbox tmpfs; optional cgroup memory/process/CPU limits |
| Pinning                 | Content hashes, drift detection, fresh comparison before acceptance, prior-pin history and evidence digests               |
| Execution gate          | `run` checks the pin before executing in the sandbox                                                                      |
| Local store             | `install` copies pinned content into a directory addressed by its digest                                                  |
| VM backend              | SSH transport to a user-provisioned Linux guest running the worker protocol                                               |

See [architecture](docs/architecture.md), [scenario and policy reference](docs/scenarios.md), [agent protocol](docs/agents.md), and [runner setup](docs/runners.md).

## Review, pin and run

Choose an initial version you trust. The initial pin is an explicit trust decision, not a security scan:

```sh
node src/cli.js pin --skill examples/v1 --name invoices --lock skills.lock.json
node src/cli.js verify --skill examples/v1 --name invoices --lock skills.lock.json
```

`pin` refuses to overwrite an entry. `verify` reports MATCH or DRIFT without modifying anything. Keep the lockfile outside skills and evidence directories and commit it to your own repository.

Review an update:

```sh
node src/cli.js accept \
  --old examples/v1 --new examples/v2 \
  --scenario examples/suite.json --out reports/update-review \
  --name invoices --lock skills.lock.json
```

This example returns HOLD and preserves the lockfile. Acceptance requires the baseline to match the existing pin, generates fresh sandbox evidence, and confirms the candidate still matches the tested digest. Only a PASS across the entire suite changes the pin. It never accepts a supplied report's status. Lock updates use atomic rename and a guard against concurrent cooperating writers. After an interrupted writer, inspect a stale `.guard` file before removing it.

Run a pinned version or copy it to the local store:

```sh
node src/cli.js run --skill examples/v1 --name invoices --lock skills.lock.json \
  --scenario examples/scenario.json --out reports/pinned-execution
node src/cli.js install --skill examples/v1 --name invoices --lock skills.lock.json \
  --store skill-store
```

`run` executes one scenario once and saves `execution.json`; drift is rejected before execution. `install` verifies copied content and returns `skill-store/<digest>`. Store directories remain ordinary local files: use the execution gate to detect later changes. Neither command changes another application's skill settings.

## Agents and stronger isolation

```sh
node src/cli.js compare \
  --old examples/agent-v1 --new examples/agent-v2 \
  --scenario examples/agent-scenario.json --out reports/agent-review

node src/cli.js compare \
  --old examples/v1 --new examples/v1 \
  --scenario examples/suite.json --out reports/cgroup-review \
  --runner cgroup --memory-mib 256 --tasks-max 64 --cpu-percent 100
```

The agent example branches on a tool result and then requests another tool. Its planner runs sandboxed with a read-only workspace; the controller executes each requested command in a fresh sandbox sharing only the disposable workspace. The supplied example is offline and deterministic. A Claude Code pin-check hook is included; see [Claude integration](docs/claude.md). No hosted model connector is included.

The cgroup runner requires a working systemd user manager and delegated controllers. VM execution requires your own guest and SSH configuration; see [runners](docs/runners.md). Requested isolation is never silently downgraded.

## Decisions and limits

| Exit | Decision                                                | Meaning                                                                        |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0    | PASS / ACCEPTED / MATCH / EXECUTED / PINNED / INSTALLED | Requested operation succeeded within its scope                                 |
| 1    | Error                                                   | Invalid inputs, unavailable isolation, or setup/transport failure              |
| 2    | HOLD / DRIFT                                            | Review findings or content mismatch                                            |
| 3    | INCONCLUSIVE                                            | Baseline failure, incomplete traces or variability prevents a clean comparison |

PASS describes only the supplied scenarios. An unobserved behavior may still be dangerous. Explicit policy rules can catch forbidden activity even if both versions do it, but this is not a malware detector or a safety certification. System runtime reads are largely filtered from normalized comparisons; raw traces retain them. LLM behavior is not assumed repeatable.

Read [SECURITY.md](SECURITY.md). Bubblewrap shares the host kernel. The default runner has no aggregate memory or process limit; use cgroups or a disposable VM for stronger isolation. Every local workspace now uses a kernel-bounded tmpfs (64 MiB by default, with an inode limit); see [workspace quotas](docs/quotas.md). Exported evidence still consumes host storage. The VM backend does not provision or attest a VM; its full SSH/guest path has been exercised manually against a local QEMU guest but is not covered by CI.

## Development

```sh
npm run check
SKILLGATE_REQUIRE_SANDBOX=1 npm test
npm pack --dry-run
```

Integration tests execute real Bubblewrap and strace. Missing local sandbox support is an explicit skip unless `SKILLGATE_REQUIRE_SANDBOX=1` is set. Cgroup tests separately detect host support. The VM worker and transfer protocol are tested locally; a separate guest is required to test the entire SSH backend.

Node 22 and newer are supported. `.tools/`, reports, demo output and dependencies are ignored by Git. `SKILLGATE_STRACE` may select a trusted strace binary. See [CONTRIBUTING.md](CONTRIBUTING.md). Apache-2.0 licensed.
