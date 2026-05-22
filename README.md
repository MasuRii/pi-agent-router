# pi-agent-router

[![npm version](https://img.shields.io/npm/v/pi-agent-router?style=flat-square)](https://www.npmjs.com/package/pi-agent-router) [![License](https://img.shields.io/github/license/MasuRii/pi-agent-router?style=flat-square)](LICENSE)

Active-agent routing and controlled subagent delegation for the [Pi coding agent](https://github.com/mariozechner/pi).

`pi-agent-router` adds active-agent selection, orchestrator-only task delegation, tracked subagent sessions, parallel and chain delegation rendering, and scalable controls for task execution concurrency.

## Features

- **Active-agent selection** with `/agent` for switching between configured Pi agents
- **Task delegation routing** that limits delegation to the orchestrator agent
- **Parallel and chain execution modes** for delegated task batches
- **Configurable parallel delegation concurrency** through `maxParallelDelegationConcurrency`
- **Tracked delegated sessions** with attach and dismiss workflows
- **Delegated runtime safety controls** for optional compatibility extensions and fail-closed security companions
- **Compact task result rendering** for running, completed, failed, and aborted delegation batches
- **Output contract warnings** that surface malformed or incomplete delegated results
- **Debug logging control** through `debug`, with logs written only under the extension-local `debug/` directory when enabled

## Installation

### Local extension folder

Place this folder in one of Pi's auto-discovery locations:

```text
# Global default (when PI_CODING_AGENT_DIR is unset)
~/.pi/agent/extensions/pi-agent-router

# Project-specific
.pi/extensions/pi-agent-router
```

When `PI_CODING_AGENT_DIR` is set, the global path resolves under `$PI_CODING_AGENT_DIR/extensions/pi-agent-router`.

### npm package

```bash
pi install npm:pi-agent-router
```

### Git repository

```bash
pi install git:github.com/MasuRii/pi-agent-router
```

## Usage

### Active agent selection

Open the active-agent picker or switch in non-interactive mode:

```text
/agent
/agent code
/agent orchestrator
/agent off
```

### Task delegation

The extension registers controlled task delegation for the orchestrator agent. Delegated batches can run in parallel or chain mode depending on the task request.

Parallel delegation uses the configured concurrency limit. Chain delegation always executes one step at a time so each step can receive prior-step context.

Task items use `id` as the stable logical task reference. Use `retry: true` (or `retryFrom: "<taskId|logicalId|sessionId|sessionPath>"`) to resume prior delegated work with the retained Pi `--session` path when available. Use top-level or parallel per-task `contextFrom` only for retained delegated sessions; in `mode: "chain"`, per-task `contextFrom` may also reference earlier completed same-batch items by `id`. Only bounded final responses/results or validated `submit_result` payloads are injected; full transcripts, session context, and tool history are not injected.

When delegated work is still queued or running after a `task` tool result, the router schedules hidden follow-up turns that remind the orchestrator to continue dispatching independent work and later report delegated runtime status once the tracked jobs finish. This prevents premature final responses while preserving compact visible output.

### Session attachment

Open or dismiss tracked delegated-task output:

```text
/attach
/attach <sessionId>
/dismiss <sessionId|taskId|agent>
/dismiss all
```

`/dismiss` accepts a session id/prefix, retained task id, logical task id, or a unique delegated agent name. Dismissing one task in parallel mode stops only that delegated session; chain mode stops later queued steps when the dismissed session is not the final step, while completed earlier chain results remain in the final summary.

## Configuration

Runtime configuration is stored at:

```text
Default global path: ~/.pi/agent/extensions/pi-agent-router/config.json
Actual global path: $PI_CODING_AGENT_DIR/extensions/pi-agent-router/config.json when PI_CODING_AGENT_DIR is set
```

A starter template is included at `config/config.example.json`.

### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `debug` | boolean | `false` | Enables extension debug logging to `debug/pi-agent-router-debug.jsonl`; no debug log file is opened when disabled |
| `maxParallelDelegationConcurrency` | integer | `4` | Maximum number of delegated tasks that can run at the same time in parallel mode; valid range is `1` to `16` |
| `delegatedExtensions` | array | required security companions | Extensions to load into delegated subagent runtimes. The generated default requires `pi-permission-system` plus one of `pi-sensitive-guard` or `env-protection`; entries can be a string, an alias/candidate array, or an object with `candidates`, `skipWhen`, and `optional`. Missing security companion entries fail closed unless marked optional; other missing entries are skipped with a warning. |
| `agentDiscovery.maxMarkdownBytes` | integer | `262144` | Maximum bytes read from each agent Markdown file during discovery; larger files are skipped to keep startup and reload bounded. |

### Example config

```json
{
  "debug": false,
  "maxParallelDelegationConcurrency": 4,
  "agentDiscovery": {
    "maxMarkdownBytes": 262144
  },
  "delegatedExtensions": [
    "pi-permission-system",
    ["pi-sensitive-guard", "env-protection"]
  ]
}
```

Invalid `maxParallelDelegationConcurrency` values are rejected with task control warnings and the default of `4` is used. Changes take effect after Pi reloads the extension or the task controls cache is invalidated.

### Delegated extension compatibility

By default, delegated subagents run with Pi's automatic extension discovery disabled and receive router-generated runtime extensions plus required security companion entries. If a deployment intentionally does not use those companions, mark the relevant entry `optional: true`; otherwise missing security companions fail closed before delegation starts.

Use `delegatedExtensions` when you intentionally want delegated subagents to load extra installed extensions:

```json
{
  "delegatedExtensions": [
    "pi-fast-mode",
    ["pi-context-injector", "context-injector"],
    {
      "candidates": ["pi-multi-auth", "multi-auth"],
      "skipWhen": ["directEnvAuthAvailable"],
      "optional": true
    }
  ]
}
```

Entry formats:

| Entry shape | Meaning |
|-------------|---------|
| `"extension-name"` | Load this extension if `$PI_CODING_AGENT_DIR/extensions/extension-name` exists. |
| `["name-a", "name-b"]` | Treat names as candidates for the same compatibility extension and load the first installed candidate. |
| `{ "candidates": [...], "skipWhen": [...], "optional": true }` | Load the first installed candidate unless a generic skip rule applies; treat missing candidates as intentional when `optional` is `true`. |

Supported `skipWhen` values:

| Rule | Meaning |
|------|---------|
| `directEnvAuthAvailable` | Skip the delegated extension when the selected delegated provider can use direct environment-variable authentication. |

Extensions can also declare their own delegated-runtime metadata in `package.json`:

```json
{
  "piAgentRouter": {
    "delegatedRuntime": {
      "skipWhen": ["directEnvAuthAvailable"]
    }
  }
}
```

Router config rules and extension metadata rules are merged. Security companion candidates named `pi-permission-system`, `pi-sensitive-guard`, or `env-protection` are required by default because delegated subagents run with `--no-extensions`; delegation fails closed when those candidates are missing unless the entry sets `optional: true`. The legacy object shape with `requiredExtensionCandidates`, `optionalExtensionNames`, and `delegatedMultiAuthExtensionNames` is still accepted for compatibility and normalized into the unified list internally.

When a delegated model has already been resolved and is launched with `--model`, the router marks the subagent runtime with `PI_MODEL_DISCOVERY_CACHE_ONLY=1`. Compatible `model-discovery` versions still register cached provider metadata but skip startup background discovery and catalog HTTP requests in that subagent.

### Additional task controls

The extension also respects existing Pi task control settings from global `settings.json`, nearest project `.pi/settings.json`, and environment variables. Those controls remain available for advanced automation and are applied after the extension config:

- `agentRouter.task.maxConcurrency`, `taskRouter.maxConcurrency`, or `task.maxConcurrency`
- `agentRouter.task.maxRecursionDepth`, `taskRouter.maxRecursionDepth`, or `task.maxRecursionDepth`
- `agentRouter.task.eagerDelegation`, `taskRouter.eagerDelegation`, or `task.eagerDelegation`
- `agentRouter.task.defaultTimeoutMs`, `taskRouter.defaultTimeoutMs`, or `task.defaultTimeoutMs`
- `agentRouter.task.outputStrictness`, `taskRouter.outputStrictness`, or `task.outputStrictness`
- `PI_AGENT_ROUTER_TASK_MAX_CONCURRENCY`
- `PI_AGENT_ROUTER_TASK_DEFAULT_TIMEOUT_MS`
- `PI_AGENT_ROUTER_TASK_OUTPUT_STRICTNESS`
- `agentRouter.task.retry.enabled`, `taskRouter.retry.enabled`, or `task.retry.enabled` (`true`/`false`)
- `agentRouter.task.retry.maxRetries`, `taskRouter.retry.maxRetries`, or `task.retry.maxRetries` (integer `0` through `32`)
- `agentRouter.task.retry.baseDelayMs`, `taskRouter.retry.baseDelayMs`, or `task.retry.baseDelayMs` (integer `0` through `3600000` milliseconds)

## Troubleshooting

### Parallel delegation is too aggressive

Lower `maxParallelDelegationConcurrency` in `config.json`, then reload Pi. Use `1` when you want parallel-mode task batches to run serially without changing prompts to chain mode.

### Config not loading

1. Check that `config.json` exists in the Pi extension runtime folder.
2. Make sure the JSON is valid.
3. Confirm `maxParallelDelegationConcurrency` is an integer from `1` through `16`.
4. Reload Pi so cached task controls are refreshed.

### Debug logs not appearing

Debug logging is disabled by default. Set `debug` to `true`; logs will be appended under `debug/` next to this extension. When `debug` is `false`, the extension does not write debug logs or open debug log handles.

## Project structure

```text
pi-agent-router/
├── index.ts                         # Extension entrypoint for Pi auto-discovery
├── src/
│   ├── index.ts                     # Bootstrap, command registration, task tool integration
│   ├── config.ts                    # Config load, initialization, and validation
│   ├── constants.ts                 # Shared runtime limits and defaults
│   ├── debug-logger.ts              # File-only debug logger gated by config.json
│   ├── subagent/                    # Delegated runtime, session, credential, and metadata helpers
│   ├── task/                        # Task delegation controls, rendering, and parallel execution helpers
│   └── test/                        # Bun-based extension regression tests
├── config/
│   └── config.example.json          # Starter config template
├── CHANGELOG.md
├── LICENSE
├── package.json
├── README.md
└── tsconfig.json
```

## Development

```bash
# Build/type-safety check used by this extension
npm run build

# Strict type check
npm run lint

# Verify Bun is installed for the Bun-based regression suite
npm run test:runtime

# Run regression tests (requires Bun on PATH; see https://bun.sh/docs/installation)
npm run test

# Full verification
npm run check
```

## Publishing

The package metadata follows the same publish-ready shape used by established local Pi extensions:

- entrypoint: `index.ts`
- package exports: `.` → `./index.ts`
- Pi extension manifest: `pi.extensions`
- published files: source, README, changelog, license, and config template
- runtime `config.json` and `debug/` logs excluded from npm publication

## Related Pi Extensions

| Extension | Install | Description |
|-----------|---------|-------------|
| [pi-multi-auth](https://www.npmjs.com/package/pi-multi-auth) | `pi install npm:pi-multi-auth` | Multi-provider credential management, OAuth login, and account rotation |
| [pi-rtk-optimizer](https://www.npmjs.com/package/pi-rtk-optimizer) | `pi install npm:pi-rtk-optimizer` | RTK command rewriting and tool output compaction |
| [pi-must-have-extension](https://www.npmjs.com/package/pi-must-have-extension) | `pi install npm:pi-must-have-extension` | RFC 2119 keyword normalizer for prompt compliance |
| [pi-hide-messages](https://www.npmjs.com/package/pi-hide-messages) | `pi install npm:pi-hide-messages` | Hide older TUI chat history while preserving full session context |

## License

[MIT](LICENSE)
