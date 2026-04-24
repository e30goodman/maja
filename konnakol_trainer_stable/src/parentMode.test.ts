/**
 * Тесты parent-mode (см. parentMode.ts).
 * Запуск: `npx tsx src/parentMode.test.ts` из каталога konnakol_trainer.
 *
 * Покрывает:
 *  - genome ↔ BarRandomizerMutable converters (roundtrip).
 *  - chaosToIntensity: диапазон и монотонность.
 *  - operators: substitution / retrograde / inversion — определённость, step=0=parent,
 *    step=1 даёт отличие.
 *  - scheduler: полное покрытие bars, детерминизм, respect phraseLength.
 *  - applyParentModeBar: маршрутизация role=parent/free/mutation.
 *  - JSON serialization: roundtrip.
 */
import assert from 'node:assert/strict';
import { mulberry32, type BarRandomizerMutable } from './randomLogic';
import {
	ALL_MUTATION_TYPES,
	applyGenomeToBar,
	applyParentModeBar,
	buildPhraseSchedule,
	chaosToIntensity,
	cloneBarGenome,
	cloneParentGenome,
	MUTATION_OPERATORS,
	MUTATION_PHRASE_LEN,
	parentGenomeFromJSON,
	parentGenomeToJSON,
	snapshotBarGenome,
	type BarGenome,
	type ParentGenome,
	type PhraseRole,
} from './parentMode';
import {
	PRESET_ENABLED_MUTATIONS,
	PRESET_TARGET_BARS,
	clampParentTargetBars,
} from './parentModeUi';

const makeEmpty = (): BarRandomizerMutable => ({
	customSyllables: {},
	accents: new Set<string>(),
	customSubdivisions: {},
	customMultipliers: {},
	deadCells: {},
});

const makeParent = (bar0?: Partial<BarGenome>, bar1?: Partial<BarGenome>): ParentGenome => {
	const b0: BarGenome = {
		curSyl: 5,
		accents: new Set([0, 2, 4]),
		subdivisions: { 1: 2, 3: 4 },
		...bar0,
	};
	const bars: BarGenome[] = [b0];
	if (bar1 !== undefined) {
		const b1: BarGenome = {
			curSyl: 6,
			accents: new Set([0, 3]),
			subdivisions: { 2: 3 },
			...bar1,
		};
		bars.push(b1);
	}
	return { bars };
};

function testChaosToIntensityRange() {
	assert.ok(Math.abs(chaosToIntensity(0) - 0.2) < 1e-9, `chaosToIntensity(0) должен быть 0.2`);
	assert.ok(Math.abs(chaosToIntensity(100) - 1.2) < 1e-9, `chaosToIntensity(100) должен быть 1.2`);
	let prev = chaosToIntensity(0);
	for (let c = 1; c <= 100; c++) {
		const v = chaosToIntensity(c);
		assert.ok(v + 1e-12 >= prev, `chaosToIntensity не монотонна на c=${c}`);
		assert.ok(v >= 0.2 && v <= 1.2, `chaosToIntensity(${c})=${v} вне [0.2, 1.2]`);
		prev = v;
	}
}

function testSnapshotBarGenomeRoundtrip() {
	const m: BarRandomizerMutable = {
		customSyllables: { 0: 5, 1: 7 },
		accents: new Set<string>(['0-0', '0-2', '0-4', '1-1']),
		customSubdivisions: { '0-1': 2, '0-3': 4, '1-2': 3 },
		customMultipliers: {},
		deadCells: { 1: { deadStart: 6, displayLen: 7, baseLen: 7 } },
	};
	const g0 = snapshotBarGenome(0, 4, m);
	assert.equal(g0.curSyl, 5);
	assert.deepEqual([...g0.accents].sort(), [0, 2, 4]);
	assert.deepEqual(g0.subdivisions, { 1: 2, 3: 4 });
	assert.equal(g0.deadStart, undefined);

	const g1 = snapshotBarGenome(1, 4, m);
	assert.equal(g1.curSyl, 7);
	assert.deepEqual([...g1.accents].sort(), [1]);
	assert.deepEqual(g1.subdivisions, { 2: 3 });
	assert.equal(g1.deadStart, 6);

	const m2 = makeEmpty();
	applyGenomeToBar(0, g0, m2);
	applyGenomeToBar(1, g1, m2);
	const g0b = snapshotBarGenome(0, 4, m2);
	const g1b = snapshotBarGenome(1, 4, m2);
	assert.equal(g0b.curSyl, g0.curSyl);
	assert.deepEqual([...g0b.accents].sort(), [...g0.accents].sort());
	assert.deepEqual(g0b.subdivisions, g0.subdivisions);
	assert.equal(g1b.deadStart, g1.deadStart);
}

function testCloneIsolation() {
	const p = makeParent(undefined, {});
	const c = cloneParentGenome(p);
	c.bars[0]!.accents.add(99);
	c.bars[0]!.subdivisions[99] = 9;
	assert.ok(!p.bars[0]!.accents.has(99), 'cloneParentGenome не изолирует accents');
	assert.equal(p.bars[0]!.subdivisions[99], undefined, 'cloneParentGenome не изолирует subdivisions');

	const b = cloneBarGenome(p.bars[0]!);
	b.accents.clear();
	assert.ok(p.bars[0]!.accents.size > 0, 'cloneBarGenome не изолирует accents');
}

function makeRole(type: PhraseRole['type'], step: number = 0, len: number = 2, parentBarIdx: 0 | 1 = 0): PhraseRole {
	if (type === 'parent') return { type: 'parent', phraseId: 0, phraseStep: 0, phraseLength: 1, parentBarIdx };
	if (type === 'free') return { type: 'free', phraseId: 0, phraseStep: 0, phraseLength: 1, parentBarIdx: 0 };
	return { type, phraseId: 0, phraseStep: step, phraseLength: len, parentBarIdx };
}

