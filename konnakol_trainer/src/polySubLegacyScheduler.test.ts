/**
 * Run: `npx tsx src/polySubLegacyScheduler.test.ts` from the `konnakol_trainer` directory.
 */
import assert from 'node:assert/strict';
import {
	advancePolyLaneAfterEmit,
	buildLaneBarIndices,
	createPolySubLegacyScheduler,
	type PolySubLegacyDeps,
} from './polySubLegacyScheduler';
import { getFusedBarTimeWindowSeconds, getFusedCellDurationSeconds } from './fusedBarGroups';

function withDefaultStepDur(
	partial: Omit<PolySubLegacyDeps, 'getStepDurationSeconds'> &
		Partial<Pick<PolySubLegacyDeps, 'getStepDurationSeconds'>>,
): PolySubLegacyDeps {
	const getBarTimeWindowSeconds = partial.getBarTimeWindowSeconds;
	const getRowSyllables = partial.getRowSyllables;
	return {
		...partial,
		getStepDurationSeconds:
			partial.getStepDurationSeconds ??
			((bar, _c) => getBarTimeWindowSeconds(bar) / Math.max(1, getRowSyllables(bar))),
	};
}

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
	/* one live cell: after c=0 next index goes to dead zone -> nextC 0 without advanceBar */
	assert.deepEqual(advancePolyLaneAfterEmit(0, 4, 1), { nextC: 0, advanceBar: false });
}

