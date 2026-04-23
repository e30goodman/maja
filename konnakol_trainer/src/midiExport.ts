/**
 * Export current grid to General MIDI drums (channel 10).
 * Semantics: all_beats, dictant off, syllableReadMuteMode off (matches App.tsx emit paths).
 */

import MidiWriter from 'midi-writer-js';
import { buildLegacyPlaybackSequence, type DeadCellsMap } from './randomLogic';
import { advancePolyLaneAfterEmit, buildLaneBarIndices, type PolyVoicesCount } from './polySubLegacyScheduler';
import { buildRowCellSyllableLabels, type KalamMap } from './sequencerLabels';

const PULSE_METER_BASE_SYLLABLES = 4;

/** Lane 1 (legacy + poly V1). */
export const MIDI_V1_ACCENT_NOTE = 23; // B0
export const MIDI_V1_PASSIVE_NOTE = 50; // D3
export const MIDI_V1_ALT_NOTE = 26; // D1 (legacy default, unchanged)
export const MIDI_V1_TA_HIGH_NOTE = 56; // G#2 (legacy default, unchanged)

/** Lane 2 (poly V2). */
export const MIDI_V2_ACCENT_NOTE = 34; // A#1
export const MIDI_V2_ALT_NOTE = 21; // A0
export const MIDI_V2_PASSIVE_NOTE = 51; // D#3
export const MIDI_V2_TA_HIGH_NOTE = 29; // F1

const DRUM_CHANNEL = 10;

export type MidiExportRole = 'accent' | 'alt' | 'passive' | 'taHigh';

export function resolveMidiNoteForLaneRole(lane: number, role: MidiExportRole): number {
	// Legacy mode always emits lane 0, so it follows V1 mapping.
	if (lane === 1) {
		if (role === 'accent') return MIDI_V2_ACCENT_NOTE;
		if (role === 'alt') return MIDI_V2_ALT_NOTE;
		if (role === 'passive') return MIDI_V2_PASSIVE_NOTE;
		return MIDI_V2_TA_HIGH_NOTE;
	}
	if (role === 'accent') return MIDI_V1_ACCENT_NOTE;
	if (role === 'alt') return MIDI_V1_ALT_NOTE;
	if (role === 'passive') return MIDI_V1_PASSIVE_NOTE;
	return MIDI_V1_TA_HIGH_NOTE;
}

export interface MidiExportInput {
	bpm: number;
	bars: number;
	baseSyllables: number;
	customSyllables: Record<number, number>;
	customSubdivisions: Record<string, number>;
	pulseMeterUnlinked?: Record<number, boolean>;
	customMultipliers?: Record<number, number>;
	accents: Set<string> | Iterable<string>;
	accentsByLane?: Partial<Record<0 | 1 | 2, Set<string> | Iterable<string>>>;
	taDingKeys: Set<string> | Iterable<string>;
	taDingKeysByLane?: Partial<Record<0 | 1 | 2, Set<string> | Iterable<string>>>;
	firstBeatAccent: boolean;
	firstBeatAccentByLane?: Partial<Record<0 | 1 | 2, boolean>>;
	firstBeatDingSuppressedRows: Set<number> | Iterable<number>;
	deadCells: DeadCellsMap | Record<number, { deadStart?: number; displayLen?: number; baseLen?: number }>;
	polyMode: boolean;
	polyVoices: PolyVoicesCount;
	humanize?: boolean;
	seed?: number;
	ppq?: number;
	maxNoteEvents?: number;
	maxWallSeconds?: number;
	patternRevolutions?: number;
	squarePlaybackMode?: 'all_beats' | 'accent_only' | 'passive_only';
	syllableReadMuteMode?: 'off' | 'full' | 'no_accent_sharp';
	dictantMode?: boolean;
}

export type ClassifiedHits = {
	taHigh: boolean;
	accent: boolean;
	altShadow: boolean;
	passive: boolean;
};

