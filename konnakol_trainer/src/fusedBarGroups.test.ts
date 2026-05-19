/**
 * Run: `npx tsx src/fusedBarGroups.test.ts` from the `konnakol_trainer` directory.
 */
import assert from 'node:assert/strict';
import {
	applyFusedMultiplierHold,
	canPlaceFusedTaAtCell,
	computeFusedCrossLaneDeadBars,
	isFusedGroupFirstBeatCell,
	getFusedNonLeaderBars,
	getFusedBarStepDisplay,
	formatFusedBarStepLabel,
	getFusedPolyDisplayStep,
	buildFusedFlatCellIndex,
	stripTaDingKeysForFusedGroups,
	decodeFusedGroupsToken,
	decrementFusedGroupJatiFromBar,
	distributeFusedGroupJatiSum,
	encodeFusedGroupsToken,
	findGroupForBar,
	incrementFusedGroupJatiFromBar,
	getCrossLaneBarsAtSameCycle,
	getFusedBarTimeWindowSeconds,
	getFusedCellDurationSeconds,
	getFusedTotalLiveCells,
	getLegacyNoteDurationSeconds,
	remapGroupsOnBarsChange,
	sumGroupJati,
} from './fusedBarGroups';

function testHoldCreateExtendDissolve() {
	let g = applyFusedMultiplierHold([], 0, false, 2, 4);
	assert.equal(g.length, 1);
	assert.deepEqual(g[0]!.bars, [0]);
	g = applyFusedMultiplierHold(g, 0, false, 2, 4);
	assert.equal(g.length, 0);
	g = applyFusedMultiplierHold([], 1, false, 2, 4);
	assert.deepEqual(g[0]!.bars, [1]);
	g = applyFusedMultiplierHold(g, 0, false, 2, 4);
	assert.deepEqual(g[0]!.bars, [0, 1]);
	g = applyFusedMultiplierHold(g, 2, false, 2, 4);
	assert.deepEqual(g[0]!.bars, [0, 1, 2]);
	g = applyFusedMultiplierHold(g, 3, false, 2, 4);
	assert.deepEqual(g[0]!.bars, [0, 1, 2, 3]);
	g = applyFusedMultiplierHold(g, 2, false, 2, 4);
	assert.equal(g.length, 0);
}

function testPolyLanesSeparate() {
	let g = applyFusedMultiplierHold([], 0, true, 2, 6);
	g = applyFusedMultiplierHold(g, 1, true, 2, 6);
	assert.equal(g.length, 2);
	assert.deepEqual(findGroupForBar(g, 0)!.bars, [0]);
	assert.deepEqual(findGroupForBar(g, 1)!.bars, [1]);
	g = applyFusedMultiplierHold(g, 2, true, 2, 6);
	assert.deepEqual(findGroupForBar(g, 0)!.bars, [0, 2]);
}

function testCannotSkipBar() {
	let g = applyFusedMultiplierHold([], 0, false, 2, 6);
	g = applyFusedMultiplierHold(g, 2, false, 2, 6);
	assert.deepEqual(g[0]!.bars, [0]);
}

function testFusedTimingEqualsSingleBar() {
	const group = { laneId: 0, bars: [0, 2] };
	const customSyllables = { 0: 9, 2: 2 };
	const tempo = 100;
	const fusedWin = getFusedBarTimeWindowSeconds(group, customSyllables, 4, {}, {}, tempo);
	const singleWin =
		getLegacyNoteDurationSeconds(11, tempo, 1) * 11;
	assert.ok(Math.abs(fusedWin - singleWin) < 1e-9);
	const cells = getFusedTotalLiveCells(group, customSyllables, 4, {});
	assert.equal(cells, 11);
	const dCell = getFusedCellDurationSeconds(group, customSyllables, 4, {}, {}, tempo, {});
	assert.ok(Math.abs(dCell * cells - fusedWin) < 1e-9);
	assert.equal(sumGroupJati(group, customSyllables, 4), 11);
}

function testSnapshotRoundtrip() {
	const groups = [
		{ laneId: 0, bars: [0, 2, 4] },
		{ laneId: 1, bars: [1, 3] },
	];
	const tok = encodeFusedGroupsToken(groups, true);
	const back = decodeFusedGroupsToken(tok, true, 6, 2);
	assert.equal(back.length, 2);
	assert.deepEqual(back[0]!.bars, [0, 2, 4]);
	assert.deepEqual(back[1]!.bars, [1, 3]);
	const monoTok = encodeFusedGroupsToken([{ laneId: 0, bars: [0, 1] }], false);
	assert.deepEqual(decodeFusedGroupsToken(monoTok, false, 4, 2)[0]!.bars, [0, 1]);
}

