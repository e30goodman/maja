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
import { applyRandomizerEffectsToBar, mulberry32, type BarRandomizerMutable } from './randomLogic';
import {
	ALL_MUTATION_TYPES,
	applyGenomeToBar,
	applyParentModeBar,
	buildPhraseSchedule,
	computeTihaiBlockBarCount,
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
import { buildBarLogForParentRow, computeMuktayiCheck, evaluateModeTruth } from './lessonLogger';
import {
	PRESET_ENABLED_MUTATIONS,
	PRESET_TARGET_BARS,
	clampParentTargetBars,
} from './parentModeUi';

const makeEmpty = (): BarRandomizerMutable => ({
	customSyllables: {},
	accents: new Set<string>(),
	customSubdivisions: {},
	customCellSyllables: {},
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
		customCellSyllables: { '0-2': 'Ja', '1-0': '-' },
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
	assert.equal(g0b.cellSyllables?.[2], 'Ja');
	assert.equal(m2.customCellSyllables['0-2'], 'Ja');
	assert.equal(m2.customCellSyllables['1-0'], '-');
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
	// step=1 — контрастные слоги в cellSyllables
	let withCells = 0;
	for (let seed = 1; seed <= 30; seed++) {
		const g1 = op(parent, makeRole('substitution', 1) as any, 0.5, mulberry32(seed));
		const cs = g1.cellSyllables;
		if (cs && Object.keys(cs).length >= 3) withCells++;
		if (cs) {
			for (const c of Object.keys(cs)) {
				const tok = cs[Number(c)];
				assert.ok(typeof tok === 'string' && tok.trim().length > 0, `substitution empty token at c=${c}`);
			}
		}
	}
	assert.ok(withCells >= 28, `substitution step=1 должен задавать cellSyllables: ${withCells}/30`);
}

function testRetrogradeOperator() {
	// Ta Ki Ta — палиндром slow; акценты {0,2} зеркально не меняются → complement.
	const parent = makeParent({ curSyl: 3, accents: new Set([0, 2]), subdivisions: {} });
	const op = MUTATION_OPERATORS.retrograde;
	const g0 = op(parent, makeRole('retrograde', 0) as any, 0.5, mulberry32(1));
	assert.deepEqual([...g0.accents].sort(), [0, 2]);
	const g1 = op(parent, makeRole('retrograde', 1) as any, 0.5, mulberry32(1));
	assert.deepEqual([...g1.accents].sort(), [1], 'палиндром слогов → принудительная инверсия акцентов');

	// несимметричный случай:
	const parentA = makeParent({ curSyl: 6, accents: new Set([0, 1, 3]), subdivisions: { 0: 2 } });
	const gA = op(parentA, makeRole('retrograde', 1) as any, 0.5, mulberry32(1));
	// 0→5, 1→4, 3→2
	assert.deepEqual([...gA.accents].sort((a, b) => a - b), [2, 4, 5], `retrograde accents: ${[...gA.accents].sort()}`);
	// subdivisions {0:2} → {5:2}
	assert.deepEqual(gA.subdivisions, { 5: 2 });
	for (const c of Object.keys(gA.cellSyllables ?? {})) {
		const tok = gA.cellSyllables?.[Number(c)];
		assert.ok(typeof tok === 'string' && tok.trim().length > 0, `retrograde empty token at c=${c}`);
	}
	// strict mirror: if source has explicit custom syllables, output must be exact reverse.
	const parentStrict = makeParent({
		curSyl: 4,
		accents: new Set([0, 2]),
		subdivisions: {},
		cellSyllables: { 0: 'Ta', 1: 'Ka', 2: 'Ju', 3: 'Nu' },
	});
	const gStrict = op(parentStrict, makeRole('retrograde', 1) as any, 0.5, mulberry32(123));
	const outStrict = [0, 1, 2, 3].map((c) => gStrict.cellSyllables?.[c]);
	assert.deepEqual(outStrict, ['Nu', 'Ju', 'Ka', 'Ta'], 'retrograde must be strict reverse of source syllables');
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

function testFreeRoleScrubsStaleThom() {
	const parent = makeParent({ curSyl: 4, accents: new Set([0]), subdivisions: {} });
	const m = makeEmpty();
	m.customSyllables[0] = 4;
	m.customCellSyllables['0-1'] = 'Thom';
	const schedule: PhraseRole[] = [makeRole('free', 0, 1, 0)];
	const changed = applyParentModeBar({
		barIdx: 0,
		parent,
		schedule,
		chaos: 0,
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
	assert.equal(m.customCellSyllables['0-1'], 'Ta', 'free-role should sanitize stale Thom');
	assert.equal(changed, true, 'sanitizing stale Thom should mark bar as changed');
}

function testRandomBarSpeedPrunesDeadZoneCellOverrides() {
	const m: BarRandomizerMutable = {
		customSyllables: { 0: 4 },
		accents: new Set(['0-0']),
		customSubdivisions: {},
		customCellSyllables: { '0-3': 'Thom' },
		customMultipliers: {},
		deadCells: {},
	};
	const changed = applyRandomizerEffectsToBar(
		0,
		100,
		false,
		false,
		false,
		true,
		false,
		4,
		m,
		mulberry32(1),
		false,
	);
	assert.equal(changed, true, 'bar-speed mutation should change bar');
	assert.equal(m.deadCells[0]?.deadStart, 1, 'seed=1 should produce deadStart=1 in this scenario');
	assert.equal(
		m.customCellSyllables['0-3'],
		undefined,
		'dead-zone cleanup must remove stale cell syllable overrides',
	);
}

function testParentGenomeJSONRoundtrip() {
	const p = makeParent(
		{
			curSyl: 7,
			accents: new Set([0, 3, 6]),
			subdivisions: { 1: 2, 5: 3 },
			deadStart: 6,
			cellSyllables: { 2: 'Ja', 4: '-' },
		},
		{ curSyl: 5, accents: new Set([0]), subdivisions: {} },
	);
	const json = parentGenomeToJSON(p);
	const back = parentGenomeFromJSON(json);
	assert.ok(back, `JSON roundtrip не распарсился`);
	assert.equal(back!.bars.length, 2);
	assert.equal(back!.bars[0]!.curSyl, 7);
	assert.deepEqual([...back!.bars[0]!.accents].sort(), [0, 3, 6]);
	assert.deepEqual(back!.bars[0]!.subdivisions, { 1: 2, 5: 3 });
	assert.deepEqual(back!.bars[0]!.cellSyllables, { 2: 'Ja', 4: '-' });
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
	const len = 6;
	const g0 = op(parent, makeRole('tihai', 0, len) as any, 0.5, mulberry32(1));
	const g1 = op(parent, makeRole('tihai', 1, len) as any, 0.5, mulberry32(1));
	const g5 = op(parent, makeRole('tihai', 5, len) as any, 0.5, mulberry32(1));
	assert.equal(g0.curSyl, parent.bars[0]!.curSyl);
	assert.deepEqual([...g0.accents].sort(), [...parent.bars[0]!.accents].sort());
	// step=1 — такт Karvai
	assert.ok(g1.cellSyllables && g1.curSyl === Object.keys(g1.cellSyllables).length);
	for (let c = 0; c < g1.curSyl; c++) assert.equal(g1.cellSyllables![c], '-');
	assert.equal(g1.accents.size, 0);
	// landing
	for (let c = 0; c < g5.curSyl; c++) {
		if (g5.cellSyllables?.[c] === 'Thom') {
			assert.ok(g5.accents.has(c), `tihai landing Thom must be accented`);
		}
	}
	assert.equal(g5.cellSyllables?.[g5.curSyl - 1], 'Thom');
}

function testTihaiFinalThomNeverStartsTrailingSilence() {
	const parent = makeParent({
		curSyl: 4,
		accents: new Set([0]),
		subdivisions: {},
		cellSyllables: { 0: 'Thom', 1: '-', 2: '-', 3: '-' },
	});
	const op = MUTATION_OPERATORS.tihai;
	const role = { ...(makeRole('tihai', 5, 6) as any), tihaiLandingIndex: 0 };
	const out = op(parent, role, 0.5, mulberry32(77));
	assert.equal(out.cellSyllables?.[out.curSyl - 1], 'Thom', 'final Thom must stay at last cell');
	assert.notEqual(out.cellSyllables?.[0], 'Thom', 'final Thom cannot appear at bar start');
}

function testTihaiTurboAfter70ChaosEquivalent() {
	const parent = makeParent({ curSyl: 7, accents: new Set([0, 3]), subdivisions: {} });
	const op = MUTATION_OPERATORS.tihai;
	const len = 6;
	// intensity ~0.5 (до heavy) vs ~0.75 (heavy, 50+) vs ~1.1 (super, 70+); шаг 4 = третья фраза (r=4)
	const base = op(parent, makeRole('tihai', 4, len) as any, 0.5, mulberry32(10));
	const heavy = op(parent, makeRole('tihai', 4, len) as any, 0.75, mulberry32(10));
	const high = op(parent, makeRole('tihai', 4, len) as any, 1.1, mulberry32(10));
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
	// step=1 в Gati-пути не должен менять размер такта.
	const g1Gati = op(
		parent,
		{ ...(makeRole('neighbour_pulsation', 1, 3) as any), deSyncJati: false },
		0.5,
		mulberry32(1),
	);
	assert.equal(g1Gati.curSyl, 5, 'gati neighbour must keep cycle size');
	assert.ok(Object.keys(g1Gati.subdivisions).length >= 1, 'gati neighbour should still add inner density movement');
	// step=1 в Jati-пути: curSyl сменится на ±1
	let deltas: number[] = [];
	for (let seed = 1; seed <= 20; seed++) {
		const g1 = op(
			parent,
			{ ...(makeRole('neighbour_pulsation', 1, 3) as any), deSyncJati: true },
			0.5,
			mulberry32(seed),
		);
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
		enabledMutations: ['tihai', 'substitution', 'diminution', 'rotation'],
		preset: 'tihai_heavy',
		parentLength: 1,
		rng: mulberry32(1),
	});
	let tihaiPhraseStarts = 0;
	for (const r of sched) {
		if (r.phraseStep === 0 && r.type === 'tihai') tihaiPhraseStarts++;
	}
	assert.equal(tihaiPhraseStarts, 2, 'tihai_heavy: ровно два блока тихая (середина + финал)');
	const lastFour = sched.slice(-4);
	assert.ok(lastFour.every((r) => r.type === 'tihai'), 'последние 4 такта — финальный tihai');
}

function testSchedulerTihaiHeavyDramaturgy24Bars() {
	const sched = buildPhraseSchedule({
		bars: 24,
		enabledMutations: ['tihai', 'substitution', 'retrograde', 'diminution', 'neighbour_pulsation', 'rotation'],
		preset: 'tihai_heavy',
		parentLength: 1,
		rng: mulberry32(11),
	});
	assert.equal(sched.length, 24, 'tihai_heavy должен покрывать все 24 такта');

	const tihaiStarts: number[] = [];
	for (let i = 0; i < sched.length; i++) {
		const r = sched[i]!;
		if (r.type === 'tihai' && r.phraseStep === 0) tihaiStarts.push(i);
	}
	assert.equal(tihaiStarts.length, 2, 'два tihai-блока (середина + финал)');
	const [midStart, finStart] = tihaiStarts;
	assert.ok(finStart >= 20, 'финальный tihai в последних 4 тактах');
	const midLen = sched[midStart]!.phraseLength;
	assert.ok(finStart - (midStart + midLen) >= 6, 'между серединным и финальным tihai ≥6 тактов развития');

	const finTihai0 = sched.findIndex((r, idx) => r.type === 'tihai' && r.phraseStep === 0 && idx >= 18);
	assert.ok(finTihai0 >= 18, 'финальный tihai ближе к концу формы');

	const breathPhraseTypes = new Set<string>([
		'diminution',
		'neighbour_pulsation',
		'rotation',
		'augmentation',
		'fractal',
	]);
	let breathStart = -1;
	for (let i = Math.min(finTihai0 - 1, sched.length - 3); i >= 0; i--) {
		const a = sched[i]!;
		const b = sched[i + 1]!;
		const c = sched[i + 2]!;
		if (
			breathPhraseTypes.has(a.type) &&
			a.phraseStep === 0 &&
			a.phraseLength === 3 &&
			a.phraseId === b.phraseId &&
			b.phraseId === c.phraseId &&
			b.phraseStep === 1 &&
			c.phraseStep === 2
		) {
			breathStart = i;
			break;
		}
	}
	assert.ok(breathStart >= 0, 'перед финалом должен быть 3-тактный блок «вдоха»');
	assert.ok(breathStart < finTihai0, '«вдох» строго перед финальным tihai');
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
			cellSyl: { ...m.customCellSyllables },
		};
	};

	const a = run();
	const b = run();
	assert.deepEqual(a.syls, b.syls);
	assert.deepEqual(a.accents, b.accents);
	assert.deepEqual(a.subs, b.subs);
	assert.deepEqual(a.cellSyl, b.cellSyl);
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
	const parent = makeParent({ curSyl: 7, accents: new Set([0, 3]), subdivisions: {} });
	const op = MUTATION_OPERATORS.augmentation;
	const intensityLow = chaosToIntensity(0);
	const intensityHigh = chaosToIntensity(100);
	assert.ok(Math.abs(intensityLow - 0.2) < 1e-9);
	assert.ok(Math.abs(intensityHigh - 1.2) < 1e-9);
	let countLow = 0;
	let countHigh = 0;
	for (let seed = 1; seed <= 20; seed++) {
		const gL = op(parent, makeRole('augmentation', 1, 3) as any, intensityLow, mulberry32(seed));
		const gH = op(parent, makeRole('augmentation', 1, 3) as any, intensityHigh, mulberry32(seed));
		countLow += Object.keys(gL.subdivisions).length;
		countHigh += Object.keys(gH.subdivisions).length;
	}
	assert.ok(countHigh >= countLow, `augmentation: высокий intensity не меньше subdiv-изменений: low=${countLow}, high=${countHigh}`);
}

function testComputeTihaiBlockSamAlignment() {
	const check = (off: number, L: number, n: number) => (((off + n * L - 1) % 8) + 8) % 8 === 0;
	assert.equal(computeTihaiBlockBarCount(0, 3), 3);
	assert.ok(check(0, 3, 3));
	const n243 = computeTihaiBlockBarCount(24, 3);
	assert.ok(check(24, 3, n243));
	assert.equal(computeTihaiBlockBarCount(0, 5), 5);
	assert.ok(check(0, 5, 5));
}

function testScheduleCarriesPulseOffsetForTihai() {
	const sched = buildPhraseSchedule({
		bars: 24,
		enabledMutations: ['tihai', 'augmentation', 'diminution', 'truncation', 'rotation'],
		preset: 'random',
		parentLength: 1,
		rng: mulberry32(77),
		motifPulseLen: 4,
	});
	let sawTihai = false;
	let prev = -1;
	for (const r of sched) {
		if (r.type === 'tihai') {
			sawTihai = true;
			assert.ok(typeof r.pulseOffsetBeforeBar === 'number', 'tihai role должен нести pulseOffsetBeforeBar');
			assert.ok((r.pulseOffsetBeforeBar ?? -1) >= prev, 'pulseOffsetBeforeBar должен быть неубывающим');
			prev = r.pulseOffsetBeforeBar ?? prev;
		}
	}
	assert.ok(sawTihai, 'ожидался хотя бы один tihai блок');
}

function testDensityFreezeWindowMarksRoles() {
	const sched16 = buildPhraseSchedule({
		bars: 16,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'random',
		parentLength: 1,
		rng: mulberry32(11),
	});
	for (let i = 0; i < sched16.length; i++) {
		const inFreeze = i >= 9 && i <= 10;
		const r = sched16[i]!;
		if (r.type === 'parent' || r.type === 'free') continue;
		assert.equal(Boolean(r.densityFreeze), inFreeze, `bar ${i + 1}: freeze flag mismatch`);
	}
}

function testTruncationEarlyCap15Percent() {
	const bars = 32;
	const sched = buildPhraseSchedule({
		bars,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(9090),
		chaosLevel: 30,
	});
	const earlyEnd = Math.ceil(bars / 3) - 1; // first third
	let truncBars = 0;
	for (let i = 0; i <= earlyEnd; i++) {
		if (sched[i]?.type === 'truncation') truncBars++;
	}
	assert.ok(truncBars <= Math.floor(bars * 0.15), `early truncation cap exceeded: ${truncBars}`);
}

function testProgressiveMidWindowForcesDeSyncAtChaos15() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(2026),
		progressiveDensityMode: 'jati_mode',
		deSyncJati: false,
		chaosLevel: 15,
	});
	const midDeSync = sched.findIndex((r, idx) => idx >= 7 && idx <= 19 && r.type !== 'parent' && r.type !== 'free' && r.deSyncJati === true);
	assert.ok(midDeSync >= 0, 'Chaos>=15 должен дать хотя бы одну de-sync фразу в окне 8–20');
}

