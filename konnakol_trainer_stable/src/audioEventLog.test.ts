import assert from 'node:assert/strict';
import {
	resolveFirstBeatHitRow as resolveFirstBeatHitRowPolicy,
	resolveRuntimeFirstBeatPolicy,
	type FirstBeatHitPolicy,
} from './firstBeatPolicy';
import {
	resolveFirstBeatHitRow as resolveFirstBeatHitRowMidi,
} from './midiExport';
import { shouldPlayBeatForSquareGate, type SquarePlaybackMode } from './squarePlaybackGate';

/**
 * Audio event-log oracle (parity helper).
 *
 * Цель: иметь один детерминированный "оракул", который принимает решение
 * по первой доле (first-beat hit) и по square playback gate для заданной
 * клетки. Реализации в runtime-audio (`App.tsx::emitGridSubAudio`) и в
 * midi-export (`midiExport.ts`) должны давать ОДИНАКОВЫЙ результат.
 *
 * Этот файл:
 * 1. Фиксирует parity между firstBeatPolicy.ts и midiExport.ts
 *    (`resolveFirstBeatHitRow`).
 * 2. Формирует стабильный event-log (список hit-флагов) по bar, который
 *    можно использовать в будущем для сравнения с MIDI-выходом и runtime
 *    audio-логами.
 */

type BarCellInput = {
	cIdx: number;
	isAccent: boolean;
	hasTaDing: boolean;
};

type BarInput = {
	rIdx: number;
	polyMode: boolean;
	laneId: 0 | 1 | 2;
	firstBeatEnabled: boolean;
	suppressedRow: boolean;
	playbackMode: SquarePlaybackMode;
	cells: BarCellInput[];
};

type BarEventLog = {
	firstBeatHitRow: boolean;
	cellEvents: Array<{
		cIdx: number;
		shouldPlay: boolean;
		isFirstBeatTaEvent: boolean;
	}>;
};

function simulateBar(input: BarInput): BarEventLog {
	const policy = resolveRuntimeFirstBeatPolicy(input.polyMode, input.laneId);
	const on0Accent = input.cells.find((c) => c.cIdx === 0)?.isAccent ?? false;
	const on0Ding = input.cells.find((c) => c.cIdx === 0)?.hasTaDing ?? false;
	const firstBeatHitRow = resolveFirstBeatHitRowPolicy(
		policy,
		on0Accent,
		on0Ding,
		input.firstBeatEnabled,
		input.suppressedRow,
	);
	const shouldPlayFirstBeatTa = firstBeatHitRow && input.firstBeatEnabled;
	const cellEvents = input.cells.map((cell) => {
		const hasTaDingHere = cell.cIdx === 0
			? firstBeatHitRow && input.firstBeatEnabled
			: cell.hasTaDing && input.firstBeatEnabled;
		const isFirstBeatTaEvent = cell.cIdx === 0 && shouldPlayFirstBeatTa;
		const shouldPlay = shouldPlayBeatForSquareGate({
			playbackMode: input.playbackMode,
			isAccent: cell.isAccent,
			hasTaDingHere,
			shouldPlayFirstBeatTa: isFirstBeatTaEvent,
		});
		return { cIdx: cell.cIdx, shouldPlay, isFirstBeatTaEvent };
	});
	return { firstBeatHitRow, cellEvents };
}

/**
 * Parity: runtime-audio и MIDI-export используют ОДИНАКОВУЮ функцию
 * `resolveFirstBeatHitRow` (сигнатура 5-args, policy-based).
 */
function testFirstBeatHelperParityAcrossModules() {
	for (const policy of ['legacy', 'explicit_any', 'explicit_ta_only'] as FirstBeatHitPolicy[]) {
		for (const a of [false, true]) {
			for (const d of [false, true]) {
				for (const fb of [false, true]) {
					for (const s of [false, true]) {
						const rtRuntime = resolveFirstBeatHitRowPolicy(policy, a, d, fb, s);
						const rtMidi = resolveFirstBeatHitRowMidi(policy, a, d, fb, s);
						assert.equal(rtRuntime, rtMidi, `policy parity mismatch: ${policy}, ${a}/${d}/${fb}/${s}`);
					}
				}
			}
		}
	}
}

/**
 * Event-log oracle stability: для одного и того же входа event-log детерминирован.
 */
function testEventLogDeterministic() {
	const input: BarInput = {
		rIdx: 0,
		polyMode: false,
		laneId: 0,
		firstBeatEnabled: true,
		suppressedRow: false,
		playbackMode: 'all_beats',
		cells: [
			{ cIdx: 0, isAccent: false, hasTaDing: false },
			{ cIdx: 1, isAccent: false, hasTaDing: false },
			{ cIdx: 2, isAccent: true, hasTaDing: false },
			{ cIdx: 3, isAccent: false, hasTaDing: true },
		],
	};
	const a = simulateBar(input);
	const b = simulateBar(input);
	assert.deepEqual(a, b);
}

/**
 * Oracle сценарий: lane0 legacy, firstBeatEnabled — c0 всегда играет.
 */