function testFillLookaheadMonotone() {
	const events: { bar: number; c: number; t: number }[] = [];
	const sch = createPolySubLegacyScheduler(
		withDefaultStepDur({
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
		}),
	);
	sch.reset(100);
	sch.fillLookahead(101.15);
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

/** Three dead out of four: `deadStart === 1` means only c=0; lane must advance to next bar, not hang. */
function testFillLookaheadSingleLiveCellNotStuck() {
	const events: { bar: number; c: number; voice: number }[] = [];
	const sch = createPolySubLegacyScheduler(
		withDefaultStepDur({
			polyVoices: () => 2,
			barCount: () => 4,
			getBarTimeWindowSeconds: () => 4,
			getRowSyllables: () => 4,
			getDeadStart: () => 1,
			emit: (bar, c, _absR, _t, voice) => {
				events.push({ bar, c, voice });
			},
		}),
	);
	sch.reset(0);
	sch.fillLookahead(80);
	assert.ok(
		events.some((e) => e.voice === 0 && e.bar === 2),
		'lane0 must reach bar 2 after single-live-cell bars, not stuck on bar 0',
	);
	assert.ok(events.some((e) => e.c === 0), 'single-live pattern must still emit c0');
}

/** Lane-head bar with single live cell: emit c0, then phantom c1 (silent downstream), then advance. */
function testLaneHeadSingleLiveCellInsertsPhantomSecondCell() {
	const events: { bar: number; c: number; voice: number }[] = [];
	const sch = createPolySubLegacyScheduler(
		withDefaultStepDur({
			polyVoices: () => 2,
			barCount: () => 4,
			getBarTimeWindowSeconds: () => 4,
			getRowSyllables: () => 4,
			getDeadStart: (bar) => (bar === 0 ? 1 : undefined),
			emit: (bar, c, _absR, _t, voice) => {
				events.push({ bar, c, voice });
			},
		}),
	);
	sch.reset(0);
	sch.fillLookahead(12);
	const lane0Bar0 = events.filter((e) => e.voice === 0 && e.bar === 0).map((e) => e.c);
	assert.ok(lane0Bar0.includes(0), 'lane-head single-live row must still emit c0');
	assert.ok(lane0Bar0.includes(1), 'lane-head single-live row must insert phantom c1 before advancing');
	assert.ok(
		events.some((e) => e.voice === 0 && e.bar === 2),
		'lane0 must advance to next bar after phantom step',
	);
}

/** Truncation: partial-dead tail is dropped; fully-dead bar is skipped with zero time. */
function testSecondLaneBarFullyDeadSkipsWithZeroTime() {
	const events: { bar: number; c: number; voice: number; t: number }[] = [];
	const sch = createPolySubLegacyScheduler(
		withDefaultStepDur({
			polyVoices: () => 2,
			barCount: () => 6, // lane1 bars: 1,3,5
			getBarTimeWindowSeconds: () => 4,
			getRowSyllables: () => 4,
			getDeadStart: (bar) => {
				if (bar === 1) return 2; // first lane bar: partial dead
				if (bar === 3) return 0; // second lane bar: fully dead
				return undefined;
			},
			emit: (bar, c, _absR, t, voice) => {
				events.push({ bar, c, voice, t });
			},
		}),
	);
	sch.reset(0);
	sch.fillLookahead(40);
	const lane1Bar5First = events.find((e) => e.voice === 1 && e.bar === 5);
	assert.ok(lane1Bar5First, 'lane1 must jump to third lane bar (bar 5)');
	const lane1Bar1BeforeBar5 = events
		.filter((e) => e.voice === 1 && e.bar === 1 && e.t < lane1Bar5First.t)
		.at(-1);
	assert.ok(lane1Bar1BeforeBar5, 'lane1 first bar must emit before first bar5 hit');
	assert.equal(
		lane1Bar5First.t,
		lane1Bar1BeforeBar5.t + 1, // after last emitted step, scheduler jumps directly to next live bar
		'truncation policy: dead tail + fully-dead bar consume zero extra time',
	);
	assert.ok(!events.some((e) => e.voice === 1 && e.bar === 3), 'fully-dead bar must be fully skipped');
}

/** Fully dead row: `deadStart === 0` means no emits for that bar, lane must still advance. */
function testFillLookaheadFullyDeadRowAdvancesWithoutEmit() {
	const events: { bar: number; c: number; voice: number }[] = [];
	const sch = createPolySubLegacyScheduler(
		withDefaultStepDur({
			polyVoices: () => 2,
			barCount: () => 4,
			getBarTimeWindowSeconds: () => 4,
			getRowSyllables: () => 4,
			getDeadStart: (bar) => (bar === 1 ? 0 : undefined),
			emit: (bar, c, _absR, _t, voice) => {
				events.push({ bar, c, voice });
			},
		}),
	);
	sch.reset(0);
	sch.fillLookahead(80);
	assert.ok(
		events.some((e) => e.voice === 1 && e.bar === 3),
		'lane1 must advance past fully-dead bar 1 to bar 3',
	);
	assert.ok(!events.some((e) => e.bar === 1), 'fully-dead bar must not emit events');
}

function testMixedBarLengthsProduceInterleaving() {
	const events: { bar: number; voice: number; t: number }[] = [];
	const sch = createPolySubLegacyScheduler(
		withDefaultStepDur({
			polyVoices: () => 3,
			barCount: () => 6,
			getBarTimeWindowSeconds: (bar) => (bar % 3 === 0 ? 0.5 : bar % 3 === 1 ? 0.75 : 1.0),
			getRowSyllables: (bar) => (bar % 3 === 0 ? 2 : bar % 3 === 1 ? 3 : 4),
			getDeadStart: () => undefined,
			emit: (bar, _c, _absR, t, voice) => {
				events.push({ bar, voice, t });
			},
		}),
	);
	sch.reset(12);
	sch.fillLookahead(13.5);
	assert.ok(events.length > 0, 'scheduler must emit events');
	const byVoice = new Map<number, number[]>();
	for (const e of events) {
		const arr = byVoice.get(e.voice) ?? [];
		arr.push(e.t);
		byVoice.set(e.voice, arr);
	}
	for (const [voice, times] of byVoice) {
		for (let i = 1; i < times.length; i++) {
			assert.ok(times[i]! > times[i - 1]!, `voice ${voice} time must be monotone`);
		}
	}
}

function testLaneBoundaryCallbackPerVoice() {
	const boundaries: { prevBar: number; laneId: number; wrappedPattern: boolean }[] = [];
	const sch = createPolySubLegacyScheduler(
		withDefaultStepDur({
			polyVoices: () => 2,
			barCount: () => 4,
			getBarTimeWindowSeconds: () => 1,
			getRowSyllables: () => 2,
			getDeadStart: () => undefined,
			emit: () => {},
			onLaneBarBoundary: (prevBar, laneId, wrappedPattern) => {
				boundaries.push({ prevBar, laneId, wrappedPattern });
			},
		}),
	);
	sch.reset(0);
	sch.fillLookahead(6);
	assert.ok(boundaries.some((x) => x.laneId === 0), 'lane 0 must report boundaries');
	assert.ok(boundaries.some((x) => x.laneId === 1), 'lane 1 must report boundaries');
	assert.ok(boundaries.some((x) => x.wrappedPattern), 'wrappedPattern must eventually be true');
}

/** Fused lane0 bars 0+2 (jati 9+2): two physical bars consume one pulse-sum window, not 2x. */
function testFusedBarsShareOneWindowOnLane() {
	const group = { bars: [0, 2] };
	const customSyllables = { 0: 9, 2: 2 };
	const tempo = 100;
	const fusedWin = getFusedBarTimeWindowSeconds(
		{ laneId: 0, bars: [0, 2] },
		customSyllables,
		4,
		{},
		{},
		tempo,
	);
	const unfusedTotal = fusedWin * 2;
	const events: { bar: number; t: number }[] = [];
	const sch = createPolySubLegacyScheduler(
		withDefaultStepDur({
			polyVoices: () => 2,
			barCount: () => 4,
			getBarTimeWindowSeconds: (bar) => {
				if (bar === 0 || bar === 2) return fusedWin;
				return 1;
			},
			getRowSyllables: (bar) => (bar === 0 ? 9 : bar === 2 ? 2 : 4),
			getDeadStart: () => undefined,
			getStepDurationSeconds: (bar, _c) =>
				getFusedCellDurationSeconds(
					{ laneId: 0, bars: [0, 2] },
					customSyllables,
					4,
					{},
					{},
					tempo,
					{},
				),
			barsInSameFusedBlock: (a, b) => group.bars.includes(a) && group.bars.includes(b),
			getFusedGroup: (bar) => (group.bars.includes(bar) ? group : null),
			emit: (bar, _c, _absR, t) => {
				events.push({ bar, t });
			},
		}),
	);
	sch.reset(0);
	sch.fillLookahead(fusedWin * 1.1);
	const lane0 = events.filter((e) => e.bar === 0 || e.bar === 2);
	assert.ok(lane0.length >= 11, 'fused lane must emit all cells');
	const span = lane0[lane0.length - 1]!.t - lane0[0]!.t;
	assert.ok(span < unfusedTotal * 0.9, 'fused span must be ~one window not two');
}

/** Playhead `step` must follow physical bar row (floor(bar/V)), not fused-leader step. */
function testEmitPlayheadStepUsesPhysicalBarIndex() {
	const group = { laneId: 1, bars: [1, 3] };
	const steps: { bar: number; step: number; r: number }[] = [];
	const sch = createPolySubLegacyScheduler(
		withDefaultStepDur({
			polyVoices: () => 2,
			barCount: () => 4,
			getBarTimeWindowSeconds: () => 2,
			getRowSyllables: () => 4,
			getDeadStart: () => undefined,
			getFusedGroup: (bar) => (group.bars.includes(bar) ? group : null),
			emit: (bar, _c, absR, _t, _voice, step) => {
				steps.push({ bar, step, r: absR });
			},
		}),
	);
	sch.reset(0);
	sch.fillLookahead(20);
	const bar3 = steps.find((e) => e.bar === 3);
	assert.ok(bar3, 'lane1 must emit bar 3');
	assert.equal(bar3!.step, 1, 'bar 3 is cycle step 1, not leader step 0');
	assert.equal(bar3!.r, 3, 'playhead row index follows physical bar');
}

testBuildLaneBarIndices();
testAdvancePolyLaneAfterEmit();
testFusedBarsShareOneWindowOnLane();
testEmitPlayheadStepUsesPhysicalBarIndex();
testFillLookaheadMonotone();
testFillLookaheadSingleLiveCellNotStuck();
testLaneHeadSingleLiveCellInsertsPhantomSecondCell();
testSecondLaneBarFullyDeadSkipsWithZeroTime();
testFillLookaheadFullyDeadRowAdvancesWithoutEmit();
testMixedBarLengthsProduceInterleaving();
testLaneBoundaryCallbackPerVoice();
console.log('polySubLegacyScheduler.test.ts: ok');
