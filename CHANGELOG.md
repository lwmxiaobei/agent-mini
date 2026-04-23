# Changelog

All notable changes to `xbcode` will be documented in this file.

The format is based on Keep a Changelog, and the project aims to follow Semantic Versioning for published releases.

## [Unreleased]

### Added

- OpenAI OAuth login support for provider authentication
- Skills loading from global and workspace-local directories
- MCP integration with dynamic tool exposure and resource access
- Persistent task storage under `.tasks/`
- Lightweight teammate-based multi-agent coordination
- Context compaction support for long-running sessions
- Open source project baseline files, including contribution guides, issue templates, PR template, security policy, and CI workflow

## [1.0.0] - 2026-04-22

### Added

- Initial public release of `xbcode`
- Terminal-first TypeScript CLI coding agent built with OpenAI SDK and Ink
- Streaming model output and workspace-scoped file and shell tools
- Dual backend support for Responses API and Chat Completions API
- Repo `AGENTS.md` prompt injection and slash-command based CLI workflow
