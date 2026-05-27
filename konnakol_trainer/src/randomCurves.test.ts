/**
 * Tests for konnakol random logic (see randomLogic.ts).
 * Run: `npx tsx src/randomCurves.test.ts` from the `konnakol_trainer` directory.
 */
import assert from 'node:assert/strict';
import {
	applyRandomizerEffectsToBar,
	barSpeedChangeProbFromChaos,
	buildLegacyPlaybackSequence,
	cellSpeedExtendedBlendFromChaos,
	cellSpeedHitPFromChaos,
	mulberry32,
	patternChangeProbFromChaos,
	pickAccentCountForBar,
	pickRandomCellSpeedSubdiv,
	pickRandomPulsationMeter,
	pulsationChangeProbFromChaos,
	pulsationPoolForChaos,
	smoothstep01,
	speedChangeProbFromChaos,
	type BarRandomizerMutable,
} from './randomLogic';

const makeEmptyState = (): BarRandomizerMutable => ({
	customSyllables: {},
	accents: new Set<string>(),
	customSubdivisions: {},
	customCellSyllables: {},
	customMultipliers: {},
	deadCells: {},
});

/** All probability curves must be monotone non-decreasing and stay within [0, 1]. */
function testChangeProbCurvesMonotoneAndBounded() {
	const fns: [string, (c: number) => number][] = [
		['pulsationChangeProb', pulsationChangeProbFromChaos],
		['patternChangeProb', patternChangeProbFromChaos],
		['speedChangeProb', speedChangeProbFromChaos],
		['barSpeedChangeProb', barSpeedChangeProbFromChaos],
		['cellSpeedHitP', cellSpeedHitPFromChaos],
	];
	for (const [name, fn] of fns) {
		let prev = fn(0);
		assert.ok(prev >= 0 && prev <= 1, `${name}(0)=${prev} out of [0,1]`);
		for (let c = 1; c <= 100; c++) {
			const v = fn(c);
			assert.ok(v >= 0 && v <= 1, `${name}(${c})=${v} out of [0,1]`);
			assert.ok(
				v + 1e-12 >= prev,
				`${name} not monotone non-decreasing at c=${c}: prev=${prev} v=${v}`,
			);
			// No jumps > 0.05 per step 1 - curve should be smooth.
			assert.ok(
				v - prev <= 0.05 + 1e-12,
				`${name} jump >0.05 at c=${c}: prev=${prev} v=${v}`,
			);
			prev = v;
		}
	}
}

/** cellSpeedHitPFromChaos: continuity at 25/26 boundary. */
function testCellSpeedHitPContinuityAt25() {
	const at25 = cellSpeedHitPFromChaos(25);
	const at26 = cellSpeedHitPFromChaos(26);
	assert.ok(Math.abs(at26 - at25) < 0.01, `cliff at 25→26: ${at25} → ${at26}`);
	assert.ok(at25 > 0.14 && at25 < 0.16, `at25=${at25} expected ~0.15`);
}

/** smoothstep01: boundaries + 3t^2-2t^3. */
function testSmoothstep() {
	assert.equal(smoothstep01(-1), 0);
	assert.equal(smoothstep01(0), 0);
	assert.equal(smoothstep01(1), 1);
	assert.equal(smoothstep01(2), 1);
	assert.ok(Math.abs(smoothstep01(0.5) - 0.5) < 1e-9);
}

/** pickAccentCountForBar: for small pulses (curSyl<=3), floor is 1 regardless of chaos. */
function testPickAccentCountMinForSmallBar() {
	const rng = mulberry32(42);
	for (let curSyl = 1; curSyl <= 3; curSyl++) {
		for (let chaos = 0; chaos <= 100; chaos += 5) {
			for (let i = 0; i < 20; i++) {
				const n = pickAccentCountForBar(chaos, curSyl, rng);
				assert.ok(
					n >= 1 && n <= curSyl,
					`accentCount(chaos=${chaos}, curSyl=${curSyl}) = ${n} — expected 1..${curSyl}`,
				);
			}
		}
	}
}

/** pickAccentCountForBar: 0 for curSyl<1. */
function testPickAccentCountZeroOnEmpty() {
	assert.equal(pickAccentCountForBar(50, 0, mulberry32(1)), 0);
}

/** Pulsation pools: 1 and 2 are excluded at all chaos levels (Tala Shastra). */
function testPulsationPoolsExclude1And2() {
	for (let chaos = 0; chaos <= 100; chaos += 5) {
		const pool = pulsationPoolForChaos(chaos);
		assert.ok(!pool.includes(1), `chaos=${chaos}: pool contains 1 (forbidden Anga)`);
		assert.ok(!pool.includes(2), `chaos=${chaos}: pool contains 2 (forbidden Anga)`);
		assert.ok(pool.includes(3), `chaos=${chaos}: pool missing 3 (Tisra base)`);
	}
}

