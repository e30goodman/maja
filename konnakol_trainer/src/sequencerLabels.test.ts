/**
 * Run: `npx tsx src/sequencerLabels.test.ts` from the `konnakol_trainer` directory.
 */
import assert from 'node:assert/strict';
import {
	KALAM_THRESHOLDS,
	KONNAKOL_DICTIONARY,
	buildRowCellSyllableLabels,
	composeLongBar,
	computeNps,
	getSyllablesForGati,
	pickKalam,
	type Kalam,
	type KalamMap,
	type SyllableLabel,
} from './sequencerLabels';

const plain = (rows: string[][]): SyllableLabel[][] =>
	rows.map((cell) => cell.map((s) => ({ syl: s, accent: false })));

function testComputeNps() {
	assert.equal(computeNps(60, 4), 4);
	assert.equal(computeNps(120, 4), 8);
	assert.equal(computeNps(90, 5), 7.5);
	assert.equal(computeNps(0, 4), 0);
	assert.equal(computeNps(60, 0), 0);
}

function testPickKalamStartState() {
	assert.equal(pickKalam(3.9, undefined), 'slow');
	assert.equal(pickKalam(4.0, undefined), 'slow');
	assert.equal(pickKalam(4.1, undefined), 'medium');
	assert.equal(pickKalam(8.0, undefined), 'medium');
	assert.equal(pickKalam(8.1, undefined), 'fast');
	assert.equal(pickKalam(20, undefined), 'fast');
}

function testPickKalamHysteresisSlowMedium() {
	assert.equal(pickKalam(KALAM_THRESHOLDS.slowToMedium, 'slow'), 'slow', 'edge 4.4 stays slow');
	assert.equal(pickKalam(4.5, 'slow'), 'medium');
	assert.equal(pickKalam(4.0, 'medium'), 'medium', 'above mediumToSlow stays');
	assert.equal(pickKalam(KALAM_THRESHOLDS.mediumToSlow, 'medium'), 'medium', 'edge 3.6 stays');
	assert.equal(pickKalam(3.5, 'medium'), 'slow');
}

function testPickKalamHysteresisMediumFast() {
	assert.equal(pickKalam(KALAM_THRESHOLDS.mediumToFast, 'medium'), 'medium', 'edge 8.4 stays medium');
	assert.equal(pickKalam(8.5, 'medium'), 'fast');
	assert.equal(pickKalam(8.0, 'fast'), 'fast', 'above fastToMedium stays fast');
	assert.equal(pickKalam(KALAM_THRESHOLDS.fastToMedium, 'fast'), 'fast', 'edge 7.6 stays fast');
	assert.equal(pickKalam(7.5, 'fast'), 'medium');
}

function testGetSyllablesForGati() {
	for (let g = 1; g <= 9; g++) {
		for (const kalam of ['slow', 'medium', 'fast'] as Kalam[]) {
			const arr = getSyllablesForGati(g, kalam);
			assert.equal(arr.length, g, `len Gati=${g} ${kalam}`);
			assert.deepEqual(arr, KONNAKOL_DICTIONARY[g as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9][kalam]);
			assert.ok(
				!arr.includes('Di'),
				`Gati=${g} ${kalam} must not contain legacy "Di" (canonical is "Dhi")`,
			);
		}
	}
	assert.deepEqual(getSyllablesForGati(0, 'slow'), KONNAKOL_DICTIONARY[1].slow, 'clamp low');
	assert.deepEqual(getSyllablesForGati(99, 'fast'), KONNAKOL_DICTIONARY[9].fast, 'clamp high');
}

function testGati4FastIsJuNu() {
	assert.deepEqual(KONNAKOL_DICTIONARY[4].fast, ['Ta', 'Ka', 'Ju', 'Nu']);
	assert.deepEqual(KONNAKOL_DICTIONARY[8].medium, ['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ka', 'Ju', 'Nu']);
}