function testDeSyncDeadCellsAndResyncBridge() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(424242),
		progressiveDensityMode: 'jati_mode',
		deSyncJati: false,
		chaosLevel: 35,
		motifPulseLen: 8,
	});
	const deSyncBarIdx = sched.findIndex((r, idx) => idx >= 7 && idx <= 19 && r.type !== 'parent' && r.type !== 'free' && r.deSyncJati === true);
	assert.ok(deSyncBarIdx >= 0, 'ожидался de-sync бар в середине формы');
	const m = makeEmpty();
	const parent = makeParent({ curSyl: 8, accents: new Set([0, 2, 4, 6]), subdivisions: {} });
	applyParentModeBar({
		barIdx: deSyncBarIdx,
		parent,
		schedule: sched,
		chaos: 50,
		syllablesDefault: 8,
		m,
		rng: mulberry32(99),
		freeAxes: {
			randomPulsation: false,
			randomPattern: false,
			randomSpeed: false,
			randomBarSpeed: false,
			forceFirstBeat: false,
		},
	});
	const dead = m.deadCells[deSyncBarIdx]?.deadStart;
	assert.ok(dead === undefined, 'de-sync не должен ампутировать фразу через dead-cells');
	const rowSyl = m.customSyllables[deSyncBarIdx];
	assert.ok(rowSyl === 5 || rowSyl === 7, 'de-sync должен переходить на целостный Jati-паттерн (5/7)');
	const tihaiStart = sched.findIndex((r, idx) => idx >= 24 && r.type === 'tihai' && r.phraseStep === 0);
	if (tihaiStart > 0) {
		const prev = sched[tihaiStart - 1];
		assert.ok(prev?.type === 'resync_bridge', 'перед финальным tihai должен быть отдельный resync_bridge');
	} else {
		const hasBridge = sched.some((r) => r.type === 'resync_bridge');
		assert.ok(hasBridge, 'при de-sync должен появляться bridge role даже если tihai не выбран в этом seed');
	}
}

