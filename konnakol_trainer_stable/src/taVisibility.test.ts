import assert from 'node:assert/strict';
import { deriveTaNormalVisibility } from './taVisibility';

function testBarsOneAccentDoesNotRevealDefaultTa() {
	const base = {
		totalBars: 1,
		accentMapVersion: 0,
		firstBeatDingSuppressedRows: new Set<number>(),
		customSyllables: {} as Record<number, number>,
		syllables: 4,
		deadCells: {},
	};

	const changed = deriveTaNormalVisibility({
		...base,
		accentsUi: new Set<string>(['0-1']),
		taDingKeysUi: new Set<string>(),
	});
	assert.equal(changed.isTaGridAtDefault, true);
	assert.equal(changed.canShowDefaultTaInNormal, false);

	const reverted = deriveTaNormalVisibility({
		...base,
		accentsUi: new Set<string>(),
		taDingKeysUi: new Set<string>(),
	});
	assert.equal(reverted.isTaGridAtDefault, true);
	assert.equal(reverted.canShowDefaultTaInNormal, false);
}

function testExplicitTaReveal() {
	const out = deriveTaNormalVisibility({
		totalBars: 1,
		accentMapVersion: 0,
		firstBeatDingSuppressedRows: new Set<number>(),
		accentsUi: new Set<string>(),
		taDingKeysUi: new Set<string>(['0-1']),
		customSyllables: {},
		syllables: 4,
		deadCells: {},
	});
	assert.equal(out.isTaGridAtDefault, false);
	assert.equal(out.canShowDefaultTaInNormal, true);
}

function testOutOfDomainRowsIgnored() {
	const out = deriveTaNormalVisibility({
		totalBars: 2,
		accentMapVersion: 0,
		firstBeatDingSuppressedRows: new Set<number>(),
		accentsUi: new Set<string>(['4-3']),
		taDingKeysUi: new Set<string>(['9-1']),
		customSyllables: {},
		syllables: 4,
		deadCells: {},
	});
	assert.equal(out.isTaGridAtDefault, true);
	assert.equal(out.canShowDefaultTaInNormal, false);
}

function testAccentMapVersionReveal() {
	const out = deriveTaNormalVisibility({
		totalBars: 1,
		accentMapVersion: 1,
		firstBeatDingSuppressedRows: new Set<number>(),
		accentsUi: new Set<string>(),
		taDingKeysUi: new Set<string>(),
		customSyllables: {},
		syllables: 4,
		deadCells: {},
	});
	assert.equal(out.canShowDefaultTaInNormal, true);
}

function run() {
	testBarsOneAccentDoesNotRevealDefaultTa();
	testExplicitTaReveal();
	testOutOfDomainRowsIgnored();
	testAccentMapVersionReveal();
	console.log('taVisibility tests passed');
}

run();
