# Tool Parser Setup Guide

Last updated: 2026-04-14

OpenCode fork for gateways that don't support native function calling.

## When you need this

Your API gateway **strips or ignores** the `tools` parameter from OpenAI-compatible requests. Without the tool parser, OpenCode's tools (read, write, bash, etc.) won't work.

Signs you need this:
- Model responds with plain text instead of calling tools
- "No tools available" or similar errors
- Gateway documentation says "function calling is not supported"

## Quick Start

Add `toolParser` to your provider options in `opencode.json`:

```jsonc
{
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://your-gateway/v1",
        "apiKey": "your-key",
        "toolParser": "hermes-strict"  // recommended
      },
      "models": {
        "your-model": {
          "name": "Your Model",
          "limit": { "context": 200000, "output": 32768 }
        }
      }
    }
  }
}
```

Restart OpenCode after changing the config.

## Tool Parser Modes

| Mode | Format | Best for |
|------|--------|----------|
| `hermes-strict` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | **Recommended.** Strict JSON format with explicit rules in system prompt. Most reliable. |
| `hermes` | Same tag format, less strict prompting | Fallback if hermes-strict causes issues with your model |
| `xml` | Pure XML format | Models trained on XML tool calling |

**Start with `hermes-strict`.** Only switch if you encounter issues.

## Google AI (Gemini) example

You can also use toolParser with native providers like Google AI. This is useful when you want to force text-based tool calling for evaluation or compatibility testing:

```jsonc
{
  "provider": {
    "google": {
      "npm": "@ai-sdk/google",
      "options": {
        "apiKey": "your-google-api-key",
        "toolParser": "hermes-strict"
      },
      "models": {
        "gemini-3.1-pro-preview": {
          "name": "Gemini 3.1 Pro",
          "options": {
            "thinkingConfig": {
              "thinkingLevel": "medium",   // low/medium/high (minimal is NOT supported)
              "includeThoughts": false      // hide thinking from stream
            }
          },
          "limit": { "context": 1000000, "output": 65536 }
        }
      }
    }
  }
}
```

**Important:** Gemini 3.x models have mandatory thinking — it cannot be disabled. Set `includeThoughts: false` to prevent thinking tokens from appearing in the text stream. Without this, thinking text will be visible in the TUI output (but tool calling still works either way).

This only works with `@ai-sdk/google` (native SDK). The SDK separates thinking into `reasoning-delta` events, which hermes-strict ignores. OpenAI-compatible APIs (OpenRouter, etc.) mix thinking into the text stream, making hermes-strict incompatible.

## Per-model configuration

You can set `toolParser` at the provider level (applies to all models) or per-model:

```jsonc
{
  "provider": {
    "my-gateway": {
      "options": {
        "toolParser": "hermes-strict"  // default for all models
      },
      "models": {
        "strong-model": {
          "name": "Strong Model"
          // inherits hermes-strict from provider
        },
        "native-fc-model": {
          "name": "Native FC Model",
          "options": {
            "toolParser": false  // disable for this model (uses native FC)
          }
        }
      }
    }
  }
}
```

## Model Compatibility

**Not all models work with hermes-strict.** The tool parser requires the model to generate valid `<tool_call>` JSON within its text output, which is harder than native function calling.

Tested models (as of 2026-04-14, via OpenRouter multi-provider evaluation):