function testSubstitutionOperator() {
	const parent = makeParent();
	const op = MUTATION_OPERATORS.substitution;
	// step=0 === parent
	const g0 = op(parent, makeRole('substitution', 0) as any, 0.5, mulberry32(1));
	assert.equal(g0.curSyl, parent.bars[0]!.curSyl);
	assert.deepEqual([...g0.accents].sort(), [...parent.bars[0]!.accents].sort());
	// step=1 меняет хотя бы одну клетку
	let differs = 0;
	for (let seed = 1; seed <= 30; seed++) {
		const g1 = op(parent, makeRole('substitution', 1) as any, 0.5, mulberry32(seed));
		const p = parent.bars[0]!;
		const same = g1.accents.size === p.accents.size && [...g1.accents].every((x) => p.accents.has(x));
		if (!same) differs++;
	}
	assert.ok(differs >= 25, `substitution step=1 должен менять accents большинство seeds, differs=${differs}/30`);
}

function testRetrogradeOperator() {
	const parent = makeParent(); // accents {0,2,4} на curSyl=5
	const op = MUTATION_OPERATORS.retrograde;
	const g0 = op(parent, makeRole('retrograde', 0) as any, 0.5, mulberry32(1));
	assert.deepEqual([...g0.accents].sort(), [0, 2, 4]);
	const g1 = op(parent, makeRole('retrograde', 1) as any, 0.5, mulberry32(1));
	// reverse(0,2,4) на live=5 → (4,2,0) — симметрично, остаётся {0,2,4}.
	assert.deepEqual([...g1.accents].sort(), [0, 2, 4], 'симметричный паттерн не меняется при reverse');

	// несимметричный случай:
	const parentA = makeParent({ curSyl: 6, accents: new Set([0, 1, 3]), subdivisions: { 0: 2 } });
	const gA = op(parentA, makeRole('retrograde', 1) as any, 0.5, mulberry32(1));
	// 0→5, 1→4, 3→2
	assert.deepEqual([...gA.accents].sort((a, b) => a - b), [2, 4, 5], `retrograde accents: ${[...gA.accents].sort()}`);
	// subdivisions {0:2} → {5:2}
	assert.deepEqual(gA.subdivisions, { 5: 2 });
}

function testInversionOperator() {
	const parent = makeParent(); // accents {0,2,4} на curSyl=5
	const op = MUTATION_OPERATORS.inversion;
	const g0 = op(parent, makeRole('inversion', 0) as any, 0.5, mulberry32(1));
	assert.deepEqual([...g0.accents].sort(), [0, 2, 4]);
	const g1 = op(parent, makeRole('inversion', 1) as any, 0.5, mulberry32(1));
	// complement на live=5: {1,3}
	assert.deepEqual([...g1.accents].sort(), [1, 3]);
	// subdivisions сохраняются
	assert.deepEqual(g1.subdivisions, parent.bars[0]!.subdivisions);
}

function testSchedulerCoversAllBars() {
	for (const seed of [1, 42, 100, 999, 123456]) {
		const sched = buildPhraseSchedule({
			bars: 8,
			enabledMutations: ['substitution', 'retrograde', 'inversion'],
			preset: 'random',
			parentLength: 1,
			rng: mulberry32(seed),
		});
		assert.equal(sched.length, 8, `scheduler должен дать 8 ролей`);
		for (const role of sched) {
			assert.ok(role.phraseStep >= 0 && role.phraseStep < role.phraseLength, `phraseStep out of range`);
		}
	}
}

function testSchedulerDeterminism() {
	const ctx = {
		bars: 16,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'random' as const,
		parentLength: 1 as const,
	};
	const a = buildPhraseSchedule({ ...ctx, rng: mulberry32(777) });
	const b = buildPhraseSchedule({ ...ctx, rng: mulberry32(777) });
	assert.deepEqual(a, b, `scheduler не детерминирован для seed=777`);
}

function testSchedulerEmptyMutationsGivesAllParent() {
	const sched = buildPhraseSchedule({
		bars: 6,
		enabledMutations: [],
		preset: 'random',
		parentLength: 2,
		rng: mulberry32(1),
	});
	assert.equal(sched.length, 6);
	for (const role of sched) {
		assert.equal(role.type, 'parent', `empty enabledMutations → все роли должны быть parent`);
	}
	// parentBarIdx чередуется 0,1,0,1,...
	for (let i = 0; i < sched.length; i++) {
		assert.equal(sched[i]!.parentBarIdx, (i % 2) as 0 | 1, `parentBarIdx[${i}] не чередуется`);
	}
}

function testSchedulerPhraseIntegrity() {
	// Все фразы одного phraseId имеют последовательные phraseStep 0..len-1.
	const sched = buildPhraseSchedule({
		bars: 20,
		enabledMutations: ['substitution', 'retrograde', 'rotation', 'truncation'],
		preset: 'random',
		parentLength: 1,
		rng: mulberry32(42),
	});
	let i = 0;
	while (i < sched.length) {
		const role = sched[i]!;
		const len = role.phraseLength;
		for (let step = 0; step < len && i + step < sched.length; step++) {
			const r = sched[i + step]!;
			assert.equal(r.phraseStep, step, `phraseStep mismatch at i=${i + step}`);
			assert.equal(r.phraseId, role.phraseId, `phraseId mismatch at i=${i + step}`);
			assert.equal(r.type, role.type, `type mismatch in phrase at i=${i + step}`);
		}
		i += len;
	}
}

