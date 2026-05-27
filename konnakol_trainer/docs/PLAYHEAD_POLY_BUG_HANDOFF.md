# Poly playhead bug handoff (V0 / V1 / V2)

## Scope (what we fix)

**Inside one voice** during play: emerald/sky/violet **border** and **fill** must appear and disappear **together** on the same syllable cell (`isActive` → one `playheadHighlightCellClasses`).

**Not in scope:** V0 vs V1 sounding at the same wall time; fused audio anchor timing; Ta/accent styling vs playhead color.

## User-visible symptoms

- V0 or V1: frame without fill or fill without frame (same cell).
- V1 feels tied to V0 refresh rhythm (“magnetized” to V0 ticks).
- Brief empty gap between subdivisions of the same voice (frame+fill off between `tEnd` and next `t0`).

## Root cause (pre-refactor)

| Issue | Effect |
|-------|--------|
| One global `playheadTimerRef` + `nextPlayheadWakeDeadline` over all voices | UI wake often driven by V0’s shorter cell edges |
| `syncPlayheadDisplayFromQueue` in `scheduler()` every `lookaheadMs` | All voices refreshed on one `now` |
| `setPlayheadAudioTime` before signature early-return | Grid re-renders all rows even when slots unchanged |
| Second time-gate in grid (`playheadByVoiceMap` + `playheadAudioTime`) | Edge `now` can drop V1 highlight while V0 updates |

## Hypotheses (phase 0 logs)

- **H1:** `activeSlotForVoice === null` between `tEnd` and next event `t0` for same voice → flash off.
- **H2:** deferred hybrid `subTime` vs playhead `t0` mismatch (audio vs UI).

## Fix (implemented)

Per-voice lane clock: `playheadLaneClock.ts` — separate wake per voice, `playheadSlotsByVoice[voice]` atomic slot for border+fill, no global sync in `scheduler()`.

## Acceptance

- Active V0 cell: emerald border + fill together.
- Active V1 cell: sky border + fill together; refresh not locked to V0 tick.
- V2 (`polyVoices===3`): same as V1, violet.
- Between cells of same voice: no “frame only” or “fill only” frame.

## Do not reintroduce

rAF playhead loop, `flushSync`, catch-up chain, `playheadUiSampleTime`, batch `while (shift)` UI drain.