function testComposeLongBar() {
	assert.equal(composeLongBar(10, 'slow').length, 10);
	assert.equal(composeLongBar(12, 'slow').length, 12);
	assert.equal(composeLongBar(16, 'slow').length, 16);
	assert.deepEqual(composeLongBar(9, 'slow'), getSyllablesForGati(9, 'slow'), 'segLen=9 is plain');
	const ten = composeLongBar(10, 'slow');
	assert.deepEqual(
		ten,
		[
			...getSyllablesForGati(5, 'slow'),
			...getSyllablesForGati(5, 'slow'),
		],
		'10 prefers exact factorization 5+5 over greedy',
	);

	const twelve = composeLongBar(12, 'slow');
	assert.deepEqual(
		twelve,
		[
			...getSyllablesForGati(4, 'slow'),
			...getSyllablesForGati(4, 'slow'),
			...getSyllablesForGati(4, 'slow'),
		],
		'12 prefers factorization 4+4+4 over greedy 9+3',
	);

	const fifteen = composeLongBar(15, 'slow');
	assert.deepEqual(
		fifteen,
		[
			...getSyllablesForGati(3, 'slow'),
			...getSyllablesForGati(3, 'slow'),
			...getSyllablesForGati(3, 'slow'),
			...getSyllablesForGati(3, 'slow'),
			...getSyllablesForGati(3, 'slow'),
		],
		'15 prefers factorization 3x5 groups before greedy',
	);

	const eleven = composeLongBar(11, 'slow');
	assert.deepEqual(eleven.slice(0, 9), getSyllablesForGati(9, 'slow'), '11 falls back to greedy 9+2');
	assert.deepEqual(eleven.slice(9), getSyllablesForGati(2, 'slow'), '11 falls back to greedy 9+2');

	const twelveFast = composeLongBar(12, 'fast');
	assert.deepEqual(
		twelveFast,
		[
			...KONNAKOL_DICTIONARY[4].fast,
			...KONNAKOL_DICTIONARY[4].fast,
			...KONNAKOL_DICTIONARY[4].fast,
		],
		'default flow must not alternate 4-chunks',
	);

	const twelveFastDivX2 = composeLongBar(12, 'fast', { enableFastFourChunkAlternation: true });
	assert.deepEqual(
		twelveFastDivX2,
		[
			...KONNAKOL_DICTIONARY[4].fast,
			...KONNAKOL_DICTIONARY[4].medium,
			...KONNAKOL_DICTIONARY[4].fast,
		],
		'div+x2 flow alternates JuNu and DhiMi for repeating 4-chunks',
	);
}

function testBuildRow4BpmSlow() {
	const out = buildRowCellSyllableLabels(4, {}, 0, { bpm: 60 });
	assert.deepEqual(out, plain([['Ta'], ['Ka'], ['Dhi'], ['Mi']]));
}

function testBuildRow4BpmFast() {
	const out = buildRowCellSyllableLabels(4, {}, 0, { bpm: 150 });
	assert.deepEqual(out, plain([['Ta'], ['Ka'], ['Dhi'], ['Mi']]));
}

function testBuildRow5Bpm60() {
	const out = buildRowCellSyllableLabels(5, {}, 0, { bpm: 60 });
	assert.deepEqual(out, plain([['Ta'], ['Ka'], ['Ta'], ['Ki'], ['Ta']]));
}

function testBuildRow4DeadStart3() {
	const out = buildRowCellSyllableLabels(4, {}, 0, { bpm: 60, deadStart: 3 });
	assert.deepEqual(
		out,
		plain([['Ta'], ['Ki'], ['Ta']]).concat([[]]),
		'3 active + 1 dead tail, Gati=3 on active',
	);
}

function testBuildRow5DeadStart3() {
	const out = buildRowCellSyllableLabels(5, {}, 0, { bpm: 60, deadStart: 3 });
	assert.deepEqual(
		out,
		plain([['Ta'], ['Ki'], ['Ta']]).concat([[], []]),
		'length invariant: labels.length === rowSyllCount even with dead tail',
	);
}

