import assert from 'node:assert/strict';
import {
	pruneDeadCellsByBars,
	pruneGridKeySetByBars,
	pruneLaneSetMapByBars,
	pruneNumericRecordByBars,
	pruneSuppressedRowsByBars,
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

function run() {
	testPruneGridKeySetByBars();
	testPruneSuppressedRowsByBars();
	testPruneNumericRecordByBars();
	testPruneDeadCellsByBars();
	testPruneLaneSetMapByBarsPolyParity();
	testUpsizeIsNoOp();
	console.log('barsDomain tests passed');
}

run();

