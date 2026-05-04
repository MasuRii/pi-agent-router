# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-05-04

### Added
- Added `delegatedExtensions[].optional` so compatibility extensions can be explicitly optional while security companion entries remain fail-closed by default.
- Added delegated runtime follow-up status handling so queued or running task delegations continue through hidden orchestrator reminder and completion turns.

### Changed
- Delegated extension loading now merges extension-provided runtime metadata with router config `skipWhen` rules before deciding whether to load a companion extension.
- Updated Pi peer dependency ranges to `@mariozechner/*` `^0.72.0` and `typebox` `^1.1.37`.

### Fixed
- Blocked missing delegated security companions such as `pi-permission-system`, `pi-sensitive-guard`, and `env-protection` unless the config entry is intentionally marked optional.
- Compacted delegated failure summaries and runtime status displays so failed batches remain readable.

## [0.4.0] - 2026-04-30

### Added
- Expanded `/dismiss` targeting to accept retained task ids, logical task ids, and unique delegated agent names in addition to session ids.

### Changed
- Refactored delegated-session widget and dismiss menu rendering for more compact active-state and task selection displays.
- Shortened task tool and parameter descriptions to reduce prompt/context overhead while preserving `contextFrom` mode rules.
- Updated Pi peer dependency ranges to `@mariozechner/*` `^0.70.6` and `typebox` `^1.1.35`.

### Fixed
- Added explicit validation for top-level and parallel `contextFrom` references that match current-batch task ids, with guidance to use chain mode or retained delegated sessions.
- Fixed `/dismiss` so dismissing one running parallel delegated session no longer aborts or skips unrelated parallel tasks.

## [0.3.0] - 2026-04-28

### Added
- Added retained task context handoff support through `contextFrom`, including bounded final-response/result injection from previous delegated sessions and earlier completed chain-mode items.
- Added retry support through `retry` and `retryFrom` so delegated tasks can resume retained Pi session paths by logical task id, task id, session id, or session path.
- Added chain-mode validation and coverage for prior-step context references, output sanitizer behavior, output contract handling, subagent output retention, and task tool adapter behavior.

### Changed
- Improved delegated output normalization and sanitization to retain handoff-safe final responses and structured `submit_result` payloads while omitting ambiguous tool transcripts and full session history.
- Expanded task tool descriptions and README usage guidance for explicit task agents, parallel and chain execution, retained context handoffs, and retry semantics.

## [0.2.0] - 2026-04-27

### Added
- Added runtime configuration for delegated subagent behavior, including `maxParallelDelegationConcurrency`, delegated extension loading rules, provider environment-key mappings, direct environment delegation provider IDs, credential fallback policies, Copilot initiator target APIs, primary agent lists, agent emoji mappings, and subagent widget icon mode.
- Added a publish-ready starter config template under `config/config.example.json` and included release artifacts in the package file list.

### Changed
- Improved delegated credential entitlement handling so direct environment authentication providers can avoid unnecessary compatibility extension loading and provider fallback policies can require distributed credentials where configured.
- Expanded package metadata, README installation/configuration/publishing guidance, and npm package exclusions to match Pi extension publish conventions.