function testRemapBars() {
	const g = [{ laneId: 0, bars: [0, 1, 2] }];
	const next = remapGroupsOnBarsChange(g, 2, false, 2, 3);
	assert.deepEqual(next[0]!.bars, [0, 1]);
	assert.deepEqual(next[0]!.shrinkDetachedBars, [2]);
}

function testRemapBarsRestoreOnGrow() {
	let g = [{ laneId: 0, bars: [0, 1, 2], shrinkDetachedBars: [2] }];
	g = remapGroupsOnBarsChange(g, 4, false, 2, 2);
	assert.deepEqual(g[0]!.bars, [0, 1, 2]);
	assert.equal(g[0]!.shrinkDetachedBars, undefined);
}

function testRemapBarsPolyRestore() {
	let g = [{ laneId: 1, bars: [1, 3], shrinkDetachedBars: [5] }];
	g = remapGroupsOnBarsChange(g, 6, true, 2, 4);
	assert.deepEqual(g[0]!.bars, [1, 3, 5]);
}

function testPolyFusedWindowMatchesAnchorPeer() {
	const group = { laneId: 1, bars: [1, 3] };
	const cs = { 0: 4, 1: 5, 3: 5 };
	const tempo = 120;
	const peerWin = getLegacyNoteDurationSeconds(4, tempo, 1) * 4;
	const ctx = {
		polyMode: true as const,
		polyVoices: 2 as const,
		barCount: 4,
		getPeerBarWindowSeconds: (b: number) => {
			const row = cs[b] ?? 4;
			return getLegacyNoteDurationSeconds(row, tempo, 1) * row;
		},
	};
	const win = getFusedBarTimeWindowSeconds(group, cs, 4, {}, {}, tempo, ctx);
	assert.ok(Math.abs(win - peerWin) < 1e-9, `fused window ${win} vs peer ${peerWin}`);
	const dCell = getFusedCellDurationSeconds(group, cs, 4, {}, {}, tempo, {}, ctx);
	assert.ok(Math.abs(dCell * 10 - win) < 1e-9);
	const peerStep = peerWin / 4;
	assert.ok(Math.abs(peerStep / dCell - 2.5) < 1e-6, '4:10 step ratio');
}

function testFusedFlatCellIndexStitchOrder() {
	const group = { laneId: 1, bars: [1, 3] };
	const flat = buildFusedFlatCellIndex(group, { 1: 2, 3: 3 }, 4, {});
	assert.equal(flat.length, 5);
	assert.deepEqual(flat[0], { bar: 1, c: 0 });
	assert.deepEqual(flat[1], { bar: 1, c: 1 });
	assert.deepEqual(flat[2], { bar: 3, c: 0 });
}

function testFusedBarStepDisplayLabels() {
	const duo = [{ laneId: 0, bars: [0, 1] }];
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(0, duo, 3, false, 2)), '1');
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(1, duo, 3, false, 2)), '');
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(2, duo, 3, false, 2)), '2');
	const groups = [{ laneId: 0, bars: [0, 1, 2] }];
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(0, groups, 4, false, 2)), '1');
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(1, groups, 4, false, 2)), '');
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(2, groups, 4, false, 2)), '');
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(3, groups, 4, false, 2)), '2');
	const polyG = [{ laneId: 0, bars: [0, 2] }];
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(0, polyG, 4, true, 2)), '1');
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(2, polyG, 4, true, 2)), '');
	assert.equal(
		formatFusedBarStepLabel(getFusedBarStepDisplay(1, polyG, 4, true, 2, { 1: 0 })),
		'',
	);
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(1, polyG, 4, true, 2)), '1');
	assert.equal(formatFusedBarStepLabel(getFusedBarStepDisplay(3, polyG, 4, true, 2)), '2');
}

function testFusedPolyDisplayStepUsesLeader() {
	const group = { laneId: 1, bars: [1, 3] };
	assert.equal(getFusedPolyDisplayStep(1, group, 2), 0);
	assert.equal(getFusedPolyDisplayStep(3, group, 2), 0);
	assert.equal(getFusedPolyDisplayStep(2, null, 2), 1);
}

