/**
 * Tests for `pressMatrix.ts`. Run with `npx tsx src/pressMatrix.test.ts`.
 *
 * Coverage:
 *  - snapshot/apply roundtrip (mono and poly).
 *  - tile mod-N for N=1, N=2, N=3.
 *  - tile copies every layer: jati / multiplier / subdivisions / cellSyllables /
 *    accents (flat + lane) / taDing (flat + lane) / firstBeatDingSuppressed /
 *    pulseMeterUnlinked / deadCells.
 *  - dropPress purges everything for r >= maxBars in every map.
 *  - isStateEmpty: positive and negative paths.
 *  - baseline freeze: tile uses baseline, not live state.
 *  - poly invariant: lane(srcRow) read, lane(targetRow) write.
 *  - prevN=0 / sourceN=0 guard.
 */

import assert from 'node:assert/strict';
import {
	type LaneId,
	type LaneSetMap,
	type PressBarFrame,
	type PressState,
	applyBarFrame,
	clonePressState,
	dropPress,
	isStateEmpty,
	laneForRow,
	snapshotBarFrame,
	tilePress,
} from './pressMatrix';
import {
	armPressFromState,
	getPressBaseline,
	isPressPrimed,
	notifyPressErased,
	_resetPressCoordinatorForTests,
} from './pressMatrixCoordinator';

function emptyLaneMap(): LaneSetMap {
	return { 0: new Set<string>(), 1: new Set<string>(), 2: new Set<string>() };
}

function makeEmptyState(opts?: Partial<Pick<PressState, 'bars' | 'syllables' | 'polyMode' | 'polyVoices'>>): PressState {
	return {
		bars: opts?.bars ?? 4,
		syllables: opts?.syllables ?? 4,
		polyMode: opts?.polyMode ?? false,
		polyVoices: opts?.polyVoices ?? 2,
		customSyllables: {},
		customMultipliers: {},
		customSubdivisions: {},
		customCellSyllables: {},
		accents: new Set<string>(),
		taDingKeys: new Set<string>(),
		accentsByLane: emptyLaneMap(),
		taDingKeysByLane: emptyLaneMap(),
		firstBeatDingSuppressedRows: new Set<number>(),
		pulseMeterUnlinked: {},
		deadCells: {},
	};
}

function applyPatchToState(state: PressState, patch: ReturnType<typeof tilePress>): PressState {
	return {
		...state,
		customSyllables: patch.customSyllables ?? state.customSyllables,
		customMultipliers: patch.customMultipliers ?? state.customMultipliers,
		customSubdivisions: patch.customSubdivisions ?? state.customSubdivisions,
		customCellSyllables: patch.customCellSyllables ?? state.customCellSyllables,
		accents: patch.accents ?? state.accents,
		taDingKeys: patch.taDingKeys ?? state.taDingKeys,
		accentsByLane: patch.accentsByLane ?? state.accentsByLane,
		taDingKeysByLane: patch.taDingKeysByLane ?? state.taDingKeysByLane,
		firstBeatDingSuppressedRows: patch.firstBeatDingSuppressedRows ?? state.firstBeatDingSuppressedRows,
		pulseMeterUnlinked: patch.pulseMeterUnlinked ?? state.pulseMeterUnlinked,
		deadCells: patch.deadCells ?? state.deadCells,
	};
}

