# pi-agent-router

`pi-agent-router` provides active-agent selection, subagent delegation, task rendering, and related routing utilities for the Pi coding agent.

## Structure

This extension follows the production-style layout used by other Pi extensions:

```text
pi-agent-router/
├── index.ts
├── package.json
├── tsconfig.json
├── README.md
└── src/
```

## Local usage

Place this folder in Pi's extension discovery path:

```text
~/.pi/agent/extensions/pi-agent-router
```

## Validation

```bash
npm run build
npm run typecheck
npm run test
```