function testApplyParentModeBarParentRole() {
	const parent = makeParent();
	const m = makeEmpty();
	const schedule = [makeRole('parent', 0, 1, 0)];
	const changed = applyParentModeBar({
		barIdx: 0,
		parent,
		schedule,
		chaos: 50,
		syllablesDefault: 4,
		m,
		rng: mulberry32(1),
		freeAxes: {
			randomPulsation: false,
			randomPattern: false,
			randomSpeed: false,
			randomBarSpeed: false,
			forceFirstBeat: false,
		},
	});
	assert.ok(changed, `parent-role должен обновить пустой bar`);
	assert.equal(m.customSyllables[0], 5);
	assert.ok(m.accents.has('0-0') && m.accents.has('0-2') && m.accents.has('0-4'));
}

function testApplyParentModeBarSubstitutionRole() {
	const parent = makeParent();
	const m = makeEmpty();
	// step=0 даёт чистый parent
	const schedule: PhraseRole[] = [
		makeRole('substitution', 0, 2, 0),
		makeRole('substitution', 1, 2, 0),
	];
	applyParentModeBar({
		barIdx: 0,
		parent,
		schedule,
		chaos: 50,
		syllablesDefault: 4,
		m,
		rng: mulberry32(1),
		freeAxes: {
			randomPulsation: false,
			randomPattern: false,
			randomSpeed: false,
			randomBarSpeed: false,
			forceFirstBeat: false,
		},
	});
	assert.deepEqual(
		[...m.accents].map((k) => parseInt(k.split('-')[1] ?? '0', 10)).sort(),
		[0, 2, 4],
		`step=0 substitution → accents parent`,
	);
}

function testParentGenomeJSONRoundtrip() {
	const p = makeParent(
		{ curSyl: 7, accents: new Set([0, 3, 6]), subdivisions: { 1: 2, 5: 3 }, deadStart: 6 },
		{ curSyl: 5, accents: new Set([0]), subdivisions: {} },
	);
	const json = parentGenomeToJSON(p);
	const back = parentGenomeFromJSON(json);
	assert.ok(back, `JSON roundtrip не распарсился`);
	assert.equal(back!.bars.length, 2);
	assert.equal(back!.bars[0]!.curSyl, 7);
	assert.deepEqual([...back!.bars[0]!.accents].sort(), [0, 3, 6]);
	assert.deepEqual(back!.bars[0]!.subdivisions, { 1: 2, 5: 3 });
	assert.equal(back!.bars[0]!.deadStart, 6);
	assert.equal(back!.bars[1]!.curSyl, 5);
	assert.equal(back!.bars[1]!.deadStart, undefined);
}

function testMutationPhraseLenComplete() {
	// Каждый MutationType должен иметь длину.
	for (const t of ALL_MUTATION_TYPES) {
		const len = MUTATION_PHRASE_LEN[t];
		assert.ok(Number.isInteger(len) && len >= 2, `MUTATION_PHRASE_LEN[${t}] отсутствует или < 2`);
	}
}

function testRotationOperator() {
	const parent = makeParent({ curSyl: 6, accents: new Set([0, 2]), subdivisions: { 1: 3, 4: 2 } });
	const op = MUTATION_OPERATORS.rotation;
	const g0 = op(parent, makeRole('rotation', 0, 3) as any, 0.5, mulberry32(1));
	assert.deepEqual([...g0.accents].sort(), [0, 2]);
	// step=1, intensity=0.5 → k = round(1 * 1.25) = 1
	const g1 = op(parent, makeRole('rotation', 1, 3) as any, 0.5, mulberry32(1));
	assert.deepEqual([...g1.accents].sort(), [1, 3], `rotation step=1 k=1: accents сдвинулись`);
	// step=2, intensity=0.5 → k = Math.round(2.5) = 3 (JS banker → 3)
	const g2 = op(parent, makeRole('rotation', 2, 3) as any, 0.5, mulberry32(1));
	// k=3 ⇒ 0→3, 2→5
	assert.deepEqual([...g2.accents].sort((a, b) => a - b), [3, 5], `rotation step=2 k=3: accents`);
}

function testTruncationOperator() {
	const parent = makeParent({ curSyl: 8, accents: new Set([0, 2, 4, 6]), subdivisions: { 1: 2, 5: 4 } });
	const op = MUTATION_OPERATORS.truncation;
	const g0 = op(parent, makeRole('truncation', 0, 5) as any, 0.5, mulberry32(1));
	assert.equal(g0.deadStart, undefined);
	assert.deepEqual([...g0.accents].sort(), [0, 2, 4, 6]);
	// step 1..4: deadStart уменьшается (live уменьшается).
	const lives: number[] = [];
	for (let s = 1; s <= 4; s++) {
		const g = op(parent, makeRole('truncation', s, 5) as any, 0.5, mulberry32(1));
		assert.ok(typeof g.deadStart === 'number', `truncation step=${s}: deadStart должен быть задан`);
		lives.push(g.deadStart!);
		// accents и subs в dead-зоне должны быть отброшены
		for (const c of g.accents) assert.ok(c < g.deadStart!, `accent ${c} попал в dead-зону step=${s}`);
		for (const cStr of Object.keys(g.subdivisions)) {
			assert.ok(parseInt(cStr, 10) < g.deadStart!, `sub ${cStr} попал в dead-зону step=${s}`);
		}
	}
	for (let i = 1; i < lives.length; i++) {
		assert.ok(lives[i]! <= lives[i - 1]!, `truncation deadStart должен монотонно уменьшаться: ${lives}`);
	}
}

