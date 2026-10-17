# Security scope

Experimental software. Prefer a disposable Linux VM for actively hostile skills. Bubblewrap shares the kernel; it is not a complete security boundary. Never run the worker as root. PASS is not a security certification.

## Enforced restrictions

Local execution unshares namespaces, disables nested user namespaces and drops capabilities. The system runtime under /usr and library/bin paths is read-only. Host home, host /etc, controller credentials/environment, and host network are absent. Skills and checks are read-only. Verification receives a read-only workspace. External strace observes the executed process tree. The root tmpfs and /tmp are each limited to 32 MiB. Wall time, per-file size, per-process CPU, open descriptors, output and trace inspection are bounded.

Default workspace permissions allow writes throughout a disposable copy; unexpected file changes are review findings. With `policy.enforceWrites`, the workspace is read-only except exact allowed output files, which are prepared before execution. This mode prevents workspace writes outside those mounts, including attempts later caught and ignored by a skill. Writable-file mounts do not support atomic replacement or deletion of the mountpoint. The remaining sandbox-local writable paths are not governed by the output file list.

The cgroup backend adds MemoryMax, MemorySwapMax=0, TasksMax and CPUQuota through transient systemd user scopes. Limits cover the tree of each invocation, including descendants. An interactive planner and its active tool occupy separate concurrent scopes, so a scenario may use up to two configured envelopes. Verification has its own scope. There is no fallback if the selected backend cannot start.

The VM backend transfers inputs to a configured guest via SSH with mandatory host-key verification and agent forwarding disabled. The guest worker still uses Bubblewrap. Host credentials and home are not transferred. VM RAM, virtual CPU, disk, networking, image lifecycle and snapshot reset are the operator's responsibility. SSH authenticates the host key, not the claim that the destination is a VM. Use a dedicated disposable guest with no secrets and no host directory shares. Guest cleanup is bounded by worker timeouts; cancelling SSH may not immediately terminate an in-flight guest run.

## Review policies versus runtime enforcement

Network isolation, read-only mounts, strict writable-file mounts, and configured resource limits are enforced during execution. `deniedReads` and `allowedProcesses` are post-execution review rules, not syscall filters: a process may execute or read fixture data before being flagged. Never mount a secret and rely on a review rule to hide it. Network policy only supports deny. Read/process/output review relaxations do not grant host access or enable network traffic.

The interactive agent broker records the tool commands it actually starts. Requests are bounded and executed without host shell interpolation. The planner may still start its own subprocesses inside its sandbox; external tracing observes them, and broker records are not claimed to exhaustively attribute every agent action. The controller does not execute a model's requested command outside a sandbox. No model API credentials are forwarded.

## Remaining limits

Writable workspaces use a private rootless tmpfs with a kernel-enforced capacity (64 MiB by default) and a 4096-inode limit. The controller enters its namespace before starting Bubblewrap; a sibling namespace cannot access it directly. Temporary workspace allocation is bounded, but exported evidence and trace collections still consume host storage across reviews. This is not a global quota for the report directory. Default Bubblewrap lacks aggregate memory/process limits. Cgroups constrain resources but share the host kernel. Kernel vulnerabilities and tracing evasion remain possible. Runtime packages under /usr are exposed.

Trace decoding is best effort. Directory-fd annotations and resolved open paths improve coverage but do not fully reconstruct all descriptor sharing, symlinks, filesystem operations, socket payloads, DNS names or kernel interfaces. Unknown/truncated paths and io_uring use create uncertainty. System runtime reads are normally filtered from normalized comparisons. Raw traces are available for review. Attempted activity is not proof of intent; no syscall record proves complete coverage. A behavior absent from every scenario remains untested. Repetition detects some variability, not all nondeterminism.

The controller, scenario/verification files, OS tools, runtime and source/report/store directories must be trusted and not mutated concurrently by a hostile host actor. Input symlinks and special files are rejected; hostile filesystem races are not supported. File hashes include content and an executable bit, not ownership or complete Unix metadata. Empty directories are not included in content digests.

## Lockfile and evidence trust

Initial pins are explicit trust decisions. Update acceptance generates fresh evidence and binds it to both skill content digests, scenario digests and fixture/check digests. It records prior pin history and a report hash. State is local and unsigned. Protect lockfiles, stores, reports and controller code from modification. Atomic rename avoids partial JSON replacement; it does not guarantee durability after power loss. Guard files coordinate cooperating writers only.

`run` checks the copied skill digest before execution. `install` copies pinned content into a digest-addressed store, which is still writable local state and must be verified when used. Other applications can bypass this tool; installation does not intercept their updates or execution. Reports can contain task inputs, outputs, command arguments and trace data. New report directories are private by default, but do not publish evidence without reviewing it.

## Reporting bugs

Provide a minimal sanitized reproduction and state the runner and OS/tool versions. Do not include credentials or sensitive fixtures in public issues. No hosted private vulnerability reporting channel has been configured yet.

## Claude Code integration

The optional PreToolUse hook checks registered explicit Skill invocations against local pins. It denies unknown, drifted and unreadable entries and retains the normal permission flow on a match. Generated settings require Claude Code 2.1.295+ and onFailure=block. It does not gate automatic instruction loading or arbitrary reads/Bash, and cannot enforce policy if a user disables the hook. Hook settings, mappings and locks must be trusted and protected.
