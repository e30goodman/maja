/**
 * Export current grid to MIDI.
 * - single-voice mode keeps GM drum channel 10 for legacy compatibility
 * - poly mode uses dedicated per-voice channels so DAW import does not collapse voices into one instrument
 * Semantics: `full_mix` baseline; parity with gating in App.tsx (emitGridSubAudio / classifyGridCellHits).
 */

import MidiWriter from 'midi-writer-js';
import {
	findGroupForBar,
	FUSED_BAR_GROUPS_ENABLED,
	getBarRepriseCountForBar,
	getFusedBarTimeWindowSeconds,
	isFusedGroupFirstBeatCell,
	getFusedCellDurationSeconds,
	getGroupMultiplier,
	getGroupPulseSyllables,
	isRowPulseUnlinkedEffective,
	normalizeBarMultiplier,
	type FusedGroupState,
	type FusedTimingContext,
	type BarRepriseCounts,
} from './fusedBarGroups';
import { buildLegacyPlaybackSequence, type DeadCellsMap } from './randomLogic';
import { advancePolyLaneAfterEmit, buildLaneBarIndices, type PolyVoicesCount } from './polySubLegacyScheduler';
import { buildRowCellSyllableLabels, type KalamMap, type RowRuntimeContext } from './sequencerLabels';
import { resolveEffectiveStepMask, type CellStepMasks } from './stepMask';

const LEGACY_TICK_OFFSET = 3840;

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
export const MIDI_V3_ACCENT_NOTE = 29; // F1
export const MIDI_V3_ALT_NOTE = 53; // F3 (Ride Bell, GM)
export const MIDI_V3_PASSIVE_NOTE = 76; // E5 (Hi Wood Block, GM)
export const MIDI_V3_TA_HIGH_NOTE = 57; // A2 (Crash Cymbal 2)