function testBuildRow5WithCellSubdivAndDead() {
	const out = buildRowCellSyllableLabels(
		5,
		{ '0-0': 3 },
		0,
		{ bpm: 60, deadStart: 4 },
	);
	assert.deepEqual(out[0], plain([['Ta', 'Ki', 'Ta']])[0], 'cell 0 is Gati=3 phrase');
	assert.deepEqual(out.slice(1, 4), plain([['Ta'], ['Ki'], ['Ta']]), 'segment of 3 ones is Gati=3');
	assert.deepEqual(out[4], [], 'last cell is dead');
}

function testBuildRowMixedCellThenOnes() {
	const out = buildRowCellSyllableLabels(
		4,
		{ '0-0': 4 },
		0,
		{ bpm: 60 },
	);
	assert.deepEqual(out[0], plain([['Ta', 'Ka', 'Dhi', 'Mi']])[0], 'cell 0 Gati=4 slow at BPM=60 (NPS=4)');
	assert.deepEqual(out.slice(1), plain([['Ta'], ['Ki'], ['Ta']]), 'segment 1-3 is Gati=3');
}

function testSubdiv4AlwaysDictionaryPerKalamAndNonUniform() {
	const cases: Array<{ bpm: number; kalam: Kalam; ctx?: { roleType?: string; rowMultiplier?: number; gatiTargetSub?: number; effectiveBpm?: number } }> = [
		{ bpm: 60, kalam: 'slow' },
		{ bpm: 120, kalam: 'medium' },
		{ bpm: 150, kalam: 'medium' },
		{
			bpm: 150,
			kalam: 'fast',
			ctx: { roleType: 'substitution', rowMultiplier: 2, gatiTargetSub: 4, effectiveBpm: 220 },
		},
	];
	for (const { bpm, kalam, ctx } of cases) {
		const out = buildRowCellSyllableLabels(1, { '0-0': 4 }, 0, { bpm, rowRuntimeContext: ctx });
		assert.deepEqual(out[0].map((x) => x.syl), KONNAKOL_DICTIONARY[4][kalam], `subdivs=4 must follow dictionary (${kalam})`);
		assert.equal(new Set(out[0].map((x) => x.syl)).size, 4, `subdivs=4 (${kalam}) must produce 4 different syllables`);
	}
}

function testNoStutterForSubdiv2And3() {
	const out2 = buildRowCellSyllableLabels(1, { '0-0': 2 }, 0, { bpm: 60 });
	assert.deepEqual(out2[0].map((x) => x.syl), KONNAKOL_DICTIONARY[2].slow, 'subdiv=2 must stay Ta Ka');
	assert.notEqual(out2[0]?.[0]?.syl, out2[0]?.[1]?.syl, 'subdiv=2 must not stutter');

	const out3 = buildRowCellSyllableLabels(1, { '0-0': 3 }, 0, { bpm: 60 });
	assert.deepEqual(out3[0].map((x) => x.syl), KONNAKOL_DICTIONARY[3].slow, 'subdiv=3 must stay Ta Ki Ta');
	assert.equal(out3[0]?.[0]?.syl, 'Ta');
	assert.equal(out3[0]?.[1]?.syl, 'Ki');
}

function testAllSubdivs2to9StrictDictionaryMapping() {
	for (let subdiv = 2; subdiv <= 9; subdiv++) {
		const out = buildRowCellSyllableLabels(1, { '0-0': subdiv }, 0, { bpm: 60 });
		const sylls = out[0].map((x) => x.syl);
		const pickedKalam = pickKalam(computeNps(60, subdiv), undefined);
		const kalam = pickedKalam === 'fast' ? 'medium' : pickedKalam;
		assert.equal(sylls.length, subdiv, `subdiv=${subdiv}: length must equal subdiv`);
		assert.deepEqual(
			sylls,
			KONNAKOL_DICTIONARY[subdiv as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9][kalam],
			`subdiv=${subdiv}: must strictly follow dictionary`,
		);
		if (subdiv > 1) {
			assert.equal(
				new Set(sylls).size > 1,
				true,
				`subdiv=${subdiv}: phrase must not collapse to uniform fallback filler`,
			);
		}
	}
}