/** Mono: writes content into row 0, snapshot, apply into row 5, expect row 5 mirrors row 0 fully. */
function testRoundtripMono() {
	const state = makeEmptyState({ bars: 6 });
	state.customSyllables[0] = 5;
	state.customMultipliers[0] = 3;
	state.pulseMeterUnlinked[0] = true;
	state.firstBeatDingSuppressedRows.add(0);
	state.customSubdivisions['0-0'] = 2;
	state.customSubdivisions['0-3'] = 4;
	state.customCellSyllables['0-1'] = 'TaKa';
	state.accents.add('0-2');
	state.taDingKeys.add('0-4');
	state.deadCells[0] = { deadStart: 4, displayLen: 5, baseLen: 5 };

	const frame = snapshotBarFrame(0, state);
	assert.equal(frame.customSyllables, 5);
	assert.equal(frame.customMultiplier, 3);
	assert.equal(frame.pulseMeterUnlinked, true);
	assert.equal(frame.firstBeatDingSuppressed, true);
	assert.equal(frame.subdivisions[0], 2);
	assert.equal(frame.subdivisions[3], 4);
	assert.equal(frame.cellSyllables[1], 'TaKa');
	assert.ok(frame.accents.has(2));
	assert.ok(frame.taDingKeys.has(4));
	assert.deepEqual(frame.deadCells, { deadStart: 4, displayLen: 5, baseLen: 5 });

	const patch = applyBarFrame(5, frame, state);
	assert.equal(patch.customSyllables![5], 5);
	assert.equal(patch.customMultipliers![5], 3);
	assert.equal(patch.pulseMeterUnlinked![5], true);
	assert.ok(patch.firstBeatDingSuppressedRows!.has(5));
	assert.equal(patch.customSubdivisions!['5-0'], 2);
	assert.equal(patch.customSubdivisions!['5-3'], 4);
	assert.equal(patch.customCellSyllables!['5-1'], 'TaKa');
	assert.ok(patch.accents!.has('5-2'));
	assert.ok(patch.taDingKeys!.has('5-4'));
	assert.deepEqual(patch.deadCells![5], { deadStart: 4, displayLen: 5, baseLen: 5 });
}

/** Poly 2: row 0 (lane 0) -> row 1 (lane 1) cross-lane stamp. */
function testRoundtripPoly2() {
	const state = makeEmptyState({ bars: 4, polyMode: true, polyVoices: 2 });
	state.accents.add('0-2');
	state.accentsByLane[0].add('0-2');
	state.taDingKeys.add('0-3');
	state.taDingKeysByLane[0].add('0-3');
	state.customSyllables[0] = 6;

	const frame = snapshotBarFrame(0, state);
	assert.equal(frame.customSyllables, 6);
	assert.ok(frame.accents.has(2));
	assert.ok(frame.taDingKeys.has(3));

	const patch = applyBarFrame(1, frame, state);
	const lane1: LaneId = laneForRow(1, 2);
	assert.equal(lane1, 1, 'row 1 must live in lane 1 with voices=2');
	assert.ok(patch.accentsByLane![1].has('1-2'), 'lane 1 must contain row-1 accent');
	assert.ok(!patch.accentsByLane![0].has('1-2'), 'lane 0 must NOT contain row-1 accent');
	assert.ok(patch.taDingKeysByLane![1].has('1-3'));
	assert.ok(!patch.taDingKeysByLane![0].has('1-3'));
}

/** Poly 3: row 1 (lane 1) -> row 4 (lane 1) same-lane stamp. */
function testRoundtripPoly3() {
	const state = makeEmptyState({ bars: 6, polyMode: true, polyVoices: 3 });
	state.accents.add('1-0');
	state.accentsByLane[1].add('1-0');

	const frame = snapshotBarFrame(1, state);
	assert.ok(frame.accents.has(0));

	const targetR = 4;
	const patch = applyBarFrame(targetR, frame, state);
	const targetLane = laneForRow(targetR, 3);
	assert.equal(targetLane, 1);
	assert.ok(patch.accentsByLane![1].has('4-0'));
	for (const lane of [0, 2] as const) {
		assert.ok(!patch.accentsByLane![lane].has('4-0'));
	}
}

