/**
 * Export current grid to General MIDI drums (channel 10).
 * Semantics: `full_mix` baseline; parity with gating in App.tsx (emitGridSubAudio / classifyGridCellHits).
 */

import MidiWriter from 'midi-writer-js';
import { buildLegacyPlaybackSequence, type DeadCellsMap } from './randomLogic';
import { advancePolyLaneAfterEmit, buildLaneBarIndices, type PolyVoicesCount } from './polySubLegacyScheduler';
import { buildRowCellSyllableLabels, type KalamMap, type RowRuntimeContext } from './sequencerLabels';

const PULSE_METER_BASE_SYLLABLES = 4;

export type MidiSquarePlaybackMode = 'passive_no_alt' | 'full_mix' | 'ta_only';
export type MidiMixerLayerMode = 'full_mix' | 'no_alt' | 'alt_only';
export type MidiTrainerMode = 'normal' | 'ta_only' | 'dictation';

/** Parity with `normalizeSquarePlaybackModeFromSnapshot` in App. */
function normalizeSquarePlaybackModeForExport(raw: unknown): MidiSquarePlaybackMode {
	if (raw === 'passive_no_alt' || raw === 'full_mix' || raw === 'ta_only') return raw;
	if (raw === 'all_beats' || raw === 'accent_only') return 'full_mix';
	if (raw === 'passive_only') return 'ta_only';
	return 'full_mix';
}
function normalizeMixerLayerModeForExport(raw: unknown): MidiMixerLayerMode {
	if (raw === 'full_mix' || raw === 'no_alt' || raw === 'alt_only') return raw;
	return 'full_mix';
}
function normalizeTrainerModeForExport(raw: unknown): MidiTrainerMode {
	if (raw === 'normal' || raw === 'ta_only' || raw === 'dictation') return raw;
	return 'normal';
}
function deriveModesFromLegacyExport(
	playbackMode: MidiSquarePlaybackMode,
	passiveLayerMuted: boolean,
	dictantMode: boolean,
): { mixerLayerMode: MidiMixerLayerMode; trainerMode: MidiTrainerMode } {
	const mixerLayerMode: MidiMixerLayerMode =
		playbackMode === 'passive_no_alt'
			? 'no_alt'
			: playbackMode === 'ta_only'
				? 'full_mix'
				: passiveLayerMuted
					? 'alt_only'
					: 'full_mix';
	const trainerMode: MidiTrainerMode = dictantMode ? 'dictation' : playbackMode === 'ta_only' ? 'ta_only' : 'normal';
	return { mixerLayerMode, trainerMode };
}

/** Lane 1 (legacy + poly V1). */
export const MIDI_V1_ACCENT_NOTE = 36; // C1 (Bass Drum 1, GM)
export const MIDI_V1_PASSIVE_NOTE = 42; // F#1 (Closed Hi-Hat, GM)
export const MIDI_V1_ALT_NOTE = 38; // D1 (Acoustic Snare, GM)
export const MIDI_V1_TA_HIGH_NOTE = 36; // C1 (merged with accent per Cubase mapping)

/** Lane 2 (poly V2). */
export const MIDI_V2_ACCENT_NOTE = 47; // B1 (Low-Mid Tom, GM)
export const MIDI_V2_ALT_NOTE = 39; // D#1 (Hand Clap, GM)
export const MIDI_V2_PASSIVE_NOTE = 37; // C#1 (Side Stick / Rimshot, GM)
export const MIDI_V2_TA_HIGH_NOTE = 29; // F1

/** Lane 3 (poly V3). */
export const MIDI_V3_ACCENT_NOTE = 56; // G#2 (Cowbell, GM)
export const MIDI_V3_ALT_NOTE = 53; // F3 (Ride Bell, GM)
export const MIDI_V3_PASSIVE_NOTE = 76; // E5 (Hi Wood Block, GM)
export const MIDI_V3_TA_HIGH_NOTE = 57; // A2 (Crash Cymbal 2)

const DRUM_CHANNEL = 10;

export type MidiExportRole = 'accent' | 'alt' | 'passive' | 'taHigh';
type MidiLaneProfile = 'base' | 'contrast' | 'ring';