export type FirstBeatHitPolicy = 'legacy' | 'explicit_any' | 'explicit_ta_only';

export function resolveFirstBeatHitRow(
	policy: FirstBeatHitPolicy,
	on0Accent: boolean,
	on0Ding: boolean,
	firstBeatAccent: boolean,
	suppressedRow: boolean,
): boolean {
	if (policy === 'explicit_ta_only') return on0Ding;
	if (policy === 'explicit_any') return on0Accent || on0Ding;
	/**
	 * Legacy: default first-beat Ta when `firstBeatAccent && !suppressedRow`, or explicit
	 * mark on 0. If the user **suppressed** default Ta for this row, a plain 0-accent must
	 * not resurrect the Ta hit (only `on0Ding` does), or the row sounds «Ta» without a Ta mark.
	 */
	if (suppressedRow) return on0Ding;
	return on0Accent || on0Ding || firstBeatAccent;
}

function toStringSet(iter: Set<string> | Iterable<string>): Set<string> {
	return iter instanceof Set ? iter : new Set(iter);
}

function toNumberSet(iter: Set<number> | Iterable<number>): Set<number> {
	return iter instanceof Set ? iter : new Set(iter);
}

function toDeadCellsMap(raw: MidiExportInput['deadCells']): DeadCellsMap {
	const out: DeadCellsMap = {};
	for (const [k, v] of Object.entries(raw)) {
		const r = parseInt(k, 10);
		if (!Number.isFinite(r) || !v) continue;
		const ds = v.deadStart;
		if (typeof ds !== 'number') continue;
		const displayLen = typeof v.displayLen === 'number' ? v.displayLen : ds;
		const baseLen = typeof v.baseLen === 'number' ? v.baseLen : displayLen;
		out[r] = { deadStart: ds, displayLen, baseLen };
	}
	return out;
}

/** mulberry32 PRNG */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function syllableToDrumNote(syllable: string): number {
	const s = syllable.trim().toLowerCase();
	if (s === 'ta' || s === 'dhi' || s === 'tha') return 38;
	if (s === 'ka' || s === 'ki') return 42;
	if (s === 'thom' || s === 'num') return 41;
	return 37;
}

function headSyllableForCell(
	rowSyllCount: number,
	customSubdivs: Record<string, number>,
	rowIdx: number,
	colIdx: number,
	bpm: number,
	kalamMap: KalamMap,
): string {
	const labels = buildRowCellSyllableLabels(rowSyllCount, customSubdivs, rowIdx, {
		bpm,
		kalamMap,
	});
	const cell = labels[colIdx];
	const first = cell?.[0]?.trim();
	return first && first.length > 0 ? first : 'Ta';
}

export function effectiveBpmForRow(
	bpm: number,
	rowIdx: number,
	baseSyllables: number,
	customSyllables: Record<number, number>,
	pulseMeterUnlinked: Record<number, boolean> | undefined,
	customMultipliers: Record<number, number> | undefined,
): number {
	const rowSyllables =
		customSyllables[rowIdx] !== undefined ? customSyllables[rowIdx]! : baseSyllables;
	const pulseSyllables = pulseMeterUnlinked?.[rowIdx] ? PULSE_METER_BASE_SYLLABLES : rowSyllables;
	const mult = customMultipliers?.[rowIdx] ?? 1;
	return bpm * (pulseSyllables / 4) * mult;
}

export function ticksPerCellFromRow(
	bpm: number,
	rowIdx: number,
	baseSyllables: number,
	customSyllables: Record<number, number>,
	pulseMeterUnlinked: Record<number, boolean> | undefined,
	customMultipliers: Record<number, number> | undefined,
	ppq: number,
): number {
	const eff = effectiveBpmForRow(bpm, rowIdx, baseSyllables, customSyllables, pulseMeterUnlinked, customMultipliers);
	if (!Number.isFinite(eff) || eff <= 0) return ppq;
	return (ppq * bpm) / eff;
}