function testMixedRowLengthInvariantForAllCells() {
	const out = buildRowCellSyllableLabels(
		9,
		{
			'0-0': 2,
			'0-1': 3,
			'0-2': 4,
			'0-3': 5,
			'0-4': 6,
			'0-5': 7,
			'0-6': 8,
			'0-7': 9,
			'0-8': 1,
		},
		0,
		{ bpm: 60 },
	);
	assert.equal(out.length, 9, 'row length invariant');
	const expectedLens = [2, 3, 4, 5, 6, 7, 8, 9, 1];
	for (let i = 0; i < expectedLens.length; i++) {
		assert.equal(out[i]?.length, expectedLens[i], `cell ${i}: syllable length invariant`);
	}
}

function testHysteresisStickyAroundBoundary() {
	const km: KalamMap = new Map();
	/** BPM 88 → Gati=5 NPS = 88*5/60 ≈ 7.33 (medium). */
	buildRowCellSyllableLabels(5, {}, 0, { bpm: 88, kalamMap: km });
	const at88 = km.get('0-seg0');
	assert.equal(at88, 'medium', 'NPS=7.33 starts medium');

	/** BPM 92 → NPS ≈ 7.67 (still medium, < mediumToFast=8.4). */
	buildRowCellSyllableLabels(5, {}, 0, { bpm: 92, kalamMap: km });
	assert.equal(km.get('0-seg0'), 'medium', 'NPS=7.67 stays medium');

	/** BPM 88 -> back down, still medium. */
	buildRowCellSyllableLabels(5, {}, 0, { bpm: 88, kalamMap: km });
	assert.equal(km.get('0-seg0'), 'medium', 'return to 7.33 still medium (no thrash)');

	/** BPM 102 → NPS=8.5 > 8.4 picks fast, but default flow gates it back to medium. */
	buildRowCellSyllableLabels(5, {}, 0, { bpm: 102, kalamMap: km });
	assert.equal(km.get('0-seg0'), 'medium', 'default flow keeps DhiMi even after fast threshold');

	/** BPM 96 → still medium in default flow. */
	buildRowCellSyllableLabels(5, {}, 0, { bpm: 96, kalamMap: km });
	assert.equal(km.get('0-seg0'), 'medium', 'default flow remains medium');

	/** BPM 90 → NPS=7.5 < 7.6 → medium. */
	buildRowCellSyllableLabels(5, {}, 0, { bpm: 90, kalamMap: km });
	assert.equal(km.get('0-seg0'), 'medium', 'falling through 7.6 returns to medium');
}

function testTouchedKeysAndGcContract() {
	const km: KalamMap = new Map();
	const touched = new Set<string>();
	buildRowCellSyllableLabels(4, { '0-0': 4 }, 0, { bpm: 60, kalamMap: km, touchedKeys: touched });
	assert.ok(touched.has('0-c0'), 'subdiv>1 cell key touched');
	assert.ok(touched.has('0-seg1'), 'segment of ones starting at idx 1 touched');
	assert.equal(km.size, touched.size, 'kalamMap mirrors touched keys on first run');
}

function testBuildRowDeadStartZero() {
	const out = buildRowCellSyllableLabels(3, {}, 0, { bpm: 60, deadStart: 0 });
	assert.deepEqual(out, [[], [], []], 'deadStart=0 → whole row is silent');
}

function testAccentObjectsIntegrated() {
	const out = buildRowCellSyllableLabels(4, {}, 0, {
		bpm: 60,
		accentCells: new Set([1, 3]),
	});
	assert.equal(out[1]?.[0]?.accent, true);
	assert.equal(out[0]?.[0]?.accent, false);
	assert.equal(out[3]?.[0]?.accent, true);
}

