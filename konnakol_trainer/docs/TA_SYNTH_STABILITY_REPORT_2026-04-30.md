# TA Synth Stability Report (for external expert)

## 1) Problem statement

Observed issue in `konnakol_trainer`:

- `Ta` accent sound is perceptually unstable between hits.
- User reports instability as:
  - different start character/attack feel between hits,
  - occasional "alive"/breathing feel (as if different level reaches compressor),
  - no clean deterministic pattern tied only to bar start or fixed grid position.
- Issue reproduced even during accent-focused listening (solo context).

Important clarification from user:

- Main concern is **not jitter** itself.
- Main concern is **synth start behavior** ("start синтеза"), i.e. hit onset consistency.

## 2) Current architecture context

Relevant runtime path:

- `src/App.tsx` orchestrates scheduling and role routing.
- `playSharpClick(...)` renders click voices (`accent`/`alt`/`passive`) through layered synth path.
- Layer rendering in `src/metroLayerGraph.ts`:
  - tone/noise layers,
  - envelope and filter scheduling,
  - oscillator start timing logic.
- Voice buses in `src/metroSoundBus.ts`, master chain/limiter in `src/metraAudioBus.ts`.

## 3) Key technical hypotheses investigated

1. Role-routing variability:
   - same logical Ta-adjacent events may reach different voice paths (`accent` vs `alt`/`base`) depending on branch conditions.
   - different role gains and bus/filter paths change pre-compressor signal.

2. Start-time variability:
   - oscillator start and/or scheduling guards create non-identical onset behavior.

3. Dynamics interaction:
   - varying pre-compressor input level/state may produce "breathing" artifacts, perceived as timbral inconsistency.

## 4) What was tried (and did not solve issue)

### A. Temporary pre-recorded Ta mode

- Goal: exclude live synth generation as root cause.
- Implemented temporary pre-recorded buffer path per click preset (priority `drum machine`/`hi_hat`).
- Result:
  - gave improvement in one test phase,
  - then switched back to synth for further isolation per user request.

### B. Deterministic synth Ta mode (no jitter path)

- Ta routed through deterministic synth call (`disableOscJitter=true`) instead of sample path.
- Result:
  - issue persisted according to user feedback.

### C. Strong synth "compression" attempt (single-layer deterministic Ta)

- Tried heavily constrained synth onset path to force repeatability.
- Result:
  - user reported worse timbre,
  - rolled back.

### D. Soft gain stabilization for Ta (without changing timbre path)

- Added mild then stronger gain compression mapping before Ta deterministic synth call.
- Result:
  - still insufficient; issue remained.

### E. "Exact start" forcing in `playSharpClick`

- Tried force mode to bypass extra start shift logic.
- Result:
  - not helpful for user’s target symptom,
  - rolled back.

### F. Synth warmup (cold-start mitigation)

- Added one-time per-context/per-preset silent prewarm of Ta synth chain.
- Result:
  - did not help,
  - rolled back.

## 5) Rollback status

Latest failed warmup change was rolled back.

Current working state after rollback:

- no Ta synth warmup hook,
- no exact-start override flag,
- no aggressive single-layer timbre-changing Ta path,
- no sample mode active.

Still present for investigation:

- deterministic Ta synth branch with no jitter flag during Ta call path.

## 6) Why this remains hard

- Symptom appears to be onset-consistency related, but straightforward jitter/first-hit/cold-start fixes were not sufficient.
- User-perceived defect may be caused by interaction of:
  - role resolution branches,
  - layer stack behavior under accent context,
  - bus-gain differences reaching master dynamics.

## 7) Requested expert focus

Please inspect and propose minimal intrusive fix for:

1. deterministic `Ta` onset identity across repeated hits,
2. no timbre degradation compared to baseline Ta tone,
3. no changes to rhythm-grid logic and no redesign of compressor/master chain.

Primary files to inspect:

- `src/App.tsx` (`scheduleGridCellAtTime`, `playSharpClick`, `playBarFirstHighClick`)
- `src/metroLayerGraph.ts`
- `src/metroSoundBus.ts`
- `src/metraAudioBus.ts`
