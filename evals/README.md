# Multi-Provider Evaluation

Evaluation of opencode-ai-nofc's tool parser middleware across multiple LLM providers via OpenRouter, demonstrating provider-agnostic compatibility.

## Overview

opencode-ai-nofc integrates `@ai-sdk-tool/parser` middleware to enable tool calling on API endpoints that don't support native function calling. This evaluation tests that the tool parser works with models from diverse providers — not just one specific endpoint.

## Models Tested

| Model | Provider | Architecture |
|-------|----------|-------------|
| Gemini 3.1 Pro | Google (direct API) | Long context, multimodal, flagship |
| Gemma 4 31B | Google (open) | Open-weight, 256K context |
| Llama 4 Scout | Meta | Open-weight |
| Mistral Large 3 | Mistral | European provider, 675B MoE flagship |
| Qwen3.6 Plus | Alibaba | Latest flagship |
| DeepSeek V3.2 | DeepSeek | Latest flagship |
| Command A | Cohere | 111B, agentic focus |
| Claude Opus 4.6 | Anthropic | Flagship, native FC capable |

## Scenarios

1. **Basic Tool Calling** — `read` + `bash` with result verification
2. **File Creation & Verification** — `write` + `bash` + `read` pipeline
3. **Bug Fix Workflow** — `read` → `edit` → `read` on a real codebase

See [prompts.md](prompts.md) for detailed prompts and scoring criteria.

## Running

```bash
export OPENROUTER_API_KEY="sk-or-..."
bash evals/run-all.sh
```

## Results

See [SUMMARY.md](SUMMARY.md) for the scoring matrix and per-model notes.
Raw outputs are in `results/` subdirectories.