function testLane0LegacyFirstBeatAlwaysPlays() {
	const log = simulateBar({
		rIdx: 0,
		polyMode: true,
		laneId: 0,
		firstBeatEnabled: true,
		suppressedRow: false,
		playbackMode: 'all_beats',
		cells: [
			{ cIdx: 0, isAccent: false, hasTaDing: false },
			{ cIdx: 1, isAccent: false, hasTaDing: false },
		],
	});
	assert.equal(log.firstBeatHitRow, true);
	assert.equal(log.cellEvents[0]!.isFirstBeatTaEvent, true);
}

/**
 * Oracle сценарий: lane1 explicit_ta_only, нет Ta на c0 — first-beat НЕ играет,
 * даже если firstBeatEnabled=true.
 */
function testLane1ExplicitTaOnlyNoGhostFirstBeat() {
	const log = simulateBar({
		rIdx: 1,
		polyMode: true,
		laneId: 1,
		firstBeatEnabled: true,
		suppressedRow: false,
		playbackMode: 'all_beats',
		cells: [
			{ cIdx: 0, isAccent: true, hasTaDing: false },
			{ cIdx: 1, isAccent: false, hasTaDing: false },
		],
	});
	assert.equal(log.firstBeatHitRow, false, 'lane1 не должен получать ghost Ta от accent');
	assert.equal(log.cellEvents[0]!.isFirstBeatTaEvent, false);
}

/**
 * Passive_only + mixed Ta+accent: Ta-event играет (shouldPlay=true).
 *
 * Контракт App.tsx: `hasTaDingHere = firstBeatEnabled && laneTaDing.has(...)`.
 * Поэтому Ta-реально-звучит только когда lane включил first-beat (fa=true).
 */
function testPassiveOnlyMixedTaAccent() {
	const log = simulateBar({
		rIdx: 0,
		polyMode: false,
		laneId: 0,
		firstBeatEnabled: true,
		suppressedRow: false,
		playbackMode: 'passive_only',
		cells: [
			{ cIdx: 0, isAccent: false, hasTaDing: false },
			{ cIdx: 1, isAccent: true, hasTaDing: true },
			{ cIdx: 2, isAccent: false, hasTaDing: false },
		],
	});
	/** c1 (Ta+accent) должен играть в passive_only. */
	const c1 = log.cellEvents.find((e) => e.cIdx === 1);
	assert.ok(c1);
	assert.equal(c1.shouldPlay, true, 'passive_only: Ta+accent на c>0 должен играть');
	/** c2 (пустая) — не играет. */
	const c2 = log.cellEvents.find((e) => e.cIdx === 2);
	assert.ok(c2);
	assert.equal(c2.shouldPlay, false);
}

/**
 * Passive_only: Ta-клетка играет даже без accent.
 */
function testPassiveOnlyPureTaPlays() {
	const log = simulateBar({
		rIdx: 0,
		polyMode: false,
		laneId: 0,
		firstBeatEnabled: true,
		suppressedRow: false,
		playbackMode: 'passive_only',
		cells: [
			{ cIdx: 1, isAccent: false, hasTaDing: true },
		],
	});
	const c1 = log.cellEvents.find((e) => e.cIdx === 1);
	assert.ok(c1);
	assert.equal(c1.shouldPlay, true);
}

/**
 * Suppressed row + lane0 legacy: only `on0Ding` decides first-beat.
 */
function testSuppressedRowLegacyBehavior() {
	const logWithDing = simulateBar({
		rIdx: 0,
		polyMode: false,
		laneId: 0,
		firstBeatEnabled: true,
		suppressedRow: true,
		playbackMode: 'all_beats',
		cells: [
			{ cIdx: 0, isAccent: false, hasTaDing: true },
		],
	});
	assert.equal(logWithDing.firstBeatHitRow, true);

	const logNoDing = simulateBar({
		rIdx: 0,
		polyMode: false,
		laneId: 0,
		firstBeatEnabled: true,
		suppressedRow: true,
		playbackMode: 'all_beats',
		cells: [
			{ cIdx: 0, isAccent: true, hasTaDing: false },
		],
	});
	assert.equal(logNoDing.firstBeatHitRow, false, 'suppressed row: accent без Ta не должен звучать Ta');
}

/**
 * Virtualization independence для event-log: один и тот же `rIdx` + state
 * даёт одинаковый event-log независимо от того, какое `absR` был бы в UI.
 * Helper вообще не принимает absR/view-индексов — это фиксирует контракт домена.
 */
function testEventLogNoViewDependency() {
	const input: BarInput = {
		rIdx: 3,
		polyMode: true,
		laneId: 1,
		firstBeatEnabled: true,
		suppressedRow: false,
		playbackMode: 'accent_only',
		cells: [
			{ cIdx: 0, isAccent: false, hasTaDing: true },
			{ cIdx: 1, isAccent: true, hasTaDing: false },
		],
	};
	const a = simulateBar(input);
	const b = simulateBar({ ...input, cells: input.cells.map((c) => ({ ...c })) });
	assert.deepEqual(a, b, 'event-log должен зависеть только от data-domain входов');
}

function run() {
	testFirstBeatHelperParityAcrossModules();
	testEventLogDeterministic();
	testLane0LegacyFirstBeatAlwaysPlays();
	testLane1ExplicitTaOnlyNoGhostFirstBeat();
	testPassiveOnlyMixedTaAccent();
	testPassiveOnlyPureTaPlays();
	testSuppressedRowLegacyBehavior();
	testEventLogNoViewDependency();
	console.log('audioEventLog tests passed');
}

run();