function testChaos20NarrativeJourneyHasJatiAndResync() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(2027),
		progressiveDensityMode: 'jati_mode',
		deSyncJati: false,
		chaosLevel: 20,
		motifPulseLen: 8,
	});
	const deSyncIdx = sched.findIndex((r, idx) => idx >= 11 && idx <= 21 && r.type !== 'parent' && r.type !== 'free' && r.type !== 'resync_bridge' && r.deSyncJati === true);
	assert.ok(deSyncIdx >= 0, 'Chaos=20 должен гарантировать Jati de-sync в музыкальном окне 12–22');
	const tihaiStart = sched.findIndex((r, idx) => idx >= 24 && r.type === 'tihai' && r.phraseStep === 0);
	if (tihaiStart > 0) {
		assert.equal(sched[tihaiStart - 1]?.type, 'resync_bridge', 'перед финальным tihai должен стоять отдельный re-sync bridge');
	}
}

function testProgressiveGatiTargetEscalates() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(2028),
		progressiveDensityMode: 'gati_mode',
		deSyncJati: false,
		chaosLevel: 20,
	});
	const early = sched.filter((r, idx) => idx < 12 && r.type !== 'parent' && r.type !== 'free' && r.type !== 'resync_bridge');
	const late = sched.filter((r, idx) => idx >= 24 && r.type !== 'parent' && r.type !== 'free' && r.type !== 'resync_bridge');
	const earlyMax = Math.max(0, ...early.map((r) => r.gatiTargetSub ?? 0));
	const lateMax = Math.max(0, ...late.map((r) => r.gatiTargetSub ?? 0));
	assert.ok(earlyMax >= 4, 'ранняя фаза должна иметь gati target >=4');
	assert.ok(lateMax >= 8, 'поздняя фаза должна подниматься к gati target >=8');
}

function testParentRoleAlwaysHasFirstAccent() {
	const parent = makeParent({ curSyl: 4, accents: new Set(), subdivisions: {} });
	const m = makeEmpty();
	const schedule: PhraseRole[] = [makeRole('parent', 0, 1, 0)];
	applyParentModeBar({
		barIdx: 0,
		parent,
		schedule,
		chaos: 30,
		syllablesDefault: 4,
		m,
		rng: mulberry32(7),
		freeAxes: {
			randomPulsation: false,
			randomPattern: false,
			randomSpeed: false,
			randomBarSpeed: false,
			forceFirstBeat: false,
		},
	});
	assert.ok(m.accents.has('0-0'), 'exposition bar must always keep accent at index 0');
}

function testThomOnlyOnFinalTihaiLanding() {
	const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
	const m = makeEmpty();
	const schedule = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(707),
		chaosLevel: 25,
	});
	for (let i = 0; i < schedule.length; i++) {
		applyParentModeBar({
			barIdx: i,
			parent,
			schedule,
			chaos: 60,
			syllablesDefault: 4,
			m,
			rng: mulberry32(5000 + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
	}
	for (let i = 0; i < schedule.length; i++) {
		const role = schedule[i]!;
		const bar = snapshotBarGenome(i, 4, m);
		const entries = Object.entries(bar.cellSyllables ?? {});
		for (const [cStr, tok] of entries) {
			if (tok !== 'Thom') continue;
			const c = parseInt(cStr, 10);
			const landingIdx = role.type === 'tihai' ? Math.max(0, Math.min(bar.curSyl - 1, role.tihaiLandingIndex ?? bar.curSyl - 1)) : -1;
			const isFinalLanding = role.type === 'tihai' && role.phraseStep === role.phraseLength - 1 && c === landingIdx;
			assert.ok(isFinalLanding, `Thom is only allowed on final tihai landing; bar=${i + 1} cell=${c}`);
		}
	}
}

function testProgressiveFinalMuktayiIntensityPeaks() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(2029),
		chaosLevel: 30,
	});
	const tailTihai = sched.filter((r, idx) => idx >= 24 && r.type === 'tihai');
	assert.ok(tailTihai.length > 0, 'expected tihai block in final tail');
	const peak = Math.max(0, ...tailTihai.map((r) => r.intensityTarget ?? 0));
	assert.ok(peak >= 0.95, `final muktayi intensity should peak >= 0.95; got ${peak}`);
}

function testMuktayiAlwaysPassesAcrossSeeds() {
	for (const seed of [11, 42, 77, 109, 2048, 9001]) {
		const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
		const schedule = buildPhraseSchedule({
			bars: 32,
			enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
			preset: 'progressive',
			parentLength: 1,
			rng: mulberry32(seed),
			motifPulseLen: 4,
			chaosLevel: 35,
		});
		const m = makeEmpty();
		const bars = [];
		for (let i = 0; i < schedule.length; i++) {
			applyParentModeBar({
				barIdx: i,
				parent,
				schedule,
				chaos: 70,
				syllablesDefault: 4,
				m,
				rng: mulberry32(seed * 100 + i),
				freeAxes: {
					randomPulsation: false,
					randomPattern: false,
					randomSpeed: false,
					randomBarSpeed: false,
					forceFirstBeat: false,
				},
			});
			bars.push(
				buildBarLogForParentRow(i, schedule[i]!, 60, 4, {
					customSyllables: m.customSyllables,
					accents: m.accents,
					customSubdivisions: m.customSubdivisions,
					customCellSyllables: m.customCellSyllables,
					deadCells: m.deadCells,
				}),
			);
		}
		const check = computeMuktayiCheck(bars);
		assert.ok(check.ok, `Muktayi should always pass; seed=${seed} lines=${check.lines.join(' | ')}`);
	}
}

function testModeTruthDetectorRejectsFalseJati() {
	const verdict = evaluateModeTruth({
		modeTag: 'jati_mode',
		totalCells: 8,
		subdivisionHits: 2,
		maxSubdivision: 5,
		pulseOffsetBeforeBar: 16,
		localJati: 8,
	});
	assert.equal(verdict.resolvedModeTag, 'gati_mode');
	assert.equal(verdict.critical, 'CRITICAL: False Jati Mapping Detected (ImitationDetected).');
}

function testModeTruthDetectorAcceptsTrueGati() {
	const verdict = evaluateModeTruth({
		modeTag: 'gati_mode',
		totalCells: 8,
		subdivisionHits: 3,
		maxSubdivision: 6,
		pulseOffsetBeforeBar: 24,
		localJati: 8,
	});
	assert.equal(verdict.resolvedModeTag, 'gati_mode');
	assert.equal(verdict.critical, undefined);
}

function testModeTruthDetectorAcceptsTrueJati() {
	const verdict = evaluateModeTruth({
		modeTag: 'jati_mode',
		totalCells: 5,
		subdivisionHits: 0,
		maxSubdivision: 1,
		pulseOffsetBeforeBar: 13,
		localJati: 5,
	});
	assert.equal(verdict.resolvedModeTag, 'jati_mode');
	assert.equal(verdict.critical, undefined);
}

function testBarLogEmitsCriticalForFalseJatiMapping() {
	const role: PhraseRole = {
		type: 'augmentation',
		phraseId: 1,
		phraseStep: 1,
		phraseLength: 3,
		parentBarIdx: 0,
		deSyncJati: true,
		localCycleLength: 8,
		pulseOffsetBeforeBar: 16,
	};
	const m: BarRandomizerMutable = {
		customSyllables: { 0: 8 },
		accents: new Set(['0-0', '0-4']),
		customSubdivisions: { '0-1': 5, '0-3': 5 },
		customCellSyllables: {},
		customMultipliers: {},
		deadCells: {},
	};
	const bar = buildBarLogForParentRow(0, role, 90, 8, {
		customSyllables: m.customSyllables,
		accents: m.accents,
		customSubdivisions: m.customSubdivisions,
		customCellSyllables: m.customCellSyllables,
		deadCells: m.deadCells,
	});
	assert.equal(bar.modeTag, 'gati_mode', 'non-5/7/9 jati labels are gated to gati at source');
	assert.equal(bar.auditCritical, undefined, 'source gating should prevent false-jati critical noise');
}

