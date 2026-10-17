# Runner setup

Every runner fails closed. Selecting a backend never enables an unsandboxed fallback. Use `doctor` with the same options before a comparison.

## Bubblewrap

Default. Requires Linux, recent Bubblewrap supporting `--disable-userns` and `--size`, strace, util-linux, and working unprivileged user namespaces and ptrace. `doctor` runs an actual traced sandbox. Distribution policies can prohibit user namespaces or ptrace; use an appropriate isolated development host rather than silently bypassing isolation.

Read-only runtime mounts, isolated namespaces, cleared environment, private task copies and bounded tmpfs are enforced. Each workspace is a kernel-bounded tmpfs (64 MiB and 4096 inodes by default; see [workspace quotas](quotas.md)). No aggregate process/memory limit is provided by this backend.

## Cgroups through systemd

```sh
node src/cli.js doctor --runner cgroup
node src/cli.js compare --old examples/v1 --new examples/v1 \
  --scenario examples/scenario.json --out reports/resource-limited \
  --runner cgroup --memory-mib 256 --tasks-max 64 --cpu-percent 100
```

A systemd user manager must have delegated memory, pids and CPU controllers. MemoryMiB range: 64–16384; TasksMax: 8–512; CPU percent: 10–400. Defaults: 256 MiB, 64 tasks, 100%. Swap is disabled for each scope. `systemd-run --user --scope` applies limits to the traced command and its descendants, including the tracer and Bubblewrap overhead. Verification uses a separate scope. Interactive agent and active tool run concurrently in separate scopes; each has the configured envelope.

No system configuration is changed by this tool. Missing manager/controller support causes an error. These limits share the host kernel. The workspace tmpfs quota applies as with the default backend, and its pages count toward the scope's memory limit.

## VM over SSH

This is a transport to an **existing, user-provisioned disposable Linux VM**, not a VM creator. Configure its image, RAM/vCPU/disk limits and reset strategy in your hypervisor. Do not share the host filesystem, forward host agents, or store credentials in the guest. SSH should be reachable by the host; skill sandboxes inside the guest still have isolated networking.

1. Install Node.js 22+, recent Bubblewrap, strace, util-linux and the task's language runtime in the guest.
2. Copy this repository to a fixed guest path, such as `/opt/skillgate`, readable by an unprivileged dedicated worker user.
3. Configure a dedicated SSH alias/key in your host SSH config and verify its host key through your normal trusted process. Batch mode and strict host-key checking are mandatory. The worker must not run as root. To keep the alias out of `~/.ssh/config`, pass a dedicated file with `--vm-ssh-config FILE`.
4. Ensure `/usr/bin/node /opt/skillgate/src/cli.js doctor` succeeds in the guest.

```sh
node src/cli.js doctor --runner vm \
  --vm-host skillgate-guest --vm-cli /opt/skillgate/src/cli.js

node src/cli.js compare --old examples/v1 --new examples/v2 \
  --scenario examples/scenario.json --out reports/vm-review \
  --runner vm --vm-host skillgate-guest \
  --vm-cli /opt/skillgate/src/cli.js
```

The host sends verified file entries over stdin to the guest worker; no host paths are mounted. The guest creates temporary copies, runs Bubblewrap, verifies outputs, returns structured evidence/raw traces and removes its temporary directory. Transfer paths and hashes are checked. Requests/responses are capped at 32 MiB; each transferred directory and returned trace collection is capped at 16 MiB. Large tasks fail rather than bypassing these bounds. VM run workspaces are not copied back; hashes and observed changes remain in the report, with raw traces under `guest-traces/`.

The host trusts its configured guest controller and SSH key. SSH does not attest that the destination is virtualized or clean. A reused compromised guest can falsify evidence. Reset it between reviews when needed. Cancelling the host transport may leave a guest operation running until its bounded timeout expires.

The transfer and worker protocol are integration-tested locally. A complete run over SSH into a separate Ubuntu arm64 QEMU/KVM guest (snapshot disk, dedicated key, strict host-key checking, `--vm-ssh-config`) was exercised manually: an identical-version comparison returned PASS and the example update returned HOLD with the expected credential-read, network and workspace findings. That end-to-end path is not part of CI. The guest applies its own workspace quota. Provisioning, guest attestation and snapshot automation are outside this release.
