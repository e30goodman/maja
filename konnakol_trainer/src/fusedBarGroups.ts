/**
 * Fused bar groups: adjacent bars on one poly lane (or legacy mono) share one pulse-meter
 * window and play as a single temporal unit (Σ jati display, one x-mult, block gati/jati).
 */

import type { DeadCellsMap } from './randomLogic';

/** UI/runtime gate: fused logic stays in repo but is inactive while false. */
export const FUSED_BAR_GROUPS_ENABLED = false;

export type RepriseDisabledRows = Record<number, true>;

export function isBarRepriseDisabled(repriseDisabled: RepriseDisabledRows, bar: number): boolean {
	return repriseDisabled[bar] === true;
}

/** Reprise count follows x-mult (1/2/4); long-press on x-mult can force a single pass. */
export function getBarRepriseCountForBar(
	bar: number,
	repriseDisabled: RepriseDisabledRows,
	customMultipliers: Record<number, number>,
	group: FusedGroupState | null = null,
): number {
	if (isBarRepriseDisabled(repriseDisabled, bar)) return 1;
	const mult = group ? getGroupMultiplier(group, customMultipliers) : normalizeBarMultiplier(customMultipliers[bar]);
	return mult;
}

/** @deprecated Use getBarRepriseCountForBar */
export function getBarRepriseCount(
	repriseDisabled: RepriseDisabledRows,
	bar: number,
	customMultipliers: Record<number, number> = {},
): number {
	return getBarRepriseCountForBar(bar, repriseDisabled, customMultipliers, null);
}

export const PULSE_METER_BASE_SYLLABLES = 4;
export type BarMultiplier = 1 | 2 | 4;

export type FusedGroupState = {
	laneId: number;
	bars: number[];
	/** Lane bars cut when global `bars` shrank; merged back when `bars` grows again. */
	shrinkDetachedBars?: number[];
};

export function normalizeBarMultiplier(raw: unknown): BarMultiplier {
	const n = Math.floor(Number(raw));
	return n === 2 || n === 4 ? n : 1;
}

export function shouldStoreBarMultiplier(raw: unknown): raw is 2 | 4 {
	return normalizeBarMultiplier(raw) !== 1;
}

export function cycleBarMultiplier(raw: unknown): BarMultiplier {
	const cur = normalizeBarMultiplier(raw);
	return cur === 1 ? 2 : cur === 2 ? 4 : 1;
}

export type PolyVoicesCount = 2 | 3;

export function getLaneId(bar: number, polyMode: boolean, polyVoices: PolyVoicesCount): number {
	if (!polyMode) return 0;
	const V = polyVoices === 3 ? 3 : 2;
	return ((bar % V) + V) % V;
}

export function buildLaneBarIndices(barCount: number, polyVoices: PolyVoicesCount): number[][] {
	const V = polyVoices === 3 ? 3 : 2;
	const lanes: number[][] = Array.from({ length: V }, () => []);
	for (let b = 0; b < barCount; b++) {
		lanes[b % V]!.push(b);
	}
	return lanes;
}

/** Other-lane bars at the same cycle index as `bar` on `fusedLaneId`. */
export function getCrossLaneBarsAtSameCycle(
	bar: number,
	fusedLaneId: number,
	barCount: number,
	polyVoices: PolyVoicesCount,
): number[] {
	if (barCount <= 0) return [];
	const lanes = buildLaneBarIndices(barCount, polyVoices);
	const laneBars = lanes[fusedLaneId];
	if (!laneBars) return [];
	const cycleIdx = laneBars.indexOf(bar);
	if (cycleIdx < 0) return [];
	const out: number[] = [];
	for (let lid = 0; lid < lanes.length; lid++) {
		if (lid === fusedLaneId) continue;
		const cross = lanes[lid]![cycleIdx];
		if (cross !== undefined) out.push(cross);
	}
	return out;
}

/**
 * Poly: each non-leader bar in a fused block borrows its cycle slot; counterpart bars on
 * other lanes at that cycle must be fully dead (deadStart ≤ 0) so they leave rotation.
 */
export function computeFusedCrossLaneDeadBars(
	groups: FusedGroupState[],
	polyMode: boolean,
	polyVoices: PolyVoicesCount,
	barCount: number,
): number[] {
	if (!polyMode || barCount <= 0 || groups.length === 0) return [];
	const lanes = buildLaneBarIndices(barCount, polyVoices);
	const dead = new Set<number>();
	for (const g of groups) {
		const leader = getGroupLeaderBar(g);
		const laneBars = lanes[g.laneId];
		if (!laneBars) continue;
		for (const b of g.bars) {
			if (b === leader) continue;
			const cycleIdx = laneBars.indexOf(b);
			if (cycleIdx < 0) continue;
			for (let lid = 0; lid < lanes.length; lid++) {
				if (lid === g.laneId) continue;
				const cross = lanes[lid]![cycleIdx];
				if (cross !== undefined && !findGroupForBar(groups, cross)) dead.add(cross);
			}
		}
	}
	return [...dead].sort((a, b) => a - b);
}

