# GATI Definition (Canonical)

## What Gati Is

Gati is the gait of rhythm: subdivision density **inside** a fixed pulse.

- Musical meaning: micro-pulse articulation per beat.
- Runtime mapping: `subdivisions[cellIdx]`.
- Domain invariant: Gati does **not** change cycle skeleton length.

## UI Trigger

- Trigger: **Long Press on Tempo**.
- Intended outcome: denser intra-cell articulation (`4 -> 5 -> 6 -> 7 -> 8`) while keeping the same global bar frame.

## Logic Contract

For ADI-8 lessons, the following must stay fixed in pure Gati mode:

- Global cycle remains ADI-8 (8 anchor cells).
- Global BPM remains unchanged by the mode switch itself.
- Bar size (`curSyl`) remains unchanged.

Only these may change:

- `subdivisions` map values and distribution,
- articulation dictionary choice tied to speed/kalam.

## Aesthetic Intent

Gati creates flow acceleration without rewriting the rhythmic skeleton.

- Listener hears increased movement and energy.
- Listener does **not** lose structural orientation of the cycle.

## Allowed vs Forbidden

### Allowed in Gati

- Increase/decrease intra-cell density.
- Accent reshaping that preserves cycle length.
- Kalam articulation switches (e.g., Ju/Nu at high NPS).

### Forbidden in Gati

- Re-labeling fixed-length bars as Jati.
- Changing `curSyl` as a side effect of pure Gati mutation.
- Using dead-cells as fake cycle-size change.

## True Gati Log Signature

- `Mode = Gati`
- `Total_Cells = 8` (in ADI context)
- `Sub` changes across bars/phases
- No structural cycle rewrite

Example:

`Bar 12: [Gati Mode] | Cells:8 | Sub:6 | PulseOffset:...`

## False Jati Anti-Pattern

If only `Sub` changed while bar size remained the same, this is still Gati:

`Bar 12: [Jati Mode] | Cells:8 | Sub:6` -> **invalid mapping**

## Glossary

- **Pulse/Cell**: anchor beat unit in the bar frame.
- **Subdivision (Sub)**: micro-pulses inside one cell.
- **Cycle Skeleton**: number of anchor cells (`curSyl`) used by timing.