function testTerminalSyllableOnLessonEnd() {
	const out = buildRowCellSyllableLabels(4, {}, 0, {
		bpm: 60,
		isLessonLastRow: true,
	});
	assert.equal(out[3]?.[0]?.syl, 'Mi', 'stable algorithm keeps dictionary ending for row=4');
}

function testNps833StaysMediumUntil84WhenSticky() {
	const km: KalamMap = new Map();
	buildRowCellSyllableLabels(1, { '0-0': 4 }, 0, { bpm: 120, kalamMap: km });
	assert.equal(km.get('0-c0'), 'medium', 'NPS=8.0 starts medium');
	buildRowCellSyllableLabels(1, { '0-0': 4 }, 0, {
		bpm: 120,
		kalamMap: km,
		rowRuntimeContext: { effectiveBpm: 125 },
	});
	assert.equal(km.get('0-c0'), 'medium', 'NPS=8.33 must stay medium until >8.4');
	buildRowCellSyllableLabels(1, { '0-0': 4 }, 0, {
		bpm: 120,
		kalamMap: km,
		rowRuntimeContext: { effectiveBpm: 127 },
	});
	assert.equal(km.get('0-c0'), 'medium', 'default flow keeps medium even past 8.4');
}

function testJuNuDelayedForX2UntilVeryHighTempo() {
	const km: KalamMap = new Map();
	buildRowCellSyllableLabels(1, { '0-0': 4 }, 0, {
		bpm: 120,
		kalamMap: km,
		rowRuntimeContext: { effectiveBpm: 180, rowMultiplier: 2, roleType: 'substitution', gatiTargetSub: 4 },
	});
	assert.equal(km.get('0-c0'), 'medium', 'x2 should delay JuNu below/equal 200 BPM');
	const low = buildRowCellSyllableLabels(1, { '0-0': 4 }, 0, {
		bpm: 120,
		rowRuntimeContext: { effectiveBpm: 180, rowMultiplier: 2, roleType: 'substitution', gatiTargetSub: 4 },
	});
	assert.deepEqual(low[0]?.map((x) => x.syl), KONNAKOL_DICTIONARY[4].medium, 'below 200 BPM on x2 keep DhiMi');

	buildRowCellSyllableLabels(1, { '0-0': 4 }, 0, {
		bpm: 120,
		kalamMap: km,
		rowRuntimeContext: { effectiveBpm: 205, rowMultiplier: 2, roleType: 'substitution', gatiTargetSub: 4 },
	});
	assert.equal(km.get('0-c0'), 'fast', 'x2 allows JuNu only after 200 BPM');
	const high = buildRowCellSyllableLabels(1, { '0-0': 4 }, 0, {
		bpm: 120,
		rowRuntimeContext: { effectiveBpm: 205, rowMultiplier: 2, roleType: 'substitution', gatiTargetSub: 4 },
	});
	assert.deepEqual(high[0]?.map((x) => x.syl), KONNAKOL_DICTIONARY[4].fast, 'after 200 BPM on x2 switch to JuNu');
}

function testDebugTraceIncludesRuntimeContext() {
	const trace: Array<{ localJati?: number; gatiTargetSub?: number; roleType?: string }> = [];
	buildRowCellSyllableLabels(1, { '0-0': 4 }, 0, {
		bpm: 120,
		rowRuntimeContext: { localJati: 7, gatiTargetSub: 8, roleType: 'tihai' },
		debugTrace: (e) => trace.push({ localJati: e.localJati, gatiTargetSub: e.gatiTargetSub, roleType: e.roleType }),
	});
	assert.equal(trace.length, 1);
	assert.deepEqual(trace[0], { localJati: 7, gatiTargetSub: 8, roleType: 'tihai' });
}

