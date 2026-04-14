#!/bin/bash
# Multi-provider evaluation for opencode-ai-nofc
# Runs 3 scenarios across 7 models via OpenRouter with hermes-strict tool parser.
#
# Prerequisites:
#   export OPENROUTER_API_KEY="sk-or-..."
#   bun install (in the opencode-nofc repo root)
#
# Usage:
#   bash evals/run-all.sh
#
# Outputs:
#   evals/results/<model_slug>/scenario-{a,b,c}.txt  — raw output
#   evals/results/<model_slug>/metrics.json           — time, exit code per scenario

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
WORKSPACE="/tmp/opencode-eval-workspace"

# Models to evaluate
# Google AI Studio (requires GOOGLE_GENERATIVE_AI_API_KEY)
# OpenRouter (requires OPENROUTER_API_KEY)
MODELS=(
  "google/gemini-3.1-pro-preview"
  "openrouter/google/gemma-4-31b-it"
  "openrouter/meta-llama/llama-4-scout"
  "openrouter/mistralai/mistral-large-2512"
  "openrouter/qwen/qwen3.6-plus"
  "openrouter/deepseek/deepseek-v3.2"
  "openrouter/cohere/command-a-03-2025"
  "openrouter/anthropic/claude-opus-4-6"
)

MAX_RETRIES=3

# Prompts
PROMPT_A='Read the file README.md in this project directory, then count the number of lines it contains using bash (wc -l), and report both the first heading found in the file and the exact line count.'

PROMPT_B='Create a Python file called hello.py that prints "Hello from OpenCode" and the current date/time. Then run it with python3 and show me the output. Finally, read the file back and confirm its contents.'

PROMPT_C='This Spring Boot project has a JPQL injection vulnerability in HotelService.java'\''s searchByCity method (the city parameter is concatenated directly into the query string). Fix this vulnerability by using parameterized queries. Read the file first, make the fix using edit, then read the file again to verify your fix.'

PROMPT_D='Review the last 10 commits of this project. Use git log, git diff, and read to examine the changes. Report any bugs, security issues, or design problems you find. Rank findings by severity (Critical/High/Medium/Low). Skip style issues.'

PROMPT_E='Write Playwright E2E tests for https://todomvc.com/examples/react/dist/ with these test cases: 1. Add a TODO 2. Complete a TODO 3. Delete a completed TODO 4. Edit a TODO'\''s text 5. Complete all TODOs at once 6. Active/Completed filters work. Install dependencies, write the tests, and run them.'

PLANETILER_DIR="${PLANETILER_DIR:-$HOME/projects/planetiler}"
PLAYWRIGHT_DIR="/tmp/playwright-eval-workspace"