function sortBarsByLaneOrder(bars: number[], laneBarIndices: number[]): number[] {
	const uniq = [...new Set(bars.filter((b) => Number.isInteger(b) && b >= 0))];
	return uniq.sort((a, b) => laneBarIndices.indexOf(a) - laneBarIndices.indexOf(b));
}

function normalizeGroupBars(bars: number[], laneBarIndices: number[]): number[] {
	const sorted = sortBarsByLaneOrder(bars, laneBarIndices);
	if (sorted.length === 0) return [];
	const positions = sorted.map((b) => laneBarIndices.indexOf(b));
	if (positions.some((p) => p < 0)) return [];
	for (let i = 1; i < positions.length; i++) {
		if (positions[i]! - positions[i - 1]! !== 1) return [];
	}
	return sorted;
}

export function findGroupForBar(groups: FusedGroupState[], bar: number): FusedGroupState | null {
	for (const g of groups) {
		if (g.bars.includes(bar)) return g;
	}
	return null;
}

export function findGroupForLane(groups: FusedGroupState[], laneId: number): FusedGroupState | null {
	return groups.find((g) => g.laneId === laneId) ?? null;
}

export function getRowSyllables(
	bar: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
): number {
	return customSyllables[bar] !== undefined ? customSyllables[bar]! : baseSyllables;
}

export function sumGroupJati(
	group: FusedGroupState,
	customSyllables: Record<number, number>,
	baseSyllables: number,
): number {
	let sum = 0;
	for (const b of group.bars) {
		sum += getRowSyllables(b, customSyllables, baseSyllables);
	}
	return Math.max(1, sum);
}

const FUSED_JATI_MIN = 1;
const FUSED_JATI_MAX = 9;

export function getFusedGroupJatiSumBounds(group: FusedGroupState): { minSum: number; maxSum: number } {
	const n = Math.max(1, group.bars.length);
	return { minSum: n * FUSED_JATI_MIN, maxSum: n * FUSED_JATI_MAX };
}

function fusedBarsFromAnchor(group: FusedGroupState, anchorBar: number): number[] {
	const startIdx = group.bars.indexOf(anchorBar);
	if (startIdx < 0) return [...group.bars];
	return group.bars.map((_, i) => group.bars[(startIdx + i) % group.bars.length]!);
}

/**
 * Reach target Σ jati from current values: +1 prefers anchor then siblings;
 * −1 drains anchor first, then siblings in group order (wrap).
 */
export function distributeFusedGroupJatiSum(
	group: FusedGroupState,
	targetSum: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	anchorBar: number = group.bars[0]!,
): Record<number, number> {
	const { minSum, maxSum } = getFusedGroupJatiSumBounds(group);
	const target = Math.max(minSum, Math.min(maxSum, Math.round(targetSum)));
	const order = fusedBarsFromAnchor(group, anchorBar);
	const patch: Record<number, number> = {};
	let curSum = 0;
	for (const b of group.bars) {
		const v = getRowSyllables(b, customSyllables, baseSyllables);
		patch[b] = v;
		curSum += v;
	}
	let remaining = Math.abs(target - curSum);
	const dir = target > curSum ? 1 : -1;
	while (remaining > 0) {
		let progressed = false;
		for (const b of order) {
			if (remaining <= 0) break;
			if (dir > 0) {
				while (patch[b]! < FUSED_JATI_MAX && remaining > 0) {
					patch[b] = patch[b]! + 1;
					remaining -= 1;
					progressed = true;
				}
			} else {
				while (patch[b]! > FUSED_JATI_MIN && remaining > 0) {
					patch[b] = patch[b]! - 1;
					remaining -= 1;
					progressed = true;
				}
			}
		}
		if (!progressed) break;
	}
	return patch;
}

/** −1 on pulse click: drain clicked bar first, then siblings (wrap). */
export function decrementFusedGroupJatiFromBar(
	group: FusedGroupState,
	clickedBar: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
): Record<number, number> {
	const startIdx = group.bars.indexOf(clickedBar);
	if (startIdx < 0) {
		const cur = getRowSyllables(clickedBar, customSyllables, baseSyllables);
		return { [clickedBar]: cur <= FUSED_JATI_MIN ? FUSED_JATI_MAX : cur - 1 };
	}
	for (let i = 0; i < group.bars.length; i++) {
		const b = group.bars[(startIdx + i) % group.bars.length]!;
		const cur = getRowSyllables(b, customSyllables, baseSyllables);
		if (cur > FUSED_JATI_MIN) {
			return { [b]: cur - 1 };
		}
	}
	return { [clickedBar]: FUSED_JATI_MAX };
}

