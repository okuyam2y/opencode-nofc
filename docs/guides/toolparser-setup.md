# Tool Parser Setup Guide

最終更新: 2026-04-07

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
          "limit": { "context": 1000000, "output": 65536 }
        }
      }
    }
  }
}
```

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

Tested models (as of 2026-04):

| Model | Reliability | Notes |
|-------|------------|-------|
| Claude Sonnet 4.5 | Stable | Best instruction following. Recommended for complex workflows |
| GPT-5.4 | Stable | Requires provider base prompt for grounding. Deep analysis capability |
| Gemini 3.1 Pro Preview | Stable | Model ID: `gemini-3.1-pro-preview`. Verified with code review tasks. Long thinking, deep analysis. Cost-effective |
| GPT-5.1 | Borderline | Works for simple tasks, degrades on multi-step workflows |
| Mistral Medium | Not usable | Output control breaks down (infinite loops, template token leakage) |
| GLM-5 Turbo | Not usable | Cannot generate `<tool_call>` syntax despite strong native FC support |

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