const DRUM_CHANNEL = 10;
const POLY_VOICE_CHANNELS = [1, 2, 3] as const;
const midiChannelForLane = (lane: number, laneCount: number): number => {
	if (laneCount <= 1) return DRUM_CHANNEL;
	if (lane >= 0 && lane < POLY_VOICE_CHANNELS.length) return POLY_VOICE_CHANNELS[lane]!;
	return POLY_VOICE_CHANNELS[POLY_VOICE_CHANNELS.length - 1]!;
};

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
	cellStepMasks?: CellStepMasks;
	pulseMeterUnlinked?: Record<number, boolean>;
	customMultipliers?: Record<number, number>;
	barRepriseCounts?: BarRepriseCounts;
	fusedBarGroups?: FusedGroupState[];
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
	cellStepMasks?: CellStepMasks,
): string {
	const labels = buildRowCellSyllableLabels(rowSyllCount, customSubdivs, rowIdx, {
		bpm: baseBpm,
		rowRuntimeContext: { ...(rowRuntimeContext ?? {}), effectiveBpm },
		kalamMap,
		cellStepMasks,
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
	fusedBarGroups: FusedGroupState[] = [],
): number {
	const group = findGroupForBar(fusedBarGroups, rowIdx);
	if (group) {
		const pulseSyl = getGroupPulseSyllables(
			group,
			customSyllables,
			baseSyllables,
			pulseMeterUnlinked ?? {},
		);
		const mult = getGroupMultiplier(group, customMultipliers ?? {});
		return bpm * (pulseSyl / 4) * mult;
	}
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
			: isRowPulseUnlinkedEffective(pulseMeterUnlinked, rowIdx)
				? rowSyllables
				: baseSyllables;
	const mult = normalizeBarMultiplier(customMultipliers?.[rowIdx]);
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
	fusedBarGroups: FusedGroupState[] = [],
	deadCells: DeadCellsMap = {},
): number {
	const group = findGroupForBar(fusedBarGroups, rowIdx);
	if (group) {
		const dSec = getFusedCellDurationSeconds(
			group,
			customSyllables,
			baseSyllables,
			pulseMeterUnlinked ?? {},
			customMultipliers ?? {},
			bpm,
			deadCells,
		);
		return wallSecToTick(dSec, bpm, ppq);
	}
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
		fusedBarGroups,
	);
	if (!Number.isFinite(eff) || eff <= 0) return ppq;
	return (ppq * bpm) / eff;
}

function resolveAdaptivePpq(input: MidiExportInput, requestedPpq: number): number {
	const targetMinCellTicks = 96;
	let minCellTicks = Infinity;
	const bars = Math.max(0, Math.floor(input.bars));
	const fused = input.fusedBarGroups ?? [];
	const deadMap = toDeadCellsMap(input.deadCells);
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
			fused,
			deadMap,
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
	suppressWhiteFrameSound?: boolean;
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
		suppressWhiteFrameSound,
	} = args;
	const layerMuted = trainerHoldMute === true;
	const suppressWhite = suppressWhiteFrameSound === true;

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
		!suppressWhite && colIdx === 0 && firstBeatCellHitRow && (subdivs > 1 || sub === 0);
	const isTaDingCell = !suppressWhite && colIdx >= 1 && taDingKeys.has(`${rowIdx}-${colIdx}`);
	const shouldPlayTaDingSound = isTaDingCell && (subdivs > 1 || sub === 0);
	const hasTaDingHere = !suppressWhite && taDingKeys.has(`${rowIdx}-${colIdx}`);

	const isTaFirstBeatArticulation =
		!suppressWhite && colIdx === 0 && firstBeatCellHitRow && (subdivs > 1 || sub === 0);
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

function getPeerBarTimeWindowSeconds(
	rowIdx: number,
	baseSyllables: number,
	customSyllables: Record<number, number>,
	pulseMeterUnlinked: Record<number, boolean> | undefined,
	customMultipliers: Record<number, number> | undefined,
	progressiveDensityMode: 'gati_mode' | 'jati_mode' | undefined,
	deSyncJatiActive: boolean | undefined,
	deSyncCycleLength: number | undefined,
	bpm: number,
	fusedBarGroups: FusedGroupState[] = [],
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
				fusedBarGroups,
			),
		);
	const rowSyl = getRowSyl(rowIdx, baseSyllables, customSyllables);
	return noteDur * Math.max(1, rowSyl);
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
	fusedBarGroups: FusedGroupState[] = [],
	deadCells: DeadCellsMap = {},
	polyMode = false,
	polyVoices: 2 | 3 = 2,
	barCount = 0,
): number {
	const group = findGroupForBar(fusedBarGroups, rowIdx);
	const fusedCtx = polyMode
		? {
				polyMode: true as const,
				polyVoices,
				barCount,
				getPeerBarWindowSeconds: (bar: number) =>
					getPeerBarTimeWindowSeconds(
						bar,
						baseSyllables,
						customSyllables,
						pulseMeterUnlinked,
						customMultipliers,
						progressiveDensityMode,
						deSyncJatiActive,
						deSyncCycleLength,
						bpm,
						fusedBarGroups,
					),
			}
		: undefined;
	if (group) {
		return getFusedBarTimeWindowSeconds(
			group,
			customSyllables,
			baseSyllables,
			pulseMeterUnlinked ?? {},
			customMultipliers ?? {},
			bpm,
			fusedCtx,
		);
	}
	return getPeerBarTimeWindowSeconds(
		rowIdx,
		baseSyllables,
		customSyllables,
		pulseMeterUnlinked,
		customMultipliers,
		progressiveDensityMode,
		deSyncJatiActive,
		deSyncCycleLength,
		bpm,
		fusedBarGroups,
	);
}

/** Bar reprise count (default x2); independent from speed multiplier. */
function getBarRepeatCountForExport(
	bar: number,
	barRepriseCounts: BarRepriseCounts | undefined,
	fusedBarGroups: FusedGroupState[] = [],
): number {
	const group = findGroupForBar(fusedBarGroups, bar);
	return getBarRepriseCountForBar(bar, barRepriseCounts ?? {}, group);
}