function resolveMidiNoteForProfileRole(profile: MidiLaneProfile, role: MidiExportRole): number {
	if (profile === 'ring') {
		if (role === 'accent') return MIDI_V3_ACCENT_NOTE;
		if (role === 'alt') return MIDI_V3_ALT_NOTE;
		if (role === 'passive') return MIDI_V3_PASSIVE_NOTE;
		return MIDI_V3_TA_HIGH_NOTE;
	}
	if (profile === 'contrast') {
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

export function resolveMidiNoteForLaneRole(lane: number, role: MidiExportRole): number {
	if (lane === 2) return resolveMidiNoteForProfileRole('ring', role);
	if (lane === 1) return resolveMidiNoteForProfileRole('contrast', role);
	return resolveMidiNoteForProfileRole('base', role);
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
	/** Long-press MIDI mode: for 2-voice poly export until first exact re-align by first notes. */
	twoVoiceAutoAlignByFirstNotes?: boolean;
	/** Safety cap for auto-align mode, measured by crossed bar boundaries. */
	twoVoiceAutoAlignMaxBars?: number;
	squarePlaybackMode?:
		| 'passive_no_alt'
		| 'full_mix'
		| 'ta_only'
		| 'all_beats'
		| 'accent_only'
		| 'passive_only';
	/** Long-press on purple: no passive layer (same as App). */
	squarePassiveLayerMuted?: boolean;
	mixerLayerMode?: MidiMixerLayerMode;
	trainerMode?: MidiTrainerMode;
	trainerHoldMute?: boolean;
	syllableReadMuteMode?: 'off' | 'full' | 'no_accent_sharp';
	dictantMode?: boolean;
	/** Optional row-level runtime context (parent mode intent). */
	rowRuntimeContexts?: Record<number, RowRuntimeContext>;
	progressiveDensityMode?: 'gati_mode' | 'jati_mode';
	deSyncJatiActive?: boolean;
	deSyncCycleLength?: number;
	/** Click preset identity for lane-profile collapsing logic in poly exports. */
	clickSound?: string;
	clickSoundByPolyVoice?: Partial<Record<0 | 1 | 2, string>>;
	/** Optional lane-role gain multipliers from metronome sliders (voice gain * bus gain). */
	laneRoleGains?: Partial<Record<0 | 1 | 2, { accent: number; alt: number; passive: number }>>;
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
	 * not resurrect the Ta hit (only `on0Ding` does), or the row sounds "Ta" without a Ta mark.
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
	baseBpm: number,
	effectiveBpm: number,
	kalamMap: KalamMap,
	rowRuntimeContext?: RowRuntimeContext,
): string {
	const labels = buildRowCellSyllableLabels(rowSyllCount, customSubdivs, rowIdx, {
		bpm: baseBpm,
		rowRuntimeContext: { ...(rowRuntimeContext ?? {}), effectiveBpm },
		kalamMap,
		isLessonLastRow: false,
	});
	const cell = labels[colIdx];
	const first = cell?.[0]?.syl?.trim();
	if (first && first.length > 0) return first;
	console.error('[midiExport] missing head syllable for cell', { rowIdx, colIdx, rowSyllCount });
	return '__ERR__';
}

export function effectiveBpmForRow(
	bpm: number,
	rowIdx: number,
	baseSyllables: number,
	customSyllables: Record<number, number>,
	pulseMeterUnlinked: Record<number, boolean> | undefined,
	customMultipliers: Record<number, number> | undefined,
	progressiveDensityMode?: 'gati_mode' | 'jati_mode',
	deSyncJatiActive?: boolean,
	deSyncCycleLength?: number,
): number {
	const rowSyllables =
		customSyllables[rowIdx] !== undefined ? customSyllables[rowIdx]! : baseSyllables;
	const jatiCycle =
		progressiveDensityMode === 'jati_mode' &&
		deSyncJatiActive === true &&
		typeof deSyncCycleLength === 'number' &&
		Number.isFinite(deSyncCycleLength) &&
		deSyncCycleLength >= 1
			? Math.max(1, Math.floor(deSyncCycleLength))
			: null;
	const pulseSyllables =
		jatiCycle !== null
			? jatiCycle
			: pulseMeterUnlinked?.[rowIdx]
				? PULSE_METER_BASE_SYLLABLES
				: rowSyllables;
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
	progressiveDensityMode?: 'gati_mode' | 'jati_mode',
	deSyncJatiActive?: boolean,
	deSyncCycleLength?: number,
): number {
	const eff = effectiveBpmForRow(
		bpm,
		rowIdx,
		baseSyllables,
		customSyllables,
		pulseMeterUnlinked,
		customMultipliers,
		progressiveDensityMode,
		deSyncJatiActive,
		deSyncCycleLength,
	);
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
			input.progressiveDensityMode,
			input.deSyncJatiActive,
			input.deSyncCycleLength,
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
	if (role === 'accent') return 120;
	if (role === 'alt') return 95;
	if (role === 'passive') return 70;
	return 108;
}

function lanePanCc10(profile: MidiLaneProfile): number {
	if (profile === 'contrast') return 40;
	if (profile === 'ring') return 88;
	return 64;
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
	mixerLayerMode: MidiMixerLayerMode;
	trainerMode: MidiTrainerMode;
	muteMode: 'off' | 'full' | 'no_accent_sharp';
	dictantActive: boolean;
	trainerHoldMute?: boolean;
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
		mixerLayerMode,
		trainerMode,
		muteMode,
		dictantActive,
		trainerHoldMute,
		firstBeatRequiresExplicitMark,
		firstBeatHitPolicy,
	} = args;
	const layerMuted = trainerHoldMute === true;

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
		colIdx === 0 && firstBeatCellHitRow && (subdivs > 1 || sub === 0);
	const isTaDingCell = colIdx >= 1 && taDingKeys.has(`${rowIdx}-${colIdx}`);
	const shouldPlayTaDingSound = isTaDingCell && (subdivs > 1 || sub === 0);
	const hasTaDingHere = taDingKeys.has(`${rowIdx}-${colIdx}`);

	const isTaFirstBeatArticulation =
		colIdx === 0 && firstBeatCellHitRow && (subdivs > 1 || sub === 0);
	const sharpAsChecked = (() => {
		if (dictantActive) return mainAccentClick;
		if (muteMode === 'no_accent_sharp' && mainAccentClick && !isTaFirstBeatArticulation) return false;
		return mainAccentClick;
	})();

	const trainerTaOnly = trainerMode === 'ta_only';
	const shouldPlayBeat = trainerTaOnly ? hasTaDingHere || shouldPlayFirstBeatTa : true;

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
	if (layerMuted || muteMode === 'full') return out;
	if (!shouldPlayBeat) return out;
	if (shouldPlayTaDingSound && !sharpAsChecked && trainerTaOnly) return out;
	if (shouldPlayFirstBeatTa && !sharpAsChecked && trainerTaOnly) return out;
	// Additive base layer: passive is always present on playable cells.
	out.passive = true;

	if (sharpAsChecked) {
		out.accent = true;
	}
	if (
		sharpAsChecked
		&& mixerLayerMode === 'full_mix'
		&& colIdx > 0
		&& !shouldPlayFirstBeatTa
		&& !shouldPlayTaDingSound
	) {
		out.altShadow = true;
	} else if (
		sharpAsChecked &&
		mixerLayerMode === 'no_alt' &&
		!shouldPlayFirstBeatTa &&
		!shouldPlayTaDingSound
	) {
		// no-op: passive already on by additive base policy
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
	progressiveDensityMode: 'gati_mode' | 'jati_mode' | undefined,
	deSyncJatiActive: boolean | undefined,
	deSyncCycleLength: number | undefined,
	bpm: number,
): number {
	const noteDur =
		60 /
		Math.max(
			1e-6,
			effectiveBpmForRow(
				bpm,
				rowIdx,
				baseSyllables,
				customSyllables,
				pulseMeterUnlinked,
				customMultipliers,
				progressiveDensityMode,
				deSyncJatiActive,
				deSyncCycleLength,
			),
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
	lane: number;
	role: MidiExportRole;
	rowIdx: number;
	colIdx: number;
	cellSubdivs: number;
};

function pushNote(
	list: PendingNote[],
	trackIndex: number,
	lane: number,
	role: MidiExportRole,
	rowIdx: number,
	colIdx: number,
	cellSubdivs: number,
	tick: number,
	pitch: number,
	velMidi: number,
	cellTicks: number,
	fixedDurTicks: number,
	humanize: boolean,
	rng: () => number,
): void {
	let t = Math.round(tick);
	if (humanize) {
		t += Math.floor(rng() * 7) - 3;
	}
	const cellTicksInt = Math.max(1, Math.round(cellTicks));
	const durRaw = Math.max(1, Math.round(fixedDurTicks));
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
		lane,
		role,
		rowIdx,
		colIdx,
		cellSubdivs,
	});
}

function trackIndexFor(lane: number, role: 'accent' | 'alt' | 'passive' | 'taHigh'): number {
	const o = role === 'accent' ? 0 : role === 'alt' ? 1 : role === 'passive' ? 2 : 3;
	return lane * 4 + o;
}

function buildPendingNotes(input: MidiExportInput): {
	pending: PendingNote[];
	bpm: number;
	ppq: number;
	laneCount: number;
	laneProfiles: MidiLaneProfile[];
} {
	const bpm = input.bpm;
	const requestedPpq = input.ppq ?? 960;
	const ppq = resolveAdaptivePpq(input, requestedPpq);
	const humanize = input.humanize !== false;
	const seed = input.seed ?? 0x9e3779b9;
	const rng = mulberry32(seed);
	const maxNotes = input.maxNoteEvents ?? 200_000;
	const maxWall = input.maxWallSeconds ?? 48;
	const revolutions = Math.max(1, Math.floor(input.patternRevolutions ?? 1));
	const playbackMode = normalizeSquarePlaybackModeForExport(input.squarePlaybackMode);
	const passiveLayerMuted = input.squarePassiveLayerMuted === true;
	const parsedMixer = normalizeMixerLayerModeForExport(input.mixerLayerMode);
	const parsedTrainer = normalizeTrainerModeForExport(input.trainerMode);
	const hasNewModes = input.mixerLayerMode !== undefined || input.trainerMode !== undefined;
	const bridgedModes = deriveModesFromLegacyExport(playbackMode, passiveLayerMuted, input.dictantMode === true);
	const mixerLayerMode = hasNewModes ? parsedMixer : bridgedModes.mixerLayerMode;
	const trainerMode = hasNewModes ? parsedTrainer : bridgedModes.trainerMode;
	const trainerHoldMute = input.trainerHoldMute === true;
	const muteMode = input.syllableReadMuteMode ?? 'off';
	const dictantActive = trainerMode === 'dictation';

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
	const autoAlignTwoVoice =
		input.polyMode === true && laneCount === 2 && input.twoVoiceAutoAlignByFirstNotes === true;
	const autoAlignMaxBars = Math.max(
		1,
		Math.floor(
			typeof input.twoVoiceAutoAlignMaxBars === 'number' && Number.isFinite(input.twoVoiceAutoAlignMaxBars)
				? input.twoVoiceAutoAlignMaxBars
				: 100,
		),
	);
	const drumDurTicks = Math.max(1, Math.round(ppq / 4)); // 1/16 note
	const masterPreset = typeof input.clickSound === 'string' && input.clickSound.length > 0 ? input.clickSound : 'classic';
	const laneProfiles: MidiLaneProfile[] = Array.from({ length: laneCount }, (_, lane) =>
		lane <= 0 ? 'base' : lane === 1 ? 'contrast' : 'ring',
	);
	const kalamMap: KalamMap = new Map();
	const pending: PendingNote[] = [];
	let noteCount = 0;

	const tryPush = (
		lane: number,
		role: MidiExportRole,
		baseTick: number,
		cellTicks: number,
		rowMultiplier: number,
		rowIdx: number,
		colIdx: number,
		cellSubdivs: number,
		headSyl: string,
		mainAccent: boolean,
		shouldPlayFirstBeatTa: boolean,
	) => {
		if (noteCount >= maxNotes) return;
		const pitch = resolveMidiNoteForProfileRole(laneProfiles[lane] ?? 'base', role);
		const velBase = computeVelocity(role, colIdx, mainAccent, shouldPlayFirstBeatTa, headSyl, humanize, rng);
		const laneIdx = (lane <= 0 ? 0 : lane === 1 ? 1 : 2) as 0 | 1 | 2;
		const roleGain =
			role === 'accent' || role === 'taHigh'
				? input.laneRoleGains?.[laneIdx]?.accent
				: role === 'alt'
					? input.laneRoleGains?.[laneIdx]?.alt
					: input.laneRoleGains?.[laneIdx]?.passive;
		const gain = Number.isFinite(roleGain as number) ? Math.max(0, roleGain as number) : 1;
		const vel = Math.max(1, Math.min(127, Math.round(velBase * gain)));
		// Keep note lengths proportional to bar-speed multipliers (x2/x3/x4 => shorter notes).
		const scaledDurTicks = Math.max(1, Math.round(drumDurTicks / Math.max(1, rowMultiplier)));
		pushNote(
			pending,
			trackIndexFor(lane, role),
			lane,
			role,
			rowIdx,
			colIdx,
			cellSubdivs,
			baseTick,
			pitch,
			vel,
			cellTicks,
			scaledDurTicks,
			humanize,
			rng,
		);
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
		// Poly export sync policy: both lanes receive first-beat Ta at timeline start
		// when firstBeat is enabled for the lane (legacy parity requested by user).
		const firstBeatPolicy: FirstBeatHitPolicy = 'legacy';
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
			mixerLayerMode,
			trainerMode,
			muteMode,
			dictantActive,
			trainerHoldMute,
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
		const shouldPlayFirstBeatTa = colIdx === 0 && firstBeatCellHitRow && (subdivs > 1 || 0 === 0);
		const mainAccent = isAccent;
		const rowMultiplier = Math.max(1, Math.min(4, Math.floor(mult[rowIdx] ?? 1)));
		const cellTicks = ticksPerCellFromRow(
			bpm,
			rowIdx,
			input.baseSyllables,
			input.customSyllables,
			pulseU,
			mult,
			ppq,
			input.progressiveDensityMode,
			input.deSyncJatiActive,
			input.deSyncCycleLength,
		);
		const rowEffBpm = effectiveBpmForRow(
			bpm,
			rowIdx,
			input.baseSyllables,
			input.customSyllables,
			pulseU,
			mult,
			input.progressiveDensityMode,
			input.deSyncJatiActive,
			input.deSyncCycleLength,
		);
		const headSyl = headSyllableForCell(
			rowSyl,
			input.customSubdivisions,
			rowIdx,
			colIdx,
			bpm,
			rowEffBpm,
			kalamMap,
			input.rowRuntimeContexts?.[rowIdx],
		);
		const baseTick = wallSecToTick(wallSec, bpm, ppq);
		const subCount = Math.max(1, Math.floor(subdivs));
		const subCellTicks = cellTicks / subCount;
		if (hits.taHigh) tryPush(lane, 'taHigh', baseTick, subCellTicks, rowMultiplier, rowIdx, colIdx, subdivs, headSyl, mainAccent, shouldPlayFirstBeatTa);
		if (hits.accent) tryPush(lane, 'accent', baseTick, subCellTicks, rowMultiplier, rowIdx, colIdx, subdivs, headSyl, mainAccent, shouldPlayFirstBeatTa);
		if (hits.altShadow) {
			for (let subIdx = 0; subIdx < subCount; subIdx++) {
				const subTick = baseTick + subIdx * subCellTicks;
				tryPush(
					lane,
					'alt',
					subTick,
					subCellTicks,
					rowMultiplier,
					rowIdx,
					colIdx,
					subdivs,
					headSyl,
					mainAccent,
					shouldPlayFirstBeatTa,
				);
			}
		}
		if (hits.passive) {
			for (let subIdx = 0; subIdx < subCount; subIdx++) {
				const subTick = baseTick + subIdx * subCellTicks;
				tryPush(
					lane,
					'passive',
					subTick,
					subCellTicks,
					rowMultiplier,
					rowIdx,
					colIdx,
					subdivs,
					headSyl,
					mainAccent,
					shouldPlayFirstBeatTa,
				);
			}
		} else if (subCount > 1 && (hits.taHigh || hits.accent || hits.altShadow)) {
			// Keep DIVS audible on accented/alt cells: inner subdivisions are emitted as passive tails.
			for (let subIdx = 1; subIdx < subCount; subIdx++) {
				const subTick = baseTick + subIdx * subCellTicks;
				tryPush(
					lane,
					'passive',
					subTick,
					subCellTicks,
					rowMultiplier,
					rowIdx,
					colIdx,
					subdivs,
					headSyl,
					mainAccent,
					shouldPlayFirstBeatTa,
				);
			}
		}
	};

	if (!input.polyMode) {
		const polyClickSlots = new Set<string>();
		const seq = buildLegacyPlaybackSequence(input.bars, input.customSyllables, input.baseSyllables, deadMap);
		let wall = 0;
		for (let rev = 0; rev < revolutions; rev++) {
			for (const step of seq) {
				if (wall > maxWall) break;
				emitCell(step.r, step.c, 0, wall, false, 0, polyClickSlots);
				wall +=
					60 /
					Math.max(
						1e-6,
						effectiveBpmForRow(
							bpm,
							step.r,
							input.baseSyllables,
							input.customSyllables,
							pulseU,
							mult,
							input.progressiveDensityMode,
							input.deSyncJatiActive,
							input.deSyncCycleLength,
						),
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
				s += getBarTimeWindowSeconds(
					b,
					input.baseSyllables,
					input.customSyllables,
					pulseU,
					mult,
					input.progressiveDensityMode,
					input.deSyncJatiActive,
					input.deSyncCycleLength,
					bpm,
				);
			}
			return s;
		});
		const slowest = Math.max(1e-6, ...lanePatternSec);
		const horizon = Math.min(maxWall, slowest * revolutions);
		const polyClickSlots = new Set<string>();
		const laneFirstBar = lanes.map((L) => (L.barIndices.length > 0 ? L.barIndices[0]! : -1));
		const laneFirstStartTick: Array<number | null> = Array.from({ length: laneCount }, () => null);
		const laneLastStartTick: Array<number | null> = Array.from({ length: laneCount }, () => null);
		const laneRepeatedCycles: number[] = Array.from({ length: laneCount }, () => 0);
		let crossedBars = 0;
		let autoAlignDone = false;
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
			if (best === null) break;
			if (!autoAlignTwoVoice && bestT > horizon) break;
			const bar = best.barIndices[best.barCursor]!;
			const rowSyl = getRowSyl(bar, input.baseSyllables, input.customSyllables);
			const dBar =
				getBarTimeWindowSeconds(
					bar,
					input.baseSyllables,
					input.customSyllables,
					pulseU,
					mult,
					input.progressiveDensityMode,
					input.deSyncJatiActive,
					input.deSyncCycleLength,
					bpm,
				) / Math.max(1, rowSyl);
			const deadStart = deadMap[bar]?.deadStart;
			const currentCell = best.cellCursor;
			const laneId = best.laneId;
			const isLaneStartAnchor = currentCell === 0 && bar === laneFirstBar[laneId];
			if (autoAlignTwoVoice && isLaneStartAnchor) {
				const startTick = Math.round(wallSecToTick(bestT, bpm, ppq));
				const first = laneFirstStartTick[laneId];
				if (first === null) {
					laneFirstStartTick[laneId] = startTick;
				} else if (startTick > first) {
					laneRepeatedCycles[laneId] = laneRepeatedCycles[laneId]! + 1;
				}
				laneLastStartTick[laneId] = startTick;
			}
			const rowFullyDead = typeof deadStart === 'number' && deadStart <= 0;
			if (!rowFullyDead) {
				emitCell(bar, currentCell, best.laneId, bestT, true, best.laneId, polyClickSlots);
			}
			if (rowFullyDead) {
				crossedBars += 1;
				best.barCursor = (best.barCursor + 1) % best.barIndices.length;
				best.cellCursor = 0;
				// Keep Grid policy: fully-dead bar still consumes full bar physical time.
				best.nextWall += rowSyl * dBar;
				continue;
			}
			const { nextC, advanceBar } = advancePolyLaneAfterEmit(currentCell, rowSyl, deadStart);
			const laneHeadSingleLiveHold =
				best.barCursor === 0 &&
				currentCell === 0 &&
				typeof deadStart === 'number' &&
				deadStart === 1 &&
				rowSyl >= 2;
			const nextCWithHeadHold = laneHeadSingleLiveHold ? 1 : nextC;
			const advanceLaneBar =
				!laneHeadSingleLiveHold && (advanceBar || (!advanceBar && nextCWithHeadHold === 0));
			if (advanceLaneBar) {
				crossedBars += 1;
				best.barCursor = (best.barCursor + 1) % best.barIndices.length;
				best.cellCursor = 0;
			} else {
				best.cellCursor = nextCWithHeadHold;
			}
			const isLastLiveCell =
				typeof deadStart === 'number' &&
				deadStart > 0 &&
				currentCell === deadStart - 1;
			const stepDelta =
				isLastLiveCell
					? (1 + Math.max(0, rowSyl - deadStart)) * dBar
					: dBar;
			best.nextWall += stepDelta;
			if (autoAlignTwoVoice) {
				const lane0Tick = laneLastStartTick[0];
				const lane1Tick = laneLastStartTick[1];
				const bothRepeated = laneRepeatedCycles[0]! >= 1 && laneRepeatedCycles[1]! >= 1;
				if (bothRepeated && lane0Tick !== null && lane1Tick !== null && lane0Tick === lane1Tick) {
					autoAlignDone = true;
				}
				if (autoAlignDone || crossedBars >= autoAlignMaxBars) break;
			}
			if (noteCount >= maxNotes) break;
		}
	}
	pending.sort((a, b) => a.tick - b.tick || a.trackIndex - b.trackIndex);
	return { pending, bpm, ppq, laneCount, laneProfiles };
}

