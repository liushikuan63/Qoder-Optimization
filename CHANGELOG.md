# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
During the 0.x line, minor versions may contain breaking changes.

## [Unreleased]

## [0.0.2] - 2026-10-28

### Fixed
- Reduce the recommended resident set to 12 entries without deleting skills; repair core/library resource lookup, zero-write previews, explicit migration scopes and index-failure reporting.
- Generate installable catalog source/install entries from the public package, not from private HOME configuration; validate schema before replacing registration.
- Validate tag, VERSION, catalog, manifest, counts and consumer behavior; build only approved committed files and independently verify ZIP contents.
- Compare existing remote assets by downloaded content instead of names, and retain drafts until both assets pass verification.
- Back up exact pending suggestion rows and verify updates before COMMIT; leave evolving, expired and unselected rows untouched.
- Preserve model/tool/author attribution and uncertainty in rewritten guidance; numeric or word-list checks do not establish semantic equivalence.
- Correct secret-scan false positives for versions, relative paths and Markdown names, while rejecting missing or empty scan inputs.

### Added
- Release workflow: pushing a `v*` tag runs a release gate, builds `Qoder-Optimization-<version>.zip` with a versioned top-level folder, writes a `.sha256` checksum, and attaches both to the GitHub Release.
- `CHANGELOG.md`, plus a download section and version table in `README.md`, so users can pick a version without cloning.

### Changed
- README rewritten for a flatter, claim-checkable tone (PR #1 from @YuneTech); the download section and version table are kept.
- Release assets are immutable: a published zip is never replaced, fixes ship as a new patch release.
- Package and asset names contain no spaces (`Qoder-Optimization-0.0.1.zip`, top-level folder `Qoder-Optimization-0.0.1/`), so GitHub does not rewrite the asset name.

## [0.0.1] - 2026-10-27

### Added
- First open-source release.
- 123 skills, split into a resident layer (always injected) and an on-demand library.
- 87 scripts: guardrails with self-tests, packaging and validation tooling, desktop-automation helpers.
- 10 slash commands, 2 sub-agents, 20 domain/process rule files.
- Hook wiring templates for 5 events and placeholder-only MCP configuration.
- De-identified memory export (`qoder-memory-export-generic.tar.gz`) and offline MCP assets.
- MIT license.

[Unreleased]: https://github.com/liushikuan63/Qoder-Optimization/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.2
[0.0.1]: https://github.com/liushikuan63/Qoder-Optimization/releases/tag/v0.0.1