function resolveAdaptivePpq(input: MidiExportInput, requestedPpq: number): number {
	const targetMinCellTicks = 96;
	let minCellTicks = Infinity;
	const bars = Math.max(0, Math.floor(input.bars));
	for (let r = 0; r < bars; r++) {
		const t = ticksPerCellFromRow(
			input.bpm,
			r,
			input.baseSyllables,
			input.customSyllables,
			input.pulseMeterUnlinked,
			input.customMultipliers,
			requestedPpq,
		);
		if (Number.isFinite(t) && t > 0) minCellTicks = Math.min(minCellTicks, t);
	}
	if (!Number.isFinite(minCellTicks) || minCellTicks <= 0 || minCellTicks >= targetMinCellTicks) {
		return requestedPpq;
	}
	const scale = Math.ceil(targetMinCellTicks / minCellTicks);
	return Math.min(15360, requestedPpq * Math.max(1, scale));
}

function toWriterVelocity(vMidi: number): number {
	const c = Math.max(1, Math.min(127, Math.round(vMidi)));
	return Math.max(1, Math.min(100, Math.round((c / 127) * 100)));
}

export function computeVelocity(
	role: MidiExportRole,
	colIdx: number,
	mainAccent: boolean,
	shouldPlayFirstBeatTa: boolean,
	headSyllable: string,
	humanize: boolean,
	rng: () => number,
): number {
	let baseMidi =
		role === 'accent' ? 115 : role === 'alt' ? 105 : role === 'taHigh' ? 108 : 85;
	const low = headSyllable.trim().toLowerCase();
	if (low === 'thom' || low === 'num' || low === 'dhi') baseMidi += 5;
	if (low === 'ka' || low === 'ki') baseMidi -= 5;
	if (colIdx === 0 && (mainAccent || shouldPlayFirstBeatTa)) baseMidi = 127;
	if (humanize) {
		baseMidi += Math.floor(rng() * 11) - 5;
	}
	return Math.max(1, Math.min(127, baseMidi));
}

/**
 * Same order as App.tsx emitGridSubAudio (sub===0): shouldDedup uses set state before first-beat add.
 * Mutates polyClickSlots when polyMode (adds key like runtime).
 */
