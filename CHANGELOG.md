# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
During the 0.x line, minor versions may contain breaking changes.

## [Unreleased]

### Added
- Release workflow: pushing a `v*` tag runs a release gate, builds `Qoder-Optimization - <version>.zip` with a versioned top-level folder, writes a `.sha256` checksum, and attaches both to the GitHub Release.
- `CHANGELOG.md`, plus a download section and version table in `README.md`, so users can pick a version without cloning.

### Changed
- Release assets are immutable: a published zip is never replaced, fixes ship as a new patch release.

## [0.0.1] - 2026-10-27

### Added
- First open-source release.
- 123 skills, split into a resident layer (always injected) and an on-demand library.
- 87 scripts: guardrails with self-tests, packaging and validation tooling, desktop-automation helpers.
- 10 slash commands, 2 sub-agents, 20 domain/process rule files.
- Hook wiring templates for 5 events and placeholder-only MCP configuration.
- De-identified memory export (`qoder-memory-export-generic.tar.gz`) and offline MCP assets.
- MIT license.

[Unreleased]: https://github.com/liushikuan63/Qoder-Optimization/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1