function testAugmentationOperator() {
	const parent = makeParent({ curSyl: 7, accents: new Set([0, 3]), subdivisions: {} });
	const op = MUTATION_OPERATORS.augmentation;
	const g0 = op(parent, makeRole('augmentation', 0, 3) as any, 0.5, mulberry32(1));
	assert.equal(Object.keys(g0.subdivisions).length, 0);
	// По мере шага число subdivisions должно расти.
	let counts: number[] = [];
	for (let seed = 1; seed <= 10; seed++) {
		const g1 = op(parent, makeRole('augmentation', 1, 3) as any, 0.8, mulberry32(seed));
		const g2 = op(parent, makeRole('augmentation', 2, 3) as any, 0.8, mulberry32(seed));
		counts.push(Object.keys(g2.subdivisions).length - Object.keys(g1.subdivisions).length);
	}
	// Большинство seeds должны давать step2 >= step1 (non-strict, т.к. шафл).
	const nonDecreasing = counts.filter((d) => d >= 0).length;
	assert.ok(nonDecreasing >= 8, `augmentation step2 ≥ step1: ${nonDecreasing}/10`);
	// Все подделения ∈ [2,4].
	for (let s = 1; s <= 2; s++) {
		const g = op(parent, makeRole('augmentation', s, 3) as any, 0.8, mulberry32(42));
		for (const v of Object.values(g.subdivisions)) {
			assert.ok(v >= 2 && v <= 4, `augmentation subdivision ${v} вне [2,4]`);
		}
	}
}

function testDiminutionOperator() {
	const parent = makeParent({
		curSyl: 7,
		accents: new Set([0]),
		subdivisions: { 0: 2, 1: 3, 2: 4, 3: 2, 4: 3, 5: 4 },
	});
	const op = MUTATION_OPERATORS.diminution;
	const g0 = op(parent, makeRole('diminution', 0, 3) as any, 0.5, mulberry32(1));
	assert.equal(Object.keys(g0.subdivisions).length, 6);
	const g1 = op(parent, makeRole('diminution', 1, 3) as any, 0.8, mulberry32(1));
	const g2 = op(parent, makeRole('diminution', 2, 3) as any, 0.8, mulberry32(1));
	assert.ok(
		Object.keys(g1.subdivisions).length < 6,
		`diminution step=1 должен удалять подделения: ${Object.keys(g1.subdivisions).length}`,
	);
	assert.ok(
		Object.keys(g2.subdivisions).length <= Object.keys(g1.subdivisions).length,
		`diminution step=2 ≤ step=1`,
	);
}

function testPrependAppendOperator() {
	const parent = makeParent({ curSyl: 6, accents: new Set([2, 3]), subdivisions: {} });
	const op = MUTATION_OPERATORS.prepend_append;
	const g0 = op(parent, makeRole('prepend_append', 0, 4) as any, 0.5, mulberry32(1));
	assert.deepEqual([...g0.accents].sort(), [2, 3]);
	const g1 = op(parent, makeRole('prepend_append', 1, 4) as any, 0.5, mulberry32(1));
	assert.ok(g1.accents.has(0), `prepend step=1 должен добавить accent на 0`);
	assert.ok(!g1.accents.has(5), `prepend step=1 не должен трогать конец`);
	const g2 = op(parent, makeRole('prepend_append', 2, 4) as any, 0.5, mulberry32(1));
	assert.ok(g2.accents.has(5), `append step=2 должен добавить accent на live-1`);
	assert.ok(!g2.accents.has(0) || parent.bars[0]!.accents.has(0), `step=2 не добавляет 0`);
	const g3 = op(parent, makeRole('prepend_append', 3, 4) as any, 0.5, mulberry32(1));
	assert.ok(g3.accents.has(0) && g3.accents.has(5), `step=3: оба`);
}

function testFractalOperator() {
	const parent = makeParent({ curSyl: 5, accents: new Set([0]), subdivisions: {} });
	const op = MUTATION_OPERATORS.fractal;
	const g0 = op(parent, makeRole('fractal', 0, 3) as any, 0.5, mulberry32(1));
	assert.equal(Object.keys(g0.subdivisions).length, 0);
	const g2 = op(parent, makeRole('fractal', 2, 3) as any, 0.8, mulberry32(1));
	assert.ok(Object.keys(g2.subdivisions).length >= 1, `fractal step=2 должен задать хотя бы 1 subdiv`);
	// Значение subdiv равно curSyl parent (= 5).
	for (const v of Object.values(g2.subdivisions)) {
		assert.equal(v, 5, `fractal subdiv должен быть curSyl=${parent.bars[0]!.curSyl}`);
	}
}

function testTihaiOperator() {
	const parent = makeParent();
	const op = MUTATION_OPERATORS.tihai;
	const g0 = op(parent, makeRole('tihai', 0, 4) as any, 0.5, mulberry32(1));
	const g1 = op(parent, makeRole('tihai', 1, 4) as any, 0.5, mulberry32(1));
	const g2 = op(parent, makeRole('tihai', 2, 4) as any, 0.5, mulberry32(1));
	const g3 = op(parent, makeRole('tihai', 3, 4) as any, 0.5, mulberry32(1));
	// step=0 — чистый parent.
	assert.equal(g0.curSyl, parent.bars[0]!.curSyl);
	assert.deepEqual([...g0.accents].sort(), [...parent.bars[0]!.accents].sort());
	// step=1/2 должны отличаться от parent (у tihai теперь есть внутренняя динамика).
	assert.notDeepEqual([...g1.accents].sort(), [...parent.bars[0]!.accents].sort());
	assert.notDeepEqual([...g2.accents].sort(), [...parent.bars[0]!.accents].sort());
	// Landing всегда имеет Sam и конец.
	assert.ok(g3.accents.has(0), `tihai landing должен иметь Sam-accent`);
	assert.ok(g3.accents.has(g3.curSyl - 1), `tihai landing должен акцентировать конец`);
}

