# Evaluation Prompts & Scoring Criteria

## Scenario A: Basic Tool Calling (4 points)

**Prompt:**
```
Read the file README.md in this project directory, then count the number of lines it contains using bash (wc -l), and report both the first heading found in the file and the exact line count.
```

**Tools tested:** `read`, `bash`

**Scoring:**
- (1 pt) `read` tool called successfully
- (1 pt) `bash` called with `wc -l` or equivalent
- (1 pt) First heading correctly reported from actual file content
- (1 pt) Line count matches actual `wc -l` output

---

## Scenario B: File Creation & Verification (4 points)

**Prompt:**
```
Create a Python file called hello.py that prints "Hello from OpenCode" and the current date/time. Then run it with python3 and show me the output. Finally, read the file back and confirm its contents.
```

**Tools tested:** `write`, `bash`, `read`

**Scoring:**
- (1 pt) File created via `write` tool
- (1 pt) File contains valid Python with expected output string
- (1 pt) `bash python3 hello.py` executes successfully
- (1 pt) `read` tool called to verify file contents

---

## Scenario C: Bug Fix Workflow (5 points)

**Prompt:**
```
This Spring Boot project has a JPQL injection vulnerability in HotelService.java's searchByCity method (the city parameter is concatenated directly into the query string). Fix this vulnerability by using parameterized queries. Read the file first, make the fix using edit, then read the file again to verify your fix.
```

**Tools tested:** `read`, `edit`, `read` (verification)

**Scoring:**
- (1 pt) `read` called on HotelService.java
- (1 pt) Vulnerable code correctly identified
- (2 pts) `edit` produces working parameterized query fix
- (1 pt) Verification `read` confirms the fix

---

## Scenario D: Code Review (5 points)

**Prompt:**
```
Review the last 10 commits of this project. Use git log, git diff, and read to examine the changes. Report any bugs, security issues, or design problems you find. Rank findings by severity (Critical/High/Medium/Low). Skip style issues.
```

**Target:** planetiler repository (Java, ~50K LOC)

**Tools tested:** `bash` (git log, git diff), `read`, `grep`, multi-step analysis

**Scoring:**
- (1 pt) Successfully runs git log and git diff
- (1 pt) Reads at least 2 changed source files
- (1 pt) Identifies at least 1 real issue (not a false positive)
- (1 pt) Findings are ranked by severity
- (1 pt) Analysis completes without getting stuck or looping

---

## Scenario E: Playwright E2E Test Writing (5 points)

**Prompt:**
```
Write Playwright E2E tests for https://todomvc.com/examples/react/dist/ with these test cases: 1. Add a TODO 2. Complete a TODO 3. Delete a completed TODO 4. Edit a TODO's text 5. Complete all TODOs at once 6. Active/Completed filters work. Install dependencies, write the tests, and run them.
```

**Target:** empty workspace directory

**Tools tested:** `bash` (npm install, npx playwright), `write`, multi-step workflow

**Scoring:**
- (1 pt) Dependencies installed (npm init, playwright)
- (1 pt) Test file created with all 6 test cases
- (1 pt) Tests execute without syntax errors
- (1 pt) At least 4/6 tests pass on first run
- (1 pt) All 6 tests pass (after fixes if needed)
