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
	/* одна живая клетка: после c=0 следующий индекс уходит в мёртвую зону → nextC 0 без advanceBar */
	assert.deepEqual(advancePolyLaneAfterEmit(0, 4, 1), { nextC: 0, advanceBar: false });
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
	const barsHitVoice1 = new Set(events.filter((e) => e.bar % 2 === 1).map((e) => e.bar));
	assert.ok(barsHitVoice1.has(3), 'lane1 must advance to bar 3 after dead-wrap on bar 1, not stick on bar 1');
}

/** Три мёртвых из четырёх: `deadStart === 1` — только c=0; линия должна уходить на следующий такт, не висеть. */
function testFillLookaheadSingleLiveCellNotStuck() {
	const events: { bar: number; c: number; voice: number }[] = [];
	const sch = createPolySubLegacyScheduler({
		polyVoices: () => 2,
		barCount: () => 4,
		getBarTimeWindowSeconds: () => 4,
		getRowSyllables: () => 4,
		getDeadStart: () => 1,
		emit: (bar, c, _absR, _t, voice) => {
			events.push({ bar, c, voice });
		},
	});
	sch.reset(0);
	sch.fillLookahead(80);
	assert.ok(
		events.some((e) => e.voice === 0 && e.bar === 2),
		'lane0 must reach bar 2 after single-live-cell bars, not stuck on bar 0',
	);
	assert.ok(events.every((e) => e.c === 0), 'only live column is 0');
}

testBuildLaneBarIndices();
testAdvancePolyLaneAfterEmit();
testFillLookaheadMonotone();
testFillLookaheadSingleLiveCellNotStuck();
console.log('polySubLegacyScheduler.test.ts: ok');
