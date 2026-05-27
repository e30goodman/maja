# Parent Mode Investigation (2026-04-25)

## Scope

Investigated 3 reported issues in `parent-mode`:

1. `CRITICAL: False Jati Mapping Detected` while grid looks correct.
2. Final-tail `tihai` onset degraded into rest-heavy bar (`[Ta,-,-,-]`).
3. `Thom` appearing outside strict terminal placement.


## What was executed

- Ran focused ledger scans for fixed seeds and random seeds.
- Ran matrix scans across:
  - `motifPulseLen`: `4/5/7/9`
  - `chaosLevel`: `15/35/70`
  - `progressiveDensityMode`: `gati_mode/jati_mode`
- Ran full regression suite:
  - `npx tsx src/parentMode.test.ts`
- Performed targeted micro-reproductions for `free` path and dead-zone cleanup.


## Findings

### 1) False Jati Mapping (`CRITICAL`)

Status: **not reproduced in current code**.

- In matrix scan (200 seeds per config, multiple configs), no `False Jati Mapping` was produced.
- In fixed + random tail-ledger scan (24 seeds), no critical found.
- Regression tests pass, including truth-gate tests for mode detection.

Relevant truth gate:
- `src/lessonLogger.ts` -> `evaluateModeTruth(...)`
- `src/lessonLogger.ts` -> `intentionLabel(...)` (modeTag/localJati gating)
- `src/lessonLogger.ts` -> `buildBarLogForParentRow(...)` (bridge modeTag normalization)

Interpretation:
- Current branch appears to already include anti-false-jati guards.
- If user still sees this critical in UI, likely from a different runtime path/config/state, stale build, or external snapshot scenario not covered by current reproduction profile.


### 2) Tihai onset integrity (`[Ta,-,-,-]` at onset)

Status: **not reproduced in current code**.

- Tail onset scan over 14,400 runs (`1200 seeds * 4 motif lens * 3 chaos`) showed:
  - `badOnset = 0`
  - `nonGapAfterPrep = 0`
- Reported seeds `0x8cdc900a` and `0x6f7aec77` (with `motifPulseLen=5`) produce full-phrase onset; bar 28 is not degraded.

Relevant paths:
- `src/parentMode.ts`:
  - `buildPhraseSchedule(...)` tail logic and `collapseGapAfterPrep`
  - `tihaiOperator(...)` contract for `phraseStep===0` as full phrase (no hidden karvai)

Interpretation:
- Current branch likely already fixed the historical bar-28 degradation.


### 3) Thom leakage / non-terminal Thom

Status: **partially reproduced; two concrete issues**.

#### 3.1 Confirmed: `free` route bypasses Thom scrub

Minimal reproduction:
- Pre-set `customCellSyllables['0-1'] = 'Thom'`.
- Run `applyParentModeBar(...)` with role type `free`.
- Result: `Thom` persists (scrub is skipped due early return in free branch).

Root location:
- `src/parentMode.ts` -> `applyParentModeBar(...)`:
  - `role.type === 'free'` delegates to `applyRandomizerEffectsToBar(...)` and returns before `scrubInternalThom(...)`.

#### 3.2 Confirmed: dead-zone cleanup does not remove stale cell overrides

Minimal reproduction:
- Pre-set `customCellSyllables['0-3'] = 'Thom'`.
- Run `applyRandomizerEffectsToBar(...)` with `randomBarSpeed=true`, high chaos.
- Get `deadStart=1`; stale `Thom` at dead cell remains.

Root location:
- `src/randomLogic.ts` -> `applyRandomizerEffectsToBar(...)`:
  - dead-zone pruning removes accents/subdivisions, but not `customCellSyllables`.

#### 3.3 Important behavior (likely perceived as bug): non-terminal final Thom is frequent

- In 2,000-seed scan, final bar contained non-terminal `Thom` in **1367/2000** cases, examples:
  - `[Ta, Thom, -, -]`
  - `[Ta, Ta, Thom, -]`
- This is driven by strict landing index logic (`tihaiLandingIndex`) and is currently expected by implementation.

Relevant paths:
- `src/parentMode.ts`:
  - `computeStrictTihaiPlan(...)` sets landing index.
  - `tihaiOperator(...)` applies `Thom` at landing and fills trailing cells with karvai.

Interpretation:
- If product requirement is “Thom must always be the last sounding and visually terminal”, this is a spec mismatch against current strict-landing implementation.


## Visual vs Audio split (dead-zone)

- Audio path correctly suppresses dead cells:
  - `src/App.tsx` -> `scheduleGridCellAtTime(...)` checks `deadCut` before emit.
- Visual label path can still show override in dead cells:
  - `src/sequencerLabels.ts` -> `buildRowCellSyllableLabels(...)` keeps dead-cell override as visible token.

Implication:
- User can see stale `Thom` in dead area while not hearing it, creating “dirty phonetics” perception.


## Prioritized fix strategy (proposal)

1. **Sanitize `Thom` in `free` route**  
   Ensure `free` path runs the same Thom sanitation policy as mutation path.

2. **Dead-zone override pruning**  
   In `applyRandomizerEffectsToBar(...)`, when dead-cut changes, purge `customCellSyllables` for dead cells.

3. **Decide canonical final Thom policy**  
   If requirement is strict terminal seal:
   - force final `tihai` landing to last sounding cell, or
   - keep strict sam alignment but prevent visual interpretation as “mid-bar Thom with tail void”.


## Regression tests to add (after fix approval)

1. `free` role does not preserve pre-existing `Thom` outside allowed final landing.
2. dead-cut operation removes stale `customCellSyllables` from dead tail.
3. If terminal-seal policy is adopted:
   - final bar Thom index is terminal sounding position.
4. Keep existing guards:
   - no bar-28 onset degradation,
   - no false-jati critical for valid progressive scenarios.


## Final triage result

- `False Jati Mapping`: **not reproduced** on current code path.
- `Tihai onset collapse`: **not reproduced** on current code path.
- `Thom issue`: **reproduced** via `free`-path scrub bypass and dead-zone stale override retention; plus high-frequency non-terminal final Thom behavior that likely conflicts with desired canon.