/**
 * +1 on pulse click inside a fused block: fill clicked bar, then next bars in group order; wrap to first.
 */
export function incrementFusedGroupJatiFromBar(
	group: FusedGroupState,
	clickedBar: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
): Record<number, number> {
	const startIdx = group.bars.indexOf(clickedBar);
	if (startIdx < 0) {
		const cur = getRowSyllables(clickedBar, customSyllables, baseSyllables);
		return { [clickedBar]: cur >= FUSED_JATI_MAX ? FUSED_JATI_MIN : cur + 1 };
	}
	for (let i = 0; i < group.bars.length; i++) {
		const b = group.bars[(startIdx + i) % group.bars.length]!;
		const cur = getRowSyllables(b, customSyllables, baseSyllables);
		if (cur < FUSED_JATI_MAX) {
			return { [b]: cur + 1 };
		}
	}
	return { [clickedBar]: FUSED_JATI_MIN };
}

export function isGroupGati(
	group: FusedGroupState,
	pulseMeterUnlinked: Record<number, boolean>,
): boolean {
	const leader = group.bars[0]!;
	return isRowPulseUnlinkedEffective(pulseMeterUnlinked, leader);
}

export function isRowPulseUnlinkedEffective(
	pulseMeterUnlinked: Record<number, boolean> | undefined,
	rowIdx: number,
): boolean {
	return pulseMeterUnlinked?.[rowIdx] === true;
}

export function getGroupPulseSyllables(
	group: FusedGroupState,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	pulseMeterUnlinked: Record<number, boolean>,
): number {
	if (isGroupGati(group, pulseMeterUnlinked)) return sumGroupJati(group, customSyllables, baseSyllables);
	return baseSyllables;
}

export function isFusedGroupFollowerBar(group: FusedGroupState, bar: number): boolean {
	return group.bars.includes(bar) && bar !== getGroupLeaderBar(group);
}

/** Pulse meter: every fused row shows the same Σ jati for the whole block. */
export function getDisplayPulseSyllables(
	bar: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	group: FusedGroupState | null,
): number {
	if (group && group.bars.includes(bar)) {
		return sumGroupJati(group, customSyllables, baseSyllables);
	}
	return getRowSyllables(bar, customSyllables, baseSyllables);
}

export function getGroupLeaderBar(group: FusedGroupState): number {
	return group.bars[0]!;
}

export type FusedBarStepDisplay = {
	/** 1-based cycle label on the pulse meter (leader / live unfused bar only). */
	stepNum: number;
	/** Non-leader inside fused block — no label (leader shows the number). */
	isFollower: boolean;
	/** Row fully dead / cross-lane dropout — no label, does not advance cycle count. */
	hideLabel: boolean;
};

/** Whole row dead (`deadStart === 0`) — lane dropped out of the cycle. */
export function isBarDroppedFromCycle(bar: number, deadStartByRow: Record<number, number>): boolean {
	return deadStartByRow[bar] === 0;
}

/**
 * Fused mega-bar = one cycle on the lane; follower bars show no number; dead bars are skipped.
 */
export function getFusedBarStepDisplay(
	bar: number,
	groups: FusedGroupState[],
	barCount: number,
	polyMode: boolean,
	polyVoices: PolyVoicesCount,
	deadStartByRow: Record<number, number> = {},
): FusedBarStepDisplay {
	const laneId = getLaneId(bar, polyMode, polyVoices);
	const laneBars = polyMode
		? (buildLaneBarIndices(barCount, polyVoices)[laneId] ?? [])
		: Array.from({ length: barCount }, (_, i) => i);
	let logical = 0;
	const seenGroups = new Set<FusedGroupState>();
	for (const b of laneBars) {
		if (isBarDroppedFromCycle(b, deadStartByRow)) {
			if (b === bar) {
				return { stepNum: 0, isFollower: false, hideLabel: true };
			}
			continue;
		}
		const g = findGroupForBar(groups, b);
		if (g && g.laneId === laneId) {
			if (!seenGroups.has(g)) {
				seenGroups.add(g);
				logical += 1;
			}
			if (b === bar) {
				const isFollower = b !== getGroupLeaderBar(g);
				return {
					stepNum: logical,
					isFollower,
					hideLabel: isFollower,
				};
			}
		} else {
			logical += 1;
			if (b === bar) {
				return { stepNum: logical, isFollower: false, hideLabel: false };
			}
		}
	}
	return { stepNum: Math.max(1, logical), isFollower: false, hideLabel: false };
}

