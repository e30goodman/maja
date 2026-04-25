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

/** Пулы пульсации: 1 и 2 исключены на всех уровнях chaos (Тала Шастра). */
function testPulsationPoolsExclude1And2() {
	for (let chaos = 0; chaos <= 100; chaos += 5) {
		const pool = pulsationPoolForChaos(chaos);
		assert.ok(!pool.includes(1), `chaos=${chaos}: pool contains 1 (forbidden Anga)`);
		assert.ok(!pool.includes(2), `chaos=${chaos}: pool contains 2 (forbidden Anga)`);
		assert.ok(pool.includes(3), `chaos=${chaos}: pool missing 3 (Tisra base)`);
	}
}

/** pickRandomPulsationMeter: результат всегда принадлежит pulsationPoolForChaos(chaos), никогда 1/2. */
function testPickPulsationMeterInPool() {
	for (const chaos of [0, 10, 30, 31, 50, 70, 71, 100]) {
		const pool = pulsationPoolForChaos(chaos);
		const rng = mulberry32(chaos + 1);
		for (let i = 0; i < 200; i++) {
			const v = pickRandomPulsationMeter(chaos, undefined, rng);
			assert.ok(pool.includes(v), `chaos=${chaos}: got ${v} not in pool ${pool}`);
			assert.ok(v >= 3, `chaos=${chaos}: got ${v} — должно быть ≥ 3`);
		}
	}
}

/** pickRandomPulsationMeter: с prev и малым chaos результат близко к prev (±1) большинство раз. */
function testPulsationMarkovCloseToPrev() {
	const chaos = 10;
	const prev = 4; // 4 ∈ {3,4,5} новый LE_30
	const rng = mulberry32(12345);
	let closeCount = 0;
	const trials = 1000;
	for (let i = 0; i < trials; i++) {
		const v = pickRandomPulsationMeter(chaos, prev, rng);
		if (Math.abs(v - prev) <= 1) closeCount++;
	}
	// stickProb(chaos=10)=0.55; весь пул {3,4,5} в ±1 от prev=4, так что ≈100%.
	assert.ok(closeCount / trials > 0.6, `markov too weak: ${closeCount}/${trials} close`);
}

/** applyRandomizerEffectsToBar с фиксированным seed — детерминизм. */
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

/** Порядок операций: dead-зона не содержит accents/subdivisions (pattern/speed после barSpeed). */
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

/** Cap dead на 80%: не более floor(curSyl*0.8) мёртвых при chaos=100 (Vilambit Laya). */
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
		// Инвариант "минимум одна живая клетка".
		assert.ok(meta.deadStart >= 1, `seed=${seed}: all cells dead (deadStart=0)`);
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

/**
 * forceFirstBeat=true: акцент на доле 0 гарантирован при мутации pattern
 * (Sam/Eduppu — гравитационный центр Тала). Проверяем на низком chaos, где
 * pickAccentCountForBar даёт малые значения.
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
		// chaos=60 — patternChangeProb ≈ 0.68, в большинстве попыток pattern мутирует.
		// Axis pattern on, pulsation/barSpeed/speed off — изолируем эффект.
		applyRandomizerEffectsToBar(0, 60, false, true, false, false, false, 8, m, mulberry32(seed), true);
		if (m.accents.size === 0) continue; // pattern gate не сработал
		mutated++;
		assert.ok(
			m.accents.has('0-0'),
			`seed=${seed}: forceFirstBeat=true, но accent-0 отсутствует (accents=${[...m.accents]})`,
		);
	}
	assert.ok(mutated > 50, `pattern rarely mutated: ${mutated}/200 — тест недостоверен`);
}

/**
 * forceFirstBeat=false на chaos=100: хотя бы часть тактов получает pattern без акцента на 0
 * (Korvai-зона разрешает "плавающие" акценты).
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
	// Без форса и на chaos=100 ожидаем существенную долю без accent-0.
	assert.ok(
		withoutFirst > 0,
		`forceFirstBeat=false на chaos=100, но каждый такт получил accent-0 — форс утекает?`,
	);
}

/**
 * Веса cell-speed: 2→0.5, 4→0.35, 3→0.15. Проверяем частоты на 5000 независимых семплов
 * (chaos=100, prev=undefined — Markov-stick выключен).
 */
function testCellSpeedWeightedDistribution() {
	const rng = mulberry32(0xabcdef);
	const counts: Record<number, number> = { 2: 0, 3: 0, 4: 0 };
	const trials = 5000;
	for (let i = 0; i < trials; i++) {
		const v = pickRandomCellSpeedSubdiv(rng, undefined, 100);
		counts[v]! += 1;
	}
	const f2 = counts[2]! / trials;
	const f3 = counts[3]! / trials;
	const f4 = counts[4]! / trials;
	// Допуски ±0.03 — статистический шум на 5000 семплов.
	assert.ok(f2 > 0.47 && f2 < 0.53, `freq(2)=${f2.toFixed(3)} вне [0.47, 0.53]`);
	assert.ok(f3 > 0.12 && f3 < 0.18, `freq(3)=${f3.toFixed(3)} вне [0.12, 0.18]`);
	assert.ok(f4 > 0.32 && f4 < 0.38, `freq(4)=${f4.toFixed(3)} вне [0.32, 0.38]`);
}

/**
 * Dead-cells независимы от акцентов: при chaos=60 и randomPattern=false, randomBarSpeed=true
 * dead-зоны всё равно генерируются в существенной доле попыток.
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
		// Pattern off — accents всегда пустые. Dead-cells не должны зависеть от них.
		const didChange = applyRandomizerEffectsToBar(
			0, 60, false, false, false, true, false, 8, m, mulberry32(seed),
		);
		if (didChange) mutated++;
		if (m.deadCells[0] !== undefined) withDead++;
	}
	assert.ok(mutated > 50, `barSpeed gate rarely fires: ${mutated}/300`);
	assert.ok(
		withDead > 20,
		`dead-cells на chaos=60 без pattern редки: ${withDead}/300 — есть ли утечка связи с accents?`,
	);
}

/**
 * Speed бьёт безакцентные клетки: с пустыми accents и chaos=100, randomSpeed=true
 * подделения появляются на любых живых индексах.
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
		`Speed поставил подделения на безакц. клетки ${subdivsOnNonAccent} раз — мало; связь с accents не развязана?`,
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
testCellSpeedWeightedDistribution();
testDeadCellsIndependentOfAccents();
testSpeedFillsAllCellsIndependentOfAccents();
console.log('randomCurves.test.ts: ok');
