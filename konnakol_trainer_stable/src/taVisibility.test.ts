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

/**
 * AGENT-3 TRUTH TABLE: полный таблично-ориентированный regression для
 * `deriveTaNormalVisibility`. Покрывает оси:
 * - accentMapVersion: 0 / 1
 * - firstBeatDingSuppressedRows: empty / non-empty
 * - explicit Ta outside c0: absent / present
 * - explicit accent outside c0: absent / present (влияет только на hasAnyVisibleAccentOutsideFirstBeat)
 *
 * Ожидание: `canShowDefaultTaInNormal` = (accentMapVersion === 1) || (supRows.size > 0) || (hasExplicitTaOutsideC0).
 */
function testRevealTruthTable() {
	type Row = {
		name: string;
		accentMapVersion: 0 | 1;
		supRows: number[];
		accents: string[];
		taDing: string[];
		expectedReveal: boolean;
		expectedIsDefault: boolean;
	};
	const rows: Row[] = [
		// Pure default: amv=0, no supRows, no taDing c>0.
		{ name: 'pure default', accentMapVersion: 0, supRows: [], accents: [], taDing: [], expectedReveal: false, expectedIsDefault: true },
		// amv=1: reveal opens even if nothing else.
		{ name: 'amv=1 only', accentMapVersion: 1, supRows: [], accents: [], taDing: [], expectedReveal: true, expectedIsDefault: false },
		// supRows alone: reveal opens (user explicitly suppressed).
		{ name: 'supRows only', accentMapVersion: 0, supRows: [0], accents: [], taDing: [], expectedReveal: true, expectedIsDefault: false },
		// explicit Ta on c>0 only: reveal opens.
		{ name: 'explicit Ta c>0', accentMapVersion: 0, supRows: [], accents: [], taDing: ['0-2'], expectedReveal: true, expectedIsDefault: false },
		// accent on c>0 only (no Ta, no supRows, amv=0): reveal closed.
		{ name: 'accent c>0 only', accentMapVersion: 0, supRows: [], accents: ['0-1'], taDing: [], expectedReveal: false, expectedIsDefault: true },
		// Combined: amv=1 + supRows: reveal opens.
		{ name: 'amv=1 + supRows', accentMapVersion: 1, supRows: [1], accents: [], taDing: [], expectedReveal: true, expectedIsDefault: false },
		// All triggers active.
		{ name: 'all triggers', accentMapVersion: 1, supRows: [2], accents: ['0-1'], taDing: ['1-3'], expectedReveal: true, expectedIsDefault: false },
		// out-of-domain Ta c0 only: это c<=0, не триггер для "outsideFirstBeat".
		{ name: 'ta only on c0', accentMapVersion: 0, supRows: [], accents: [], taDing: ['0-0'], expectedReveal: false, expectedIsDefault: true },
	];
	for (const row of rows) {
		const out = deriveTaNormalVisibility({
			totalBars: 4,
			accentMapVersion: row.accentMapVersion,
			firstBeatDingSuppressedRows: new Set(row.supRows),
			accentsUi: new Set(row.accents),
			taDingKeysUi: new Set(row.taDing),
			customSyllables: {},
			syllables: 4,
			deadCells: {},
		});
		assert.equal(
			out.canShowDefaultTaInNormal,
			row.expectedReveal,
			`truth-table "${row.name}": expected reveal=${row.expectedReveal}, got ${out.canShowDefaultTaInNormal}`,
		);
		assert.equal(
			out.isTaGridAtDefault,
			row.expectedIsDefault,
			`truth-table "${row.name}": expected isTaGridAtDefault=${row.expectedIsDefault}, got ${out.isTaGridAtDefault}`,
		);
	}
}

/**
 * Virtualization independence:
 * При одинаковом `totalBars` и одинаковом state reveal должен быть одинаковым
 * независимо от гипотетических view/render параметров (которые у нас вне helper'а).
 * Helper принимает только data-domain, поэтому этот тест документирует:
 * виртуализация не может изменить вход — только вызывающая сторона обязана не подмешивать view-данные.
 */
function testVirtualizationIndependence() {
	const base = {
		totalBars: 4,
		accentMapVersion: 1 as const,
		firstBeatDingSuppressedRows: new Set<number>([2]),
		accentsUi: new Set<string>(['0-1']),
		taDingKeysUi: new Set<string>(['3-2']),
		customSyllables: { 0: 4, 3: 4 },
		syllables: 4,
		deadCells: {},
	};
	const a = deriveTaNormalVisibility(base);
	/** Повторный вызов с теми же входами даёт тот же результат. */
	const b = deriveTaNormalVisibility({ ...base, firstBeatDingSuppressedRows: new Set(base.firstBeatDingSuppressedRows) });
	assert.equal(a.canShowDefaultTaInNormal, b.canShowDefaultTaInNormal);
	assert.equal(a.isTaGridAtDefault, b.isTaGridAtDefault);
	assert.equal(a.hasAnyExplicitTaOutsideFirstBeat, b.hasAnyExplicitTaOutsideFirstBeat);
	assert.equal(a.hasAnyVisibleAccentOutsideFirstBeat, b.hasAnyVisibleAccentOutsideFirstBeat);
}

/**
 * Incident regression (§15): alt/accent на c0 не должен триггерить reveal.
 * До фикса: accent на `r-0` ошибочно давал `canShowDefaultTaInNormal=true`.
 */
function testAltOnC0DoesNotRevealAllRows() {
	const out = deriveTaNormalVisibility({
		totalBars: 4,
		accentMapVersion: 0,
		firstBeatDingSuppressedRows: new Set<number>(),
		accentsUi: new Set<string>(['0-0', '1-0', '2-0', '3-0']),
		taDingKeysUi: new Set<string>(),
		customSyllables: {},
		syllables: 4,
		deadCells: {},
	});
	assert.equal(out.canShowDefaultTaInNormal, false, 'alt на c0 не должен триггерить global reveal');
	assert.equal(out.isTaGridAtDefault, true);
	assert.equal(out.hasAnyVisibleAccentOutsideFirstBeat, false);
}

/**
 * Dead-cells: accent/Ta в "мёртвой" зоне (c >= deadStart) не считаются.
 */
function testDeadCellsIgnored() {
	const out = deriveTaNormalVisibility({
		totalBars: 2,
		accentMapVersion: 0,
		firstBeatDingSuppressedRows: new Set<number>(),
		accentsUi: new Set<string>(['0-3']),
		taDingKeysUi: new Set<string>(['0-3']),
		customSyllables: { 0: 4 },
		syllables: 4,
		deadCells: { 0: { deadStart: 2, displayLen: 4, baseLen: 4 } },
	});
	assert.equal(out.hasAnyExplicitTaOutsideFirstBeat, false, 'dead-cell Ta не считается');
	assert.equal(out.hasAnyVisibleAccentOutsideFirstBeat, false, 'dead-cell accent не считается');
	assert.equal(out.canShowDefaultTaInNormal, false);
}

function run() {
	testBarsOneAccentDoesNotRevealDefaultTa();
	testExplicitTaReveal();
	testOutOfDomainRowsIgnored();
	testAccentMapVersionReveal();
	testRevealTruthTable();
	testVirtualizationIndependence();
	testAltOnC0DoesNotRevealAllRows();
	testDeadCellsIgnored();
	console.log('taVisibility tests passed');
}

run();
