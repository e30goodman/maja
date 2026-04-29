import assert from 'node:assert/strict';
import {
	normalizeBarsAndLaneState,
	pruneDeadCellsByBars,
	pruneGridKeySetByBars,
	pruneLaneSetMapByBars,
	pruneNumericRecordByBars,
	pruneStringKeyRecordByBars,
	pruneSuppressedRowsByBars,
	type BarsDomainState,
} from './barsDomain';

function testPruneGridKeySetByBars() {
	const input = new Set(['0-0', '3-1', '4-0', 'bad', '-1-0']);
	const out = pruneGridKeySetByBars(input, 4);
	assert.deepEqual([...out].sort(), ['0-0', '3-1']);
}

function testPruneSuppressedRowsByBars() {
	const input = new Set<number>([0, 2, 5, -1]);
	const out = pruneSuppressedRowsByBars(input, 3);
	assert.deepEqual([...out].sort((a, b) => a - b), [0, 2]);
}

function testPruneNumericRecordByBars() {
	const input: Record<number, number> = { 0: 4, 2: 6, 5: 8 };
	const out = pruneNumericRecordByBars(input, 3);
	assert.deepEqual(out, { 0: 4, 2: 6 });
}

function testPruneDeadCellsByBars() {
	const input = {
		0: { deadStart: 2, displayLen: 4, baseLen: 4 },
		4: { deadStart: 1, displayLen: 4, baseLen: 4 },
	};
	const out = pruneDeadCellsByBars(input, 4);
	assert.deepEqual(out, { 0: { deadStart: 2, displayLen: 4, baseLen: 4 } });
}

function testPruneLaneSetMapByBarsPolyParity() {
	const input = {
		0: new Set<string>(['0-0', '2-0', '3-0']),
		1: new Set<string>(['1-0', '3-1', '4-0']),
		2: new Set<string>(['2-1']),
	} as const;
	const out2Voice = pruneLaneSetMapByBars(
		{ 0: new Set(input[0]), 1: new Set(input[1]), 2: new Set(input[2]) },
		4,
		2,
	);
	assert.deepEqual([...out2Voice[0]].sort(), ['0-0', '2-0']);
	assert.deepEqual([...out2Voice[1]].sort(), ['1-0', '3-1']);
	assert.deepEqual([...out2Voice[2]].sort(), []);
}

function testUpsizeIsNoOp() {
	const accents = new Set(['0-0', '1-0']);
	const suppressed = new Set<number>([0, 1]);
	assert.deepEqual([...pruneGridKeySetByBars(accents, 8)].sort(), ['0-0', '1-0']);
	assert.deepEqual([...pruneSuppressedRowsByBars(suppressed, 8)].sort((a, b) => a - b), [0, 1]);
}

function testPruneStringKeyRecordByBars() {
	const input: Record<string, number> = {
		'0-0': 2,
		'0-3': 4,
		'3-1': 3,
		'5-2': 2,
		'bad-key': 1,
		'-1-0': 2,
	};
	const out = pruneStringKeyRecordByBars(input, 4);
	assert.deepEqual(Object.keys(out).sort(), ['0-0', '0-3', '3-1']);
	assert.equal(out['5-2'], undefined);
	/** input не мутирован. */
	assert.equal(input['5-2'], 2);
}

function makeState(): BarsDomainState {
	return {
		accents: new Set(['0-1', '3-2', '5-0']),
		taDingKeys: new Set(['1-0', '4-1', '6-3']),
		accentsByLane: {
			0: new Set(['0-1', '2-0']),
			1: new Set(['1-0', '3-1', '5-0']),
			2: new Set<string>(),
		},
		taDingKeysByLane: {
			0: new Set(['0-2', '4-1']),
			1: new Set(['1-0', '3-0', '7-1']),
			2: new Set<string>(),
		},
		firstBeatDingSuppressedRows: new Set([0, 2, 4, 6]),
		firstBeatAccentByLane: { 0: true, 1: false, 2: true },
		deadCells: {
			0: { deadStart: 2, displayLen: 4, baseLen: 4 },
			2: { deadStart: 3, displayLen: 4, baseLen: 4 },
			5: { deadStart: 1, displayLen: 4, baseLen: 4 },
		},
		customSyllables: { 0: 4, 1: 5, 4: 3 },
		customMultipliers: { 0: 2, 4: 3 },
		pulseMeterUnlinked: { 0: true, 4: true },
		customSubdivisions: { '0-1': 2, '3-0': 3, '5-1': 4 },
	};
}

function testNormalizeDownsizeDropsOutOfRange() {
	const input = makeState();
	const { state, report } = normalizeBarsAndLaneState(input, 4, 2, false);

	assert.deepEqual([...state.accents].sort(), ['0-1', '3-2']);
	assert.deepEqual([...state.taDingKeys].sort(), ['1-0']);
	assert.deepEqual([...state.firstBeatDingSuppressedRows].sort(), [0, 2]);
	assert.deepEqual(Object.keys(state.deadCells).sort(), ['0', '2']);
	assert.deepEqual(state.customSyllables, { 0: 4, 1: 5 });
	assert.deepEqual(state.customMultipliers, { 0: 2 });
	assert.deepEqual(state.pulseMeterUnlinked, { 0: true });
	assert.deepEqual(Object.keys(state.customSubdivisions).sort(), ['0-1', '3-0']);
	assert.equal(report.prunedAnything, true);
	assert.ok(report.changedFields.includes('accents'));
	assert.ok(report.changedFields.includes('firstBeatDingSuppressedRows'));
}