/** Empty string = render no cycle label (not the default bar index). */
export function formatFusedBarStepLabel(display: FusedBarStepDisplay): string {
	if (display.hideLabel || display.isFollower) return '';
	return `${display.stepNum}`;
}

/** Poly playhead `step`: fused block uses leader cycle index so highlight stays on one grid row. */
export function getFusedPolyDisplayStep(
	bar: number,
	group: Pick<FusedGroupState, 'bars'> | null,
	polyVoices: PolyVoicesCount,
): number {
	const V = polyVoices === 3 ? 3 : 2;
	if (group && group.bars.includes(bar)) {
		return Math.floor(group.bars[0]! / V);
	}
	return Math.floor(bar / V);
}

export function getGroupMultiplier(
	group: FusedGroupState,
	customMultipliers: Record<number, number>,
): number {
	return normalizeBarMultiplier(customMultipliers[getGroupLeaderBar(group)]);
}

export function getLegacyNoteDurationSeconds(
	pulseSyllables: number,
	tempo: number,
	mult: number,
): number {
	const effectiveBpm = tempo * (pulseSyllables / 4) * normalizeBarMultiplier(mult);
	if (effectiveBpm <= 0) return 0.5;
	return 60.0 / effectiveBpm;
}

/** Poly: peer bar on another lane at the same cycle index as the fused block leader (lane 0 first). */
export function getFusedCrossLaneAnchorBar(
	group: FusedGroupState,
	barCount: number,
	polyVoices: PolyVoicesCount,
): number | null {
	if (barCount <= 0) return null;
	const lanes = buildLaneBarIndices(barCount, polyVoices);
	const laneBars = lanes[group.laneId];
	if (!laneBars) return null;
	const cycleIdx = laneBars.indexOf(getGroupLeaderBar(group));
	if (cycleIdx < 0) return null;
	const V = polyVoices === 3 ? 3 : 2;
	for (let lid = 0; lid < V; lid++) {
		if (lid === group.laneId) continue;
		const cross = lanes[lid]![cycleIdx];
		if (cross !== undefined) return cross;
	}
	return null;
}

export type FusedTimingContext = {
	polyMode: boolean;
	polyVoices: PolyVoicesCount;
	barCount: number;
	/** Window of a normal (non-fused) peer bar — must not recurse into fused timing. */
	getPeerBarWindowSeconds: (bar: number) => number;
};

function getFusedSumPulseWindowSeconds(
	group: FusedGroupState,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	pulseMeterUnlinked: Record<number, boolean>,
	customMultipliers: Record<number, number>,
	tempo: number,
): number {
	const pulseSyl = getGroupPulseSyllables(group, customSyllables, baseSyllables, pulseMeterUnlinked);
	const mult = getGroupMultiplier(group, customMultipliers);
	const noteDuration = getLegacyNoteDurationSeconds(pulseSyl, tempo, mult);
	return noteDuration * Math.max(1, pulseSyl);
}

/**
 * Wall-clock duration of one fused block.
 * Poly: same window as cross-lane anchor (e.g. 4-pulse bar) so Σ jati cells fit 4:10 polymeter;
 * user mult on the block divides that anchor window (x2 = twice as fast).
 * Mono: legacy sum-pulse formula.
 */
export function getFusedBarTimeWindowSeconds(
	group: FusedGroupState,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	pulseMeterUnlinked: Record<number, boolean>,
	customMultipliers: Record<number, number>,
	tempo: number,
	timingCtx?: FusedTimingContext,
): number {
	const mult = Math.max(1, getGroupMultiplier(group, customMultipliers));
	if (timingCtx?.polyMode && timingCtx.barCount > 0) {
		const anchor = getFusedCrossLaneAnchorBar(group, timingCtx.barCount, timingCtx.polyVoices);
		if (anchor !== null) {
			const peerWindow = timingCtx.getPeerBarWindowSeconds(anchor);
			if (Number.isFinite(peerWindow) && peerWindow > 0) {
				return peerWindow / mult;
			}
		}
	}
	return getFusedSumPulseWindowSeconds(
		group,
		customSyllables,
		baseSyllables,
		pulseMeterUnlinked,
		customMultipliers,
		tempo,
	);
}

