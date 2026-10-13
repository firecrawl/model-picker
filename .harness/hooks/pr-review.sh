#!/usr/bin/env bash
[[ $(jq -r '.tool_input.command // empty') =~ gh[[:space:]]+pr[[:space:]]+create ]] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || true
plan=""
for f in PLAN.md plan.md docs/PLAN.md docs/plan.md; do [[ -f $f ]] && { plan=$f; break; }; done

cat >&2 <<'MSG'
PR created. Before merging, review it in fresh contexts, then fix what holds up.

1. Review the PR. Split the diff between reviewers, at least one on a different model:
   - codex review --base main
   - grok -p "Review this branch's diff against main. Findings only, with file:line."
   - a Claude subagent, also when a CLI isn't signed in or refuses its model
   Ask each for, with file:line and a concrete fix:
   - bugs: wrong results, crashes, leaks, races, unhandled errors, processes left running
   - repeated code that should be one helper, hook or shared component
   - if/else or switch chains that would be simpler as a data structure (lookup table, map, config array)
   - modularity: what should be easy to change in one place (shared components, style tokens, constants), and the project's own rules in CLAUDE.md
   - styles: repeated class strings, hard-coded colours and sizes that should be tokens, unused tokens
   - performance: work on hot paths, sync IO on the main thread, needless re-renders and allocations
   Check every finding against the code before acting on it and drop what doesn't hold. Fix the confirmed ones, quickest first, tests passing after each.
MSG

if [[ -n $plan ]]; then
  cat >&2 <<MSG

2. Review $plan against what this PR built and the code as it is now: facts that went stale, things it promises that were never built, phases without a gate or status, sections that have grown into history. Fix the plainly factual ones; ask the user about the rest.
MSG
fi
exit 2
