# OpenCode-nofc Multi-Provider Evaluation Results

Date: 2026-04-14
OpenCode version: 1.4.3
Tool parser mode: hermes-strict
Infrastructure: OpenRouter API + Google AI Studio (direct)

## Scoring Matrix

| Model | Company | A (/4) | B (/4) | C (/5) | D (/5) | E (/5) | Total (/23) | Status |
|-------|---------|--------|--------|--------|--------|--------|-------------|--------|
| claude-opus-4.6 | Anthropic | 4 | 4 | 4 | 5 | 5 | **22** | Pass |
| mistral-large-3 | Mistral | 4 | 4 | 5 | 5 | 4 | **22** | Pass |
| gemma-4-31b | Google (open) | 4 | 4 | 5 | 4 | 4 | **21** | Pass |
| qwen3.6-plus | Alibaba | 4 | 2 | 4 | 3 | 1 | **14** | Partial |
| command-a | Cohere | 2 | 2 | 1 | 2 | 0 | **7** | Partial |
| deepseek-v3.2 | DeepSeek | 0 | 0* | 0 | — | — | **0** | Fail |
| llama-4-scout | Meta | 0 | 0 | 0 | — | — | **0** | Fail |
| gemini-3.1-pro | Google (direct) | — | — | — | — | — | — | Incompatible |

\* DeepSeek V3.2 succeeded on Scenario B after 2 retries but failed all others.

## Scenarios

| ID | Task | Difficulty | Tools Tested |
|----|------|-----------|-------------|
| A | Basic tool calling (read + bash) | Low | read, bash |
| B | File creation & verification | Medium | write, bash, read |
| C | Bug fix workflow (JPQL injection) | Medium | read, edit, read |
| D | Code review (planetiler, 10 commits) | High | bash (git), read, grep |
| E | Playwright E2E test writing | High | bash (npm), write, bash |

## Status Definitions

- **Pass**: Total >= 18/23. Model handles all scenario types reliably.
- **Partial**: Total 5-17/23. Basic tool calling works but complex scenarios fail.
- **Fail**: Total < 5/23. Tool parser does not work with this model.
- **Incompatible**: Model architecture conflicts with hermes-strict (e.g. mandatory thinking).

## Per-Model Notes

### Claude Opus 4.6 (22/23) — Pass
- Strongest overall. D produced 10 findings (2 Critical, 3 High) in 31 steps / 19 min.
- E achieved 6/6 Playwright tests passing after 1 fix iteration.
- hermes-strict introduces no quality degradation vs native function calling.

### Mistral Large 3 (22/23) — Pass
- Perfect on A-D. C produced a clean parameterized query fix.
- D found 5 real issues with proper severity ranking (3 High, 2 Medium).
- E required iteration (25 steps) but ultimately completed.

### Gemma 4 31B (21/23) — Pass
- Remarkable for a 31B model. Perfect on A-C.
- D was shallow (2 steps, 18s) but identified 3 valid issues.
- E completed but 1/6 Playwright tests (edit TODO) consistently times out.

### Qwen3.6 Plus (14/23) — Partial
- A-C solid. Fast execution (7s for A, 20s for C).
- D found 11 issues but analysis showed looping tendency.
- E failed — Playwright setup incomplete, tests did not run successfully.

### Cohere Command A (7/23) — Partial
- A partially failed (incorrect heading extraction).
- C corrupted the target file during edit attempts.
- E completely failed — interactive npm prompts not supported.
- B and D partially successful.

### DeepSeek V3.2 (0/23) — Fail
- Does not generate `<tool_call>` tags. Responds with natural language instead.
- B succeeded on retry 2/3, suggesting intermittent compliance.
- Root cause: instruction following insufficient for hermes-strict format.

### Llama 4 Scout (0/23) — Fail
- Generates `<tool_calls>` (plural) instead of `<tool_call>` (singular).
- Hermes-strict system prompt specifies singular form; model ignores this.
- 6 retry attempts, all identical failure. Root cause: instruction following.

### Gemini 3.1 Pro — Incompatible
- Mandatory thinking mode consumes all output tokens before generating tool calls.
- Thinking chain loops indefinitely on complex tasks (code review).
- Simple tasks may work with manual "continue" intervention.
- Incompatible with hermes-strict architecture, not a model quality issue.

## Evaluation Axes

| Axis | What it measures | How |
|------|-----------------|-----|
| **Functionality** | Can the model generate valid tool calls via hermes-strict? | Per-criterion scoring (23 points total) |
| **Time** | End-to-end wall clock time per scenario | Measured by run-all.sh (seconds) |
| **Steps** | Number of tool invocations per scenario | Counted from output |
| **Quality** | Is the output correct and the fix valid? | Manual review of raw output |

## Performance Summary

| Model | A time | B time | C time | D time / steps | E time / steps |
|-------|--------|--------|--------|----------------|----------------|
| claude-opus-4.6 | 10s | 55s | 42s | 1136s / 31 | 238s / 11 |
| mistral-large-3 | 7s | 53s | 17s | 36s / 8 | 958s / 25 |
| gemma-4-31b | 35s | 137s | 103s | 18s / 2 | 819s / 6 |
| qwen3.6-plus | 7s | 61s | 20s | 52s / 12 | 209s / 7 |
| command-a | 10s | 57s | 140s | 18s / 1 | 116s / 11 |

## Methodology

- OpenRouter models tested with `toolParser: "hermes-strict"` at provider level
- Gemini tested via Google AI Studio direct API (thinking model incompatibility discovered)
- 8 models from 7 companies, latest/flagship versions
- 5 scenarios covering basic tool calling through complex agentic tasks
- Up to 3 retries per scenario for failed models
- Raw outputs preserved in `results/` subdirectories
- Scoring criteria defined in [prompts.md](prompts.md)

## Reproducing These Results

1. Clone this repository
2. Install dependencies: `bun install`
3. Build: `cd packages/opencode && bun run build`
4. Set `OPENROUTER_API_KEY` environment variable
5. (Optional) Set `GOOGLE_GENERATIVE_AI_API_KEY` for Gemini
6. Run: `bash evals/run-all.sh`

Note: Results may vary between runs due to model non-determinism.
