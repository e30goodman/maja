/**
 * Press Matrix — Bar Replication ("printing press").
 *
 * Pure module. No React, no DOM, no setState calls. Returns mutation patches
 * that App.tsx applies atomically.
 *
 * Activation contract: arming is explicit in App.tsx (Bars slider thumb long-press
 * or snowflake long-press toggle).
 * In the moment of arming, App.tsx calls `armPressFromState` (in coordinator)
 * which freezes the current `PressState` as `baselineState` together with
 * `baselineBars`. Subsequent edits to live state do NOT mutate the baseline.
 *
 * On `bars` expansion (prevN -> nextM, prevN < nextM) with `isPrimed === true`:
 *   for every r' in [prevN, nextM): srcRow = r' mod baselineBars
 *   write `snapshotBarFrame(srcRow, baselineState)` into row r' of the patch.
 *
 * On `bars` shrink (nextM < prevN) with `isPrimed === true`:
 *   drop ALL per-row / per-cell entries with r >= nextM.
 *
 * Poly-mode invariants (see `TA_LOGIC_GUIDE.md`):
 *   - lane containers (`accentsByLane`, `taDingKeysByLane`) are SoT;
 *   - in poly, content of row r lives in lane (r % voices);
 *   - on tile, content of srcRow's lane is written into lane (r' % voices);
 *   - flat `accents` / `taDingKeys` are derived from lane containers afterwards.
 */

import type { DeadCellsMap } from './randomLogic';

export type LaneId = 0 | 1 | 2;
export type LaneSetMap = Record<LaneId, Set<string>>;

export type PressBarFrame = {
	customSyllables?: number;
	customMultiplier?: number;
	pulseMeterUnlinked: boolean;
	firstBeatDingSuppressed: boolean;
	subdivisions: Record<number, number>;
	cellSyllables: Record<number, string>;
	accents: Set<number>;
	taDingKeys: Set<number>;
	deadCells?: { deadStart: number; displayLen: number; baseLen: number };
};

export type PressState = {
	bars: number;
	syllables: number;
	polyMode: boolean;
	polyVoices: 2 | 3 | 4;
	customSyllables: Record<number, number>;
	customMultipliers: Record<number, number>;
	customSubdivisions: Record<string, number>;
	customCellSyllables: Record<string, string>;
	accents: Set<string>;
	taDingKeys: Set<string>;
	accentsByLane: LaneSetMap;
	taDingKeysByLane: LaneSetMap;
	firstBeatDingSuppressedRows: Set<number>;
	pulseMeterUnlinked: Record<number, boolean>;
	deadCells: DeadCellsMap;
};

export type PressPatch = {
	customSyllables?: Record<number, number>;
	customMultipliers?: Record<number, number>;
	customSubdivisions?: Record<string, number>;
	customCellSyllables?: Record<string, string>;
	accents?: Set<string>;
	taDingKeys?: Set<string>;
	accentsByLane?: LaneSetMap;
	taDingKeysByLane?: LaneSetMap;
	firstBeatDingSuppressedRows?: Set<number>;
	pulseMeterUnlinked?: Record<number, boolean>;
	deadCells?: DeadCellsMap;
};

export function laneForRow(r: number, voices: 2 | 3 | 4): LaneId {
	return (voices === 3 ? (r % 3) : (r % 2)) as LaneId;
}

function makeEmptyLaneMap(): LaneSetMap {
	return { 0: new Set<string>(), 1: new Set<string>(), 2: new Set<string>() };
}

function cloneLaneMap(src: LaneSetMap): LaneSetMap {
	return { 0: new Set(src[0]), 1: new Set(src[1]), 2: new Set(src[2]) };
}

function parseRC(key: string): [number, number] | null {
	const parts = key.split('-');
	if (parts.length !== 2) return null;
	const r = parseInt(parts[0]!, 10);
	const c = parseInt(parts[1]!, 10);
	if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
	return [r, c];
}

/**
 * Reads the row-`r` cell-set view, lane-aware in poly mode.
 * In mono: just the flat set (rows are not segregated per voice).
 * In poly: only `lane(r) = r % voices` is authoritative for row r.
 */
function readRowCellSet(
	r: number,
	flat: Set<string>,
	byLane: LaneSetMap,
	state: PressState,
): Set<number> {
	const out = new Set<number>();
	const source = state.polyMode ? byLane[laneForRow(r, state.polyVoices)] : flat;
	for (const key of source) {
		const parsed = parseRC(key);
		if (!parsed) continue;
		const [rk, ck] = parsed;
		if (rk !== r) continue;
		out.add(ck);
	}
	return out;
}

