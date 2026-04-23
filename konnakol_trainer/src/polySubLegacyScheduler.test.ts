/**
 * Запуск: `npx tsx src/polySubLegacyScheduler.test.ts` из каталога konnakol_trainer.
 */
import assert from 'node:assert/strict';
import {
	advancePolyLaneAfterEmit,
	buildLaneBarIndices,
	createPolySubLegacyScheduler,
} from './polySubLegacyScheduler';

function testBuildLaneBarIndices() {
	const two = buildLaneBarIndices(4, 2);
	assert.deepEqual(two[0], [0, 2]);
	assert.deepEqual(two[1], [1, 3]);
	const three = buildLaneBarIndices(5, 3);
	assert.deepEqual(three[0], [0, 3]);
	assert.deepEqual(three[1], [1, 4]);
	assert.deepEqual(three[2], [2]);
}

function testAdvancePolyLaneAfterEmit() {
	assert.deepEqual(advancePolyLaneAfterEmit(2, 4, 3), { nextC: 0, advanceBar: false });
	assert.deepEqual(advancePolyLaneAfterEmit(3, 4, undefined), { nextC: 0, advanceBar: true });
	assert.deepEqual(advancePolyLaneAfterEmit(0, 4, undefined), { nextC: 1, advanceBar: false });
}

function testFillLookaheadMonotone() {
	const events: { bar: number; c: number; t: number }[] = [];
	const sch = createPolySubLegacyScheduler({
		polyVoices: () => 2,
		barCount: () => 4,
		getBarTimeWindowSeconds: (bar) => {
			const syl = bar === 3 ? 5 : 4;
			return syl * 0.25;
		},
		getRowSyllables: (bar) => (bar === 3 ? 5 : 4),
		getDeadStart: (bar) => (bar === 1 ? 3 : undefined),
		emit: (bar, c, _absR, t, _voice, _step, _dBar) => {
			events.push({ bar, c, t });
		},
	});
	sch.reset(100);
	sch.fillLookahead(100.85);
	const byBar = new Map<number, number[]>();
	for (const e of events) {
		const arr = byBar.get(e.bar) ?? [];
		arr.push(e.t);
		byBar.set(e.bar, arr);
	}
	for (const [, times] of byBar) {
		for (let i = 1; i < times.length; i++) {
			assert.ok(times[i]! > times[i - 1]!, 'times strictly increase per bar');
		}
	}
	const bar1 = events.filter((e) => e.bar === 1).map((e) => e.c);
	assert.ok(bar1.includes(0) && bar1.includes(1) && bar1.includes(2), 'lane1 uses live cells');
}

testBuildLaneBarIndices();
testAdvancePolyLaneAfterEmit();
testFillLookaheadMonotone();
console.log('polySubLegacyScheduler.test.ts: ok');