/** N=1 -> M=4: every new row equals row 0. */
function testTile_N1_to_M4() {
	const state = makeEmptyState({ bars: 1 });
	state.customSyllables[0] = 7;
	state.accents.add('0-3');
	state.customSubdivisions['0-2'] = 3;

	const baseline = clonePressState(state);
	const patch = tilePress(1, 4, state, baseline, 1);
	assert.equal(patch.customSyllables![1], 7);
	assert.equal(patch.customSyllables![2], 7);
	assert.equal(patch.customSyllables![3], 7);
	for (const r of [1, 2, 3]) {
		assert.ok(patch.accents!.has(`${r}-3`), `row ${r} accent missing`);
		assert.equal(patch.customSubdivisions![`${r}-2`], 3, `row ${r} subdivision missing`);
	}
}

/** N=2 -> M=5: new rows index sequence = [0,1,0]. */
function testTile_N2_to_M5() {
	const state = makeEmptyState({ bars: 2 });
	state.customSyllables[0] = 4;
	state.customSyllables[1] = 6;
	state.accents.add('0-0');
	state.accents.add('1-2');

	const baseline = clonePressState(state);
	const patch = tilePress(2, 5, state, baseline, 2);
	assert.equal(patch.customSyllables![2], 4, 'row 2 = src 0');
	assert.equal(patch.customSyllables![3], 6, 'row 3 = src 1');
	assert.equal(patch.customSyllables![4], 4, 'row 4 = src 0');
	assert.ok(patch.accents!.has('2-0'));
	assert.ok(patch.accents!.has('3-2'));
	assert.ok(patch.accents!.has('4-0'));
}

/** N=3 -> M=7: new rows = [0,1,2,0]. */
function testTile_N3_to_M7() {
	const state = makeEmptyState({ bars: 3 });
	state.customSyllables[0] = 4;
	state.customSyllables[1] = 5;
	state.customSyllables[2] = 7;

	const baseline = clonePressState(state);
	const patch = tilePress(3, 7, state, baseline, 3);
	assert.equal(patch.customSyllables![3], 4);
	assert.equal(patch.customSyllables![4], 5);
	assert.equal(patch.customSyllables![5], 7);
	assert.equal(patch.customSyllables![6], 4);
}

/** Baseline freeze: live state changes after arming should not affect tile output. */
function testBaselineFreeze() {
	_resetPressCoordinatorForTests();
	const state = makeEmptyState({ bars: 2 });
	state.customSyllables[0] = 5;
	state.accents.add('0-0');

	armPressFromState(state);
	assert.equal(isPressPrimed(), true);
	const baseline = getPressBaseline()!;
	assert.equal(baseline.bars, 2);

	state.customSyllables[0] = 9;
	state.accents.delete('0-0');
	state.accents.add('0-7');

	const patch = tilePress(2, 4, state, baseline.state, baseline.bars);
	assert.equal(patch.customSyllables![2], 5, 'baseline must be frozen');
	assert.ok(patch.accents!.has('2-0'), 'baseline accents must be frozen');
	assert.ok(!patch.accents!.has('2-7'), 'live edits must not bleed into baseline');

	notifyPressErased();
	assert.equal(isPressPrimed(), false);
	assert.equal(getPressBaseline(), null);
}

/** Tile copies every layer simultaneously. */
function testTileAllLayers() {
	const state = makeEmptyState({ bars: 1 });
	state.customSyllables[0] = 5;
	state.customMultipliers[0] = 2;
	state.pulseMeterUnlinked[0] = true;
	state.firstBeatDingSuppressedRows.add(0);
	state.customSubdivisions['0-0'] = 3;
	state.customSubdivisions['0-1'] = 5;
	state.customCellSyllables['0-2'] = 'Ki';
	state.accents.add('0-3');
	state.taDingKeys.add('0-4');
	state.deadCells[0] = { deadStart: 4, displayLen: 5, baseLen: 5 };

	const baseline = clonePressState(state);
	const patch = tilePress(1, 3, state, baseline, 1);
	for (const r of [1, 2]) {
		assert.equal(patch.customSyllables![r], 5);
		assert.equal(patch.customMultipliers![r], 2);
		assert.equal(patch.pulseMeterUnlinked![r], true);
		assert.ok(patch.firstBeatDingSuppressedRows!.has(r));
		assert.equal(patch.customSubdivisions![`${r}-0`], 3);
		assert.equal(patch.customSubdivisions![`${r}-1`], 5);
		assert.equal(patch.customCellSyllables![`${r}-2`], 'Ki');
		assert.ok(patch.accents!.has(`${r}-3`));
		assert.ok(patch.taDingKeys!.has(`${r}-4`));
		assert.deepEqual(patch.deadCells![r], { deadStart: 4, displayLen: 5, baseLen: 5 });
	}
}