/**
 * Extracts a complete `PressBarFrame` for row `r` from `state`.
 * Lane-aware: in poly mode reads from `*ByLane[lane(r)]` (lane SoT).
 */
export function snapshotBarFrame(r: number, state: PressState): PressBarFrame {
	const customSyllables =
		state.customSyllables[r] !== undefined ? state.customSyllables[r] : undefined;
	const customMultiplier =
		state.customMultipliers[r] !== undefined ? state.customMultipliers[r] : undefined;
	const pulseMeterUnlinked = state.pulseMeterUnlinked[r] === true;
	const firstBeatDingSuppressed = state.firstBeatDingSuppressedRows.has(r);

	const subdivisions: Record<number, number> = {};
	const cellSyllables: Record<number, string> = {};
	for (const [k, v] of Object.entries(state.customSubdivisions)) {
		const parsed = parseRC(k);
		if (!parsed) continue;
		const [rk, ck] = parsed;
		if (rk !== r) continue;
		if (typeof v === 'number' && Number.isFinite(v)) subdivisions[ck] = v;
	}
	for (const [k, v] of Object.entries(state.customCellSyllables)) {
		const parsed = parseRC(k);
		if (!parsed) continue;
		const [rk, ck] = parsed;
		if (rk !== r) continue;
		if (typeof v === 'string' && v.length > 0) cellSyllables[ck] = v;
	}

	const accents = readRowCellSet(r, state.accents, state.accentsByLane, state);
	const taDingKeys = readRowCellSet(r, state.taDingKeys, state.taDingKeysByLane, state);

	const dc = state.deadCells[r];
	const frame: PressBarFrame = {
		pulseMeterUnlinked,
		firstBeatDingSuppressed,
		subdivisions,
		cellSyllables,
		accents,
		taDingKeys,
	};
	if (typeof customSyllables === 'number') frame.customSyllables = customSyllables;
	if (typeof customMultiplier === 'number') frame.customMultiplier = customMultiplier;
	if (dc) frame.deadCells = { deadStart: dc.deadStart, displayLen: dc.displayLen, baseLen: dc.baseLen };
	return frame;
}

type PressMutable = {
	customSyllables: Record<number, number>;
	customMultipliers: Record<number, number>;
	customSubdivisions: Record<string, number>;
	customCellSyllables: Record<string, string>;
	accents: Set<string>;
	taDingKeys: Set<string>;
	accentsByLane: LaneSetMap;
	taDingKeysByLane: LaneSetMap;
	firstBeatDingSuppressedRows: Set<number>;
	pulseMeterUnlinked: Record<number, boolean>;
	deadCells: DeadCellsMap;
};

function cloneStateMutable(state: PressState): PressMutable {
	return {
		customSyllables: { ...state.customSyllables },
		customMultipliers: { ...state.customMultipliers },
		customSubdivisions: { ...state.customSubdivisions },
		customCellSyllables: { ...state.customCellSyllables },
		accents: new Set(state.accents),
		taDingKeys: new Set(state.taDingKeys),
		accentsByLane: cloneLaneMap(state.accentsByLane),
		taDingKeysByLane: cloneLaneMap(state.taDingKeysByLane),
		firstBeatDingSuppressedRows: new Set(state.firstBeatDingSuppressedRows),
		pulseMeterUnlinked: { ...state.pulseMeterUnlinked },
		deadCells: { ...state.deadCells },
	};
}

/**
 * Removes any keys for `targetR` from cell-level maps and lane sets.
 * Required before writing frame so that "absent in source" actually clears
 * stale entries that may have lingered in target row from previous edits.
 */
function clearTargetRow(targetR: number, m: PressMutable, voices: 2 | 3 | 4, isPoly: boolean): void {
	const prefix = `${targetR}-`;

	for (const key of Array.from(m.accents)) if (key.startsWith(prefix)) m.accents.delete(key);
	for (const key of Array.from(m.taDingKeys)) if (key.startsWith(prefix)) m.taDingKeys.delete(key);
	for (const lane of [0, 1, 2] as const) {
		for (const key of Array.from(m.accentsByLane[lane])) if (key.startsWith(prefix)) m.accentsByLane[lane].delete(key);
		for (const key of Array.from(m.taDingKeysByLane[lane])) if (key.startsWith(prefix)) m.taDingKeysByLane[lane].delete(key);
	}
	for (const k of Object.keys(m.customSubdivisions)) if (k.startsWith(prefix)) delete m.customSubdivisions[k];
	for (const k of Object.keys(m.customCellSyllables)) if (k.startsWith(prefix)) delete m.customCellSyllables[k];

	delete m.customSyllables[targetR];
	delete m.customMultipliers[targetR];
	delete m.pulseMeterUnlinked[targetR];
	m.firstBeatDingSuppressedRows.delete(targetR);
	delete m.deadCells[targetR];

	void voices;
	void isPoly;
}

