/**
 * Запуск: `npx tsx src/sequencerLabels.test.ts` из каталога konnakol_trainer.
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
} from './sequencerLabels';

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
	assert.equal(pickKalam(KALAM_THRESHOLDS.mediumToFast, 'medium'), 'medium', 'edge 8.4 stays');
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
	assert.deepEqual(ten.slice(0, 9), getSyllablesForGati(9, 'slow'), 'greedy 9+1 first chunk');
	assert.deepEqual(ten.slice(9), getSyllablesForGati(1, 'slow'), 'greedy 9+1 remainder');
}

function testBuildRow4BpmSlow() {
	const out = buildRowCellSyllableLabels(4, {}, 0, { bpm: 60 });
	assert.deepEqual(out, [['Ta'], ['Ka'], ['Dhi'], ['Mi']]);
}

function testBuildRow4BpmFast() {
	const out = buildRowCellSyllableLabels(4, {}, 0, { bpm: 150 });
	assert.deepEqual(out, [['Ta'], ['Ka'], ['Ju'], ['Nu']]);
}

function testBuildRow5Bpm60() {
	const out = buildRowCellSyllableLabels(5, {}, 0, { bpm: 60 });
	assert.deepEqual(out, [['Ta'], ['Ka'], ['Ta'], ['Ki'], ['Ta']]);
}

function testBuildRow4DeadStart3() {
	const out = buildRowCellSyllableLabels(4, {}, 0, { bpm: 60, deadStart: 3 });
	assert.deepEqual(
		out,
		[['Ta'], ['Ki'], ['Ta'], []],
		'3 active + 1 dead tail, Gati=3 on active',
	);
}

function testBuildRow5DeadStart3() {
	const out = buildRowCellSyllableLabels(5, {}, 0, { bpm: 60, deadStart: 3 });
	assert.deepEqual(
		out,
		[['Ta'], ['Ki'], ['Ta'], [], []],
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
	assert.deepEqual(out[0], ['Ta', 'Ki', 'Ta'], 'cell 0 is Gati=3 phrase');
	assert.deepEqual(out.slice(1, 4), [['Ta'], ['Ki'], ['Ta']], 'segment of 3 ones is Gati=3');
	assert.deepEqual(out[4], [], 'last cell is dead');
}

function testBuildRowMixedCellThenOnes() {
	const out = buildRowCellSyllableLabels(
		4,
		{ '0-0': 4 },
		0,
		{ bpm: 60 },
	);
	assert.deepEqual(out[0], ['Ta', 'Ka', 'Dhi', 'Mi'], 'cell 0 Gati=4 slow at BPM=60 (NPS=4)');
	assert.deepEqual(out.slice(1), [['Ta'], ['Ki'], ['Ta']], 'segment 1-3 is Gati=3');
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

	/** BPM 88 → обратно, всё ещё medium. */
	buildRowCellSyllableLabels(5, {}, 0, { bpm: 88, kalamMap: km });
	assert.equal(km.get('0-seg0'), 'medium', 'return to 7.33 still medium (no thrash)');

	/** BPM 102 → NPS=8.5 > 8.4 → fast. */
	buildRowCellSyllableLabels(5, {}, 0, { bpm: 102, kalamMap: km });
	assert.equal(km.get('0-seg0'), 'fast', 'crossing 8.4 goes fast');

	/** BPM 96 → NPS=8.0 (above fastToMedium=7.6) → fast sticks. */
	buildRowCellSyllableLabels(5, {}, 0, { bpm: 96, kalamMap: km });
	assert.equal(km.get('0-seg0'), 'fast', 'fast holds until below 7.6');

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

function testRowSyllCountZero() {
	assert.deepEqual(buildRowCellSyllableLabels(0, {}, 0, { bpm: 60 }), []);
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
testHysteresisStickyAroundBoundary();
testTouchedKeysAndGcContract();
testBuildRowDeadStartZero();
testRowSyllCountZero();
console.log('sequencerLabels.test.ts: ok');