export type MidiParityEvent = {
	index: number;
	layer: string;
	lane: number;
	role: MidiExportRole;
	row: number;
	cell: number;
	cellSubdivs: number;
	startTick: number;
	durationTicks: number;
	startMs: number;
	durationMs: number;
	note: number;
	velocity: number;
};

export function buildMidiParityEvents(input: MidiExportInput): {
	bpm: number;
	ppq: number;
	events: MidiParityEvent[];
} {
	const { pending, bpm, ppq, laneCount } = buildPendingNotes(input);
	const labels = ['Accent', 'Alt', 'Passive', 'TaHigh'] as const;
	const ticksToMs = (ticks: number): number => (ticks * 60000) / Math.max(1e-6, bpm * ppq);
	const events: MidiParityEvent[] = pending.map((n, i) => {
		const roleIdx = n.trackIndex % 4;
		const lanePrefix = laneCount > 1 ? `V${n.lane + 1}-` : '';
		return {
			index: i + 1,
			layer: `${lanePrefix}${labels[roleIdx]}`,
			lane: n.lane + 1,
			role: n.role,
			row: n.rowIdx + 1,
			cell: n.colIdx + 1,
			cellSubdivs: n.cellSubdivs,
			startTick: n.tick,
			durationTicks: n.durationTicks,
			startMs: Number(ticksToMs(n.tick).toFixed(3)),
			durationMs: Number(ticksToMs(n.durationTicks).toFixed(3)),
			note: n.pitch,
			velocity: n.velocity,
		};
	});
	return { bpm, ppq, events };
}