function testTihaiTurboAfter70ChaosEquivalent() {
	const parent = makeParent({ curSyl: 7, accents: new Set([0, 3]), subdivisions: {} });
	const op = MUTATION_OPERATORS.tihai;
	// intensity ~0.5 (до heavy) vs ~0.75 (heavy, 50+) vs ~1.1 (super, 70+)
	const base = op(parent, makeRole('tihai', 2, 4) as any, 0.5, mulberry32(10));
	const heavy = op(parent, makeRole('tihai', 2, 4) as any, 0.75, mulberry32(10));
	const high = op(parent, makeRole('tihai', 2, 4) as any, 1.1, mulberry32(10));
	assert.ok(
		Object.keys(heavy.subdivisions).length >= Object.keys(base.subdivisions).length,
		`tihai heavy(50+) должен быть плотнее base`,
	);
	assert.ok(heavy.accents.size >= base.accents.size, `tihai heavy(50+) должен быть насыщеннее base`);
	assert.ok(
		Object.keys(high.subdivisions).length >= Object.keys(heavy.subdivisions).length,
		`tihai turbo должен быть плотнее по subdivisions`,
	);
	// В отдельных seeds акцентные множества могут совпадать, ключевой критерий super — плотность subdivisions.
}

function testEchoDecayOperator() {
	const parent = makeParent({
		curSyl: 7,
		accents: new Set([0, 2, 4, 6]),
		subdivisions: { 1: 2, 3: 3, 5: 4 },
	});
	const op = MUTATION_OPERATORS.echo_decay;
	const g0 = op(parent, makeRole('echo_decay', 0, 4) as any, 0.8, mulberry32(1));
	assert.equal(g0.accents.size, 4);
	// step=3 intensity=0.8 → decayFactor=1 → keepRatio=0 → почти всё снято.
	let totalG3 = 0;
	for (let seed = 1; seed <= 20; seed++) {
		const g3 = op(parent, makeRole('echo_decay', 3, 4) as any, 0.8, mulberry32(seed));
		totalG3 += g3.accents.size + Object.keys(g3.subdivisions).length;
	}
	const avg = totalG3 / 20;
	assert.ok(avg < 2, `echo_decay step=3 intensity=0.8: avg остатка ${avg} должен быть < 2`);
}

function testNeighbourPulsationOperator() {
	const parent = makeParent({ curSyl: 5, accents: new Set([0, 2, 4]), subdivisions: { 1: 2 } });
	const op = MUTATION_OPERATORS.neighbour_pulsation;
	const g0 = op(parent, makeRole('neighbour_pulsation', 0, 3) as any, 0.5, mulberry32(1));
	assert.equal(g0.curSyl, 5);
	const g2 = op(parent, makeRole('neighbour_pulsation', 2, 3) as any, 0.5, mulberry32(1));
	assert.equal(g2.curSyl, 5, `step=2 возвращается к parent curSyl`);
	// step=1: curSyl сменится на ±1
	let deltas: number[] = [];
	for (let seed = 1; seed <= 20; seed++) {
		const g1 = op(parent, makeRole('neighbour_pulsation', 1, 3) as any, 0.5, mulberry32(seed));
		deltas.push(g1.curSyl - 5);
	}
	const unique = new Set(deltas);
	assert.ok(unique.has(-1) || unique.has(1), `step=1 должен давать ±1: deltas=${deltas}`);
	for (const d of deltas) {
		assert.ok(Math.abs(d) <= 1, `step=1 delta ${d} не в {-1, 0, 1}`);
	}
}

function testCallFillOperator() {
	const parent = makeParent({ curSyl: 7, accents: new Set([0, 3, 6]), subdivisions: {} });
	const op = MUTATION_OPERATORS.call_fill;
	const g0 = op(parent, makeRole('call_fill', 0, 4) as any, 0.5, mulberry32(1));
	const g2 = op(parent, makeRole('call_fill', 2, 4) as any, 0.5, mulberry32(1));
	// Call-бары идентичны parent.
	assert.deepEqual([...g0.accents].sort(), [0, 3, 6]);
	assert.deepEqual([...g2.accents].sort(), [0, 3, 6]);
	assert.equal(Object.keys(g0.subdivisions).length, 0);
	assert.equal(Object.keys(g2.subdivisions).length, 0);
	// Fill #1 (step=1): добавляет subdivisions.
	const g1 = op(parent, makeRole('call_fill', 1, 4) as any, 0.5, mulberry32(1));
	assert.ok(Object.keys(g1.subdivisions).length >= 1, `fill #1 должен добавить subdivisions`);
	// Fill #2 (step=3): retrograde + accent на конце.
	const g3 = op(parent, makeRole('call_fill', 3, 4) as any, 0.5, mulberry32(1));
	assert.ok(g3.accents.has(6), `fill #3 должен акцентировать last live cell`);
	// retrograde: 0→6, 3→3, 6→0 → ожидаем {0, 3, 6}.
	// С добавлением lastLive=6 — должно быть те же + 6 (уже там).
	assert.ok(g3.accents.size >= parent.bars[0]!.accents.size);
}