/** pickRandomPulsationMeter: result is always from pulsationPoolForChaos(chaos), never 1/2. */
function testPickPulsationMeterInPool() {
	for (const chaos of [0, 10, 30, 31, 50, 70, 71, 100]) {
		const pool = pulsationPoolForChaos(chaos);
		const rng = mulberry32(chaos + 1);
		for (let i = 0; i < 200; i++) {
			const v = pickRandomPulsationMeter(chaos, undefined, rng);
			assert.ok(pool.includes(v), `chaos=${chaos}: got ${v} not in pool ${pool}`);
			assert.ok(v >= 3, `chaos=${chaos}: got ${v} - expected >= 3`);
		}
	}
}

/** pickRandomPulsationMeter: with prev and low chaos, result stays close to prev (+/-1) most of the time. */
function testPulsationMarkovCloseToPrev() {
	const chaos = 10;
	const prev = 4; // 4 in {3,4,5} under new LE_30
	const rng = mulberry32(12345);
	let closeCount = 0;
	const trials = 1000;
	for (let i = 0; i < trials; i++) {
		const v = pickRandomPulsationMeter(chaos, prev, rng);
		if (Math.abs(v - prev) <= 1) closeCount++;
	}
	// stickProb(chaos=10)=0.55; full pool {3,4,5} is within +/-1 of prev=4, so approx 100%.
	assert.ok(closeCount / trials > 0.6, `markov too weak: ${closeCount}/${trials} close`);
}

/** applyRandomizerEffectsToBar with fixed seed must be deterministic. */
function testApplyDeterministic() {
	const run = () => {
		const m = makeEmptyState();
		applyRandomizerEffectsToBar(0, 70, true, true, true, true, false, 4, m, mulberry32(0xc0ffee));
		return {
			syl: m.customSyllables[0],
			acc: [...m.accents].sort(),
			subs: JSON.stringify(m.customSubdivisions),
			dead: JSON.stringify(m.deadCells),
		};
	};
	const a = run();
	const b = run();
	assert.deepEqual(a, b, 'applyRandomizerEffectsToBar not deterministic under same seed');
}

/** Operation order: dead zone must not contain accents/subdivisions (pattern/speed after barSpeed). */
function testOrderDeadRegionClean() {
	for (let seed = 1; seed <= 50; seed++) {
		const m = makeEmptyState();
		applyRandomizerEffectsToBar(0, 100, true, true, true, true, false, 8, m, mulberry32(seed));
		const ds = m.deadCells[0]?.deadStart;
		if (typeof ds !== 'number') continue;
		const curSyl = m.customSyllables[0] ?? 8;
		for (let i = ds; i < curSyl; i++) {
			assert.ok(!m.accents.has(`0-${i}`), `seed=${seed}: accent in dead zone at i=${i}`);
			assert.ok(
				m.customSubdivisions[`0-${i}`] === undefined,
				`seed=${seed}: subdiv in dead zone at i=${i}`,
			);
		}
	}
}

/** Dead cap at 80%: at most floor(curSyl*0.8) dead cells when chaos=100 (Vilambit Laya). */
function testDeadCellsCapAt80Percent() {
	for (let seed = 1; seed <= 100; seed++) {
		const m: BarRandomizerMutable = {
			customSyllables: { 0: 9 },
			accents: new Set<string>(),
			customSubdivisions: {},
			customCellSyllables: {},
			customMultipliers: {},
			deadCells: {},
		};
		applyRandomizerEffectsToBar(0, 100, false, false, false, true, false, 9, m, mulberry32(seed));
		const meta = m.deadCells[0];
		if (!meta) continue;
		const deadCount = 9 - meta.deadStart;
		assert.ok(
			deadCount <= Math.floor(9 * 0.8),
			`seed=${seed}: dead=${deadCount} > 80% of curSyl=9`,
		);
		// Invariant: "at least one live cell".
		assert.ok(meta.deadStart >= 1, `seed=${seed}: all cells dead (deadStart=0)`);
	}
}

/** mulberry32: same seed -> same sequence. */
function testMulberry32Determinism() {
	const a = mulberry32(0xdeadbeef);
	const b = mulberry32(0xdeadbeef);
	for (let i = 0; i < 100; i++) {
		assert.equal(a(), b());
	}
}

/** mulberry32: different seeds -> different initial values. */
function testMulberry32DifferentSeeds() {
	const a = mulberry32(1);
	const b = mulberry32(2);
	let diffCount = 0;
	for (let i = 0; i < 10; i++) {
		if (a() !== b()) diffCount++;
	}
	assert.ok(diffCount >= 9, `different seeds should differ most values, got ${diffCount}/10`);
}