export function generateMidi(input: MidiExportInput): Uint8Array {
	const { pending, bpm, ppq, laneCount, laneProfiles } = buildPendingNotes(input);
	if (laneCount === 1) {
		// Legacy compatibility mode (reference-aligned):
		// - single track (type-0 writer output)
		// - 480 TPB timeline with 1-bar lead-in offset
		// - 3 instrument voices only: Accent/Alt/Passive (TaHigh merged into Accent)
		const LEGACY_TPB = 480;
		const LEGACY_TICK_OFFSET = 3840;
		const roleOrder = (r: MidiExportRole): number =>
			r === 'accent' ? 0 : r === 'passive' ? 1 : r === 'alt' ? 2 : 3;
		const laneProfile = laneProfiles[0] ?? 'base';
		const tr = new MidiWriter.Track();
		tr.addTrackName('Tempo');
		tr.setTempo(bpm, LEGACY_TICK_OFFSET);
		// Keep role-channel CC pan events (historical compatibility: 3 identical CC10 at start tick).
		for (let i = 0; i < 3; i++) {
			tr.addEvent(
				new MidiWriter.ControllerChangeEvent({
					controllerNumber: 10,
					controllerValue: lanePanCc10(laneProfile),
					channel: DRUM_CHANNEL,
					tick: LEGACY_TICK_OFFSET,
				}),
			);
		}
		const norm = pending
			.map((n) => ({
				...n,
				role: n.role === 'taHigh' ? 'accent' : n.role,
				pitch: n.role === 'taHigh' ? MIDI_V1_ACCENT_NOTE : n.pitch,
				tick: LEGACY_TICK_OFFSET + Math.max(0, Math.floor(n.tick / 2)),
				durationTicks: Math.max(1, Math.floor(n.durationTicks / 2)),
			}))
			.filter((n) => n.role === 'accent' || n.role === 'alt' || n.role === 'passive')
			.sort((a, b) => (a.tick - b.tick) || (roleOrder(a.role) - roleOrder(b.role)));
		const seen = new Set<string>();
		for (const n of norm) {
			const dedupeKey = `${n.tick}:${n.pitch}:${n.durationTicks}:${n.role}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
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
		const writer = new MidiWriter.Writer([tr], { ticksPerBeat: LEGACY_TPB });
		return writer.buildFile();
	}

	const labels = ['Accent', 'Alt', 'Passive', 'TaHigh'] as const;
	const normalizeTrackIndex = (trackIndex: number): number => {
		// Legacy export keeps only 3 tracks: Accent/Alt/Passive.
		// TaHigh events are merged into Accent track.
		if (laneCount === 1 && trackIndex === 3) return 0;
		// Poly export: one instrument track per lane.
		if (laneCount > 1) return Math.floor(trackIndex / 4);
		return trackIndex;
	};
	const usedTrackIndices = Array.from(new Set(pending.map((n) => normalizeTrackIndex(n.trackIndex)))).sort((a, b) => a - b);
	const trackIndexToDense = new Map<number, number>();
	const denseToLane: number[] = [];
	const drumTracks: InstanceType<typeof MidiWriter.Track>[] = [];
	for (let dense = 0; dense < usedTrackIndices.length; dense++) {
		const rawTrackIdx = usedTrackIndices[dense];
		trackIndexToDense.set(rawTrackIdx, dense);
		const lane = rawTrackIdx;
		const t = new MidiWriter.Track();
		const prefix = laneCount > 1 ? `V${lane + 1}` : 'Tempo';
		t.addTrackName(prefix);
		denseToLane[dense] = lane;
		const laneProfile = laneProfiles[lane] ?? 'base';
		t.addEvent(
			new MidiWriter.ControllerChangeEvent({
				controllerNumber: 10,
				controllerValue: lanePanCc10(laneProfile),
				channel: DRUM_CHANNEL,
				tick: 0,
			}),
		);
		drumTracks.push(t);
	}
	if (laneCount > 1) {
		for (let dense = 0; dense < drumTracks.length; dense++) {
			const lane = denseToLane[dense] ?? dense;
			const hasTaAtStart = pending.some((n) => n.lane === lane && n.role === 'taHigh' && n.tick === 0);
			if (!hasTaAtStart) continue;
			const laneProfile = laneProfiles[lane] ?? 'base';
			drumTracks[dense]!.addEvent(
				new MidiWriter.NoteEvent({
					pitch: resolveMidiNoteForProfileRole(laneProfile, 'accent'),
					startTick: 0,
					duration: `T${Math.max(1, Math.round(ppq / 4))}`,
					velocity: toWriterVelocity(108),
					channel: DRUM_CHANNEL,
				}),
			);
		}
	}
	if (drumTracks.length > 0) {
		drumTracks[0].setTempo(bpm, 0);
	} else {
		const t = new MidiWriter.Track();
		t.addTrackName('Tempo');
		t.setTempo(bpm, 0);
		drumTracks.push(t);
	}

	for (const n of pending) {
		const denseIdx = trackIndexToDense.get(normalizeTrackIndex(n.trackIndex));
		if (denseIdx === undefined) continue;
		const tr = drumTracks[denseIdx];
		if (!tr) continue;
		const laneProfile = laneProfiles[n.lane] ?? 'base';
		const outPitch =
			laneCount > 1 && n.role === 'taHigh'
				? resolveMidiNoteForProfileRole(laneProfile, 'accent')
				: n.pitch;
		tr.addEvent(
			new MidiWriter.NoteEvent({
				pitch: outPitch,
				startTick: n.tick,
				duration: `T${n.durationTicks}`,
				velocity: n.velocity,
				channel: DRUM_CHANNEL,
			}),
		);
	}

	const writer = new MidiWriter.Writer(drumTracks, { ticksPerBeat: ppq });
	return writer.buildFile();
}

export function generateMidiBlob(input: MidiExportInput): Blob {
	return new Blob([generateMidi(input)], { type: 'audio/midi' });
}
