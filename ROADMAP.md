# Roadmap

This roadmap reflects the current direction of `xbcode`. It is intentionally short and may change as the project evolves.

## Current Status

`xbcode` is usable today for terminal-first coding workflows, but it should still be treated as an early open source product.

The core loop, tool execution, skills, MCP integration, task persistence, and teammate coordination are already in place. The next phase is to improve reliability, documentation quality, and contributor experience rather than expanding surface area too aggressively.

## Near Term

- Strengthen test coverage around tool execution, workspace boundaries, and teammate flows
- Improve onboarding with clearer quick-start paths and example workflows
- Refine provider configuration and model selection UX
- Stabilize MCP configuration and troubleshooting guidance

## Medium Term

- Make agent behavior easier to inspect and debug from the CLI
- Improve long-running session ergonomics and compaction visibility
- Expand skill authoring guidance and examples
- Harden multi-agent coordination and inbox workflows

## Out of Scope for Now

- Turning the project into a large framework with heavy abstraction layers
- Adding broad feature surface area without clear operational value
- Optimizing for hosted or remote-managed execution before the local CLI workflow is solid