function testJatiModeRequiresResyncBridgeBeforeFinalTihai() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(555),
		progressiveDensityMode: 'jati_mode',
		deSyncJati: true,
		deSyncCycleLength: 5,
		chaosLevel: 30,
	});
	const finalTihaiStart = sched.findIndex(
		(r, idx) => idx >= 24 && r.type === 'tihai' && r.phraseStep === 0,
	);
	assert.ok(finalTihaiStart > 0, 'expected final tail tihai');
	const prev = sched[finalTihaiStart - 1];
	assert.equal(prev?.type, 'resync_bridge', 'final jati tihai must be preceded by resync bridge');
}

function testChaosZeroDoesNotAutoTriggerJatiDeSync() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(321),
		progressiveDensityMode: 'jati_mode',
		deSyncJati: false,
		chaosLevel: 0,
	});
	const hasAutoDeSync = sched.some(
		(r) =>
			r.type !== 'parent' &&
			r.type !== 'free' &&
			r.type !== 'resync_bridge' &&
			r.deSyncJati === true,
	);
	assert.equal(hasAutoDeSync, false, 'Chaos=0 must not create random Jati de-sync');
}

function testResyncBridgeDoesNotOverwriteTihaiOnset() {
	const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(7777),
		progressiveDensityMode: 'jati_mode',
		deSyncJati: true,
		deSyncCycleLength: 5,
		chaosLevel: 25,
	});
	const tihaiStart = sched.findIndex((r, idx) => idx >= 24 && r.type === 'tihai' && r.phraseStep === 0);
	assert.ok(tihaiStart > 0, 'expected final tihai in tail');
	assert.equal(sched[tihaiStart - 1]?.type, 'resync_bridge', 'bridge must be separate role before tihai');

	const m: BarRandomizerMutable = {
		customSyllables: {},
		accents: new Set(),
		customSubdivisions: {},
		customCellSyllables: {},
		customMultipliers: {},
		deadCells: {},
	};
	for (let i = 0; i <= tihaiStart; i++) {
		applyParentModeBar({
			barIdx: i,
			parent,
			schedule: sched,
			chaos: 60,
			syllablesDefault: 4,
			m,
			rng: mulberry32(9000 + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
	}
	const firstTihaiGenome = snapshotBarGenome(tihaiStart, 4, m);
	const tokens = [0, 1, 2, 3].map((c) => firstTihaiGenome.cellSyllables?.[c] ?? 'Ta');
	const allRest = tokens.every((t) => t === '-');
	assert.equal(allRest, false, 'first tihai phrase onset cannot be overwritten by bridge karvai');
	const hasInternalRest = tokens.slice(1).some((t) => t === '-');
	assert.equal(hasInternalRest, false, 'first tihai phrase onset must stay whole; no hidden bridge rests inside tihai bar');
}

function testGatiModeKeepsBarSizeWhenAutoJatiDisabled() {
	const parent = makeParent({ curSyl: 8, accents: new Set([0, 4]), subdivisions: {} });
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(4242),
		progressiveDensityMode: 'gati_mode',
		deSyncJati: false,
		chaosLevel: 0,
	});
	const m: BarRandomizerMutable = {
		customSyllables: {},
		accents: new Set(),
		customSubdivisions: {},
		customCellSyllables: {},
		customMultipliers: {},
		deadCells: {},
	};
	for (let i = 0; i < sched.length; i++) {
		applyParentModeBar({
			barIdx: i,
			parent,
			schedule: sched,
			chaos: 80,
			syllablesDefault: 8,
			m,
			rng: mulberry32(12000 + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
		const curSyl = m.customSyllables[i];
		assert.equal(curSyl, 8, `with Chaos=0 auto-jati disabled, curSyl must stay 8; bar=${i + 1}`);
	}
}

function testAutoJatiAppearsWithoutManualModeSwitch() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(9331),
		progressiveDensityMode: 'gati_mode',
		deSyncJati: false,
		chaosLevel: 30,
	});
	const hasAutoJati = sched.some(
		(r, idx) =>
			idx >= 7 &&
			idx <= 21 &&
			r.type !== 'parent' &&
			r.type !== 'free' &&
			r.type !== 'resync_bridge' &&
			r.deSyncJati === true,
	);
	assert.equal(hasAutoJati, true, 'Progressive + Chaos>0 must auto-trigger Jati without manual switch');
	const hasTriggerInstruction = sched.some(
		(r) =>
			r.type !== 'parent' &&
			r.type !== 'free' &&
			r.type !== 'resync_bridge' &&
			r.deSyncJati === true &&
			(r.triggerJatiAction?.targetCurSyl === 5 ||
				r.triggerJatiAction?.targetCurSyl === 7 ||
				r.triggerJatiAction?.targetCurSyl === 9),
	);
	assert.equal(hasTriggerInstruction, true, 'auto-jati roles must carry explicit app-layer trigger instructions');
}

function testAutoJatiProbabilityInReasonableBand() {
	const runs = 120;
	let hit = 0;
	for (let seed = 1; seed <= runs; seed++) {
		const sched = buildPhraseSchedule({
			bars: 32,
			enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
			preset: 'progressive',
			parentLength: 1,
			rng: mulberry32(10000 + seed),
			progressiveDensityMode: 'gati_mode',
			deSyncJati: false,
			chaosLevel: 10,
		});
		const hasJati = sched.some(
			(r, idx) =>
				idx >= 7 &&
				idx <= 21 &&
				r.type !== 'parent' &&
				r.type !== 'free' &&
				r.type !== 'resync_bridge' &&
				r.deSyncJati === true,
		);
		if (hasJati) hit++;
	}
	const ratio = hit / runs;
	assert.ok(ratio >= 0.45 && ratio <= 0.85, `auto-jati hit ratio out of range: ${ratio}`);
}

function testAutoJatiMutatesToPhysical5or7or9() {
	const parent = makeParent({ curSyl: 8, accents: new Set([0, 4]), subdivisions: {} });
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(8128),
		progressiveDensityMode: 'gati_mode',
		deSyncJati: false,
		chaosLevel: 45,
		motifPulseLen: 8,
	});
	const m = makeEmpty();
	for (let i = 0; i < sched.length; i++) {
		applyParentModeBar({
			barIdx: i,
			parent,
			schedule: sched,
			chaos: 70,
			syllablesDefault: 8,
			m,
			rng: mulberry32(30000 + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
	}
	const jatiBars: number[] = [];
	for (let i = 0; i < sched.length; i++) {
		const r = sched[i]!;
		if (r.type === 'parent' || r.type === 'free' || r.type === 'resync_bridge' || r.deSyncJati !== true) continue;
		jatiBars.push(i);
		const curSyl = m.customSyllables[i];
		assert.ok(curSyl === 5 || curSyl === 7 || curSyl === 9, `auto-jati must physically set 5/7/9, got ${curSyl} at bar ${i + 1}`);
		assert.ok(
			r.triggerJatiAction?.targetCurSyl === 5 ||
				r.triggerJatiAction?.targetCurSyl === 7 ||
				r.triggerJatiAction?.targetCurSyl === 9,
			`auto-jati role must include triggerJatiAction targetCurSyl at bar ${i + 1}`,
		);
	}
	assert.ok(jatiBars.length > 0, 'expected at least one physical auto-jati bar');
}

function testAutoJatiExitsViaResyncBeforeFinalTihai() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(4771),
		progressiveDensityMode: 'gati_mode',
		deSyncJati: false,
		chaosLevel: 35,
		motifPulseLen: 8,
	});
	const tihaiStart = sched.findIndex((r, idx) => idx >= 24 && r.type === 'tihai' && r.phraseStep === 0);
	assert.ok(tihaiStart > 0, 'expected final tail tihai');
	assert.equal(sched[tihaiStart - 1]?.type, 'resync_bridge', 'auto-jati must pass through resync_bridge before final tihai');
}

function testResyncBridgeNonJatiCycleDoesNotEmitLocalJati() {
	const role: PhraseRole = {
		type: 'resync_bridge',
		phraseId: 2,
		phraseStep: 0,
		phraseLength: 1,
		parentBarIdx: 0,
		pulseOffsetBeforeBar: 16,
		localCycleLength: 4,
		bridgeKind: 'gati_prep',
	};
	const m: BarRandomizerMutable = {
		customSyllables: { 0: 4 },
		accents: new Set(['0-0']),
		customSubdivisions: {},
		customCellSyllables: {},
		customMultipliers: {},
		deadCells: {},
	};
	const bar = buildBarLogForParentRow(0, role, 90, 4, {
		customSyllables: m.customSyllables,
		accents: m.accents,
		customSubdivisions: m.customSubdivisions,
		customCellSyllables: m.customCellSyllables,
		deadCells: m.deadCells,
	});
	assert.equal(bar.modeTag, 'gati_mode', 'non-5/7/9 bridge should stay gati');
	assert.equal(bar.localJati, undefined, 'non-5/7/9 bridge must not emit Local Jati');
	assert.equal(bar.auditCritical, undefined, 'non-5/7/9 bridge must not emit false-jati critical');
}

