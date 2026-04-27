# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-27

### Added
- Added runtime configuration for delegated subagent behavior, including `maxParallelDelegationConcurrency`, delegated extension loading rules, provider environment-key mappings, direct environment delegation provider IDs, credential fallback policies, Copilot initiator target APIs, primary agent lists, agent emoji mappings, and subagent widget icon mode.
- Added a publish-ready starter config template under `config/config.example.json` and included release artifacts in the package file list.

### Changed
- Improved delegated credential entitlement handling so direct environment authentication providers can avoid unnecessary compatibility extension loading and provider fallback policies can require distributed credentials where configured.
- Expanded package metadata, README installation/configuration/publishing guidance, and npm package exclusions to match Pi extension publish conventions.
