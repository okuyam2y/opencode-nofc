# Security

## Upstream

This is a fork of [anomalyco/opencode](https://github.com/anomalyco/opencode). For security issues in the upstream codebase, please report to the [upstream security advisories](https://github.com/anomalyco/opencode/security/advisories/new).

## This Fork

For security issues specific to this fork (tool parser middleware, streaming tag filter, document extraction, OCR, etc.), please [open a GitHub issue](https://github.com/okuyam2y/opencode-nofc/issues/new) with the label `security`.

If the issue is sensitive, please email okuyam2y@gmail.com.

## Threat Model

See the [upstream SECURITY.md](https://github.com/anomalyco/opencode/blob/dev/SECURITY.md) for the full threat model. The same considerations apply to this fork. In particular:

- OpenCode does **not** sandbox the agent
- Server mode is opt-in and requires user-configured authentication
- The tool parser middleware does not change the trust boundary — it translates text-based tool calls into the same tool execution path