function testNormalizeUpsizeIsNoOp() {
	const input = makeState();
	const { state, report } = normalizeBarsAndLaneState(input, 16, 2, false);

	/** Все значения остаются, новые строки не создаются. */
	assert.equal(state.accents.size, input.accents.size);
	assert.equal(state.firstBeatDingSuppressedRows.size, input.firstBeatDingSuppressedRows.size);
	assert.equal(Object.keys(state.customSubdivisions).length, Object.keys(input.customSubdivisions).length);
	assert.equal(report.prunedAnything, false);
}

function testNormalizePolyLaneBleedCleanup() {
	/** В poly 2-voice: row 0 принадлежит lane0, row 1 — lane1.
	 * Ghost — это когда lane-контейнер содержит ключ не своей lane.
	 * Используем ключи, которых изначально нет в "правильной" lane,
	 * чтобы проверить именно удаление lane-bleed, а не общий prune.
	 */
	const input: BarsDomainState = {
		accents: new Set<string>(),
		taDingKeys: new Set<string>(),
		accentsByLane: {
			0: new Set(['1-1']),     // ghost: row 1 принадлежит lane1.
			1: new Set(['0-3']),     // ghost: row 0 принадлежит lane0.
			2: new Set<string>(),
		},
		taDingKeysByLane: {
			0: new Set(['3-2']),     // ghost: row 3 принадлежит lane1.
			1: new Set(['2-0']),     // ghost: row 2 принадлежит lane0.
			2: new Set<string>(),
		},
		firstBeatDingSuppressedRows: new Set<number>(),
		firstBeatAccentByLane: { 0: true, 1: false, 2: false },
		deadCells: {},
		customSyllables: {},
		customMultipliers: {},
		pulseMeterUnlinked: {},
		customSubdivisions: {},
	};

	const { state } = normalizeBarsAndLaneState(input, 4, 2, true);

	/** Lane-bleed в lane-контейнерах очищен. */
	assert.equal(state.accentsByLane[0].has('1-1'), false, 'ghost accent в lane0 должен быть удалён');
	assert.equal(state.accentsByLane[1].has('0-3'), false, 'ghost accent в lane1 должен быть удалён');
	assert.equal(state.taDingKeysByLane[0].has('3-2'), false, 'ghost Ta в lane0 должен быть удалён');
	assert.equal(state.taDingKeysByLane[1].has('2-0'), false, 'ghost Ta в lane1 должен быть удалён');

	/** В poly плоские set'ы пересчитаны из lane — без ghost-ов. */
	assert.equal(state.accents.size, 0);
	assert.equal(state.taDingKeys.size, 0);
}

function testNormalizeDoesNotMutateInput() {
	const input = makeState();
	const snapshot = {
		accents: [...input.accents].sort(),
		supRows: [...input.firstBeatDingSuppressedRows].sort(),
		subCount: Object.keys(input.customSubdivisions).length,
	};
	normalizeBarsAndLaneState(input, 2, 2, true);
	assert.deepEqual([...input.accents].sort(), snapshot.accents);
	assert.deepEqual([...input.firstBeatDingSuppressedRows].sort(), snapshot.supRows);
	assert.equal(Object.keys(input.customSubdivisions).length, snapshot.subCount);
}

function testNormalizeBarsOneRegression() {
	/** bars=1 scenario: после downsize все строки `r >= 1` уходят. */
	const input = makeState();
	const { state } = normalizeBarsAndLaneState(input, 1, 2, false);
	for (const key of state.accents) {
		const r = parseInt(key.split('-')[0] ?? '', 10);
		assert.ok(r >= 0 && r < 1, `accent ${key} должен быть в rows < 1`);
	}
	for (const key of state.taDingKeys) {
		const r = parseInt(key.split('-')[0] ?? '', 10);
		assert.ok(r >= 0 && r < 1);
	}
	for (const r of state.firstBeatDingSuppressedRows) {
		assert.ok(r >= 0 && r < 1);
	}
	for (const key of Object.keys(state.customSubdivisions)) {
		const r = parseInt(key.split('-')[0] ?? '', 10);
		assert.ok(r >= 0 && r < 1);
	}
}

function testNormalizeRoundtripDownsizeUpsizeDoesNotResurrectStale() {
	/**
	 * Downsize до 2, затем upsize обратно до 8: данные не должны «воскресать»
	 * для row >= 2. Это фиксирует контракт "upsize инициализирует только default".
	 */
	const input = makeState();
	const { state: afterDown } = normalizeBarsAndLaneState(input, 2, 2, true);
	const { state: afterUp } = normalizeBarsAndLaneState(afterDown, 8, 2, true);

	for (const key of afterUp.accents) {
		const r = parseInt(key.split('-')[0] ?? '', 10);
		assert.ok(r < 2, `после roundtrip не должно быть row ${r} >= 2 в accents`);
	}
	for (const r of afterUp.firstBeatDingSuppressedRows) {
		assert.ok(r < 2);
	}
}

function run() {
	testPruneGridKeySetByBars();
	testPruneSuppressedRowsByBars();
	testPruneNumericRecordByBars();
	testPruneDeadCellsByBars();
	testPruneLaneSetMapByBarsPolyParity();
	testUpsizeIsNoOp();
	testPruneStringKeyRecordByBars();
	testNormalizeDownsizeDropsOutOfRange();
	testNormalizeUpsizeIsNoOp();
	testNormalizePolyLaneBleedCleanup();
	testNormalizeDoesNotMutateInput();
	testNormalizeBarsOneRegression();
	testNormalizeRoundtripDownsizeUpsizeDoesNotResurrectStale();
	console.log('barsDomain tests passed');
}

run();

