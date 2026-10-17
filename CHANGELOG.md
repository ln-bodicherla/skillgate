# Changelog

## Unreleased

- Renamed the project from Skill Update Firewall to SkillGate. The command is now `skillgate`, environment variables use the `SKILLGATE_` prefix, and the repository is github.com/ln-bodicherla/skillgate (old URLs redirect).

## 0.2.0 — first public release

- Redesigned HTML report: decision summary, finding counts, side-by-side output changes, policy tables, per-run evidence links and a searchable, filterable activity explorer (CSP-pinned inline script, no external assets).
- Kernel-enforced workspace quota: every local run uses a private rootless tmpfs (`workspaceMiB`, default 64 MiB, 4096 inodes); `doctor` probes it.
- Claude Code integration: `claude-settings` generates a fail-closed PreToolUse hook and `claude-hook` denies unregistered or drifted Skill invocations.
- VM runner accepts `--vm-ssh-config`; full SSH execution validated manually against a QEMU guest.
- GitHub clone-and-run instructions replace npm distribution.
- Configurable review policies, strict writable-file mounts and scenario suites.
- Recorded tool-plan and interactive JSON-lines agent adapters.
- Cgroup resource limits and SSH transport to a configured Linux VM worker.
- Directory-fd and resolved-path tracing, bounded activity sequences, SARIF reports.
- Pin-enforced execution, content-addressed local installation and acceptance history/evidence provenance.
- Repeatable demos, documented threat model and runner/agent setup, CI and integration tests.

Prototype pin hashing now uses a locale-independent filename order. Lockfiles made with the unpublished 0.1 prototype may report DRIFT; review the content and create a new initial lockfile rather than treating a prototype pin as portable.