# Check API keys
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "Warning: OPENROUTER_API_KEY is not set — OpenRouter models will fail"
fi
if [ -z "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ]; then
  echo "Warning: GOOGLE_GENERATIVE_AI_API_KEY is not set — Google models will fail"
fi

# Prepare workspace for Scenarios A & B
mkdir -p "$WORKSPACE"
cp "$SCRIPT_DIR/opencode.json" "$WORKSPACE/opencode.json"
cat > "$WORKSPACE/README.md" << 'READMEEOF'
# OpenCode Evaluation Project

This is a test workspace for evaluating tool parser compatibility
across multiple LLM providers via OpenRouter.

## Purpose

Demonstrate that opencode-ai-nofc works as a generic,
provider-agnostic tool for enabling tool calling on any
OpenAI-compatible API endpoint.

## Models Tested

- Google Gemini
- Google Gemma
- Meta Llama
- Mistral
- Qwen
- DeepSeek
- Cohere
READMEEOF

run_opencode() {
  local model="$1"
  local dir="$2"
  local prompt="$3"

  cd "$REPO_ROOT"
  bun run --cwd "$REPO_ROOT/packages/opencode" \
    --conditions=browser src/index.ts \
    run \
    -m "$model" \
    --dir "$dir" \
    --dangerously-skip-permissions \
    "$prompt" \
    2>&1 | sed 's/\x1b\[[0-9;]*m//g'
}

# Count tool calls in output (lines starting with → or $)
count_steps() {
  grep -cE '^(→ |\\$ )' "$1" 2>/dev/null || echo 0
}

# Run a scenario with retries (hermes drop can cause intermittent failures)
run_scenario() {
  local model="$1"
  local dir="$2"
  local prompt="$3"
  local outfile="$4"
  local attempt=1
  local rc=1

  while [ $attempt -le $MAX_RETRIES ]; do
    if run_opencode "$model" "$dir" "$prompt" > "$outfile" 2>&1; then
      rc=0
    else
      rc=$?
    fi
    local steps
    steps=$(count_steps "$outfile")
    # Success if exit 0 and at least 1 tool call detected
    if [ $rc -eq 0 ] && [ "$steps" -gt 0 ]; then
      break
    fi
    if [ $attempt -lt $MAX_RETRIES ]; then
      echo "    Retry $((attempt+1))/$MAX_RETRIES (exit=$rc, steps=$steps)..."
    fi
    attempt=$((attempt + 1))
  done
  return $rc
}

echo "=== OpenCode Multi-Provider Evaluation ==="
echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "Models: ${#MODELS[@]}"
echo ""

for model in "${MODELS[@]}"; do
  slug=$(echo "$model" | tr '/' '_')
  mkdir -p "$RESULTS_DIR/$slug"

  echo "--- $model ---"

  # Initialize metrics
  metrics="{\"model\": \"$model\", \"date\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\""

  # Scenario A
  echo "  Scenario A: Basic Tool Calling..."
  start_a=$(date +%s)
  if run_scenario "$model" "$WORKSPACE" "$PROMPT_A" "$RESULTS_DIR/$slug/scenario-a.txt"; then
    exit_a=0
  else
    exit_a=$?
  fi
  elapsed_a=$(( $(date +%s) - start_a ))
  steps_a=$(count_steps "$RESULTS_DIR/$slug/scenario-a.txt")
  echo "  Scenario A: ${elapsed_a}s, ${steps_a} steps, exit ${exit_a}"
  metrics="$metrics, \"scenario_a\": {\"time_s\": $elapsed_a, \"steps\": $steps_a, \"exit\": $exit_a}"

  # Scenario B
  echo "  Scenario B: File Creation..."
  rm -f "$WORKSPACE/hello.py"
  start_b=$(date +%s)
  if run_scenario "$model" "$WORKSPACE" "$PROMPT_B" "$RESULTS_DIR/$slug/scenario-b.txt"; then
    exit_b=0
  else
    exit_b=$?
  fi
  elapsed_b=$(( $(date +%s) - start_b ))
  steps_b=$(count_steps "$RESULTS_DIR/$slug/scenario-b.txt")
  echo "  Scenario B: ${elapsed_b}s, ${steps_b} steps, exit ${exit_b}"
  metrics="$metrics, \"scenario_b\": {\"time_s\": $elapsed_b, \"steps\": $steps_b, \"exit\": $exit_b}"

  # Scenario C
  echo "  Scenario C: Bug Fix..."
  BUGGY_DIR="/tmp/spring-boot-rest-example-buggy"
  rm -rf "$BUGGY_DIR"
  if [ -f "$REPO_ROOT/tests/code-review/spring-boot-rest-example-buggy.zip" ]; then
    unzip -q "$REPO_ROOT/tests/code-review/spring-boot-rest-example-buggy.zip" -d /tmp
    cp "$SCRIPT_DIR/opencode.json" "$BUGGY_DIR/opencode.json"
    start_c=$(date +%s)
    if run_scenario "$model" "$BUGGY_DIR" "$PROMPT_C" "$RESULTS_DIR/$slug/scenario-c.txt"; then
      exit_c=0
    else
      exit_c=$?
    fi
    elapsed_c=$(( $(date +%s) - start_c ))
    steps_c=$(count_steps "$RESULTS_DIR/$slug/scenario-c.txt")
    echo "  Scenario C: ${elapsed_c}s, ${steps_c} steps, exit ${exit_c}"
    metrics="$metrics, \"scenario_c\": {\"time_s\": $elapsed_c, \"steps\": $steps_c, \"exit\": $exit_c}"
  else
    echo "  Scenario C: Skipped (test project not found)"
    metrics="$metrics, \"scenario_c\": {\"skipped\": true}"
  fi

  # Scenario D: Code Review (planetiler)
  if [ -d "$PLANETILER_DIR/.git" ]; then
    echo "  Scenario D: Code Review..."
    cp "$SCRIPT_DIR/opencode.json" "$PLANETILER_DIR/opencode.json"
    start_d=$(date +%s)
    if run_scenario "$model" "$PLANETILER_DIR" "$PROMPT_D" "$RESULTS_DIR/$slug/scenario-d.txt"; then
      exit_d=0
    else
      exit_d=$?
    fi
    elapsed_d=$(( $(date +%s) - start_d ))
    steps_d=$(count_steps "$RESULTS_DIR/$slug/scenario-d.txt")
    echo "  Scenario D: ${elapsed_d}s, ${steps_d} steps, exit ${exit_d}"
    metrics="$metrics, \"scenario_d\": {\"time_s\": $elapsed_d, \"steps\": $steps_d, \"exit\": $exit_d}"
    rm -f "$PLANETILER_DIR/opencode.json"
  else
    echo "  Scenario D: Skipped (planetiler not found at $PLANETILER_DIR)"
    metrics="$metrics, \"scenario_d\": {\"skipped\": true}"
  fi

  # Scenario E: Playwright E2E
  echo "  Scenario E: Playwright E2E..."
  rm -rf "$PLAYWRIGHT_DIR"
  mkdir -p "$PLAYWRIGHT_DIR"
  cp "$SCRIPT_DIR/opencode.json" "$PLAYWRIGHT_DIR/opencode.json"
  start_e=$(date +%s)
  if run_scenario "$model" "$PLAYWRIGHT_DIR" "$PROMPT_E" "$RESULTS_DIR/$slug/scenario-e.txt"; then
    exit_e=0
  else
    exit_e=$?
  fi
  elapsed_e=$(( $(date +%s) - start_e ))
  steps_e=$(count_steps "$RESULTS_DIR/$slug/scenario-e.txt")
  echo "  Scenario E: ${elapsed_e}s, ${steps_e} steps, exit ${exit_e}"
  metrics="$metrics, \"scenario_e\": {\"time_s\": $elapsed_e, \"steps\": $steps_e, \"exit\": $exit_e}"

  metrics="$metrics}"
  echo "$metrics" > "$RESULTS_DIR/$slug/metrics.json"

  echo ""
done

echo "=== Evaluation Complete ==="
echo "Results saved to: $RESULTS_DIR"
echo ""
echo "=== Summary ==="
for model in "${MODELS[@]}"; do
  slug=$(echo "$model" | tr '/' '_')
  if [ -f "$RESULTS_DIR/$slug/metrics.json" ]; then
    echo "$model:"
    cat "$RESULTS_DIR/$slug/metrics.json"
  fi
done