function getStepDurationSecondsForExport(
	bar: number,
	baseSyllables: number,
	customSyllables: Record<number, number>,
	pulseMeterUnlinked: Record<number, boolean> | undefined,
	customMultipliers: Record<number, number> | undefined,
	progressiveDensityMode: 'gati_mode' | 'jati_mode' | undefined,
	deSyncJatiActive: boolean | undefined,
	deSyncCycleLength: number | undefined,
	bpm: number,
	fusedBarGroups: FusedGroupState[],
	deadCells: DeadCellsMap,
	polyMode = false,
	polyVoices: 2 | 3 = 2,
	barCount = 0,
): number {
	const group = findGroupForBar(fusedBarGroups, bar);
	const fusedCtx = polyMode
		? {
				polyMode: true as const,
				polyVoices,
				barCount,
				getPeerBarWindowSeconds: (peerBar: number) =>
					getPeerBarTimeWindowSeconds(
						peerBar,
						baseSyllables,
						customSyllables,
						pulseMeterUnlinked,
						customMultipliers,
						progressiveDensityMode,
						deSyncJatiActive,
						deSyncCycleLength,
						bpm,
						fusedBarGroups,
					),
			}
		: undefined;
	if (group) {
		return getFusedCellDurationSeconds(
			group,
			customSyllables,
			baseSyllables,
			pulseMeterUnlinked ?? {},
			customMultipliers ?? {},
			bpm,
			deadCells,
			fusedCtx,
		);
	}
	const rowSyl = getRowSyl(bar, baseSyllables, customSyllables);
	return (
		getBarTimeWindowSeconds(
			bar,
			baseSyllables,
			customSyllables,
			pulseMeterUnlinked,
			customMultipliers,
			progressiveDensityMode,
			deSyncJatiActive,
			deSyncCycleLength,
			bpm,
			fusedBarGroups,
			deadCells,
			polyMode,
			polyVoices,
			barCount,
		) / Math.max(1, rowSyl)
	);
}

