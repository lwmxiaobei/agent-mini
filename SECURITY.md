# Security Policy

## Supported Versions

Security fixes are provided for the latest published release on a best-effort basis.

If you are reporting a vulnerability, please verify it against the current release before sending a report.

## Reporting a Vulnerability

Please do not open a public GitHub issue for suspected security vulnerabilities.

Instead, report the issue privately to `security@xbcode.dev` and include:

- A clear description of the vulnerability
- The affected version or commit when known
- Reproduction steps or a proof of concept
- The expected impact and any relevant environment details

You can expect:

- An acknowledgment within 5 business days
- A follow-up after triage if more information is needed
- Coordination on disclosure timing for confirmed issues

## Security Scope

`xbcode` is a local CLI agent that can read and write files inside the current workspace, execute shell commands, load skills, connect to MCP servers, and authenticate against model providers.

Because of that, reports are especially useful when they involve:

- Sandbox or workspace-boundary escapes
- Dangerous command filtering bypasses
- Credential leakage or unintended token persistence
- Prompt injection paths that lead to unexpected tool execution
- Unsafe MCP exposure or resource handling

## Operational Guidance

Users should treat `xbcode` as a privileged local development tool and review:

- Which directory it is running in
- Which providers and MCP servers are configured
- Which credentials are available on the machine
- Whether the current project contains trusted `AGENTS.md` and local skills