function testFusedTaOnlyOnLeaderBeatZero() {
	let g = applyFusedMultiplierHold([], 1, true, 2, 4);
	const ta = new Set(['1-0', '3-0', '3-2', '1-1']);
	g = applyFusedMultiplierHold(g, 3, true, 2, 4);
	assert.deepEqual(getFusedNonLeaderBars(g), [3]);
	const stripped = stripTaDingKeysForFusedGroups(g, ta);
	assert.deepEqual([...stripped].sort(), ['1-0']);
	assert.equal(canPlaceFusedTaAtCell(g, 3, 0), false);
	assert.equal(canPlaceFusedTaAtCell(g, 1, 0), true);
	assert.equal(canPlaceFusedTaAtCell(g, 1, 1), false);
	assert.equal(isFusedGroupFirstBeatCell(g, 1, 0), true);
	assert.equal(isFusedGroupFirstBeatCell(g, 3, 0), false);
}

function testFusedJatiCarryAcrossBars() {
	const group = { laneId: 0, bars: [0, 1, 2] };
	const base = 4;
	let cs: Record<number, number> = {};
	assert.equal(sumGroupJati(group, cs, base), 12);
	cs = { ...cs, ...incrementFusedGroupJatiFromBar(group, 0, cs, base) };
	assert.equal(cs[0], 5);
	assert.equal(sumGroupJati(group, cs, base), 13);
	cs = { 0: 9, 1: 4, 2: 4 };
	const carry = incrementFusedGroupJatiFromBar(group, 0, cs, base);
	assert.equal(carry[1], 5);
	assert.equal(carry[0], undefined);
	cs = { ...cs, ...carry };
	assert.equal(sumGroupJati(group, cs, base), 18);
	cs = { 0: 9, 1: 9, 2: 9 };
	const wrap = incrementFusedGroupJatiFromBar(group, 2, cs, base);
	assert.deepEqual(wrap, { 2: 1 });
	const dist = distributeFusedGroupJatiSum(group, 10, {}, base, 0);
	assert.deepEqual(dist, { 0: 2, 1: 4, 2: 4 });
	assert.equal(sumGroupJati(group, dist, base), 10);
	const distFromBar2 = distributeFusedGroupJatiSum(group, 10, { 0: 9, 1: 9, 2: 9 }, base, 2);
	assert.deepEqual(distFromBar2, { 0: 1, 1: 8, 2: 1 });
	assert.equal(sumGroupJati(group, distFromBar2, base), 10);
	const dec = decrementFusedGroupJatiFromBar(group, 2, { 0: 5, 1: 5, 2: 5 }, base);
	assert.equal(dec[2], 4);
	assert.equal(dec[0], undefined);
}

function testCrossLaneDeadOnFusedExtend() {
	// 2 voices, 4 bars: lane0 [0,2], lane1 [1,3]. Fuse lane1 9+2 → bar 2 (voice1 tact2) dead.
	let g = applyFusedMultiplierHold([], 1, true, 2, 4);
	g = applyFusedMultiplierHold(g, 3, true, 2, 4);
	assert.deepEqual(findGroupForBar(g, 3)!.bars, [1, 3]);
	assert.deepEqual(getCrossLaneBarsAtSameCycle(3, 1, 4, 2), [2]);
	assert.deepEqual(computeFusedCrossLaneDeadBars(g, true, 2, 4), [2]);
	const singleOnly = applyFusedMultiplierHold([], 1, true, 2, 4);
	assert.deepEqual(computeFusedCrossLaneDeadBars(singleOnly, true, 2, 4), []);
}

function run() {
	testHoldCreateExtendDissolve();
	testPolyLanesSeparate();
	testCannotSkipBar();
	testFusedTimingEqualsSingleBar();
	testSnapshotRoundtrip();
	testRemapBars();
	testRemapBarsRestoreOnGrow();
	testRemapBarsPolyRestore();
	testFusedFlatCellIndexStitchOrder();
	testFusedBarStepDisplayLabels();
	testFusedPolyDisplayStepUsesLeader();
	testFusedTaOnlyOnLeaderBeatZero();
	testFusedJatiCarryAcrossBars();
	testCrossLaneDeadOnFusedExtend();
	testPolyFusedWindowMatchesAnchorPeer();
	console.log('fusedBarGroups.test.ts: all passed');
}

run();