function testLongBarAlternationGatedByDivAndMultiplier() {
	const base = buildRowCellSyllableLabels(12, {}, 0, { bpm: 45 });
	assert.deepEqual(
		base.map((x) => x[0]?.syl),
		[
			'Ta', 'Ka', 'Dhi', 'Mi',
			'Ta', 'Ka', 'Dhi', 'Mi',
			'Ta', 'Ka', 'Dhi', 'Mi',
		],
		'no multiplier/div -> no alternation',
	);

	const divNoMult = buildRowCellSyllableLabels(12, {}, 0, {
		bpm: 45,
		rowRuntimeContext: { roleType: 'substitution', rowMultiplier: 1 },
	});
	assert.deepEqual(
		divNoMult.map((x) => x[0]?.syl),
		[
			'Ta', 'Ka', 'Dhi', 'Mi',
			'Ta', 'Ka', 'Dhi', 'Mi',
			'Ta', 'Ka', 'Dhi', 'Mi',
		],
		'div without multiplier -> no alternation',
	);

	const x2NoDiv = buildRowCellSyllableLabels(12, {}, 0, {
		bpm: 45,
		rowRuntimeContext: { rowMultiplier: 2, roleType: 'parent' },
	});
	assert.deepEqual(
		x2NoDiv.map((x) => x[0]?.syl),
		[
			'Ta', 'Ka', 'Dhi', 'Mi',
			'Ta', 'Ka', 'Dhi', 'Mi',
			'Ta', 'Ka', 'Dhi', 'Mi',
		],
		'x2 without div -> no alternation',
	);

	const divX2 = buildRowCellSyllableLabels(12, {}, 0, {
		bpm: 45,
		rowRuntimeContext: { roleType: 'substitution', rowMultiplier: 2, gatiTargetSub: 4, effectiveBpm: 220 },
	});
	assert.deepEqual(
		divX2.map((x) => x[0]?.syl),
		[
			'Ta', 'Ka', 'Ju', 'Nu',
			'Ta', 'Ka', 'Dhi', 'Mi',
			'Ta', 'Ka', 'Ju', 'Nu',
		],
		'div+x2 -> alternation enabled',
	);
}

function testRowSyllCountZero() {
	assert.deepEqual(buildRowCellSyllableLabels(0, {}, 0, { bpm: 60 }), []);
}

function testCellOverrideRespectsMaskValidation() {
	const muted = buildRowCellSyllableLabels(2, {}, 0, {
		bpm: 60,
		cellSyllableOverrides: { '0-1': 'DIM' },
		cellStepMasks: { '0-1': [false] },
	});
	assert.equal(muted[1]?.[0]?.syl, '-', 'override must not bypass per-cell mute mask');
	const active = buildRowCellSyllableLabels(2, {}, 0, {
		bpm: 60,
		cellSyllableOverrides: { '0-1': 'DIM' },
		cellStepMasks: { '0-1': [true] },
	});
	assert.equal(active[1]?.[0]?.syl, 'DIM', 'override applies only for active cell mask');
}

testComputeNps();
testPickKalamStartState();
testPickKalamHysteresisSlowMedium();
testPickKalamHysteresisMediumFast();
testGetSyllablesForGati();
testGati4FastIsJuNu();
testComposeLongBar();
testBuildRow4BpmSlow();
testBuildRow4BpmFast();
testBuildRow5Bpm60();
testBuildRow4DeadStart3();
testBuildRow5DeadStart3();
testBuildRow5WithCellSubdivAndDead();
testBuildRowMixedCellThenOnes();
testSubdiv4AlwaysDictionaryPerKalamAndNonUniform();
testNoStutterForSubdiv2And3();
testAllSubdivs2to9StrictDictionaryMapping();
testMixedRowLengthInvariantForAllCells();
testHysteresisStickyAroundBoundary();
testTouchedKeysAndGcContract();
testBuildRowDeadStartZero();
testRowSyllCountZero();
testAccentObjectsIntegrated();
testTerminalSyllableOnLessonEnd();
testNps833StaysMediumUntil84WhenSticky();
testJuNuDelayedForX2UntilVeryHighTempo();
testDebugTraceIncludesRuntimeContext();
testLongBarAlternationGatedByDivAndMultiplier();
testCellOverrideRespectsMaskValidation();
console.log('sequencerLabels.test.ts: ok');