function testSchedulerTihaiHeavyPreset() {
	const sched = buildPhraseSchedule({
		bars: 40,
		enabledMutations: ['tihai', 'substitution'],
		preset: 'tihai_heavy',
		parentLength: 1,
		rng: mulberry32(1),
	});
	// Количество tihai должно быть выше, чем substitution.
	let tihaiCount = 0;
	let subCount = 0;
	const phraseStarts = new Set<number>();
	for (const r of sched) {
		if (r.phraseStep === 0 && r.type !== 'parent' && r.type !== 'free') {
			phraseStarts.add(r.phraseId);
			if (r.type === 'tihai') tihaiCount++;
			else if (r.type === 'substitution') subCount++;
		}
	}
	assert.ok(tihaiCount >= subCount, `tihai_heavy preset должен доминировать/не уступать по tihai: ${tihaiCount} vs ${subCount}`);
}

function testSchedulerTihaiHeavyDramaturgy24Bars() {
	const sched = buildPhraseSchedule({
		bars: 24,
		enabledMutations: ['tihai', 'substitution', 'retrograde'],
		preset: 'tihai_heavy',
		parentLength: 1,
		rng: mulberry32(11),
	});
	assert.equal(sched.length, 24, 'tihai_heavy должен покрывать все 24 такта');

	for (const idx of [0, 8, 16]) {
		assert.equal(sched[idx]?.type, 'parent', `такт ${idx + 1}: должен быть parent-anchor секции`);
	}

	for (const start of [4, 12, 20]) {
		for (let step = 0; step < 4; step++) {
			const role = sched[start + step]!;
			assert.equal(role.type, 'tihai', `такт ${start + step + 1}: должен быть частью tihai-каденции`);
			assert.equal(role.phraseStep, step, `такт ${start + step + 1}: неверный step в tihai-каденции`);
		}
	}
}

function testSchedulerCallFillDramaturgy16Bars() {
	const sched = buildPhraseSchedule({
		bars: 16,
		enabledMutations: ['call_fill', 'substitution', 'retrograde'],
		preset: 'call_fill',
		parentLength: 1,
		rng: mulberry32(21),
	});
	assert.equal(sched.length, 16, 'call_fill должен покрывать все 16 тактов');
	for (const idx of [0, 8]) {
		assert.equal(sched[idx]?.type, 'parent', `такт ${idx + 1}: должен быть parent-anchor секции`);
	}
	for (const start of [1, 9]) {
		for (let step = 0; step < 4; step++) {
			const role = sched[start + step]!;
			assert.equal(role.type, 'call_fill', `такт ${start + step + 1}: должен быть частью call_fill блока`);
			assert.equal(role.phraseStep, step, `такт ${start + step + 1}: неверный step в call_fill блоке`);
		}
	}
}

function testSchedulerCallFillDramaturgy32Bars() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: ['call_fill', 'substitution', 'retrograde'],
		preset: 'call_fill',
		parentLength: 1,
		rng: mulberry32(77),
	});
	assert.equal(sched.length, 32, 'call_fill должен покрывать все 32 такта');
	for (const idx of [0, 8, 16, 24]) {
		assert.equal(sched[idx]?.type, 'parent', `такт ${idx + 1}: должен быть parent-anchor секции`);
	}
	for (const start of [1, 9, 17, 25]) {
		for (let step = 0; step < 4; step++) {
			const role = sched[start + step]!;
			assert.equal(role.type, 'call_fill', `такт ${start + step + 1}: должен быть частью call_fill блока`);
			assert.equal(role.phraseStep, step, `такт ${start + step + 1}: неверный step в call_fill блоке`);
		}
	}
}

function testSchedulerProgressivePreset() {
	const sched = buildPhraseSchedule({
		bars: 10,
		enabledMutations: ['substitution', 'tihai', 'fractal'],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(1),
	});
	// Progressive → выбирает substitution первым (в порядке простой→сложный).
	const first = sched.find((r) => r.phraseStep === 0 && r.type !== 'parent' && r.type !== 'free');
	assert.equal(first?.type, 'substitution', `progressive preset должен начинать с substitution`);
}

function testSchedulerProgressiveStageCoverage32Bars() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(42),
	});
	let early = 0;
	let mid = 0;
	let late = 0;
	const earlySet = new Set<import('./parentMode').MutationType>(['substitution', 'inversion', 'retrograde', 'rotation']);
	const midSet = new Set<import('./parentMode').MutationType>(['augmentation', 'diminution', 'echo_decay', 'neighbour_pulsation', 'fractal']);
	for (const r of sched) {
		if (r.type === 'parent' || r.type === 'free') continue;
		if (earlySet.has(r.type)) early++;
		else if (midSet.has(r.type)) mid++;
		else late++;
	}
	assert.ok(early > 0, `progressive 32 bars: early stage должен присутствовать`);
	assert.ok(mid > 0, `progressive 32 bars: mid stage должен присутствовать`);
	assert.ok(late > 0, `progressive 32 bars: late stage должен присутствовать`);
}

