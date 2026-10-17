# Workspace quotas

Each run allocates a private tmpfs in a rootless user/mount namespace. Capacity defaults to 64 MiB; set `workspaceMiB` in a trusted scenario to an integer from 8 to 1024. The filesystem has a 4096-inode limit, covering empty-file and directory creation as well as file data. Writes beyond the kernel limit fail with ENOSPC. A regression test writes multiple files to demonstrate aggregate enforcement.

A trusted Python helper owns the private mount and waits for the controller. The controller populates it through its proc-root view, then uses nsenter with preserved credentials to enter that namespace before Bubblewrap creates its own isolation. No skill runs directly in the workspace holder. Parent-death handling and stdin closure dispose of the namespace. Kernel user namespaces, util-linux and Python 3 are required; unavailable quotas are errors, never an unbounded fallback.

After execution and verification, inspected ordinary file artifacts are copied to the evidence directory. Symlink or uninspectable outputs are not exported. They remain findings in the report. Exported reports and traces consume ordinary host disk space; this quota does not limit the sum of evidence from many runs. Tmpfs data consumes memory, so use the cgroup backend and/or a disposable VM when memory exhaustion matters.