/** Drop purges every map for r >= maxBars. */
function testDropAllLayers() {
	const state = makeEmptyState({ bars: 8 });
	for (let r = 0; r < 8; r++) {
		state.customSyllables[r] = 4 + r;
		state.customMultipliers[r] = 2;
		state.pulseMeterUnlinked[r] = true;
		state.firstBeatDingSuppressedRows.add(r);
		state.customSubdivisions[`${r}-0`] = 2;
		state.customCellSyllables[`${r}-1`] = 'Ta';
		state.accents.add(`${r}-2`);
		state.taDingKeys.add(`${r}-3`);
		state.accentsByLane[(r % 2) as LaneId].add(`${r}-2`);
		state.taDingKeysByLane[(r % 2) as LaneId].add(`${r}-3`);
		state.deadCells[r] = { deadStart: 3, displayLen: 4, baseLen: 4 };
	}

	const patch = dropPress(3, state);
	for (const r of [3, 4, 5, 6, 7]) {
		assert.equal(patch.customSyllables![r], undefined, `customSyllables[${r}] must be dropped`);
		assert.equal(patch.customMultipliers![r], undefined);
		assert.equal(patch.pulseMeterUnlinked![r], undefined);
		assert.equal(patch.firstBeatDingSuppressedRows!.has(r), false);
		assert.equal(patch.customSubdivisions![`${r}-0`], undefined);
		assert.equal(patch.customCellSyllables![`${r}-1`], undefined);
		assert.equal(patch.accents!.has(`${r}-2`), false);
		assert.equal(patch.taDingKeys!.has(`${r}-3`), false);
		for (const lane of [0, 1, 2] as const) {
			assert.equal(patch.accentsByLane![lane].has(`${r}-2`), false);
			assert.equal(patch.taDingKeysByLane![lane].has(`${r}-3`), false);
		}
		assert.equal(patch.deadCells![r], undefined);
	}
	for (const r of [0, 1, 2]) {
		assert.equal(patch.customSyllables![r], 4 + r, `customSyllables[${r}] must be retained`);
		assert.ok(patch.accents!.has(`${r}-2`));
	}
}

/** isStateEmpty: empty state and every "single-tainted" variant. */
function testIsStateEmpty() {
	const empty = makeEmptyState();
	assert.equal(isStateEmpty(empty), true);

	const tainted: Array<(s: PressState) => void> = [
		(s) => { s.customSyllables[0] = 5; },
		(s) => { s.customMultipliers[0] = 2; },
		(s) => { s.customSubdivisions['0-0'] = 2; },
		(s) => { s.customCellSyllables['0-0'] = 'Ta'; },
		(s) => { s.accents.add('0-0'); },
		(s) => { s.taDingKeys.add('0-0'); },
		(s) => { s.accentsByLane[1].add('0-0'); },
		(s) => { s.taDingKeysByLane[2].add('0-0'); },
		(s) => { s.firstBeatDingSuppressedRows.add(0); },
		(s) => { s.pulseMeterUnlinked[0] = true; },
		(s) => { s.deadCells[0] = { deadStart: 1, displayLen: 1, baseLen: 1 }; },
	];
	for (const taint of tainted) {
		const s = makeEmptyState();
		taint(s);
		assert.equal(isStateEmpty(s), false, 'tainted state should be non-empty');
	}
}