function testSchedulerProgressiveDramaturgyAnchorsAndFlow() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(99),
	});
	assert.equal(sched.length, 32, 'progressive schedule должен покрывать все 32 такта');

	for (const idx of [0, 8, 16, 24]) {
		assert.equal(
			sched[idx]?.type,
			'parent',
			`такт ${idx + 1}: должен быть parent-anchor для сквозной темы`,
		);
	}

	const earlySet = new Set<import('./parentMode').MutationType>(['substitution', 'inversion', 'retrograde', 'rotation']);
	const midSet = new Set<import('./parentMode').MutationType>(['augmentation', 'diminution', 'echo_decay', 'neighbour_pulsation', 'fractal']);
	const lateSet = new Set<import('./parentMode').MutationType>(['prepend_append', 'truncation', 'tihai', 'call_fill']);

	let earlyInFirstThird = 0;
	let firstThirdTotal = 0;
	let lateInLastThird = 0;
	let lastThirdTotal = 0;
	for (let i = 0; i < sched.length; i++) {
		const t = sched[i]!.type;
		if (t === 'parent' || t === 'free') continue;
		if (i < 11) {
			firstThirdTotal++;
			if (earlySet.has(t)) earlyInFirstThird++;
		}
		if (i >= 21) {
			lastThirdTotal++;
			if (lateSet.has(t)) lateInLastThird++;
		}
	}
	assert.ok(firstThirdTotal > 0, 'в первой трети должны быть мутации');
	assert.ok(lastThirdTotal > 0, 'в финальной трети должны быть мутации');
	assert.ok(
		earlyInFirstThird >= Math.max(2, Math.floor(firstThirdTotal * 0.4)),
		`первая треть должна держать early-окраску: ${earlyInFirstThird}/${firstThirdTotal}`,
	);
	assert.ok(
		lateInLastThird >= 4,
		`финальная треть должна иметь выраженный late-блок: ${lateInLastThird}/${lastThirdTotal}`,
	);
}