/**
 * forceFirstBeat=true: accent on beat 0 is guaranteed for pattern mutation
 * (Sam/Eduppu is Tala's gravitational center). Test at low chaos where
 * pickAccentCountForBar yields low values.
 */
function testFirstBeatForcedWhenFlag() {
	let mutated = 0;
	for (let seed = 1; seed <= 200; seed++) {
		const m: BarRandomizerMutable = {
			customSyllables: { 0: 8 },
			accents: new Set<string>(),
			customSubdivisions: {},
			customCellSyllables: {},
			customMultipliers: {},
			deadCells: {},
		};
		// chaos=60: patternChangeProb approx 0.68, so pattern mutates in most attempts.
		// Axis pattern on, pulsation/barSpeed/speed off - isolate the effect.
		applyRandomizerEffectsToBar(0, 60, false, true, false, false, false, 8, m, mulberry32(seed), true);
		if (m.accents.size === 0) continue; // pattern gate did not fire
		mutated++;
		assert.ok(
			m.accents.has('0-0'),
			`seed=${seed}: forceFirstBeat=true but accent-0 is missing (accents=${[...m.accents]})`,
		);
	}
	assert.ok(mutated > 50, `pattern rarely mutated: ${mutated}/200 - test is not reliable`);
}

/**
 * forceFirstBeat=false at chaos=100: at least some bars should get pattern without accent on 0
 * (Korvai zone allows "floating" accents).
 */
function testFirstBeatNotForcedWithoutFlag() {
	let withoutFirst = 0;
	let mutated = 0;
	for (let seed = 1; seed <= 500; seed++) {
		const m: BarRandomizerMutable = {
			customSyllables: { 0: 9 },
			accents: new Set<string>(),
			customSubdivisions: {},
			customCellSyllables: {},
			customMultipliers: {},
			deadCells: {},
		};
		applyRandomizerEffectsToBar(0, 100, false, true, false, false, false, 9, m, mulberry32(seed), false);
		if (m.accents.size === 0) continue;
		mutated++;
		if (!m.accents.has('0-0')) withoutFirst++;
	}
	assert.ok(mutated > 100, `pattern rarely mutated: ${mutated}/500`);
	// Without force at chaos=100, expect a meaningful share without accent-0.
	assert.ok(
		withoutFirst > 0,
		`forceFirstBeat=false at chaos=100, but every bar got accent-0 - force may be leaking`,
	);
}

/** chaos≤50: только базовые веса на {2,3,4}. */
function testCellSpeedWeightedDistributionLowChaos() {
	const rng = mulberry32(0xabcdef);
	const counts: Record<number, number> = { 2: 0, 3: 0, 4: 0 };
	const trials = 5000;
	for (let i = 0; i < trials; i++) {
		const v = pickRandomCellSpeedSubdiv(rng, undefined, 45);
		counts[v]! += 1;
	}
	const f2 = counts[2]! / trials;
	const f3 = counts[3]! / trials;
	const f4 = counts[4]! / trials;
	assert.ok(f2 > 0.47 && f2 < 0.53, `freq(2)=${f2.toFixed(3)} out of [0.47, 0.53]`);
	assert.ok(f3 > 0.12 && f3 < 0.18, `freq(3)=${f3.toFixed(3)} out of [0.12, 0.18]`);
	assert.ok(f4 > 0.32 && f4 < 0.38, `freq(4)=${f4.toFixed(3)} out of [0.32, 0.38]`);
}

/** chaos≥90: равномерка по всем подделениям 2..9 (для 90 и 100). */
function testCellSpeedUniformHighChaos() {
	const trials = 12000;
	const expected = 1 / 8;
	for (const chaos of [90, 100]) {
		const rng = mulberry32(0xf00dbaad + chaos);
		const counts: Record<number, number> = {};
		for (let s = 2; s <= 9; s++) counts[s] = 0;
		for (let i = 0; i < trials; i++) {
			const v = pickRandomCellSpeedSubdiv(rng, undefined, chaos);
			counts[v]! += 1;
		}
		for (let s = 2; s <= 9; s++) {
			const f = counts[s]! / trials;
			assert.ok(
				f > expected - 0.035 && f < expected + 0.035,
				`chaos=${chaos} freq(${s})=${f.toFixed(3)} vs ~${expected}`,
			);
		}
	}
}

function testCellSpeedExtendedBlendEndpoints() {
	assert.equal(cellSpeedExtendedBlendFromChaos(0), 0);
	assert.equal(cellSpeedExtendedBlendFromChaos(50), 0);
	assert.equal(cellSpeedExtendedBlendFromChaos(90), 1);
	assert.equal(cellSpeedExtendedBlendFromChaos(100), 1);
	assert.ok(cellSpeedExtendedBlendFromChaos(70) > 0 && cellSpeedExtendedBlendFromChaos(70) < 1);
}

