import assert from 'node:assert/strict';
import {
	normalizeBarsAndLaneState,
	pruneGridKeySetByBars,
	pruneLaneSetMapByBars,
	pruneSuppressedRowsByBars,
	type BarsDomainState,
} from './barsDomain';

/**
 * Corrupted snapshot negative test:
 * Проверяем, что `normalizeBarsAndLaneState` справляется с «грязным» входом:
 * - ключи с нечисловым row,
 * - out-of-range row (r >= totalBars или r < 0),
 * - lane-bleed (ключ в неправильной lane),
 * - lane >= voices (lane2 при voices=2),
 * - lane boolean через JSON (true/false),
 * - dead-cells с неразумными значениями.
 *
 * Ожидание: нормализатор не бросает exceptions, возвращает чистый state без ghost Ta
 * и без lane bleed, flat derived = lane-derived в poly.
 */

function makeCorruptedInput(): BarsDomainState {
	return {
		accents: new Set<string>([
			'0-1', // valid
			'not-a-row', // garbage
			'-5-0', // negative row
			'99-0', // out-of-range
			'4-2', // will be out after prune (bars=4)
		]),
		taDingKeys: new Set<string>([
			'1-0',
			'3-0',
			'abc',
			'10-1',
			'-3-2',
		]),
		accentsByLane: {
			0: new Set(['0-1', '1-2']), /** ghost: row 1 → lane1. */
			1: new Set(['1-0', '3-0', '0-2']), /** ghost: row 0 → lane0. */
			2: new Set(['2-3']),
		},
		taDingKeysByLane: {
			0: new Set(['0-0', '3-1']), /** ghost: row 3 → lane1. */
			1: new Set(['bad-key', '1-1']),
			2: new Set<string>(),
		},
		firstBeatDingSuppressedRows: new Set([0, 2, 99, -1]),
		firstBeatAccentByLane: { 0: true, 1: false, 2: false },
		deadCells: {
			0: { deadStart: 2, displayLen: 4, baseLen: 4 },
			99: { deadStart: 1, displayLen: 4, baseLen: 4 },
		},
		customSyllables: { 0: 4, 99: 5, '-1': 3 } as unknown as Record<number, number>,
		customMultipliers: { 1: 2, 100: 3 },
		pulseMeterUnlinked: { 0: true, 8: true },
		customSubdivisions: { '0-1': 2, '99-0': 3, 'garbage': 4 },
	};
}

function testCorruptedSnapshotDoesNotThrow() {
	const input = makeCorruptedInput();
	const r = normalizeBarsAndLaneState(input, 4, 2, true);
	assert.ok(r.state, 'нормализатор должен вернуть state, а не throw');
}

function testCorruptedOutOfRangeFiltered() {
	const input = makeCorruptedInput();
	const { state } = normalizeBarsAndLaneState(input, 4, 2, true);
	for (const key of state.accents) {
		const r = parseInt(key.split('-')[0] ?? '', 10);
		assert.ok(Number.isFinite(r) && r >= 0 && r < 4, `accent ${key} в допустимом диапазоне`);
	}
	for (const r of state.firstBeatDingSuppressedRows) {
		assert.ok(r >= 0 && r < 4, `suppressed row ${r} в допустимом диапазоне`);
	}
	for (const key of Object.keys(state.deadCells)) {
		const r = parseInt(key, 10);
		assert.ok(Number.isFinite(r) && r >= 0 && r < 4);
	}
	for (const key of Object.keys(state.customSyllables)) {
		const r = parseInt(key, 10);
		assert.ok(Number.isFinite(r) && r >= 0 && r < 4);
	}
	for (const key of Object.keys(state.customSubdivisions)) {
		const r = parseInt(key.split('-')[0] ?? '', 10);
		assert.ok(Number.isFinite(r) && r >= 0 && r < 4);
	}
}