function testProgressiveSeed3478844360MuktayiPasses() {
	const seed = 3478844360;
	const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
	const schedule = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(seed),
		motifPulseLen: 4,
		chaosLevel: 35,
	});
	const m = makeEmpty();
	const bars = [];
	for (let i = 0; i < schedule.length; i++) {
		applyParentModeBar({
			barIdx: i,
			parent,
			schedule,
			chaos: 70,
			syllablesDefault: 4,
			m,
			rng: mulberry32(seed + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
		bars.push(
			buildBarLogForParentRow(i, schedule[i]!, 60, 4, {
				customSyllables: m.customSyllables,
				accents: m.accents,
				customSubdivisions: m.customSubdivisions,
				customCellSyllables: m.customCellSyllables,
				deadCells: m.deadCells,
			}),
		);
	}
	const check = computeMuktayiCheck(bars);
	assert.ok(check.ok, `Muktayi should pass for seed=${seed}; lines=${check.lines.join(' | ')}`);
}

function testNoImitationDetectedForValidProgressiveJatiScenarios() {
	for (const seed of [0x754a1685, 0x4ae774a6]) {
		const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
		const schedule = buildPhraseSchedule({
			bars: 32,
			enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
			preset: 'progressive',
			parentLength: 1,
			rng: mulberry32(seed),
			motifPulseLen: 4,
			chaosLevel: 35,
		});
		const m = makeEmpty();
		const logs = [];
		for (let i = 0; i < schedule.length; i++) {
			applyParentModeBar({
				barIdx: i,
				parent,
				schedule,
				chaos: 70,
				syllablesDefault: 4,
				m,
				rng: mulberry32(seed + 100 + i),
				freeAxes: {
					randomPulsation: false,
					randomPattern: false,
					randomSpeed: false,
					randomBarSpeed: false,
					forceFirstBeat: false,
				},
			});
			logs.push(
				buildBarLogForParentRow(i, schedule[i]!, 60, 4, {
					customSyllables: m.customSyllables,
					accents: m.accents,
					customSubdivisions: m.customSubdivisions,
					customCellSyllables: m.customCellSyllables,
					deadCells: m.deadCells,
				}),
			);
		}
		const hasImitationDetected = logs.some((b) => (b.auditCritical ?? '').includes('ImitationDetected'));
		assert.equal(hasImitationDetected, false, `no ImitationDetected expected for seed=${seed.toString(16)}`);
	}
}

function testNoFalseJatiMappingForSeedE43CD609() {
	const seed = 0xe43cd609;
	const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
	const schedule = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(seed),
		progressiveDensityMode: 'gati_mode',
		deSyncJati: false,
		chaosLevel: 35,
		motifPulseLen: 4,
	});
	const m = makeEmpty();
	const logs = [];
	for (let i = 0; i < schedule.length; i++) {
		applyParentModeBar({
			barIdx: i,
			parent,
			schedule,
			chaos: 70,
			syllablesDefault: 4,
			m,
			rng: mulberry32(seed + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
		logs.push(
			buildBarLogForParentRow(i, schedule[i]!, 60, 4, {
				customSyllables: m.customSyllables,
				accents: m.accents,
				customSubdivisions: m.customSubdivisions,
				customCellSyllables: m.customCellSyllables,
				deadCells: m.deadCells,
			}),
		);
	}
	const hasImitationDetected = logs.some((b) => (b.auditCritical ?? '').includes('ImitationDetected'));
	assert.equal(hasImitationDetected, false, 'seed e43cd609 must not emit False Jati Mapping');
	for (const b of logs) {
		if (b.modeTag !== 'jati_mode') continue;
		assert.ok(
			b.totalCells === 5 || b.totalCells === 7 || b.totalCells === 9,
			`jati_mode must have physical 5/7/9 cells; bar=${b.index + 1}, total=${b.totalCells}`,
		);
	}
}

function testReportedFailSeedsNowAlwaysPassMuktayi() {
	const seeds = [0x8e385828, 0x9767146c];
	const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
	for (const seed of seeds) {
		const schedule = buildPhraseSchedule({
			bars: 32,
			enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
			preset: 'progressive',
			parentLength: 1,
			rng: mulberry32(seed),
			progressiveDensityMode: 'gati_mode',
			deSyncJati: false,
			chaosLevel: 35,
			motifPulseLen: 4,
		});
		const m = makeEmpty();
		const bars = [];
		for (let i = 0; i < schedule.length; i++) {
			applyParentModeBar({
				barIdx: i,
				parent,
				schedule,
				chaos: 70,
				syllablesDefault: 4,
				m,
				rng: mulberry32(seed + i),
				freeAxes: {
					randomPulsation: false,
					randomPattern: false,
					randomSpeed: false,
					randomBarSpeed: false,
					forceFirstBeat: false,
				},
			});
			bars.push(
				buildBarLogForParentRow(i, schedule[i]!, 60, 4, {
					customSyllables: m.customSyllables,
					accents: m.accents,
					customSubdivisions: m.customSubdivisions,
					customCellSyllables: m.customCellSyllables,
					deadCells: m.deadCells,
				}),
			);
		}
		const check = computeMuktayiCheck(bars);
		assert.equal(check.ok, true, `reported fail seed must pass now: 0x${seed.toString(16)}`);
		const mod = computeFinalLandingMod8(bars);
		assert.equal(mod, 7, `seed 0x${seed.toString(16)} must land at mod 7`);
	}
}

function testBridgeAndDeSyncTraceForInvestigationSeeds() {
	const seeds = [0x754a1685, 0x4ae774a6, 0xcf5af3c8];
	for (const seed of seeds) {
		const schedule = buildPhraseSchedule({
			bars: 32,
			enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
			preset: 'progressive',
			parentLength: 1,
			rng: mulberry32(seed),
			progressiveDensityMode: 'gati_mode',
			deSyncJati: false,
			chaosLevel: 35,
			motifPulseLen: 4,
		});
		const trace = schedule
			.map((role, idx) => ({
				bar: idx + 1,
				role: role.type,
				localJati: role.localCycleLength ?? 4,
				totalCells: role.localCycleLength ?? 4,
				pulseOffsetBeforeBar: role.pulseOffsetBeforeBar ?? (idx * 4),
				deSyncJati: role.deSyncJati === true,
			}))
			.filter((x) => x.role === 'resync_bridge' || x.deSyncJati)
			.map(({ deSyncJati, ...rest }) => rest);
		assert.ok(trace.length > 0, `expected non-empty de-sync trace for seed=0x${seed.toString(16)}`);
		const hasOddCycle = trace.some((x) => x.localJati === 7 || x.localJati === 9);
		assert.ok(hasOddCycle, `expected odd-cycle trace segments for seed=0x${seed.toString(16)}`);
		const tailPrep = trace.find((x) => x.bar >= 24 && x.role === 'resync_bridge');
		assert.ok(tailPrep, `expected tail bridge before final tihai for seed=0x${seed.toString(16)}`);
		const hasTihaiTail = schedule.some((r, idx) => idx >= 24 && r.type === 'tihai');
		assert.ok(hasTihaiTail, `expected final tail tihai for seed=0x${seed.toString(16)}`);
	}
}

function testOddJatiTailBridgeForReferenceSeed3478844360() {
	const seed = 3478844360;
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(seed),
		progressiveDensityMode: 'gati_mode',
		deSyncJati: false,
		chaosLevel: 35,
		motifPulseLen: 4,
	});
	const prep = sched.find((r, idx) => idx >= 24 && r.type === 'resync_bridge' && r.bridgeKind === 'gati_prep');
	assert.ok(prep, 'reference seed must contain gati_prep bridge in tail');
	assert.ok(
		prep?.localCycleLength === 7 || prep?.localCycleLength === 9 || prep?.localCycleLength === 5,
		'gati_prep must use discrete prep length (5/7/9)',
	);
	const tihaiStart = sched.findIndex((r, idx) => idx >= 24 && r.type === 'tihai' && r.phraseStep === 0);
	assert.ok(tihaiStart > 0, 'reference seed must end with tail tihai');
	const prev = sched[tihaiStart - 1];
	assert.equal(prev?.type, 'resync_bridge', 'tail tihai must start right after bridge');
}

function testOddJatiConsistencyPulseOffsetVsPhysicalBarLengthInTail() {
	const seeds = [3478844360, 0xcf5af3c8, 0x4ae774a6];
	for (const seed of seeds) {
		const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
		const sched = buildPhraseSchedule({
			bars: 32,
			enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
			preset: 'progressive',
			parentLength: 1,
			rng: mulberry32(seed),
			progressiveDensityMode: 'gati_mode',
			deSyncJati: false,
			chaosLevel: 35,
			motifPulseLen: 4,
		});
		const m = makeEmpty();
		const bars = [];
		for (let i = 0; i < sched.length; i++) {
			applyParentModeBar({
				barIdx: i,
				parent,
				schedule: sched,
				chaos: 70,
				syllablesDefault: 4,
				m,
				rng: mulberry32(seed + i),
				freeAxes: {
					randomPulsation: false,
					randomPattern: false,
					randomSpeed: false,
					randomBarSpeed: false,
					forceFirstBeat: false,
				},
			});
			bars.push(
				buildBarLogForParentRow(i, sched[i]!, 60, 4, {
					customSyllables: m.customSyllables,
					accents: m.accents,
					customSubdivisions: m.customSubdivisions,
					customCellSyllables: m.customCellSyllables,
					deadCells: m.deadCells,
				}),
			);
		}
		for (let i = 24; i < bars.length - 1; i++) {
			const cur = bars[i]!;
			const next = bars[i + 1]!;
			if (typeof cur.pulseOffsetBeforeBar !== 'number' || typeof next.pulseOffsetBeforeBar !== 'number') continue;
			const declaredStep = next.pulseOffsetBeforeBar - cur.pulseOffsetBeforeBar;
			const physicalStep = cur.syllables.length;
			assert.equal(
				declaredStep,
				physicalStep,
				`tail pulse mismatch seed=${seed} bar=${i + 1}: declared=${declaredStep}, physical=${physicalStep}`,
			);
		}
	}
}

function testOddJatiMuktayiPassesForSevenAndNineCycleExamples() {
	const seeds = [3478844360, 321, 1726, 2149, 0xcf5af3c8, 0x4ae774a6];
	const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
	for (const seed of seeds) {
		const sched = buildPhraseSchedule({
			bars: 32,
			enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
			preset: 'progressive',
			parentLength: 1,
			rng: mulberry32(seed),
			progressiveDensityMode: 'gati_mode',
			deSyncJati: false,
			chaosLevel: 35,
			motifPulseLen: 4,
		});
		const oddCycles = new Set<number>();
		for (const role of sched) {
			const l = (role as { localCycleLength?: number }).localCycleLength;
			if (l === 7 || l === 9) oddCycles.add(l);
		}
		if (oddCycles.size === 0) continue;
		const m = makeEmpty();
		const bars = [];
		for (let i = 0; i < sched.length; i++) {
			applyParentModeBar({
				barIdx: i,
				parent,
				schedule: sched,
				chaos: 70,
				syllablesDefault: 4,
				m,
				rng: mulberry32(seed + i),
				freeAxes: {
					randomPulsation: false,
					randomPattern: false,
					randomSpeed: false,
					randomBarSpeed: false,
					forceFirstBeat: false,
				},
			});
			bars.push(
				buildBarLogForParentRow(i, sched[i]!, 60, 4, {
					customSyllables: m.customSyllables,
					accents: m.accents,
					customSubdivisions: m.customSubdivisions,
					customCellSyllables: m.customCellSyllables,
					deadCells: m.deadCells,
				}),
			);
		}
		const check = computeMuktayiCheck(bars);
		assert.ok(check.ok, `odd-jati muktayi must pass for seed=${seed}, odd=${[...oddCycles].join(',')}`);
	}
}

function testOddJatiDiagnosticSeed89NowLandsOnMod7() {
	const seed = 89;
	const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(seed),
		progressiveDensityMode: 'gati_mode',
		deSyncJati: false,
		chaosLevel: 35,
		motifPulseLen: 4,
	});
	const m = makeEmpty();
	const bars = [];
	for (let i = 0; i < sched.length; i++) {
		applyParentModeBar({
			barIdx: i,
			parent,
			schedule: sched,
			chaos: 70,
			syllablesDefault: 4,
			m,
			rng: mulberry32(seed + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
		bars.push(
			buildBarLogForParentRow(i, sched[i]!, 60, 4, {
				customSyllables: m.customSyllables,
				accents: m.accents,
				customSubdivisions: m.customSubdivisions,
				customCellSyllables: m.customCellSyllables,
				deadCells: m.deadCells,
			}),
		);
	}
	const check = computeMuktayiCheck(bars);
	assert.equal(check.ok, true, 'after fix diagnostic odd-jati seed should pass');
	const firstPrep = bars.find((b) => b.bridgeKind === 'gati_prep');
	assert.ok(firstPrep, 'diagnostic seed should still use explicit gati_prep in tail');
	assert.notEqual(firstPrep?.totalCells, 5, 'tail fix must avoid unstable prepLen=5 pattern for this seed');
	const lastBar = bars[bars.length - 1]!;
	let lastIdx = lastBar.syllables.length - 1;
	while (lastIdx >= 0 && ['-', '.', '—', ''].includes((lastBar.syllables[lastIdx] ?? '').trim())) lastIdx--;
	let pulsesBefore = 0;
	for (let i = 0; i < bars.length - 1; i++) pulsesBefore += bars[i]!.syllables.length;
	const globalPulse = pulsesBefore + Math.max(0, lastIdx);
	assert.equal(globalPulse % 8, 7, `diagnostic landing must be mod 7, got ${globalPulse % 8}`);
}

function testResyncIsCompleteBeforeBar28ForReportedSeeds() {
	const seeds = [0x8cdc900a, 0x6f7aec77];
	const parent = makeParent({ curSyl: 5, accents: new Set([0, 2, 4]), subdivisions: {} });
	for (const seed of seeds) {
		const sched = buildPhraseSchedule({
			bars: 32,
			enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
			preset: 'progressive',
			parentLength: 1,
			rng: mulberry32(seed),
			progressiveDensityMode: 'gati_mode',
			deSyncJati: false,
			chaosLevel: 35,
			motifPulseLen: 5,
		});
		const m = makeEmpty();
		for (let i = 0; i < sched.length; i++) {
			applyParentModeBar({
				barIdx: i,
				parent,
				schedule: sched,
				chaos: 70,
				syllablesDefault: 5,
				m,
				rng: mulberry32(seed + i),
				freeAxes: {
					randomPulsation: false,
					randomPattern: false,
					randomSpeed: false,
					randomBarSpeed: false,
					forceFirstBeat: false,
				},
			});
		}
		const role28 = sched[27] as any;
		if (role28?.type !== 'tihai') continue;
		assert.equal(role28?.tihaiGapBars ?? 0, 0, `seed=0x${seed.toString(16)}: bar 28 tihai must not be gap-bar`);
		const b28 = buildBarLogForParentRow(27, sched[27]!, 60, 5, {
			customSyllables: m.customSyllables,
			accents: m.accents,
			customSubdivisions: m.customSubdivisions,
			customCellSyllables: m.customCellSyllables,
			deadCells: m.deadCells,
		});
		const hasTaRestTaPattern =
			b28.syllables.length >= 5 &&
			b28.syllables[0]?.trim() === 'Ta' &&
			b28.syllables[1]?.trim() === '-' &&
			b28.syllables[2]?.trim() === '-' &&
			b28.syllables[3]?.trim() === '-' &&
			b28.syllables[4]?.trim() === 'Ta';
		assert.equal(
			hasTaRestTaPattern,
			false,
			`seed=0x${seed.toString(16)}: bar 28 must not contain Ta---Ta karvai artifact after re-sync`,
		);
	}
}

function testReportedLateFailSeedsNowLandOnSam() {
	const seeds = [0xb487ed44, 0x626cbb5c];
	const parent = makeParent({ curSyl: 5, accents: new Set([0, 2, 4]), subdivisions: {} });
	for (const seed of seeds) {
		const sched = buildPhraseSchedule({
			bars: 32,
			enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
			preset: 'progressive',
			parentLength: 1,
			rng: mulberry32(seed),
			progressiveDensityMode: 'gati_mode',
			deSyncJati: false,
			chaosLevel: 35,
			motifPulseLen: 5,
		});
		const m = makeEmpty();
		const bars = [];
		for (let i = 0; i < sched.length; i++) {
			applyParentModeBar({
				barIdx: i,
				parent,
				schedule: sched,
				chaos: 70,
				syllablesDefault: 5,
				m,
				rng: mulberry32(seed + i),
				freeAxes: {
					randomPulsation: false,
					randomPattern: false,
					randomSpeed: false,
					randomBarSpeed: false,
					forceFirstBeat: false,
				},
			});
			bars.push(
				buildBarLogForParentRow(i, sched[i]!, 60, 5, {
					customSyllables: m.customSyllables,
					accents: m.accents,
					customSubdivisions: m.customSubdivisions,
					customCellSyllables: m.customCellSyllables,
					deadCells: m.deadCells,
				}),
			);
		}
		const check = computeMuktayiCheck(bars);
		assert.equal(check.ok, true, `seed=0x${seed.toString(16)}: final landing must pass on sam`);
	}
}

function buildProgressiveTailInvestigationCase(seed: number, deSyncJati: boolean, deSyncCycleLength?: 5 | 7 | 9) {
	const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
	const schedule = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(seed),
		progressiveDensityMode: 'gati_mode',
		deSyncJati,
		deSyncCycleLength,
		chaosLevel: 35,
		motifPulseLen: 4,
	});
	const m = makeEmpty();
	const bars = [];
	for (let i = 0; i < schedule.length; i++) {
		applyParentModeBar({
			barIdx: i,
			parent,
			schedule,
			chaos: 70,
			syllablesDefault: 4,
			m,
			rng: mulberry32(seed + i),
			freeAxes: {
				randomPulsation: false,
				randomPattern: false,
				randomSpeed: false,
				randomBarSpeed: false,
				forceFirstBeat: false,
			},
		});
		bars.push(
			buildBarLogForParentRow(i, schedule[i]!, 60, 4, {
				customSyllables: m.customSyllables,
				accents: m.accents,
				customSubdivisions: m.customSubdivisions,
				customCellSyllables: m.customCellSyllables,
				deadCells: m.deadCells,
			}),
		);
	}
	return { schedule, bars };
}

