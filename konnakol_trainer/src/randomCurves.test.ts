/**
 * Тесты рандом-логики konnakol (см. randomLogic.ts).
 * Запуск: `npx tsx src/randomCurves.test.ts` из каталога konnakol_trainer.
 */
import assert from 'node:assert/strict';
import {
	applyRandomizerEffectsToBar,
	barSpeedChangeProbFromChaos,
	cellSpeedHitPFromChaos,
	mulberry32,
	patternChangeProbFromChaos,
	pickAccentCountForBar,
	pickRandomPulsationMeter,
	pulsationChangeProbFromChaos,
	pulsationPoolForChaos,
	smoothstep01,
	speedChangeProbFromChaos,
	type BarRandomizerMutable,
} from './randomLogic';

/** Все probability-curves должны быть монотонно неубывающими и жить в [0, 1]. */
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
			// Нет обрывов > 0.05 на шаге 1 — кривая гладкая.
			assert.ok(
				v - prev <= 0.05 + 1e-12,
				`${name} jump >0.05 at c=${c}: prev=${prev} v=${v}`,
			);
			prev = v;
		}
	}
}

/** cellSpeedHitPFromChaos: непрерывность на стыке 25/26. */
function testCellSpeedHitPContinuityAt25() {
	const at25 = cellSpeedHitPFromChaos(25);
	const at26 = cellSpeedHitPFromChaos(26);
	assert.ok(Math.abs(at26 - at25) < 0.01, `cliff at 25→26: ${at25} → ${at26}`);
	assert.ok(at25 > 0.14 && at25 < 0.16, `at25=${at25} expected ~0.15`);
}

/** smoothstep01: границы + 3t²−2t³. */
function testSmoothstep() {
	assert.equal(smoothstep01(-1), 0);
	assert.equal(smoothstep01(0), 0);
	assert.equal(smoothstep01(1), 1);
	assert.equal(smoothstep01(2), 1);
	assert.ok(Math.abs(smoothstep01(0.5) - 0.5) < 1e-9);
}

/** pickAccentCountForBar: для малых пульсаций (curSyl≤3) пол=1 независимо от chaos. */
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

/** pickAccentCountForBar: 0 для curSyl<1. */
function testPickAccentCountZeroOnEmpty() {
	assert.equal(pickAccentCountForBar(50, 0, mulberry32(1)), 0);
}

/** pickRandomPulsationMeter: результат всегда принадлежит pulsationPoolForChaos(chaos). */
function testPickPulsationMeterInPool() {
	for (const chaos of [0, 10, 30, 31, 50, 70, 71, 100]) {
		const pool = pulsationPoolForChaos(chaos);
		const rng = mulberry32(chaos + 1);
		for (let i = 0; i < 50; i++) {
			const v = pickRandomPulsationMeter(chaos, undefined, rng);
			assert.ok(pool.includes(v), `chaos=${chaos}: got ${v} not in pool ${pool}`);
		}
	}
}

/** pickRandomPulsationMeter: с prev и малым chaos результат близко к prev (±1) большинство раз. */
function testPulsationMarkovCloseToPrev() {
	const chaos = 10;
	const prev = 4;
	const rng = mulberry32(12345);
	let closeCount = 0;
	const trials = 1000;
	for (let i = 0; i < trials; i++) {
		const v = pickRandomPulsationMeter(chaos, prev, rng);
		if (Math.abs(v - prev) <= 1) closeCount++;
	}
	// stickProb(chaos=10)=0.55; на stick-branch гарантированно ±1; на non-stick — из пула [1..5].
	// Ожидаем ≥60% близких результатов (даже с учётом non-stick иногда тоже попадающего в ±1).
	assert.ok(closeCount / trials > 0.6, `markov too weak: ${closeCount}/${trials} close`);
}

/** applyRandomizerEffectsToBar с фиксированным seed — детерминизм. */
function testApplyDeterministic() {
	const makeState = (): BarRandomizerMutable => ({
		customSyllables: {},
		accents: new Set<string>(),
		customSubdivisions: {},
		customMultipliers: {},
		deadCells: {},
	});
	const run = () => {
		const m = makeState();
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

/** Порядок операций: dead-зона не содержит accents/subdivisions (pattern/speed после barSpeed). */
function testOrderDeadRegionClean() {
	// Крутим много seeds на chaos=100 где все axis включены; в dead-зоне должна быть тишина.
	for (let seed = 1; seed <= 50; seed++) {
		const m: BarRandomizerMutable = {
			customSyllables: {},
			accents: new Set<string>(),
			customSubdivisions: {},
			customMultipliers: {},
			deadCells: {},
		};
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

/** Cap dead на 50%: не более floor(curSyl*0.5) мёртвых при chaos=100. */
function testDeadCellsCapAt50Percent() {
	for (let seed = 1; seed <= 100; seed++) {
		const m: BarRandomizerMutable = {
			customSyllables: { 0: 9 },
			accents: new Set<string>(),
			customSubdivisions: {},
			customMultipliers: {},
			deadCells: {},
		};
		applyRandomizerEffectsToBar(0, 100, false, false, false, true, false, 9, m, mulberry32(seed));
		const meta = m.deadCells[0];
		if (!meta) continue;
		const deadCount = 9 - meta.deadStart;
		assert.ok(
			deadCount <= Math.floor(9 * 0.5),
			`seed=${seed}: dead=${deadCount} > 50% of curSyl=9`,
		);
	}
}

/** mulberry32: одинаковый seed → одинаковая последовательность. */
function testMulberry32Determinism() {
	const a = mulberry32(0xdeadbeef);
	const b = mulberry32(0xdeadbeef);
	for (let i = 0; i < 100; i++) {
		assert.equal(a(), b());
	}
}

/** mulberry32: разные seed → разные начальные значения. */
function testMulberry32DifferentSeeds() {
	const a = mulberry32(1);
	const b = mulberry32(2);
	let diffCount = 0;
	for (let i = 0; i < 10; i++) {
		if (a() !== b()) diffCount++;
	}
	assert.ok(diffCount >= 9, `different seeds should differ most values, got ${diffCount}/10`);
}

testChangeProbCurvesMonotoneAndBounded();
testCellSpeedHitPContinuityAt25();
testSmoothstep();
testPickAccentCountMinForSmallBar();
testPickAccentCountZeroOnEmpty();
testPickPulsationMeterInPool();
testPulsationMarkovCloseToPrev();
testApplyDeterministic();
testOrderDeadRegionClean();
testDeadCellsCapAt50Percent();
testMulberry32Determinism();
testMulberry32DifferentSeeds();
console.log('randomCurves.test.ts: ok');