function testCorruptedLaneBleedCleaned() {
	const input = makeCorruptedInput();
	const { state } = normalizeBarsAndLaneState(input, 4, 2, true);
	for (const lane of [0, 1, 2] as const) {
		for (const key of state.accentsByLane[lane]) {
			const row = parseInt(key.split('-')[0] ?? '', 10);
			const expectedLane = row % 2; /** 2-voice. */
			assert.equal(expectedLane, lane, `accentsByLane[${lane}]: ключ ${key} не в своей lane`);
		}
		for (const key of state.taDingKeysByLane[lane]) {
			const row = parseInt(key.split('-')[0] ?? '', 10);
			const expectedLane = row % 2;
			assert.equal(expectedLane, lane, `taDingKeysByLane[${lane}]: ключ ${key} не в своей lane`);
		}
	}
}

function testCorruptedPolyFlatDerivedFromLane() {
	/** В poly плоские set'ы = union lane-контейнеров (без ghost). */
	const input = makeCorruptedInput();
	const { state } = normalizeBarsAndLaneState(input, 4, 2, true);
	const rebuilt = new Set<string>();
	for (const lane of [0, 1, 2] as const) {
		for (const key of state.accentsByLane[lane]) rebuilt.add(key);
	}
	assert.equal(state.accents.size, rebuilt.size);
	for (const key of rebuilt) {
		assert.ok(state.accents.has(key), `flat accents должен содержать ${key} из lane-контейнера`);
	}
}

function testCorruptedNoGhostTaInLaneGtZero() {
	/** В poly lane>0 не получает ghost Ta от accent на c0 или от lane0 ключей. */
	const input = makeCorruptedInput();
	const { state } = normalizeBarsAndLaneState(input, 4, 2, true);
	for (const key of state.taDingKeysByLane[1]) {
		const row = parseInt(key.split('-')[0] ?? '', 10);
		assert.equal(row % 2, 1, `ghost Ta в lane1: ${key}`);
	}
}

/**
 * Идемпотентность: повторная нормализация уже нормализованного state
 * не должна менять результат.
 */
function testIdempotent() {
	const input = makeCorruptedInput();
	const a = normalizeBarsAndLaneState(input, 4, 2, true).state;
	const b = normalizeBarsAndLaneState(a, 4, 2, true).state;
	assert.equal(a.accents.size, b.accents.size);
	assert.equal(a.firstBeatDingSuppressedRows.size, b.firstBeatDingSuppressedRows.size);
	assert.equal(Object.keys(a.customSubdivisions).length, Object.keys(b.customSubdivisions).length);
}

/**
 * Проверка что helper'ы прунинга также устойчивы к corrupted входу.
 */
function testPruneHelpersRobustness() {
	const bad = new Set(['', 'abc', '-1-0', '100-0', '0-0', '3-5']);
	const out = pruneGridKeySetByBars(bad, 4);
	assert.ok(out.has('0-0'));
	assert.ok(out.has('3-5'));
	assert.equal(out.has('100-0'), false);
	assert.equal(out.has('abc'), false);

	const badSup = new Set([0, -1, 99, NaN, 2]);
	const outSup = pruneSuppressedRowsByBars(badSup, 4);
	assert.deepEqual([...outSup].sort((a, b) => a - b), [0, 2]);

	const badLanes = pruneLaneSetMapByBars(
		{ 0: new Set(['0-0', 'x', '-1-0']), 1: new Set(['1-1', '0-1']), 2: new Set<string>() },
		4,
		2,
	);
	assert.ok(badLanes[0].has('0-0'));
	assert.equal(badLanes[0].has('x'), false);
	assert.equal(badLanes[1].has('0-1'), false, 'lane1 не должен содержать row0 ключ');
}

function run() {
	testCorruptedSnapshotDoesNotThrow();
	testCorruptedOutOfRangeFiltered();
	testCorruptedLaneBleedCleaned();
	testCorruptedPolyFlatDerivedFromLane();
	testCorruptedNoGhostTaInLaneGtZero();
	testIdempotent();
	testPruneHelpersRobustness();
	console.log('snapshotCorruption tests passed');
}

run();