/** Implied x-mult so sum-pulse window would match peer anchor (for display / optional sync). */
export function computeFusedMultiplierForPeerWindow(
	group: FusedGroupState,
	peerWindowSec: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	pulseMeterUnlinked: Record<number, boolean>,
	tempo: number,
): number {
	if (!Number.isFinite(peerWindowSec) || peerWindowSec <= 0) return 1;
	const pulseSyl = getGroupPulseSyllables(group, customSyllables, baseSyllables, pulseMeterUnlinked);
	const intrinsic = getLegacyNoteDurationSeconds(pulseSyl, tempo, 1) * Math.max(1, pulseSyl);
	const raw = intrinsic / peerWindowSec;
	if (!Number.isFinite(raw) || raw <= 0) return 1;
	return Math.max(1, Math.min(4, Math.round(raw)));
}

export function getLiveCellCountForBar(
	bar: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	deadCells: DeadCellsMap,
): number {
	const rowSyl = getRowSyllables(bar, customSyllables, baseSyllables);
	const ds = deadCells[bar]?.deadStart;
	const lastLiveExclusive =
		typeof ds === 'number' ? Math.min(Math.max(0, Math.floor(ds)), rowSyl) : rowSyl;
	return Math.max(0, lastLiveExclusive);
}

export function getFusedTotalLiveCells(
	group: FusedGroupState,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	deadCells: DeadCellsMap,
): number {
	let total = 0;
	for (const b of group.bars) {
		total += getLiveCellCountForBar(b, customSyllables, baseSyllables, deadCells);
	}
	return Math.max(1, total);
}

/** Glued mega-bar: lane-order flat list of live (bar, cell) for playhead / timing alignment. */
export type FusedFlatCell = { bar: number; c: number };

export function buildFusedFlatCellIndex(
	group: FusedGroupState,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	deadCells: DeadCellsMap,
): FusedFlatCell[] {
	const flat: FusedFlatCell[] = [];
	for (const bar of group.bars) {
		const live = getLiveCellCountForBar(bar, customSyllables, baseSyllables, deadCells);
		for (let c = 0; c < live; c++) {
			flat.push({ bar, c });
		}
	}
	return flat;
}

export function getFusedCellDurationSeconds(
	group: FusedGroupState,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	pulseMeterUnlinked: Record<number, boolean>,
	customMultipliers: Record<number, number>,
	tempo: number,
	deadCells: DeadCellsMap,
	timingCtx?: FusedTimingContext,
): number {
	const window = getFusedBarTimeWindowSeconds(
		group,
		customSyllables,
		baseSyllables,
		pulseMeterUnlinked,
		customMultipliers,
		tempo,
		timingCtx,
	);
	const cells = getFusedTotalLiveCells(group, customSyllables, baseSyllables, deadCells);
	return window / cells;
}

export function barsShareFusedGroup(a: number, b: number, groups: FusedGroupState[]): boolean {
	const ga = findGroupForBar(groups, a);
	const gb = findGroupForBar(groups, b);
	return ga !== null && ga === gb;
}

/** Member bars (not leader): default Ta on beat 0 must be off while in a fused block. */
export function getFusedNonLeaderBars(groups: FusedGroupState[]): number[] {
	const out: number[] = [];
	for (const g of groups) {
		const leader = getGroupLeaderBar(g);
		for (const b of g.bars) {
			if (b !== leader) out.push(b);
		}
	}
	return out;
}

/**
 * True when this cell is beat-0 of the fused mega-bar (leader row, col 0 only).
 * Non-leader bar col 0 is a mid-block syllable, not a downbeat — not user-suppressed Ta.
 */
export function isFusedGroupFirstBeatCell(
	groups: FusedGroupState[],
	bar: number,
	col: number,
): boolean {
	if (col !== 0) return false;
	const g = findGroupForBar(groups, bar);
	if (!g) return true;
	return bar === getGroupLeaderBar(g);
}

/** Outside fused blocks explicit Ta can live on any cell; inside a fused block only leader beat 0 keeps Ta. */
export function canPlaceFusedTaAtCell(
	groups: FusedGroupState[],
	bar: number,
	col: number,
): boolean {
	const g = findGroupForBar(groups, bar);
	if (!g) return col >= 0;
	return col === 0 && bar === getGroupLeaderBar(g);
}

export function stripTaDingKeysForFusedGroups(
	groups: FusedGroupState[],
	taDingKeys: Iterable<string>,
): Set<string> {
	if (groups.length === 0) {
		return taDingKeys instanceof Set ? new Set(taDingKeys) : new Set(taDingKeys);
	}
	const leaders = new Set<number>();
	const nonLeaders = new Set<number>();
	for (const g of groups) {
		const leader = getGroupLeaderBar(g);
		leaders.add(leader);
		for (const b of g.bars) {
			if (b !== leader) nonLeaders.add(b);
		}
	}
	const out = new Set<string>();
	for (const key of taDingKeys) {
		const dash = key.indexOf('-');
		if (dash < 0) continue;
		const r = parseInt(key.slice(0, dash), 10);
		const c = parseInt(key.slice(dash + 1), 10);
		if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
		if (nonLeaders.has(r)) continue;
		if (leaders.has(r) && c !== 0) continue;
		out.add(key);
	}
	return out;
}

