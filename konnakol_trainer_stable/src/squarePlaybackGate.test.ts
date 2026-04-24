import assert from 'node:assert/strict';
import {
	shouldPlayBeatForSquareGate,
	type SquarePlaybackMode,
} from './squarePlaybackGate';

/**
 * Регрессионный контракт из §15 / плана: в `passive_only` звук Ta/first-beat
 * НЕ теряется, даже если клетка одновременно accent.
 */

function testAllBeatsAlwaysPlays() {
	for (const isAccent of [false, true]) {
		for (const hasTa of [false, true]) {
			for (const fbTa of [false, true]) {
				assert.equal(
					shouldPlayBeatForSquareGate({
						playbackMode: 'all_beats',
						isAccent,
						hasTaDingHere: hasTa,
						shouldPlayFirstBeatTa: fbTa,
					}),
					true,
					`all_beats always plays (isAccent=${isAccent}, hasTa=${hasTa}, fbTa=${fbTa})`,
				);
			}
		}
	}
}

function testAccentOnlyPlaysAccentOrTa() {
	const mode: SquarePlaybackMode = 'accent_only';
	assert.equal(shouldPlayBeatForSquareGate({ playbackMode: mode, isAccent: false, hasTaDingHere: false, shouldPlayFirstBeatTa: false }), false);
	assert.equal(shouldPlayBeatForSquareGate({ playbackMode: mode, isAccent: true, hasTaDingHere: false, shouldPlayFirstBeatTa: false }), true);
	assert.equal(shouldPlayBeatForSquareGate({ playbackMode: mode, isAccent: false, hasTaDingHere: true, shouldPlayFirstBeatTa: false }), true);
	assert.equal(shouldPlayBeatForSquareGate({ playbackMode: mode, isAccent: false, hasTaDingHere: false, shouldPlayFirstBeatTa: true }), true);
}

function testPassiveOnlyIgnoresPurePassive() {
	const mode: SquarePlaybackMode = 'passive_only';
	assert.equal(
		shouldPlayBeatForSquareGate({ playbackMode: mode, isAccent: false, hasTaDingHere: false, shouldPlayFirstBeatTa: false }),
		false,
	);
	/** accent без Ta — в passive_only тоже gate закрыт. */
	assert.equal(
		shouldPlayBeatForSquareGate({ playbackMode: mode, isAccent: true, hasTaDingHere: false, shouldPlayFirstBeatTa: false }),
		false,
	);
}

/**
 * P0 regression: passive_only + mixed Ta+accent.
 * Баг: если gate смешивает `isAccent`-early-return с Ta-веткой, Ta пропадает.
 * Контракт: Ta всегда звучит при `hasTaDingHere=true`, независимо от `isAccent`.
 */
function testPassiveOnlyMixedTaAccentPlaysTa() {
	const mode: SquarePlaybackMode = 'passive_only';
	assert.equal(
		shouldPlayBeatForSquareGate({ playbackMode: mode, isAccent: true, hasTaDingHere: true, shouldPlayFirstBeatTa: false }),
		true,
		'passive_only + Ta+accent: звук Ta НЕ должен теряться',
	);
}

function testPassiveOnlyFirstBeatTaPlays() {
	const mode: SquarePlaybackMode = 'passive_only';
	assert.equal(
		shouldPlayBeatForSquareGate({ playbackMode: mode, isAccent: false, hasTaDingHere: false, shouldPlayFirstBeatTa: true }),
		true,
	);
	/** Даже при isAccent=true на первой клетке, first-beat Ta играет. */
	assert.equal(
		shouldPlayBeatForSquareGate({ playbackMode: mode, isAccent: true, hasTaDingHere: false, shouldPlayFirstBeatTa: true }),
		true,
	);
}

/**
 * Truth-table для всех трёх режимов и всех комбинаций сигналов.
 * Фиксируем, что никакое изменение одного сигнала не может изменить решение для others unrelated signals.
 */
function testSquareGateFullTruthTable() {
	type Row = {
		mode: SquarePlaybackMode;
		isAccent: boolean;
		hasTa: boolean;
		fbTa: boolean;
		expected: boolean;
	};
	const rows: Row[] = [];
	for (const mode of ['all_beats', 'accent_only', 'passive_only'] as SquarePlaybackMode[]) {
		for (const isAccent of [false, true]) {
			for (const hasTa of [false, true]) {
				for (const fbTa of [false, true]) {
					const expected = mode === 'all_beats'
						? true
						: mode === 'accent_only'
							? isAccent || hasTa || fbTa
							: hasTa || fbTa;
					rows.push({ mode, isAccent, hasTa, fbTa, expected });
				}
			}
		}
	}
	for (const row of rows) {
		assert.equal(
			shouldPlayBeatForSquareGate({
				playbackMode: row.mode,
				isAccent: row.isAccent,
				hasTaDingHere: row.hasTa,
				shouldPlayFirstBeatTa: row.fbTa,
			}),
			row.expected,
			`square gate: ${JSON.stringify(row)}`,
		);
	}
}

function run() {
	testAllBeatsAlwaysPlays();
	testAccentOnlyPlaysAccentOrTa();
	testPassiveOnlyIgnoresPurePassive();
	testPassiveOnlyMixedTaAccentPlaysTa();
	testPassiveOnlyFirstBeatTaPlays();
	testSquareGateFullTruthTable();
	console.log('squarePlaybackGate tests passed');
}

run();
