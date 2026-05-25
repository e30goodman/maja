# UI Debugging Confession + Distilled Protocol

## Confession: What Went Wrong
Short: iterative symptom tuning started before geometry source was localized.

- Tweaked inner `BAR/CELLS` too early while issue lived higher (scroll container/right geometry).
- Changed multiple variables in one step (offset/absolute/padding/layers), producing noise.
- Started measurable debugging too late (borders should be step zero).
- Optimized for visual appearance instead of native flow correctness.
- Failed to enforce hard constraints immediately (`CELLS` untouched, no hacks).
- Broke build via malformed JSX comment sequence.

## Distilled Protocol (Use on Every UI Task)
1. Write invariants first:
   - Protected internals stay unchanged (example: `CELLS` `flex-1` / `self-stretch`).
   - Ban `translate`, negative positional hacks, fake layers.
2. Diagnose top-down:
   - Header/root width vs grid/parent width.
   - Parent `padding` / `margin` / `overflow`.
   - Only then inspect row/cell internals.
3. One parameter per experiment:
   - One change, one screenshot, one conclusion.
4. Apply Traffic Light borders immediately:
   - Red (root), Green (parent), Yellow (target), Blue (children).
5. Fix only in native flow:
   - Prefer `w-full`, container sizing, margin/padding corrections.
   - Do not use absolute overlays for structural alignment.
6. Measure after each step:
   - Record which border edges align or fail.
   - Reject "looks better" without geometry evidence.
7. Keep edit safety:
   - Avoid JSX comment text that can terminate comment blocks unexpectedly.

## Quick UI Gate (20 sec)
Before changing CSS:

- Invariants written?
- Top-down localization done?
- One-variable experiment planned?
- Border-based screenshot evidence available?
- Fix stays in native flow (no hacks)?