export function classifyGridCellHits(args: {
	rowIdx: number;
	colIdx: number;
	subdivs: number;
	isAccent: boolean;
	taDingKeys: Set<string>;
	accents: Set<string>;
	firstBeatAccent: boolean;
	suppressedRow: boolean;
	polyMode: boolean;
	polyDedupKey: string;
	polyClickSlots: Set<string>;
	playbackMode: 'all_beats' | 'accent_only' | 'passive_only';
	muteMode: 'off' | 'full' | 'no_accent_sharp';
	dictantActive: boolean;
	firstBeatRequiresExplicitMark?: boolean;
	firstBeatHitPolicy?: FirstBeatHitPolicy;
}): ClassifiedHits {
	const {
		rowIdx,
		colIdx,
		subdivs,
		isAccent,
		taDingKeys,
		accents,
		firstBeatAccent,
		suppressedRow,
		polyMode,
		polyDedupKey,
		polyClickSlots,
		playbackMode,
		muteMode,
		dictantActive,
		firstBeatRequiresExplicitMark,
		firstBeatHitPolicy,
	} = args;

	const out: ClassifiedHits = { taHigh: false, accent: false, altShadow: false, passive: false };
	const shouldDedupPolyClick = polyMode && polyClickSlots.has(polyDedupKey);

	const on0Accent = accents.has(`${rowIdx}-0`);
	const on0Ding = taDingKeys.has(`${rowIdx}-0`);
	const policy: FirstBeatHitPolicy = firstBeatHitPolicy
		?? (firstBeatRequiresExplicitMark ? 'explicit_any' : 'legacy');
	const firstBeatCellHitRow = resolveFirstBeatHitRow(
		policy,
		on0Accent,
		on0Ding,
		firstBeatAccent,
		suppressedRow,
	);
	const sub = 0;
	const mainAccentClick = isAccent && (subdivs > 1 || sub === 0);
	const shouldPlayFirstBeatTa =
		colIdx === 0 && firstBeatAccent && firstBeatCellHitRow && (subdivs > 1 || sub === 0);
	const isTaDingCell = firstBeatAccent && colIdx >= 1 && taDingKeys.has(`${rowIdx}-${colIdx}`);
	const shouldPlayTaDingSound = isTaDingCell && (subdivs > 1 || sub === 0);

	const isTaFirstBeatArticulation =
		colIdx === 0 && firstBeatAccent && firstBeatCellHitRow && (subdivs > 1 || sub === 0);
	const sharpAsChecked = (() => {
		if (dictantActive) return mainAccentClick;
		if (muteMode === 'no_accent_sharp' && mainAccentClick && !isTaFirstBeatArticulation) return false;
		return mainAccentClick;
	})();

	const shouldPlayBeat =
		playbackMode === 'all_beats'
			? true
			: playbackMode === 'accent_only'
				? isAccent || taDingKeys.has(`${rowIdx}-${colIdx}`)
				: false;

	if (shouldPlayFirstBeatTa) {
		out.taHigh = true;
		if (polyMode) polyClickSlots.add(polyDedupKey);
	}
	if (shouldDedupPolyClick) {
		return out;
	}
	if (shouldPlayTaDingSound) {
		out.taHigh = true;
		if (polyMode) polyClickSlots.add(polyDedupKey);
	}
	if (muteMode === 'full') return out;
	if (!shouldPlayBeat) return out;
	if (shouldPlayTaDingSound && !sharpAsChecked && playbackMode !== 'all_beats') return out;
	if (shouldPlayFirstBeatTa && !sharpAsChecked && playbackMode !== 'all_beats') return out;

	if (sharpAsChecked) {
		out.accent = true;
	} else {
		out.passive = true;
	}
	if (sharpAsChecked && playbackMode === 'all_beats' && !shouldPlayFirstBeatTa && !shouldPlayTaDingSound) {
		out.altShadow = true;
	}
	if (polyMode) {
		polyClickSlots.add(polyDedupKey);
	}
	return out;
}

function wallSecToTick(wallSec: number, bpm: number, ppq: number): number {
	return wallSec * (bpm / 60) * ppq;
}

function getRowSyl(
	rowIdx: number,
	baseSyllables: number,
	customSyllables: Record<number, number>,
): number {
	return customSyllables[rowIdx] !== undefined ? customSyllables[rowIdx]! : baseSyllables;
}

function getBarTimeWindowSeconds(
	rowIdx: number,
	baseSyllables: number,
	customSyllables: Record<number, number>,
	pulseMeterUnlinked: Record<number, boolean> | undefined,
	customMultipliers: Record<number, number> | undefined,
	bpm: number,
): number {
	const noteDur =
		60 /
		Math.max(
			1e-6,
			effectiveBpmForRow(bpm, rowIdx, baseSyllables, customSyllables, pulseMeterUnlinked, customMultipliers),
		);
	const rowSyl = getRowSyl(rowIdx, baseSyllables, customSyllables);
	return noteDur * Math.max(1, rowSyl);
}

type PendingNote = {
	tick: number;
	pitch: number;
	velocity: number;
	durationTicks: number;
	trackIndex: number;
};

function pushNote(
	list: PendingNote[],
	trackIndex: number,
	tick: number,
	pitch: number,
	velMidi: number,
	cellTicks: number,
	humanize: boolean,
	rng: () => number,
): void {
	let t = Math.round(tick);
	if (humanize) {
		t += Math.floor(rng() * 7) - 3;
	}
	const cellTicksInt = Math.max(1, Math.round(cellTicks));
	const minDurTicks = 24;
	const durRaw = Math.max(minDurTicks, Math.round(cellTicksInt * 0.82));
	const maxStart = Math.max(0, Math.round(tick + cellTicksInt) - 1);
	t = Math.max(0, Math.min(maxStart, t));
	const noteEnd = Math.min(Math.round(tick + cellTicksInt), t + durRaw);
	const durationTicks = Math.max(1, noteEnd - t);
	list.push({
		trackIndex,
		tick: t,
		pitch,
		velocity: toWriterVelocity(velMidi),
		durationTicks,
	});
}

