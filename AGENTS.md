# Agent Operating Rules (Canonical)

This file is the single source of truth for agent startup and review flow rules in this repository.

## Mandatory Startup

- At the beginning of a new session, call `initial_instructions` first.
- Before starting any review flow, call `initial_instructions` again and use the review scenario guide.

## Mandatory Review Order

For code review tasks, use this order unless explicitly blocked:

1. `initial_instructions`
2. `activate_project` with `mode=review`
3. `search_knowledge` with `preset=review_context`
4. `review_task`
5. `record_task_note` for reusable findings (when applicable)

## Guardrail

- Do not run `review_task` before `initial_instructions`.
- If the flow is out of sync, run `doctor` and resume from the recommended next call.
