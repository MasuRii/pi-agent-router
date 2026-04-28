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

Task items use `id` as the stable logical task reference. Use `retry: true` (or `retryFrom: "<taskId|logicalId|sessionId|sessionPath>"`) to resume prior delegated work with the retained Pi `--session` path when available. Use top-level or per-task `contextFrom` to hand off only bounded final responses/results or validated `submit_result` payloads from previous delegated sessions; in `mode: "chain"`, a per-task `contextFrom` may also reference an earlier completed item in the same batch by `id`. Full transcripts, session context, and tool history are not injected.

### Session attachment

Open or dismiss tracked delegated-task output:

```text
/attach
/attach <sessionId>
/dismiss <sessionId>
/dismiss all
```

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
| `delegatedExtensions` | array | `[]` | Extra extensions to load into delegated subagent runtimes when installed. Entries can be a string, an alias/candidate array, or an object with `candidates` and `skipWhen`. Missing entries are skipped without failing delegation. |

### Example config

```json
{
  "debug": false,
  "maxParallelDelegationConcurrency": 4,
  "delegatedExtensions": []
}
```

Invalid `maxParallelDelegationConcurrency` values are rejected with task control warnings and the default of `4` is used. Changes take effect after Pi reloads the extension or the task controls cache is invalidated.

### Delegated extension compatibility

By default, delegated subagents run with Pi's automatic extension discovery disabled and only receive router-generated runtime extensions. This keeps published installs portable for users who do not have local companion extensions.

Use `delegatedExtensions` when you intentionally want delegated subagents to load extra installed extensions:

```json
{
  "delegatedExtensions": [
    "pi-fast-mode",
    ["pi-context-injector", "context-injector"],
    {
      "candidates": ["pi-multi-auth", "multi-auth"],
      "skipWhen": ["directEnvAuthAvailable"]
    }
  ]
}
```

Entry formats:

| Entry shape | Meaning |
|-------------|---------|
| `"extension-name"` | Load this extension if `$PI_CODING_AGENT_DIR/extensions/extension-name` exists. |
| `["name-a", "name-b"]` | Treat names as candidates for the same compatibility extension and load the first installed candidate. |
| `{ "candidates": [...], "skipWhen": [...] }` | Load the first installed candidate unless a generic skip rule applies. |

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

Router config rules and extension metadata rules are merged. The legacy object shape with `requiredExtensionCandidates`, `optionalExtensionNames`, and `delegatedMultiAuthExtensionNames` is still accepted for compatibility and normalized into the unified list internally.

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
# Build/type generation check used by this extension
npm run build

# Strict type check
npm run lint

# Run regression tests
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
