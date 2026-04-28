# UI Debugging Confession + Distilled Protocol

## Confession: What Went Wrong
Short: got stuck tuning symptoms iteratively instead of localizing geometry source early.

- Started tweaking `BAR/CELLS` too early while bug lived higher in hierarchy (scroll container and right-side geometry).
- Broke one-measurement-per-step principle: changed offsets, absolute positioning, padding, and layers in same iteration.
- Enabled measurable debugging too late (borders/container comparison should be step zero).
- Sometimes optimized for "looks right" instead of preserving native flow/layout correctness.
- Did not always enforce user constraints as hard invariants (`CELLS` untouched, no hacks).
- Broke build with malformed JSX comment sequence (discipline failure during editing).

## Distilled Protocol (Use Every UI Task)
1. Write invariants first (non-negotiable):
   - Keep protected internals unchanged (example: `CELLS` `flex-1` / `self-stretch`).
   - Ban `translate`, positional magic offsets, fake extension layers.
2. Localize geometry top-down:
   - Reference/root width vs parent container width.
   - Parent `padding` / `margin` / `overflow`.
   - Only then inspect inner rows/cells.
3. Run one-variable experiments only:
   - One change, one observation, one conclusion.
4. Use Traffic Light borders at beginning:
   - Red (root), Green (parent), Yellow (target), Blue (children).
5. Fix in native flow only:
   - Use `w-full`, container sizing, margin/padding corrections.
   - Avoid absolute overlays for structural alignment fixes.
6. Measure after every step:
   - Record which border edge aligned or did not align.
   - Reject "seems better" without geometric evidence.
7. Keep edit safety discipline:
   - Avoid JSX comment patterns that can terminate comments unexpectedly.

## Quick 20-Second UI Gate
Before touching CSS:

- Did I define invariants?
- Did I localize top-down?
- Am I changing one variable only?
- Do I have border-based proof from screenshot?
- Is fix native flow (not visual hack)?
