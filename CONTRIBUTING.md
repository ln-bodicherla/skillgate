# Contributing

Open an issue or pull request with a concrete behavior and sanitized reproduction. Keep the runtime dependency-free and fail closed when isolation is unavailable. Include focused tests for changes to isolation, policy decisions, pinning, protocols or process supervision.

Run `npm run check`, `SKILLWALL_REQUIRE_SANDBOX=1 npm test`, and `npm pack --dry-run` on Linux. State explicitly when a backend was not tested. Cgroup tests require a working systemd user manager; a separate guest is required for full SSH/VM testing. CI permits namespaces only on its disposable runner and must not silently skip local sandbox tests.

Review report output for HTML escaping and sensitive fixture disclosure. Keep security claims proportional to the evidence. See SECURITY.md before proposing new permissions or host access. Initial trust and policy decisions must stay explicit; stored reports must not become unauthenticated update approvals.