/**
 * Dead-cells are independent from accents: with chaos=60 and randomPattern=false, randomBarSpeed=true
 * dead zones should still appear in a meaningful fraction of attempts.
 */
function testDeadCellsIndependentOfAccents() {
	let withDead = 0;
	let mutated = 0;
	for (let seed = 1; seed <= 300; seed++) {
		const m: BarRandomizerMutable = {
			customSyllables: { 0: 8 },
			accents: new Set<string>(),
			customSubdivisions: {},
			customCellSyllables: {},
			customMultipliers: {},
			deadCells: {},
		};
		// Pattern off - accents are always empty. Dead-cells must not depend on them.
		const didChange = applyRandomizerEffectsToBar(
			0, 60, false, false, false, true, false, 8, m, mulberry32(seed),
		);
		if (didChange) mutated++;
		if (m.deadCells[0] !== undefined) withDead++;
	}
	assert.ok(mutated > 50, `barSpeed gate rarely fires: ${mutated}/300`);
	assert.ok(
		withDead > 20,
		`dead-cells at chaos=60 without pattern are rare: ${withDead}/300 - possible accidental dependency on accents?`,
	);
}

/**
 * Speed affects non-accented cells: with empty accents and chaos=100, randomSpeed=true
 * subdivisions should appear on any live indices.
 */
function testSpeedFillsAllCellsIndependentOfAccents() {
	let subdivsOnNonAccent = 0;
	for (let seed = 1; seed <= 100; seed++) {
		const m: BarRandomizerMutable = {
			customSyllables: { 0: 8 },
			accents: new Set<string>(),
			customSubdivisions: {},
			customCellSyllables: {},
			customMultipliers: {},
			deadCells: {},
		};
		applyRandomizerEffectsToBar(0, 100, false, false, true, false, false, 8, m, mulberry32(seed));
		for (const key of Object.keys(m.customSubdivisions)) {
			if (!m.accents.has(key)) subdivsOnNonAccent++;
		}
	}
	assert.ok(
		subdivsOnNonAccent > 100,
		`Speed added subdivisions to non-accent cells only ${subdivsOnNonAccent} times - too low; dependency on accents may remain`,
	);
}

/** Divs=0 (all-false step mask) must not remove cell from timing sequence. */
function testLegacySequenceKeepsDiv0CellsInTimingGrid() {
	const seq = buildLegacyPlaybackSequence(
		1,
		{},
		4,
		{},
		{},
		{},
		{
			'0-1': [false],
		},
	);
	assert.deepEqual(
		seq.map((x) => `${x.r}-${x.c}`),
		['0-0', '0-1', '0-2', '0-3'],
		'Div0 cell must stay in sequence timing, only audio should be muted',
	);
}

function testLegacySequenceRepeatsOnlyX2AndX4Bars() {
	const seq = buildLegacyPlaybackSequence(3, {}, 2, {}, {}, {}, {}, { 0: 2, 1: 3, 2: 4 });
	assert.deepEqual(
		seq.map((x) => `${x.r}-${x.c}:${x.repeatIndex ?? 0}/${x.repeatCount ?? 1}`),
		[
			'0-0:0/2',
			'0-1:0/2',
			'0-0:1/2',
			'0-1:1/2',
			'1-0:0/1',
			'1-1:0/1',
			'2-0:0/4',
			'2-1:0/4',
			'2-0:1/4',
			'2-1:1/4',
			'2-0:2/4',
			'2-1:2/4',
			'2-0:3/4',
			'2-1:3/4',
		],
		'x2/x4 repeat bars; x3 is removed and behaves like x1',
	);
}

testChangeProbCurvesMonotoneAndBounded();
testCellSpeedHitPContinuityAt25();
testSmoothstep();
testPickAccentCountMinForSmallBar();
testPickAccentCountZeroOnEmpty();
testPulsationPoolsExclude1And2();
testPickPulsationMeterInPool();
testPulsationMarkovCloseToPrev();
testApplyDeterministic();
testOrderDeadRegionClean();
testDeadCellsCapAt80Percent();
testMulberry32Determinism();
testMulberry32DifferentSeeds();
testFirstBeatForcedWhenFlag();
testFirstBeatNotForcedWithoutFlag();
testCellSpeedWeightedDistributionLowChaos();
testCellSpeedUniformHighChaos();
testCellSpeedExtendedBlendEndpoints();
testDeadCellsIndependentOfAccents();
testSpeedFillsAllCellsIndependentOfAccents();
testLegacySequenceKeepsDiv0CellsInTimingGrid();
testLegacySequenceRepeatsOnlyX2AndX4Bars();
console.log('randomCurves.test.ts: ok');
