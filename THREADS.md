# Threads

Threads let WebPilot keep user-facing continuity across related browser tasks without injecting full internal logs into every prompt.

## What A Thread Stores

- thread id
- title
- run ids
- user goals
- final results
- compact context text for follow-up tasks

## What A Thread Should Not Store

- provider API keys
- browser cookies
- raw DOM dumps
- large internal logs
- private profile paths beyond what is needed in run metadata

## Runtime Flow

1. A task starts with an optional `threadId`.
2. `ensureThread` creates or loads the thread.
3. `buildThreadContext` creates compact prior context.
4. The planner receives that context as background only.
5. On run completion, the thread gets the run status, user goal, and final result.

## Design Constraints

Thread context should help interpret follow-up instructions, but live browser state remains the source of truth. If a prior answer conflicts with the current page, the agent should prefer current page evidence.

## Storage

Thread data is stored locally under `agent_threads/` or the packaged app user-data directory.