function writeFrameInto(
	targetR: number,
	frame: PressBarFrame,
	m: PressMutable,
	voices: 2 | 3 | 4,
	isPoly: boolean,
): void {
	if (typeof frame.customSyllables === 'number') m.customSyllables[targetR] = frame.customSyllables;
	if (typeof frame.customMultiplier === 'number') m.customMultipliers[targetR] = frame.customMultiplier;
	if (frame.pulseMeterUnlinked) m.pulseMeterUnlinked[targetR] = true;
	if (frame.firstBeatDingSuppressed) m.firstBeatDingSuppressedRows.add(targetR);
	for (const [cStr, val] of Object.entries(frame.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (!Number.isFinite(c)) continue;
		m.customSubdivisions[`${targetR}-${c}`] = val;
	}
	for (const [cStr, tok] of Object.entries(frame.cellSyllables)) {
		const c = parseInt(cStr, 10);
		if (!Number.isFinite(c)) continue;
		m.customCellSyllables[`${targetR}-${c}`] = tok;
	}

	const targetLane: LaneId = isPoly ? laneForRow(targetR, voices) : 0;

	for (const c of frame.accents) {
		const key = `${targetR}-${c}`;
		m.accents.add(key);
		if (isPoly) m.accentsByLane[targetLane].add(key);
		else m.accentsByLane[0].add(key);
	}
	for (const c of frame.taDingKeys) {
		const key = `${targetR}-${c}`;
		m.taDingKeys.add(key);
		if (isPoly) m.taDingKeysByLane[targetLane].add(key);
		else m.taDingKeysByLane[0].add(key);
	}

	if (frame.deadCells) {
		m.deadCells[targetR] = {
			deadStart: frame.deadCells.deadStart,
			displayLen: frame.deadCells.displayLen,
			baseLen: frame.deadCells.baseLen,
		};
	}
}

/**
 * Writes `frame` into row `targetR`, returning a fresh patch.
 * Clears the target row first so that "absent in source" actually clears
 * stale entries.
 */
export function applyBarFrame(
	targetR: number,
	frame: PressBarFrame,
	state: PressState,
): PressPatch {
	const m = cloneStateMutable(state);
	clearTargetRow(targetR, m, state.polyVoices, state.polyMode);
	writeFrameInto(targetR, frame, m, state.polyVoices, state.polyMode);
	return mutableToPatch(m);
}

function mutableToPatch(m: PressMutable): PressPatch {
	return {
		customSyllables: m.customSyllables,
		customMultipliers: m.customMultipliers,
		customSubdivisions: m.customSubdivisions,
		customCellSyllables: m.customCellSyllables,
		accents: m.accents,
		taDingKeys: m.taDingKeys,
		accentsByLane: m.accentsByLane,
		taDingKeysByLane: m.taDingKeysByLane,
		firstBeatDingSuppressedRows: m.firstBeatDingSuppressedRows,
		pulseMeterUnlinked: m.pulseMeterUnlinked,
		deadCells: m.deadCells,
	};
}

/**
 * Tile press: source rows [0..sourceN-1] in `baselineState` are stamped onto
 * target rows [prevN..nextM-1] of `liveState`. New row r' uses srcRow = r' mod sourceN.
 *
 * `liveState` is the current grid into which we write; `baselineState` is the
 * frozen source-of-truth captured at arm-time. They may differ (user could
 * have edited live state after arming).
 */
export function tilePress(
	prevN: number,
	nextM: number,
	liveState: PressState,
	baselineState: PressState,
	sourceN: number,
): PressPatch {
	if (sourceN < 1 || nextM <= prevN) return {};
	const m = cloneStateMutable(liveState);
	for (let rPrime = prevN; rPrime < nextM; rPrime++) {
		const srcRow = ((rPrime % sourceN) + sourceN) % sourceN;
		const frame = snapshotBarFrame(srcRow, baselineState);
		clearTargetRow(rPrime, m, liveState.polyVoices, liveState.polyMode);
		writeFrameInto(rPrime, frame, m, liveState.polyVoices, liveState.polyMode);
	}
	return mutableToPatch(m);
}

/**
 * Drop press: removes ALL per-row / per-cell entries with r >= maxBars.
 * Used when bars decreases — by user choice this is a hard drop, not a freeze.
 */
export function dropPress(maxBars: number, state: PressState): PressPatch {
	const m = cloneStateMutable(state);

	for (const key of Array.from(m.accents)) {
		const parsed = parseRC(key);
		if (!parsed) continue;
		if (parsed[0] >= maxBars) m.accents.delete(key);
	}
	for (const key of Array.from(m.taDingKeys)) {
		const parsed = parseRC(key);
		if (!parsed) continue;
		if (parsed[0] >= maxBars) m.taDingKeys.delete(key);
	}
	for (const lane of [0, 1, 2] as const) {
		for (const key of Array.from(m.accentsByLane[lane])) {
			const parsed = parseRC(key);
			if (!parsed) continue;
			if (parsed[0] >= maxBars) m.accentsByLane[lane].delete(key);
		}
		for (const key of Array.from(m.taDingKeysByLane[lane])) {
			const parsed = parseRC(key);
			if (!parsed) continue;
			if (parsed[0] >= maxBars) m.taDingKeysByLane[lane].delete(key);
		}
	}
	for (const k of Object.keys(m.customSubdivisions)) {
		const parsed = parseRC(k);
		if (!parsed) continue;
		if (parsed[0] >= maxBars) delete m.customSubdivisions[k];
	}
	for (const k of Object.keys(m.customCellSyllables)) {
		const parsed = parseRC(k);
		if (!parsed) continue;
		if (parsed[0] >= maxBars) delete m.customCellSyllables[k];
	}
	for (const k of Object.keys(m.customSyllables)) {
		const r = parseInt(k, 10);
		if (Number.isFinite(r) && r >= maxBars) delete m.customSyllables[r];
	}
	for (const k of Object.keys(m.customMultipliers)) {
		const r = parseInt(k, 10);
		if (Number.isFinite(r) && r >= maxBars) delete m.customMultipliers[r];
	}
	for (const k of Object.keys(m.pulseMeterUnlinked)) {
		const r = parseInt(k, 10);
		if (Number.isFinite(r) && r >= maxBars) delete m.pulseMeterUnlinked[r];
	}
	for (const r of Array.from(m.firstBeatDingSuppressedRows)) {
		if (r >= maxBars) m.firstBeatDingSuppressedRows.delete(r);
	}
	for (const k of Object.keys(m.deadCells)) {
		const r = parseInt(k, 10);
		if (Number.isFinite(r) && r >= maxBars) delete m.deadCells[r];
	}
	return mutableToPatch(m);
}

/**
 * True iff every per-row/per-cell map is empty. Used as a safety check after
 * Eraser-like operations to deactivate `isPrimed`.
 */
export function isStateEmpty(state: PressState): boolean {
	if (Object.keys(state.customSyllables).length > 0) return false;
	if (Object.keys(state.customMultipliers).length > 0) return false;
	if (Object.keys(state.customSubdivisions).length > 0) return false;
	if (Object.keys(state.customCellSyllables).length > 0) return false;
	if (state.accents.size > 0) return false;
	if (state.taDingKeys.size > 0) return false;
	for (const lane of [0, 1, 2] as const) {
		if (state.accentsByLane[lane].size > 0) return false;
		if (state.taDingKeysByLane[lane].size > 0) return false;
	}
	if (state.firstBeatDingSuppressedRows.size > 0) return false;
	if (Object.keys(state.pulseMeterUnlinked).length > 0) return false;
	if (Object.keys(state.deadCells).length > 0) return false;
	return true;
}

/**
 * Deep clone of `PressState`. Used by coordinator to freeze a baseline at
 * arm-time so that subsequent live edits do not bleed into the source.
 */
export function clonePressState(state: PressState): PressState {
	return {
		bars: state.bars,
		syllables: state.syllables,
		polyMode: state.polyMode,
		polyVoices: state.polyVoices,
		customSyllables: { ...state.customSyllables },
		customMultipliers: { ...state.customMultipliers },
		customSubdivisions: { ...state.customSubdivisions },
		customCellSyllables: { ...state.customCellSyllables },
		accents: new Set(state.accents),
		taDingKeys: new Set(state.taDingKeys),
		accentsByLane: cloneLaneMap(state.accentsByLane),
		taDingKeysByLane: cloneLaneMap(state.taDingKeysByLane),
		firstBeatDingSuppressedRows: new Set(state.firstBeatDingSuppressedRows),
		pulseMeterUnlinked: { ...state.pulseMeterUnlinked },
		deadCells: { ...state.deadCells },
	};
}

export const __INTERNAL = { parseRC, makeEmptyLaneMap };