function computeFinalLandingMod8(bars: Array<{ syllables: string[] }>): number {
	const lastBar = bars[bars.length - 1]!;
	let lastIdx = lastBar.syllables.length - 1;
	while (lastIdx >= 0 && ['-', '.', '—', ''].includes((lastBar.syllables[lastIdx] ?? '').trim())) lastIdx--;
	let pulsesBefore = 0;
	for (let i = 0; i < bars.length - 1; i++) pulsesBefore += bars[i]!.syllables.length;
	const globalPulse = pulsesBefore + Math.max(0, lastIdx);
	return ((globalPulse % 8) + 8) % 8;
}

function testPhase6BaselineSeed3478844360TailLedgerAndLanding() {
	const seed = 3478844360;
	const { schedule, bars } = buildProgressiveTailInvestigationCase(seed, false);
	const tailRoles = schedule
		.map((r, idx) => ({ idx, role: r }))
		.filter(({ idx }) => idx >= 24);
	assert.ok(tailRoles.length > 0, 'tail ledger must be non-empty');

	const tihaiStart = schedule.findIndex((r, idx) => idx >= 24 && r.type === 'tihai' && r.phraseStep === 0);
	assert.ok(tihaiStart > 0, 'baseline seed must contain final tail tihai start');
	const bridge = schedule[tihaiStart - 1];
	assert.equal(bridge?.type, 'resync_bridge', 'tail must include explicit bridge right before final tihai');
	assert.equal((bridge as any)?.bridgeKind, 'gati_prep', 'tail bridge before final tihai must be gati_prep');
	assert.ok(
		(bridge as any)?.localCycleLength === 5 ||
			(bridge as any)?.localCycleLength === 7 ||
			(bridge as any)?.localCycleLength === 9,
		'gati_prep bridge must carry odd-cycle prep length (5/7/9)',
	);

	for (let i = 24; i < schedule.length - 1; i++) {
		const cur = schedule[i]!;
		const next = schedule[i + 1]!;
		if (typeof (cur as any).pulseOffsetBeforeBar !== 'number' || typeof (next as any).pulseOffsetBeforeBar !== 'number') continue;
		assert.ok(
			((next as any).pulseOffsetBeforeBar as number) >= ((cur as any).pulseOffsetBeforeBar as number),
			`tail pulse ledger must be monotonic at bar ${i + 1}`,
		);
	}

	const mod = computeFinalLandingMod8(bars);
	assert.equal(mod, 7, `baseline seed final landing must be mod 7, got ${mod}`);
}

