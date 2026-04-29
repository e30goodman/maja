# HANDBOOK: AI Deep Audit Protocol

## Purpose
Break the AI Fix-Fail Loop when the agent starts hallucinating fixes.

## Red Flags (STOP CODING IMMEDIATELY)
- Index 0 Paradox: Cell 0 works, but 1+ fails (or vice versa).
- Fix-Fail Loop: 2+ failed attempts to fix `useMemo`, `useEffect`, or cache logic.
- Watchdog Smells: suggestions to add `setTimeout`, watchdogs, or "safety" refs to force renders.

## Differential Auditor Algorithm

### 1) Hypothesis Generation
Generate exactly 3 distinct theories:
1. Data Path: upstream generator provides corrupted or offset data.
2. State Sync: race condition between Ref and State.
3. Event Competition: gesture conflict (Tap vs Hold).

### 2) Verification Gate
Before touching code, agent MUST ask 10 clarifying questions about raw logic flow:
- Where data is created.
- How data is transformed.
- Where data is cached.
- Which events mutate state.
- Which events read state.
- What happens per index (`0` vs `1+`).
- Which function is source of truth.
- Where side effects happen.
- What happens during rapid input.
- Which invariant is expected in DOM and in logs.

### 3) Non-Negotiable Mantra
"Treat the disease, not the symptom."

Stop patching `React.memo`; check Atomic Integrity of data source first.