function testIntegration16BarsAllMutations() {
	// End-to-end: парент из 1 такта, 16 бар, все 13 мутаций включены.
	const parent = makeParent({
		curSyl: 7,
		accents: new Set([0, 2, 4, 6]),
		subdivisions: { 1: 2, 5: 3 },
	});
	const rng = mulberry32(12345);
	const schedule = buildPhraseSchedule({
		bars: 16,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'random',
		parentLength: 1,
		rng,
	});
	assert.equal(schedule.length, 16);

	const m = makeEmpty();
	let mutatedCount = 0;
	for (let i = 0; i < 16; i++) {
		const changed = applyParentModeBar({
			barIdx: i,
			parent,
			schedule,
			chaos: 60,
			syllablesDefault: 4,
			m,
			rng: mulberry32(1000 + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
		if (changed) mutatedCount++;
		// Все бары должны получить curSyl (parent-каркас сохранён).
		assert.ok(m.customSyllables[i] !== undefined, `bar ${i} не получил curSyl`);
	}
	assert.ok(mutatedCount >= 10, `минимум 10 баров должны измениться: ${mutatedCount}/16`);
}

function testIntegrationParent2BarsAlternation() {
	// Парент из 2 тактов: барs=6, все parent-роли (enabledMutations пусто).
	const parent = makeParent(
		{ curSyl: 4, accents: new Set([0]), subdivisions: {} },
		{ curSyl: 5, accents: new Set([2]), subdivisions: {} },
	);
	const schedule = buildPhraseSchedule({
		bars: 6,
		enabledMutations: [],
		preset: 'random',
		parentLength: 2,
		rng: mulberry32(1),
	});
	const m = makeEmpty();
	for (let i = 0; i < 6; i++) {
		applyParentModeBar({
			barIdx: i,
			parent,
			schedule,
			chaos: 50,
			syllablesDefault: 4,
			m,
			rng: mulberry32(777 + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
	}
	// Чередование parent.bars[0] / parent.bars[1]:
	// bar 0: curSyl=4 (parent.bars[0]), bar 1: curSyl=5 (parent.bars[1]), bar 2: curSyl=4, ...
	for (let i = 0; i < 6; i++) {
		const expected = i % 2 === 0 ? 4 : 5;
		assert.equal(m.customSyllables[i], expected, `bar ${i}: ожидаемый curSyl=${expected}`);
	}
}

function testIntegrationDeterminismReplay() {
	// Парент + schedule + fixed seeds даёт 100% идентичный результат при повторе.
	const parent = makeParent();
	const schedule = buildPhraseSchedule({
		bars: 8,
		enabledMutations: ['tihai', 'rotation', 'call_fill'],
		preset: 'random',
		parentLength: 1,
		rng: mulberry32(2024),
	});

	const run = () => {
		const m = makeEmpty();
		for (let i = 0; i < 8; i++) {
			applyParentModeBar({
				barIdx: i,
				parent,
				schedule,
				chaos: 75,
				syllablesDefault: 4,
				m,
				rng: mulberry32(500 + i),
				freeAxes: {
					randomPulsation: false,
					randomPattern: false,
					randomSpeed: false,
					randomBarSpeed: false,
					forceFirstBeat: false,
				},
			});
		}
		return {
			syls: { ...m.customSyllables },
			accents: [...m.accents].sort(),
			subs: { ...m.customSubdivisions },
		};
	};

	const a = run();
	const b = run();
	assert.deepEqual(a.syls, b.syls);
	assert.deepEqual(a.accents, b.accents);
	assert.deepEqual(a.subs, b.subs);
}

function testPresetTargetBarsRangeAndExact() {
	assert.equal(PRESET_TARGET_BARS.random, 16);
	assert.equal(PRESET_TARGET_BARS.tihai_heavy, 24);
	assert.equal(PRESET_TARGET_BARS.progressive, 32);
	assert.equal(PRESET_TARGET_BARS.call_fill, 16);

	assert.equal(clampParentTargetBars(0), 1);
	assert.equal(clampParentTargetBars(1), 1);
	assert.equal(clampParentTargetBars(16), 16);
	assert.equal(clampParentTargetBars(32), 32);
	assert.equal(clampParentTargetBars(99), 32);
}

function testScheduleLongFormByPresetTargets() {
	// Для каждого пресета schedule должен покрывать всю целевую длину формы.
	const presets: Array<import('./parentMode').FormPresetId> = ['random', 'tihai_heavy', 'progressive', 'call_fill'];
	for (const preset of presets) {
		const bars = clampParentTargetBars(PRESET_TARGET_BARS[preset]);
		const schedule = buildPhraseSchedule({
			bars,
			enabledMutations: [...PRESET_ENABLED_MUTATIONS[preset]],
			preset,
			parentLength: 1,
			rng: mulberry32(12345),
		});
		assert.equal(schedule.length, bars, `preset=${preset}: schedule.length != target bars`);
		for (const role of schedule) {
			assert.ok(role.phraseStep >= 0 && role.phraseStep < role.phraseLength, `preset=${preset}: bad phraseStep`);
		}
	}
}

function testChaosIntensityIntegration() {
	// chaos=0 → intensity=0.2 → маленькие изменения (substitution k=1)
	// chaos=100 → intensity=0.8 → большие (substitution k=3)
	const parent = makeParent();
	const op = MUTATION_OPERATORS.substitution;
	const intensityLow = chaosToIntensity(0);
	const intensityHigh = chaosToIntensity(100);
	assert.ok(Math.abs(intensityLow - 0.2) < 1e-9);
	assert.ok(Math.abs(intensityHigh - 1.2) < 1e-9);
	// На высоком intensity кол-во изменений (k) больше в среднем.
	let countLow = 0;
	let countHigh = 0;
	for (let seed = 1; seed <= 20; seed++) {
		const gL = op(parent, makeRole('substitution', 1, 2) as any, intensityLow, mulberry32(seed));
		const gH = op(parent, makeRole('substitution', 1, 2) as any, intensityHigh, mulberry32(seed));
		const baseAcc = parent.bars[0]!.accents;
		let diffL = 0, diffH = 0;
		for (const c of gL.accents) if (!baseAcc.has(c)) diffL++;
		for (const c of baseAcc) if (!gL.accents.has(c)) diffL++;
		for (const c of gH.accents) if (!baseAcc.has(c)) diffH++;
		for (const c of baseAcc) if (!gH.accents.has(c)) diffH++;
		countLow += diffL;
		countHigh += diffH;
	}
	assert.ok(countHigh > countLow, `высокий intensity должен давать больше изменений: low=${countLow}, high=${countHigh}`);
}

const tests: [string, () => void][] = [
	['testChaosToIntensityRange', testChaosToIntensityRange],
	['testSnapshotBarGenomeRoundtrip', testSnapshotBarGenomeRoundtrip],
	['testCloneIsolation', testCloneIsolation],
	['testSubstitutionOperator', testSubstitutionOperator],
	['testRetrogradeOperator', testRetrogradeOperator],
	['testInversionOperator', testInversionOperator],
	['testSchedulerCoversAllBars', testSchedulerCoversAllBars],
	['testSchedulerDeterminism', testSchedulerDeterminism],
	['testSchedulerEmptyMutationsGivesAllParent', testSchedulerEmptyMutationsGivesAllParent],
	['testSchedulerPhraseIntegrity', testSchedulerPhraseIntegrity],
	['testApplyParentModeBarParentRole', testApplyParentModeBarParentRole],
	['testApplyParentModeBarSubstitutionRole', testApplyParentModeBarSubstitutionRole],
	['testParentGenomeJSONRoundtrip', testParentGenomeJSONRoundtrip],
	['testMutationPhraseLenComplete', testMutationPhraseLenComplete],
	['testRotationOperator', testRotationOperator],
	['testTruncationOperator', testTruncationOperator],
	['testAugmentationOperator', testAugmentationOperator],
	['testDiminutionOperator', testDiminutionOperator],
	['testPrependAppendOperator', testPrependAppendOperator],
	['testFractalOperator', testFractalOperator],
	['testTihaiOperator', testTihaiOperator],
	['testTihaiTurboAfter70ChaosEquivalent', testTihaiTurboAfter70ChaosEquivalent],
	['testEchoDecayOperator', testEchoDecayOperator],
	['testNeighbourPulsationOperator', testNeighbourPulsationOperator],
	['testCallFillOperator', testCallFillOperator],
	['testSchedulerTihaiHeavyPreset', testSchedulerTihaiHeavyPreset],
	['testSchedulerTihaiHeavyDramaturgy24Bars', testSchedulerTihaiHeavyDramaturgy24Bars],
	['testSchedulerCallFillDramaturgy16Bars', testSchedulerCallFillDramaturgy16Bars],
	['testSchedulerCallFillDramaturgy32Bars', testSchedulerCallFillDramaturgy32Bars],
	['testSchedulerProgressivePreset', testSchedulerProgressivePreset],
	['testSchedulerProgressiveStageCoverage32Bars', testSchedulerProgressiveStageCoverage32Bars],
	['testSchedulerProgressiveDramaturgyAnchorsAndFlow', testSchedulerProgressiveDramaturgyAnchorsAndFlow],
	['testChaosIntensityIntegration', testChaosIntensityIntegration],
	['testIntegration16BarsAllMutations', testIntegration16BarsAllMutations],
	['testIntegrationParent2BarsAlternation', testIntegrationParent2BarsAlternation],
	['testIntegrationDeterminismReplay', testIntegrationDeterminismReplay],
	['testPresetTargetBarsRangeAndExact', testPresetTargetBarsRangeAndExact],
	['testScheduleLongFormByPresetTargets', testScheduleLongFormByPresetTargets],
];

let failed = 0;
for (const [name, fn] of tests) {
	try {
		fn();
		console.log(`ok  ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL ${name}:`, (e as Error).message);
	}
}
if (failed > 0) {
	console.error(`${failed}/${tests.length} tests failed`);
	process.exit(1);
} else {
	console.log(`${tests.length}/${tests.length} tests passed`);
}