| Model | Company | Reliability | Notes |
|-------|---------|------------|-------|
| Claude Opus 4.6 | Anthropic | **Stable** | 22/23. Best overall. Deep code review (31 steps), Playwright 6/6 |
| Claude Sonnet 4.5 | Anthropic | **Stable** | Best instruction following. Recommended for complex workflows |
| GPT-5.4 | OpenAI | **Stable** | Requires provider base prompt for grounding. Deep analysis |
| Mistral Large 3 | Mistral | **Stable** | 22/23. Clean bug fixes, thorough code review (5 issues) |
| Gemma 4 31B | Google | **Stable** | 21/23. Remarkable for 31B. A-C perfect, D shallow but valid |
| GPT-5.1 | OpenAI | Borderline | Works for simple tasks, degrades on multi-step workflows |
| Qwen3.6 Plus | Alibaba | Borderline | 14/23. A-C solid, E (Playwright) failed, D loops |
| Cohere Command A | Cohere | Borderline | 7/23. Basic tools work, edit corrupts files, E failed |
| DeepSeek V3.2 | DeepSeek | **Not usable** | Responds with natural language instead of `<tool_call>` tags |
| Llama 4 Scout | Meta | **Not usable** | Generates `<tool_calls>` (plural) instead of `<tool_call>` (singular) |
| Gemini 3.1 Pro | Google | **Stable** (native SDK only) | Requires `@ai-sdk/google` + `includeThoughts: false`. Incompatible via OpenRouter/OpenAI-compatible |
| Mistral Medium | Mistral | **Not usable** | Output control breaks down (infinite loops, template token leakage) |
| GLM-5 Turbo | ZhipuAI | **Not usable** | Cannot generate `<tool_call>` syntax despite strong native FC support |
| GLM-5.1 | ZhipuAI | **Not usable** | Mandatory thinking. Reasons about tools but emits no `<tool_call>` tags (z.ai direct, 2026-04-15) |

**Key finding:** hermes-strict success depends on **instruction following precision**, not model size. Gemma 4 (31B) outperforms DeepSeek V3.2 (671B MoE).

**Recommendation:** Validate your model on a representative multi-step workflow before relying on it. Passing simple tool calls does not guarantee reliability on longer runs.

## How it works

1. Tool definitions are injected into the **system prompt** as text (instead of the `tools` API parameter)
2. The `tools` parameter is **removed** from the API request
3. The model generates `<tool_call>` tags in its text output
4. The parser detects these tags, extracts the JSON, and converts them to standard AI SDK tool-call events
5. Tool results are sent back as `<tool_response>` text in the `user` role (not the structured `tool` role)

This means the model sees everything as text — there's no structured channel for tool calls or results.

Additionally, when toolParser is active:
- `apply_patch` is removed from the available tools (replaced by `edit`/`write`/`line_edit`)
- System prompt references to `apply_patch` (in `gpt.txt`, `codex.txt`) are rewritten to recommend "available file editing tools" instead
- This prevents models from attempting to call `apply_patch` via bash when they don't see it in the tool list

## Troubleshooting

### Tools not being called

1. Check `toolParser` is set in your config:
   ```bash
   grep -i toolparser opencode.json
   ```
2. Restart OpenCode after config changes
3. Check logs for errors:
   ```bash
   tail -f ~/.local/share/opencode/log/*.log | grep -i "tool\|error"
   ```

### Model generates broken JSON in tool calls

- Switch from `hermes` to `hermes-strict` (stricter prompting)
- Try a more capable model
- Check if the gateway modifies the response stream (some gateways truncate long responses)

### Tags like `<tool_call>` or `<tool_response>` appear in the output

This is a tag leakage issue. Common causes:
- Gateway returning 500 errors mid-stream
- Model generating text that looks like tool tags

OpenCode includes a tag filter that removes these, but edge cases may occur. Check logs:
```bash
tail -f ~/.local/share/opencode/log/*.log | grep "tag-leak"
```

### Model ignores tool results and generates fake data

The model may not distinguish `<tool_response>` text from its own output. This is more likely with:
- Custom agent prompts that replace the default system prompt
- Longer system prompts that dilute tool-usage instructions
- Models at the edge of hermes-strict compatibility

Mitigations:
- Ensure the provider base prompt is not completely replaced by agent prompts
- Use a more capable model
- Simplify the system prompt

## Patches

This fork includes a patch for `@ai-sdk-tool/parser` that fixes literal control character handling in JSON strings. The patch is automatically applied by `bun install`:

```
patches/@ai-sdk-tool%2Fparser@2.1.7.patch
```

If tools break after reinstalling dependencies, verify the patch is applied:
```bash
grep "normalizeJsonStringCtrl" node_modules/@ai-sdk-tool/parser/dist/*.js
```