function trackIndexFor(lane: number, role: 'accent' | 'alt' | 'passive' | 'taHigh'): number {
	const o = role === 'accent' ? 0 : role === 'alt' ? 1 : role === 'passive' ? 2 : 3;
	return lane * 4 + o;
}

export function generateMidi(input: MidiExportInput): Uint8Array {
	const bpm = input.bpm;
	const requestedPpq = input.ppq ?? 960;
	const ppq = resolveAdaptivePpq(input, requestedPpq);
	const humanize = input.humanize !== false;
	const seed = input.seed ?? 0x9e3779b9;
	const rng = mulberry32(seed);
	const maxNotes = input.maxNoteEvents ?? 200_000;
	const maxWall = input.maxWallSeconds ?? 48;
	const revolutions = Math.max(1, Math.floor(input.patternRevolutions ?? 1));
	const playbackMode = input.squarePlaybackMode ?? 'all_beats';
	const muteMode = input.syllableReadMuteMode ?? 'off';
	const dictantActive = input.dictantMode === true;

	const accents = toStringSet(input.accents);
	const taDingKeys = toStringSet(input.taDingKeys);
	const accentsByLane: Record<0 | 1 | 2, Set<string>> = {
		0: toStringSet(input.accentsByLane?.[0] ?? accents),
		1: toStringSet(input.accentsByLane?.[1] ?? []),
		2: toStringSet(input.accentsByLane?.[2] ?? []),
	};
	const taDingByLane: Record<0 | 1 | 2, Set<string>> = {
		0: toStringSet(input.taDingKeysByLane?.[0] ?? taDingKeys),
		1: toStringSet(input.taDingKeysByLane?.[1] ?? []),
		2: toStringSet(input.taDingKeysByLane?.[2] ?? []),
	};
	const firstBeatByLane: Record<0 | 1 | 2, boolean> = {
		0: input.firstBeatAccentByLane?.[0] ?? input.firstBeatAccent,
		1: input.firstBeatAccentByLane?.[1] ?? input.firstBeatAccent,
		2: input.firstBeatAccentByLane?.[2] ?? input.firstBeatAccent,
	};
	const suppressed = toNumberSet(input.firstBeatDingSuppressedRows);
	const deadMap = toDeadCellsMap(input.deadCells);
	const pulseU = input.pulseMeterUnlinked ?? {};
	const mult = input.customMultipliers ?? {};

	const V: PolyVoicesCount = input.polyVoices === 3 ? 3 : 2;
	const laneCount = input.polyMode ? (V === 3 ? 3 : 2) : 1;

	const kalamMap: KalamMap = new Map();

	const pending: PendingNote[] = [];
	let noteCount = 0;

	const tryPush = (
		lane: number,
		role: MidiExportRole,
		baseTick: number,
		cellTicks: number,
		rowIdx: number,
		colIdx: number,
		headSyl: string,
		mainAccent: boolean,
		shouldPlayFirstBeatTa: boolean,
	) => {
		if (noteCount >= maxNotes) return;
		const pitch = resolveMidiNoteForLaneRole(lane, role);
		const vel = computeVelocity(role, colIdx, mainAccent, shouldPlayFirstBeatTa, headSyl, humanize, rng);
		pushNote(pending, trackIndexFor(lane, role), baseTick, pitch, vel, cellTicks, humanize, rng);
		noteCount++;
	};

	const emitCell = (
		rowIdx: number,
		colIdx: number,
		lane: number,
		wallSec: number,
		polyMode: boolean,
		polyVoice: number,
		polyClickSlots: Set<string>,
	) => {
		const rowSyl = getRowSyl(rowIdx, input.baseSyllables, input.customSyllables);
		const subdivs = input.customSubdivisions[`${rowIdx}-${colIdx}`] ?? 1;
		const deadCut = deadMap[rowIdx]?.deadStart;
		if (typeof deadCut === 'number' && colIdx >= deadCut) return;

		const polyDedupKey = `${polyVoice}:${rowIdx}:${Math.round(wallSec * 1_000_000)}`;
		const laneSetIdx = (lane <= 0 ? 0 : lane === 1 ? 1 : 2) as 0 | 1 | 2;
		const rowAccents = input.polyMode ? accentsByLane[laneSetIdx] : accents;
		const rowTaDing = input.polyMode ? taDingByLane[laneSetIdx] : taDingKeys;
		const rowFirstBeat = input.polyMode ? firstBeatByLane[laneSetIdx] : input.firstBeatAccent;
		const isAccent = rowAccents.has(`${rowIdx}-${colIdx}`);
		const firstBeatPolicy: FirstBeatHitPolicy = input.polyMode
			? (laneSetIdx === 0 ? 'legacy' : 'explicit_ta_only')
			: 'legacy';
		const hits = classifyGridCellHits({
			rowIdx,
			colIdx,
			subdivs,
			isAccent,
			taDingKeys: rowTaDing,
			accents: rowAccents,
			firstBeatAccent: rowFirstBeat,
			suppressedRow: suppressed.has(rowIdx),
			polyMode,
			polyDedupKey,
			polyClickSlots,
			playbackMode,
			muteMode,
			dictantActive,
			firstBeatHitPolicy: firstBeatPolicy,
		});

		const on0Accent = rowAccents.has(`${rowIdx}-0`);
		const on0Ding = rowTaDing.has(`${rowIdx}-0`);
		const firstBeatCellHitRow = resolveFirstBeatHitRow(
			firstBeatPolicy,
			on0Accent,
			on0Ding,
			rowFirstBeat,
			suppressed.has(rowIdx),
		);
		const shouldPlayFirstBeatTa =
			colIdx === 0 && rowFirstBeat && firstBeatCellHitRow && (subdivs > 1 || 0 === 0);
		const mainAccent = isAccent;

		const headSyl = headSyllableForCell(rowSyl, input.customSubdivisions, rowIdx, colIdx, bpm, kalamMap);
		const cellTicks = ticksPerCellFromRow(
			bpm,
			rowIdx,
			input.baseSyllables,
			input.customSyllables,
			pulseU,
			mult,
			ppq,
		);
		const baseTick = wallSecToTick(wallSec, bpm, ppq);

		if (hits.taHigh) tryPush(lane, 'taHigh', baseTick, cellTicks, rowIdx, colIdx, headSyl, mainAccent, shouldPlayFirstBeatTa);
		if (hits.accent) tryPush(lane, 'accent', baseTick, cellTicks, rowIdx, colIdx, headSyl, mainAccent, shouldPlayFirstBeatTa);
		if (hits.altShadow) tryPush(lane, 'alt', baseTick, cellTicks, rowIdx, colIdx, headSyl, mainAccent, shouldPlayFirstBeatTa);
		if (hits.passive) tryPush(lane, 'passive', baseTick, cellTicks, rowIdx, colIdx, headSyl, mainAccent, shouldPlayFirstBeatTa);
	};

	if (!input.polyMode) {
		const polyClickSlots = new Set<string>();
		const seq = buildLegacyPlaybackSequence(
			input.bars,
			input.customSyllables,
			input.baseSyllables,
			deadMap,
		);
		let wall = 0;
		for (let rev = 0; rev < revolutions; rev++) {
			for (const step of seq) {
				if (wall > maxWall) break;
				emitCell(step.r, step.c, 0, wall, false, 0, polyClickSlots);
				wall +=
					60 /
					Math.max(
						1e-6,
						effectiveBpmForRow(bpm, step.r, input.baseSyllables, input.customSyllables, pulseU, mult),
					);
			}
			if (wall > maxWall) break;
		}
	} else {
		const barCount = Math.max(0, Math.floor(input.bars));
		const laneBarIdx = buildLaneBarIndices(barCount, V);
		type Lane = {
			laneId: number;
			barIndices: number[];
			barCursor: number;
			cellCursor: number;
			nextWall: number;
		};
		const lanes: Lane[] = laneBarIdx.map((barIndices, laneId) => ({
			laneId,
			barIndices,
			barCursor: 0,
			cellCursor: 0,
			nextWall: 0,
		}));

		const lanePatternSec = lanes.map((L) => {
			if (L.barIndices.length === 0) return 0;
			let s = 0;
			for (const b of L.barIndices) {
				s += getBarTimeWindowSeconds(b, input.baseSyllables, input.customSyllables, pulseU, mult, bpm);
			}
			return s;
		});
		const slowest = Math.max(1e-6, ...lanePatternSec);

		const horizon = Math.min(maxWall, slowest * revolutions);

		const polyClickSlots = new Set<string>();

		let guard = 0;
		while (guard < 500_000) {
			guard++;
			let best: Lane | null = null;
			let bestT = Infinity;
			for (const L of lanes) {
				if (L.barIndices.length === 0) continue;
				if (L.nextWall < bestT) {
					bestT = L.nextWall;
					best = L;
				}
			}
			if (best === null || bestT > horizon) break;

			const bar = best.barIndices[best.barCursor]!;
			const rowSyl = getRowSyl(bar, input.baseSyllables, input.customSyllables);
			const dBar = getBarTimeWindowSeconds(bar, input.baseSyllables, input.customSyllables, pulseU, mult, bpm) / Math.max(1, rowSyl);
			const deadStart = deadMap[bar]?.deadStart;

			emitCell(bar, best.cellCursor, best.laneId, bestT, true, best.laneId, polyClickSlots);

			const { nextC, advanceBar } = advancePolyLaneAfterEmit(best.cellCursor, rowSyl, deadStart);
			const advanceLaneBar = advanceBar || (!advanceBar && nextC === 0);
			if (advanceLaneBar) {
				best.barCursor = (best.barCursor + 1) % best.barIndices.length;
				best.cellCursor = 0;
			} else {
				best.cellCursor = nextC;
			}
			best.nextWall += dBar;
			if (noteCount >= maxNotes) break;
		}
	}

	pending.sort((a, b) => a.tick - b.tick || a.trackIndex - b.trackIndex);

	const conductor = new MidiWriter.Track();
	conductor.setTempo(bpm, 0);
	conductor.addTrackName('Tempo');

	const drumTracks: InstanceType<typeof MidiWriter.Track>[] = [];
	for (let lane = 0; lane < laneCount; lane++) {
		const labels = ['Accent', 'Alt', 'Passive', 'TaHigh'] as const;
		for (let k = 0; k < 4; k++) {
			const t = new MidiWriter.Track();
			const prefix = laneCount > 1 ? `V${lane + 1}-` : '';
			t.addTrackName(`${prefix}${labels[k]}`);
			drumTracks.push(t);
		}
	}

	for (const n of pending) {
		const tr = drumTracks[n.trackIndex];
		if (!tr) continue;
		tr.addEvent(
			new MidiWriter.NoteEvent({
				pitch: n.pitch,
				startTick: n.tick,
				duration: `T${n.durationTicks}`,
				velocity: n.velocity,
				channel: DRUM_CHANNEL,
			}),
		);
	}

	const writer = new MidiWriter.Writer([conductor, ...drumTracks], { ticksPerBeat: ppq });
	return writer.buildFile();
}

export function generateMidiBlob(input: MidiExportInput): Blob {
	return new Blob([generateMidi(input)], { type: 'audio/midi' });
}