/** sourceN < 1 / nextM <= prevN: tile must return empty patch. */
function testTileGuards() {
	const state = makeEmptyState({ bars: 0 });
	const baseline = clonePressState(state);

	const p1 = tilePress(0, 4, state, baseline, 0);
	assert.deepEqual(p1, {}, 'sourceN=0 must early-return empty patch');

	const p2 = tilePress(4, 4, state, baseline, 4);
	assert.deepEqual(p2, {}, 'nextM <= prevN must early-return empty patch');

	const p3 = tilePress(4, 2, state, baseline, 4);
	assert.deepEqual(p3, {}, 'shrink direction must early-return empty patch');
}

/** Stale row content in target row must be cleared by tile (no bleed). */
function testTileClearsStaleTarget() {
	const live = makeEmptyState({ bars: 2 });
	live.customSyllables[0] = 5;
	live.accents.add('0-2');
	const baseline = clonePressState(live);

	live.customSyllables[1] = 9;
	live.accents.add('1-7');
	live.customSubdivisions['1-3'] = 4;

	const patch = tilePress(2, 3, live, baseline, 2);
	assert.equal(patch.customSyllables![1], 9, 'pre-existing row 1 must be retained (it is < prevN)');
	assert.ok(patch.accents!.has('1-7'));
	assert.equal(patch.customSubdivisions!['1-3'], 4);
	assert.equal(patch.customSyllables![2], 5, 'row 2 must come from baseline row 0');
	assert.ok(patch.accents!.has('2-2'));
}

/** End-to-end roundtrip: snapshot row, apply into another row, then verify reads back identically. */
function testSnapshotApplyRoundtripIdentity() {
	const state = makeEmptyState({ bars: 4 });
	state.customSyllables[0] = 5;
	state.customMultipliers[0] = 2;
	state.pulseMeterUnlinked[0] = true;
	state.firstBeatDingSuppressedRows.add(0);
	state.customSubdivisions['0-0'] = 3;
	state.customCellSyllables['0-1'] = 'Ki';
	state.accents.add('0-2');
	state.taDingKeys.add('0-3');
	state.deadCells[0] = { deadStart: 4, displayLen: 5, baseLen: 5 };

	const frame = snapshotBarFrame(0, state);
	const patch = applyBarFrame(2, frame, state);
	const next = applyPatchToState(state, patch);
	const readback = snapshotBarFrame(2, next);
	assert.deepEqual(readback, frame, 'roundtrip frame must be identical');
}

const tests: Array<[string, () => void]> = [
	['roundtrip mono', testRoundtripMono],
	['roundtrip poly voices=2', testRoundtripPoly2],
	['roundtrip poly voices=3', testRoundtripPoly3],
	['tile N=1 -> M=4', testTile_N1_to_M4],
	['tile N=2 -> M=5', testTile_N2_to_M5],
	['tile N=3 -> M=7', testTile_N3_to_M7],
	['tile baseline freeze', testBaselineFreeze],
	['tile copies every layer', testTileAllLayers],
	['drop all layers', testDropAllLayers],
	['isStateEmpty', testIsStateEmpty],
	['tile guards (sourceN=0 / nextM<=prevN)', testTileGuards],
	['tile clears stale target row', testTileClearsStaleTarget],
	['snapshot/apply identity', testSnapshotApplyRoundtripIdentity],
];

let failures = 0;
for (const [name, fn] of tests) {
	try {
		fn();
		console.log(`[ok] ${name}`);
	} catch (e) {
		failures++;
		console.error(`[fail] ${name}`);
		console.error(e);
	}
}

if (failures > 0) {
	console.error(`\n${failures} test(s) failed`);
	process.exit(1);
} else {
	console.log(`\nAll ${tests.length} tests passed.`);
}
