# JATI Definition (Canonical)

## What Jati Is

Jati is the cycle skeleton: the number of anchor pulses/cells in the bar.

- Musical meaning: meter-size contour (e.g., 8 -> 5 -> 7).
- Runtime mapping: `curSyl` / active cell count per bar.
- Domain invariant: Jati changes cycle size, not just intra-cell density.

## UI Trigger

- Trigger: **Long Press on Pulse**.
- Intended outcome: bar enters local autonomous size and may de-sync from ADI-8.

## Logic Contract (De-sync)

When Jati mode is truly active:

- Bar size is physically changed (`curSyl` is rewritten to local jati size).
- Local phrase follows its own cycle length (e.g., 5/7/9).
- Timing accumulator can drift relative to global ADI-8 phase.

Jati mode is **not** valid when only `subdivisions` changed.

## Re-sync Bridge Contract

Before final cadence (especially Tihai/Muktayi), de-synced flow must return to ADI-8 alignment.

- Bridge role: `resync_bridge` (including prep bridges where needed).
- Bridge responsibility: absorb offset without amputating main phrase onset.
- Final requirement: cadence lands on Sam by real timing math, not label-only masking.

## Aesthetic Intent

Jati is structural transformation, not decorative density.

- Listener hears real size migration (e.g., 4/4 feel to 5/8 feel).
- Listener experiences controlled return to canonical landing.

## Allowed vs Forbidden

### Allowed in Jati

- Physical bar-size rewrite (`curSyl`/active cells).
- Autonomous local cycle passage.
- Purposeful bridge-based return to ADI-8.

### Forbidden in Jati

- Declaring Jati while keeping unchanged cycle size.
- Using only syllable swap as proof of Jati.
- Replacing bridge timing math with dead-cell masking.

## True Jati Log Signature

- `Mode = Jati`
- Asymmetric local cycle (`5`, `7`, `9`, etc.)
- Non-trivial phase behavior (`PulseOffset` drift / bridge correction)

Example:

`Bar 18: [Jati Mode] | Cells:5 | LocalJati:5/8 | PulseOffset:...`

## Critical Audit Failure

If log says Jati but no structural or timing evidence exists:

`CRITICAL: False Jati Mapping Detected`

## Glossary

- **Jati**: cycle-length identity.
- **De-sync**: temporary autonomy from global ADI lock.
- **Re-sync Bridge**: transition mechanism restoring ADI alignment.