export function canAddBarToGroup(
	group: FusedGroupState,
	bar: number,
	laneBarIndices: number[],
): boolean {
	if (group.bars.includes(bar)) return false;
	const barPos = laneBarIndices.indexOf(bar);
	if (barPos < 0) return false;
	const positions = group.bars.map((b) => laneBarIndices.indexOf(b)).filter((p) => p >= 0);
	if (positions.length === 0) return false;
	const minPos = Math.min(...positions);
	const maxPos = Math.max(...positions);
	return barPos === minPos - 1 || barPos === maxPos + 1;
}

function findNearestAddableBarForGroup(
	group: FusedGroupState,
	requestedBar: number,
	laneBarIndices: number[],
	groups: FusedGroupState[],
	allowNearestFallback: boolean,
): number | null {
	if (canAddBarToGroup(group, requestedBar, laneBarIndices)) return requestedBar;
	if (!allowNearestFallback) return null;
	const positions = group.bars.map((b) => laneBarIndices.indexOf(b)).filter((p) => p >= 0);
	if (positions.length === 0) return null;
	const requestedPos = laneBarIndices.indexOf(requestedBar);
	const minPos = Math.min(...positions);
	const maxPos = Math.max(...positions);
	const candidates = [minPos - 1, maxPos + 1]
		.filter((p) => p >= 0 && p < laneBarIndices.length)
		.map((p) => laneBarIndices[p]!)
		.filter((b) => {
			const owner = findGroupForBar(groups, b);
			return owner === null || owner === group;
		});
	if (candidates.length === 0) return null;
	const distance = (bar: number) => {
		const pos = laneBarIndices.indexOf(bar);
		if (requestedPos >= 0 && pos >= 0) return Math.abs(pos - requestedPos);
		return Math.abs(bar - requestedBar);
	};
	return candidates.sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

function buildReservableLaneBarIndices(
	groups: FusedGroupState[],
	currentGroup: FusedGroupState,
	laneId: number,
	laneBarIndices: number[],
	polyMode: boolean,
	polyVoices: PolyVoicesCount,
	barCount: number,
): number[] {
	if (!polyMode || barCount <= 0) return laneBarIndices;
	const lanes = buildLaneBarIndices(barCount, polyVoices);
	const reserved = new Set<number>();
	for (const g of groups) {
		if (g === currentGroup || g.laneId === laneId) continue;
		const otherLaneBars = lanes[g.laneId];
		if (!otherLaneBars) continue;
		const leader = getGroupLeaderBar(g);
		for (const b of g.bars) {
			if (b === leader) continue;
			const cycleIdx = otherLaneBars.indexOf(b);
			if (cycleIdx < 0) continue;
			const cross = laneBarIndices[cycleIdx];
			if (cross !== undefined) reserved.add(cross);
		}
	}
	return laneBarIndices.filter((b) => {
		if (currentGroup.bars.includes(b)) return true;
		const owner = findGroupForBar(groups, b);
		if (owner !== null && owner !== currentGroup) return false;
		return !reserved.has(b);
	});
}

function findNearestGroupForLane(
	groups: FusedGroupState[],
	laneId: number,
	requestedBar: number,
	laneBarIndices: number[],
): FusedGroupState | null {
	const laneGroups = groups.filter((g) => g.laneId === laneId);
	if (laneGroups.length === 0) return null;
	const requestedPos = laneBarIndices.indexOf(requestedBar);
	const distance = (group: FusedGroupState) => {
		const positions = group.bars.map((b) => laneBarIndices.indexOf(b)).filter((p) => p >= 0);
		if (positions.length === 0) return Number.POSITIVE_INFINITY;
		if (requestedPos >= 0) return Math.min(...positions.map((p) => Math.abs(p - requestedPos)));
		return Math.min(...group.bars.map((b) => Math.abs(b - requestedBar)));
	};
	return laneGroups.sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

/** After removing a bar, keep only contiguous runs with 2+ bars (singleton = unfused). */
function splitIntoContiguousRuns(bars: number[], laneBarIndices: number[]): number[][] {
	const sorted = sortBarsByLaneOrder(bars, laneBarIndices);
	if (sorted.length === 0) return [];
	const runs: number[][] = [];
	let current: number[] = [sorted[0]!];
	for (let i = 1; i < sorted.length; i++) {
		const b = sorted[i]!;
		const prevPos = laneBarIndices.indexOf(current[current.length - 1]!);
		const pos = laneBarIndices.indexOf(b);
		if (pos >= 0 && prevPos >= 0 && pos === prevPos + 1) {
			current.push(b);
		} else {
			runs.push(current);
			current = [b];
		}
	}
	runs.push(current);
	return runs;
}

function removeBarFromFusedGroup(
	groups: FusedGroupState[],
	existing: FusedGroupState,
	bar: number,
	laneId: number,
	laneBars: number[],
): FusedGroupState[] {
	const remaining = existing.bars.filter((b) => b !== bar);
	const without = groups.filter((g) => g !== existing);
	if (remaining.length === 0) return without;
	const runs = splitIntoContiguousRuns(remaining, laneBars);
	const nextGroups: FusedGroupState[] = [];
	for (const run of runs) {
		if (run.length < 2) continue;
		const normalized = normalizeGroupBars(run, laneBars);
		if (normalized.length >= 2) {
			nextGroups.push({ laneId, bars: normalized });
		}
	}
	return [...without, ...nextGroups];
}

/** Hold on multiplier: create / extend / detach held bar only. */
export function applyFusedMultiplierHold(
	groups: FusedGroupState[],
	bar: number,
	polyMode: boolean,
	polyVoices: PolyVoicesCount,
	barCount: number,
): FusedGroupState[] {
	const laneId = getLaneId(bar, polyMode, polyVoices);
	const laneBars = polyMode
		? buildLaneBarIndices(barCount, polyVoices)[laneId]!
		: Array.from({ length: barCount }, (_, i) => i);
	const existing = findGroupForBar(groups, bar);
	if (existing) {
		const reservableLaneBars = buildReservableLaneBarIndices(
			groups,
			existing,
			laneId,
			laneBars,
			polyMode,
			polyVoices,
			barCount,
		);
		return removeBarFromFusedGroup(groups, existing, bar, laneId, reservableLaneBars);
	}
	const laneGroup = findNearestGroupForLane(groups, laneId, bar, laneBars);
	if (laneGroup) {
		const reservableLaneBars = buildReservableLaneBarIndices(
			groups,
			laneGroup,
			laneId,
			laneBars,
			polyMode,
			polyVoices,
			barCount,
		);
		const addBar = findNearestAddableBarForGroup(
			laneGroup,
			bar,
			reservableLaneBars,
			groups,
			polyMode && reservableLaneBars.length !== laneBars.length,
		);
		if (addBar !== null) {
			const nextBars = normalizeGroupBars([...laneGroup.bars, addBar], reservableLaneBars);
			if (nextBars.length === 0) return groups;
			return groups.map((g) => (g === laneGroup ? { laneId, bars: nextBars } : g));
		}
		return groups;
	}
	if (polyMode) {
		const others = groups.filter((g) => g.laneId !== laneId);
		return [...others, { laneId, bars: [bar] }];
	}
	return [{ laneId: 0, bars: [bar] }];
}

export function syncGroupMultiplier(
	groups: FusedGroupState[],
	bar: number,
	mult: number,
): Record<number, number> {
	const g = findGroupForBar(groups, bar);
	if (!g) return {};
	const out: Record<number, number> = {};
	const leader = getGroupLeaderBar(g);
	const normalized = normalizeBarMultiplier(mult);
	if (normalized === 1) {
		for (const b of g.bars) {
			if (b !== leader) out[b] = -1;
		}
		return out;
	}
	for (const b of g.bars) {
		out[b] = normalized;
	}
	return out;
}

/** After merge / extend: reset mult to x1 on all bars except leader keys cleared. */
export function multiplierResetPatchForGroup(group: FusedGroupState): {
	set: Record<number, number>;
	delete: number[];
} {
	const leader = getGroupLeaderBar(group);
	const del: number[] = [];
	for (const b of group.bars) {
		if (b !== leader) del.push(b);
	}
	return { set: {}, delete: del };
}

export function toggleGroupGati(
	group: FusedGroupState,
	pulseMeterUnlinked: Record<number, boolean>,
): Record<number, boolean> {
	const nextVal = !isGroupGati(group, pulseMeterUnlinked);
	const patch: Record<number, boolean> = {};
	for (const b of group.bars) {
		patch[b] = nextVal;
	}
	return patch;
}

export function remapGroupsOnBarsChange(
	groups: FusedGroupState[],
	newBarCount: number,
	polyMode: boolean,
	polyVoices: PolyVoicesCount,
	previousBarCount?: number,
): FusedGroupState[] {
	if (newBarCount <= 0) return [];
	const laneIndexLists = polyMode ? buildLaneBarIndices(newBarCount, polyVoices) : null;
	const growing =
		previousBarCount !== undefined &&
		Number.isFinite(previousBarCount) &&
		newBarCount > previousBarCount;
	const shrinking =
		previousBarCount !== undefined &&
		Number.isFinite(previousBarCount) &&
		newBarCount < previousBarCount;
	const out: FusedGroupState[] = [];
	for (const g of groups) {
		const laneBars =
			laneIndexLists?.[g.laneId] ?? Array.from({ length: newBarCount }, (_, i) => i);
		let shrinkDetached = [...(g.shrinkDetachedBars ?? [])];
		if (shrinking) {
			const removed = g.bars.filter((b) => b >= newBarCount || !laneBars.includes(b));
			if (removed.length > 0) {
				shrinkDetached = [...new Set([...shrinkDetached, ...removed])].sort((a, b) => a - b);
			}
		}
		const shrinkRestorable = shrinkDetached.filter(
			(b) => b >= 0 && b < newBarCount && laneBars.includes(b),
		);
		const activeBars = g.bars.filter((b) => b >= 0 && b < newBarCount && laneBars.includes(b));
		const candidateBars = growing
			? [...new Set([...activeBars, ...shrinkRestorable])]
			: activeBars;
		const normalized = normalizeGroupBars(candidateBars, laneBars);
		if (normalized.length === 0) continue;
		const stillDetached = shrinkDetached.filter((b) => !normalized.includes(b));
		const next: FusedGroupState = { laneId: g.laneId, bars: normalized };
		if (stillDetached.length > 0) next.shrinkDetachedBars = stillDetached;
		out.push(next);
	}
	return out;
}

export function encodeFusedGroupsToken(groups: FusedGroupState[], polyMode: boolean): string {
	if (groups.length === 0) return '0';
	const parts: string[] = [];
	for (const g of groups) {
		const barPart = g.bars.map((b) => b.toString(36)).join('-');
		if (polyMode) {
			parts.push(`L${g.laneId}:${barPart}`);
		} else {
			parts.push(`m:${barPart}`);
		}
	}
	parts.sort();
	return parts.join('|');
}

export function getGlobalCellIndexInGroup(
	group: FusedGroupState,
	bar: number,
	cell: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	deadCells: DeadCellsMap,
): number {
	let idx = 0;
	for (const b of group.bars) {
		const live = getLiveCellCountForBar(b, customSyllables, baseSyllables, deadCells);
		if (b === bar) {
			return idx + Math.min(cell, Math.max(0, live - 1));
		}
		idx += live;
	}
	return idx;
}

export function mapGlobalCellToBarCell(
	group: FusedGroupState,
	globalCell: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	deadCells: DeadCellsMap,
): { bar: number; c: number } {
	let remaining = Math.max(0, globalCell);
	for (const b of group.bars) {
		const live = getLiveCellCountForBar(b, customSyllables, baseSyllables, deadCells);
		if (remaining < live) {
			return { bar: b, c: remaining };
		}
		remaining -= live;
	}
	const lastBar = group.bars[group.bars.length - 1]!;
	const liveLast = getLiveCellCountForBar(lastBar, customSyllables, baseSyllables, deadCells);
	return { bar: lastBar, c: Math.max(0, liveLast - 1) };
}

export function decodeFusedGroupsToken(
	token: string,
	polyMode: boolean,
	barCount: number,
	polyVoices: PolyVoicesCount,
): FusedGroupState[] {
	if (!token || token === '0') return [];
	const laneIndexLists = polyMode ? buildLaneBarIndices(barCount, polyVoices) : null;
	const out: FusedGroupState[] = [];
	for (const chunk of token.split('|')) {
		if (!chunk) continue;
		const mono = chunk.match(/^m:([\da-z\-]+)$/i);
		const poly = chunk.match(/^L(\d+):([\da-z\-]+)$/i);
		let laneId = 0;
		let barPart: string | undefined;
		if (mono) {
			barPart = mono[1];
		} else if (poly && polyMode) {
			laneId = parseInt(poly[1]!, 10);
			barPart = poly[2];
		} else {
			continue;
		}
		if (!barPart) continue;
		const rawBars = barPart.split('-').map((s) => parseInt(s, 36)).filter((n) => Number.isFinite(n));
		const laneBars =
			laneIndexLists?.[laneId] ?? Array.from({ length: barCount }, (_, i) => i);
		const bars = normalizeGroupBars(rawBars, laneBars);
		if (bars.length === 0) continue;
		out.push({ laneId, bars });
	}
	return out;
}
