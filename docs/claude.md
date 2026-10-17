# Claude Code integration

The integration gates explicit calls to Claude Code's `Skill` tool with a content-pin check. It does not invoke a model or require API credentials. It is not a substitute for sandboxing the actual skill commands: automatic instruction loading, direct file reads and arbitrary Bash are outside this hook's scope.

Requires Claude Code 2.1.295+ for exec-form hooks with `onFailure: "block"`. Pin the installed skill directory you actually use, then create a trusted mapping, for example:

```json
{
  "schemaVersion": 1,
  "lock": "skills.lock.json",
  "skills": {
    "invoices": { "path": "installed/invoices", "pin": "invoices" }
  }
}
```

Paths resolve relative to this mapping file. The mapping name must match the skill invocation name, including a plugin namespace if applicable. Keep the mapping, pins and generated settings outside directories that an untrusted skill can modify.

```sh
node src/cli.js pin --skill installed/invoices --name invoices --lock skills.lock.json
node src/cli.js claude-settings --config skillwall-claude.json --out skillwall-settings.json
claude --settings /absolute/path/skillwall-settings.json
```

The generator writes a new settings file and does not change any existing Claude settings. Claude's `--settings` loads it. Registered unchanged skills retain the normal permission flow; the hook never returns an automatic permission grant. Drift, missing files, invalid locks and unknown invocation names return deny. Runtime hook failure is blocked by the generated `onFailure` setting. Review updates with `accept`, then update the installed content to the accepted digest before invoking it again.

Test the hook without a model call:

```sh
printf '%s\n' '{"hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"invoices"}}' |
  node src/cli.js claude-hook --config skillwall-claude.json
```

Protocol tests cover match, drift, unknown mappings, missing state and generated fail-closed settings. A live model session has not been used for validation. Official schema: https://code.claude.com/docs/en/hooks
