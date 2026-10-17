# Agent execution adapters

The core does not need a model API. Choose a normal command, a recorded tool plan, or the interactive agent protocol. A real model-backed agent must implement this protocol (or run as a normal sandboxed command). There are no bundled Claude/Codex/OpenClaw connectors and no hosted-model network bridge. The sandbox has no host model credentials or network access; local model assets would need to be included in the supported input/runtime layout.

## Recorded tool plan

Set `"adapter": {"type":"tool-plan", "file":"tools.json"}`. The plan file is inside each skill version:

```json
{
  "calls": [
    { "name": "summarize", "command": ["/usr/bin/python3", "/skill/run.py"] }
  ]
}
```

The controller reads the frozen plan, starts each command in a fresh sandbox and records its actual result. The disposable workspace persists between calls; /tmp does not. A failed call stops the plan. Maximum: 16 calls. These are executed commands, not an LLM's predicted effects.

See `examples/plan-v1`, `examples/plan-v2` and `examples/plan-scenario.json`.

## Interactive agent

Set `"adapter":{"type":"agent"}` and provide `command`. The planner runs sandboxed with read-only skills, checks and workspace. It communicates JSON objects, one per newline, using stdout for protocol and stderr for diagnostics. The controller sends this first message on stdin:

```json
{
  "type": "start",
  "skill": "/skill/SKILL.md",
  "workspace": "/workspace",
  "maxToolCalls": 16
}
```

The agent can read its instructions and request a tool:

```json
{
  "type": "tool",
  "name": "inspect",
  "command": ["/usr/bin/python3", "-c", "print('hello')"]
}
```

The controller validates the request, executes it in a new sandbox, records it outside the skill, and replies on stdin:

```json
{
  "type": "tool-result",
  "name": "inspect",
  "code": 0,
  "stdout": "hello\n",
  "stderr": "",
  "timedOut": false
}
```

The next request can depend on this result. Commands share the disposable workspace. Requests are serialized. The planner can read tool output files through its read-only mount. Tools get the scenario's configured writable workspace permissions.

To complete, send `{"type":"finish"}`, read the `{"type":"finished"}` reply and exit 0. Missing finish, malformed messages, invalid commands, messages after finish or more than 16 requests fail the run. Planner plus tools share the execution timeout. Output and tracing are bounded. Tool failures are retained even if the planner ignores them.

See the branching Python agent in `examples/agent-v1/agent.py`. Compare it with `agent-v2` using `examples/agent-scenario.json` to observe a behavior-changing tool update.

## Evidence and trust

Tool records come from commands started by the controller, not from the agent's self-report. External tracing also records the planner and each tool. A planner can start subprocesses inside its own sandbox; those are traced process events, not necessarily broker tool-call records. Tool names and arguments are untrusted strings and are escaped in HTML reports. Do not interpret them as host commands.