function testPhase6OddCycleSevenAndNineBridgeToMod7() {
	const scenarios: Array<{ label: '7/8' | '9/8'; cycle: 7 | 9; seed: number }> = [
		{ label: '7/8', cycle: 7, seed: 1 },
		{ label: '9/8', cycle: 9, seed: 1 },
	];
	for (const s of scenarios) {
		const { schedule, bars } = buildProgressiveTailInvestigationCase(s.seed, true, s.cycle);
		const hasOddCyclePath = schedule.some(
			(r, idx) =>
				idx >= 20 &&
				r.type !== 'parent' &&
				r.type !== 'free' &&
				r.type !== 'resync_bridge' &&
				r.localCycleLength === s.cycle,
		);
		assert.ok(hasOddCyclePath, `${s.label}: expected odd-cycle path in late form`);
		const tihaiStart = schedule.findIndex((r, idx) => idx >= 24 && r.type === 'tihai' && r.phraseStep === 0);
		assert.ok(tihaiStart > 0, `${s.label}: expected final tail tihai`);
		const bridge = schedule[tihaiStart - 1];
		assert.equal(bridge?.type, 'resync_bridge', `${s.label}: bridge must stand right before final tihai`);
		assert.equal((bridge as any)?.bridgeKind, 'gati_prep', `${s.label}: final bridge must be gati_prep`);
		const mod = computeFinalLandingMod8(bars);
		assert.equal(mod, 7, `${s.label}: bridge+tihai path must land on mod 7, got ${mod}`);
	}
}

function testPhase6TailPulseConsistencyViaExposedBehavior() {
	// estimateRolePulseLen не экспортируется — проверяем её контракт через pulse ledger и физическую длину bars.
	const { schedule, bars } = buildProgressiveTailInvestigationCase(3478844360, false);
	for (let i = 24; i < schedule.length - 1; i++) {
		const role = schedule[i]!;
		const next = schedule[i + 1]!;
		if (typeof (role as any).pulseOffsetBeforeBar !== 'number' || typeof (next as any).pulseOffsetBeforeBar !== 'number') continue;
		const inRelevantPath =
			role.type === 'resync_bridge' ||
			role.type === 'tihai' ||
			(role.type !== 'parent' && role.type !== 'free' && role.deSyncJati === true);
		if (!inRelevantPath) continue;
		const declaredStep = ((next as any).pulseOffsetBeforeBar as number) - ((role as any).pulseOffsetBeforeBar as number);
		const physicalStep = bars[i]!.syllables.length;
		assert.equal(
			declaredStep,
			physicalStep,
			`tail pulse consistency mismatch at bar ${i + 1}: declared=${declaredStep} physical=${physicalStep}`,
		);
		if (role.type === 'resync_bridge' && (role as any).bridgeKind === 'gati_prep') {
			assert.equal(
				declaredStep,
				(role as any).localCycleLength,
				'gati_prep bridge pulse increment must equal localCycleLength',
			);
		}
	}
}

function testThomRuleDisallowsPassingThomInsidePhrase() {
	const parent = makeParent({
		curSyl: 4,
		accents: new Set([0, 2]),
		subdivisions: {},
		cellSyllables: { 0: 'Ta', 1: 'Thom', 2: 'Ki', 3: 'Ta' },
	});
	const m = makeEmpty();
	const schedule: PhraseRole[] = [
		{
			type: 'substitution',
			phraseId: 1,
			phraseStep: 0,
			phraseLength: 2,
			parentBarIdx: 0,
			intensityTarget: 0.9,
		},
		{
			type: 'substitution',
			phraseId: 1,
			phraseStep: 1,
			phraseLength: 2,
			parentBarIdx: 0,
			intensityTarget: 0.9,
		},
	];
	applyParentModeBar({
		barIdx: 0,
		parent,
		schedule,
		chaos: 70,
		syllablesDefault: 4,
		m,
		rng: mulberry32(11),
		freeAxes: {
			randomPulsation: false,
			randomPattern: false,
			randomSpeed: false,
			randomBarSpeed: false,
			forceFirstBeat: false,
		},
	});
	applyParentModeBar({
		barIdx: 1,
		parent,
		schedule,
		chaos: 70,
		syllablesDefault: 4,
		m,
		rng: mulberry32(12),
		freeAxes: {
			randomPulsation: false,
			randomPattern: false,
			randomSpeed: false,
			randomBarSpeed: false,
			forceFirstBeat: false,
		},
	});
	const g = snapshotBarGenome(1, 4, m);
	const live = g.deadStart ?? g.curSyl;
	for (let c = 0; c < live - 1; c++) {
		assert.notEqual(g.cellSyllables?.[c], 'Thom', `passing Thom is forbidden at cell ${c}`);
	}
}

function testDeSyncPrepBridgeHasAtLeastFourPulses() {
	const parent = makeParent({ curSyl: 3, accents: new Set([0]), subdivisions: {} });
	const m = makeEmpty();
	const schedule: PhraseRole[] = [
		{
			type: 'resync_bridge',
			phraseId: 1,
			phraseStep: 0,
			phraseLength: 1,
			parentBarIdx: 0,
			bridgeKind: 'de_sync_prep',
		},
	];
	applyParentModeBar({
		barIdx: 0,
		parent,
		schedule,
		chaos: 20,
		syllablesDefault: 3,
		m,
		rng: mulberry32(31),
		freeAxes: {
			randomPulsation: false,
			randomPattern: false,
			randomSpeed: false,
			randomBarSpeed: false,
			forceFirstBeat: false,
		},
	});
	assert.ok((m.customSyllables[0] ?? 0) >= 4, 'de-sync prep bridge must provide >=4 pulse silence buffer');
}

function testEmotionalProfileSelectionByChaosBands() {
	const high = buildPhraseSchedule({
		bars: 16,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(1),
		chaosLevel: 90,
	});
	const highProfile = high.find((r) => r.type !== 'parent' && r.type !== 'free') as any;
	assert.equal(highProfile?.emotionalProfile, 'tandava', 'high chaos should select tandava profile');

	const low = buildPhraseSchedule({
		bars: 16,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(1),
		chaosLevel: 10,
	});
	const lowProfile = low.find((r) => r.type !== 'parent' && r.type !== 'free') as any;
	assert.equal(lowProfile?.emotionalProfile, 'lasya', 'low chaos should select lasya profile');
}

