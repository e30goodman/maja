# 🥁 Ta Logic Guide (`konnakol_trainer_stable`)

**Status:** Source of Truth for Ta / Accents / Audio / UI  
**Critical Rule:** Never merge White Ta layer and Purple Accent layer logic.

## 1. Data Entities & Domains

### 1.1 Terminology

| Entity | Type | Purpose |
|---|---|---|
| `accents*` | Purple | Accent logic only. Independent of Ta. |
| `taDingKeys*` | White | Explicit Ta markers (`c > 0`, or `c0` if default is off). |
| `firstBeatAccent*` | State | Default "First Beat Ta" (implicit). |
| `firstBeatDingSuppressedRows` | Set | Rows where default `c0` Ta is disabled by user. |

### 1.2 Bars Domains (Critical)

- `totalBars` (Data Domain): ONLY source of truth for audio, snapshots, and logic.
- `visibleBars` (View Domain): How many rows user sees. Zero effect on logic.
- `virtual/renderableBars`: Technical optimization for scrolling. Zero effect on logic.

## 2. Core Invariants (Rules)

### 2.1 Two-Layer Law

- White Frame = Ta logic (`taDingKeys`, `firstBeat*`, suppression).
- Purple Fill = Accent logic (`accents*`).
- Change rule: one must never trigger other.
- Changing accent (purple) **MUST NOT** change Ta-reveal (white) logic.

### 2.2 Polyrhythm (Lane Isolation)

- Always use `*ByLane` containers in poly mode.
- Flat sets are derived/legacy.
- **NEVER** use flat sets as source of truth for lane-specific behavior.

### 2.3 `c0` (First Beat) Toggle

- If Default First Beat is **ON**:
  - Click `c0` -> toggle suppression (add/remove from `SuppressedRows`).
  - No explicit key `r-0` is created.
- If Default First Beat is **OFF**:
  - Click `c0` -> standard `taDingKeys` behavior (explicit key).

## 3. Audio & Playback Gating

### 3.1 First-Beat Policy ("Always Sound" Rule)

- First-beat audio must be calculated via `resolveRuntimeFirstBeatPolicy()`.
- ⛔ **NEVER** bind first-beat audio to `accentMapVersion`.
- `accentMapVersion` is UI/history helper.
- `c0` must sound based on policy, even if grid was edited (`version > 0`).

### 3.2 Square Button (Grid Mix Modes)

| Mode | UI Color | Audio Behavior |
|---|---|---|
| `passive_no_alt` | Gray | Passive sounds + Ta. Purple accents go to passive bus. |
| `full_mix` | Purple | Passive + Alt (Accents) + Ta. |
| `ta_only` | Green | Gating mode: only Ta/First-beat sound. No background passive/alt. |

## 4. UI & Visibility Rules (`SequencerGrid`)

### 4.1 Visibility Contract

- Ta-Editor: show everything (Explicit Ta + default `c0` if not suppressed).
- Normal Mode: show Explicit Ta.
- Reveal default `c0` only if user modified Ta-grid:
  - suppression exists, **or**
  - explicit Ta `c > 0` exists.
- Rule: once revealed, stays revealed until grid is "Reverted to Default".

### 4.2 "Bars = 1" Stability

- When resizing to 1 bar, `SuppressedRows` can become empty.
- Fix: use `canShowDefaultTaInNormal` (derived flag) to keep `c0` frame visible if other changes exist.
- This prevents flickering UI when exiting editor.

## 5. Anti-Regression Checklist (Incident History)

| Avoid this mistake | Why |
|---|---|
| Binding `c0` visibility to `accentMapVersion` | `c0` disappears when adding accents (`alt`). |
| Using `visibleBars` for pruning | UI scroll/zoom breaks audio state. |
| Creating explicit key `r-0` during suppression | Breaks data model and snapshot compatibility. |
| Syncing SHA-7 manually in `App.tsx` | Creates Git Ouroboros (infinite recursion). |

## 6. Snapshot Compatibility

- Normalize on load: convert lane maps and suppression sets/arrays to current internal types.
- Legacy migrations:
  - `all_beats` / `accent_only` -> `full_mix`
  - `passive_only` -> `ta_only`

## 7. File Map

- Logic/Audio: `src/App.tsx`
- UI/Rendering: `src/SequencerGrid.tsx`
- Data Resizing: `src/barsDomain.ts`
- Tests: `src/taVisibility.test.ts`, `src/midiExport.test.ts`