function lanePatternSeconds(
	barIndices: number[],
	input: MidiExportInput,
	pulseU: Record<number, boolean>,
	mult: Record<number, number>,
	bpm: number,
	deadMap: DeadCellsMap,
	polyVoices: 2 | 3,
	barCount: number,
): number {
	const fused = input.fusedBarGroups ?? [];
	let s = 0;
	for (let i = 0; i < barIndices.length; i++) {
		const b = barIndices[i]!;
		const g = findGroupForBar(fused, b);
		if (g && b !== g.bars[0]) continue;
		const windowSec = getBarTimeWindowSeconds(
			b,
			input.baseSyllables,
			input.customSyllables,
			pulseU,
			mult,
			input.progressiveDensityMode,
			input.deSyncJatiActive,
			input.deSyncCycleLength,
			bpm,
			fused,
			deadMap,
			true,
			polyVoices,
			barCount,
		);
		s += windowSec * getBarRepeatCountForExport(b, input.barRepriseCounts, fused);
	}
	return s;
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
	// Force robot-straight timing/velocity for deterministic export.
	const humanize = false;
	const seed = input.seed ?? 0x9e3779b9;
	const rng = mulberry32(seed);
	const maxNotes = input.maxNoteEvents ?? 200_000;
	const maxWallBase = input.maxWallSeconds ?? 48;
	const barsSafetyWall = Math.max(1, Math.floor(input.bars ?? 1)) * 8;
	const maxWall = Math.max(maxWallBase, barsSafetyWall);
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
	const fusedBarGroups = FUSED_BAR_GROUPS_ENABLED ? (input.fusedBarGroups ?? []) : [];

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
		// Keep note lengths proportional to bar-speed multipliers (x2/x4 => shorter notes).
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
		repeatIndex = 0,
	) => {
		void repeatIndex;
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
		const fused = input.fusedBarGroups ?? [];
		const isMegaBarDownbeat =
			colIdx === 0 && isFusedGroupFirstBeatCell(fused, rowIdx, colIdx);
		const firstBeatCellHitRow = isMegaBarDownbeat
			? resolveFirstBeatHitRow(
					firstBeatPolicy,
					on0Accent,
					on0Ding,
					rowFirstBeat,
					suppressed.has(rowIdx),
				)
			: false;
		const shouldPlayFirstBeatTa =
			isMegaBarDownbeat && firstBeatCellHitRow && (subdivs > 1 || 0 === 0);
		const mainAccent = isAccent;
		const rowMultiplier = normalizeBarMultiplier(mult[rowIdx]);
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
			fusedBarGroups,
			deadMap,
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
			fusedBarGroups,
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
			input.cellStepMasks,
		);
		const baseTick = wallSecToTick(wallSec, bpm, ppq);
		const subCount = Math.max(1, Math.floor(subdivs));
		const subCellTicks = cellTicks / subCount;
		const stepMask = resolveEffectiveStepMask(`${rowIdx}-${colIdx}`, subdivs, input.cellStepMasks);
		if (stepMask[0] !== false && hits.taHigh) {
			tryPush(lane, 'taHigh', baseTick, subCellTicks, rowMultiplier, rowIdx, colIdx, subdivs, headSyl, mainAccent, shouldPlayFirstBeatTa);
		}
		if (stepMask[0] !== false && hits.accent) {
			tryPush(lane, 'accent', baseTick, subCellTicks, rowMultiplier, rowIdx, colIdx, subdivs, headSyl, mainAccent, shouldPlayFirstBeatTa);
		}
		if (hits.altShadow) {
			for (let subIdx = 0; subIdx < subCount; subIdx++) {
				if (stepMask[subIdx] === false) continue;
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
				if (stepMask[subIdx] === false) continue;
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
				if (stepMask[subIdx] === false) continue;
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
		const seq = buildLegacyPlaybackSequence(
			input.bars,
			input.customSyllables,
			input.baseSyllables,
			deadMap,
			undefined,
			input.customSubdivisions,
			input.cellStepMasks,
			mult,
			input.barRepriseCounts,
		);
		let wall = 0;
		for (let rev = 0; rev < revolutions; rev++) {
			for (const step of seq) {
				if (wall > maxWall) break;
				emitCell(step.r, step.c, 0, wall, false, 0, polyClickSlots, step.repeatIndex ?? 0);
				wall += getStepDurationSecondsForExport(
					step.r,
					input.baseSyllables,
					input.customSyllables,
					pulseU,
					mult,
					input.progressiveDensityMode,
					input.deSyncJatiActive,
					input.deSyncCycleLength,
					bpm,
					fusedBarGroups,
					deadMap,
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
			barRepeatCursor: number;
			nextWall: number;
		};
		const lanes: Lane[] = laneBarIdx.map((barIndices, laneId) => ({
			laneId,
			barIndices,
			barCursor: 0,
			cellCursor: 0,
			barRepeatCursor: 0,
			nextWall: 0,
		}));
		const lanePatternSec = lanes.map((L) =>
			lanePatternSeconds(L.barIndices, input, pulseU, mult, bpm, deadMap, V, barCount),
		);
		const slowest = Math.max(1e-6, ...lanePatternSec);
		let totalGridSec = 0;
		for (let b = 0; b < barCount; b++) {
			const g = findGroupForBar(fusedBarGroups, b);
			if (g && b !== g.bars[0]) continue;
			const windowSec = getBarTimeWindowSeconds(
				b,
				input.baseSyllables,
				input.customSyllables,
				pulseU,
				mult,
				input.progressiveDensityMode,
				input.deSyncJatiActive,
				input.deSyncCycleLength,
				bpm,
				fusedBarGroups,
				deadMap,
				true,
				V,
				barCount,
			);
			totalGridSec += windowSec * getBarRepeatCountForExport(b, input.barRepriseCounts, fusedBarGroups);
		}
		const horizon = Math.min(maxWall, Math.max(slowest, totalGridSec * revolutions));
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
			const dBar = getStepDurationSecondsForExport(
				bar,
				input.baseSyllables,
				input.customSyllables,
				pulseU,
				mult,
				input.progressiveDensityMode,
				input.deSyncJatiActive,
				input.deSyncCycleLength,
				bpm,
				fusedBarGroups,
				deadMap,
				true,
				V,
				barCount,
			);
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
				emitCell(bar, currentCell, best.laneId, bestT, true, best.laneId, polyClickSlots, best.barRepeatCursor);
			}
			if (rowFullyDead) {
				crossedBars += 1;
				best.barCursor = (best.barCursor + 1) % best.barIndices.length;
				best.cellCursor = 0;
				best.barRepeatCursor = 0;
				// Truncation policy: fully-dead bar consumes zero physical time.
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
				const prevBar = bar;
				const prevCursor = best.barCursor;
				const nextCursor = (best.barCursor + 1) % best.barIndices.length;
				const nextBar = best.barIndices[nextCursor]!;
				const sameFused = Boolean(findGroupForBar(fusedBarGroups, prevBar)?.bars.includes(nextBar));
				const repeats = getBarRepeatCountForExport(prevBar, input.barRepriseCounts, fusedBarGroups);
				if (!sameFused && best.barRepeatCursor + 1 < repeats) {
					best.barRepeatCursor += 1;
					const fusedGroup = findGroupForBar(fusedBarGroups, prevBar);
					const repeatStartBar = fusedGroup?.bars[0] ?? prevBar;
					const repeatStartCursor = best.barIndices.indexOf(repeatStartBar);
					best.barCursor = repeatStartCursor >= 0 ? repeatStartCursor : prevCursor;
					best.cellCursor = 0;
					best.nextWall += dBar;
					continue;
				}
				crossedBars += 1;
				best.barCursor = nextCursor;
				best.cellCursor = 0;
				if (!sameFused) best.barRepeatCursor = 0;
			} else {
				best.cellCursor = nextCWithHeadHold;
			}
			if (!autoAlignTwoVoice && crossedBars >= Math.max(1, barCount * revolutions)) break;
			// Truncation policy: one emitted cell always advances by one cell duration.
			best.nextWall += dBar;
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

export type MidiWriterNoteTuple = {
	trackIndex: number;
	lane: number;
	role: MidiExportRole;
	tick: number;
	note: number;
	velocity: number;
	durationTicks: number;
};

export function buildMidiWriterNoteTuples(input: MidiExportInput): {
	bpm: number;
	ppq: number;
	laneCount: number;
	trackLaneByIndex: number[];
	notes: MidiWriterNoteTuple[];
} {
	const { pending, bpm, ppq, laneCount, laneProfiles } = buildPendingNotes(input);
	if (laneCount === 1) {
		const roleOrder = (r: MidiExportRole): number =>
			r === 'accent' ? 0 : r === 'passive' ? 1 : r === 'alt' ? 2 : 3;
		const norm = pending
			.map((n) => ({
				...n,
				role: n.role === 'taHigh' ? ('accent' as MidiExportRole) : n.role,
				pitch: n.role === 'taHigh' ? MIDI_V1_ACCENT_NOTE : n.pitch,
				tick: LEGACY_TICK_OFFSET + Math.max(0, Math.floor(n.tick / 2)),
				durationTicks: Math.max(1, Math.floor(n.durationTicks / 2)),
			}))
			.filter((n) => n.role === 'accent' || n.role === 'alt' || n.role === 'passive')
			.sort((a, b) => (a.tick - b.tick) || (roleOrder(a.role) - roleOrder(b.role)));
		const seen = new Set<string>();
		const notes: MidiWriterNoteTuple[] = [];
		for (const n of norm) {
			const dedupeKey = `${n.tick}:${n.pitch}:${n.durationTicks}:${n.role}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
			notes.push({
				trackIndex: 0,
				lane: 0,
				role: n.role,
				tick: n.tick,
				note: n.pitch,
				velocity: n.velocity,
				durationTicks: n.durationTicks,
			});
		}
		return { bpm, ppq: 480, laneCount, trackLaneByIndex: [0], notes };
	}
	const normalizeTrackIndex = (trackIndex: number): number => {
		if (laneCount === 1 && trackIndex === 3) return 0;
		if (laneCount > 1) return Math.floor(trackIndex / 4);
		return trackIndex;
	};
	const usedTrackIndices = Array.from(new Set(pending.map((n) => normalizeTrackIndex(n.trackIndex)))).sort((a, b) => a - b);
	const trackIndexToDense = new Map<number, number>();
	const denseToLane: number[] = [];
	for (let dense = 0; dense < usedTrackIndices.length; dense++) {
		const rawTrackIdx = usedTrackIndices[dense];
		trackIndexToDense.set(rawTrackIdx, dense);
		denseToLane[dense] = rawTrackIdx;
	}
	const notes: MidiWriterNoteTuple[] = [];
	if (laneCount > 1) {
		for (let dense = 0; dense < usedTrackIndices.length; dense++) {
			const lane = denseToLane[dense] ?? dense;
			const hasTaAtStart = pending.some((n) => n.lane === lane && n.role === 'taHigh' && n.tick === 0);
			if (!hasTaAtStart) continue;
			const laneProfile = laneProfiles[lane] ?? 'base';
			notes.push({
				trackIndex: dense,
				lane,
				role: 'accent',
				tick: lane > 0 ? Math.max(1, Math.round(ppq / 4)) : 0,
				note: resolveMidiNoteForProfileRole(laneProfile, 'accent'),
				velocity: toWriterVelocity(108),
				durationTicks: Math.max(1, Math.round(ppq / 4)),
			});
		}
	}
	for (const n of pending) {
		const denseIdx = trackIndexToDense.get(normalizeTrackIndex(n.trackIndex));
		if (denseIdx === undefined) continue;
		const laneProfile = laneProfiles[n.lane] ?? 'base';
		const outPitch =
			laneCount > 1 && n.role === 'taHigh'
				? resolveMidiNoteForProfileRole(laneProfile, 'accent')
				: n.pitch;
		notes.push({
			trackIndex: denseIdx,
			lane: n.lane,
			role: n.role,
			tick: n.tick,
			note: outPitch,
			velocity: n.velocity,
			durationTicks: n.durationTicks,
		});
	}
	let notesOut = [...notes];
	if (laneCount > 1) {
		const tracksWithAccentAtStart = new Set<number>();
		for (const n of notesOut) {
			if (n.tick === 0 && (n.role === 'accent' || n.role === 'taHigh')) tracksWithAccentAtStart.add(n.trackIndex);
		}
		if (tracksWithAccentAtStart.size > 0) {
			notesOut = notesOut.filter((n) => !(n.tick === 0 && n.role === 'passive' && tracksWithAccentAtStart.has(n.trackIndex)));
		}
	}
	const anchorBars = Math.max(1, Math.floor(input.bars ?? 1));
	const anchorSyllables = Math.max(1, Math.floor(input.baseSyllables ?? 1));
	const anchorTick = Math.max(0, Math.round((anchorBars - 1) * anchorSyllables * ppq));
	notesOut.push({
		trackIndex: 0,
		lane: 0,
		role: 'passive',
		tick: anchorTick,
		note: resolveMidiNoteForProfileRole('base', 'passive'),
		velocity: toWriterVelocity(1),
		durationTicks: 1,
	});
	notesOut = notesOut.sort(
		(a, b) => a.tick - b.tick || a.trackIndex - b.trackIndex || a.note - b.note || a.velocity - b.velocity,
	);
	return { bpm, ppq, laneCount, trackLaneByIndex: denseToLane, notes: notesOut };
}

export type MidiWriterEvent = {
	order: number;
	trackIndex: number;
	lane: number;
	type: 'cc10' | 'noteOn' | 'noteOff';
	tick: number;
	channel: number;
	note?: number;
	velocity?: number;
	durationTicks?: number;
	controllerNumber?: 10;
	controllerValue?: number;
	role?: MidiExportRole;
};

function canonicalizeWriterNotes(notes: MidiWriterNoteTuple[]): MidiWriterNoteTuple[] {
	const rolePriority = (role: MidiExportRole): number =>
		role === 'taHigh' ? 0 : role === 'accent' ? 1 : role === 'alt' ? 2 : 3;
	const mergedByStart = new Map<string, MidiWriterNoteTuple>();
	for (const n of notes) {
		const startKey = `${n.trackIndex}:${n.tick}:${n.note}`;
		const prev = mergedByStart.get(startKey);
		if (!prev) {
			mergedByStart.set(startKey, { ...n });
			continue;
		}
		const useNextRole = rolePriority(n.role) < rolePriority(prev.role);
		mergedByStart.set(startKey, {
			...(useNextRole ? n : prev),
			trackIndex: prev.trackIndex,
			lane: prev.lane,
			tick: prev.tick,
			note: prev.note,
			velocity: Math.max(prev.velocity, n.velocity),
			durationTicks: Math.max(prev.durationTicks, n.durationTicks),
		});
	}
	const sorted = [...mergedByStart.values()].sort(
		(a, b) =>
			a.trackIndex - b.trackIndex ||
			a.tick - b.tick ||
			a.note - b.note ||
			a.velocity - b.velocity ||
			a.durationTicks - b.durationTicks,
	);
	const nextFreeTickByTrackNote = new Map<string, number>();
	const out: MidiWriterNoteTuple[] = [];
	const seen = new Set<string>();
	for (const n of sorted) {
		const keyTrackNote = `${n.trackIndex}:${n.note}`;
		const nextFree = nextFreeTickByTrackNote.get(keyTrackNote) ?? 0;
		const startTick = Math.max(n.tick, nextFree);
		const durationTicks = Math.max(1, n.durationTicks);
		const normalized: MidiWriterNoteTuple = {
			...n,
			tick: startTick,
			durationTicks,
		};
		const identity = `${normalized.trackIndex}:${normalized.tick}:${normalized.note}:${normalized.velocity}:${normalized.durationTicks}`;
		if (seen.has(identity)) continue;
		seen.add(identity);
		out.push(normalized);
		nextFreeTickByTrackNote.set(keyTrackNote, startTick + durationTicks);
	}
	return out;
}

export function buildWriterEvents(input: MidiExportInput): {
	bpm: number;
	ppq: number;
	laneCount: number;
	trackLaneByIndex: number[];
	events: MidiWriterEvent[];
} {
	const { bpm, ppq, laneCount, trackLaneByIndex, notes } = buildMidiWriterNoteTuples(input);
	const canonicalNotes = canonicalizeWriterNotes(notes);
	const laneProfileFor = (lane: number): MidiLaneProfile => (lane <= 0 ? 'base' : lane === 1 ? 'contrast' : 'ring');
	const rawEvents: MidiWriterEvent[] = [];
	let order = 0;
	const pushEvent = (event: Omit<MidiWriterEvent, 'order'>): void => {
		rawEvents.push({ order: order++, ...event });
	};
	if (laneCount === 1) {
		const laneProfile = laneProfileFor(0);
		for (let i = 0; i < 3; i++) {
			pushEvent({
				trackIndex: 0,
				lane: 0,
				type: 'cc10',
				tick: LEGACY_TICK_OFFSET,
				channel: DRUM_CHANNEL,
				controllerNumber: 10,
				controllerValue: lanePanCc10(laneProfile),
			});
		}
		for (const n of canonicalNotes) {
			pushEvent({
				trackIndex: n.trackIndex,
				lane: n.lane,
				type: 'noteOn',
				tick: n.tick,
				channel: DRUM_CHANNEL,
				note: n.note,
				velocity: n.velocity,
				durationTicks: n.durationTicks,
				role: n.role,
			});
			pushEvent({
				trackIndex: n.trackIndex,
				lane: n.lane,
				type: 'noteOff',
				tick: n.tick + Math.max(1, n.durationTicks),
				channel: DRUM_CHANNEL,
				note: n.note,
				velocity: 0,
				role: n.role,
			});
		}
		const deduped: MidiWriterEvent[] = [];
		const seen = new Set<string>();
		for (const e of rawEvents) {
			const key = `${e.trackIndex}:${e.tick}:${e.type}:${e.note ?? -1}:${e.velocity ?? -1}:${e.channel}:${e.durationTicks ?? -1}:${e.controllerNumber ?? -1}:${e.controllerValue ?? -1}`;
			if (seen.has(key)) continue;
			seen.add(key);
			deduped.push(e);
		}
		return { bpm, ppq, laneCount, trackLaneByIndex, events: deduped.map((e, idx) => ({ ...e, order: idx })) };
	}
	const usedTrackIndices = Array.from(new Set(notes.map((n) => n.trackIndex))).sort((a, b) => a - b);
	for (let dense = 0; dense < usedTrackIndices.length; dense++) {
		const lane = trackLaneByIndex[dense] ?? dense;
		const channel = midiChannelForLane(lane, laneCount);
		pushEvent({
			trackIndex: dense,
			lane,
			type: 'cc10',
			tick: 0,
			channel,
			controllerNumber: 10,
			controllerValue: lanePanCc10(laneProfileFor(lane)),
		});
	}
	for (const n of canonicalNotes) {
		const channel = midiChannelForLane(n.lane, laneCount);
		pushEvent({
			trackIndex: n.trackIndex,
			lane: n.lane,
			type: 'noteOn',
			tick: n.tick,
			channel,
			note: n.note,
			velocity: n.velocity,
			durationTicks: n.durationTicks,
			role: n.role,
		});
		pushEvent({
			trackIndex: n.trackIndex,
			lane: n.lane,
			type: 'noteOff',
			tick: n.tick + Math.max(1, n.durationTicks),
			channel,
			note: n.note,
			velocity: 0,
			role: n.role,
		});
	}
	const deduped: MidiWriterEvent[] = [];
	const seen = new Set<string>();
	for (const e of rawEvents) {
		const key = `${e.trackIndex}:${e.tick}:${e.type}:${e.note ?? -1}:${e.velocity ?? -1}:${e.channel}:${e.durationTicks ?? -1}:${e.controllerNumber ?? -1}:${e.controllerValue ?? -1}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(e);
	}
	return { bpm, ppq, laneCount, trackLaneByIndex, events: deduped.map((e, idx) => ({ ...e, order: idx })) };
}

export function generateMidi(input: MidiExportInput): Uint8Array {
	const { bpm, ppq, laneCount, trackLaneByIndex, events } = buildWriterEvents(input);
	const laneProfileFor = (lane: number): MidiLaneProfile => (lane <= 0 ? 'base' : lane === 1 ? 'contrast' : 'ring');
	if (laneCount === 1) {
		// Legacy compatibility mode (reference-aligned):
		// - single track (type-0 writer output)
		// - 480 TPB timeline with 1-bar lead-in offset
		// - 3 instrument voices only: Accent/Alt/Passive (TaHigh merged into Accent)
		const LEGACY_TPB = ppq;
		const laneProfile = laneProfileFor(0);
		const tr = new MidiWriter.Track();
		tr.addTrackName('Tempo');
		tr.setTempo(bpm, 3840);
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
		for (const n of events) {
			if (n.type !== 'noteOn' || n.note === undefined || n.velocity === undefined || n.durationTicks === undefined) continue;
			tr.addEvent(
				new MidiWriter.NoteEvent({
					pitch: n.note,
					startTick: n.tick,
					duration: `T${n.durationTicks}`,
					velocity: n.velocity,
					channel: n.channel,
				}),
			);
		}
		const writer = new MidiWriter.Writer([tr], { ticksPerBeat: LEGACY_TPB });
		return writer.buildFile();
	}

	const drumTracks: InstanceType<typeof MidiWriter.Track>[] = [];
	const usedTrackIndices = Array.from(new Set(events.map((n) => n.trackIndex))).sort((a, b) => a - b);
	for (let dense = 0; dense < usedTrackIndices.length; dense++) {
		const lane = trackLaneByIndex[dense] ?? dense;
		const t = new MidiWriter.Track();
		const prefix = laneCount > 1 ? `V${lane + 1}` : 'Tempo';
		t.addTrackName(prefix);
		const laneProfile = laneProfileFor(lane);
		const channel = midiChannelForLane(lane, laneCount);
		t.addEvent(
			new MidiWriter.ControllerChangeEvent({
				controllerNumber: 10,
				controllerValue: lanePanCc10(laneProfile),
				channel,
				tick: 0,
			}),
		);
		drumTracks.push(t);
	}
	if (drumTracks.length > 0) {
		drumTracks[0].setTempo(bpm, 0);
		drumTracks[0].setTimeSignature(Math.max(1, Math.floor(input.baseSyllables ?? 4)), 4);
	} else {
		const t = new MidiWriter.Track();
		t.addTrackName('Tempo');
		t.setTempo(bpm, 0);
		t.setTimeSignature(Math.max(1, Math.floor(input.baseSyllables ?? 4)), 4);
		drumTracks.push(t);
	}

	for (const n of events) {
		if (n.type !== 'noteOn' || n.note === undefined || n.velocity === undefined || n.durationTicks === undefined) continue;
		const tr = drumTracks[n.trackIndex];
		if (!tr) continue;
		tr.addEvent(
			new MidiWriter.NoteEvent({
				pitch: n.note,
				startTick: n.tick,
				duration: `T${n.durationTicks}`,
				velocity: n.velocity,
				channel: n.channel,
			}),
		);
	}

	const writer = new MidiWriter.Writer(drumTracks, { ticksPerBeat: ppq });
	return writer.buildFile();
}

export function generateMidiBlob(input: MidiExportInput): Blob {
	return new Blob([generateMidi(input)], { type: 'audio/midi' });
}