function testArudiReasonAndPrasaCapAreAssigned() {
	const sched = buildPhraseSchedule({
		bars: 20,
		enabledMutations: ['substitution', 'retrograde', 'rotation', 'truncation'],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(52),
		chaosLevel: 25,
	});
	const arudi = sched.find((r: any) => r.arudiReason === 'symmetry_close' || r.arudiReason === 'phrase_cadence') as any;
	assert.ok(arudi, 'scheduler should mark arudi reason on cadence bars');
	assert.equal(arudi?.prasaMaxEditDistance, 2, 'lasya profile should use tighter prasa cap');
}

function testProgressiveTailHasPreTihaiBreathBridge() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(7007),
		chaosLevel: 50,
		motifPulseLen: 4,
	});
	const tihaiStart = sched.findIndex((r, idx) => idx >= 24 && r.type === 'tihai' && r.phraseStep === 0);
	assert.ok(tihaiStart > 0, 'expected final tail tihai');
	assert.equal(sched[tihaiStart - 1]?.type, 'resync_bridge', 'final tihai must have explicit pre-breath bridge');
}

function testArudiMarkersAreNotOverused() {
	const sched = buildPhraseSchedule({
		bars: 32,
		enabledMutations: [...ALL_MUTATION_TYPES] as import('./parentMode').MutationType[],
		preset: 'progressive',
		parentLength: 1,
		rng: mulberry32(909),
		chaosLevel: 35,
	});
	const mutBars = sched.filter((r) => r.type !== 'parent' && r.type !== 'free' && r.type !== 'resync_bridge');
	const arudiBars = mutBars.filter((r: any) => typeof r.arudiReason === 'string');
	assert.ok(mutBars.length > 0, 'expected mutation bars');
	assert.ok(arudiBars.length <= Math.ceil(mutBars.length * 0.35), `Arudi must stay sparse: ${arudiBars.length}/${mutBars.length}`);
}

function testTihaiSupportsShortGapPulses() {
	const parent = makeParent({ curSyl: 4, accents: new Set([0, 2]), subdivisions: {} });
	const role = {
		...(makeRole('tihai', 1, 6) as any),
		tihaiPrefixBars: 0,
		tihaiGapBars: 1,
		tihaiGapPulses: 2,
	};
	const out = MUTATION_OPERATORS.tihai(parent, role, 0.7, mulberry32(3));
	assert.equal(out.cellSyllables?.[0], '-');
	assert.equal(out.cellSyllables?.[1], '-');
	assert.equal(out.cellSyllables?.[2], 'Ta');
	assert.equal(out.cellSyllables?.[3], 'Ta');
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
	['testFreeRoleScrubsStaleThom', testFreeRoleScrubsStaleThom],
	['testRandomBarSpeedPrunesDeadZoneCellOverrides', testRandomBarSpeedPrunesDeadZoneCellOverrides],
	['testParentGenomeJSONRoundtrip', testParentGenomeJSONRoundtrip],
	['testMutationPhraseLenComplete', testMutationPhraseLenComplete],
	['testRotationOperator', testRotationOperator],
	['testTruncationOperator', testTruncationOperator],
	['testAugmentationOperator', testAugmentationOperator],
	['testDiminutionOperator', testDiminutionOperator],
	['testPrependAppendOperator', testPrependAppendOperator],
	['testFractalOperator', testFractalOperator],
	['testTihaiOperator', testTihaiOperator],
	['testTihaiFinalThomNeverStartsTrailingSilence', testTihaiFinalThomNeverStartsTrailingSilence],
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
	['testComputeTihaiBlockSamAlignment', testComputeTihaiBlockSamAlignment],
	['testScheduleCarriesPulseOffsetForTihai', testScheduleCarriesPulseOffsetForTihai],
	['testDensityFreezeWindowMarksRoles', testDensityFreezeWindowMarksRoles],
	['testTruncationEarlyCap15Percent', testTruncationEarlyCap15Percent],
	['testProgressiveMidWindowForcesDeSyncAtChaos15', testProgressiveMidWindowForcesDeSyncAtChaos15],
	['testDeSyncDeadCellsAndResyncBridge', testDeSyncDeadCellsAndResyncBridge],
	['testChaos20NarrativeJourneyHasJatiAndResync', testChaos20NarrativeJourneyHasJatiAndResync],
	['testProgressiveGatiTargetEscalates', testProgressiveGatiTargetEscalates],
	['testParentRoleAlwaysHasFirstAccent', testParentRoleAlwaysHasFirstAccent],
	['testThomOnlyOnFinalTihaiLanding', testThomOnlyOnFinalTihaiLanding],
	['testProgressiveFinalMuktayiIntensityPeaks', testProgressiveFinalMuktayiIntensityPeaks],
	['testMuktayiAlwaysPassesAcrossSeeds', testMuktayiAlwaysPassesAcrossSeeds],
	['testModeTruthDetectorRejectsFalseJati', testModeTruthDetectorRejectsFalseJati],
	['testModeTruthDetectorAcceptsTrueGati', testModeTruthDetectorAcceptsTrueGati],
	['testModeTruthDetectorAcceptsTrueJati', testModeTruthDetectorAcceptsTrueJati],
	['testBarLogEmitsCriticalForFalseJatiMapping', testBarLogEmitsCriticalForFalseJatiMapping],
	['testJatiModeRequiresResyncBridgeBeforeFinalTihai', testJatiModeRequiresResyncBridgeBeforeFinalTihai],
	['testChaosZeroDoesNotAutoTriggerJatiDeSync', testChaosZeroDoesNotAutoTriggerJatiDeSync],
	['testResyncBridgeDoesNotOverwriteTihaiOnset', testResyncBridgeDoesNotOverwriteTihaiOnset],
	['testGatiModeKeepsBarSizeWhenAutoJatiDisabled', testGatiModeKeepsBarSizeWhenAutoJatiDisabled],
	['testAutoJatiAppearsWithoutManualModeSwitch', testAutoJatiAppearsWithoutManualModeSwitch],
	['testAutoJatiProbabilityInReasonableBand', testAutoJatiProbabilityInReasonableBand],
	['testAutoJatiMutatesToPhysical5or7or9', testAutoJatiMutatesToPhysical5or7or9],
	['testAutoJatiExitsViaResyncBeforeFinalTihai', testAutoJatiExitsViaResyncBeforeFinalTihai],
	['testResyncBridgeNonJatiCycleDoesNotEmitLocalJati', testResyncBridgeNonJatiCycleDoesNotEmitLocalJati],
	['testProgressiveSeed3478844360MuktayiPasses', testProgressiveSeed3478844360MuktayiPasses],
	['testNoImitationDetectedForValidProgressiveJatiScenarios', testNoImitationDetectedForValidProgressiveJatiScenarios],
	['testNoFalseJatiMappingForSeedE43CD609', testNoFalseJatiMappingForSeedE43CD609],
	['testReportedFailSeedsNowAlwaysPassMuktayi', testReportedFailSeedsNowAlwaysPassMuktayi],
	['testBridgeAndDeSyncTraceForInvestigationSeeds', testBridgeAndDeSyncTraceForInvestigationSeeds],
	['testOddJatiTailBridgeForReferenceSeed3478844360', testOddJatiTailBridgeForReferenceSeed3478844360],
	['testOddJatiConsistencyPulseOffsetVsPhysicalBarLengthInTail', testOddJatiConsistencyPulseOffsetVsPhysicalBarLengthInTail],
	['testOddJatiMuktayiPassesForSevenAndNineCycleExamples', testOddJatiMuktayiPassesForSevenAndNineCycleExamples],
	['testOddJatiDiagnosticSeed89NowLandsOnMod7', testOddJatiDiagnosticSeed89NowLandsOnMod7],
	['testResyncIsCompleteBeforeBar28ForReportedSeeds', testResyncIsCompleteBeforeBar28ForReportedSeeds],
	['testReportedLateFailSeedsNowLandOnSam', testReportedLateFailSeedsNowLandOnSam],
	['testPhase6BaselineSeed3478844360TailLedgerAndLanding', testPhase6BaselineSeed3478844360TailLedgerAndLanding],
	['testPhase6OddCycleSevenAndNineBridgeToMod7', testPhase6OddCycleSevenAndNineBridgeToMod7],
	['testPhase6TailPulseConsistencyViaExposedBehavior', testPhase6TailPulseConsistencyViaExposedBehavior],
	['testThomRuleDisallowsPassingThomInsidePhrase', testThomRuleDisallowsPassingThomInsidePhrase],
	['testDeSyncPrepBridgeHasAtLeastFourPulses', testDeSyncPrepBridgeHasAtLeastFourPulses],
	['testEmotionalProfileSelectionByChaosBands', testEmotionalProfileSelectionByChaosBands],
	['testArudiReasonAndPrasaCapAreAssigned', testArudiReasonAndPrasaCapAreAssigned],
	['testProgressiveTailHasPreTihaiBreathBridge', testProgressiveTailHasPreTihaiBreathBridge],
	['testArudiMarkersAreNotOverused', testArudiMarkersAreNotOverused],
	['testTihaiSupportsShortGapPulses', testTihaiSupportsShortGapPulses],
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
