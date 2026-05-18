import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, startTransition } from 'react';
import { flushSync } from 'react-dom';
import {
	Settings,
	Minus,
	Plus,
	Dices,
	Play,
	Snowflake,
	ChevronUp,
	ChevronDown,
	ChevronLeft,
	Eraser,
	Copy,
	ClipboardPaste,
} from 'lucide-react';
import { SequencerGrid, type SequencerGridRowActions } from './SequencerGrid';
import {
	getMetraSchedulerConfig,
	getMetronomeSummingInput,
	type MetraSchedulerProfile,
} from './metraAudioBus';
import { applyVoiceGroupChain, getVoiceLayerSumInput, type MetroVoiceKey } from './metroSoundBus';
import { metroEnvelopeEndFromPeak, scheduleLayerToBus } from './metroLayerGraph';
import {
	createPolySubLegacyScheduler,
	type PolySubLegacyScheduler,
} from './polySubLegacyScheduler';
import type { PlayheadHighlightEvent, PlayheadPosition } from './playheadTypes';
import { createPolySubLegacyLaneIndicatorStore } from './polySubLegacyLaneIndicatorStore';
import {
	applyRandomizerEffectsToBar,
	buildLegacyPlaybackSequence,
	mulberry32,
	type BarRandomizerMutable,
	type DeadCellsMap,
} from './randomLogic';
import {
	ALL_FORM_PRESETS,
	applyParentModeBar,
	buildPhraseSchedule,
	FORM_PRESET_LABEL,
	isFormPresetId,
	isMutationType,
	isRandomMode,
	parentGenomeFromJSON,
	parentGenomeToJSON,
	snapshotBarGenome,
	type FormPresetId,
	type MutationType,
	type ParentGenome,
	type ParentLength,
	type ProgressiveDensityMode,
	type PhraseSchedule,
	type RandomMode,
} from './parentMode';
import {
	isEnabledMutationsCustomForPreset,
	clampParentTargetBars,
	PRESET_ENABLED_MUTATIONS,
	PRESET_TARGET_BARS,
} from './parentModeUi';
import {
	buildBarLogForParentRow,
	formatParentGenomeHumanLine,
	lessonLogger,
} from './lessonLogger';
import { generateMidiBlob } from './midiExport';
import type { RowRuntimeContext } from './sequencerLabels';
import {
	applyCellIntentToConfig,
	buildCellConfigsFromLegacy,
	ensureCellConfig,
	normalizeStoredStepMask,
	resolveEffectiveStepMask,
	splitCellConfigsToLegacy,
	type CellConfigs,
	type CellIntent,
	type CellStepMasks,
} from './stepMask';
import {
	dropPress,
	isStateEmpty as isPressStateEmpty,
	tilePress,
	type PressPatch,
	type PressState,
} from './pressMatrix';
import {
	armPressFromState,
	getPressArmSource,
	getPressBaseline,
	isPressPrimed,
	notifyPressErased,
	type PressArmSource,
} from './pressMatrixCoordinator';

function buildPolyChunks(barCount: number, voiceCount: number): number[][] {
	const safeBars = Math.max(0, Math.floor(barCount));
	// const safeVoices = voiceCount === 3 || voiceCount === 4 ? voiceCount : 2;
	// 4-voice polyrythm temporarily disabled.
	const safeVoices = voiceCount === 3 ? voiceCount : 2;
	const chunks: number[][] = [];
	for (let i = 0; i < safeBars; i += safeVoices) {
		const chunk: number[] = [];
		for (let v = 0; v < safeVoices; v++) {
			const barIdx = i + v;
			if (barIdx < safeBars) chunk.push(barIdx);
		}
		if (chunk.length > 0) chunks.push(chunk);
	}
	return chunks;
}

/** Row index in grid = pattern bar index (legacy and poly). */
function patternBarFromRowTap(rIdx: number, _polyMode: boolean, _polyVoices: 2 | 3 | 4): number {
	return rIdx;
}

function insertPlayheadSorted(queue: PlayheadHighlightEvent[], ev: PlayheadHighlightEvent) {
	let lo = 0;
	let hi = queue.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (queue[mid].t <= ev.t) lo = mid + 1;
		else hi = mid;
	}
	queue.splice(lo, 0, ev);
}

/** When pulse is unlinked from beats-per-bar, step duration uses a 4-beat (quarter-note) grid. */
const PULSE_METER_BASE_SYLLABLES = 4;

/** Manual mute mode toggled by holding the "Mode" button. */
type SyllableReadMuteMode = 'off' | 'full' | 'no_accent_sharp';
/** Legacy wire format (previously controlled by a single square button). */
type SquarePlaybackMode = 'passive_no_alt' | 'full_mix' | 'ta_only';
type MixerLayerMode = 'full_mix' | 'no_alt' | 'alt_only';
type TrainerMode = 'normal' | 'ta_only' | 'dictation';
const DEFAULT_SQUARE_PLAYBACK_MODE: SquarePlaybackMode = 'full_mix';
const DEFAULT_MIXER_LAYER_MODE: MixerLayerMode = 'full_mix';
const DEFAULT_TRAINER_MODE: TrainerMode = 'normal';

function nextMixerLayerMode(mode: MixerLayerMode): MixerLayerMode {
	if (mode === 'full_mix') return 'alt_only';
	if (mode === 'alt_only') return 'no_alt';
	return 'full_mix';
}
function nextTrainerMode(mode: TrainerMode): TrainerMode {
	if (mode === 'normal') return 'ta_only';
	if (mode === 'ta_only') return 'dictation';
	return 'normal';
}

/** Snapshots/JSON: new values + migration from `all_beats`/`accent_only`/`passive_only` and legacy `onlyAccents`. */
function normalizeSquarePlaybackModeFromSnapshot(
	raw: unknown,
	legacyOnlyAccents?: boolean,
): SquarePlaybackMode {
	if (raw === 'passive_no_alt' || raw === 'full_mix' || raw === 'ta_only') return raw;
	if (raw === 'all_beats' || raw === 'accent_only') return 'full_mix';
	if (raw === 'passive_only') return 'ta_only';
	if (legacyOnlyAccents === true) return 'full_mix';
	return DEFAULT_SQUARE_PLAYBACK_MODE;
}

function normalizeSyllableReadMuteModeFromSnapshot(modeRaw: unknown, legacyLatched: unknown): SyllableReadMuteMode {
	if (modeRaw === 'full' || modeRaw === 'no_accent_sharp') return modeRaw;
	if (legacyLatched === true) return 'no_accent_sharp';
	return 'off';
}

function normalizeMixerLayerModeFromSnapshot(raw: unknown): MixerLayerMode {
	if (raw === 'full_mix' || raw === 'no_alt' || raw === 'alt_only') return raw;
	return DEFAULT_MIXER_LAYER_MODE;
}
function normalizeTrainerModeFromSnapshot(raw: unknown): TrainerMode {
	if (raw === 'normal' || raw === 'ta_only' || raw === 'dictation') return raw;
	return DEFAULT_TRAINER_MODE;
}
function deriveNewModesFromLegacySnapshot(
	raw: { squarePlaybackMode?: unknown; squarePassiveLayerMuted?: unknown; dictantMode?: unknown; onlyAccents?: unknown },
): { mixerLayerMode: MixerLayerMode; trainerMode: TrainerMode } {
	const legacyPlayback = normalizeSquarePlaybackModeFromSnapshot(
		raw.squarePlaybackMode,
		raw.onlyAccents === true ? true : undefined,
	);
	const legacyPassiveMuted = raw.squarePassiveLayerMuted === true;
	const legacyDictation = raw.dictantMode === true;
	const mixerLayerMode: MixerLayerMode =
		legacyPlayback === 'passive_no_alt'
			? 'no_alt'
			: legacyPlayback === 'ta_only'
				? 'full_mix'
				: legacyPassiveMuted
					? 'alt_only'
					: 'full_mix';
	const trainerMode: TrainerMode = legacyDictation
		? 'dictation'
		: legacyPlayback === 'ta_only'
			? 'ta_only'
			: 'normal';
	return { mixerLayerMode, trainerMode };
}
function mapNewModesToLegacySnapshot(
	mixerLayerMode: MixerLayerMode,
	trainerMode: TrainerMode,
): { squarePlaybackMode: SquarePlaybackMode; squarePassiveLayerMuted: boolean; dictantMode: boolean } {
	if (trainerMode === 'dictation') {
		return {
			squarePlaybackMode: 'passive_no_alt',
			squarePassiveLayerMuted: false,
			dictantMode: true,
		};
	}
	if (trainerMode === 'ta_only') {
		return {
			squarePlaybackMode: 'ta_only',
			squarePassiveLayerMuted: false,
			dictantMode: false,
		};
	}
	if (mixerLayerMode === 'no_alt') {
		return {
			squarePlaybackMode: 'passive_no_alt',
			squarePassiveLayerMuted: false,
			dictantMode: false,
		};
	}
	if (mixerLayerMode === 'alt_only') {
		return {
			squarePlaybackMode: 'full_mix',
			squarePassiveLayerMuted: true,
			dictantMode: false,
		};
	}
	return {
		squarePlaybackMode: 'full_mix',
		squarePassiveLayerMuted: false,
		dictantMode: false,
	};
}

function normalizePulseMeterUnlinked(raw: unknown): Record<number, boolean> {
	if (!raw || typeof raw !== 'object') return {};
	const out: Record<number, boolean> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		const ri = parseInt(k, 10);
		if (Number.isFinite(ri) && ri >= 0) out[ri] = Boolean(v);
	}
	return out;
}
function parsePolyVoices(raw: unknown): 2 | 3 | 4 {
	const n = parseInt(String(raw), 10);
	// return n === 3 || n === 4 ? n : 2;
	// 4-voice polyrythm temporarily disabled.
	return n === 3 ? n : 2;
}

type PolyVoiceTarget = 0 | 1 | 2 | 3;
type LaneId = 0 | 1 | 2;
type LaneSetMap = Record<LaneId, Set<string>>;
type LaneBoolMap = Record<LaneId, boolean>;
type FirstBeatHitPolicy = 'legacy' | 'explicit_any' | 'explicit_ta_only';
type ClickSoundByPolyVoice = Partial<Record<PolyVoiceTarget, ClickSoundPreset>>;
type PolyVoiceGainMap = Record<0 | 1 | 2, number>;

function normalizeClickSoundByPolyVoice(raw: unknown): ClickSoundByPolyVoice {
	const out: ClickSoundByPolyVoice = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		const voice = parseInt(k, 10);
		if (!Number.isFinite(voice) || voice < 0 || voice > 3) continue;
		if (isClickSoundPreset(v)) out[voice as PolyVoiceTarget] = v;
	}
	return out;
}

function parsePolyVoiceGainsFromUnknown(raw: unknown): PolyVoiceGainMap | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const parsed = raw as Partial<Record<number, unknown>>;
	const next: PolyVoiceGainMap = { ...DEFAULT_POLY_VOICE_GAINS };
	let hasAny = false;
	for (const lane of [0, 1, 2] as const) {
		const v = Number(parsed?.[lane]);
		if (!Number.isFinite(v)) continue;
		next[lane] = Math.max(0, Math.min(1.6, v));
		hasAny = true;
	}
	return hasAny ? next : undefined;
}

function resolveClickSoundForPolyVoice(
	voice: number,
	isPoly: boolean,
	perVoice: ClickSoundByPolyVoice,
	master: ClickSoundPreset,
): ClickSoundPreset {
	if (!isPoly) return master;
	const mapped = perVoice[voice as PolyVoiceTarget];
	return mapped ?? master;
}

function laneForRow(r: number, voices: 2 | 3 | 4): LaneId {
	return (voices === 3 ? (r % 3) : (r % 2)) as LaneId;
}

function makeEmptyLaneSetMap(seedLane0?: Iterable<string>): LaneSetMap {
	return {
		0: new Set(seedLane0 ?? []),
		1: new Set<string>(),
		2: new Set<string>(),
	};
}

function makeLaneBoolMap(defaultValue: boolean): LaneBoolMap {
	return { 0: defaultValue, 1: defaultValue, 2: defaultValue };
}

function cloneLaneSetMap(src?: Partial<Record<number, Iterable<string>>>): LaneSetMap {
	const toSafeSet = (value: unknown): Set<string> => {
		if (value instanceof Set) return new Set([...value].filter((x): x is string => typeof x === 'string'));
		if (Array.isArray(value)) return new Set(value.filter((x): x is string => typeof x === 'string'));
		return new Set<string>();
	};
	return {
		0: toSafeSet(src?.[0]),
		1: toSafeSet(src?.[1]),
		2: toSafeSet(src?.[2]),
	};
}

function cloneLaneBoolMap(src?: Partial<Record<number, boolean>>, fallback = true): LaneBoolMap {
	return {
		0: typeof src?.[0] === 'boolean' ? src[0]! : fallback,
		1: typeof src?.[1] === 'boolean' ? src[1]! : fallback,
		2: typeof src?.[2] === 'boolean' ? src[2]! : fallback,
	};
}

function flattenLaneSetMap(map: LaneSetMap, bars: number, voices: 2 | 3 | 4): Set<string> {
	const out = new Set<string>();
	for (const lane of [0, 1, 2] as const) {
		for (const key of map[lane]) {
			const [rRaw] = key.split('-');
			const r = parseInt(rRaw ?? '', 10);
			if (!Number.isFinite(r) || r < 0 || r >= bars) continue;
			if (laneForRow(r, voices) !== lane) continue;
			out.add(key);
		}
	}
	return out;
}

function distributeSetToLanes(set: Set<string>, bars: number, voices: 2 | 3 | 4): LaneSetMap {
	const out = makeEmptyLaneSetMap();
	for (const key of set) {
		const [rRaw] = key.split('-');
		const r = parseInt(rRaw ?? '', 10);
		if (!Number.isFinite(r) || r < 0 || r >= bars) continue;
		out[laneForRow(r, voices)].add(key);
	}
	return out;
}

function resolveFirstBeatHitRow(
	policy: FirstBeatHitPolicy,
	on0Accent: boolean,
	on0Ding: boolean,
	firstBeatEnabled: boolean,
	suppressedRow: boolean,
): boolean {
	if (policy === 'explicit_ta_only') return on0Ding;
	if (policy === 'explicit_any') return on0Accent || on0Ding;
	if (suppressedRow) return on0Ding;
	return on0Accent || on0Ding || firstBeatEnabled;
}

function resolveRuntimeFirstBeatPolicy(isPoly: boolean, laneId: LaneId): FirstBeatHitPolicy {
	if (!isPoly) return 'legacy';
	// Keep default first-beat Ta on V1/V2; only extra lanes require explicit taDing on beat 0.
	return laneId === 2 ? 'explicit_ta_only' : 'legacy';
}

function normalizeSuppressedRows(raw: unknown, bars: number): Set<number> {
	const source: unknown[] =
		raw instanceof Set
			? [...raw]
			: Array.isArray(raw)
				? raw
				: [];
	const out = new Set<number>();
	for (const x of source) {
		const r = parseInt(String(x), 10);
		if (Number.isFinite(r) && r >= 0 && r < bars) out.add(r);
	}
	return out;
}

/**
 * With poly enabled: bar count must be a multiple of voice count (3 -> 3,6,9,...; otherwise 2 -> 2,4,...).
 * Without poly: only clamp to 1..100.
 */
function snapBarsToPolyGrid(raw: number, polyActive: boolean, voices: 2 | 3 | 4): number {
	const rounded = Math.round(raw);
	const clamped = Math.max(1, Math.min(100, rounded));
	if (!polyActive) return clamped;
	const V = voices === 3 ? 3 : 2;
	const minBars = V;
	const constrained = Math.max(minBars, clamped);
	const down = Math.floor(constrained / V) * V;
	const up = Math.ceil(constrained / V) * V;
	let snapped = down;
	if (down < minBars) snapped = up;
	else if (up <= 100 && Math.abs(up - constrained) < Math.abs(constrained - down)) snapped = up;
	if (snapped > 100) {
		snapped = 100 - (100 % V);
		if (snapped < minBars) snapped = minBars;
	}
	return snapped;
}

const SNAPSHOT_SLOT_COUNT = 7;
const SNAPSHOT_STORAGE_KEY = 'konnakolTrainerSnapshotsV1';
const SNAPSHOT_STORAGE_COMPACT_KEY = 'konnakolTrainerSnapshotsCompactV1';
const LITE_UI_STORAGE_KEY = 'konnakol_lite_ui';
const POLY_MODE_STORAGE_KEY = 'konnakol_poly_mode';
const POLY_VOICES_STORAGE_KEY = 'konnakol_poly_voices';
const POLY_VOICE_GAINS_STORAGE_KEY = 'konnakol_poly_voice_gains';
const CLICK_PRESET_BUS_GAINS_STORAGE_KEY = 'konnakol_click_preset_bus_gains';
/**
 * Project-wide hardcoded default from user-calibrated backup.
 * Neutral UI "vol" baseline is still 1.0, but startup default for V1 uses 0.76.
 */
const DEFAULT_POLY_VOICE_GAINS: PolyVoiceGainMap = { 0: 1, 1: 1, 2: 1 };
/** Debounce `playTwoBarsPreviewFromGrid` after bus 1/2/3 slider moves. */
const CLICK_PRESET_BUS_TWO_BARS_PREVIEW_DEBOUNCE_MS = 120;
const APP_COMMIT_VERSION = (() => {
	if (typeof __APP_BUILD_COMMIT__ === 'string' && __APP_BUILD_COMMIT__.length >= 7) return __APP_BUILD_COMMIT__.slice(0, 7);
	return 'dev';
})();
const TEMPO_THROTTLE_MS = 56;
/** Hold tempo +/-: after delay, apply step +/-5 every 0.1s. */
const TEMPO_HOLD_REPEAT_MS = 100;
const TEMPO_HOLD_REPEAT_STEP = 5;
/** Long press on tempo slider track (without much move) → inline BPM on thumb. */
const TEMPO_MANUAL_HOLD_MS = 2000;
/** Tempo slider long-press to inline BPM edit (short hold). */
const TEMPO_SLIDER_INLINE_HOLD_MS = 420;
const TEMPO_MANUAL_MAX_MOVE_PX = 14;
/*
 * Do not modify this block without a migration plan.
 * The marker, regex, field order, p1/p2/p3 layout, 0xFE handling, V2 and legacy compatibility
 * are tightly coupled: encodeSnapshotClipboard / tryDecodeSnapshotClipboard / packGridTokenPacked.
 */
/**
 * FRAGILE — compact clipboard snapshot format (high regression risk).
 * Do not change marker string, SNAPSHOT_CLIPBOARD_MARKER_REGEX character class, dot-separated field
 * order/count, p1/p2/p3 binary layout in pack/unpack, or flag bit meanings without a migration plan.
 * Reference: konnakol_trainer/docs/reserve-hub/01-snapshot-clipboard-cipher.md
 */
/** Clipboard export: kawaii magic marker for compact preset payload. */
const SNAPSHOT_CLIPBOARD_MARKER = '(⁠ʘ⁠ᴗ⁠ʘ⁠)⁠♪:';
/** Accept marker with/without zero-width separators from messengers. */
const SNAPSHOT_CLIPBOARD_MARKER_REGEX =
	/^\([\s\u200b\u200c\u200d\ufeff\u2060]*ʘ[\s\u200b\u200c\u200d\ufeff\u2060]*ᴗ[\s\u200b\u200c\u200d\ufeff\u2060]*ʘ[\s\u200b\u200c\u200d\ufeff\u2060]*\)[\s\u200b\u200c\u200d\ufeff\u2060]*♪[\s\u200b\u200c\u200d\ufeff\u2060]*:/;
/** Backward compatibility for previously shared compact snapshots. */
const SNAPSHOT_CLIPBOARD_PREFIX_LEGACY_COMPACT = 'METRONOME_CONFIG:';
/** Legacy prefix with raw JSON after colon — still accepted when pasting. */
const SNAPSHOT_CLIPBOARD_PREFIX_LEGACY = 'konnakolTrainerSnapshotV1:';
/** JSON clipboard with lane-separated accent/Ta maps. */
const SNAPSHOT_CLIPBOARD_PREFIX_V2 = 'konnakolTrainerSnapshotV2:';
/** Hold snapshot slot to copy preset to clipboard. */
const SNAPSHOT_SLOT_HOLD_MS = 300;
/** Long-press for Ta / dead-editor eraser / other UI timers (~0.5s). */
const SNAPSHOT_MENU_HOLD_MS = 520;
/** Bottom "Ta" button only: enter/exit frame-edit mode (shorter than `SNAPSHOT_MENU_HOLD_MS`, avoids false long-press on tap). */
const TA_EDITOR_HOLD_MS = 150;
/** Dead time before instant full fill on the button (ms); long-press timer is not shifted. */
const TA_EDITOR_HOLD_FILL_DEAD_MS = 100;
/** Hold the dice button: toggle Randomizer mode (enable/disable randomization at bar boundaries). */
const RANDOM_DICE_PREFILL_HOLD_MS = SNAPSHOT_MENU_HOLD_MS;
/** Long-press PLAY: pick pattern-bar anchor for next playback start. */
const PLAY_START_PICK_HOLD_MS = 400;

const SNAPSHOT_FLAG_RANDOM_MODE_ENABLED = 1 << 0;
const SNAPSHOT_FLAG_RANDOM_PULSATION = 1 << 1;
const SNAPSHOT_FLAG_RANDOM_PATTERN = 1 << 2;
const SNAPSHOT_FLAG_RANDOM_SPEED = 1 << 3;
const SNAPSHOT_FLAG_RANDOM_BAR_SPEED = 1 << 4;
const SNAPSHOT_FLAG_PANEL_EXPANDED = 1 << 5;
const SNAPSHOT_FLAG_ONLY_ACCENTS = 1 << 6;
const SNAPSHOT_FLAG_FIRST_BEAT_ACCENT = 1 << 7;
const SNAPSHOT_FLAG_POLY_MODE = 1 << 8;
const SNAPSHOT_FLAG_POLY_VOICES_3 = 1 << 9;
const SNAPSHOT_FLAG_POLY_VOICES_4 = 1 << 10;
/** Parent mode active: randomMode='parent'. Old snapshots without this flag are treated as 'free'. */
const SNAPSHOT_FLAG_PARENT_MODE = 1 << 11;
/** Extended compact snapshot payload marker: includes encoded mixer/trainer/playback/mute modes. */
const SNAPSHOT_FLAG_MODE_FIELDS_PRESENT = 1 << 12;
const SNAPSHOT_FLAG_TRAINER_HOLD_MUTE = 1 << 13;
const SNAPSHOT_FLAG_SQUARE_PASSIVE_LAYER_MUTED = 1 << 14;
const SNAPSHOT_FLAG_DICTANT_MODE = 1 << 15;
const SNAPSHOT_FLAG_MIXER_LAYER_SHIFT = 16;
const SNAPSHOT_FLAG_MIXER_LAYER_MASK = 0b11 << SNAPSHOT_FLAG_MIXER_LAYER_SHIFT;
const SNAPSHOT_FLAG_TRAINER_MODE_SHIFT = 18;
const SNAPSHOT_FLAG_TRAINER_MODE_MASK = 0b11 << SNAPSHOT_FLAG_TRAINER_MODE_SHIFT;
const SNAPSHOT_FLAG_SQUARE_PLAYBACK_SHIFT = 20;
const SNAPSHOT_FLAG_SQUARE_PLAYBACK_MASK = 0b11 << SNAPSHOT_FLAG_SQUARE_PLAYBACK_SHIFT;
const SNAPSHOT_FLAG_SYLLABLE_MUTE_SHIFT = 22;
const SNAPSHOT_FLAG_SYLLABLE_MUTE_MASK = 0b11 << SNAPSHOT_FLAG_SYLLABLE_MUTE_SHIFT;
const SNAPSHOT_SOUND_ID_CLASSIC = 0;
const SNAPSHOT_SOUND_ID_OLDSCHOOL = 1;
const AUDIO_START_GUARD_SEC = 0.004;
const AUDIO_BURST_MIN_SPACING_SEC = 0.0012;
const AUDIO_BURST_PASSIVE_MIN_SPACING_SEC = 0.0032;
const AUDIO_PASSIVE_STALL_COOLDOWN_SPACING_MULT = 1.8;
const AUDIO_SCHEDULER_LONG_STALL_MIN_MS = 220;
const AUDIO_SCHEDULER_LONG_STALL_LOOKAHEAD_MULT = 6;
const AUDIO_SCHEDULER_POST_STALL_COOLDOWN_MS = 1500;
/** Percussion AD envelope: linear attack (s), exponential decay floor vs peak (-60 dB rel.). */
const CLICK_ENV_ATTACK_SEC = 0.002;
const CLICK_LAYER_VOLUME_GATE = 0.001;
const CLICK_DECAY_MIN_SEC = 0.001;
const CLICK_DECAY_MAX_SEC = 3;
const HYBRID_NEAR_HIT_MIN_MS = 8;
const HYBRID_NEAR_HIT_MAX_MS = 35;
const HYBRID_TAIL_MIN_MS = 120;
const HYBRID_TAIL_MAX_MS = 220;
const HYBRID_PENDING_DOIGR_LIMIT_MS = 10;
const HYBRID_MODE_MIN_HOLD_FLOOR_MS = 20;
const HYBRID_LIVE_WATCHDOG_MS = 800;
const AUDIO_TIMING_METRICS_ENABLED = true;
const AUDIO_TIMING_METRICS_LOG_EVERY_MS = 15000;
const DEFAULT_SCHEDULER_PROFILE: MetraSchedulerProfile = 'safe';

type TimingDomain = 'mono' | 'poly';

type AudioTimingMetrics = {
	enabled: boolean;
	logEveryMs: number;
	scheduledEvents: number;
	lateEvents: number;
	droppedEvents: number;
	recoveryCount: number;
	maxLatenessSec: number;
	maxLagSec: number;
	latenessSamples: {
		mono: number[];
		poly: number[];
	};
	totalSubHitCount: number;
	deferSubHitCount: number;
	liveWindowActiveMs: number;
	modeSwitchCount: number;
	flapCount: number;
	deferCanceledCount: number;
	deferRescheduledCount: number;
	lastLogAtMs: number;
};

function makeAudioTimingMetrics(): AudioTimingMetrics {
	return {
		enabled: AUDIO_TIMING_METRICS_ENABLED,
		logEveryMs: AUDIO_TIMING_METRICS_LOG_EVERY_MS,
		scheduledEvents: 0,
		lateEvents: 0,
		droppedEvents: 0,
		recoveryCount: 0,
		maxLatenessSec: 0,
		maxLagSec: 0,
		latenessSamples: { mono: [], poly: [] },
		totalSubHitCount: 0,
		deferSubHitCount: 0,
		liveWindowActiveMs: 0,
		modeSwitchCount: 0,
		flapCount: 0,
		deferCanceledCount: 0,
		deferRescheduledCount: 0,
		lastLogAtMs: 0,
	};
}

function percentile(sortedValues: number[], p: number): number {
	if (sortedValues.length === 0) return 0;
	const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * p)));
	return sortedValues[idx]!;
}

type PendingGridDeferredEvent = {
	id: number;
	targetTime: number;
	fire: () => void;
};

type ClickSoundPreset =
	| 'classic'
	| 'oldschool'
	| 'standard'
	| 'modern_daw'
	| 'woodblock'
	| 'punchy'
	| 'sharp_digital'
	| 'deep_sub'
	| 'laser_snap'
	| 'hi_hat'
	| 'glass_drop'
	| 'plastic_knock'
	| 'metallic'
	| 'clock_tick'
	| 'cowbell'
	| 'analog_synth'
	| 'vinyl_crackle'
	| 'dry_click'
	| 'soft_ping'
	| 'noise_burst'
	| 'eight_bit';

type ClickSoundConfig = {
	oscType?: OscillatorType;
	baseFreq: number;
	accentFreq: number;
	altFreq: number;
	decay: number;
	decayAccent: number;
	decayAlt: number;
	sweep?: boolean;
	noise?: boolean;
	noiseType?: BiquadFilterType;
	noiseFreq?: number;
	noiseFreqAccent?: number;
	altNoiseFreq?: number;
	volume: number;
	volumeAccent: number;
	volumeAlt: number;
	layers?: {
		accent: ClickLayerConfig[];
		alt: ClickLayerConfig[];
		passive: ClickLayerConfig[];
	};
};

type ClickLayerType = OscillatorType | 'noise' | 'none';
type ClickLayerConfig = {
	type: ClickLayerType;
	sweep: boolean;
	noiseFilterType: BiquadFilterType;
	params: {
		volume: number;
		decay: number;
		freq: number;
		hpFreq: number;
		lpFreq: number;
	};
	mute?: boolean;
	solo?: boolean;
};

function buildLegacyVoiceLayers(cfg: ClickSoundConfig): {
	accent: ClickLayerConfig[];
	alt: ClickLayerConfig[];
	passive: ClickLayerConfig[];
} {
	const mkOsc = (freq: number, volume: number, decay: number): ClickLayerConfig => ({
		type: (cfg.oscType ?? 'sine') as ClickLayerType,
		sweep: cfg.sweep === true,
		noiseFilterType: 'highpass',
		params: { volume, decay, freq, hpFreq: 20, lpFreq: 20000 },
	});
	const mkNoise = (freq: number, volume: number, decay: number): ClickLayerConfig => ({
		type: cfg.noise ? 'noise' : 'none',
		sweep: false,
		noiseFilterType: (cfg.noiseType ?? 'highpass') as BiquadFilterType,
		params: { volume, decay, freq, hpFreq: 20, lpFreq: 20000 },
	});
	const mkNone = (decay: number): ClickLayerConfig => ({
		type: 'none',
		sweep: false,
		noiseFilterType: 'highpass',
		params: { volume: 0, decay, freq: 1000, hpFreq: 20, lpFreq: 20000 },
	});
	const baseDecay = cfg.decay;
	const accentDecay = cfg.decayAccent;
	const altDecay = cfg.decayAlt;
	const baseVolume = cfg.volume;
	const accentVolume = cfg.volumeAccent;
	const altVolume = cfg.volumeAlt;
	const baseNoiseFreq = cfg.noiseFreq ?? 1000;
	const accentNoiseFreq = cfg.noiseFreqAccent ?? cfg.noiseFreq ?? 1000;
	const altNoiseFreq = cfg.altNoiseFreq ?? cfg.noiseFreq ?? 1000;
	return {
		accent: [
			mkOsc(cfg.accentFreq, accentVolume, accentDecay),
			mkNoise(accentNoiseFreq, accentVolume * 0.5, accentDecay),
			mkNone(0.1),
		],
		alt: [
			mkOsc(cfg.altFreq, altVolume, altDecay),
			mkNoise(altNoiseFreq, altVolume * 0.5, altDecay),
			mkNone(0.1),
		],
		passive: [
			mkOsc(cfg.baseFreq, baseVolume, baseDecay),
			mkNoise(baseNoiseFreq, baseVolume * 0.5, baseDecay),
			mkNone(0.1),
		],
	};
}

const CLICK_SOUND_PRESET_ORDER: ClickSoundPreset[] = [
	'classic',
	'oldschool',
	'standard',
	'modern_daw',
	'woodblock',
	'punchy',
	'sharp_digital',
	'deep_sub',
	'laser_snap',
	'hi_hat',
	'glass_drop',
	'plastic_knock',
	'metallic',
	'clock_tick',
	'cowbell',
	'analog_synth',
	'vinyl_crackle',
	'dry_click',
	'soft_ping',
	'noise_burst',
	'eight_bit',
];

/** Per-preset gain for accent / alt / passive buses (multiplies layer output). */
type ClickPresetBusGains = { accent: number; alt: number; passive: number };
type ClickPresetBusGainsMap = Partial<Record<ClickSoundPreset, ClickPresetBusGains>>;
type ClickPresetBusGainsByVoiceMap = Partial<Record<0 | 1 | 2, ClickPresetBusGainsMap>>;
type ClickPresetBusGainsStorageV2 = {
	v: 2;
	byVoice?: ClickPresetBusGainsByVoiceMap;
	byPreset?: ClickPresetBusGainsMap;
};

const DEFAULT_CLICK_PRESET_BUS_GAINS: ClickPresetBusGains = { accent: 1, alt: 1, passive: 1 };
const HARDCODED_DEFAULT_CLICK_PRESET_BUS_GAINS_BY_PRESET: ClickPresetBusGainsMap = {
	classic: { accent: 1, alt: 1, passive: 1 },
	oldschool: { accent: 0, alt: 0.98, passive: 1.12 },
	standard: { accent: 0.99, alt: 0.78, passive: 0.81 },
	sharp_digital: { accent: 1, alt: 1, passive: 1 },
	hi_hat: { accent: 0.87, alt: 0.23, passive: 0.32 },
	plastic_knock: { accent: 1, alt: 1, passive: 1 },
	metallic: { accent: 1, alt: 1, passive: 1 },
	clock_tick: { accent: 1, alt: 1, passive: 1 },
	vinyl_crackle: { accent: 1, alt: 1, passive: 0.68 },
};
const HARDCODED_DEFAULT_CLICK_PRESET_BUS_GAINS_BY_VOICE: ClickPresetBusGainsByVoiceMap = {
	0: {
		plastic_knock: { accent: 1, alt: 1, passive: 1 },
		vinyl_crackle: { accent: 1.24, alt: 0.84, passive: 0.54 },
		dry_click: { accent: 1, alt: 0.44, passive: 0.28 },
		noise_burst: { accent: 0.7, alt: 0.36, passive: 0.76 },
		hi_hat: { accent: 0.87, alt: 0.4, passive: 0.56 },
		woodblock: { accent: 1.24, alt: 0.7, passive: 0.28 },
		oldschool: { accent: 1.1, alt: 0.52, passive: 0.32 },
		eight_bit: { accent: 0.4, alt: 0.22, passive: 0.74 },
		metallic: { accent: 0.86, alt: 0.68, passive: 0.4 },
		deep_sub: { accent: 1, alt: 0.28, passive: 0.4 },
		cowbell: { accent: 0.92, alt: 0.24, passive: 0.48 },
		glass_drop: { accent: 1, alt: 0.22, passive: 0.38 },
		modern_daw: { accent: 0.58, alt: 0.24, passive: 0.42 },
		classic: { accent: 1.46, alt: 1.1, passive: 0.74 },
		sharp_digital: { accent: 0.88, alt: 0.64, passive: 0.4 },
		soft_ping: { accent: 1.08, alt: 0.72, passive: 0.3 },
		analog_synth: { accent: 1, alt: 0.48, passive: 0.7 },
		punchy: { accent: 1.1, alt: 0.74, passive: 0.3 },
		clock_tick: { accent: 1, alt: 0.46, passive: 0.76 },
	},
	1: {
		classic: { accent: 1, alt: 1, passive: 1 },
		oldschool: { accent: 0.58, alt: 0.98, passive: 1.12 },
		hi_hat: { accent: 0.63, alt: 0.52, passive: 0.59 },
		clock_tick: { accent: 0, alt: 0, passive: 0.67 },
		vinyl_crackle: { accent: 1, alt: 1, passive: 1 },
	},
	2: {
		classic: { accent: 1, alt: 1, passive: 1 },
		hi_hat: { accent: 0.87, alt: 0.23, passive: 0.32 },
	},
};

function clampClickPresetBusGain(n: number): number {
	if (!Number.isFinite(n)) return 1;
	return Math.max(0, Math.min(1.6, n));
}

function getClickPresetBusGainsForPreset(map: ClickPresetBusGainsMap, preset: ClickSoundPreset): ClickPresetBusGains {
	const row = map[preset];
	return {
		accent: clampClickPresetBusGain(row?.accent ?? 1),
		alt: clampClickPresetBusGain(row?.alt ?? 1),
		passive: clampClickPresetBusGain(row?.passive ?? 1),
	};
}

function normalizeClickBusVoiceIndex(raw: unknown): 0 | 1 | 2 {
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0 || n > 2) return 0;
	return Math.floor(n) as 0 | 1 | 2;
}

function parseClickPresetBusGainsMapFromUnknown(raw: unknown): ClickPresetBusGainsMap {
	if (!raw || typeof raw !== 'object') return {};
	const parsed = raw as Record<string, unknown>;
	const out: ClickPresetBusGainsMap = {};
	for (const preset of CLICK_SOUND_PRESET_ORDER) {
		const row = parsed[preset];
		if (!row || typeof row !== 'object') continue;
		const o = row as Record<string, unknown>;
		out[preset] = {
			accent: clampClickPresetBusGain(Number(o.accent)),
			alt: clampClickPresetBusGain(Number(o.alt)),
			passive: clampClickPresetBusGain(Number(o.passive)),
		};
	}
	return out;
}

function parseClickPresetBusGainsStorage(raw: string | null): {
	byPreset: ClickPresetBusGainsMap;
	byVoice: ClickPresetBusGainsByVoiceMap;
} {
	if (!raw) return { byPreset: {}, byVoice: {} };
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (parsed && parsed.v === 2) {
			const v2 = parsed as ClickPresetBusGainsStorageV2;
			const byPreset = parseClickPresetBusGainsMapFromUnknown(v2.byPreset);
			const byVoice: ClickPresetBusGainsByVoiceMap = {};
			const rawByVoice = v2.byVoice;
			if (rawByVoice && typeof rawByVoice === 'object') {
				for (const [k, map] of Object.entries(rawByVoice as Record<string, unknown>)) {
					const voice = normalizeClickBusVoiceIndex(k);
					byVoice[voice] = parseClickPresetBusGainsMapFromUnknown(map);
				}
			}
			return { byPreset, byVoice };
		}
		return { byPreset: parseClickPresetBusGainsMapFromUnknown(parsed), byVoice: {} };
	} catch {
		return { byPreset: {}, byVoice: {} };
	}
}

function getClickPresetBusGainsForVoicePreset(
	byVoice: ClickPresetBusGainsByVoiceMap,
	byPreset: ClickPresetBusGainsMap,
	voice: number,
	preset: ClickSoundPreset,
): ClickPresetBusGains {
	const normVoice = normalizeClickBusVoiceIndex(voice);
	const voiceMap = byVoice[normVoice];
	if (voiceMap && voiceMap[preset]) return getClickPresetBusGainsForPreset(voiceMap, preset);
	if (byPreset[preset]) return getClickPresetBusGainsForPreset(byPreset, preset);
	return DEFAULT_CLICK_PRESET_BUS_GAINS;
}

const CLICK_SOUND_LIBRARY: Record<ClickSoundPreset, ClickSoundConfig> = {
	classic: {
		oscType: 'sine',
		baseFreq: 800,
		accentFreq: 920,
		altFreq: 860,
		decay: 0.04,
		decayAccent: 0.04,
		decayAlt: 0.04,
		volume: 0.4,
		volumeAccent: 0.5,
		volumeAlt: 0.44,
		layers: {
			accent: [
				{
					type: 'sine',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.5, decay: 0.04, freq: 920, hpFreq: 1200, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.04, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			alt: [
				{
					type: 'sine',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.44, decay: 0.04, freq: 860, hpFreq: 320, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.04, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			passive: [
				{
					type: 'sine',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.4, decay: 0.04, freq: 800, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.04, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
		},
	},
	oldschool: {
		oscType: 'triangle',
		baseFreq: 250,
		accentFreq: 500,
		altFreq: 320,
		decay: 0.02,
		decayAccent: 0.04,
		decayAlt: 0.03,
		sweep: true,
		volume: 0.48,
		volumeAccent: 0.9,
		volumeAlt: 0.56,
		layers: {
			accent: [
				{
					type: 'triangle',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 0.9, decay: 0.04, freq: 500, hpFreq: 1200, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.04, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			alt: [
				{
					type: 'triangle',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 0.56, decay: 0.03, freq: 320, hpFreq: 260, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.04, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			passive: [
				{
					type: 'triangle',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 0.48, decay: 0.02, freq: 250, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.04, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
		},
	},
	standard: {
		oscType: 'sine',
		baseFreq: 1000,
		accentFreq: 1500,
		altFreq: 1250,
		decay: 0.03,
		decayAccent: 0.03,
		decayAlt: 0.03,
		volume: 0.35,
		volumeAccent: 1.5,
		volumeAlt: 1.2,
		layers: {
			accent: [
				{
					type: 'sine',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 1.5, decay: 0.03, freq: 1500, hpFreq: 1490, lpFreq: 20000 },
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.03, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			alt: [
				{
					type: 'sine',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 1.2, decay: 0.03, freq: 1250, hpFreq: 1370, lpFreq: 20000 },
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.03, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			passive: [
				{
					type: 'sine',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.35, decay: 0.03, freq: 1000, hpFreq: 1120, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.03, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
		},
	},
	modern_daw: {
		oscType: 'sine',
		baseFreq: 1390,
		accentFreq: 3840,
		altFreq: 2860,
		decay: 0.015,
		decayAccent: 0.015,
		decayAlt: 0.013,
		sweep: true,
		volume: 0,
		volumeAccent: 1.1,
		volumeAlt: 1.65,
		layers: {
			accent: [
				{
					type: 'sine',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 1.1, decay: 0.015, freq: 3840, hpFreq: 140, lpFreq: 1370 },
					mute: false,
					solo: false,
				},
				{
					type: 'triangle',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 0.2, decay: 0.015, freq: 310, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			alt: [
				{
					type: 'sine',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 1.65, decay: 0.013, freq: 2860, hpFreq: 880, lpFreq: 1490 },
					mute: false,
				},
				{
					type: 'triangle',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.4, decay: 0.015, freq: 20, hpFreq: 20, lpFreq: 20000 },
					mute: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			passive: [
				{
					type: 'sine',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 0.85, decay: 0.013, freq: 1390, hpFreq: 1000, lpFreq: 20000 },
					mute: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.015, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
		},
	},
	woodblock: {
		oscType: 'triangle',
		baseFreq: 600,
		accentFreq: 800,
		altFreq: 700,
		decay: 0.05,
		decayAccent: 0.05,
		decayAlt: 0.05,
		volume: 1.5,
		volumeAccent: 1.5,
		volumeAlt: 1.5,
	},
	punchy: {
		oscType: 'sine',
		baseFreq: 500,
		accentFreq: 1000,
		altFreq: 750,
		decay: 0.05,
		decayAccent: 0.05,
		decayAlt: 0.05,
		sweep: true,
		volume: 1.5,
		volumeAccent: 1.5,
		volumeAlt: 1.5,
	},
	sharp_digital: {
		oscType: 'square',
		baseFreq: 800,
		accentFreq: 1200,
		altFreq: 1000,
		decay: 0.02,
		decayAccent: 0.02,
		decayAlt: 0.02,
		volume: 0.6,
		volumeAccent: 0.6,
		volumeAlt: 0.6,
	},
	deep_sub: {
		oscType: 'sine',
		baseFreq: 300,
		accentFreq: 400,
		altFreq: 350,
		decay: 0.06,
		decayAccent: 0.06,
		decayAlt: 0.06,
		volume: 1.5,
		volumeAccent: 1.5,
		volumeAlt: 1.5,
	},
	laser_snap: {
		oscType: 'sawtooth',
		baseFreq: 1000,
		accentFreq: 2000,
		altFreq: 1500,
		decay: 0.03,
		decayAccent: 0.03,
		decayAlt: 0.03,
		sweep: true,
		volume: 0.5,
		volumeAccent: 0.5,
		volumeAlt: 0.5,
	},
	hi_hat: {
		baseFreq: 0,
		accentFreq: 0,
		altFreq: 0,
		decay: 0.041,
		decayAlt: 0.065,
		decayAccent: 0.093,
		noise: true,
		noiseType: 'highpass',
		noiseFreq: 5600,
		noiseFreqAccent: 1390,
		altNoiseFreq: 1490,
		volume: 0.7,
		volumeAccent: 3,
		volumeAlt: 2.25,
		layers: {
			accent: [
				{
					type: 'triangle',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 3, decay: 0.093, freq: 20, hpFreq: 20, lpFreq: 630 },
					mute: false,
					solo: false,
				},
				{
					type: 'noise',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.5, decay: 0.081, freq: 1390, hpFreq: 5000, lpFreq: 12000 },
					mute: false,
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			alt: [
				{
					type: 'triangle',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 1.4, decay: 0.065, freq: 410, hpFreq: 20, lpFreq: 12000 },
					mute: false,
					solo: false,
				},
				{
					type: 'noise',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 2.25, decay: 0.065, freq: 1490, hpFreq: 5000, lpFreq: 12280 },
					mute: false,
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			passive: [
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.041, freq: 0, hpFreq: 5000, lpFreq: 12000 },
					mute: false,
				},
				{
					type: 'noise',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.7, decay: 0.041, freq: 5600, hpFreq: 5000, lpFreq: 12000 },
					mute: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
		},
	},
	glass_drop: {
		oscType: 'sine',
		baseFreq: 2500,
		accentFreq: 3500,
		altFreq: 3000,
		decay: 0.04,
		decayAccent: 0.04,
		decayAlt: 0.04,
		volume: 0.8,
		volumeAccent: 0.8,
		volumeAlt: 0.8,
		layers: {
			accent: [
				{
					type: 'sine',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.8, decay: 0.04, freq: 3500, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.04, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			alt: [
				{
					type: 'sine',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.8, decay: 0.04, freq: 3000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.04, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			passive: [
				{
					type: 'sine',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.8, decay: 0.04, freq: 2500, hpFreq: 1600, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.04, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
		},
	},
	plastic_knock: {
		oscType: 'triangle',
		sweep: true,
		volume: 0.8,
		decay: 0.025,
		baseFreq: 400,
		volumeAccent: 2.3,
		decayAccent: 0.025,
		accentFreq: 20,
		volumeAlt: 1.7,
		decayAlt: 0.025,
		altFreq: 880,
		layers: {
			accent: [
				{
					type: 'triangle',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 2.3, decay: 0.025, freq: 20, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.025, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			alt: [
				{
					type: 'triangle',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 1.7, decay: 0.025, freq: 880, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.025, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			passive: [
				{
					type: 'triangle',
					sweep: true,
					noiseFilterType: 'highpass',
					params: { volume: 0.8, decay: 0.025, freq: 400, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.025, freq: 1000, hpFreq: 20, lpFreq: 20000 },
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
		},
	},
	metallic: {
		oscType: 'square',
		baseFreq: 1500,
		accentFreq: 2500,
		altFreq: 2000,
		decay: 0.015,
		decayAccent: 0.015,
		decayAlt: 0.015,
		noise: true,
		noiseType: 'highpass',
		noiseFreq: 4000,
		altNoiseFreq: 5000,
		volume: 0.4,
		volumeAccent: 0.4,
		volumeAlt: 0.4,
	},
	clock_tick: {
		baseFreq: 0,
		accentFreq: 0,
		altFreq: 0,
		decay: 0.01,
		decayAccent: 0.01,
		decayAlt: 0.017,
		noise: true,
		noiseType: 'highpass',
		noiseFreq: 2500,
		noiseFreqAccent: 4800,
		altNoiseFreq: 3700,
		volume: 0.5,
		volumeAccent: 2.2,
		volumeAlt: 1.7,
	},
	cowbell: {
		oscType: 'square',
		baseFreq: 540,
		accentFreq: 800,
		altFreq: 800,
		decay: 0.08,
		decayAccent: 0.15,
		decayAlt: 0.1,
		volume: 0.8,
		volumeAccent: 1.2,
		volumeAlt: 1,
		layers: {
			accent: [
				{
					type: 'square',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 1.2, decay: 0.15, freq: 540, hpFreq: 400, lpFreq: 4000 },
					mute: false,
					solo: false,
				},
				{
					type: 'square',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.9, decay: 0.15, freq: 800, hpFreq: 400, lpFreq: 4000 },
					mute: false,
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			alt: [
				{
					type: 'square',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 1, decay: 0.1, freq: 540, hpFreq: 400, lpFreq: 4000 },
					mute: false,
					solo: false,
				},
				{
					type: 'square',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.7, decay: 0.1, freq: 800, hpFreq: 400, lpFreq: 4000 },
					mute: false,
					solo: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
			passive: [
				{
					type: 'square',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.8, decay: 0.08, freq: 540, hpFreq: 400, lpFreq: 4000 },
					mute: false,
				},
				{
					type: 'square',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0.6, decay: 0.08, freq: 800, hpFreq: 400, lpFreq: 4000 },
					mute: false,
				},
				{
					type: 'none',
					sweep: false,
					noiseFilterType: 'highpass',
					params: { volume: 0, decay: 0.1, freq: 1000, hpFreq: 20, lpFreq: 20000 },
					mute: false,
					solo: false,
				},
			],
		},
	},
	analog_synth: {
		oscType: 'sawtooth',
		baseFreq: 500,
		accentFreq: 800,
		altFreq: 650,
		decay: 0.04,
		decayAccent: 0.04,
		decayAlt: 0.04,
		volume: 0.5,
		volumeAccent: 0.5,
		volumeAlt: 0.5,
	},
	vinyl_crackle: {
		baseFreq: 0,
		accentFreq: 0,
		altFreq: 0,
		decay: 0.04,
		decayAccent: 0.04,
		decayAlt: 0.04,
		noise: true,
		noiseType: 'bandpass',
		noiseFreq: 3900,
		noiseFreqAccent: 6000,
		altNoiseFreq: 5500,
		volume: 0.4,
		volumeAccent: 2.2,
		volumeAlt: 1.6,
	},
	dry_click: {
		oscType: 'square',
		baseFreq: 1200,
		accentFreq: 1600,
		altFreq: 1400,
		decay: 0.008,
		decayAccent: 0.008,
		decayAlt: 0.008,
		volume: 0.5,
		volumeAccent: 1.2,
		volumeAlt: 1.1,
	},
	soft_ping: {
		oscType: 'sine',
		baseFreq: 700,
		accentFreq: 900,
		altFreq: 800,
		decay: 0.1,
		decayAccent: 0.1,
		decayAlt: 0.1,
		volume: 1.2,
		volumeAccent: 1.2,
		volumeAlt: 1.2,
	},
	noise_burst: {
		baseFreq: 0,
		accentFreq: 0,
		altFreq: 0,
		decay: 0.05,
		decayAccent: 0.05,
		decayAlt: 0.05,
		noise: true,
		noiseType: 'lowpass',
		noiseFreq: 5000,
		noiseFreqAccent: 7500,
		altNoiseFreq: 6300,
		volume: 0.3,
		volumeAccent: 1.6,
		volumeAlt: 1.1,
	},
	eight_bit: {
		oscType: 'square',
		baseFreq: 440,
		accentFreq: 660,
		altFreq: 550,
		decay: 0.023,
		decayAccent: 0.023,
		decayAlt: 0.023,
		sweep: true,
		volume: 0.2,
		volumeAccent: 0.9,
		volumeAlt: 0.6,
	},
};

function isClickSoundPreset(value: unknown): value is ClickSoundPreset {
	return typeof value === 'string' && CLICK_SOUND_PRESET_ORDER.includes(value as ClickSoundPreset);
}

type ClickSoundUiPreset = {
	id: string;
	label: string;
	mappedSound: ClickSoundPreset;
};
const CLICK_SOUND_PRESET_META: ClickSoundUiPreset[] = [
	{ id: 'preset-01', label: 'Classic', mappedSound: 'classic' },
	{ id: 'preset-02', label: 'Old School', mappedSound: 'oldschool' },
	{ id: 'preset-03', label: 'Standard', mappedSound: 'standard' },
	{ id: 'preset-04', label: 'Modern DAW', mappedSound: 'modern_daw' },
	{ id: 'preset-05', label: 'Woodblock', mappedSound: 'woodblock' },
	{ id: 'preset-06', label: 'Punchy', mappedSound: 'punchy' },
	{ id: 'preset-07', label: 'Sharp Digital', mappedSound: 'sharp_digital' },
	{ id: 'preset-08', label: 'Deep Sub', mappedSound: 'deep_sub' },
	{ id: 'preset-10', label: 'Drum machine', mappedSound: 'hi_hat' },
	{ id: 'preset-11', label: 'Glass Drop', mappedSound: 'glass_drop' },
	{ id: 'preset-12', label: 'Plastic Knock', mappedSound: 'plastic_knock' },
	{ id: 'preset-13', label: 'Metallic', mappedSound: 'metallic' },
	{ id: 'preset-14', label: 'Clock Tick', mappedSound: 'clock_tick' },
	{ id: 'preset-15', label: '808 Cowbell', mappedSound: 'cowbell' },
	{ id: 'preset-16', label: 'Analog Synth', mappedSound: 'analog_synth' },
	{ id: 'preset-17', label: 'Cajon', mappedSound: 'vinyl_crackle' },
	{ id: 'preset-18', label: 'Dry Click', mappedSound: 'dry_click' },
	{ id: 'preset-19', label: 'Soft Ping', mappedSound: 'soft_ping' },
	{ id: 'preset-20', label: 'Noise Burst', mappedSound: 'noise_burst' },
	{ id: 'preset-21', label: '8-Bit', mappedSound: 'eight_bit' },
];

function buildSnapshotGridToken(s: ReturnType<typeof createEmptySnapshot>): string {
	const accents = s.accents instanceof Set ? s.accents : new Set(Array.isArray(s.accents) ? s.accents : []);
	let bits = '';
	for (let r = 0; r < s.bars; r++) {
		for (let c = 0; c < s.syllables; c++) {
			bits += accents.has(`${r}-${c}`) ? '1' : '0';
		}
	}
	if (!bits || /^0+$/.test(bits)) return '0';
	const fullHex = BigInt(`0b${bits}`).toString(16);
	const trailingZeros = bits.match(/0+$/)?.[0].length ?? 0;
	const coreLen = bits.length - trailingZeros;
	const coreBits = coreLen > 0 ? bits.slice(0, coreLen) : '0';
	const coreHex = BigInt(`0b${coreBits}`).toString(16);
	const compressed = trailingZeros > 0 ? `${coreHex}~${trailingZeros.toString(36)}` : coreHex;
	return compressed.length < fullHex.length ? compressed : fullHex;
}

function hydrateSnapshotAccentsFromGridToken(
	gridToken: string,
	bars: number,
	syllables: number,
	d: ReturnType<typeof createEmptySnapshot>,
) {
	const totalCells = bars * syllables;
	if (totalCells <= 0) {
		d.accents = new Set<string>();
		return;
	}
	const normalizedToken = gridToken.trim().toLowerCase();
	if (!normalizedToken) return;
	let normalizedHex = normalizedToken;
	let trailingZeros = 0;
	if (normalizedToken.includes('~')) {
		const [hexPart, tzPart] = normalizedToken.split('~');
		if (!hexPart || tzPart === undefined || tzPart.length === 0) return;
		if (!/^[0-9a-f]+$/.test(hexPart)) return;
		const tz = parseInt(tzPart, 36);
		if (!Number.isFinite(tz) || tz < 0 || tz > totalCells) return;
		normalizedHex = hexPart;
		trailingZeros = tz;
	} else {
		if (!/^[0-9a-f]+$/.test(normalizedHex)) return;
	}
	// BigInt is mandatory here to safely parse masks >53 bits.
	let bits = BigInt(`0x${normalizedHex}`).toString(2);
	if (trailingZeros > 0) {
		const coreLen = Math.max(0, totalCells - trailingZeros);
		if (bits.length < coreLen) bits = bits.padStart(coreLen, '0');
		if (bits.length > coreLen) bits = bits.slice(bits.length - coreLen);
		bits += '0'.repeat(trailingZeros);
	}
	if (bits.length < totalCells) bits = bits.padStart(totalCells, '0');
	if (bits.length > totalCells) bits = bits.slice(bits.length - totalCells);
	const nextAccents = new Set<string>();
	let idx = 0;
	for (let r = 0; r < bars; r++) {
		for (let c = 0; c < syllables; c++) {
			if (bits[idx] === '1') nextAccents.add(`${r}-${c}`);
			idx++;
		}
	}
	d.accents = nextAccents;
}

function encodeSparseRowNumberMap(
	map: Record<number, number>,
	isAllowed: (value: number) => boolean,
): string {
	const parts: string[] = [];
	for (const [k, raw] of Object.entries(map)) {
		const row = parseInt(k, 10);
		const value = parseInt(String(raw), 10);
		if (!Number.isFinite(row) || row < 0 || !Number.isFinite(value) || !isAllowed(value)) continue;
		parts.push(`${row.toString(36)}:${value.toString(36)}`);
	}
	if (parts.length === 0) return '0';
	parts.sort();
	return parts.join('_');
}

function decodeSparseRowNumberMap(
	token: string,
	isAllowed: (value: number) => boolean,
): Record<number, number> {
	if (!token || token === '0') return {};
	const out: Record<number, number> = {};
	for (const chunk of token.split('_')) {
		const [rowRaw, valueRaw] = chunk.split(':');
		if (!rowRaw || !valueRaw) continue;
		const row = parseInt(rowRaw, 36);
		const value = parseInt(valueRaw, 36);
		if (!Number.isFinite(row) || row < 0 || !Number.isFinite(value) || !isAllowed(value)) continue;
		out[row] = value;
	}
	return out;
}

function encodePulseUnlinkedRowsToken(rows: Record<number, boolean>): string {
	const out: string[] = [];
	for (const [k, raw] of Object.entries(rows)) {
		const row = parseInt(k, 10);
		if (!Number.isFinite(row) || row < 0 || raw !== true) continue;
		out.push(row.toString(36));
	}
	if (out.length === 0) return '0';
	out.sort();
	return out.join('_');
}

function decodePulseUnlinkedRowsToken(token: string): Record<number, boolean> {
	if (!token || token === '0') return {};
	const out: Record<number, boolean> = {};
	for (const piece of token.split('_')) {
		const row = parseInt(piece, 36);
		if (!Number.isFinite(row) || row < 0) continue;
		out[row] = true;
	}
	return out;
}

function canRowUseZeroDeadStart(_polyMode: boolean, _polyVoices: number, _row: number): boolean {
	// Manual dead-cells editor + snapshot round-trip: deadStart may be 0 on any row.
	// Random dead-cells still enforce at least one live cell via randomLogic activeCount floor.
	return true;
}

function encodeDeadCellsToken(deadCells: DeadCellsMap, bars: number, polyMode: boolean, polyVoices: number): string {
	const parts: string[] = [];
	for (const [rk, meta] of Object.entries(deadCells || {})) {
		const row = parseInt(rk, 10);
		if (!Number.isFinite(row) || row < 0 || row >= bars) continue;
		const minDeadStart = canRowUseZeroDeadStart(polyMode, polyVoices, row) ? 0 : 1;
		const deadStart = Math.max(minDeadStart, Math.min(9, Math.floor(meta.deadStart)));
		const displayLen = Math.max(1, Math.min(9, Math.floor(meta.displayLen)));
		const baseLen = Math.max(1, Math.min(9, Math.floor(meta.baseLen)));
		parts.push(`${row.toString(36)}:${deadStart.toString(36)}${displayLen.toString(36)}${baseLen.toString(36)}`);
	}
	if (parts.length === 0) return '0';
	parts.sort();
	return parts.join('_');
}

function decodeDeadCellsToken(token: string, bars: number, polyMode: boolean, polyVoices: number): DeadCellsMap {
	if (!token || token === '0') return {};
	const out: DeadCellsMap = {};
	for (const chunk of token.split('_')) {
		const [rowRaw, packed] = chunk.split(':');
		if (!rowRaw || !packed || packed.length < 3) continue;
		const row = parseInt(rowRaw, 36);
		if (!Number.isFinite(row) || row < 0 || row >= bars) continue;
		const deadStart = parseInt(packed[0]!, 36);
		const displayLen = parseInt(packed[1]!, 36);
		const baseLen = parseInt(packed[2]!, 36);
		if (!Number.isFinite(deadStart) || !Number.isFinite(displayLen) || !Number.isFinite(baseLen)) continue;
		const minDeadStart = canRowUseZeroDeadStart(polyMode, polyVoices, row) ? 0 : 1;
		out[row] = {
			deadStart: Math.max(minDeadStart, Math.min(9, deadStart)),
			displayLen: Math.max(1, Math.min(9, displayLen)),
			baseLen: Math.max(1, Math.min(9, baseLen)),
		};
	}
	return out;
}

function buildCellIndexMapForSnapshot(
	bars: number,
	syllables: number,
	customSyllables: Record<number, number>,
): Array<{ key: string }> {
	const cells: Array<{ key: string }> = [];
	for (let r = 0; r < bars; r++) {
		const rowSylls = customSyllables[r] !== undefined ? customSyllables[r] : syllables;
		for (let c = 0; c < rowSylls; c++) {
			cells.push({ key: `${r}-${c}` });
		}
	}
	return cells;
}

function buildAccentTokenForVariableGrid(accents: Set<string>, cells: Array<{ key: string }>): string {
	if (cells.length === 0) return '0';
	let bits = '';
	for (const cell of cells) bits += accents.has(cell.key) ? '1' : '0';
	if (!bits || /^0+$/.test(bits)) return '0';
	const fullHex = BigInt(`0b${bits}`).toString(16);
	const trailingZeros = bits.match(/0+$/)?.[0].length ?? 0;
	const coreLen = bits.length - trailingZeros;
	const coreBits = coreLen > 0 ? bits.slice(0, coreLen) : '0';
	const coreHex = BigInt(`0b${coreBits}`).toString(16);
	return trailingZeros > 0 ? `${coreHex}~${trailingZeros.toString(36)}` : fullHex;
}

function hydrateAccentsFromVariableGridToken(token: string, cells: Array<{ key: string }>): Set<string> {
	const totalCells = cells.length;
	if (!token || token === '0' || totalCells === 0) return new Set<string>();
	const normalizedToken = token.toLowerCase();
	let normalizedHex = normalizedToken;
	let trailingZeros = 0;
	if (normalizedToken.includes('~')) {
		const [hexPart, tzPart] = normalizedToken.split('~');
		if (!hexPart || tzPart === undefined || tzPart.length === 0) return new Set<string>();
		if (!/^[0-9a-f]+$/.test(hexPart)) return new Set<string>();
		const tz = parseInt(tzPart, 36);
		if (!Number.isFinite(tz) || tz < 0 || tz > totalCells) return new Set<string>();
		normalizedHex = hexPart;
		trailingZeros = tz;
	} else if (!/^[0-9a-f]+$/.test(normalizedHex)) {
		return new Set<string>();
	}
	let bits = BigInt(`0x${normalizedHex}`).toString(2);
	if (trailingZeros > 0) {
		const coreLen = Math.max(0, totalCells - trailingZeros);
		if (bits.length < coreLen) bits = bits.padStart(coreLen, '0');
		if (bits.length > coreLen) bits = bits.slice(bits.length - coreLen);
		bits += '0'.repeat(trailingZeros);
	}
	if (bits.length < totalCells) bits = bits.padStart(totalCells, '0');
	if (bits.length > totalCells) bits = bits.slice(bits.length - totalCells);
	const out = new Set<string>();
	for (let i = 0; i < totalCells; i++) {
		if (bits[i] === '1') out.add(cells[i]!.key);
	}
	return out;
}

function encodeSubdivisionsToken(
	customSubdivisions: Record<string, number>,
	cells: Array<{ key: string }>,
): string {
	const out: string[] = [];
	for (let idx = 0; idx < cells.length; idx++) {
		const key = cells[idx]!.key;
		const val = customSubdivisions[key];
		if (typeof val !== 'number' || val < 1 || val > 9 || val === 1) continue;
		out.push(`${idx.toString(36)}:${val.toString(36)}`);
	}
	if (out.length === 0) return '0';
	return out.join('_');
}

function decodeSubdivisionsToken(token: string, cells: Array<{ key: string }>): Record<string, number> {
	if (!token || token === '0') return {};
	const out: Record<string, number> = {};
	for (const piece of token.split('_')) {
		const [idxRaw, valRaw] = piece.split(':');
		if (!idxRaw || !valRaw) continue;
		const idx = parseInt(idxRaw, 36);
		const val = parseInt(valRaw, 36);
		if (!Number.isFinite(idx) || idx < 0 || idx >= cells.length) continue;
		if (!Number.isFinite(val) || val < 1 || val > 9 || val === 1) continue;
		out[cells[idx]!.key] = val;
	}
	return out;
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(token: string): Uint8Array | null {
	const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
	const pad = (4 - (b64.length % 4)) % 4;
	const padded = b64 + '='.repeat(pad);
	try {
		const bin = atob(padded);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
		return out;
	} catch {
		return null;
	}
}

function pushU16(out: number[], value: number) {
	out.push((value >> 8) & 0xff, value & 0xff);
}

function readU16(bytes: Uint8Array, offset: number): number | null {
	if (offset + 1 >= bytes.length) return null;
	return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

/** FRAGILE — binary grid blob; any field order/length/version change breaks paste for old shares. */
function packGridTokenPacked(
	snapshot: ReturnType<typeof createEmptySnapshot>,
	cells: Array<{ key: string }>,
	accents: Set<string>,
): string {
	const out: number[] = [];
	const bars = Math.max(1, Math.min(255, snapshot.bars));
	const syllables = Math.max(1, Math.min(9, snapshot.syllables));
	const useV2 = (snapshot.accentMapVersion ?? 0) >= 1;
	const useV3 = true; // v3: adds taDing bitmap; backward parser keeps p1/p2 support.
	const hasStepMasks = Object.keys(snapshot.cellStepMasks || {}).length > 0;
	const gridVersion = hasStepMasks ? 0x04 : (useV3 ? 0x03 : useV2 ? 0x02 : 0x01);
	out.push(0x50, gridVersion, bars, syllables);

	const rowEntries = Object.entries(snapshot.customSyllables)
		.map(([k, v]) => [parseInt(k, 10), parseInt(String(v), 10)] as const)
		.filter(([r, v]) => Number.isFinite(r) && r >= 0 && r < bars && Number.isFinite(v) && v >= 1 && v <= 9)
		.sort((a, b) => a[0] - b[0]);
	out.push(Math.min(255, rowEntries.length));
	for (let i = 0; i < Math.min(255, rowEntries.length); i++) {
		const [r, v] = rowEntries[i]!;
		out.push(r & 0xff, v & 0xff);
	}

	pushU16(out, Math.min(65535, cells.length));
	let accByte = 0;
	let accBit = 0;
	for (let i = 0; i < cells.length; i++) {
		if (accents.has(cells[i]!.key)) accByte |= 1 << accBit;
		accBit++;
		if (accBit === 8) {
			out.push(accByte);
			accByte = 0;
			accBit = 0;
		}
	}
	if (accBit !== 0) out.push(accByte);

	if (gridVersion >= 0x03) {
		let taByte = 0;
		let taBit = 0;
		for (let i = 0; i < cells.length; i++) {
			if (snapshot.taDingKeys.has(cells[i]!.key)) taByte |= 1 << taBit;
			taBit++;
			if (taBit === 8) {
				out.push(taByte);
				taByte = 0;
				taBit = 0;
			}
		}
		if (taBit !== 0) out.push(taByte);
	}

	const subEntries: Array<[number, number]> = [];
	for (let i = 0; i < cells.length; i++) {
		const v = snapshot.customSubdivisions[cells[i]!.key];
		if (typeof v === 'number' && v >= 2 && v <= 9) subEntries.push([i, v]);
	}
	pushU16(out, Math.min(65535, subEntries.length));
	for (let i = 0; i < Math.min(65535, subEntries.length); i++) {
		const [idx, v] = subEntries[i]!;
		pushU16(out, idx);
		out.push(v & 0xff);
	}

	const multEntries = Object.entries(snapshot.customMultipliers)
		.map(([k, v]) => [parseInt(k, 10), parseInt(String(v), 10)] as const)
		.filter(([r, v]) => Number.isFinite(r) && r >= 0 && r < bars && Number.isFinite(v) && v >= 2 && v <= 4)
		.sort((a, b) => a[0] - b[0]);
	out.push(Math.min(255, multEntries.length));
	for (let i = 0; i < Math.min(255, multEntries.length); i++) {
		const [r, v] = multEntries[i]!;
		out.push(r & 0xff, v & 0xff);
	}

	const pulseRows = Object.entries(snapshot.pulseMeterUnlinked || {})
		.map(([k, v]) => [parseInt(k, 10), Boolean(v)] as const)
		.filter(([r, v]) => Number.isFinite(r) && r >= 0 && r < bars && v)
		.map(([r]) => r)
		.sort((a, b) => a - b);
	out.push(Math.min(255, pulseRows.length));
	for (let i = 0; i < Math.min(255, pulseRows.length); i++) out.push(pulseRows[i]! & 0xff);

	// p3: always write map-version byte (0/1), so decode never falls back to legacy=0 and does not auto-draw Ta on beat 0.
	if (gridVersion >= 0x03) {
		out.push(((snapshot.accentMapVersion ?? 0) >= 1 ? 1 : 0) & 0xff);
	} else if (useV2) {
		out.push(Math.min(255, Math.max(0, Math.floor(snapshot.accentMapVersion ?? 1))) & 0xff);
	}
	if (gridVersion >= 0x04) {
		const maskEntries: Array<[number, number, number]> = [];
		for (let i = 0; i < cells.length; i++) {
			const cellKey = cells[i]!.key;
			const subdivs = snapshot.customSubdivisions[cellKey] ?? 1;
			const mask = resolveEffectiveStepMask(cellKey, subdivs, snapshot.cellStepMasks || {});
			if (mask.every((x) => x === true)) continue;
			let bits = 0;
			for (let b = 0; b < mask.length; b++) {
				if (mask[b]) bits |= (1 << b);
			}
			maskEntries.push([i, mask.length, bits]);
		}
		pushU16(out, Math.min(65535, maskEntries.length));
		for (let i = 0; i < Math.min(65535, maskEntries.length); i++) {
			const [idx, len, bits] = maskEntries[i]!;
			pushU16(out, idx);
			out.push(len & 0xff, bits & 0xff, (bits >> 8) & 0xff);
		}
	}

	const prefix = gridVersion === 0x04 ? 'p4' : gridVersion === 0x03 ? 'p3' : useV2 ? 'p2' : 'p1';
	return `${prefix}${toBase64Url(new Uint8Array(out))}`;
}

/** FRAGILE — must stay symmetric to packGridTokenPacked; invalid lengths silently corrupt grids. */
function unpackGridTokenPacked(
	token: string,
	d: ReturnType<typeof createEmptySnapshot>,
): boolean {
	let b64 = token;
	if (token.startsWith('p4')) b64 = token.slice(2);
	else if (token.startsWith('p3')) b64 = token.slice(2);
	else if (token.startsWith('p2')) b64 = token.slice(2);
	else if (token.startsWith('p1')) b64 = token.slice(2);
	else return false;
	const bytes = fromBase64Url(b64);
	if (!bytes || bytes.length < 6) return false;
	let off = 0;
	const magic = bytes[off++]!;
	const version = bytes[off++]!;
	if (magic !== 0x50 || (version !== 0x01 && version !== 0x02 && version !== 0x03 && version !== 0x04)) return false;
	const bars = bytes[off++]!;
	const syllables = bytes[off++]!;
	if (bars < 1 || bars > 100 || syllables < 1 || syllables > 9) return false;
	d.bars = bars;
	d.syllables = syllables;

	const rowCount = bytes[off++]!;
	const nextCustomSyllables: Record<number, number> = {};
	for (let i = 0; i < rowCount; i++) {
		if (off + 1 >= bytes.length) return false;
		const r = bytes[off++]!;
		const v = bytes[off++]!;
		if (r < bars && v >= 1 && v <= 9) nextCustomSyllables[r] = v;
	}
	d.customSyllables = nextCustomSyllables;

	const cellCount = readU16(bytes, off);
	if (cellCount === null) return false;
	off += 2;
	const cells = buildCellIndexMapForSnapshot(d.bars, d.syllables, d.customSyllables);
	const cappedCellCount = Math.min(cellCount, cells.length);
	const accBytesLen = Math.ceil(cappedCellCount / 8);
	if (off + accBytesLen > bytes.length) return false;
	const nextAccents = new Set<string>();
	for (let i = 0; i < cappedCellCount; i++) {
		const byte = bytes[off + (i >> 3)]!;
		if (((byte >> (i & 7)) & 1) === 1) nextAccents.add(cells[i]!.key);
	}
	off += accBytesLen;
	d.accents = nextAccents;

	if (version >= 0x03) {
		const taBytesLen = Math.ceil(cappedCellCount / 8);
		if (off + taBytesLen > bytes.length) return false;
		const nextTa = new Set<string>();
		for (let i = 0; i < cappedCellCount; i++) {
			const byte = bytes[off + (i >> 3)]!;
			if (((byte >> (i & 7)) & 1) === 1) nextTa.add(cells[i]!.key);
		}
		off += taBytesLen;
		d.taDingKeys = nextTa;
	}

	const subCount = readU16(bytes, off);
	if (subCount === null) return false;
	off += 2;
	const nextSub: Record<string, number> = {};
	for (let i = 0; i < subCount; i++) {
		const idx = readU16(bytes, off);
		if (idx === null) return false;
		off += 2;
		if (off >= bytes.length) return false;
		const v = bytes[off++]!;
		if (idx < cells.length && v >= 2 && v <= 9) nextSub[cells[idx]!.key] = v;
	}
	d.customSubdivisions = nextSub;

	if (off >= bytes.length) return false;
	const multCount = bytes[off++]!;
	const nextMult: Record<number, number> = {};
	for (let i = 0; i < multCount; i++) {
		if (off + 1 >= bytes.length) return false;
		const r = bytes[off++]!;
		const v = bytes[off++]!;
		if (r < bars && v >= 2 && v <= 4) nextMult[r] = v;
	}
	d.customMultipliers = nextMult;

	if (off >= bytes.length) return false;
	const pulseCount = bytes[off++]!;
	const nextPulse: Record<number, boolean> = {};
	for (let i = 0; i < pulseCount; i++) {
		if (off >= bytes.length) return false;
		const r = bytes[off++]!;
		if (r < bars) nextPulse[r] = true;
	}
	d.pulseMeterUnlinked = nextPulse;
	if (version === 0x02) {
		if (off < bytes.length) {
			const v = bytes[off++]!;
			d.accentMapVersion = v >= 1 ? 1 : 0;
		} else {
			d.accentMapVersion = 1;
		}
	} else if (version === 0x03 || version === 0x04) {
		// In p3, Ta bit-map is explicit; without trailing byte, old blobs are still treated as explicit map (not legacy).
		if (off < bytes.length) {
			const v = bytes[off++]!;
			d.accentMapVersion = v >= 1 ? 1 : 0;
		} else {
			d.accentMapVersion = 1;
		}
	}
	if (version >= 0x04) {
		const maskCount = readU16(bytes, off);
		if (maskCount === null) return false;
		off += 2;
		const nextMasks: CellStepMasks = {};
		for (let i = 0; i < maskCount; i++) {
			const idx = readU16(bytes, off);
			if (idx === null) return false;
			off += 2;
			if (off + 2 >= bytes.length) return false;
			const len = bytes[off++]!;
			const lo = bytes[off++]!;
			const hi = bytes[off++]!;
			if (idx >= cells.length || len < 1 || len > 9) continue;
			const bits = lo | (hi << 8);
			const arr = Array.from({ length: len }, (_, b) => ((bits >> b) & 1) === 1);
			if (!arr.every((x) => x === true)) nextMasks[cells[idx]!.key] = arr;
		}
		d.cellStepMasks = nextMasks;
	}
	return true;
}

/** FRAGILE — single integer in clipboard string; bit positions are part of the public wire format. */
function buildSnapshotFlags(s: ReturnType<typeof createEmptySnapshot>): number {
	let flags = 0;
	if (s.randomModeEnabled) flags |= SNAPSHOT_FLAG_RANDOM_MODE_ENABLED;
	if (s.randomPulsation) flags |= SNAPSHOT_FLAG_RANDOM_PULSATION;
	if (s.randomPattern) flags |= SNAPSHOT_FLAG_RANDOM_PATTERN;
	if (s.randomSpeed) flags |= SNAPSHOT_FLAG_RANDOM_SPEED;
	if (s.randomBarSpeed) flags |= SNAPSHOT_FLAG_RANDOM_BAR_SPEED;
	if (s.panelExpanded) flags |= SNAPSHOT_FLAG_PANEL_EXPANDED;
	if (s.onlyAccents) flags |= SNAPSHOT_FLAG_ONLY_ACCENTS;
	if (s.firstBeatAccent) flags |= SNAPSHOT_FLAG_FIRST_BEAT_ACCENT;
	if (s.polyMode) flags |= SNAPSHOT_FLAG_POLY_MODE;
	if (s.polyVoices === 3) flags |= SNAPSHOT_FLAG_POLY_VOICES_3;
	// if (s.polyVoices === 4) flags |= SNAPSHOT_FLAG_POLY_VOICES_4; // 4-voice polyrythm temporarily disabled
	if (s.randomMode === 'parent') flags |= SNAPSHOT_FLAG_PARENT_MODE;
	flags |= SNAPSHOT_FLAG_MODE_FIELDS_PRESENT;
	if (s.trainerHoldMute) flags |= SNAPSHOT_FLAG_TRAINER_HOLD_MUTE;
	if (s.squarePassiveLayerMuted) flags |= SNAPSHOT_FLAG_SQUARE_PASSIVE_LAYER_MUTED;
	if (s.dictantMode) flags |= SNAPSHOT_FLAG_DICTANT_MODE;
	const mixerBits =
		s.mixerLayerMode === 'no_alt' ? 1
		: s.mixerLayerMode === 'alt_only' ? 2
		: 0;
	const trainerBits =
		s.trainerMode === 'ta_only' ? 1
		: s.trainerMode === 'dictation' ? 2
		: 0;
	const squareBits =
		s.squarePlaybackMode === 'passive_no_alt' ? 1
		: s.squarePlaybackMode === 'ta_only' ? 2
		: 0;
	const muteBits =
		s.syllableReadMuteMode === 'full' ? 1
		: s.syllableReadMuteMode === 'no_accent_sharp' ? 2
		: 0;
	flags |= (mixerBits << SNAPSHOT_FLAG_MIXER_LAYER_SHIFT) & SNAPSHOT_FLAG_MIXER_LAYER_MASK;
	flags |= (trainerBits << SNAPSHOT_FLAG_TRAINER_MODE_SHIFT) & SNAPSHOT_FLAG_TRAINER_MODE_MASK;
	flags |= (squareBits << SNAPSHOT_FLAG_SQUARE_PLAYBACK_SHIFT) & SNAPSHOT_FLAG_SQUARE_PLAYBACK_MASK;
	flags |= (muteBits << SNAPSHOT_FLAG_SYLLABLE_MUTE_SHIFT) & SNAPSHOT_FLAG_SYLLABLE_MUTE_MASK;
	return flags;
}

/** FRAGILE — inverse of buildSnapshotFlags; bit drift breaks paste, poly voice count, and first-beat Ta. */
function applySnapshotFlags(flags: number, d: ReturnType<typeof createEmptySnapshot>) {
	d.randomModeEnabled = Boolean(flags & SNAPSHOT_FLAG_RANDOM_MODE_ENABLED);
	d.randomPulsation = Boolean(flags & SNAPSHOT_FLAG_RANDOM_PULSATION);
	d.randomPattern = Boolean(flags & SNAPSHOT_FLAG_RANDOM_PATTERN);
	d.randomSpeed = Boolean(flags & SNAPSHOT_FLAG_RANDOM_SPEED);
	d.randomBarSpeed = Boolean(flags & SNAPSHOT_FLAG_RANDOM_BAR_SPEED);
	d.panelExpanded = Boolean(flags & SNAPSHOT_FLAG_PANEL_EXPANDED);
	d.onlyAccents = Boolean(flags & SNAPSHOT_FLAG_ONLY_ACCENTS);
	d.firstBeatAccent = Boolean(flags & SNAPSHOT_FLAG_FIRST_BEAT_ACCENT);
	d.polyMode = Boolean(flags & SNAPSHOT_FLAG_POLY_MODE);
	// d.polyVoices = (flags & SNAPSHOT_FLAG_POLY_VOICES_4)
	// 	? 4
	// 	: (flags & SNAPSHOT_FLAG_POLY_VOICES_3)
	// 		? 3
	// 		: 2;
	// 4-voice polyrythm temporarily disabled.
	d.polyVoices = (flags & SNAPSHOT_FLAG_POLY_VOICES_3) ? 3 : 2;
	d.randomMode = flags & SNAPSHOT_FLAG_PARENT_MODE ? 'parent' : 'free';
	if (flags & SNAPSHOT_FLAG_MODE_FIELDS_PRESENT) {
		d.trainerHoldMute = Boolean(flags & SNAPSHOT_FLAG_TRAINER_HOLD_MUTE);
		d.squarePassiveLayerMuted = Boolean(flags & SNAPSHOT_FLAG_SQUARE_PASSIVE_LAYER_MUTED);
		d.dictantMode = Boolean(flags & SNAPSHOT_FLAG_DICTANT_MODE);
		const mixerBits = (flags & SNAPSHOT_FLAG_MIXER_LAYER_MASK) >>> SNAPSHOT_FLAG_MIXER_LAYER_SHIFT;
		const trainerBits = (flags & SNAPSHOT_FLAG_TRAINER_MODE_MASK) >>> SNAPSHOT_FLAG_TRAINER_MODE_SHIFT;
		const squareBits = (flags & SNAPSHOT_FLAG_SQUARE_PLAYBACK_MASK) >>> SNAPSHOT_FLAG_SQUARE_PLAYBACK_SHIFT;
		const muteBits = (flags & SNAPSHOT_FLAG_SYLLABLE_MUTE_MASK) >>> SNAPSHOT_FLAG_SYLLABLE_MUTE_SHIFT;
		d.mixerLayerMode =
			mixerBits === 1 ? 'no_alt'
			: mixerBits === 2 ? 'alt_only'
			: DEFAULT_MIXER_LAYER_MODE;
		d.trainerMode =
			trainerBits === 1 ? 'ta_only'
			: trainerBits === 2 ? 'dictation'
			: DEFAULT_TRAINER_MODE;
		d.squarePlaybackMode =
			squareBits === 1 ? 'passive_no_alt'
			: squareBits === 2 ? 'ta_only'
			: DEFAULT_SQUARE_PLAYBACK_MODE;
		d.syllableReadMuteMode =
			muteBits === 1 ? 'full'
			: muteBits === 2 ? 'no_accent_sharp'
			: 'off';
	}
}

function buildSnapshotSoundId(s: ReturnType<typeof createEmptySnapshot>): number {
	const idx = CLICK_SOUND_PRESET_ORDER.indexOf(s.clickSound);
	return idx >= 0 ? idx : SNAPSHOT_SOUND_ID_CLASSIC;
}

function applySnapshotSoundId(soundId: number, d: ReturnType<typeof createEmptySnapshot>) {
	if (soundId === SNAPSHOT_SOUND_ID_OLDSCHOOL) {
		d.clickSound = 'oldschool';
		return;
	}
	if (soundId >= 0 && soundId < CLICK_SOUND_PRESET_ORDER.length) {
		d.clickSound = CLICK_SOUND_PRESET_ORDER[soundId]!;
		return;
	}
	d.clickSound = 'classic';
}

function buildSnapshotSoundToken(s: ReturnType<typeof createEmptySnapshot>): string {
	const soundId = buildSnapshotSoundId(s);
	const byVoice = normalizeClickSoundByPolyVoice((s as { clickSoundByPolyVoice?: unknown }).clickSoundByPolyVoice);
	const entries = Object.entries(byVoice)
		.map(([voiceRaw, preset]) => {
			const voice = parseInt(voiceRaw, 10);
			const presetId = CLICK_SOUND_PRESET_ORDER.indexOf(preset);
			if (!Number.isFinite(voice) || voice < 0 || voice > 3) return null;
			if (presetId < 0) return null;
			return `${voice}:${presetId.toString(36)}`;
		})
		.filter((chunk): chunk is string => typeof chunk === 'string')
		.sort();
	if (entries.length === 0) return String(soundId);
	return `${soundId}~${entries.join('_')}`;
}

function applySnapshotSoundToken(soundRaw: string, d: ReturnType<typeof createEmptySnapshot>) {
	const token = String(soundRaw ?? '').trim();
	const [baseRaw, byVoiceRaw] = token.split('~', 2);
	const baseId = parseInt(baseRaw, 10);
	applySnapshotSoundId(Number.isFinite(baseId) ? baseId : SNAPSHOT_SOUND_ID_CLASSIC, d);
	if (!byVoiceRaw) return;
	const byVoice: ClickSoundByPolyVoice = {};
	for (const chunk of byVoiceRaw.split('_')) {
		const [voiceRaw, presetRaw] = chunk.split(':', 2);
		const voice = parseInt(String(voiceRaw), 10);
		const presetId = parseInt(String(presetRaw), 36);
		if (!Number.isFinite(voice) || voice < 0 || voice > 3) continue;
		if (!Number.isFinite(presetId) || presetId < 0 || presetId >= CLICK_SOUND_PRESET_ORDER.length) continue;
		byVoice[voice as PolyVoiceTarget] = CLICK_SOUND_PRESET_ORDER[presetId]!;
	}
	d.clickSoundByPolyVoice = byVoice;
}

export function encodeSnapshotSoundTokenForTest(
	baseClickSound: ClickSoundPreset,
	clickSoundByPolyVoice: ClickSoundByPolyVoice = {},
): string {
	const s = createEmptySnapshot();
	s.clickSound = baseClickSound;
	s.clickSoundByPolyVoice = normalizeClickSoundByPolyVoice(clickSoundByPolyVoice);
	return buildSnapshotSoundToken(s);
}

export function decodeSnapshotSoundTokenForTest(soundRaw: string): {
	clickSound: ClickSoundPreset;
	clickSoundByPolyVoice: ClickSoundByPolyVoice;
} {
	const s = createEmptySnapshot();
	applySnapshotSoundToken(soundRaw, s);
	return {
		clickSound: s.clickSound,
		clickSoundByPolyVoice: normalizeClickSoundByPolyVoice(s.clickSoundByPolyVoice),
	};
}

type SequencerCellJSON = { accent: boolean; pulsation: number };

function buildSequencerCellsForSnapshot(s: ReturnType<typeof createEmptySnapshot>): Record<string, SequencerCellJSON> {
	const acc = s.accents instanceof Set ? s.accents : new Set(Array.isArray(s.accents) ? s.accents : []);
	const out: Record<string, SequencerCellJSON> = {};
	for (let r = 0; r < s.bars; r++) {
		const syl = s.customSyllables[r] !== undefined ? s.customSyllables[r] : s.syllables;
		for (let c = 0; c < syl; c++) {
			const k = `${r}-${c}`;
			const p = s.customSubdivisions[k];
			const pul = typeof p === 'number' && p >= 1 && p <= 9 ? p : 1;
			out[k] = { accent: acc.has(k), pulsation: pul };
		}
	}
	return out;
}

/** Restore accents and subdivisions from dense grid payload (has priority over legacy fields). */
function hydrateSequencerFromCells(cellsRaw: unknown, d: ReturnType<typeof createEmptySnapshot>) {
	if (!cellsRaw || typeof cellsRaw !== 'object') return;
	const cells = cellsRaw as Record<string, unknown>;
	const nextAcc = new Set<string>();
	const nextSub: Record<string, number> = {};
	for (let r = 0; r < d.bars; r++) {
		const syl = d.customSyllables[r] !== undefined ? d.customSyllables[r] : d.syllables;
		for (let c = 0; c < syl; c++) {
			const k = `${r}-${c}`;
			const row = cells[k];
			if (!row || typeof row !== 'object') continue;
			const o = row as Record<string, unknown>;
			if (o.accent === true) nextAcc.add(k);
			const p = parseInt(String(o.pulsation), 10);
			const pul = Number.isFinite(p) && p >= 1 && p <= 10 ? p : 1;
			if (pul === 10) {
				nextSub[k] = 1;
				d.cellStepMasks[k] = [false];
				continue;
			}
			if (pul !== 1) nextSub[k] = pul;
		}
	}
	d.accents = nextAcc;
	d.customSubdivisions = nextSub;
}

function createEmptySnapshot() {
	return {
		tempo: 100,
		bars: 4,
		syllables: 4,
		accents: new Set<string>(),
		accentsByLane: makeEmptyLaneSetMap(),
		customSyllables: {} as Record<number, number>,
		customMultipliers: {} as Record<number, number>,
		customSubdivisions: {} as Record<string, number>,
		cellStepMasks: {} as CellStepMasks,
		customCellSyllables: {} as Record<string, string>,
		/** Randomizer defaults: mode on, pulsation off, cell speed + accents (pattern), chaos 15. */
		randomModeEnabled: true,
		randomPulsation: false,
		randomPattern: true,
		randomSpeed: true,
		randomBarSpeed: false,
		chaosLevel: 15,
		/** Classic = legacy maja without `konnakol_metronome`: accent / passive + Ta on first beat. */
		clickSound: 'classic' as ClickSoundPreset,
		/** Poly: per-voice preset override (0..3); missing key inherits from `clickSound`. */
		clickSoundByPolyVoice: {} as ClickSoundByPolyVoice,
		polyVoiceGains: { ...DEFAULT_POLY_VOICE_GAINS },
		/** Top panel: tempo + slider (Chevron) section expanded. */
		panelExpanded: false,
		/** Row r: cell duration follows PULSE_METER_BASE_SYLLABLES, not customSyllables[r]. */
		pulseMeterUnlinked: {} as Record<number, boolean>,
		/** Frozen row height (number of visible bars) or null. */
		frozenScale: null as number | null,
		/** Potato mode (low-performance UI). */
		lowPerfMode: false,
		polyMode: false,
		polyVoices: 2 as 2 | 3 | 4,
		onlyAccents: false,
		mixerLayerMode: DEFAULT_MIXER_LAYER_MODE,
		trainerMode: DEFAULT_TRAINER_MODE,
		trainerHoldMute: false,
		squarePlaybackMode: DEFAULT_SQUARE_PLAYBACK_MODE,
		/** Long-press on purple: mute passive bus only (see emitGridSubAudio). */
		squarePassiveLayerMuted: false,
		firstBeatAccent: true,
		firstBeatAccentByLane: makeLaneBoolMap(true),
		/** 0 = legacy: first-beat Ta without explicit `r-0` keys is treated as enabled; 1 = `accents` map controls first beats. */
		accentMapVersion: 0,
		syllableReadMuteMode: 'off' as SyllableReadMuteMode,
		/** Dictation: only first syllable of bar with green runner; passive clicks are disabled. */
		dictantMode: false,
		deadCells: {} as DeadCellsMap,
		/** Sound 1 (Ta-ding): any `r-c`, including `r-0` (white frame in Ta editor without writing to `accents`). */
		taDingKeys: new Set<string>(),
		/** Rows where default first-beat Ta is suppressed in Ta editor. */
		firstBeatDingSuppressedRows: new Set<number>(),
		taDingKeysByLane: makeEmptyLaneSetMap(),
		/** Random mode: free = axes (current logic); parent = inherited motif mutations. */
		randomMode: 'free' as RandomMode,
		/** ParentGenome (1 or 2 bars) - source core for parent mode. Null if not set. */
		parentGenome: null as ParentGenome | null,
		/** Parent length (1 or 2 bars). */
		parentLength: 1 as ParentLength,
		/** Enabled mutation types. Default = full Random preset pool (see parentModeUi). */
		enabledMutations: [...PRESET_ENABLED_MUTATIONS.random],
		/** Form preset for scheduler. */
		formPresetId: 'random' as FormPresetId,
		/** Press Matrix state for this snapshot: null=off, 'star'/'slider'=armed source. */
		pressMatrixArmSource: null as PressArmSource | null,
		/** Parent mode density progression source for export/log replay. */
		progressiveDensityMode: 'gati_mode' as ProgressiveDensityMode,
		/** Parent mode long-press jati toggle snapshot. */
		deSyncJatiActive: false,
		/** Parent mode de-sync cycle length for jati mode. */
		deSyncCycleLength: undefined as number | undefined,
	};
}

type AppSnapshot = ReturnType<typeof createEmptySnapshot> & {
	clickBusBalance?: ClickPresetBusGains;
	clickBusBalanceByPreset?: ClickPresetBusGainsMap;
	clickBusBalanceByVoicePreset?: ClickPresetBusGainsByVoiceMap;
};

function parseClickBusBalanceFromUnknown(raw: unknown): ClickPresetBusGains | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const o = raw as Record<string, unknown>;
	const a = Number(o.accent);
	const alt = Number(o.alt);
	const p = Number(o.passive);
	if (!Number.isFinite(a) && !Number.isFinite(alt) && !Number.isFinite(p)) return undefined;
	return {
		accent: clampClickPresetBusGain(Number.isFinite(a) ? a : 1),
		alt: clampClickPresetBusGain(Number.isFinite(alt) ? alt : 1),
		passive: clampClickPresetBusGain(Number.isFinite(p) ? p : 1),
	};
}

function parseClickBusBalanceByPresetFromUnknown(raw: unknown): ClickPresetBusGainsMap | undefined {
	const out = parseClickPresetBusGainsMapFromUnknown(raw);
	return Object.keys(out).length > 0 ? out : undefined;
}

function parseClickBusBalanceByVoicePresetFromUnknown(raw: unknown): ClickPresetBusGainsByVoiceMap | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const parsed = raw as Record<string, unknown>;
	const out: ClickPresetBusGainsByVoiceMap = {};
	for (const [voiceRaw, mapRaw] of Object.entries(parsed)) {
		const map = parseClickPresetBusGainsMapFromUnknown(mapRaw);
		if (Object.keys(map).length === 0) continue;
		out[normalizeClickBusVoiceIndex(voiceRaw)] = map;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function collectSnapshotClickBusBalanceByPreset(
	clickSound: ClickSoundPreset,
	clickSoundByPolyVoice: ClickSoundByPolyVoice,
	polyMode: boolean,
	presetBusGains: ClickPresetBusGainsMap,
): ClickPresetBusGainsMap {
	const presets = new Set<ClickSoundPreset>([clickSound]);
	if (polyMode) {
		for (const lane of [0, 1, 2] as const) {
			presets.add(resolveClickSoundForPolyVoice(lane, true, clickSoundByPolyVoice, clickSound));
		}
	}
	const out: ClickPresetBusGainsMap = {};
	for (const preset of presets) out[preset] = getClickPresetBusGainsForPreset(presetBusGains, preset);
	return out;
}

function collectSnapshotClickBusBalanceByVoicePreset(
	clickSound: ClickSoundPreset,
	clickSoundByPolyVoice: ClickSoundByPolyVoice,
	polyMode: boolean,
	byVoice: ClickPresetBusGainsByVoiceMap,
	legacyByPreset: ClickPresetBusGainsMap,
): ClickPresetBusGainsByVoiceMap {
	const voices: Array<0 | 1 | 2> = polyMode ? [0, 1, 2] : [0];
	const out: ClickPresetBusGainsByVoiceMap = {};
	for (const voice of voices) {
		const preset = resolveClickSoundForPolyVoice(voice, polyMode, clickSoundByPolyVoice, clickSound);
		const merged = getClickPresetBusGainsForVoicePreset(byVoice, legacyByPreset, voice, preset);
		const voicePrev = byVoice[voice];
		const nextMap: ClickPresetBusGainsMap = { ...(voicePrev ?? {}), [preset]: merged };
		out[voice] = nextMap;
	}
	return out;
}

function parseSnapshotRow(raw: unknown) {
	const d = createEmptySnapshot();
	if (!raw || typeof raw !== 'object') return d;
	const o = raw as Record<string, unknown>;
	const tempo = parseInt(String(o.tempo), 10);
	const bars = parseInt(String(o.bars), 10);
	const syllables = parseInt(String(o.syllables), 10);
	if (Number.isFinite(tempo) && tempo >= 20 && tempo <= 400) d.tempo = tempo;
	if (Number.isFinite(bars) && bars >= 1 && bars <= 100) d.bars = bars;
	if (Number.isFinite(syllables) && syllables >= 1 && syllables <= 9) d.syllables = syllables;
	const acc = o.accents;
	if (Array.isArray(acc)) d.accents = new Set(acc.filter((x): x is string => typeof x === 'string'));
	const accByLane = o.accentsByLane;
	if (accByLane && typeof accByLane === 'object') {
		d.accentsByLane = cloneLaneSetMap(accByLane as Partial<Record<number, Iterable<string>>>);
	}
	const cs = o.customSyllables;
	if (cs && typeof cs === 'object') {
		for (const [k, v] of Object.entries(cs as Record<string, unknown>)) {
			const ri = parseInt(k, 10);
			const vi = parseInt(String(v), 10);
			if (Number.isFinite(ri) && Number.isFinite(vi) && vi >= 1 && vi <= 9) d.customSyllables[ri] = vi;
		}
	}
	const cm = o.customMultipliers;
	if (cm && typeof cm === 'object') {
		for (const [k, v] of Object.entries(cm as Record<string, unknown>)) {
			const ri = parseInt(k, 10);
			const vi = Number(v);
			if (Number.isFinite(ri) && Number.isFinite(vi) && vi >= 1 && vi <= 4) d.customMultipliers[ri] = vi;
		}
	}
	const cd = o.customSubdivisions;
	if (cd && typeof cd === 'object') {
		for (const [k, v] of Object.entries(cd as Record<string, unknown>)) {
			const vi = parseInt(String(v), 10);
			if (typeof k !== 'string' || !Number.isFinite(vi)) continue;
			if (vi === 10) {
				d.customSubdivisions[k] = 1;
				d.cellStepMasks[k] = [false];
				continue;
			}
			if (vi >= 1 && vi <= 9) d.customSubdivisions[k] = vi;
		}
	}
	const csm = o.cellStepMasks;
	if (csm && typeof csm === 'object') {
		for (const [k, v] of Object.entries(csm as Record<string, unknown>)) {
			if (!/^\d+-\d+$/.test(k)) continue;
			const normalized = normalizeStoredStepMask(v);
			if (normalized) d.cellStepMasks[k] = normalized;
		}
	}
	const ccs = o.customCellSyllables;
	if (ccs && typeof ccs === 'object') {
		for (const [k, v] of Object.entries(ccs as Record<string, unknown>)) {
			if (!/^\d+-\d+$/.test(k)) continue;
			if (v === '-') {
				d.cellStepMasks[k] = [false];
				continue;
			}
			if (typeof v === 'string' && v.length > 0 && v.length <= 48) d.customCellSyllables[k] = v;
		}
	}
	if (typeof o.randomModeEnabled === 'boolean') d.randomModeEnabled = o.randomModeEnabled;
	if (typeof o.randomPulsation === 'boolean') d.randomPulsation = o.randomPulsation;
	if (typeof o.randomPattern === 'boolean') d.randomPattern = o.randomPattern;
	if (typeof o.randomSpeed === 'boolean') d.randomSpeed = o.randomSpeed;
	if (typeof o.randomBarSpeed === 'boolean') d.randomBarSpeed = o.randomBarSpeed;
	const cl = parseInt(String(o.chaosLevel), 10);
	if (Number.isFinite(cl) && cl >= 0 && cl <= 100) {
		d.chaosLevel = cl;
	} else if (o.randomMaxNotes !== undefined) {
		const legacy = parseInt(String(o.randomMaxNotes), 10);
		if (Number.isFinite(legacy) && legacy >= 0 && legacy <= 9) {
			d.chaosLevel = legacy <= 0 ? 18 : Math.min(100, 12 + legacy * 9);
		}
	}
	if (isClickSoundPreset(o.clickSound)) d.clickSound = o.clickSound;
	else if (o.clickSound === 'old-school') d.clickSound = 'oldschool';
	else d.clickSound = 'classic';
	d.clickSoundByPolyVoice = normalizeClickSoundByPolyVoice(o.clickSoundByPolyVoice);
	const parsedPolyVoiceGains = parsePolyVoiceGainsFromUnknown(o.polyVoiceGains);
	if (parsedPolyVoiceGains) d.polyVoiceGains = parsedPolyVoiceGains;
	const parsedBus = parseClickBusBalanceFromUnknown(o.clickBusBalance);
	if (parsedBus) (d as AppSnapshot).clickBusBalance = parsedBus;
	const parsedBusByPreset = parseClickBusBalanceByPresetFromUnknown(o.clickBusBalanceByPreset);
	if (parsedBusByPreset) (d as AppSnapshot).clickBusBalanceByPreset = parsedBusByPreset;
	const parsedBusByVoicePreset = parseClickBusBalanceByVoicePresetFromUnknown(
		o.clickBusBalanceByVoicePreset,
	);
	if (parsedBusByVoicePreset) (d as AppSnapshot).clickBusBalanceByVoicePreset = parsedBusByVoicePreset;
	if (typeof o.panelExpanded === 'boolean') d.panelExpanded = o.panelExpanded;
	if (o.sequencerCells && typeof o.sequencerCells === 'object') {
		hydrateSequencerFromCells(o.sequencerCells, d);
	}
	const pu = o.pulseMeterUnlinked;
	if (pu && typeof pu === 'object') {
		const next: Record<number, boolean> = {};
		for (const [k, v] of Object.entries(pu as Record<string, unknown>)) {
			const ri = parseInt(k, 10);
			if (Number.isFinite(ri) && ri >= 0) next[ri] = Boolean(v);
		}
		d.pulseMeterUnlinked = next;
	}
	if (typeof o.onlyAccents === 'boolean') d.onlyAccents = o.onlyAccents;
	const parsedMixer = normalizeMixerLayerModeFromSnapshot((o as { mixerLayerMode?: unknown }).mixerLayerMode);
	const parsedTrainer = normalizeTrainerModeFromSnapshot((o as { trainerMode?: unknown }).trainerMode);
	const hasNewModeFields =
		(o as { mixerLayerMode?: unknown }).mixerLayerMode !== undefined ||
		(o as { trainerMode?: unknown }).trainerMode !== undefined;
	const fallbackModes = deriveNewModesFromLegacySnapshot({
		squarePlaybackMode: o.squarePlaybackMode,
		squarePassiveLayerMuted: (o as { squarePassiveLayerMuted?: unknown }).squarePassiveLayerMuted,
		dictantMode: o.dictantMode,
		onlyAccents: o.onlyAccents,
	});
	d.mixerLayerMode = hasNewModeFields ? parsedMixer : fallbackModes.mixerLayerMode;
	d.trainerMode = hasNewModeFields ? parsedTrainer : fallbackModes.trainerMode;
	d.trainerHoldMute = (o as { trainerHoldMute?: unknown }).trainerHoldMute === true;
	d.squarePlaybackMode = normalizeSquarePlaybackModeFromSnapshot(
		o.squarePlaybackMode,
		typeof o.onlyAccents === 'boolean' ? o.onlyAccents : undefined,
	);
	if (typeof (o as { squarePassiveLayerMuted?: unknown }).squarePassiveLayerMuted === 'boolean') {
		d.squarePassiveLayerMuted = (o as { squarePassiveLayerMuted: boolean }).squarePassiveLayerMuted;
	}
	if (typeof o.dictantMode === 'boolean') d.dictantMode = o.dictantMode;
	if (typeof o.firstBeatAccent === 'boolean') d.firstBeatAccent = o.firstBeatAccent;
	const firstBeatByLane = o.firstBeatAccentByLane;
	if (firstBeatByLane && typeof firstBeatByLane === 'object') {
		d.firstBeatAccentByLane = cloneLaneBoolMap(firstBeatByLane as Partial<Record<number, boolean>>, d.firstBeatAccent);
	}
	if (o.accentMapVersion === true) d.accentMapVersion = 1;
	else {
		const amv = parseInt(String(o.accentMapVersion), 10);
		if (Number.isFinite(amv) && amv >= 1) d.accentMapVersion = 1;
	}
	d.syllableReadMuteMode = normalizeSyllableReadMuteModeFromSnapshot(o.syllableReadMuteMode, o.syllableReadMuteLatched);
	const fs = o.frozenScale;
	if (fs === null || fs === undefined) d.frozenScale = null;
	else {
		const fn = parseInt(String(fs), 10);
		d.frozenScale = Number.isFinite(fn) && fn >= 1 && fn <= 100 ? fn : null;
	}
	if (typeof o.lowPerfMode === 'boolean') d.lowPerfMode = o.lowPerfMode;
	if (typeof o.polyMode === 'boolean') d.polyMode = o.polyMode;
	d.polyVoices = parsePolyVoices(o.polyVoices);
	const deadRaw = o.deadCells;
	if (deadRaw && typeof deadRaw === 'object') {
		const nextDead: DeadCellsMap = {};
		for (const [rk, rv] of Object.entries(deadRaw as Record<string, unknown>)) {
			const r = parseInt(rk, 10);
			if (!Number.isFinite(r) || r < 0 || r >= d.bars) continue;
			if (!rv || typeof rv !== 'object') continue;
			const robj = rv as Record<string, unknown>;
			const deadStart = parseInt(String(robj.deadStart), 10);
			const displayLen = parseInt(String(robj.displayLen), 10);
			const baseLen = parseInt(String(robj.baseLen), 10);
			if (!Number.isFinite(deadStart) || !Number.isFinite(displayLen) || !Number.isFinite(baseLen)) continue;
			const minDeadStart = canRowUseZeroDeadStart(d.polyMode, d.polyVoices, r) ? 0 : 1;
			if (deadStart < minDeadStart || displayLen < 1 || baseLen < 1) continue;
			nextDead[r] = {
				deadStart: Math.min(deadStart, 9),
				displayLen: Math.min(displayLen, 9),
				baseLen: Math.min(baseLen, 9),
			};
		}
		d.deadCells = nextDead;
	}
	d.randomMode = 'free';
	const pg = parentGenomeFromJSON(o.parentGenome);
	if (pg) d.parentGenome = pg;
	const pl = parseInt(String(o.parentLength), 10);
	if (pl === 1 || pl === 2) d.parentLength = pl;
	if (Array.isArray(o.enabledMutations)) {
		const out: MutationType[] = [];
		for (const x of o.enabledMutations) if (isMutationType(x) && !out.includes(x)) out.push(x);
		d.enabledMutations = out;
	}
	if (isFormPresetId(o.formPresetId)) d.formPresetId = o.formPresetId;
	if (o.pressMatrixArmSource === 'star' || o.pressMatrixArmSource === 'slider') {
		d.pressMatrixArmSource = o.pressMatrixArmSource;
	} else {
		d.pressMatrixArmSource = null;
	}
	if (o.progressiveDensityMode === 'gati_mode' || o.progressiveDensityMode === 'jati_mode') {
		d.progressiveDensityMode = o.progressiveDensityMode;
	}
	d.deSyncJatiActive = o.deSyncJatiActive === true;
	if (o.deSyncCycleLength === undefined || o.deSyncCycleLength === null) {
		d.deSyncCycleLength = undefined;
	} else {
		const parsedCycle = Math.floor(Number(o.deSyncCycleLength));
		d.deSyncCycleLength = Number.isFinite(parsedCycle) && parsedCycle >= 1 ? parsedCycle : undefined;
	}
	const tdkIn = o.taDingKeys;
	if (Array.isArray(tdkIn)) {
		const next = new Set<string>();
		const nBars = d.bars;
		for (const x of tdkIn) {
			if (typeof x !== 'string') continue;
			const parts = x.split('-');
			if (parts.length !== 2) continue;
			const r = parseInt(parts[0], 10);
			const c = parseInt(parts[1], 10);
			if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || r >= nBars || c < 0) continue;
			const rowSyl = d.customSyllables[r] !== undefined ? d.customSyllables[r] : d.syllables;
			if (c >= rowSyl) continue;
			next.add(x);
		}
		d.taDingKeys = next;
	}
	const tdkByLane = o.taDingKeysByLane;
	if (tdkByLane && typeof tdkByLane === 'object') {
		d.taDingKeysByLane = cloneLaneSetMap(tdkByLane as Partial<Record<number, Iterable<string>>>);
	}
	const supRowsIn = o.firstBeatDingSuppressedRows;
	d.firstBeatDingSuppressedRows = normalizeSuppressedRows(supRowsIn, d.bars);
	const hasLaneAcc = accByLane && typeof accByLane === 'object';
	const hasLaneTdk = tdkByLane && typeof tdkByLane === 'object';
	const hasLaneFb = firstBeatByLane && typeof firstBeatByLane === 'object';
	if (!hasLaneAcc) d.accentsByLane = distributeSetToLanes(d.accents, d.bars, d.polyVoices);
	if (!hasLaneTdk) d.taDingKeysByLane = distributeSetToLanes(d.taDingKeys, d.bars, d.polyVoices);
	if (!hasLaneFb) d.firstBeatAccentByLane = makeLaneBoolMap(d.firstBeatAccent);
	d.accents = flattenLaneSetMap(d.accentsByLane, d.bars, d.polyVoices);
	d.taDingKeys = flattenLaneSetMap(d.taDingKeysByLane, d.bars, d.polyVoices);
	d.firstBeatAccent = Boolean(d.firstBeatAccentByLane[0]);
	return d;
}

function snapSlotLooksUsed(s: ReturnType<typeof createEmptySnapshot>) {
	if (s.tempo !== 100 || s.bars !== 4 || s.syllables !== 4) return true;
	if (s.accents.size > 0) return true;
	if (s.taDingKeys.size > 0) return true;
	if (Object.keys(s.customSyllables).length > 0) return true;
	if (Object.keys(s.customMultipliers).length > 0) return true;
	if (Object.keys(s.customSubdivisions).length > 0) return true;
	if (Object.keys(s.cellStepMasks || {}).length > 0) return true;
	if (Object.keys((s as { customCellSyllables?: Record<string, string> }).customCellSyllables || {}).length > 0)
		return true;
	if (s.randomModeEnabled || s.randomPulsation || !s.randomPattern || s.randomSpeed || s.randomBarSpeed) return true;
	if (s.chaosLevel !== 0) return true;
	if (s.clickSound !== 'classic') return true;
	if (Object.keys(s.clickSoundByPolyVoice || {}).length > 0) return true;
	if (s.panelExpanded === true) return true;
	if (s.pulseMeterUnlinked && Object.values(s.pulseMeterUnlinked).some(Boolean)) return true;
	if (s.onlyAccents) return true;
	if ((s as { mixerLayerMode?: MixerLayerMode }).mixerLayerMode && (s as { mixerLayerMode?: MixerLayerMode }).mixerLayerMode !== DEFAULT_MIXER_LAYER_MODE) return true;
	if ((s as { trainerMode?: TrainerMode }).trainerMode && (s as { trainerMode?: TrainerMode }).trainerMode !== DEFAULT_TRAINER_MODE) return true;
	if ((s as { trainerHoldMute?: boolean }).trainerHoldMute === true) return true;
	if ((s as { squarePassiveLayerMuted?: boolean }).squarePassiveLayerMuted) return true;
	{
		const m = (s as { squarePlaybackMode?: string }).squarePlaybackMode;
		if (m === 'passive_no_alt' || m === 'ta_only') return true;
		if (m === 'accent_only' || m === 'passive_only') return true;
	}
	if (s.firstBeatAccent === false) return true;
	if (s.frozenScale != null) return true;
	if ((s as { lowPerfMode?: boolean }).lowPerfMode === true) return true;
	if (s.polyMode) return true;
	if (s.polyVoices !== 2) return true;
	if (s.syllableReadMuteMode !== 'off') return true;
	if ((s as { accentMapVersion?: number }).accentMapVersion === 1) return true;
	if ((s as { dictantMode?: boolean }).dictantMode === true) return true;
	if ((s as { deadCells?: DeadCellsMap }).deadCells && Object.keys((s as { deadCells?: DeadCellsMap }).deadCells || {}).length > 0) return true;
	if (s.randomMode === 'parent') return true;
	if (s.parentGenome !== null) return true;
	if (isEnabledMutationsCustomForPreset(s.enabledMutations, s.formPresetId)) return true;
	if (s.formPresetId !== 'random') return true;
	return false;
}

function snapshotToJSON(s: ReturnType<typeof createEmptySnapshot>) {
	const snap = s as AppSnapshot;
	const enabledMutationsSafe = Array.isArray(s.enabledMutations) ? s.enabledMutations : [];
	const clickBusByVoicePreset =
		snap.clickBusBalanceByVoicePreset ??
		collectSnapshotClickBusBalanceByVoicePreset(
			s.clickSound,
			normalizeClickSoundByPolyVoice(s.clickSoundByPolyVoice),
			s.polyMode === true,
			{},
			{ ...(snap.clickBusBalance ? { [s.clickSound]: snap.clickBusBalance } : {}) },
		);
	const clickBusByPreset =
		snap.clickBusBalanceByPreset ??
		collectSnapshotClickBusBalanceByPreset(
			s.clickSound,
			normalizeClickSoundByPolyVoice(s.clickSoundByPolyVoice),
			s.polyMode === true,
			{ ...(snap.clickBusBalance ? { [s.clickSound]: snap.clickBusBalance } : {}) },
		);
	const mixerLayerMode = normalizeMixerLayerModeFromSnapshot((s as { mixerLayerMode?: unknown }).mixerLayerMode);
	const trainerMode = normalizeTrainerModeFromSnapshot((s as { trainerMode?: unknown }).trainerMode);
	return {
		tempo: s.tempo,
		bars: s.bars,
		syllables: s.syllables,
		accents: [...s.accents],
		accentsByLane: {
			0: [...(s.accentsByLane?.[0] ?? [])],
			1: [...(s.accentsByLane?.[1] ?? [])],
			2: [...(s.accentsByLane?.[2] ?? [])],
		},
		sequencerCells: buildSequencerCellsForSnapshot(s),
		customSyllables: s.customSyllables,
		customMultipliers: s.customMultipliers,
		customSubdivisions: s.customSubdivisions,
		cellStepMasks: s.cellStepMasks,
		customCellSyllables: { ...((s as { customCellSyllables?: Record<string, string> }).customCellSyllables || {}) },
		randomModeEnabled: s.randomModeEnabled,
		randomPulsation: s.randomPulsation,
		randomPattern: s.randomPattern,
		randomSpeed: s.randomSpeed,
		randomBarSpeed: s.randomBarSpeed,
		chaosLevel: s.chaosLevel,
		clickSound: s.clickSound,
		clickSoundByPolyVoice: normalizeClickSoundByPolyVoice(s.clickSoundByPolyVoice),
		polyVoiceGains: parsePolyVoiceGainsFromUnknown((s as { polyVoiceGains?: unknown }).polyVoiceGains) ?? {
			...DEFAULT_POLY_VOICE_GAINS,
		},
		panelExpanded: s.panelExpanded,
		pulseMeterUnlinked: Object.fromEntries(
			Object.entries(s.pulseMeterUnlinked || {}).filter(([, v]) => v),
		) as Record<string, boolean>,
		frozenScale: s.frozenScale ?? null,
		lowPerfMode: (s as { lowPerfMode?: boolean }).lowPerfMode === true,
		polyMode: s.polyMode === true,
		polyVoices: parsePolyVoices(s.polyVoices),
		onlyAccents: s.onlyAccents,
		mixerLayerMode,
		trainerMode,
		trainerHoldMute: (s as { trainerHoldMute?: boolean }).trainerHoldMute === true,
		...mapNewModesToLegacySnapshot(mixerLayerMode, trainerMode),
		firstBeatAccent: s.firstBeatAccent,
		firstBeatAccentByLane: { ...makeLaneBoolMap(s.firstBeatAccent !== false), ...(s.firstBeatAccentByLane ?? {}) },
		accentMapVersion: (s as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
		taEditorMode: false,
		syllableReadMuteMode: s.syllableReadMuteMode,
		dictantMode: trainerMode === 'dictation',
		deadCells: (s as { deadCells?: DeadCellsMap }).deadCells ?? {},
		taDingKeys: [...s.taDingKeys],
		firstBeatDingSuppressedRows: [...(s.firstBeatDingSuppressedRows ?? [])],
		taDingKeysByLane: {
			0: [...(s.taDingKeysByLane?.[0] ?? [])],
			1: [...(s.taDingKeysByLane?.[1] ?? [])],
			2: [...(s.taDingKeysByLane?.[2] ?? [])],
		},
		randomMode: s.randomMode,
		parentGenome: s.parentGenome ? parentGenomeToJSON(s.parentGenome) : null,
		parentLength: s.parentLength,
		enabledMutations: Array.from(enabledMutationsSafe),
		formPresetId: s.formPresetId,
		pressMatrixArmSource: s.pressMatrixArmSource === 'slider' ? 'slider' : s.pressMatrixArmSource === 'star' ? 'star' : null,
		...(snap.clickBusBalance
			? { clickBusBalance: snap.clickBusBalance }
			: {
					clickBusBalance: getClickPresetBusGainsForVoicePreset(
						clickBusByVoicePreset,
						clickBusByPreset,
						0,
						s.clickSound,
					),
				}),
		...(clickBusByPreset ? { clickBusBalanceByPreset: clickBusByPreset } : {}),
		...(clickBusByVoicePreset ? { clickBusBalanceByVoicePreset: clickBusByVoicePreset } : {}),
	};
}

/** FRAGILE — clipboard export; poly flatten + gridToken + deadCells + flags must match decode branches. */
function encodeSnapshotClipboard(s: ReturnType<typeof createEmptySnapshot>): string {
	const voices = parsePolyVoices(s.polyVoices);
	const accIn = s.accents;
	const accentsFlat: Set<string> =
		s.polyMode === true
			? flattenLaneSetMap(cloneLaneSetMap(s.accentsByLane), s.bars, voices)
			: accIn instanceof Set
				? new Set(accIn)
				: new Set(
						Array.isArray(accIn)
							? (accIn as unknown[]).filter((x): x is string => typeof x === 'string')
							: [],
					);
	const taIn = s.taDingKeys;
	const taFlat: Set<string> =
		s.polyMode === true
			? flattenLaneSetMap(cloneLaneSetMap(s.taDingKeysByLane), s.bars, voices)
			: taIn instanceof Set
				? new Set(taIn)
				: new Set(
						Array.isArray(taIn)
							? (taIn as unknown[]).filter((x): x is string => typeof x === 'string')
							: [],
					);
	const sForPack: ReturnType<typeof createEmptySnapshot> = { ...s, taDingKeys: taFlat };
	const cells = buildCellIndexMapForSnapshot(s.bars, s.syllables, s.customSyllables);
	const gridToken = packGridTokenPacked(sForPack, cells, accentsFlat);
	const deadCellsToken = encodeDeadCellsToken(
		(s as { deadCells?: DeadCellsMap }).deadCells ?? {},
		s.bars,
		Boolean((s as { polyMode?: boolean }).polyMode),
		parsePolyVoices((s as { polyVoices?: unknown }).polyVoices),
	);
	const flags = buildSnapshotFlags(s);
	const soundToken = buildSnapshotSoundToken(s);
	const compact = `${s.tempo}.${s.bars}.${s.syllables}.${gridToken}.${deadCellsToken}.${s.chaosLevel}.${flags}.${soundToken}`;
	return SNAPSHOT_CLIPBOARD_MARKER + compact;
}

/** FRAGILE — paste/import; keep 7/8/11-part branches and legacy prefixes or users lose presets. */
function tryDecodeSnapshotClipboard(text: string): ReturnType<typeof createEmptySnapshot> | null {
	const t = text.trim();
	const markerMatch = t.match(SNAPSHOT_CLIPBOARD_MARKER_REGEX);
	const hasNewMarker = markerMatch !== null;
	const hasLegacyCompactMarker = t.startsWith(SNAPSHOT_CLIPBOARD_PREFIX_LEGACY_COMPACT);
	const hasBareCompact =
		!hasNewMarker &&
		!hasLegacyCompactMarker &&
		/^\d+\.\d+\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.\d+\.\d+\.\d+$/.test(t);
	if (hasNewMarker || hasLegacyCompactMarker || hasBareCompact) {
		const markerLength = hasNewMarker
			? markerMatch![0].length
			: hasLegacyCompactMarker
				? SNAPSHOT_CLIPBOARD_PREFIX_LEGACY_COMPACT.length
				: 0;
		const body = t.slice(markerLength).replace(/\s+/g, '');
		if (!body) return null;
		const compactParts = body.split('.');
		if (compactParts.length === 11) {
			const [
				tempoRaw,
				barsRaw,
				syllablesRaw,
				rowSyllablesToken,
				accentToken,
				subdivisionsToken,
				multipliersToken,
				pulseUnlinkedToken,
				chaosRaw,
				flagsRaw,
				soundRaw,
			] = compactParts;
			const d = createEmptySnapshot();
			const tempo = parseInt(tempoRaw, 10);
			const bars = parseInt(barsRaw, 10);
			const syllables = parseInt(syllablesRaw, 10);
			const chaosLevel = parseInt(chaosRaw, 10);
			const flags = parseInt(flagsRaw, 10);
			if (!Number.isFinite(tempo) || tempo < 20 || tempo > 400) return null;
			if (!Number.isFinite(bars) || bars < 1 || bars > 100) return null;
			if (!Number.isFinite(syllables) || syllables < 1 || syllables > 9) return null;
			if (!Number.isFinite(chaosLevel) || chaosLevel < 0 || chaosLevel > 100) return null;
			if (!Number.isFinite(flags) || flags < 0) return null;
			d.tempo = tempo;
			d.bars = bars;
			d.syllables = syllables;
			d.customSyllables = decodeSparseRowNumberMap(rowSyllablesToken, (value) => value >= 1 && value <= 9);
			const cells = buildCellIndexMapForSnapshot(d.bars, d.syllables, d.customSyllables);
			d.accents = hydrateAccentsFromVariableGridToken(accentToken, cells);
			d.customSubdivisions = decodeSubdivisionsToken(subdivisionsToken, cells);
			d.customMultipliers = decodeSparseRowNumberMap(
				multipliersToken,
				(value) => value >= 1 && value <= 4 && value !== 1,
			);
			d.pulseMeterUnlinked = decodePulseUnlinkedRowsToken(pulseUnlinkedToken);
			d.chaosLevel = chaosLevel;
			applySnapshotFlags(flags, d);
			applySnapshotSoundToken(soundRaw, d);
			return d;
		}
		if (compactParts.length === 8) {
			const [tempoRaw, barsRaw, syllablesRaw, gridTokenRaw, deadCellsRaw, chaosRaw, flagsRaw, soundRaw] =
				compactParts;
			const d = createEmptySnapshot();
			const tempo = parseInt(tempoRaw, 10);
			const bars = parseInt(barsRaw, 10);
			const syllables = parseInt(syllablesRaw, 10);
			const chaosLevel = parseInt(chaosRaw, 10);
			const flags = parseInt(flagsRaw, 10);
			if (!Number.isFinite(tempo) || tempo < 20 || tempo > 400) return null;
			if (!Number.isFinite(bars) || bars < 1 || bars > 100) return null;
			if (!Number.isFinite(syllables) || syllables < 1 || syllables > 9) return null;
			if (!Number.isFinite(chaosLevel) || chaosLevel < 0 || chaosLevel > 100) return null;
			if (!Number.isFinite(flags) || flags < 0) return null;
			d.tempo = tempo;
			d.bars = bars;
			d.syllables = syllables;
			d.chaosLevel = chaosLevel;
			applySnapshotFlags(flags, d);
			applySnapshotSoundToken(soundRaw, d);
			if (gridTokenRaw.startsWith('p1') || gridTokenRaw.startsWith('p2') || gridTokenRaw.startsWith('p3') || gridTokenRaw.startsWith('p4')) {
				if (!unpackGridTokenPacked(gridTokenRaw, d)) return null;
				// Some shared compact strings have outer bars/syllables that are newer than packed p3 internals.
				// Keep explicit outer geometry to preserve user-intended layout on paste.
				d.bars = bars;
				d.syllables = syllables;
			} else if (gridTokenRaw.includes('|')) {
				const [accentToken, rowSyllablesToken, subdivisionsToken, multipliersToken, pulseUnlinkedToken] =
					gridTokenRaw.split('|');
				d.customSyllables = decodeSparseRowNumberMap(
					rowSyllablesToken || '0',
					(value) => value >= 1 && value <= 9,
				);
				const cells = buildCellIndexMapForSnapshot(d.bars, d.syllables, d.customSyllables);
				d.accents = hydrateAccentsFromVariableGridToken(accentToken || '0', cells);
				d.customSubdivisions = decodeSubdivisionsToken(subdivisionsToken || '0', cells);
				d.customMultipliers = decodeSparseRowNumberMap(
					multipliersToken || '0',
					(value) => value >= 1 && value <= 4 && value !== 1,
				);
				d.pulseMeterUnlinked = decodePulseUnlinkedRowsToken(pulseUnlinkedToken || '0');
			} else {
				hydrateSnapshotAccentsFromGridToken(gridTokenRaw, bars, syllables, d);
			}
			d.deadCells = decodeDeadCellsToken(deadCellsRaw, d.bars, d.polyMode, d.polyVoices);
			return d;
		}
		if (compactParts.length === 7) {
			const [tempoRaw, barsRaw, syllablesRaw, gridTokenRaw, chaosRaw, flagsRaw, soundRaw] = compactParts;
			const d = createEmptySnapshot();
			const tempo = parseInt(tempoRaw, 10);
			const bars = parseInt(barsRaw, 10);
			const syllables = parseInt(syllablesRaw, 10);
			const chaosLevel = parseInt(chaosRaw, 10);
			const flags = parseInt(flagsRaw, 10);
			if (!Number.isFinite(tempo) || tempo < 20 || tempo > 400) return null;
			if (!Number.isFinite(bars) || bars < 1 || bars > 100) return null;
			if (!Number.isFinite(syllables) || syllables < 1 || syllables > 9) return null;
			if (!Number.isFinite(chaosLevel) || chaosLevel < 0 || chaosLevel > 100) return null;
			if (!Number.isFinite(flags) || flags < 0) return null;
			d.tempo = tempo;
			d.bars = bars;
			d.syllables = syllables;
			d.chaosLevel = chaosLevel;
			applySnapshotFlags(flags, d);
			applySnapshotSoundToken(soundRaw, d);
			if (gridTokenRaw.startsWith('p1') || gridTokenRaw.startsWith('p2') || gridTokenRaw.startsWith('p3') || gridTokenRaw.startsWith('p4')) {
				if (!unpackGridTokenPacked(gridTokenRaw, d)) return null;
				// Keep explicit compact header geometry for compatibility with externally edited short snapshots.
				d.bars = bars;
				d.syllables = syllables;
			} else if (gridTokenRaw.includes('|')) {
				const [accentToken, rowSyllablesToken, subdivisionsToken, multipliersToken, pulseUnlinkedToken] =
					gridTokenRaw.split('|');
				d.customSyllables = decodeSparseRowNumberMap(
					rowSyllablesToken || '0',
					(value) => value >= 1 && value <= 9,
				);
				const cells = buildCellIndexMapForSnapshot(d.bars, d.syllables, d.customSyllables);
				d.accents = hydrateAccentsFromVariableGridToken(accentToken || '0', cells);
				d.customSubdivisions = decodeSubdivisionsToken(subdivisionsToken || '0', cells);
				d.customMultipliers = decodeSparseRowNumberMap(
					multipliersToken || '0',
					(value) => value >= 1 && value <= 4 && value !== 1,
				);
				d.pulseMeterUnlinked = decodePulseUnlinkedRowsToken(pulseUnlinkedToken || '0');
			} else {
				hydrateSnapshotAccentsFromGridToken(gridTokenRaw, bars, syllables, d);
			}
			return d;
		}
		return null;
	}
	if (t.startsWith(SNAPSHOT_CLIPBOARD_PREFIX_LEGACY)) {
		try {
			const raw = JSON.parse(t.slice(SNAPSHOT_CLIPBOARD_PREFIX_LEGACY.length));
			return parseSnapshotRow(raw);
		} catch {
			return null;
		}
	}
	if (t.startsWith(SNAPSHOT_CLIPBOARD_PREFIX_V2)) {
		try {
			const raw = JSON.parse(t.slice(SNAPSHOT_CLIPBOARD_PREFIX_V2.length));
			return parseSnapshotRow(raw);
		} catch {
			return null;
		}
	}
	return null;
}

// Debug helper for offline timing reports from compact snapshot strings.
export function decodeSnapshotClipboardForReport(text: string) {
  return tryDecodeSnapshotClipboard(text);
}

type CompactSnapshotStoragePayload = {
	v: 1;
	activeSnapshot?: number;
	slots?: Record<string, string>;
	slotUi?: Record<
		string,
		{
			lowPerfMode?: boolean;
			frozenScale?: number | null;
		}
	>;
};

function loadSnapshotStorage(): {
	activeSnapshot: number;
	snapshots: Record<number, ReturnType<typeof createEmptySnapshot>>;
} {
	const snapshots: Record<number, ReturnType<typeof createEmptySnapshot>> = {};
	for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) snapshots[i] = createEmptySnapshot();
	let activeSnapshot = 1;
	let restoredAny = false;
	const applyDefaultSnapshotModes = () => {
		for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) {
			snapshots[i].randomModeEnabled = false;
			snapshots[i].squarePlaybackMode = DEFAULT_SQUARE_PLAYBACK_MODE;
		}
	};
	try {
		const rawCompact = localStorage.getItem(SNAPSHOT_STORAGE_COMPACT_KEY);
		if (rawCompact) {
			const compactData = JSON.parse(rawCompact) as CompactSnapshotStoragePayload;
			if (
				typeof compactData.activeSnapshot === 'number' &&
				compactData.activeSnapshot >= 1 &&
				compactData.activeSnapshot <= SNAPSHOT_SLOT_COUNT
			) {
				activeSnapshot = Math.floor(compactData.activeSnapshot);
			}
			const bag = compactData.slots;
			const compactSlotUi = compactData.slotUi;
			if (bag && typeof bag === 'object') {
				for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) {
					const encoded = bag[String(i)] ?? (bag as any)[i];
					if (typeof encoded !== 'string' || !encoded.trim()) continue;
					const parsed = tryDecodeSnapshotClipboard(encoded);
					if (!parsed) continue;
					if (compactSlotUi && typeof compactSlotUi === 'object') {
						const uiRaw = compactSlotUi[String(i)] ?? (compactSlotUi as any)[i];
						if (uiRaw && typeof uiRaw === 'object') {
							const ui = uiRaw as { lowPerfMode?: unknown; frozenScale?: unknown };
							if (typeof ui.lowPerfMode === 'boolean') parsed.lowPerfMode = ui.lowPerfMode;
							if (ui.frozenScale === null || ui.frozenScale === undefined) {
								parsed.frozenScale = null;
							} else {
								const fs = parseInt(String(ui.frozenScale), 10);
								parsed.frozenScale = Number.isFinite(fs) && fs >= 1 && fs <= 100 ? fs : null;
							}
						}
					}
					snapshots[i] = parsed;
					restoredAny = true;
				}
				if (restoredAny) return { activeSnapshot, snapshots };
			}
		}
		const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
		if (!raw) {
			applyDefaultSnapshotModes();
			return { activeSnapshot, snapshots };
		}
		const data = JSON.parse(raw) as { activeSnapshot?: number; snapshots?: Record<string, unknown> };
		if (typeof data.activeSnapshot === 'number' && data.activeSnapshot >= 1 && data.activeSnapshot <= SNAPSHOT_SLOT_COUNT) {
			activeSnapshot = Math.floor(data.activeSnapshot);
		}
		const bag = data.snapshots;
		if (bag && typeof bag === 'object') {
			for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) {
				const row = bag[String(i)] ?? (bag as any)[i];
				if (row) {
					snapshots[i] = parseSnapshotRow(row);
					restoredAny = true;
				}
			}
		}
	} catch {
		/* keep defaults */
	}
	if (!restoredAny) applyDefaultSnapshotModes();
	return { activeSnapshot, snapshots };
}

type ClickMixerGroup = { groupHpHz: number; groupLpHz: number; groupMasterLinear: number };

type ClickMixerLayerBag = { accent: ClickLayerConfig[]; alt: ClickLayerConfig[]; passive: ClickLayerConfig[] };
type ClickMixerPerPresetCache = Partial<Record<ClickSoundPreset, ClickMixerLayerBag>>;
const clickMixerLayerClonesByPresetRef: { current: ClickMixerPerPresetCache } = { current: {} };
const lastScheduledVoiceTimeByContext = new WeakMap<AudioContext, Record<MetroVoiceKey, number>>();
const passiveBurstCooldownUntilByContext = new WeakMap<AudioContext, number>();
const IS_CHROME_DESKTOP =
  typeof navigator !== 'undefined' &&
  /Chrome\//.test(navigator.userAgent) &&
  !/(Android|iPhone|iPad|iPod)/i.test(navigator.userAgent);

const clickMixerGroupRef: { current: Record<MetroVoiceKey, ClickMixerGroup> | null } = { current: null };
const taHiHatBufferByContext = new WeakMap<AudioContext, AudioBuffer>();
const taHiHatRenderPromiseByContext = new WeakMap<AudioContext, Promise<AudioBuffer | null>>();

function getClassicOldschoolLoudnessBoost(soundType: ClickSoundPreset): number {
  if (soundType === 'classic') return 1.42;
  if (soundType === 'oldschool') return 1.34;
  return 1;
}

async function renderTaHiHatBuffer(ctx: AudioContext): Promise<AudioBuffer | null> {
  const OfflineCtor = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!OfflineCtor) return null;
  const sampleRate = Math.max(22050, Math.floor(ctx.sampleRate || 44100));
  const durationSec = 0.2;
  const frameCount = Math.max(1, Math.floor(sampleRate * durationSec));
  const off = new OfflineCtor(1, frameCount, sampleRate);
  const t0 = 0.006;
  const sumIn = off.createGain();
  sumIn.gain.value = 1;
  sumIn.connect(off.destination);
  const cfg = CLICK_SOUND_LIBRARY.hi_hat ?? CLICK_SOUND_LIBRARY.classic;
  const accentLayers = (cfg.layers ?? buildLegacyVoiceLayers(cfg)).accent;
  const activeLayers = accentLayers.filter(
    (layer) => layer.mute !== true && layer.params.volume > CLICK_LAYER_VOLUME_GATE && layer.type !== 'none',
  );
  const soloLayers = activeLayers.filter((layer) => layer.solo === true);
  const runLayers = soloLayers.length > 0 ? soloLayers : activeLayers;
  for (const layer of runLayers) {
    const layerDecay = Math.min(CLICK_DECAY_MAX_SEC, Math.max(CLICK_DECAY_MIN_SEC, layer.params.decay));
    scheduleLayerToBus(off as unknown as AudioContext, t0, layer, layer.params.volume, layerDecay, sumIn);
  }
  return off.startRendering();
}

function ensureTaHiHatBuffer(ctx: AudioContext): Promise<AudioBuffer | null> {
  const ready = taHiHatBufferByContext.get(ctx);
  if (ready) return Promise.resolve(ready);
  const inFlight = taHiHatRenderPromiseByContext.get(ctx);
  if (inFlight) return inFlight;
  const job = renderTaHiHatBuffer(ctx)
    .then((buf) => {
      if (buf) taHiHatBufferByContext.set(ctx, buf);
      return buf;
    })
    .catch(() => null)
    .finally(() => {
      taHiHatRenderPromiseByContext.delete(ctx);
    });
  taHiHatRenderPromiseByContext.set(ctx, job);
  return job;
}

function armPassiveBurstCooldown(ctx: AudioContext, durationMs: number): void {
  if (!IS_CHROME_DESKTOP || durationMs <= 0) return;
  passiveBurstCooldownUntilByContext.set(ctx, ctx.currentTime + durationMs / 1000);
}

function isPassiveBurstCooldownActive(ctx: AudioContext): boolean {
  const until = passiveBurstCooldownUntilByContext.get(ctx);
  return typeof until === 'number' && ctx.currentTime < until;
}

function cloneClickMixerFromLibrary(soundType: ClickSoundPreset): void {
	const cfg = CLICK_SOUND_LIBRARY[soundType] ?? CLICK_SOUND_LIBRARY.classic;
	const built = cfg.layers ?? buildLegacyVoiceLayers(cfg);
	clickMixerLayerClonesByPresetRef.current[soundType] = {
		accent: structuredClone(built.accent),
		alt: structuredClone(built.alt),
		passive: structuredClone(built.passive),
	};
	const def = (): ClickMixerGroup => ({ groupHpHz: 20, groupLpHz: 20000, groupMasterLinear: 1 });
	clickMixerGroupRef.current = {
		accent: def(),
		alt: def(),
		passive: def(),
	};
}

/**
 * @param accentOnlyPlayback When true, only accented steps sound — blend accent with passive timbre.
 *   When false, passive steps also sound — accented hits use accent-only (high) to avoid doubling + clipping.
 */
const playSharpClick = (
  ctx: AudioContext,
  time: number,
  isChecked: boolean,
  soundType: ClickSoundPreset = 'classic',
  accentOnlyPlayback = false,
  voiceRole: 'accent' | 'base' | 'alt' = isChecked ? 'accent' : 'base',
  voiceGainMul = 1,
) => {
  // USER-SOURCE-OF-TRUTH: render only the role explicitly requested by scheduler from user grid state.
  const cfg = CLICK_SOUND_LIBRARY[soundType] ?? CLICK_SOUND_LIBRARY.classic;
  const presetBoost = getClassicOldschoolLoudnessBoost(soundType);
  const nowGuarded = ctx.currentTime + AUDIO_START_GUARD_SEC;
  const baseT0 = Math.max(time, nowGuarded);
  const voiceKey: MetroVoiceKey = voiceRole === 'accent' ? 'accent' : voiceRole === 'alt' ? 'alt' : 'passive';
  let lastByVoice = lastScheduledVoiceTimeByContext.get(ctx);
  if (!lastByVoice) {
    lastByVoice = { accent: -Infinity, alt: -Infinity, passive: -Infinity };
    lastScheduledVoiceTimeByContext.set(ctx, lastByVoice);
  }
  const minSpacingSec =
    voiceKey === 'passive'
      ? (
          (IS_CHROME_DESKTOP ? AUDIO_BURST_PASSIVE_MIN_SPACING_SEC : AUDIO_BURST_MIN_SPACING_SEC) *
          (isPassiveBurstCooldownActive(ctx) ? AUDIO_PASSIVE_STALL_COOLDOWN_SPACING_MULT : 1)
        )
      : AUDIO_BURST_MIN_SPACING_SEC;
  // Anti-burst guard: when scheduler catches up late events, do not collapse same-voice hits
  // into the exact same timestamp (audible as random digital clipping on dense passive patterns).
  const t0 = Math.max(baseT0, lastByVoice[voiceKey] + minSpacingSec);
  lastByVoice[voiceKey] = t0;
  const busIn = getVoiceLayerSumInput(ctx, voiceKey);
  const libLayers = (cfg.layers ?? buildLegacyVoiceLayers(cfg))[voiceKey];
  const cachedForPreset = clickMixerLayerClonesByPresetRef.current[soundType];
  const layers = cachedForPreset?.[voiceKey] ?? libLayers;
  const activeLayers = layers.filter(
    (layer) => layer.mute !== true && layer.params.volume > CLICK_LAYER_VOLUME_GATE && layer.type !== 'none',
  );
  const soloLayers = activeLayers.filter((layer) => layer.solo === true);
  const runLayers = soloLayers.length > 0 ? soloLayers : activeLayers;
  for (const layer of runLayers) {
    const layerDecay = Math.min(CLICK_DECAY_MAX_SEC, Math.max(CLICK_DECAY_MIN_SEC, layer.params.decay));
    const baseLayerVol =
      accentOnlyPlayback && voiceRole === 'accent' ? layer.params.volume * 0.72 : layer.params.volume;
    const layerVol = baseLayerVol * voiceGainMul * presetBoost;
    scheduleLayerToBus(ctx, t0, layer, layerVol, layerDecay, busIn);
  }
};

const playBarFirstHighClick = (
  ctx: AudioContext,
  time: number,
  soundType: ClickSoundPreset = 'classic',
  voiceGainMul = 1,
) => {
  if (voiceGainMul <= 0) return;
  const now = ctx.currentTime;
  const t0 = Math.max(time, ctx.currentTime + AUDIO_START_GUARD_SEC);
  const presetBoost = getClassicOldschoolLoudnessBoost(soundType);
  if (soundType === 'hi_hat') {
    const cached = taHiHatBufferByContext.get(ctx);
    if (!cached) {
      void ensureTaHiHatBuffer(ctx);
      return;
    }
    const busIn = getVoiceLayerSumInput(ctx, 'accent');
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = cached;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(voiceGainMul * presetBoost, t0 + CLICK_ENV_ATTACK_SEC);
    src.connect(gain);
    gain.connect(busIn);
    src.start(t0);
    src.onended = () => {
      src.disconnect();
      gain.disconnect();
    };
    return;
  }
  const masterIn = getMetronomeSummingInput(ctx);
  if (soundType === 'classic') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const hpFilter = ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.setValueAtTime(1600, t0);
    const lpFilter = ctx.createBiquadFilter();
    lpFilter.type = 'lowpass';
    lpFilter.frequency.setValueAtTime(20000, t0);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1550, t0);
    osc.frequency.exponentialRampToValueAtTime(520, t0 + 0.028);
    const classicPeak = 0.36 * voiceGainMul * presetBoost;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(classicPeak, t0 + CLICK_ENV_ATTACK_SEC);
    gain.gain.exponentialRampToValueAtTime(metroEnvelopeEndFromPeak(classicPeak), t0 + 0.0336);
    osc.connect(gain);
    gain.connect(hpFilter);
    hpFilter.connect(lpFilter);
    lpFilter.connect(masterIn);
    osc.start(t0);
    osc.stop(t0 + 0.06);
    return;
  }
  if (soundType === 'oldschool') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const hpFilter = ctx.createBiquadFilter();
    const lpFilter = ctx.createBiquadFilter();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(920, t0);
    osc.frequency.exponentialRampToValueAtTime(210, t0 + 0.03);
    hpFilter.type = 'highpass';
    hpFilter.frequency.setValueAtTime(1200, t0);
    lpFilter.type = 'lowpass';
    lpFilter.frequency.setValueAtTime(20000, t0);
    const oldschoolPeak = 0.78 * voiceGainMul * presetBoost;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(oldschoolPeak, t0 + CLICK_ENV_ATTACK_SEC);
    gain.gain.exponentialRampToValueAtTime(metroEnvelopeEndFromPeak(oldschoolPeak), t0 + 0.035);
    osc.connect(gain);
    gain.connect(hpFilter);
    hpFilter.connect(lpFilter);
    lpFilter.connect(masterIn);
    osc.start(t0);
    osc.stop(t0 + 0.06);
    return;
  }
  playSharpClick(ctx, time, true, soundType, false, 'accent', voiceGainMul);
};

/** Long-press на рукоятке: `holdMs` до `onArm`; до срабатывания можно отменить жест (slop / смена value). */
type StructuralSliderThumbIdleArm = {
  holdMs: number;
  /** Пока ждём hold: смещение указателя > slop px — отмена arm (не активировать matrix вместе с движением). */
  slopPx?: number;
  /** Пока ждём hold: значение range изменилось — отмена (тянут ползунок, а не удерживают). */
  cancelArmOnValueChange?: boolean;
  onArm: () => void;
};

type StructuralSliderProps = {
  label: string;
  min: number;
  max: number;
  /** Шаг native range (poly 3 → 3; poly 2 → 2). */
  step?: number;
  value: number;
  colorClass: string;
  onCommit: (next: number) => void;
  onLiveChange?: (next: number) => void;
  onBeginDrag?: () => void;
  thumbIdleArm?: StructuralSliderThumbIdleArm;
  /** Только после реального `pointerup` с рукоятки; Bars — disarm при arm с «slider» (не cancel/blur). */
  onThumbPointerSessionEnd?: () => void;
};

/** Ширина «рукоятки» в px (совпадает с w-5 в классе слайдера) — только по ней принимаем pointerdown, не по дорожке. */
const STRUCTURAL_SLIDER_THUMB_PX = 20;

function StructuralSlider({
  label,
  min,
  max,
  step = 1,
  value,
  colorClass,
  onCommit,
  onLiveChange,
  onBeginDrag,
  thumbIdleArm,
  onThumbPointerSessionEnd,
}: StructuralSliderProps) {
  const [localValue, setLocalValue] = useState(value);
  const committedValueRef = useRef(value);
  const lastLiveValueRef = useRef(value);
  const pointerActiveRef = useRef(false);
  const pointerPosRef = useRef<{ x: number; y: number } | null>(null);
  const pointerLastMoveAtRef = useRef(0);
  const pointerIsStoppedRef = useRef(false);
  const thumbRearmOnStopPendingRef = useRef(false);
  const thumbStopWatchTimerRef = useRef<number | null>(null);
  const thumbStopWatchLastPosRef = useRef<{ x: number; y: number } | null>(null);
  const localValueRef = useRef(value);
  const thumbArmTimerRef = useRef<number | null>(null);
  const thumbArmStartRef = useRef<{ x: number; y: number } | null>(null);
  const thumbArmValueAtDownRef = useRef<number | null>(null);
  const thumbIdleArmRef = useRef(thumbIdleArm);
  thumbIdleArmRef.current = thumbIdleArm;
  const onThumbPointerSessionEndRef = useRef(onThumbPointerSessionEnd);
  onThumbPointerSessionEndRef.current = onThumbPointerSessionEnd;

  const clearThumbArmTimer = useCallback(() => {
    if (thumbArmTimerRef.current !== null) {
      window.clearTimeout(thumbArmTimerRef.current);
      thumbArmTimerRef.current = null;
    }
  }, []);

  const clearThumbStopWatchTimer = useCallback(() => {
    if (thumbStopWatchTimerRef.current !== null) {
      window.clearInterval(thumbStopWatchTimerRef.current);
      thumbStopWatchTimerRef.current = null;
    }
  }, []);

  const scheduleThumbIdleArm = useCallback(() => {
    const cfg = thumbIdleArmRef.current;
    if (!cfg) return;
    clearThumbArmTimer();
    thumbArmStartRef.current = pointerPosRef.current ? { ...pointerPosRef.current } : null;
    thumbArmValueAtDownRef.current = localValueRef.current;
    const holdMs = cfg.holdMs;
    thumbArmTimerRef.current = window.setTimeout(() => {
      thumbArmTimerRef.current = null;
      thumbArmStartRef.current = null;
      thumbArmValueAtDownRef.current = null;
      thumbIdleArmRef.current?.onArm();
    }, holdMs);
  }, [clearThumbArmTimer]);

  const startThumbStopWatch = useCallback(() => {
    clearThumbStopWatchTimer();
    pointerLastMoveAtRef.current = performance.now();
    pointerIsStoppedRef.current = false;
    thumbStopWatchLastPosRef.current = pointerPosRef.current ? { ...pointerPosRef.current } : null;
    thumbStopWatchTimerRef.current = window.setInterval(() => {
      if (!pointerActiveRef.current) return;
      const pos = pointerPosRef.current;
      const last = thumbStopWatchLastPosRef.current;
      if (pos && (!last || pos.x !== last.x || pos.y !== last.y)) {
        thumbStopWatchLastPosRef.current = { ...pos };
        pointerLastMoveAtRef.current = performance.now();
        pointerIsStoppedRef.current = false;
        return;
      }
      const isStoppedNow = performance.now() - pointerLastMoveAtRef.current >= 5;
      pointerIsStoppedRef.current = isStoppedNow;
      if (isStoppedNow && thumbRearmOnStopPendingRef.current) {
        thumbRearmOnStopPendingRef.current = false;
        scheduleThumbIdleArm();
      }
    }, 5);
  }, [clearThumbStopWatchTimer, scheduleThumbIdleArm]);

  useEffect(
    () => () => {
      clearThumbArmTimer();
      clearThumbStopWatchTimer();
    },
    [clearThumbArmTimer, clearThumbStopWatchTimer],
  );

  useEffect(() => {
    localValueRef.current = localValue;
  }, [localValue]);

  useEffect(() => {
    setLocalValue(value);
    committedValueRef.current = value;
    lastLiveValueRef.current = value;
  }, [value]);

  const normalizeValue = useCallback(
    (raw: string) => {
      const parsed = parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return localValue;
      return Math.min(max, Math.max(min, parsed));
    },
    [localValue, max, min],
  );

  const commitLocalValue = useCallback(
    (next: number) => {
      if (committedValueRef.current === next) return;
      committedValueRef.current = next;
      onCommit(next);
    },
    [onCommit],
  );

  const applyLiveValue = useCallback(
    (next: number) => {
      setLocalValue(next);
      if (lastLiveValueRef.current !== next) {
        lastLiveValueRef.current = next;
        onLiveChange?.(next);
      }
    },
    [onLiveChange],
  );

  const isPointerDownOnThumb = useCallback((clientX: number, el: HTMLInputElement) => {
    const rect = el.getBoundingClientRect();
    const span = Math.max(1, max - min);
    const v = localValueRef.current;
    const frac = (v - min) / span;
    const tw = STRUCTURAL_SLIDER_THUMB_PX;
    const trackInner = Math.max(0, rect.width - tw);
    const thumbCenterX = rect.left + frac * trackInner + tw / 2;
    return Math.abs(clientX - thumbCenterX) <= tw * 0.95;
  }, [max, min]);

  return (
    <input
      aria-label={label}
      type="range"
      min={String(min)}
      max={String(max)}
      step={String(step)}
      value={localValue}
      onPointerDown={(e) => {
        if (!isPointerDownOnThumb(e.clientX, e.currentTarget)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        pointerActiveRef.current = true;
        pointerPosRef.current = { x: e.clientX, y: e.clientY };
        pointerLastMoveAtRef.current = performance.now();
        pointerIsStoppedRef.current = false;
        thumbRearmOnStopPendingRef.current = false;
        const cfg = thumbIdleArmRef.current;
        if (cfg) {
          startThumbStopWatch();
          scheduleThumbIdleArm();
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
        }
        onBeginDrag?.();
      }}
      onPointerMove={(e) => {
        pointerPosRef.current = { x: e.clientX, y: e.clientY };
        pointerLastMoveAtRef.current = performance.now();
        pointerIsStoppedRef.current = false;
        const cfg = thumbIdleArmRef.current;
        const sp = cfg?.slopPx;
        if (typeof sp !== 'number' || thumbArmTimerRef.current === null || !thumbArmStartRef.current) return;
        const { x, y } = thumbArmStartRef.current;
        const dx = e.clientX - x;
        const dy = e.clientY - y;
        if (dx * dx + dy * dy > sp * sp) {
          clearThumbArmTimer();
          thumbArmStartRef.current = null;
          thumbArmValueAtDownRef.current = null;
        }
      }}
      onPointerUp={(e) => {
        clearThumbArmTimer();
        thumbArmStartRef.current = null;
        thumbArmValueAtDownRef.current = null;
        pointerPosRef.current = null;
        thumbRearmOnStopPendingRef.current = false;
        pointerIsStoppedRef.current = false;
        clearThumbStopWatchTimer();
        try {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        } catch {
          /* ignore */
        }
        if (pointerActiveRef.current) pointerActiveRef.current = false;
        commitLocalValue(localValue);
        onThumbPointerSessionEndRef.current?.();
      }}
      onPointerCancel={(e) => {
        clearThumbArmTimer();
        thumbArmStartRef.current = null;
        thumbArmValueAtDownRef.current = null;
        pointerPosRef.current = null;
        thumbRearmOnStopPendingRef.current = false;
        pointerIsStoppedRef.current = false;
        clearThumbStopWatchTimer();
        try {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        } catch {
          /* ignore */
        }
        if (pointerActiveRef.current) pointerActiveRef.current = false;
        commitLocalValue(localValue);
      }}
      onBlur={() => {
        thumbArmStartRef.current = null;
        thumbArmValueAtDownRef.current = null;
        pointerPosRef.current = null;
        thumbRearmOnStopPendingRef.current = false;
        pointerIsStoppedRef.current = false;
        clearThumbStopWatchTimer();
        if (!thumbIdleArmRef.current) {
          clearThumbArmTimer();
        }
        commitLocalValue(localValue);
      }}
      onInput={(e) => {
        const cfg = thumbIdleArmRef.current;
        const next = normalizeValue(e.currentTarget.value);
        const valueChanged = next !== lastLiveValueRef.current;
        if (
          cfg?.cancelArmOnValueChange &&
          thumbArmTimerRef.current !== null &&
          thumbArmValueAtDownRef.current !== null &&
          next !== thumbArmValueAtDownRef.current
        ) {
          clearThumbArmTimer();
          thumbArmStartRef.current = null;
          thumbArmValueAtDownRef.current = null;
        }
        if (cfg?.cancelArmOnValueChange && pointerActiveRef.current && valueChanged) {
          thumbRearmOnStopPendingRef.current = true;
        }
        applyLiveValue(next);
      }}
      onChange={(e) => {
        const cfg = thumbIdleArmRef.current;
        const next = normalizeValue(e.currentTarget.value);
        const valueChanged = next !== lastLiveValueRef.current;
        if (
          cfg?.cancelArmOnValueChange &&
          thumbArmTimerRef.current !== null &&
          thumbArmValueAtDownRef.current !== null &&
          next !== thumbArmValueAtDownRef.current
        ) {
          clearThumbArmTimer();
          thumbArmStartRef.current = null;
          thumbArmValueAtDownRef.current = null;
        }
        if (cfg?.cancelArmOnValueChange && pointerActiveRef.current && valueChanged) {
          thumbRearmOnStopPendingRef.current = true;
        }
        applyLiveValue(next);
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        WebkitTouchCallout: 'none',
        userSelect: 'none',
      }}
      className={`flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer touch-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 ${colorClass} [&::-webkit-slider-thumb]:rounded-full [&::-moz-range-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110`}
    />
  );
}

type TempoSliderSlot = 'hdr' | 'pnl' | 'tap';

type TempoSliderTrackProps = {
	tempoUi: number;
	tempoRef: React.MutableRefObject<number>;
	scheduleTempoCommit: (raw: number) => void;
	flushTempoCommit: () => void;
	tempoInlineEditing: boolean;
	tempoInlineFocusSlot: TempoSliderSlot | null;
	tempoSliderSlot: TempoSliderSlot;
	tempoManualText: string;
	onTempoManualTextChange: (v: string) => void;
	onCommitTempoInline: () => void;
	onCancelTempoInline: () => void;
	/** Legacy prop kept for compatibility; slider long-press now resets to minimum BPM. */
	onBeginInlineEdit?: (slot: TempoSliderSlot) => void;
	className?: string;
};

function TempoSliderTrack({
	tempoUi,
	tempoRef,
	scheduleTempoCommit,
	flushTempoCommit,
	tempoInlineEditing,
	tempoInlineFocusSlot,
	tempoSliderSlot,
	tempoManualText,
	onTempoManualTextChange,
	onCommitTempoInline,
	onCancelTempoInline,
	onBeginInlineEdit,
	className = '',
}: TempoSliderTrackProps) {
	const inlineInputRef = useRef<HTMLInputElement>(null);
	const triggerHapticPulse = useCallback((durationMs = 50) => {
		try {
			if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
				navigator.vibrate(durationMs);
			}
		} catch {
			/* ignore */
		}
	}, []);
	const isInlineThumb = tempoInlineEditing && tempoInlineFocusSlot === tempoSliderSlot;
	useLayoutEffect(() => {
		if (!isInlineThumb) return;
		const el = inlineInputRef.current;
		if (!el) return;
		el.focus();
		el.select?.();
	}, [isInlineThumb]);
	return (
		<div
			className={`${className} cursor-pointer touch-none`.trim()}
			onPointerDown={(e) => {
				const el = e.currentTarget;
				let finished = false;
				const rect = el.getBoundingClientRect();
				const thumbHalf = 24;
				const startX = e.clientX;
				const startY = e.clientY;
				// Any movement cancels long-press inline mode for this pointer session.
				const moveCancelSq = 0;
				let holdTimer: number | null = null;
				let stopWatchTimer: number | null = null;
				let pendingRearmOnStop = false;
				let pointerPos: { x: number; y: number } = { x: e.clientX, y: e.clientY };
				let lastWatchPos: { x: number; y: number } = { x: e.clientX, y: e.clientY };
				let lastMoveAt = performance.now();
				const clearHold = () => {
					if (holdTimer !== null) {
						window.clearTimeout(holdTimer);
						holdTimer = null;
					}
				};
				const startHold = () => {
					if (typeof onBeginInlineEdit !== 'function') return;
					clearHold();
					holdTimer = window.setTimeout(() => {
						holdTimer = null;
						if (finished) return;
						finished = true;
						triggerHapticPulse(50);
						flushTempoCommit();
						detachListeners();
						onBeginInlineEdit(tempoSliderSlot);
					}, TEMPO_SLIDER_INLINE_HOLD_MS);
				};
				const clearStopWatch = () => {
					if (stopWatchTimer !== null) {
						window.clearInterval(stopWatchTimer);
						stopWatchTimer = null;
					}
				};
				const startStopWatch = () => {
					clearStopWatch();
					lastWatchPos = { ...pointerPos };
					lastMoveAt = performance.now();
					stopWatchTimer = window.setInterval(() => {
						if (finished) return;
						if (pointerPos.x !== lastWatchPos.x || pointerPos.y !== lastWatchPos.y) {
							lastWatchPos = { ...pointerPos };
							lastMoveAt = performance.now();
							return;
						}
						const stopped = performance.now() - lastMoveAt >= 5;
						if (stopped && pendingRearmOnStop) {
							pendingRearmOnStop = false;
							startHold();
						}
					}, 5);
				};
				const updateTempo = (clientX: number) => {
					const activeWidth = rect.width - thumbHalf * 2;
					const x = Math.max(0, Math.min(activeWidth, clientX - rect.left - thumbHalf));
					const percent = x / Math.max(1, activeWidth);
					scheduleTempoCommit(Math.round(20 + percent * 380));
				};
				const detachListeners = () => {
					el.removeEventListener('pointermove', onMove);
					el.removeEventListener('pointerup', onUp);
					el.removeEventListener('pointercancel', onUp);
					try {
						el.releasePointerCapture(e.pointerId);
					} catch {
						/* already released */
					}
				};
				const cleanup = () => {
					if (finished) return;
					finished = true;
					clearHold();
					clearStopWatch();
					flushTempoCommit();
					detachListeners();
				};
				const onMove = (moveEvt: PointerEvent) => {
					if (finished) return;
					pointerPos = { x: moveEvt.clientX, y: moveEvt.clientY };
					lastMoveAt = performance.now();
					const dx = moveEvt.clientX - startX;
					const dy = moveEvt.clientY - startY;
					// Любое существенное движение → отмена hold'а, продолжаем drag как обычно.
					if (dx * dx + dy * dy > moveCancelSq) {
						clearHold();
						pendingRearmOnStop = true;
					}
					updateTempo(moveEvt.clientX);
				};
				const onUp = () => {
					cleanup();
				};
				el.setPointerCapture(e.pointerId);
				updateTempo(e.clientX);
				startStopWatch();
				el.addEventListener('pointermove', onMove);
				el.addEventListener('pointerup', onUp);
				el.addEventListener('pointercancel', onUp);
				startHold();
			}}
		>
			<div className="absolute w-full h-1.5 bg-[#0b101e] rounded-full overflow-hidden">
				<div
					className="h-full bg-[#364976]"
					style={{ width: `calc(24px + ${((tempoUi - 20) / 380)} * calc(100% - 48px))` }}
				/>
			</div>
			<div
				className="absolute z-10 box-border w-14 min-w-14 max-w-14 overflow-hidden bg-[#23314f] border border-[#2f4066] px-1.5 text-center py-1 rounded-full text-sm font-bold shadow-md -translate-x-1/2 flex items-center justify-center select-none"
				style={{ left: `calc(24px + ${((tempoUi - 20) / 380)} * calc(100% - 48px))` }}
			>
				{isInlineThumb ? (
					<input
						ref={inlineInputRef}
						type="text"
						inputMode="numeric"
						autoComplete="off"
						spellCheck={false}
						aria-label="BPM"
						className="min-w-0 w-full max-w-full shrink bg-transparent text-center text-sm font-bold text-slate-100 outline-none tabular-nums"
						value={tempoManualText}
						onChange={(e) => onTempoManualTextChange(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								onCommitTempoInline();
							}
							if (e.key === 'Escape') {
								e.preventDefault();
								onCancelTempoInline();
							}
						}}
						onBlur={() => onCommitTempoInline()}
						onClick={(e) => e.stopPropagation()}
						onPointerDown={(e) => e.stopPropagation()}
					/>
				) : tempoInlineEditing ? (
					<span className="block min-w-0 w-full truncate tabular-nums text-slate-300">{tempoManualText}</span>
				) : (
					<span className="block min-w-0 w-full truncate tabular-nums">{tempoUi}</span>
				)}
			</div>
		</div>
	);
}

export default function App() {
  const initialBoot = useMemo(() => loadSnapshotStorage(), []);
  const seed = initialBoot.snapshots[initialBoot.activeSnapshot];

  const [tempo, setTempo] = useState(seed.tempo);
  const [tempoUi, setTempoUi] = useState(seed.tempo);
  const [tempoInlineEditing, setTempoInlineEditing] = useState(false);
  const [tempoInlineFocusSlot, setTempoInlineFocusSlot] = useState<TempoSliderSlot | null>(null);
  const [tempoManualText, setTempoManualText] = useState('');
  const skipTempoInlineBlurCommitRef = useRef(false);
  const tempoTapInlineInputRef = useRef<HTMLInputElement>(null);
  const [bars, setBars] = useState(seed.bars);
  const [barsInlineEditing, setBarsInlineEditing] = useState(false);
  const [barsManualText, setBarsManualText] = useState(String(seed.bars));
  const [frozenRowHeightPx, setFrozenRowHeightPx] = useState<number | null>(null);
  const [frozenRowHeightsByRIdx, setFrozenRowHeightsByRIdx] = useState<Record<number, number>>({});
  const barsInlineInputRef = useRef<HTMLInputElement>(null);
  const [syllables, setSyllables] = useState(seed.syllables);

  // Metronome state
  const [isPlaying, setIsPlaying] = useState(false);
  const [autoscrollVirtualRowsEnabled, setAutoscrollVirtualRowsEnabled] = useState(false);
  const [accents, setAccents] = useState<Set<string>>(() => new Set(seed.accents));
  const [accentsByLane, setAccentsByLane] = useState<LaneSetMap>(() =>
    cloneLaneSetMap((seed as { accentsByLane?: Partial<Record<number, Iterable<string>>> }).accentsByLane)
  );
  const [taDingKeys, setTaDingKeys] = useState<Set<string>>(() => new Set(seed.taDingKeys));
  const [taDingKeysByLane, setTaDingKeysByLane] = useState<LaneSetMap>(() =>
    cloneLaneSetMap((seed as { taDingKeysByLane?: Partial<Record<number, Iterable<string>>> }).taDingKeysByLane)
  );
  const [activePos, setActivePos] = useState({ r: -1, c: -1, absR: -1 });
  const [activePositions, setActivePositions] = useState<PlayheadPosition[]>([]);
  const playAbsBarRef = useRef(0);
  const [listOffset, setListOffset] = useState(0);
  const [customSyllables, setCustomSyllables] = useState<Record<number, number>>(() => ({ ...seed.customSyllables }));
  const [deadCells, setDeadCells] = useState<DeadCellsMap>(() => ({ ...((seed as { deadCells?: DeadCellsMap }).deadCells || {}) }));
  const [customMultipliers, setCustomMultipliers] = useState<Record<number, number>>(() => ({ ...seed.customMultipliers }));
  const [customSubdivisions, setCustomSubdivisions] = useState<Record<string, number>>(() => ({ ...seed.customSubdivisions }));
  const [cellStepMasks, setCellStepMasks] = useState<CellStepMasks>(() => ({ ...(seed.cellStepMasks || {}) }));
  const [cellConfigs, setCellConfigs] = useState<CellConfigs>(() =>
    buildCellConfigsFromLegacy(seed.customSubdivisions, seed.cellStepMasks || {}),
  );
  const [customCellSyllables, setCustomCellSyllables] = useState<Record<string, string>>(() => ({
    ...((seed as { customCellSyllables?: Record<string, string> }).customCellSyllables || {}),
  }));
  const [pulseMeterUnlinked, setPulseMeterUnlinked] = useState<Record<number, boolean>>(() =>
    normalizePulseMeterUnlinked(seed.pulseMeterUnlinked),
  );

  // Metronome Sound Toggles
  const seedNewModes = deriveNewModesFromLegacySnapshot({
    squarePlaybackMode: (seed as { squarePlaybackMode?: unknown }).squarePlaybackMode,
    squarePassiveLayerMuted: (seed as { squarePassiveLayerMuted?: unknown }).squarePassiveLayerMuted,
    dictantMode: (seed as { dictantMode?: unknown }).dictantMode,
    onlyAccents: (seed as { onlyAccents?: unknown }).onlyAccents,
  });
  const [mixerLayerMode, setMixerLayerMode] = useState<MixerLayerMode>(() => {
    const raw = (seed as { mixerLayerMode?: unknown }).mixerLayerMode;
    return raw === undefined ? seedNewModes.mixerLayerMode : normalizeMixerLayerModeFromSnapshot(raw);
  });
  const [trainerMode, setTrainerMode] = useState<TrainerMode>(() => {
    const raw = (seed as { trainerMode?: unknown }).trainerMode;
    return raw === undefined ? seedNewModes.trainerMode : normalizeTrainerModeFromSnapshot(raw);
  });
  const [trainerHoldMute, setTrainerHoldMute] = useState(
    () => (seed as { trainerHoldMute?: boolean }).trainerHoldMute === true,
  );
  const onlyAccents = false;
  const dictantMode = trainerMode === 'dictation';
  const [firstBeatAccent, setFirstBeatAccent] = useState(() => seed.firstBeatAccent !== false);
  const [firstBeatAccentByLane, setFirstBeatAccentByLane] = useState<LaneBoolMap>(() =>
    cloneLaneBoolMap((seed as { firstBeatAccentByLane?: Partial<Record<number, boolean>> }).firstBeatAccentByLane, seed.firstBeatAccent !== false)
  );
  const [accentMapVersion, setAccentMapVersion] = useState(() =>
    (seed as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
  );
  const [isTaEditorMode, setIsTaEditorMode] = useState(false);
  const [isTaButtonPressed, setIsTaButtonPressed] = useState(false);
  /** Удержание Ta → вход в редактор: 0 = без заливки, 1 = полная заливка (включается скачком после `TA_EDITOR_HOLD_FILL_DEAD_MS`). */
  const [taHoldFill, setTaHoldFill] = useState(0);
  const [isDeadCellsEditorMode, setIsDeadCellsEditorMode] = useState(false);
  /** Long-press PLAY: tap a bar row to set playback start anchor (sticky across STOP). */
  const [isStartBarPickMode, setIsStartBarPickMode] = useState(false);
  /** Pick-mode UI highlight: pattern bar N, or null (no ring / legacy viewport on commit bar 0). */
  const [startBarPickHighlight, setStartBarPickHighlight] = useState<number | null>(null);
  /** В режиме Ta-редактора: строки, где пользователь снял дефолтную белую метку на первой доле (без ключа taDing). */
  const [firstBeatDingSuppressedRows, setFirstBeatDingSuppressedRows] = useState<Set<number>>(() => new Set());

  // Randomizer States
  const [randomModeEnabled, setRandomModeEnabled] = useState(seed.randomModeEnabled);
  const [randomPulsation, setRandomPulsation] = useState(seed.randomPulsation);
  const [randomPattern, setRandomPattern] = useState(seed.randomPattern);
  const [randomSpeed, setRandomSpeed] = useState(seed.randomSpeed);
  const [randomBarSpeed, setRandomBarSpeed] = useState(seed.randomBarSpeed);

  // Parent mode (наследственные мутации мотива; Phase 1 — skeleton + placeholder-заморозка).
  const [randomMode, setRandomMode] = useState<RandomMode>(seed.randomMode);
  const [parentGenome, setParentGenome] = useState<ParentGenome | null>(seed.parentGenome);
  const [parentLength, setParentLength] = useState<ParentLength>(seed.parentLength);
  const [enabledMutations, setEnabledMutations] = useState<MutationType[]>(() => [...seed.enabledMutations]);
  const [formPresetId, setFormPresetId] = useState<FormPresetId>(seed.formPresetId);
  const [progressiveDensityMode, setProgressiveDensityMode] = useState<ProgressiveDensityMode>('gati_mode');
  const [deSyncJatiActive, setDeSyncJatiActive] = useState(false);
  const [deSyncCycleLength, setDeSyncCycleLength] = useState<number | undefined>(undefined);
  const [jatiPulseActiveByRow, setJatiPulseActiveByRow] = useState<Record<number, boolean>>({});
  const [chaosLevel, setChaosLevel] = useState(
    typeof seed.chaosLevel === 'number' && seed.chaosLevel >= 0 && seed.chaosLevel <= 100
      ? seed.chaosLevel
      : 0,
  );
  const [showRandomSettings, setShowRandomSettings] = useState(false);
  const showRandomSettingsRef = useRef(false);
  showRandomSettingsRef.current = showRandomSettings;
  const [lowPerfMode, setLowPerfMode] = useState(() => {
    if ((seed as { lowPerfMode?: unknown }).lowPerfMode === true) return true;
    try {
      return localStorage.getItem(LITE_UI_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [polyMode, setPolyMode] = useState(() => {
    try {
      return localStorage.getItem(POLY_MODE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [polyVoices, setPolyVoices] = useState<2 | 3 | 4>(() => {
    try {
      return parsePolyVoices(localStorage.getItem(POLY_VOICES_STORAGE_KEY));
    } catch {
      return 2;
    }
  });
  const randomSettingsPanelRef = useRef<HTMLDivElement | null>(null);
  const cellDivsSliderPanelRef = useRef<HTMLDivElement | null>(null);
  const settingsGearButtonRef = useRef<HTMLButtonElement | null>(null);
  const coldStartRef = useRef(true);

  // Click Sound
  const [clickSound, setClickSound] = useState<ClickSoundPreset>(seed.clickSound);
  const [clickSoundByPolyVoice, setClickSoundByPolyVoice] = useState<ClickSoundByPolyVoice>(
    normalizeClickSoundByPolyVoice((seed as { clickSoundByPolyVoice?: unknown }).clickSoundByPolyVoice),
  );
  const [polyVoiceGains, setPolyVoiceGains] = useState<PolyVoiceGainMap>(() => {
    const seedSnap = initialBoot.snapshots[initialBoot.activeSnapshot] as { polyVoiceGains?: unknown };
    const fromSnapshot = parsePolyVoiceGainsFromUnknown(seedSnap.polyVoiceGains);
    if (fromSnapshot) return fromSnapshot;
    try {
      const raw = localStorage.getItem(POLY_VOICE_GAINS_STORAGE_KEY);
      if (!raw) return { ...DEFAULT_POLY_VOICE_GAINS };
      const parsed = JSON.parse(raw) as Partial<Record<number, unknown>>;
      const next: PolyVoiceGainMap = { ...DEFAULT_POLY_VOICE_GAINS };
      for (const lane of [0, 1, 2] as const) {
        const v = Number(parsed?.[lane]);
        if (Number.isFinite(v)) next[lane] = Math.max(0, Math.min(1.6, v));
      }
      return next;
    } catch {
      return { ...DEFAULT_POLY_VOICE_GAINS };
    }
  });
  const [clickPresetBusGains, setClickPresetBusGains] = useState<ClickPresetBusGainsMap>(() => {
    const fromStorage = parseClickPresetBusGainsStorage(
      typeof localStorage !== 'undefined' ? localStorage.getItem(CLICK_PRESET_BUS_GAINS_STORAGE_KEY) : null,
    );
    const seeded = {
      ...HARDCODED_DEFAULT_CLICK_PRESET_BUS_GAINS_BY_PRESET,
      ...fromStorage.byPreset,
    };
    const seedSnap = initialBoot.snapshots[initialBoot.activeSnapshot] as AppSnapshot;
    const fromSnapshotMap = parseClickBusBalanceByPresetFromUnknown(seedSnap.clickBusBalanceByPreset);
    if (fromSnapshotMap) {
      return { ...seeded, ...fromSnapshotMap };
    }
    const legacySingle = seedSnap.clickBusBalance;
    if (legacySingle) {
      const pk = isClickSoundPreset(seedSnap.clickSound) ? seedSnap.clickSound : 'classic';
      return { ...seeded, [pk]: legacySingle };
    }
    return seeded;
  });
  const [clickPresetBusGainsByVoice, setClickPresetBusGainsByVoice] = useState<ClickPresetBusGainsByVoiceMap>(() => {
    const fromStorage = parseClickPresetBusGainsStorage(
      typeof localStorage !== 'undefined' ? localStorage.getItem(CLICK_PRESET_BUS_GAINS_STORAGE_KEY) : null,
    );
    const seeded = {
      ...HARDCODED_DEFAULT_CLICK_PRESET_BUS_GAINS_BY_VOICE,
      ...fromStorage.byVoice,
    };
    const seedSnap = initialBoot.snapshots[initialBoot.activeSnapshot] as AppSnapshot;
    const fromSnapshot = parseClickBusBalanceByVoicePresetFromUnknown(seedSnap.clickBusBalanceByVoicePreset);
    if (fromSnapshot) return { ...seeded, ...fromSnapshot };
    return seeded;
  });
  // Visual-only fader positions: keep neutral default (1.0) on load.
  // Real audio gains continue to use polyVoiceGains / clickPresetBusGainsByVoice.
  const [busFaderVisualByKey, setBusFaderVisualByKey] = useState<Record<string, number>>({});
  const [polyVoiceFaderVisual, setPolyVoiceFaderVisual] = useState<Record<number, number>>({});
  const [activeClickVoiceTarget, setActiveClickVoiceTarget] = useState<0 | 1 | 2>(0);
  const activeClickVoiceTargetRef = useRef<0 | 1 | 2>(0);
  const debugTaEngineModeRef = useRef(false);
  const [isClickSoundSelectorOpen, setIsClickSoundSelectorOpen] = useState(false);

  // Preset Snapshot State (7 slots; persisted in localStorage)
  const [activeSnapshot, setActiveSnapshot] = useState(initialBoot.activeSnapshot);
  const [snapshots, setSnapshots] = useState<Record<number, any>>(() => {
    const o = initialBoot.snapshots;
    const out: Record<number, any> = {};
    for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) {
      const s = o[i];
      out[i] = {
        ...s,
        accents: new Set(s.accents),
        customSyllables: { ...s.customSyllables },
        deadCells: { ...((s as { deadCells?: DeadCellsMap }).deadCells || {}) },
        customMultipliers: { ...s.customMultipliers },
        customSubdivisions: { ...s.customSubdivisions },
        customCellSyllables: { ...((s as { customCellSyllables?: Record<string, string> }).customCellSyllables || {}) },
        panelExpanded: s.panelExpanded === true,
        pulseMeterUnlinked: { ...(s.pulseMeterUnlinked || {}) },
        frozenScale: typeof s.frozenScale === 'number' && s.frozenScale >= 1 ? s.frozenScale : null,
        polyMode: s.polyMode === true,
        polyVoices: parsePolyVoices(s.polyVoices),
		mixerLayerMode: normalizeMixerLayerModeFromSnapshot((s as { mixerLayerMode?: unknown }).mixerLayerMode),
		trainerMode: normalizeTrainerModeFromSnapshot((s as { trainerMode?: unknown }).trainerMode),
		trainerHoldMute: (s as { trainerHoldMute?: boolean }).trainerHoldMute === true,
        ...mapNewModesToLegacySnapshot(
          normalizeMixerLayerModeFromSnapshot((s as { mixerLayerMode?: unknown }).mixerLayerMode),
          normalizeTrainerModeFromSnapshot((s as { trainerMode?: unknown }).trainerMode),
        ),
        onlyAccents: false,
        firstBeatAccent: s.firstBeatAccent !== false,
        accentMapVersion: (s as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
        syllableReadMuteMode: normalizeSyllableReadMuteModeFromSnapshot(
          s.syllableReadMuteMode,
          (s as { syllableReadMuteLatched?: boolean }).syllableReadMuteLatched,
        ),
        taDingKeys: (() => {
          const raw = (s as { taDingKeys?: unknown }).taDingKeys;
          if (raw instanceof Set) return new Set(raw as Set<string>);
          if (Array.isArray(raw))
            return new Set(raw.filter((x): x is string => typeof x === 'string'));
          return new Set<string>();
        })(),
        clickSoundByPolyVoice: normalizeClickSoundByPolyVoice(
          (s as { clickSoundByPolyVoice?: unknown }).clickSoundByPolyVoice,
        ),
      };
    }
    return out;
  });

  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;
  const activeSnapshotRef = useRef(activeSnapshot);
  activeSnapshotRef.current = activeSnapshot;
  const snapshotHoldTimerRef = useRef<number | null>(null);
  const snapshotHoldSlotRef = useRef<number | null>(null);
  const snapshotHoldAteClickRef = useRef(false);
  const snapshotSlotButtonRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const [snapshotClipMenu, setSnapshotClipMenu] = useState<{
    slot: number;
    x: number;
    y: number;
  } | null>(null);

  const persistSnapshotsTimerRef = useRef<number | null>(null);
  const tempoThrottleTimerRef = useRef<number | null>(null);
  const pendingTempoRef = useRef<number | null>(null);
  const tempoHoldTimeoutRef = useRef<number | null>(null);
  const tempoHoldIntervalRef = useRef<number | null>(null);
  const tempoMinusHoldAteClickRef = useRef(false);
  const tempoPlusHoldAteClickRef = useRef(false);
  const showClipboardToast = (message: string) => {
    console.info('[konnakol_trainer] clipboard', message);
  };

  const [activeEditCell, setActiveEditCell] = useState<string | null>(null);
  const [activeEditRow, setActiveEditRow] = useState<number | null>(null);
  const [frozenScale, setFrozenScale] = useState<number | null>(() =>
    typeof seed.frozenScale === 'number' && seed.frozenScale >= 1 ? seed.frozenScale : null,
  );
  const [isPanelExpanded, setIsPanelExpanded] = useState(() => seed.panelExpanded === true);
  const isPanelExpandedRef = useRef(seed.panelExpanded === true);
  isPanelExpandedRef.current = isPanelExpanded;

  /** Удержание на стрелке сворачивания → заморозка: панель не сворачивается по тапу и при старте PLAY, пока не снять тем же жестом. */
  const [panelCollapseFrozen, setPanelCollapseFrozen] = useState(false);
  const panelCollapseFrozenRef = useRef(false);
  const panelChevronHoldTimerRef = useRef<number | null>(null);
  const panelChevronHoldLongPressReadyRef = useRef(false);
  const panelChevronHoldAteClickRef = useRef(false);

  useEffect(() => {
    panelCollapseFrozenRef.current = panelCollapseFrozen;
  }, [panelCollapseFrozen]);

  useEffect(() => {
    if (!isPanelExpanded) {
      setActiveEditCell(null);
      setActiveEditRow(null);
    }
  }, [isPanelExpanded]);

  useEffect(() => {
    if (!showRandomSettings || !isPanelExpanded) {
      setIsClickSoundSelectorOpen(false);
    }
  }, [showRandomSettings, isPanelExpanded]);


  useEffect(() => {
    if (isClickSoundSelectorOpen) return;
    if (clickPresetBusTwoBarsPreviewRetryTimerRef.current !== null) {
      window.clearTimeout(clickPresetBusTwoBarsPreviewRetryTimerRef.current);
      clickPresetBusTwoBarsPreviewRetryTimerRef.current = null;
    }
    if (clickPresetBusTwoBarsPreviewDebounceRef.current !== null) {
      window.clearTimeout(clickPresetBusTwoBarsPreviewDebounceRef.current);
      clickPresetBusTwoBarsPreviewDebounceRef.current = null;
    }
    if (clickBusSliderHoldRef.current.timer !== null) {
      window.clearTimeout(clickBusSliderHoldRef.current.timer);
      clickBusSliderHoldRef.current.timer = null;
      clickBusSliderHoldRef.current.moved = false;
      clickBusSliderHoldRef.current.token = null;
    }
    if (previewResetTimerRef.current !== null) {
      window.clearTimeout(previewResetTimerRef.current);
      previewResetTimerRef.current = null;
    }
    clearPlayheadScheduling();
    setActivePos({ r: -1, c: -1, absR: -1 });
    setActivePositions([]);
    if (!isPlayingRef.current && audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, [isClickSoundSelectorOpen]);

  /** Закрыть окно Randomizer / Settings по клику вне панели (и вне кнопки-шестерёнки). */
  useEffect(() => {
    if (!showRandomSettings) return;
    if (isClickSoundSelectorOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = e.target as Node | null;
      if (!node) return;
      if (randomSettingsPanelRef.current?.contains(node)) return;
      if (settingsGearButtonRef.current?.contains(node)) return;
      setShowRandomSettings(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [showRandomSettings, isClickSoundSelectorOpen]);

  /** Выход из редактирования Divs по любому нажатию вне блока слайдера. */
  useEffect(() => {
    if (activeEditCell === null) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = e.target as Node | null;
      if (!node) return;
      if (cellDivsSliderPanelRef.current?.contains(node)) return;
      const el =
        node instanceof Element
          ? node
          : (node.parentElement ?? null);
      // Single tap on the same active syllable should close edit mode
      // via cell click handler without immediate outside-click capture race.
      if (el?.closest(`[data-subdiv-cell-key="${activeEditCell}"]`)) return;
      setActiveEditCell(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [activeEditCell]);

  useEffect(() => {
    try {
      localStorage.setItem(LITE_UI_STORAGE_KEY, lowPerfMode ? '1' : '0');
    } catch {
      /* ignore localStorage errors */
    }
  }, [lowPerfMode]);

  useEffect(() => {
    try {
      localStorage.setItem(POLY_MODE_STORAGE_KEY, polyMode ? '1' : '0');
    } catch {
      /* ignore localStorage errors */
    }
  }, [polyMode]);

  useEffect(() => {
    try {
      localStorage.setItem(POLY_VOICES_STORAGE_KEY, String(polyVoices));
    } catch {
      /* ignore localStorage errors */
    }
  }, [polyVoices]);

  const normalizeBarsForMode = useCallback(
    (raw: number) => snapBarsToPolyGrid(raw, polyModeRef.current, polyVoicesRef.current),
    [],
  );
  useEffect(() => {
    if (frozenScale === null && frozenRowHeightPx !== null) {
      setFrozenRowHeightPx(null);
    }
    if (frozenScale === null && Object.keys(frozenRowHeightsByRIdx).length > 0) {
      setFrozenRowHeightsByRIdx({});
    }
  }, [frozenScale, frozenRowHeightPx, frozenRowHeightsByRIdx]);

  const applyBarsWithPotatoFreeze = useCallback(
    (next: number) => {
      const normalizedNext = normalizeBarsForMode(next);
      const prevBars = barsRef.current;
      setBars(normalizedNext);
      barsRef.current = normalizedNext;
      // Press Matrix gate: tile/drop from frozen baseline if armed.
      // Pure functions live in `pressMatrix.ts`; closure-resolved at call time.
      handlePressOnBarsChange(prevBars, normalizedNext);
    },
    /* `handlePressOnBarsChange` resolved via closure at call time (declared later in component body). */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [normalizeBarsForMode],
  );

  const beginBarsInlineEdit = useCallback(() => {
    setBarsManualText(String(bars));
    setBarsInlineEditing(true);
  }, [bars]);

  const commitBarsInlineEdit = useCallback(() => {
    const parsed = parseInt(barsManualText, 10);
    const normalized = Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : bars;
    applyBarsWithPotatoFreeze(normalized);
    setBarsManualText(String(normalized));
    setBarsInlineEditing(false);
  }, [applyBarsWithPotatoFreeze, bars, barsManualText]);

  const cancelBarsInlineEdit = useCallback(() => {
    setBarsManualText(String(bars));
    setBarsInlineEditing(false);
  }, [bars]);

  useEffect(() => {
    if (barsInlineEditing) return;
    setBarsManualText(String(bars));
  }, [bars, barsInlineEditing]);

  useEffect(() => {
    if (!barsInlineEditing) return;
    const rafId = window.requestAnimationFrame(() => {
      const el = barsInlineInputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [barsInlineEditing]);

  /** Целевое число тактов для parent-режима по выбранному стилю (preset). */
  function targetBarsForParentPreset(preset: FormPresetId): number {
    return clampParentTargetBars(PRESET_TARGET_BARS[preset] ?? PRESET_TARGET_BARS.random);
  }

  /** Long-press по клетке такта (поддоли). */
  const holdTimerRef = useRef<number | null>(null);
  const cellGestureMutexRef = useRef<{
    key: string;
    phase: 'armed' | 'hold-fired' | 'click-fired';
    pointerId: number | null;
  } | null>(null);
  /** Активная сессия long-press поддолей (для вертикального пролистывания пульса). */
  const subdivHoldSessionRef = useRef<{
    key: string;
    startY: number;
    baseSubdiv: number;
    lastDeltaSteps: number;
    panelExpanded: boolean;
  } | null>(null);
  /** Long-press по числу слогов в такте: gati / пульс от четвёрки (не смешивать с holdTimerRef клеток). */
  const pulseUnlinkHoldTimerRef = useRef<number | null>(null);
  /** Следующий click по кнопке пульса — только «съесть» после long-press unlink (не путать с isHoldingRef от сетки). */
  const pulseUnlinkJustFiredRef = useRef(false);
  const isHoldingRef = useRef(false);
  /** Long-press square: toggle «без щелчков по клеткам»; ding такта Ta не мьютится. */
  const squareHoldTimerRef = useRef<number | null>(null);
  const squareHoldAteClickRef = useRef(false);
  const playHoldTimerRef = useRef<number | null>(null);
  const playHoldAteClickRef = useRef(false);
  const togglePlaybackRef = useRef<() => void>(() => {});
  /** `null` = legacy viewport start; number = pattern bar index (0..bars-1). */
  const playbackStartBarOverrideRef = useRef<number | null>(null);
  const isStartBarPickModeRef = useRef(false);
  const randomDiceHoldTimerRef = useRef<number | null>(null);
  const randomDiceHoldAteClickRef = useRef(false);
  const randomDicePointerTapHandledRef = useRef(false);
  const randomDiceHoldStartedAtRef = useRef<number | null>(null);
  /** Coarse pointer: доп. выход из Press — любой `pointerdown` после arm со слайдера (когда отпускание не ловится). */
  const mobileSliderDisarmListenerAttachedRef = useRef(false);
  const detachMobileSliderCoarseDisarmRef = useRef<() => void>(() => {});
  const taHoldTimerRef = useRef<number | null>(null);
  const taHoldAteClickRef = useRef(false);
  const taHoldFillSnapTimerRef = useRef<number | null>(null);
  const midiHoldTimerRef = useRef<number | null>(null);
  const midiHoldAteClickRef = useRef(false);
  const cancelTaHoldFillAnim = () => {
    if (taHoldFillSnapTimerRef.current !== null) {
      window.clearTimeout(taHoldFillSnapTimerRef.current);
      taHoldFillSnapTimerRef.current = null;
    }
    setTaHoldFill(0);
  };
  const eraserHoldTimerRef = useRef<number | null>(null);
  const eraserHoldAteClickRef = useRef(false);
  const clickPresetBusTwoBarsPreviewDebounceRef = useRef<number | null>(null);
  const clickPresetBusTwoBarsPreviewRetryTimerRef = useRef<number | null>(null);
  const clickBusSliderHoldRef = useRef<{ timer: number | null; moved: boolean; token: string | null }>({
    timer: null,
    moved: false,
    token: null,
  });
  const CLICK_BUS_SLIDER_HOLD_MS = 600;
  const [randomDiceMintFlash, setRandomDiceMintFlash] = useState(false);
  const randomDiceMintFlashClearRef = useRef<number | null>(null);
  const [syllableReadMuteMode, setSyllableReadMuteMode] = useState<SyllableReadMuteMode>(() =>
    normalizeSyllableReadMuteModeFromSnapshot(
      seed.syllableReadMuteMode,
      (seed as { syllableReadMuteLatched?: boolean }).syllableReadMuteLatched,
    ),
  );
  const syllableReadMuteModeRef = useRef(syllableReadMuteMode);
  syllableReadMuteModeRef.current = syllableReadMuteMode;
  const tapTimesRef = useRef<number[]>([]);
  const tapBpmHoldTimerRef = useRef<number | null>(null);
  const tapBpmHoldAteClickRef = useRef(false);

  const handleTap = () => {
    const now = Date.now();
    const times = tapTimesRef.current;
    
    // Clear times if it's been more than 2 seconds since last tap
    if (times.length > 0 && now - times[times.length - 1] > 2000) {
      tapTimesRef.current = [];
    }
    
    tapTimesRef.current.push(now);
    
    // Keep only the last 4 taps for a moving average
    if (tapTimesRef.current.length > 4) {
      tapTimesRef.current.shift();
    }
    
    if (tapTimesRef.current.length > 1) {
      let totalInterval = 0;
      for (let i = 1; i < tapTimesRef.current.length; i++) {
        totalInterval += (tapTimesRef.current[i] - tapTimesRef.current[i - 1]);
      }
      const averageInterval = totalInterval / (tapTimesRef.current.length - 1);
      const newTempo = Math.round(60000 / averageInterval);
      
      // Clamp between 20 and 400
      setTempo(Math.min(400, Math.max(20, newTempo)));
    }
  };

  const clearSequencer = () => {
    setActiveEditCell(null);
    setActiveEditRow(null);
    const defaults = createEmptySnapshot();
    const emptyAcc = new Set<string>();
    setAccents(emptyAcc);
    accentsRef.current = emptyAcc;
    const emptyAccByLane = makeEmptyLaneSetMap();
    setAccentsByLane(emptyAccByLane);
    accentsByLaneRef.current = cloneLaneSetMap(emptyAccByLane);
    const emptyTaDing = new Set<string>();
    setTaDingKeys(emptyTaDing);
    taDingKeysRef.current = emptyTaDing;
    const emptyTaByLane = makeEmptyLaneSetMap();
    setTaDingKeysByLane(emptyTaByLane);
    taDingKeysByLaneRef.current = cloneLaneSetMap(emptyTaByLane);
    setAccentMapVersion(0);
    setMixerLayerMode(DEFAULT_MIXER_LAYER_MODE);
    mixerLayerModeRef.current = DEFAULT_MIXER_LAYER_MODE;
    setTrainerMode(DEFAULT_TRAINER_MODE);
    trainerModeRef.current = DEFAULT_TRAINER_MODE;
    dictantModeRef.current = false;
    setTrainerHoldMute(false);
    trainerHoldMuteRef.current = false;
    setIsTaEditorMode(false);
    setIsDeadCellsEditorMode(false);
    setFirstBeatDingSuppressedRows(new Set());
    setTempo(defaults.tempo);
    tempoRef.current = defaults.tempo;
    const defaultBars = snapBarsToPolyGrid(defaults.bars, polyModeRef.current, polyVoicesRef.current);
    setBars(defaultBars);
    barsRef.current = defaultBars;
    setSyllables(PULSE_METER_BASE_SYLLABLES);
    syllablesRef.current = PULSE_METER_BASE_SYLLABLES;
    setCustomSyllables({});
    customSyllablesRef.current = {};
    setDeadCells({});
    deadCellsRef.current = {};
    setCustomMultipliers({});
    customMultipliersRef.current = {};
    setCustomSubdivisions({});
    customSubdivisionsRef.current = {};
    setCellStepMasks({});
    cellStepMasksRef.current = {};
    setCellConfigs({});
    cellConfigsRef.current = {};
    setCustomCellSyllables({});
    customCellSyllablesRef.current = {};
    // Keep per-voice click assignments on clear (eraser should reset pattern, not voice timbres).
    setPulseMeterUnlinked({});
    pulseMeterUnlinkedRef.current = {};
    setJatiPulseActiveByRow({});
    activeJatiPhraseIdRef.current = null;
    progressiveDensityModeRef.current = 'gati_mode';
    deSyncJatiActiveRef.current = false;
    deSyncCycleLengthRef.current = undefined;
    setProgressiveDensityMode('gati_mode');
    setDeSyncJatiActive(false);
    setDeSyncCycleLength(undefined);
    setFrozenScale(null);
    frozenScaleRef.current = null;
    /* Playback start: bar 1 / legacy viewport (same as picking row 1 in PLAY hold UI). */
    playbackStartBarOverrideRef.current = null;
    setStartBarPickHighlight(null);
    setIsStartBarPickMode(false);
    isStartBarPickModeRef.current = false;
    /* Press Matrix: full eraser disarms baseline (single source of "primed" reset). */
    detachMobileSliderCoarseDisarmRef.current();
    notifyPressErased();
    setPressMatrixArmSourceUi(null);
  };

  /**
   * Chaos training mode (long-press toggle):
   * - Origin — где активировали mode. Drag не переносит chaos, но задаёт target'у speed.
   * - Target — куда слайдер будет автоматически дрейфовать.
   * - Speed = |target - origin| / CHAOS_RAMP_SPEED_DIVISOR → chaos units per bar.
   *   Пример: origin=15, target=100 → distance=85 → speed=8.5 units/bar → ~10 bars к 100.
   *   origin=15, target=30 → distance=15 → speed=1.5 units/bar → медленный подъём.
   * - Advance тик каждое bar-boundary: chaos += sign * min(remaining, round(speed)).
   *
   * Вне training (chaosRampActiveRef.current === false) — обычный слайдер.
   */
  const CHAOS_RAMP_SPEED_DIVISOR = 10;

  const handleChaosSliderChange = (raw: number) => {
    const nextChaos = Math.max(0, Math.min(100, Math.round(raw)));
    if (chaosRampActiveRef.current) {
      // Training: drag задаёт target+speed, chaosLevel НЕ меняем.
      const origin = chaosRampOriginRef.current;
      chaosRampTargetRef.current = nextChaos;
      const distance = Math.abs(nextChaos - origin);
      chaosRampSpeedRef.current = distance / CHAOS_RAMP_SPEED_DIVISOR;
      setChaosRampTarget(nextChaos);
      return;
    }
    if (nextChaos === chaosLevelRef.current) return;
    chaosLevelRef.current = nextChaos;
    setChaosLevel(nextChaos);
  };

  const activateChaosRamp = useCallback(() => {
    chaosRampActiveRef.current = true;
    setChaosRampActive(true);
    const origin = chaosLevelRef.current;
    chaosRampOriginRef.current = origin;
    chaosRampTargetRef.current = origin;
    chaosRampSpeedRef.current = 0;
    setChaosRampTarget(null);
  }, []);

  const deactivateChaosRamp = useCallback(() => {
    if (!chaosRampActiveRef.current) return;
    chaosRampActiveRef.current = false;
    setChaosRampActive(false);
    chaosRampTargetRef.current = 0;
    chaosRampSpeedRef.current = 0;
    setChaosRampTarget(null);
  }, []);

  /** Один тик ramp'а на границе такта — сдвиг chaos к target на round(speed) шагов. */
  const advanceChaosRampOneStep = useCallback(() => {
    if (!chaosRampActiveRef.current) return;
    const cur = chaosLevelRef.current;
    const target = chaosRampTargetRef.current;
    const speed = chaosRampSpeedRef.current;
    if (speed < 0.5) return; // target не задан / совпадает с origin → idle
    if (cur === target) return; // уже достигли
    const delta = target - cur;
    const sign = delta > 0 ? 1 : -1;
    const mag = Math.min(Math.abs(delta), Math.max(1, Math.round(speed)));
    const next = Math.max(0, Math.min(100, cur + sign * mag));
    if (next === cur) return;
    chaosLevelRef.current = next;
    setChaosLevel(next);
  }, []);

  /** Long-press hold-detect: 600ms без drag-движения > 3px → toggle training-режима. */
  const CHAOS_RAMP_HOLD_MS = 600;
  const CHAOS_RAMP_MOVE_CANCEL_PX = 3;

  const cancelChaosRampPress = useCallback(() => {
    if (chaosRampPressTimerRef.current !== null) {
      window.clearTimeout(chaosRampPressTimerRef.current);
      chaosRampPressTimerRef.current = null;
    }
    chaosRampPointerStartRef.current = null;
  }, []);

  const handleChaosSliderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLInputElement>) => {
      cancelChaosRampPress();
      chaosRampPointerStartRef.current = { x: e.clientX, y: e.clientY };
      // Hold без движения → toggle training on/off. Drag > threshold отменяет hold
      // (см. handleChaosSliderPointerMove), так что обычное перетаскивание не переключает режим.
      chaosRampPressTimerRef.current = window.setTimeout(() => {
        chaosRampPressTimerRef.current = null;
        if (chaosRampActiveRef.current) {
          deactivateChaosRamp();
        } else {
          activateChaosRamp();
        }
      }, CHAOS_RAMP_HOLD_MS);
    },
    [activateChaosRamp, cancelChaosRampPress, deactivateChaosRamp],
  );

  const handleChaosSliderPointerMove = useCallback(
    (e: React.PointerEvent<HTMLInputElement>) => {
      const start = chaosRampPointerStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > CHAOS_RAMP_MOVE_CANCEL_PX) cancelChaosRampPress();
    },
    [cancelChaosRampPress],
  );

  const toggleRandomFeature = (feature: 'pulsation' | 'pattern' | 'speed' | 'barSpeed') => {
    if (feature === 'pulsation') {
      const next = !randomPulsation;
      randomPulsationRef.current = next;
      setRandomPulsation(next);
    } else if (feature === 'pattern') {
      setRandomPattern(!randomPattern);
    } else if (feature === 'speed') {
      setRandomSpeed(!randomSpeed);
    } else if (feature === 'barSpeed') {
      const next = !randomBarSpeed;
      randomBarSpeedRef.current = next;
      setRandomBarSpeed(next);
    }
  };

  // (Removed Djembe hold timers)

  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledPageRef = useRef<number>(-1);
  const wasPlayingAutoscrollRef = useRef(false);
  const autoscrollDisabledByUserRef = useRef(false);
  const programmaticAutoscrollRef = useRef(false);
  const programmaticAutoscrollSawScrollRef = useRef(false);
  /** Макс. время держать programmatic после scrollIntoView, если не пришли scroll-события (уже у цели). */
  const programmaticAutoscrollFallbackTimerRef = useRef<number | null>(null);
  /** Сброс programmatic после последнего scroll во время программной анимации (smooth дольше 180ms). */
  const programmaticAutoscrollSettleTimerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timerIDRef = useRef<number | null>(null);
  const playheadQueueRef = useRef<PlayheadHighlightEvent[]>([]);
  const playheadTimerRef = useRef<number | null>(null);
  /** Poly sub_legacy: по одному слоту индикатора на temporal lane (см. `polySubLegacyLaneIndicatorStore`). */
  const polySubLegacyLaneIndicatorStoreRef = useRef(createPolySubLegacyLaneIndicatorStore());
  const previewResetTimerRef = useRef<number | null>(null);
  /** Полиметр: плотный числовой ключ снижает churn строк в hot-path. */
  const polyClickSlotsRef = useRef<Set<number>>(new Set());
  /** Poly: независимые sub_legacy-линии (см. `polySubLegacyScheduler.ts`). */
  const polySubLegacyRef = useRef<PolySubLegacyScheduler | null>(null);
  /** Таймеры отложенных щелчков (hybrid live-touch defer): сброс при стопе / превью / старте. */
  const pendingGridClickDeferredRef = useRef<PendingGridDeferredEvent[]>([]);
  /** playTwoBars preview: emit разрешён без isPlaying. */
  const gridPreviewAudioActiveRef = useRef(false);
  const schedulerProfileRef = useRef<MetraSchedulerProfile>(DEFAULT_SCHEDULER_PROFILE);
  const schedulerConfigRef = useRef(getMetraSchedulerConfig(DEFAULT_SCHEDULER_PROFILE));
  const schedulerSafeProfileEscalationsRef = useRef(0);
  const schedulerLastTickPerfRef = useRef<number | null>(null);
  const schedulerPostStallCooldownUntilPerfRef = useRef(0);
  const audioTimingMetricsRef = useRef<AudioTimingMetrics>(makeAudioTimingMetrics());
  const liveControlActiveRef = useRef(false);
  const liveControlUntilRef = useRef(0);
  const liveControlWatchdogTimerRef = useRef<number | null>(null);
  const hybridModeRef = useRef<'stable' | 'live'>('stable');
  const hybridModeLockUntilRef = useRef(0);
  const liveWindowStartedAtRef = useRef<number | null>(null);
  const latestSubStepSecRef = useRef(60 / Math.max(1, tempo));
  const clearPendingGridClickTimers = () => {
    for (const pending of pendingGridClickDeferredRef.current) {
      window.clearTimeout(pending.id);
    }
    pendingGridClickDeferredRef.current = [];
  };
  const sequencerGridRowActionsRef = useRef<SequencerGridRowActions | null>(null);
  const nextNoteTimeRef = useRef(0);
  const currentStepRef = useRef(0);
  const isPlayingRef = useRef(false);
  const polyModeRef = useRef(polyMode);
  const polyVoicesRef = useRef<2 | 3 | 4>(polyVoices);

  const barsRef = useRef(bars);
  const syllablesRef = useRef(syllables);
  const tempoRef = useRef(tempo);
  const accentsRef = useRef<Set<string>>(accents);
  const accentsByLaneRef = useRef<LaneSetMap>(cloneLaneSetMap(accentsByLane));
  const taDingKeysRef = useRef<Set<string>>(taDingKeys);
  const taDingKeysByLaneRef = useRef<LaneSetMap>(cloneLaneSetMap(taDingKeysByLane));
  const customSyllablesRef = useRef(customSyllables);
  const deadCellsRef = useRef<DeadCellsMap>(deadCells);
  const customMultipliersRef = useRef(customMultipliers);
  const customSubdivisionsRef = useRef(customSubdivisions);
  const cellStepMasksRef = useRef<CellStepMasks>(cellStepMasks);
  const cellConfigsRef = useRef<CellConfigs>(cellConfigs);
  const customCellSyllablesRef = useRef(customCellSyllables);
  const pulseMeterUnlinkedRef = useRef(pulseMeterUnlinked);
  const prevCustomSyllablesRef = useRef<Record<number, number>>({ ...customSyllables });
  const onlyAccentsRef = useRef(onlyAccents);
  const mixerLayerModeRef = useRef<MixerLayerMode>(mixerLayerMode);
  const trainerModeRef = useRef<TrainerMode>(trainerMode);
  const trainerHoldMuteRef = useRef(trainerHoldMute);
  const dictantModeRef = useRef(dictantMode);
  const firstBeatAccentRef = useRef(firstBeatAccent);
  const firstBeatAccentByLaneRef = useRef<LaneBoolMap>(firstBeatAccentByLane);
  const accentMapVersionRef = useRef(accentMapVersion);
  const isTaEditorModeRef = useRef(isTaEditorMode);
  const isDeadCellsEditorModeRef = useRef(isDeadCellsEditorMode);
  const firstBeatDingSuppressedRowsRef = useRef(firstBeatDingSuppressedRows);
  const randomModeEnabledRef = useRef(randomModeEnabled);
  const randomPulsationRef = useRef(randomPulsation);
  const randomPatternRef = useRef(randomPattern);
  const randomSpeedRef = useRef(randomSpeed);
  const randomBarSpeedRef = useRef(randomBarSpeed);
  // Parent-mode refs — доступ из bar-boundary колбэков без ре-рендеров.
  const randomModeRef = useRef<RandomMode>(randomMode);
  const parentGenomeRef = useRef<ParentGenome | null>(parentGenome);
  const parentLengthRef = useRef<ParentLength>(parentLength);
  const enabledMutationsRef = useRef<MutationType[]>(enabledMutations);
  const formPresetIdRef = useRef<FormPresetId>(formPresetId);
  const progressiveDensityModeRef = useRef<ProgressiveDensityMode>(progressiveDensityMode);
  const deSyncJatiActiveRef = useRef(deSyncJatiActive);
  const deSyncCycleLengthRef = useRef<number | undefined>(deSyncCycleLength);
  const activeJatiPhraseIdRef = useRef<number | null>(null);
  /** Расписание фраз (per такт). Пересчитывается при смене mode/parent/bars/enabled/preset/re-roll. */
  const phraseScheduleRef = useRef<PhraseSchedule>([]);
  /** Per-bar seed последнего применённого рандома — для replay такта (mulberry32). */
  const lastBarSeedRef = useRef<Record<number, number>>({});
  const chaosLevelRef = useRef(chaosLevel);
  /**
   * Chaos auto-ramp: long-press на слайдере → chaos сам ползёт к 100 с learning-curve
   * (ease-in-out: быстрый warmup / долгая зона обучения / плавное восхождение).
   * Manual drag, pause, randomizer-off или достижение 100 — выключают режим.
   */
  const [chaosRampActive, setChaosRampActive] = useState(false);
  const chaosRampActiveRef = useRef(false);
  /** Origin (точка старта training-режима) — slider визуально "стоит" здесь во время drag'а. */
  const chaosRampOriginRef = useRef(0);
  /** Target — цель автопродвижения chaos'а, задаётся drag'ом по слайдеру. */
  const chaosRampTargetRef = useRef(0);
  /** Speed (chaos units per bar) — пропорциональна |target - origin|. */
  const chaosRampSpeedRef = useRef(0);
  /** UI-state для вторичного ring'а (target-индикатор на треке). null = таргет не задан. */
  const [chaosRampTarget, setChaosRampTarget] = useState<number | null>(null);
  const chaosRampPressTimerRef = useRef<number | null>(null);
  const chaosRampPointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const clickSoundRef = useRef(clickSound);
  const clickSoundByPolyVoiceRef = useRef<ClickSoundByPolyVoice>(clickSoundByPolyVoice);
  const polyVoiceGainsRef = useRef<PolyVoiceGainMap>(polyVoiceGains);
  const clickPresetBusGainsRef = useRef<ClickPresetBusGainsMap>(clickPresetBusGains);
  const clickPresetBusGainsByVoiceRef = useRef<ClickPresetBusGainsByVoiceMap>(clickPresetBusGainsByVoice);
  /** Последний пресет, для которого вызван cloneClickMixerFromLibrary (см. блок синхронизации в render). */
  const clickSoundMixerClonedKeyRef = useRef<ClickSoundPreset | null>(null);
  const frozenScaleRef = useRef(frozenScale);

  /** Пока тянут глобальные слайдеры Bars/Syllables — не писать `snapshots` из эффекта; flush на pointerup. */
  const barsSliderDraggingRef = useRef(false);
  const syllablesSliderDraggingRef = useRef(false);
  const sliderWindowListenersAttachedRef = useRef(false);
  /** `pointerup` после drag Bars (window capture); disarm Press slider-сессии. */
  const barsSliderPressSessionEndRef = useRef<(() => void) | null>(null);
  const onWindowPointerEndCaptureRef = useRef<(e?: Event) => void>(() => {});
  const flushLiveSnapshotToActiveSlotRef = useRef<() => void>(() => {});
  const deadSwipeSessionRef = useRef<{
    row: number;
    startCell: number;
    triggered: boolean;
    fromCenter: boolean;
    restoreMode: boolean;
    startX: number;
    startY: number;
    rect: { left: number; right: number; top: number; bottom: number };
  } | null>(null);

  const accumulateLiveWindowMetrics = useCallback((nowMs: number) => {
    const startedAt = liveWindowStartedAtRef.current;
    if (startedAt === null) return;
    if (nowMs <= startedAt) return;
    audioTimingMetricsRef.current.liveWindowActiveMs += nowMs - startedAt;
    liveWindowStartedAtRef.current = nowMs;
  }, []);

  const endLiveControlWindow = useCallback(() => {
    const nowMs = performance.now();
    liveControlActiveRef.current = false;
    const tailMs = Math.max(
      HYBRID_TAIL_MIN_MS,
      Math.min(HYBRID_TAIL_MAX_MS, 0.8 * latestSubStepSecRef.current * 1000),
    );
    liveControlUntilRef.current = nowMs + tailMs;
    if (liveControlWatchdogTimerRef.current !== null) {
      window.clearTimeout(liveControlWatchdogTimerRef.current);
      liveControlWatchdogTimerRef.current = null;
    }
    accumulateLiveWindowMetrics(nowMs);
  }, [accumulateLiveWindowMetrics]);

  const beginLiveControlWindow = useCallback(() => {
    const nowMs = performance.now();
    liveControlActiveRef.current = true;
    liveControlUntilRef.current = nowMs + HYBRID_TAIL_MAX_MS;
    if (liveWindowStartedAtRef.current === null) {
      liveWindowStartedAtRef.current = nowMs;
    }
    if (liveControlWatchdogTimerRef.current !== null) {
      window.clearTimeout(liveControlWatchdogTimerRef.current);
    }
    liveControlWatchdogTimerRef.current = window.setTimeout(() => {
      endLiveControlWindow();
    }, HYBRID_LIVE_WATCHDOG_MS);
  }, [endLiveControlWindow]);

  useEffect(() => {
    return () => {
      if (liveControlWatchdogTimerRef.current !== null) {
        window.clearTimeout(liveControlWatchdogTimerRef.current);
        liveControlWatchdogTimerRef.current = null;
      }
    };
  }, []);

  const registerModeSwitch = useCallback((nextMode: 'stable' | 'live', nowMs: number) => {
    if (hybridModeRef.current === nextMode) return;
    hybridModeRef.current = nextMode;
    hybridModeLockUntilRef.current =
      nowMs + Math.max(HYBRID_MODE_MIN_HOLD_FLOOR_MS, schedulerConfigRef.current.lookaheadMs);
    audioTimingMetricsRef.current.modeSwitchCount += 1;
    if (nextMode === 'stable') {
      accumulateLiveWindowMetrics(nowMs);
      liveWindowStartedAtRef.current = null;
    } else if (liveWindowStartedAtRef.current === null) {
      liveWindowStartedAtRef.current = nowMs;
    }
  }, [accumulateLiveWindowMetrics]);

  const settleDeferredQueueForStable = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const nowSec = ctx.currentTime;
    const keep: PendingGridDeferredEvent[] = [];
    const safetyLeadSec = schedulerConfigRef.current.safetyLeadSec;
    for (const pending of pendingGridClickDeferredRef.current) {
      const remainingMs = (pending.targetTime - nowSec) * 1000;
      if (remainingMs <= HYBRID_PENDING_DOIGR_LIMIT_MS) {
        keep.push(pending);
        continue;
      }
      window.clearTimeout(pending.id);
      audioTimingMetricsRef.current.deferCanceledCount += 1;
      if (pending.targetTime > nowSec + safetyLeadSec) {
        pending.fire();
        audioTimingMetricsRef.current.deferRescheduledCount += 1;
      } else {
        recordAudioDroppedEvent();
      }
    }
    pendingGridClickDeferredRef.current = keep;
  }, []);

  useEffect(() => { barsRef.current = bars; }, [bars]);
  useEffect(() => { syllablesRef.current = syllables; }, [syllables]);
  useEffect(() => { tempoRef.current = tempo; }, [tempo]);
  useEffect(() => { setTempoUi(tempo); }, [tempo]);
  useEffect(() => { accentsRef.current = new Set(accents); }, [accents]);
  useEffect(() => { taDingKeysRef.current = new Set(taDingKeys); }, [taDingKeys]);
  useEffect(() => { accentsByLaneRef.current = cloneLaneSetMap(accentsByLane); }, [accentsByLane]);
  useEffect(() => { taDingKeysByLaneRef.current = cloneLaneSetMap(taDingKeysByLane); }, [taDingKeysByLane]);
  useEffect(() => { clickSoundByPolyVoiceRef.current = { ...clickSoundByPolyVoice }; }, [clickSoundByPolyVoice]);
  useEffect(() => { polyVoiceGainsRef.current = { ...polyVoiceGains }; }, [polyVoiceGains]);
  useEffect(() => {
    clickPresetBusGainsRef.current = { ...clickPresetBusGains };
  }, [clickPresetBusGains]);
  useEffect(() => {
    clickPresetBusGainsByVoiceRef.current = { ...clickPresetBusGainsByVoice };
  }, [clickPresetBusGainsByVoice]);
  useEffect(() => {
    try {
      localStorage.setItem(POLY_VOICE_GAINS_STORAGE_KEY, JSON.stringify(polyVoiceGains));
    } catch {
      // ignore storage errors
    }
  }, [polyVoiceGains]);
  useEffect(() => {
    try {
      const payload: ClickPresetBusGainsStorageV2 = {
        v: 2,
        byPreset: clickPresetBusGains,
        byVoice: clickPresetBusGainsByVoice,
      };
      localStorage.setItem(CLICK_PRESET_BUS_GAINS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore storage errors */
    }
  }, [clickPresetBusGains, clickPresetBusGainsByVoice]);
  /* Прямые присваивания (без spread) для ref-first путей (poly randomizer и т.п.):
   * ref === state → мутации переживают перерендеры и долетают до setState({...ref}). */
  useEffect(() => { customMultipliersRef.current = customMultipliers; }, [customMultipliers]);
  useEffect(() => { customSubdivisionsRef.current = customSubdivisions; }, [customSubdivisions]);
  useEffect(() => { cellStepMasksRef.current = cellStepMasks; }, [cellStepMasks]);
  useEffect(() => {
    const nextConfigs = buildCellConfigsFromLegacy(customSubdivisions, cellStepMasks);
    cellConfigsRef.current = nextConfigs;
    setCellConfigs(nextConfigs);
  }, [customSubdivisions, cellStepMasks]);
  useEffect(() => { cellConfigsRef.current = cellConfigs; }, [cellConfigs]);
  useEffect(() => { customCellSyllablesRef.current = customCellSyllables; }, [customCellSyllables]);

  const applyCellIntent = useCallback((row: number, cell: number, intent: CellIntent) => {
    const cellKey = `${row}-${cell}`;
    const fallbackSubdivs = customSubdivisionsRef.current[cellKey] ?? 1;
    const nextConfigs = { ...cellConfigsRef.current };
    const current = ensureCellConfig(cellKey, fallbackSubdivs, nextConfigs, cellStepMasksRef.current);
    nextConfigs[cellKey] = applyCellIntentToConfig(current, intent);
    const legacy = splitCellConfigsToLegacy(nextConfigs);
    cellConfigsRef.current = nextConfigs;
    customSubdivisionsRef.current = legacy.customSubdivs;
    cellStepMasksRef.current = legacy.cellStepMasks;
    setCellConfigs(nextConfigs);
    setCustomSubdivisions(legacy.customSubdivs);
    setCellStepMasks(legacy.cellStepMasks);
  }, []);

  const toggleCellStepMute = useCallback((cellKey: string, stepIdx: number) => {
    const [rowStr, colStr] = cellKey.split('-');
    const row = Number(rowStr);
    const cell = Number(colStr);
    if (!Number.isFinite(row) || !Number.isFinite(cell)) return;
    applyCellIntent(row, cell, { type: 'TOGGLE_SUBSTEP', stepIdx });
  }, [applyCellIntent]);
  const handleCellDivUpdate = useCallback((cellKey: string, nextValue: number) => {
    if (!Number.isFinite(nextValue)) return;
    const nextInt = Math.floor(nextValue);
    if (nextInt < 0 || nextInt > 9) return;
    const currentSubdivs = customSubdivisionsRef.current[cellKey] || 1;
    if (nextInt === 0) {
      const nextMasks = {
        ...cellStepMasksRef.current,
        [cellKey]: new Array(currentSubdivs).fill(false),
      };
      cellStepMasksRef.current = nextMasks;
      setCellStepMasks(nextMasks);
      return;
    }
    const nextSubdivisions = {
      ...customSubdivisionsRef.current,
      [cellKey]: nextInt,
    };
    customSubdivisionsRef.current = nextSubdivisions;
    setCustomSubdivisions(nextSubdivisions);
    const nextMasks = { ...cellStepMasksRef.current };
    delete nextMasks[cellKey];
    cellStepMasksRef.current = nextMasks;
    setCellStepMasks(nextMasks);
  }, []);
  useEffect(() => { pulseMeterUnlinkedRef.current = pulseMeterUnlinked; }, [pulseMeterUnlinked]);
  useEffect(() => {
    const prev = prevCustomSyllablesRef.current;
    if (isPlayingRef.current && polyModeRef.current && audioCtxRef.current && polySubLegacyRef.current) {
      const poly = polySubLegacyRef.current;
      const nowAnchor = audioCtxRef.current.currentTime + schedulerConfigRef.current.scheduleAheadSec;
      const maxBars = Math.max(0, barsRef.current);
      for (let barIdx = 0; barIdx < maxBars; barIdx++) {
        const prevSyl = prev[barIdx] !== undefined ? prev[barIdx]! : syllablesRef.current;
        const nextSyl = customSyllables[barIdx] !== undefined ? customSyllables[barIdx]! : syllablesRef.current;
        if (prevSyl === nextSyl) continue;
        poly.handleRowSyllablesHotSwitch(barIdx, prevSyl, nextSyl, nowAnchor);
      }
    }
    prevCustomSyllablesRef.current = { ...customSyllables };
  }, [customSyllables]);
  useEffect(() => { customSyllablesRef.current = customSyllables; }, [customSyllables]);
  useEffect(() => { deadCellsRef.current = deadCells; }, [deadCells]);

  /** Dead-cells meta не должна блокировать снижение пульсации: при меньшем числе слогов в такте убираем «пустые» хвосты и запись, если первый мёртвый индекс ≥ длины такта. */
  useEffect(() => {
    setDeadCells((prev) => {
      let changed = false;
      const out: DeadCellsMap = { ...prev };
      for (const rk of Object.keys(prev)) {
        const r = parseInt(rk, 10);
        if (!Number.isFinite(r) || r < 0 || r >= bars) {
          delete out[r];
          changed = true;
          continue;
        }
        const rowSyl = customSyllables[r] !== undefined ? customSyllables[r] : syllables;
        const meta = prev[r];
        if (!meta) continue;
        if (meta.deadStart >= rowSyl) {
          delete out[r];
          changed = true;
          continue;
        }
        if (meta.displayLen !== rowSyl || meta.baseLen !== rowSyl) {
          out[r] = { deadStart: meta.deadStart, displayLen: rowSyl, baseLen: rowSyl };
          changed = true;
        }
      }
      return changed ? out : prev;
    });
  }, [customSyllables, syllables, bars]);

  useEffect(() => {
    onlyAccentsRef.current = false;
    mixerLayerModeRef.current = mixerLayerMode;
  }, [mixerLayerMode]);
  useEffect(() => {
    trainerModeRef.current = trainerMode;
    dictantModeRef.current = trainerMode === 'dictation';
  }, [trainerMode]);
  useEffect(() => {
    trainerHoldMuteRef.current = trainerHoldMute;
  }, [trainerHoldMute]);
  useEffect(() => { firstBeatAccentRef.current = firstBeatAccent; }, [firstBeatAccent]);
  useEffect(() => { firstBeatAccentByLaneRef.current = { ...firstBeatAccentByLane }; }, [firstBeatAccentByLane]);
  useEffect(() => {
    if (!polyMode) return;
    const next = distributeSetToLanes(accents, bars, polyVoices);
    setAccentsByLane(next);
    accentsByLaneRef.current = cloneLaneSetMap(next);
  }, [accents, bars, polyMode, polyVoices]);
  // FRAGILE — poly Ta lane map: desync from flat taDingKeys breaks grid highlights and pack/paste.
  useEffect(() => {
    if (!polyMode) return;
    const next = distributeSetToLanes(taDingKeys, bars, polyVoices);
    setTaDingKeysByLane(next);
    taDingKeysByLaneRef.current = cloneLaneSetMap(next);
  }, [taDingKeys, bars, polyMode, polyVoices]);
  useEffect(() => {
    setFirstBeatDingSuppressedRows((prev) => {
      const next = new Set<number>();
      for (const r of prev) {
        if (r >= 0 && r < bars) next.add(r);
      }
      if (next.size === prev.size) {
        for (const r of prev) {
          if (!next.has(r)) return next;
        }
        return prev;
      }
      return next;
    });
  }, [bars]);

  /**
   * Press Matrix helpers — собирают PressState из refs и применяют patch.
   *
   * Контракт: see `pressMatrix.ts`. Refs здесь — стабильные ссылки на текущее
   * состояние. Setters стабильны через render'ы. Helpers безопасно вызывать
   * из любых обработчиков, в т.ч. из `applyBarsWithPotatoFreeze` (closure).
   */
  const getPressState = useCallback((): PressState => ({
    bars: barsRef.current,
    syllables: syllablesRef.current,
    polyMode: polyModeRef.current,
    polyVoices: polyVoicesRef.current,
    customSyllables: { ...customSyllablesRef.current },
    customMultipliers: { ...customMultipliersRef.current },
    customSubdivisions: { ...customSubdivisionsRef.current },
    cellStepMasks: { ...cellStepMasksRef.current },
    customCellSyllables: { ...customCellSyllablesRef.current },
    accents: new Set(accentsRef.current),
    taDingKeys: new Set(taDingKeysRef.current),
    accentsByLane: cloneLaneSetMap(accentsByLaneRef.current),
    taDingKeysByLane: cloneLaneSetMap(taDingKeysByLaneRef.current),
    firstBeatDingSuppressedRows: new Set(firstBeatDingSuppressedRowsRef.current),
    pulseMeterUnlinked: { ...pulseMeterUnlinkedRef.current },
    deadCells: { ...deadCellsRef.current },
  }), []);

  const applyPressPatch = useCallback((patch: PressPatch) => {
    if (patch.customSyllables) {
      customSyllablesRef.current = patch.customSyllables;
      setCustomSyllables(patch.customSyllables);
    }
    if (patch.customMultipliers) {
      customMultipliersRef.current = patch.customMultipliers;
      setCustomMultipliers(patch.customMultipliers);
    }
    if (patch.customSubdivisions) {
      customSubdivisionsRef.current = patch.customSubdivisions;
      setCustomSubdivisions(patch.customSubdivisions);
      const nextConfigs = buildCellConfigsFromLegacy(patch.customSubdivisions, cellStepMasksRef.current);
      cellConfigsRef.current = nextConfigs;
      setCellConfigs(nextConfigs);
    }
    if (patch.cellStepMasks) {
      cellStepMasksRef.current = patch.cellStepMasks;
      setCellStepMasks(patch.cellStepMasks);
      const nextConfigs = buildCellConfigsFromLegacy(customSubdivisionsRef.current, patch.cellStepMasks);
      cellConfigsRef.current = nextConfigs;
      setCellConfigs(nextConfigs);
    }
    if (patch.customCellSyllables) {
      customCellSyllablesRef.current = patch.customCellSyllables;
      setCustomCellSyllables(patch.customCellSyllables);
    }
    if (patch.accents) {
      accentsRef.current = patch.accents;
      setAccents(patch.accents);
    }
    if (patch.accentsByLane) {
      accentsByLaneRef.current = patch.accentsByLane;
      setAccentsByLane(patch.accentsByLane);
    }
    if (patch.taDingKeys) {
      taDingKeysRef.current = patch.taDingKeys;
      setTaDingKeys(patch.taDingKeys);
    }
    if (patch.taDingKeysByLane) {
      taDingKeysByLaneRef.current = patch.taDingKeysByLane;
      setTaDingKeysByLane(patch.taDingKeysByLane);
    }
    if (patch.firstBeatDingSuppressedRows) {
      firstBeatDingSuppressedRowsRef.current = patch.firstBeatDingSuppressedRows;
      setFirstBeatDingSuppressedRows(patch.firstBeatDingSuppressedRows);
    }
    if (patch.pulseMeterUnlinked) {
      pulseMeterUnlinkedRef.current = patch.pulseMeterUnlinked;
      setPulseMeterUnlinked(patch.pulseMeterUnlinked);
    }
    if (patch.deadCells) {
      deadCellsRef.current = patch.deadCells;
      setDeadCells(patch.deadCells);
    }
  }, []);

  /**
   * Press Matrix: при `bars` expand — tile из baseline (frozen at arm time);
   * при shrink — drop всех данных за пределом. Гейт: only when primed.
   * Pure-функции из `pressMatrix.ts` принимают prevN и nextM как параметры,
   * избегая зависимости от refs.
   */
  const handlePressOnBarsChange = useCallback((prevBars: number, nextBars: number) => {
    if (!isPressPrimed()) return;
    if (prevBars === nextBars) return;
    const baseline = getPressBaseline();
    if (!baseline) return;
    const live = getPressState();
    if (nextBars > prevBars) {
      const sourceN = baseline.bars >= 1 ? baseline.bars : prevBars;
      if (sourceN < 1) return;
      applyPressPatch(tilePress(prevBars, nextBars, live, baseline.state, sourceN));
    } else {
      applyPressPatch(dropPress(nextBars, live));
    }
  }, [getPressState, applyPressPatch]);

  /**
   * Press Matrix (источник в `pressMatrixCoordinator` `PressArmSource`):
   * - Снежинка: arm с `'star'` — выход только повторным long-press по снежинке.
   * - Bars thumb: arm с `'slider'` — выход при отпускании рукоятки (session end).
   *   До arm: движение > slop или смена value — отмена (не matrix «вместе с движением»).
   * - На `(pointer: coarse)` дополнительно: любой следующий `pointerdown` снимает `'slider'`-сессию.
   * Eraser сбрасывает оба. Snapshot непустой — arm как `'star'` (выход как у звезды).
   */
  const PRESS_LONG_PRESS_MS = 600;
  /** Снежинка: slop отмены long-press при съезде пальца до истечения hold. */
  const PRESS_STAR_ARM_SLOP_PX = 8;
  /** Bars: до срабатывания long-press arm — порог смещения указателя (px). */
  const PRESS_BARS_SLIDER_ARM_SLOP_PX = 10;
  /** UI: источник arm (star|slider) — фиолет thumb Bars при любом primed; снежинка glow тоже при любом primed. */
  const [pressMatrixArmSourceUi, setPressMatrixArmSourceUi] = useState<PressArmSource | null>(null);
  const pressStarLongPressTimerRef = useRef<number | null>(null);
  const pressStarLongPressFiredRef = useRef(false);
  const pressStarArmStartRef = useRef<{ x: number; y: number } | null>(null);
  const [isPressStarLongPressing, setIsPressStarLongPressing] = useState(false);

  const disarmPressMatrixModeRef = useRef<() => void>(() => {});

  const stableMobileCoarsePointerDown = useCallback((e: Event) => {
    void e;
    try {
      if (!window.matchMedia('(pointer: coarse)').matches) return;
    } catch {
      return;
    }
    if (!isPressPrimed() || getPressArmSource() !== 'slider') return;
    disarmPressMatrixModeRef.current();
  }, []);

  const detachMobileSliderCoarseDisarm = useCallback(() => {
    if (!mobileSliderDisarmListenerAttachedRef.current) return;
    mobileSliderDisarmListenerAttachedRef.current = false;
    window.removeEventListener('pointerdown', stableMobileCoarsePointerDown, true);
  }, [stableMobileCoarsePointerDown]);

  const attachMobileSliderCoarseDisarm = useCallback(() => {
    try {
      if (!window.matchMedia('(pointer: coarse)').matches) return;
    } catch {
      return;
    }
    if (mobileSliderDisarmListenerAttachedRef.current) return;
    mobileSliderDisarmListenerAttachedRef.current = true;
    window.addEventListener('pointerdown', stableMobileCoarsePointerDown, true);
  }, [stableMobileCoarsePointerDown]);

  const disarmPressMatrixMode = useCallback(() => {
    detachMobileSliderCoarseDisarm();
    notifyPressErased();
    setPressMatrixArmSourceUi(null);
  }, [detachMobileSliderCoarseDisarm]);

  disarmPressMatrixModeRef.current = disarmPressMatrixMode;
  detachMobileSliderCoarseDisarmRef.current = detachMobileSliderCoarseDisarm;

  useEffect(
    () => () => {
      detachMobileSliderCoarseDisarmRef.current();
    },
    [],
  );

  const armPressMatrixFromStar = useCallback(() => {
    detachMobileSliderCoarseDisarm();
    armPressFromState(getPressState(), 'star');
    setPressMatrixArmSourceUi('star');
  }, [getPressState, detachMobileSliderCoarseDisarm]);

  const armPressMatrixFromSlider = useCallback(() => {
    armPressFromState(getPressState(), 'slider');
    setPressMatrixArmSourceUi('slider');
    attachMobileSliderCoarseDisarm();
  }, [getPressState, attachMobileSliderCoarseDisarm]);

  const triggerHapticPulse = useCallback((durationMs = 50) => {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(durationMs);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const handleBarsSliderThumbIdleArm = useCallback(() => {
    if (!isPressPrimed()) {
      armPressMatrixFromSlider();
      triggerHapticPulse(50);
    }
  }, [armPressMatrixFromSlider, triggerHapticPulse]);

  /** Disarm только для сессии, заармленной с рукоятки Bars (`'slider'`). */
  const handleBarsSliderThumbSessionEnd = useCallback(() => {
    if (isPressPrimed() && getPressArmSource() === 'slider') disarmPressMatrixMode();
  }, [disarmPressMatrixMode]);
  barsSliderPressSessionEndRef.current = handleBarsSliderThumbSessionEnd;

  const clearPressStarLongPressTimer = useCallback(() => {
    if (pressStarLongPressTimerRef.current !== null) {
      window.clearTimeout(pressStarLongPressTimerRef.current);
      pressStarLongPressTimerRef.current = null;
    }
  }, []);

  const handlePressStarPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      pressStarLongPressFiredRef.current = false;
      pressStarArmStartRef.current = { x: e.clientX, y: e.clientY };
      clearPressStarLongPressTimer();
      pressStarLongPressTimerRef.current = window.setTimeout(() => {
        pressStarLongPressTimerRef.current = null;
        pressStarArmStartRef.current = null;
        pressStarLongPressFiredRef.current = true;
        setIsPressStarLongPressing(true);
        triggerHapticPulse(50);
        if (isPressPrimed() && getPressArmSource() === 'star') disarmPressMatrixMode();
        else if (!isPressPrimed()) armPressMatrixFromStar();
      }, PRESS_LONG_PRESS_MS);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [clearPressStarLongPressTimer, armPressMatrixFromStar, disarmPressMatrixMode, triggerHapticPulse],
  );

  const handlePressStarPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (pressStarLongPressTimerRef.current === null || !pressStarArmStartRef.current) return;
      const { x, y } = pressStarArmStartRef.current;
      const dx = e.clientX - x;
      const dy = e.clientY - y;
      const sp = PRESS_STAR_ARM_SLOP_PX;
      if (dx * dx + dy * dy > sp * sp) {
        clearPressStarLongPressTimer();
        pressStarArmStartRef.current = null;
      }
    },
    [clearPressStarLongPressTimer],
  );

  const cancelPressStarLongPress = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      setIsPressStarLongPressing(false);
      clearPressStarLongPressTimer();
      pressStarArmStartRef.current = null;
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* ignore */
      }
    },
    [clearPressStarLongPressTimer],
  );

  /** Long-press по снежинке уже сработал — не трогать freeze в этом click. */
  const consumePressStarLongPress = useCallback((): boolean => {
    if (pressStarLongPressFiredRef.current) {
      pressStarLongPressFiredRef.current = false;
      setIsPressStarLongPressing(false);
      return true;
    }
    return false;
  }, []);

  const getLaneAccentsSetRef = useCallback((r: number): Set<string> => {
    if (!polyModeRef.current) return accentsRef.current;
    return accentsByLaneRef.current[laneForRow(r, polyVoicesRef.current)] ?? new Set<string>();
  }, []);

  const getLaneTaSetRef = useCallback((r: number): Set<string> => {
    if (!polyModeRef.current) return taDingKeysRef.current;
    return taDingKeysByLaneRef.current[laneForRow(r, polyVoicesRef.current)] ?? new Set<string>();
  }, []);

  const getLaneFirstBeatRef = useCallback((r: number): boolean => {
    if (!polyModeRef.current) return firstBeatAccentRef.current;
    return Boolean(firstBeatAccentByLaneRef.current[laneForRow(r, polyVoicesRef.current)]);
  }, []);
  useEffect(() => { randomModeEnabledRef.current = randomModeEnabled; }, [randomModeEnabled]);
  useEffect(() => { randomPulsationRef.current = randomPulsation; }, [randomPulsation]);
  useEffect(() => { randomPatternRef.current = randomPattern; }, [randomPattern]);
  useEffect(() => { randomSpeedRef.current = randomSpeed; }, [randomSpeed]);
  useEffect(() => { randomBarSpeedRef.current = randomBarSpeed; }, [randomBarSpeed]);
  useEffect(() => { randomModeRef.current = randomMode; }, [randomMode]);
  useEffect(() => { parentGenomeRef.current = parentGenome; }, [parentGenome]);
  useEffect(() => { parentLengthRef.current = parentLength; }, [parentLength]);
  useEffect(() => { enabledMutationsRef.current = enabledMutations; }, [enabledMutations]);
  useEffect(() => { formPresetIdRef.current = formPresetId; }, [formPresetId]);
  useEffect(() => { progressiveDensityModeRef.current = progressiveDensityMode; }, [progressiveDensityMode]);
  useEffect(() => { deSyncJatiActiveRef.current = deSyncJatiActive; }, [deSyncJatiActive]);
  useEffect(() => { deSyncCycleLengthRef.current = deSyncCycleLength; }, [deSyncCycleLength]);

  const normalizeJatiCycleLength = useCallback((cycle: number): 5 | 7 | 9 => {
    const n = Math.max(3, Math.min(9, Math.round(cycle)));
    if (n <= 5) return 5;
    if (n <= 7) return 7;
    return 9;
  }, []);

  const applyJatiMutation = useCallback((
    barIndex: number,
    newCycleLength: number,
    options?: { targetCustomSyllables?: Record<number, number>; commitState?: boolean },
  ): boolean => {
    if (!Number.isInteger(barIndex) || barIndex < 0) return false;
    const nextJati = normalizeJatiCycleLength(newCycleLength);
    const commitState = options?.commitState !== false;
    if (options?.targetCustomSyllables) {
      options.targetCustomSyllables[barIndex] = nextJati;
    } else {
      const nextMap = { ...customSyllablesRef.current, [barIndex]: nextJati };
      customSyllablesRef.current = nextMap;
      setCustomSyllables(nextMap);
    }
    progressiveDensityModeRef.current = 'jati_mode';
    deSyncJatiActiveRef.current = true;
    deSyncCycleLengthRef.current = nextJati;
    if (commitState) {
      setProgressiveDensityMode('jati_mode');
      setDeSyncJatiActive(true);
      setDeSyncCycleLength(nextJati);
      setJatiPulseActiveByRow((prev) => ({ ...prev, [barIndex]: true }));
    }
    return true;
  }, [normalizeJatiCycleLength]);

  const getRoleJatiTarget = useCallback((role: PhraseSchedule[number] | undefined): 5 | 7 | 9 | null => {
    if (!role || role.type === 'parent' || role.type === 'free' || role.type === 'resync_bridge') return null;
    const trigger = 'triggerJatiAction' in role ? role.triggerJatiAction : undefined;
    if (trigger && (trigger.targetCurSyl === 5 || trigger.targetCurSyl === 7 || trigger.targetCurSyl === 9)) {
      return trigger.targetCurSyl;
    }
    // Fallback: UI-индикация и auto-jati не должны зависеть только от trigger-поля.
    // Если роль уже de-sync с валидным циклом 5/7/9, считаем это целевым jati.
    if (
      role.deSyncJati === true &&
      (role.localCycleLength === 5 || role.localCycleLength === 7 || role.localCycleLength === 9)
    ) {
      return role.localCycleLength;
    }
    return null;
  }, []);
  const applyFormPresetSelection = useCallback((preset: FormPresetId) => {
    // Важно для UX: при мгновенном клике "Preset -> Random" генератор читает ref.
    // Обновляем ref синхронно, чтобы не схватить старый preset/пул мутаций.
    formPresetIdRef.current = preset;
    setFormPresetId(preset);
    if (randomModeRef.current === 'parent') {
      const next = [...PRESET_ENABLED_MUTATIONS[preset]];
      enabledMutationsRef.current = next;
      setEnabledMutations(next);
    }
  }, []);
  useEffect(() => { chaosLevelRef.current = chaosLevel; }, [chaosLevel]);

  useEffect(() => { frozenScaleRef.current = frozenScale; }, [frozenScale]);
  useEffect(() => { polyModeRef.current = polyMode; }, [polyMode]);
  useEffect(() => { polyVoicesRef.current = polyVoices; }, [polyVoices]);
  useEffect(() => {
    if (!polyMode) {
      setActiveClickVoiceTarget(0);
      return;
    }
    const maxVoice = polyVoices === 3 ? 2 : 1;
    setActiveClickVoiceTarget((prev) => (prev > maxVoice ? maxVoice : prev));
  }, [polyMode, polyVoices]);
  useEffect(() => {
    if (!polyMode) return;
    const normalized = snapBarsToPolyGrid(bars, true, polyVoices);
    if (normalized !== bars) {
      applyBarsWithPotatoFreeze(normalized);
    }
  }, [polyMode, polyVoices, bars, applyBarsWithPotatoFreeze]);
  useEffect(() => {
    // Randomizer закреплён в ветке free.
    if (randomMode !== 'parent') return;
    randomModeRef.current = 'free';
    setRandomMode('free');
  }, [randomMode]);

  const clampTempo = useCallback((n: number) => Math.min(400, Math.max(20, Math.round(n))), []);

  const applyTempoImmediate = useCallback(
    (raw: number) => {
      const next = clampTempo(raw);
      setTempoUi(next);
      pendingTempoRef.current = null;
      if (tempoThrottleTimerRef.current !== null) {
        window.clearTimeout(tempoThrottleTimerRef.current);
        tempoThrottleTimerRef.current = null;
      }
      setTempo(next);
      tempoRef.current = next;
    },
    [clampTempo],
  );

  const scheduleTempoCommit = useCallback(
    (raw: number) => {
      const next = clampTempo(raw);
      setTempoUi(next);
      pendingTempoRef.current = next;
      /* Аудио читает tempoRef до рендера: иначе слайдер впереди слышимого темпа (полиритм — целый chunk). */
      tempoRef.current = next;
      if (tempoThrottleTimerRef.current !== null) return;
      tempoThrottleTimerRef.current = window.setTimeout(() => {
        tempoThrottleTimerRef.current = null;
        const pending = pendingTempoRef.current;
        pendingTempoRef.current = null;
        if (pending === null) return;
        setTempo(pending);
        tempoRef.current = pending;
      }, TEMPO_THROTTLE_MS);
    },
    [clampTempo],
  );

  const flushTempoCommit = useCallback(() => {
    const pending = pendingTempoRef.current;
    pendingTempoRef.current = null;
    if (tempoThrottleTimerRef.current !== null) {
      window.clearTimeout(tempoThrottleTimerRef.current);
      tempoThrottleTimerRef.current = null;
    }
    if (pending === null) return;
    setTempo(pending);
    tempoRef.current = pending;
  }, []);

  const clearTempoHoldRepeat = useCallback(() => {
    if (tempoHoldTimeoutRef.current !== null) {
      window.clearTimeout(tempoHoldTimeoutRef.current);
      tempoHoldTimeoutRef.current = null;
    }
    if (tempoHoldIntervalRef.current !== null) {
      window.clearInterval(tempoHoldIntervalRef.current);
      tempoHoldIntervalRef.current = null;
    }
  }, []);

  const canResetDeSyncStateFromTempoHold = useCallback((): boolean => {
    if (randomModeRef.current !== 'parent') return true;
    if (formPresetIdRef.current !== 'progressive') return true;
    const schedule = phraseScheduleRef.current;
    if (!Array.isArray(schedule) || schedule.length === 0) return true;
    let lastDeSync = -1;
    let lastResync = -1;
    for (let i = 0; i < schedule.length; i++) {
      const role = schedule[i];
      if (!role) continue;
      if (role.type !== 'parent' && role.type !== 'free' && role.type !== 'resync_bridge' && role.deSyncJati === true) {
        lastDeSync = i;
      }
      if (role.type === 'resync_bridge' && role.bridgeKind === 'resync') {
        lastResync = i;
      }
    }
    if (lastDeSync < 0) return true;
    return lastResync > lastDeSync;
  }, []);

  const beginTempoMinusHold = useCallback(() => {
    tempoMinusHoldAteClickRef.current = false;
    clearTempoHoldRepeat();
    tempoHoldTimeoutRef.current = window.setTimeout(() => {
      tempoHoldTimeoutRef.current = null;
      tempoMinusHoldAteClickRef.current = true;
      if (canResetDeSyncStateFromTempoHold()) {
        progressiveDensityModeRef.current = 'gati_mode';
        deSyncJatiActiveRef.current = false;
        deSyncCycleLengthRef.current = undefined;
        setProgressiveDensityMode('gati_mode');
        setDeSyncJatiActive(false);
        setDeSyncCycleLength(undefined);
      }
      applyTempoImmediate(tempoRef.current - TEMPO_HOLD_REPEAT_STEP);
      tempoHoldIntervalRef.current = window.setInterval(() => {
        applyTempoImmediate(tempoRef.current - TEMPO_HOLD_REPEAT_STEP);
      }, TEMPO_HOLD_REPEAT_MS);
    }, TEMPO_HOLD_REPEAT_MS);
  }, [applyTempoImmediate, canResetDeSyncStateFromTempoHold, clearTempoHoldRepeat]);

  const beginTempoPlusHold = useCallback(() => {
    tempoPlusHoldAteClickRef.current = false;
    clearTempoHoldRepeat();
    tempoHoldTimeoutRef.current = window.setTimeout(() => {
      tempoHoldTimeoutRef.current = null;
      tempoPlusHoldAteClickRef.current = true;
      if (canResetDeSyncStateFromTempoHold()) {
        progressiveDensityModeRef.current = 'gati_mode';
        deSyncJatiActiveRef.current = false;
        deSyncCycleLengthRef.current = undefined;
        setProgressiveDensityMode('gati_mode');
        setDeSyncJatiActive(false);
        setDeSyncCycleLength(undefined);
      }
      applyTempoImmediate(tempoRef.current + TEMPO_HOLD_REPEAT_STEP);
      tempoHoldIntervalRef.current = window.setInterval(() => {
        applyTempoImmediate(tempoRef.current + TEMPO_HOLD_REPEAT_STEP);
      }, TEMPO_HOLD_REPEAT_MS);
    }, TEMPO_HOLD_REPEAT_MS);
  }, [applyTempoImmediate, canResetDeSyncStateFromTempoHold, clearTempoHoldRepeat]);

  const endTempoHoldRepeat = useCallback(() => {
    clearTempoHoldRepeat();
  }, [clearTempoHoldRepeat]);

  const beginTempoInlineEdit = useCallback((slot: TempoSliderSlot) => {
    skipTempoInlineBlurCommitRef.current = false;
    setTempoManualText(String(Math.round(tempoRef.current)));
    setTempoInlineFocusSlot(slot);
    setTempoInlineEditing(true);
  }, []);

  const cancelTempoInlineEdit = useCallback(() => {
    skipTempoInlineBlurCommitRef.current = true;
    setTempoInlineEditing(false);
    setTempoInlineFocusSlot(null);
  }, []);

  const commitTempoInlineEdit = useCallback(() => {
    if (skipTempoInlineBlurCommitRef.current) {
      skipTempoInlineBlurCommitRef.current = false;
      return;
    }
    const raw = tempoManualText.trim();
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) {
      setTempoInlineEditing(false);
      setTempoInlineFocusSlot(null);
      return;
    }
    applyTempoImmediate(n);
    setTempoInlineEditing(false);
    setTempoInlineFocusSlot(null);
  }, [tempoManualText, applyTempoImmediate]);

  useLayoutEffect(() => {
    if (!tempoInlineEditing || tempoInlineFocusSlot !== 'tap') return;
    const el = tempoTapInlineInputRef.current;
    if (!el) return;
    el.focus();
    el.select?.();
  }, [tempoInlineEditing, tempoInlineFocusSlot]);

  const onTapButtonPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      tapBpmHoldAteClickRef.current = false;
      if (tapBpmHoldTimerRef.current !== null) {
        window.clearTimeout(tapBpmHoldTimerRef.current);
        tapBpmHoldTimerRef.current = null;
      }
      const btn = e.currentTarget;
      const startX = e.clientX;
      const startY = e.clientY;
      const moveCancelSq = TEMPO_MANUAL_MAX_MOVE_PX * TEMPO_MANUAL_MAX_MOVE_PX;
      let finished = false;
      const clearHoldTimer = () => {
        if (tapBpmHoldTimerRef.current !== null) {
          window.clearTimeout(tapBpmHoldTimerRef.current);
          tapBpmHoldTimerRef.current = null;
        }
      };
      const endGesture = () => {
        if (finished) return;
        finished = true;
        clearHoldTimer();
        btn.removeEventListener('pointermove', onMove);
        btn.removeEventListener('pointerup', onUp);
        btn.removeEventListener('pointercancel', onUp);
        try {
          btn.releasePointerCapture(e.pointerId);
        } catch {
          /* */
        }
      };
      const onMove = (moveEvt: PointerEvent) => {
        if (finished) return;
        const dx = moveEvt.clientX - startX;
        const dy = moveEvt.clientY - startY;
        if (dx * dx + dy * dy > moveCancelSq) clearHoldTimer();
      };
      const onUp = () => {
        endGesture();
      };
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* */
      }
      tapBpmHoldTimerRef.current = window.setTimeout(() => {
        tapBpmHoldTimerRef.current = null;
        if (finished) return;
        finished = true;
        clearHoldTimer();
        btn.removeEventListener('pointermove', onMove);
        btn.removeEventListener('pointerup', onUp);
        btn.removeEventListener('pointercancel', onUp);
        try {
          btn.releasePointerCapture(e.pointerId);
        } catch {
          /* */
        }
        tapBpmHoldAteClickRef.current = true;
        const slot: TempoSliderSlot = isPanelExpandedRef.current ? 'pnl' : 'tap';
        beginTempoInlineEdit(slot);
      }, TEMPO_MANUAL_HOLD_MS);
      btn.addEventListener('pointermove', onMove);
      btn.addEventListener('pointerup', onUp);
      btn.addEventListener('pointercancel', onUp);
    },
    [beginTempoInlineEdit],
  );

  const buildLiveSnapshotFromRefs = (): AppSnapshot => ({
    tempo: tempoRef.current,
    bars: barsRef.current,
    syllables: syllablesRef.current,
    accents: new Set(accentsRef.current),
    accentsByLane: cloneLaneSetMap(accentsByLaneRef.current),
    taDingKeys: new Set(taDingKeysRef.current),
    firstBeatDingSuppressedRows: new Set(firstBeatDingSuppressedRowsRef.current),
    taDingKeysByLane: cloneLaneSetMap(taDingKeysByLaneRef.current),
    customSyllables: { ...customSyllablesRef.current },
    customMultipliers: { ...customMultipliersRef.current },
    customSubdivisions: { ...customSubdivisionsRef.current },
    cellStepMasks: { ...cellStepMasksRef.current },
    customCellSyllables: { ...customCellSyllablesRef.current },
    randomModeEnabled: randomModeEnabledRef.current,
    randomPulsation: randomPulsationRef.current,
    randomPattern: randomPatternRef.current,
    randomSpeed: randomSpeedRef.current,
    randomBarSpeed: randomBarSpeedRef.current,
    chaosLevel: chaosLevelRef.current,
    clickSound: clickSoundRef.current,
    clickSoundByPolyVoice: { ...clickSoundByPolyVoiceRef.current },
    polyVoiceGains: { ...polyVoiceGainsRef.current },
    clickBusBalance: getClickPresetBusGainsForVoicePreset(
      clickPresetBusGainsByVoiceRef.current,
      clickPresetBusGainsRef.current,
      0,
      clickSoundRef.current,
    ),
    clickBusBalanceByPreset: collectSnapshotClickBusBalanceByPreset(
      clickSoundRef.current,
      clickSoundByPolyVoiceRef.current,
      polyModeRef.current,
      clickPresetBusGainsRef.current,
    ),
    clickBusBalanceByVoicePreset: collectSnapshotClickBusBalanceByVoicePreset(
      clickSoundRef.current,
      clickSoundByPolyVoiceRef.current,
      polyModeRef.current,
      clickPresetBusGainsByVoiceRef.current,
      clickPresetBusGainsRef.current,
    ),
    panelExpanded: isPanelExpandedRef.current,
    pulseMeterUnlinked: { ...pulseMeterUnlinkedRef.current },
    frozenScale: frozenScaleRef.current,
    lowPerfMode,
    polyMode: polyModeRef.current,
    polyVoices: polyVoicesRef.current,
    onlyAccents: false,
    mixerLayerMode: mixerLayerModeRef.current,
    trainerMode: trainerModeRef.current,
    trainerHoldMute: trainerHoldMuteRef.current,
    ...mapNewModesToLegacySnapshot(mixerLayerModeRef.current, trainerModeRef.current),
    firstBeatAccent: firstBeatAccentRef.current,
    firstBeatAccentByLane: { ...firstBeatAccentByLaneRef.current },
    accentMapVersion: accentMapVersionRef.current,
    syllableReadMuteMode: syllableReadMuteModeRef.current,
    dictantMode: dictantModeRef.current,
    deadCells: { ...deadCellsRef.current },
    randomMode: randomModeRef.current,
    parentGenome: parentGenomeRef.current,
    parentLength: parentLengthRef.current,
    enabledMutations: [...enabledMutationsRef.current],
    formPresetId: formPresetIdRef.current,
    pressMatrixArmSource: getPressArmSource(),
    progressiveDensityMode: progressiveDensityModeRef.current,
    deSyncJatiActive: deSyncJatiActiveRef.current,
    deSyncCycleLength: deSyncCycleLengthRef.current,
  });

  const prefillAllTactsRandomizer = useCallback((compositionSeedOverride?: number) => {
    const chaos = chaosLevelRef.current;
    let nBars = barsRef.current;
    const syllablesDefault = syllablesRef.current;
    const rp = randomPulsationRef.current;
    const rpat = randomPatternRef.current;
    const rs = randomSpeedRef.current;
    const rbs = randomBarSpeedRef.current;
    const parentMode = randomModeRef.current === 'parent';
    if (parentMode) {
      ensureParentGenomeForParentMode();
    }
    const parentActive =
      parentMode && parentGenomeRef.current !== null;
    const hasAny = rp || rpat || rs || rbs || parentActive;

    if (randomDiceMintFlashClearRef.current !== null) {
      window.clearTimeout(randomDiceMintFlashClearRef.current);
      randomDiceMintFlashClearRef.current = null;
    }
    setRandomDiceMintFlash(true);
    randomDiceMintFlashClearRef.current = window.setTimeout(() => {
      randomDiceMintFlashClearRef.current = null;
      setRandomDiceMintFlash(false);
    }, 320);

    if (!hasAny) return;

    // Parent-mode: стиль задаёт точное число тактов (и вверх, и вниз).
    if (parentActive) {
      const requiredBars = targetBarsForParentPreset(formPresetIdRef.current);
      if (requiredBars !== nBars) {
        applyBarsWithPotatoFreeze(requiredBars);
        nBars = barsRef.current;
      }
      // Parent generation UX lock: for tihai/progressive keep viewport frozen at 8 bars,
      // while composition itself can still expand to full target length.
      if (formPresetIdRef.current === 'tihai_heavy' || formPresetIdRef.current === 'progressive') {
        setFrozenScale(8);
        frozenScaleRef.current = 8;
      }
    }

    const cs = { ...customSyllablesRef.current };
    const cd = { ...customSubdivisionsRef.current };
    const ccell = { ...customCellSyllablesRef.current };
    const cm = { ...customMultipliersRef.current };
    const dc = { ...deadCellsRef.current };
    const acc = new Set<string>(accentsRef.current);

    // Sam/Eduppu-guard: гарантируем акцент на 1 доле в диктанте и на низком chaos
    // (<80 — вне Korvai-зоны). Выше 80 — разрешаем "плавающие" акценты.
    const forceFirstBeat = dictantModeRef.current || chaos < 80;

    const nextSeeds: Record<number, number> = {};
    // Parent-mode: композиция целиком просчитывается заранее по единому master-seed.
    // Никакой live-домутации в playback не требуется.
    const compositionSeed =
      typeof compositionSeedOverride === 'number'
        ? compositionSeedOverride >>> 0
        : (Math.random() * 0xffffffff) >>> 0;
    const compositionRng = mulberry32(compositionSeed);
    if (parentActive) {
      phraseScheduleRef.current = buildPhraseSchedule({
        bars: nBars,
        enabledMutations: enabledMutationsRef.current,
        preset: formPresetIdRef.current,
        parentLength: parentLengthRef.current,
        rng: compositionRng,
        motifPulseLen: parentGenomeRef.current?.bars[0]?.curSyl ?? syllablesDefault,
        progressiveDensityMode: progressiveDensityModeRef.current,
        deSyncJati: deSyncJatiActiveRef.current,
        deSyncCycleLength: deSyncCycleLengthRef.current,
        chaosLevel: chaos,
      });
      if (parentGenomeRef.current !== null) {
        lessonLogger.reset({
          seed: compositionSeed,
          chaos,
          tempoBpm: tempoRef.current,
          polyMode: polyModeRef.current,
          polyVoices: polyVoicesRef.current,
          parentThemeLine: formatParentGenomeHumanLine(parentGenomeRef.current, tempoRef.current),
          formPresetLabel: FORM_PRESET_LABEL[formPresetIdRef.current],
          formPresetId: formPresetIdRef.current,
          randomMode: randomModeRef.current,
          barCount: nBars,
        });
      }
    }
    let any = false;
    const useParent =
      randomModeRef.current === 'parent' && parentGenomeRef.current !== null;
    let sawAutoJati = false;
    let lastAutoJatiCycle: 5 | 7 | 9 | null = null;
    const nextJatiPulseActive: Record<number, boolean> = {};
    activeJatiPhraseIdRef.current = null;
    for (let r = 0; r < nBars; r++) {
      const seed = parentActive
        ? ((compositionRng() * 0xffffffff) >>> 0)
        : ((Math.random() * 0xffffffff) >>> 0);
      nextSeeds[r] = seed;
      const rng = mulberry32(seed);
      const m = {
        customSyllables: cs,
        accents: acc,
        customSubdivisions: cd,
        customCellSyllables: ccell,
        customMultipliers: cm,
        deadCells: dc,
      };
      const scheduleRole = phraseScheduleRef.current[r];
      const roleTarget = getRoleJatiTarget(scheduleRole);
      const roleIsPhysicalJati =
        scheduleRole !== undefined &&
        scheduleRole.type !== 'parent' &&
        scheduleRole.type !== 'free' &&
        scheduleRole.type !== 'resync_bridge' &&
        scheduleRole.deSyncJati === true &&
        (scheduleRole.localCycleLength === 5 || scheduleRole.localCycleLength === 7 || scheduleRole.localCycleLength === 9);
      if (parentActive && roleTarget !== null) {
        // Визуал Jati должен гореть на каждом такте блока, а не только на старте фразы.
        nextJatiPulseActive[r] = true;
      }
      if (parentActive && roleIsPhysicalJati) {
        // Fallback-индикация по фактическому de-sync/jati, даже если trigger отсутствует.
        nextJatiPulseActive[r] = true;
      }
      const phraseBoundary =
        scheduleRole &&
        scheduleRole.type !== 'parent' &&
        scheduleRole.type !== 'free' &&
        scheduleRole.type !== 'resync_bridge' &&
        scheduleRole.phraseStep === 0;
      if (
        parentActive &&
        roleTarget !== null &&
        scheduleRole &&
        phraseBoundary &&
        activeJatiPhraseIdRef.current !== scheduleRole.phraseId
      ) {
        activeJatiPhraseIdRef.current = scheduleRole.phraseId;
        if (applyJatiMutation(r, roleTarget, { targetCustomSyllables: cs, commitState: false })) {
          sawAutoJati = true;
          lastAutoJatiCycle = roleTarget;
          nextJatiPulseActive[r] = true;
        }
      }
      const didChange = useParent
        ? applyParentModeBar({
            barIdx: r,
            parent: parentGenomeRef.current!,
            schedule: phraseScheduleRef.current,
            chaos,
            syllablesDefault,
            m,
            rng,
            freeAxes: {
              randomPulsation: rp,
              randomPattern: rpat,
              randomSpeed: rs,
              randomBarSpeed: rbs,
              forceFirstBeat,
            },
          })
        : applyRandomizerEffectsToBar(
            r, chaos, rp, rpat, rs, rbs, false, syllablesDefault,
            m,
            rng,
            forceFirstBeat,
          );
      if (didChange) any = true;
      if (parentActive && phraseScheduleRef.current[r] !== undefined) {
        lessonLogger.addBar(
          buildBarLogForParentRow(r, phraseScheduleRef.current[r]!, tempoRef.current, syllablesDefault, {
            customSyllables: cs,
            accents: acc,
            accentsByLane: accentsByLaneRef.current,
            taDingKeysByLane: taDingKeysByLaneRef.current,
            customSubdivisions: cd,
            customCellSyllables: ccell,
            customMultipliers: cm,
            polyMode: polyModeRef.current,
            polyVoices: polyVoicesRef.current,
            deadCells: dc,
          }),
        );
      }
    }
    if (sawAutoJati && lastAutoJatiCycle !== null) {
      progressiveDensityModeRef.current = 'jati_mode';
      deSyncJatiActiveRef.current = true;
      deSyncCycleLengthRef.current = lastAutoJatiCycle;
      setProgressiveDensityMode('jati_mode');
      setDeSyncJatiActive(true);
      setDeSyncCycleLength(lastAutoJatiCycle);
    }
    lastBarSeedRef.current = { ...lastBarSeedRef.current, ...nextSeeds };
    if (!any) {
      // Даже если визуальная сетка не изменилась, индикатор режима обязан синхронизироваться с новым schedule.
      startTransition(() => {
        setJatiPulseActiveByRow(nextJatiPulseActive);
      });
      return;
    }

    customSyllablesRef.current = cs;
    customSubdivisionsRef.current = cd;
    customCellSyllablesRef.current = ccell;
    customMultipliersRef.current = cm;
    deadCellsRef.current = dc;
    accentsRef.current = acc;

    startTransition(() => {
      setCustomSyllables({ ...cs });
      setAccents(new Set(acc));
      setCustomSubdivisions({ ...cd });
      setCustomCellSyllables({ ...ccell });
      setCustomMultipliers({ ...cm });
      setDeadCells({ ...dc });
      setJatiPulseActiveByRow(nextJatiPulseActive);
    });
  }, [applyBarsWithPotatoFreeze]);

  /**
   * Replay одного такта по записанному seed (см. lastBarSeedRef). Используется для debug —
   * ученик/разработчик может повторить ту же самую мутацию такта для разбора. Подтягивается
   * через `window.__konnakolDebug.rerollBar(barIndex, seed?)` (см. ниже).
   */
  const replayBarRandomizer = useCallback((barIndex: number, overrideSeed?: number): boolean => {
    const nBars = barsRef.current;
    if (!Number.isInteger(barIndex) || barIndex < 0 || barIndex >= nBars) return false;
    const syllablesDefault = syllablesRef.current;
    const rp = randomPulsationRef.current;
    const rpat = randomPatternRef.current;
    const rs = randomSpeedRef.current;
    const rbs = randomBarSpeedRef.current;
    const parentActive =
      randomModeRef.current === 'parent' && parentGenomeRef.current !== null;
    const hasAny = rp || rpat || rs || rbs || parentActive;
    if (!hasAny) return false;

    const seed =
      typeof overrideSeed === 'number'
        ? overrideSeed >>> 0
        : lastBarSeedRef.current[barIndex] ?? (Math.random() * 0xffffffff) >>> 0;
    lastBarSeedRef.current[barIndex] = seed;

    const cs = { ...customSyllablesRef.current };
    const cd = { ...customSubdivisionsRef.current };
    const ccell = { ...customCellSyllablesRef.current };
    const cm = { ...customMultipliersRef.current };
    const dc = { ...deadCellsRef.current };
    const acc = new Set<string>(accentsRef.current);

    const chaosNow = chaosLevelRef.current;
    const forceFirstBeat = dictantModeRef.current || chaosNow < 80;
    const rng = mulberry32(seed);
    const m = {
      customSyllables: cs,
      accents: acc,
      customSubdivisions: cd,
      customCellSyllables: ccell,
      customMultipliers: cm,
      deadCells: dc,
    };
    const role = phraseScheduleRef.current[barIndex];
    const roleTarget = getRoleJatiTarget(role);
    if (
      parentActive &&
      roleTarget !== null &&
      role &&
      role.type !== 'parent' &&
      role.type !== 'free' &&
      role.type !== 'resync_bridge' &&
      role.phraseStep === 0 &&
      activeJatiPhraseIdRef.current !== role.phraseId
    ) {
      activeJatiPhraseIdRef.current = role.phraseId;
      applyJatiMutation(barIndex, roleTarget, { targetCustomSyllables: cs, commitState: false });
      progressiveDensityModeRef.current = 'jati_mode';
      deSyncJatiActiveRef.current = true;
      deSyncCycleLengthRef.current = roleTarget;
      setProgressiveDensityMode('jati_mode');
      setDeSyncJatiActive(true);
      setDeSyncCycleLength(roleTarget);
    }
    const didChange = parentActive
      ? applyParentModeBar({
          barIdx: barIndex,
          parent: parentGenomeRef.current!,
          schedule: phraseScheduleRef.current,
          chaos: chaosNow,
          syllablesDefault,
          m,
          rng,
          freeAxes: {
            randomPulsation: rp,
            randomPattern: rpat,
            randomSpeed: rs,
            randomBarSpeed: rbs,
            forceFirstBeat,
          },
        })
      : applyRandomizerEffectsToBar(
          barIndex,
          chaosNow,
          rp, rpat, rs, rbs,
          false,
          syllablesDefault,
          m,
          rng,
          forceFirstBeat,
        );
    if (!didChange) return false;

    customSyllablesRef.current = cs;
    customSubdivisionsRef.current = cd;
    customCellSyllablesRef.current = ccell;
    customMultipliersRef.current = cm;
    deadCellsRef.current = dc;
    accentsRef.current = acc;

    startTransition(() => {
      setCustomSyllables({ ...cs });
      setAccents(new Set(acc));
      setCustomSubdivisions({ ...cd });
      setCustomCellSyllables({ ...ccell });
      setCustomMultipliers({ ...cm });
      setDeadCells({ ...dc });
    });
    return true;
  }, []);

  const applyImmediateRandomOnEnable = useCallback(() => {
    const nBars = barsRef.current;
    if (nBars <= 0) return;
    const currentSeqItem = sequenceRef.current[currentStepRef.current];
    const candidateBar = isPlayingRef.current ? (currentSeqItem?.r ?? 0) : 0;
    const safeBar = Math.max(0, Math.min(nBars - 1, candidateBar));
    replayBarRandomizer(safeBar);
  }, [replayBarRandomizer]);

  /**
   * Parent-source по умолчанию: первый такт текущей сетки.
   * Если он "пустой/дефолтный", создаём auto-parent умеренной сложности.
   */
  function ensureParentGenomeForParentMode(): ParentGenome {
    const base = syllablesRef.current;
    const cs = customSyllablesRef.current;
    const acc = accentsRef.current;
    const cd = customSubdivisionsRef.current;
    const ccell = customCellSyllablesRef.current;
    const dc = deadCellsRef.current;
    const bar0HasContent =
      (typeof cs[0] === 'number' && cs[0] !== base) ||
      Object.keys(cd).some((k) => k.startsWith('0-')) ||
      Object.keys(ccell).some((k) => k.startsWith('0-')) ||
      [...acc].some((k) => k.startsWith('0-')) ||
      dc[0] !== undefined;

    let next: ParentGenome;
    if (bar0HasContent) {
      next = {
        bars: [
          snapshotBarGenome(0, base, {
            customSyllables: cs,
            accents: acc,
            customSubdivisions: cd,
            customCellSyllables: ccell,
            deadCells: dc,
          }),
        ],
      };
    } else {
      const tmp: BarRandomizerMutable = {
        customSyllables: {},
        accents: new Set<string>(),
        customSubdivisions: {},
        customCellSyllables: {},
        customMultipliers: {},
        deadCells: {},
      };
      const AUTO_PARENT_CHAOS = 60;
      applyRandomizerEffectsToBar(
        0,
        AUTO_PARENT_CHAOS,
        true, true, true, false,
        false,
        base,
        tmp,
        mulberry32((Math.random() * 0xffffffff) >>> 0),
        true,
      );
      next = {
        bars: [
          snapshotBarGenome(0, base, {
            customSyllables: tmp.customSyllables,
            accents: tmp.accents,
            customSubdivisions: tmp.customSubdivisions,
            customCellSyllables: tmp.customCellSyllables,
            deadCells: tmp.deadCells,
          }),
        ],
      };
    }
    parentLengthRef.current = 1;
    setParentLength(1);
    parentGenomeRef.current = next;
    setParentGenome(next);
    return next;
  }

  /**
   * Пересчёт `phraseScheduleRef` при включении parent-mode / смене bars / enabled / preset / manual re-roll.
   * Scheduler детерминирован: seed → одинаковое расписание.
   */
  const rerollPhraseSchedule = useCallback((seedOverride?: number) => {
    const seed = typeof seedOverride === 'number' ? seedOverride >>> 0 : (Math.random() * 0xffffffff) >>> 0;
    const rng = mulberry32(seed);
    const next = buildPhraseSchedule({
      bars: barsRef.current,
      enabledMutations: enabledMutationsRef.current,
      preset: formPresetIdRef.current,
      parentLength: parentLengthRef.current,
      rng,
      motifPulseLen: parentGenomeRef.current?.bars[0]?.curSyl ?? syllablesRef.current,
      progressiveDensityMode: progressiveDensityModeRef.current,
      deSyncJati: deSyncJatiActiveRef.current,
      deSyncCycleLength: deSyncCycleLengthRef.current,
      chaosLevel: chaosLevelRef.current,
    });
    phraseScheduleRef.current = next;
  }, []);

  // Rebuild schedule on parent-relevant changes.
  useEffect(() => {
    if (randomMode !== 'parent') return;
    rerollPhraseSchedule();
  }, [randomMode, bars, enabledMutations, formPresetId, parentLength, rerollPhraseSchedule]);

  /** Пул мутаций всегда берётся из выбранного Form preset. */
  useEffect(() => {
    if (randomMode !== 'parent') return;
    const next = [...PRESET_ENABLED_MUTATIONS[formPresetId]];
    setEnabledMutations(next);
    enabledMutationsRef.current = next;
  }, [randomMode, formPresetId]);

  /** Debug-handle для воспроизведения такта по записанному seed через консоль. */
  useEffect(() => {
    type MacroLogResult = {
      seed: number;
      fileName: string;
      text: string;
      debugJson: string;
    };
    type KonnakolDebug = {
      rerollBar: (barIndex: number, seed?: number) => boolean;
      getLastBarSeeds: () => Record<number, number>;
      getLessonLogText: () => string;
      getLessonDebugJson: () => string;
      runParentProgressiveMacroBatch: (count?: number, preset?: FormPresetId) => Promise<MacroLogResult[]>;
      runParentProgressiveMacroSeedBatch: (seeds: number[], preset?: FormPresetId) => Promise<MacroLogResult[]>;
    };
    const w = window as unknown as { __konnakolDebug?: KonnakolDebug };
    const waitFrame = async (times: number = 1): Promise<void> => {
      const fastMacro = (window as unknown as { __konnakolMacroFast?: boolean }).__konnakolMacroFast === true;
      if (fastMacro) return;
      for (let i = 0; i < times; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    };
    const runParentProgressiveMacroBatch = async (
      count: number = 5,
      preset: FormPresetId = 'tihai_heavy',
    ): Promise<MacroLogResult[]> => {
      const safeCount = Math.max(1, Math.min(50, Math.floor(count)));
      const safePreset: FormPresetId = PRESET_ENABLED_MUTATIONS[preset] ? preset : 'tihai_heavy';
      const out: MacroLogResult[] = [];
      for (let i = 0; i < safeCount; i++) {
        // 1) "Ластик"
        clearSequencer();
        await waitFrame(2);
        // 2) Parent + selected preset
        randomModeRef.current = 'parent';
        setRandomMode('parent');
        formPresetIdRef.current = safePreset;
        setFormPresetId(safePreset);
        const presetMut = [...PRESET_ENABLED_MUTATIONS[safePreset]];
        enabledMutationsRef.current = presetMut;
        setEnabledMutations(presetMut);
        await waitFrame(2);
        // 3) "Random"
        prefillAllTactsRandomizer();
        await waitFrame(2);
        const seed = lessonLogger.getMeta()?.seed ?? 0;
        const hex = (seed >>> 0).toString(16).padStart(8, '0');
        const modeTag = `parent-${safePreset}`;
        out.push({
          seed: seed >>> 0,
          fileName: `lesson-log-${hex}__${modeTag}.txt`,
          text: lessonLogger.formatLessonLogText(),
          debugJson: lessonLogger.formatLessonDebugJson(),
        });
      }
      return out;
    };
    const runParentProgressiveMacroSeedBatch = async (
      seeds: number[],
      preset: FormPresetId = 'tihai_heavy',
    ): Promise<MacroLogResult[]> => {
      const safePreset: FormPresetId = PRESET_ENABLED_MUTATIONS[preset] ? preset : 'tihai_heavy';
      const safeSeeds = Array.isArray(seeds)
        ? seeds
            .map((s) => Number.isFinite(s) ? (Math.floor(s) >>> 0) : NaN)
            .filter((s) => Number.isFinite(s))
            .slice(0, 50)
        : [];
      const out: MacroLogResult[] = [];
      for (const seed of safeSeeds) {
        clearSequencer();
        await waitFrame(2);
        randomModeRef.current = 'parent';
        setRandomMode('parent');
        formPresetIdRef.current = safePreset;
        setFormPresetId(safePreset);
        const presetMut = [...PRESET_ENABLED_MUTATIONS[safePreset]];
        enabledMutationsRef.current = presetMut;
        setEnabledMutations(presetMut);
        await waitFrame(2);
        prefillAllTactsRandomizer(seed);
        await waitFrame(2);
        const actualSeed = lessonLogger.getMeta()?.seed ?? seed;
        const hex = (actualSeed >>> 0).toString(16).padStart(8, '0');
        const modeTag = `parent-${safePreset}`;
        out.push({
          seed: actualSeed >>> 0,
          fileName: `lesson-log-${hex}__${modeTag}.txt`,
          text: lessonLogger.formatLessonLogText(),
          debugJson: lessonLogger.formatLessonDebugJson(),
        });
      }
      return out;
    };
    w.__konnakolDebug = {
      rerollBar: (barIndex: number, seed?: number) => replayBarRandomizer(barIndex, seed),
      getLastBarSeeds: () => ({ ...lastBarSeedRef.current }),
      getLessonLogText: () => lessonLogger.formatLessonLogText(),
      getLessonDebugJson: () => lessonLogger.formatLessonDebugJson(),
      runParentProgressiveMacroBatch,
      runParentProgressiveMacroSeedBatch,
    };
    return () => {
      if (w.__konnakolDebug) delete w.__konnakolDebug;
    };
  }, [replayBarRandomizer, prefillAllTactsRandomizer]);

  // Autotune bootstrap: load golden DNA snapshot when available.
  useEffect(() => {
    let cancelled = false;
    const loadGoldenDna = async (): Promise<void> => {
      try {
        const res = await fetch('/logs/golden-dna.json', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as unknown;
        if (cancelled || !json || typeof json !== 'object') return;
        (window as unknown as { __goldenDna?: unknown }).__goldenDna = json;
      } catch {
        // optional source, no-op when unavailable
      }
    };
    void loadGoldenDna();
    return () => {
      cancelled = true;
    };
  }, []);

  const stableWindowPointerEnd = useCallback((e: Event) => {
    onWindowPointerEndCaptureRef.current(e);
  }, []);

  const attachSliderWindowListeners = useCallback(() => {
    if (sliderWindowListenersAttachedRef.current) return;
    sliderWindowListenersAttachedRef.current = true;
    window.addEventListener('pointerup', stableWindowPointerEnd, true);
    window.addEventListener('pointercancel', stableWindowPointerEnd, true);
    /* Touch: после drag range часто нет надёжного pointerup на window — touchend в capture ловит отпускание пальца. */
    window.addEventListener('touchend', stableWindowPointerEnd, true);
  }, [stableWindowPointerEnd]);

  /** Глобальный Syllbs: общее число слогов + перестройка sequenceRef; акценты / поддоли / множители ряда сохраняются для оставшихся ячеек. */
  const applyGlobalSyllablesFromSlider = useCallback((raw: string) => {
    const next = parseInt(raw, 10);
    if (!Number.isFinite(next) || next < 1 || next > 9) {
      return;
    }

    const nBars = barsRef.current;
    const prevSyllables = syllablesRef.current;
    const prevCustom = { ...customSyllablesRef.current };
    const prevDead = { ...deadCellsRef.current };

    setSyllables(next);
    syllablesRef.current = next;

    setCustomSyllables({});
    customSyllablesRef.current = {};

    // Preserve hidden-tail cell data when syllable count shrinks.
    // Sequence/render uses current `syllables`, so out-of-range cells stay dormant
    // and revive when user restores larger pulse later.
    const nextAccByLane = distributeSetToLanes(accentsRef.current, nBars, polyVoicesRef.current);
    setAccentsByLane(nextAccByLane);
    accentsByLaneRef.current = cloneLaneSetMap(nextAccByLane);
    const nextTaByLane = distributeSetToLanes(taDingKeysRef.current, nBars, polyVoicesRef.current);
    setTaDingKeysByLane(nextTaByLane);
    taDingKeysByLaneRef.current = cloneLaneSetMap(nextTaByLane);
    const nextCellSyl = { ...customCellSyllablesRef.current };

    const nextMult = { ...customMultipliersRef.current };
    for (const rk of Object.keys(nextMult)) {
      const r = Number(rk);
      if (!Number.isFinite(r) || r < 0 || r >= nBars) {
        delete nextMult[r];
      }
    }
    setCustomMultipliers(nextMult);
    customMultipliersRef.current = { ...nextMult };

    const nextDc: DeadCellsMap = {};
    for (const rk of Object.keys(prevDead)) {
      const r = parseInt(rk, 10);
      const meta = prevDead[r];
      if (!Number.isFinite(r) || r < 0 || r >= nBars || !meta) continue;
      const oldRowSyl = Math.max(1, prevCustom[r] !== undefined ? prevCustom[r]! : prevSyllables);
      const minLive = canRowUseZeroDeadStart(polyModeRef.current, polyVoicesRef.current, r) ? 0 : 1;
      const live = Math.max(minLive, Math.min(oldRowSyl, meta.deadStart));
      const newLive = Math.max(minLive, Math.min(next, Math.round((live * next) / oldRowSyl)));
      if (newLive >= next) continue;
      nextDc[r] = { deadStart: newLive, displayLen: next, baseLen: next };
    }
    setDeadCells(nextDc);
    deadCellsRef.current = nextDc;

    setActiveEditCell((prev) => {
      if (prev === null) return null;
      const parts = prev.split('-');
      if (parts.length !== 2) return null;
      const r = parseInt(parts[0], 10);
      const c = parseInt(parts[1], 10);
      if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || r >= nBars || c < 0 || c >= next) {
        return null;
      }
      return prev;
    });

    const newSeq = buildLegacyPlaybackSequence(
      nBars,
      {},
      next,
      nextDc,
      nextCellSyl,
      customSubdivisionsRef.current,
      cellStepMasksRef.current,
    );

    if (sequenceRef.current.length > 0 && newSeq.length > 0) {
      const oldItem = sequenceRef.current[currentStepRef.current];
      if (oldItem) {
        const rowMeta = nextDc[oldItem.r];
        const rowDs = rowMeta?.deadStart;
        const lastLiveExclusive =
          typeof rowDs === 'number' ? Math.min(Math.max(0, Math.floor(rowDs)), next) : next;
        const targetC =
          lastLiveExclusive > 0 ? Math.min(oldItem.c, lastLiveExclusive - 1) : 0;
        const newIdx = newSeq.findIndex((item) => item.r === oldItem.r && item.c === targetC);
        currentStepRef.current = newIdx !== -1 ? newIdx : 0;
      } else {
        currentStepRef.current = 0;
      }
    }

    sequenceRef.current = newSeq;
  }, []);

  flushLiveSnapshotToActiveSlotRef.current = () => {
    startTransition(() => {
      setSnapshots((prev) => ({
        ...prev,
        [activeSnapshotRef.current]: buildLiveSnapshotFromRefs(),
      }));
    });
  };

  onWindowPointerEndCaptureRef.current = (e?: Event) => {
    const wasBarsDrag = barsSliderDraggingRef.current;
    if (!wasBarsDrag && !syllablesSliderDraggingRef.current) return;
    barsSliderDraggingRef.current = false;
    syllablesSliderDraggingRef.current = false;
    if (sliderWindowListenersAttachedRef.current) {
      sliderWindowListenersAttachedRef.current = false;
      window.removeEventListener('pointerup', stableWindowPointerEnd, true);
      window.removeEventListener('pointercancel', stableWindowPointerEnd, true);
      window.removeEventListener('touchend', stableWindowPointerEnd, true);
    }
    flushLiveSnapshotToActiveSlotRef.current();
    /* Desktop: pointerup; mobile: часто touchend без pointerup на window. Не pointercancel — не снимать режим при жесте/скролле. */
    const releaseLike = e?.type === 'pointerup' || e?.type === 'touchend';
    if (releaseLike && wasBarsDrag) {
      barsSliderPressSessionEndRef.current?.();
    }
  };

  useEffect(() => {
    return () => {
      if (sliderWindowListenersAttachedRef.current) {
        sliderWindowListenersAttachedRef.current = false;
        window.removeEventListener('pointerup', stableWindowPointerEnd, true);
        window.removeEventListener('pointercancel', stableWindowPointerEnd, true);
        window.removeEventListener('touchend', stableWindowPointerEnd, true);
      }
    };
  }, [stableWindowPointerEnd]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        onWindowPointerEndCaptureRef.current();
        endLiveControlWindow();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [endLiveControlWindow]);

  useEffect(() => {
    const onPointerEnd = () => endLiveControlWindow();
    const onBlur = () => endLiveControlWindow();
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endLiveControlWindow();
    };
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('pointercancel', onPointerEnd, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onEsc, true);
    return () => {
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, [endLiveControlWindow]);

  const getSnapshotPayloadForSlotExport = (slot: number): ReturnType<typeof createEmptySnapshot> => {
    if (activeSnapshotRef.current === slot) {
      return buildLiveSnapshotFromRefs();
    }
    const raw = snapshotsRef.current[slot] ?? createEmptySnapshot();
    const acc = raw.accents;
    const accentsArr =
      acc instanceof Set
        ? [...acc]
        : Array.isArray(acc)
          ? acc.filter((x): x is string => typeof x === 'string')
          : [];
    const tdk = raw.taDingKeys;
    const taDingKeysArr =
      tdk instanceof Set
        ? [...tdk]
        : Array.isArray(tdk)
          ? tdk.filter((x): x is string => typeof x === 'string')
          : [];
    return parseSnapshotRow({
      tempo: raw.tempo,
      bars: raw.bars,
      syllables: raw.syllables,
      accents: accentsArr,
      accentsByLane: (raw as { accentsByLane?: unknown }).accentsByLane,
      taDingKeys: taDingKeysArr,
      firstBeatDingSuppressedRows: (raw as { firstBeatDingSuppressedRows?: unknown }).firstBeatDingSuppressedRows,
      taDingKeysByLane: (raw as { taDingKeysByLane?: unknown }).taDingKeysByLane,
      sequencerCells: raw.sequencerCells,
      customSyllables: raw.customSyllables,
      customMultipliers: raw.customMultipliers,
      customSubdivisions: raw.customSubdivisions,
      // Critical for clipboard round-trip from non-active snapshot slots:
      // without explicit masks, muted cells (Divs=0) collapse to plain subdiv values.
      cellStepMasks: (raw as { cellStepMasks?: CellStepMasks }).cellStepMasks,
      customCellSyllables: (raw as { customCellSyllables?: Record<string, string> }).customCellSyllables,
      randomModeEnabled: raw.randomModeEnabled,
      randomPulsation: raw.randomPulsation,
      randomPattern: raw.randomPattern,
      randomSpeed: raw.randomSpeed,
      randomBarSpeed: raw.randomBarSpeed,
      chaosLevel: raw.chaosLevel,
      progressiveDensityMode: (raw as { progressiveDensityMode?: unknown }).progressiveDensityMode,
      deSyncJatiActive: (raw as { deSyncJatiActive?: unknown }).deSyncJatiActive,
      deSyncCycleLength: (raw as { deSyncCycleLength?: unknown }).deSyncCycleLength,
      clickSound: raw.clickSound,
      clickSoundByPolyVoice: (raw as { clickSoundByPolyVoice?: unknown }).clickSoundByPolyVoice,
      clickBusBalance: (raw as AppSnapshot).clickBusBalance,
      clickBusBalanceByPreset: (raw as AppSnapshot).clickBusBalanceByPreset,
      clickBusBalanceByVoicePreset: (raw as AppSnapshot).clickBusBalanceByVoicePreset,
      panelExpanded: raw.panelExpanded,
      pulseMeterUnlinked: raw.pulseMeterUnlinked,
      frozenScale: raw.frozenScale,
      lowPerfMode: (raw as { lowPerfMode?: unknown }).lowPerfMode,
      polyMode: raw.polyMode,
      polyVoices: raw.polyVoices,
      onlyAccents: raw.onlyAccents,
      mixerLayerMode: (raw as { mixerLayerMode?: MixerLayerMode }).mixerLayerMode,
      trainerMode: (raw as { trainerMode?: TrainerMode }).trainerMode,
      trainerHoldMute: (raw as { trainerHoldMute?: boolean }).trainerHoldMute,
      squarePlaybackMode: (raw as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode,
      squarePassiveLayerMuted: (raw as { squarePassiveLayerMuted?: boolean }).squarePassiveLayerMuted,
      firstBeatAccent: raw.firstBeatAccent,
      firstBeatAccentByLane: (raw as { firstBeatAccentByLane?: unknown }).firstBeatAccentByLane,
      accentMapVersion: (raw as { accentMapVersion?: number }).accentMapVersion,
      syllableReadMuteMode: raw.syllableReadMuteMode,
      syllableReadMuteLatched: raw.syllableReadMuteLatched,
      dictantMode: (raw as { dictantMode?: boolean }).dictantMode,
      deadCells: (raw as { deadCells?: DeadCellsMap }).deadCells,
    });
  };

  useEffect(() => {
    setPulseMeterUnlinked((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        const ri = Number(k);
        if (ri >= bars) {
          delete next[ri];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [bars]);

  /** Сколько тактов по высоте «влезает» при текущей шкале (freeze фиксирует делитель отдельно от `bars`). */
  const displayScaleBars = frozenScale !== null ? Math.min(frozenScale, 10) : Math.min(bars, 10);
  /** Все такты влезают в окно — без виртуальной ленты и без автопрокрутки (в т.ч. при включённом freeze). */
  const allBarsFitViewport = bars <= displayScaleBars;
  /** Совпадает с `SequencerGrid` virtualRowCount — нужен в deps автоскролла, чтобы повторить попытку, когда лента дорисовалась в DOM. */
  const legacyStripVirtualRowCount = useMemo(() => {
    if (polyMode || !isPlaying || allBarsFitViewport) return bars;
    if (autoscrollVirtualRowsEnabled) {
      return Math.max(bars, activePos.absR + displayScaleBars * 2);
    }
    const limitedCycles = 3;
    return bars * limitedCycles;
  }, [
    polyMode,
    isPlaying,
    allBarsFitViewport,
    bars,
    autoscrollVirtualRowsEnabled,
    activePos.absR,
    displayScaleBars,
  ]);
  const disableMenuSmoothing = lowPerfMode || bars > 8 || syllables >= 9;

  const sequence = React.useMemo(
    () =>
      buildLegacyPlaybackSequence(
        bars,
        customSyllables,
        syllables,
        deadCells,
        customCellSyllables,
        customSubdivisions,
        cellStepMasks,
      ),
    [bars, syllables, customSyllables, deadCells, customCellSyllables, customSubdivisions, cellStepMasks],
  );

  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence; // Always keep ref atomic with render
  const polyChunks = useMemo(() => buildPolyChunks(bars, polyVoices), [bars, polyVoices]);
  const polyChunksRef = useRef(polyChunks);
  polyChunksRef.current = polyChunks;

  /** Слайдер Bars: legacy-диапазон в poly 30/32; если вручную введено больше, расширяем шкалу до 99/100. */
  const barsStructuralRange = useMemo(() => {
    if (!polyMode) return { min: 1, max: 32, step: 1 };
    if (polyVoices === 3) {
      const max = bars > 30 ? 99 : 30;
      return { min: 3, max, step: 3 };
    }
    const max = bars > 32 ? 100 : 32;
    return { min: 2, max, step: 2 };
  }, [polyMode, polyVoices, bars]);

  // Auto-save preset whenever parameters change (пропуск во время drag Bars/Syllables — см. pointerup flush)
  useEffect(() => {
    if (barsSliderDraggingRef.current || syllablesSliderDraggingRef.current) {
      return;
    }
    startTransition(() => {
      setSnapshots((prev) => ({
      ...prev,
        [activeSnapshot]: {
          tempo,
          bars,
          syllables,
          accents,
          accentsByLane,
          taDingKeys,
          firstBeatDingSuppressedRows,
          taDingKeysByLane,
          customSyllables,
          deadCells,
          customMultipliers,
          customSubdivisions,
          cellStepMasks,
          customCellSyllables,
          randomModeEnabled,
          randomPulsation,
          randomPattern,
          randomSpeed,
          randomBarSpeed,
          chaosLevel: chaosLevelRef.current,
          clickSound,
          clickSoundByPolyVoice,
          polyVoiceGains,
          clickBusBalance: getClickPresetBusGainsForVoicePreset(
            clickPresetBusGainsByVoice,
            clickPresetBusGains,
            0,
            clickSound,
          ),
          clickBusBalanceByPreset: collectSnapshotClickBusBalanceByPreset(
            clickSound,
            clickSoundByPolyVoice,
            polyMode,
            clickPresetBusGains,
          ),
          clickBusBalanceByVoicePreset: collectSnapshotClickBusBalanceByVoicePreset(
            clickSound,
            clickSoundByPolyVoice,
            polyMode,
            clickPresetBusGainsByVoice,
            clickPresetBusGains,
          ),
          panelExpanded: isPanelExpanded,
          pulseMeterUnlinked: { ...pulseMeterUnlinked },
          frozenScale,
          lowPerfMode,
          polyMode,
          polyVoices,
          mixerLayerMode,
          trainerMode,
          trainerHoldMute,
          onlyAccents: false,
          ...mapNewModesToLegacySnapshot(mixerLayerMode, trainerMode),
          firstBeatAccent,
          firstBeatAccentByLane,
          accentMapVersion,
          syllableReadMuteMode,
          dictantMode,
          randomMode,
          parentGenome,
          parentLength,
          enabledMutations,
          formPresetId,
          pressMatrixArmSource: pressMatrixArmSourceUi,
        },
      }));
    });
  }, [
    tempo,
    bars,
    syllables,
    accents,
    accentsByLane,
    taDingKeys,
    firstBeatDingSuppressedRows,
    taDingKeysByLane,
    customSyllables,
    deadCells,
    customMultipliers,
    customSubdivisions,
    cellStepMasks,
    customCellSyllables,
    pulseMeterUnlinked,
    activeSnapshot,
    randomModeEnabled,
    randomPulsation,
    randomPattern,
    randomSpeed,
    randomBarSpeed,
    clickSound,
    clickSoundByPolyVoice,
    polyVoiceGains,
    clickPresetBusGains,
    clickPresetBusGainsByVoice,
    isPanelExpanded,
    frozenScale,
    lowPerfMode,
    polyMode,
    polyVoices,
    mixerLayerMode,
    trainerMode,
    trainerHoldMute,
    firstBeatAccent,
    firstBeatAccentByLane,
    accentMapVersion,
    syllableReadMuteMode,
    dictantMode,
    pressMatrixArmSourceUi,
  ]);

  useEffect(() => {
    if (persistSnapshotsTimerRef.current !== null) {
      window.clearTimeout(persistSnapshotsTimerRef.current);
    }
    persistSnapshotsTimerRef.current = window.setTimeout(() => {
      persistSnapshotsTimerRef.current = null;
      try {
        const out: Record<string, ReturnType<typeof snapshotToJSON>> = {};
        for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) {
          let s = snapshots[i];
          if (i === activeSnapshot && s) {
            s = { ...s, chaosLevel: chaosLevelRef.current };
          }
          if (s) out[String(i)] = snapshotToJSON(s);
        }
        localStorage.setItem(
          SNAPSHOT_STORAGE_KEY,
          JSON.stringify({ activeSnapshot, snapshots: out }),
        );
        const compactSlots: Record<string, string> = {};
        const compactSlotUi: NonNullable<CompactSnapshotStoragePayload['slotUi']> = {};
        for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) {
          let s = snapshots[i];
          if (i === activeSnapshot && s) {
            s = { ...s, chaosLevel: chaosLevelRef.current };
          }
          if (!s) continue;
          compactSlots[String(i)] = encodeSnapshotClipboard(s);
          compactSlotUi[String(i)] = {
            lowPerfMode: (s as { lowPerfMode?: boolean }).lowPerfMode === true,
            frozenScale: typeof s.frozenScale === 'number' && s.frozenScale >= 1 ? s.frozenScale : null,
          };
        }
        const compactPayload: CompactSnapshotStoragePayload = {
          v: 1,
          activeSnapshot,
          slots: compactSlots,
          slotUi: compactSlotUi,
        };
        localStorage.setItem(SNAPSHOT_STORAGE_COMPACT_KEY, JSON.stringify(compactPayload));
      } catch (e) {
        console.warn('[konnakol_trainer] snapshot persist failed', e);
      }
    }, 400);
    return () => {
      if (persistSnapshotsTimerRef.current !== null) {
        window.clearTimeout(persistSnapshotsTimerRef.current);
        persistSnapshotsTimerRef.current = null;
      }
    };
  }, [snapshots, activeSnapshot, chaosLevel]);

  const applySnapshotDataToUi = (
    snap: ReturnType<typeof createEmptySnapshot>,
    options?: { preservePanel?: boolean },
  ) => {
      const snapVoices = parsePolyVoices(snap.polyVoices);
      setTempo(snap.tempo);
      setBars(snapBarsToPolyGrid(snap.bars, snap.polyMode === true, snapVoices));
      setSyllables(snap.syllables);
    const nextAccents = new Set(
      Array.isArray(snap.accents)
        ? snap.accents
        : snap.accents instanceof Set
          ? [...snap.accents]
          : [],
    );
    setAccents(
      new Set(
        nextAccents,
      ),
    );
    const nextTaDing = new Set(
      Array.isArray(snap.taDingKeys)
        ? snap.taDingKeys
        : snap.taDingKeys instanceof Set
          ? [...snap.taDingKeys]
          : [],
    );
    setTaDingKeys(
      new Set(
        nextTaDing,
      ),
    );
    const nextAccByLane = cloneLaneSetMap((snap as { accentsByLane?: Partial<Record<number, Iterable<string>>> }).accentsByLane);
    const nextTaByLane = cloneLaneSetMap((snap as { taDingKeysByLane?: Partial<Record<number, Iterable<string>>> }).taDingKeysByLane);
    setAccentsByLane(nextAccByLane);
    accentsByLaneRef.current = cloneLaneSetMap(nextAccByLane);
    setTaDingKeysByLane(nextTaByLane);
    taDingKeysByLaneRef.current = cloneLaneSetMap(nextTaByLane);
      setCustomSyllables({ ...snap.customSyllables });
      setDeadCells({ ...((snap as { deadCells?: DeadCellsMap }).deadCells || {}) });
      deadCellsRef.current = { ...((snap as { deadCells?: DeadCellsMap }).deadCells || {}) };
      setCustomMultipliers({ ...(snap.customMultipliers || {}) });
      const nextSubdivs = { ...(snap.customSubdivisions || {}) };
      const nextMasks = { ...(snap.cellStepMasks || {}) };
      const nextConfigs = buildCellConfigsFromLegacy(nextSubdivs, nextMasks);
      setCustomSubdivisions(nextSubdivs);
      customSubdivisionsRef.current = nextSubdivs;
      setCellStepMasks(nextMasks);
      cellStepMasksRef.current = nextMasks;
      setCellConfigs(nextConfigs);
      cellConfigsRef.current = nextConfigs;
      const nextCellSyl = { ...((snap as { customCellSyllables?: Record<string, string> }).customCellSyllables || {}) };
      setCustomCellSyllables(nextCellSyl);
      customCellSyllablesRef.current = nextCellSyl;
    {
      const nextRandomMode =
        snap.randomModeEnabled !== undefined ? Boolean(snap.randomModeEnabled) : false;
      randomModeEnabledRef.current = nextRandomMode;
      setRandomModeEnabled(nextRandomMode);
    }
    setRandomPulsation(
      snap.randomPulsation !== undefined ? Boolean(snap.randomPulsation) : false,
    );
    setRandomPattern(
      snap.randomPattern !== undefined ? Boolean(snap.randomPattern) : true,
    );
    setRandomSpeed(
      snap.randomSpeed !== undefined ? Boolean(snap.randomSpeed) : false,
    );
    setRandomBarSpeed(
      snap.randomBarSpeed !== undefined ? Boolean(snap.randomBarSpeed) : false,
    );
    setChaosLevel(
      typeof snap.chaosLevel === 'number' && snap.chaosLevel >= 0 && snap.chaosLevel <= 100
        ? snap.chaosLevel
        : 0,
    );
    const nextClickSound: ClickSoundPreset = isClickSoundPreset(snap.clickSound) ? snap.clickSound : 'classic';
    setClickSound(nextClickSound);
    clickSoundRef.current = nextClickSound;
    const nextClickByVoice = normalizeClickSoundByPolyVoice(
      (snap as { clickSoundByPolyVoice?: unknown }).clickSoundByPolyVoice,
    );
    clickSoundByPolyVoiceRef.current = { ...nextClickByVoice };
    setClickSoundByPolyVoice(nextClickByVoice);
    const nextPolyVoiceGains = parsePolyVoiceGainsFromUnknown((snap as { polyVoiceGains?: unknown }).polyVoiceGains);
    if (nextPolyVoiceGains) {
      polyVoiceGainsRef.current = { ...nextPolyVoiceGains };
      setPolyVoiceGains(nextPolyVoiceGains);
    }
    const busByPresetFromSnap = parseClickBusBalanceByPresetFromUnknown(
      (snap as AppSnapshot).clickBusBalanceByPreset,
    );
    const busByVoicePresetFromSnap = parseClickBusBalanceByVoicePresetFromUnknown(
      (snap as AppSnapshot).clickBusBalanceByVoicePreset,
    );
    const busFromSnap = (snap as AppSnapshot).clickBusBalance;
    if (busByVoicePresetFromSnap && Object.keys(busByVoicePresetFromSnap).length > 0) {
      setClickPresetBusGainsByVoice((prev) => {
        const updated = { ...prev, ...busByVoicePresetFromSnap };
        clickPresetBusGainsByVoiceRef.current = updated;
        return updated;
      });
    }
    if (busByPresetFromSnap && Object.keys(busByPresetFromSnap).length > 0) {
      setClickPresetBusGains((prev) => {
        const updated = { ...prev, ...busByPresetFromSnap };
        clickPresetBusGainsRef.current = updated;
        return updated;
      });
    } else if (busFromSnap) {
      setClickPresetBusGains((prev) => {
        const updated = { ...prev, [nextClickSound]: busFromSnap };
        clickPresetBusGainsRef.current = updated;
        return updated;
      });
    }
    const nextPulseUnlinked = normalizePulseMeterUnlinked(snap.pulseMeterUnlinked);
    setPulseMeterUnlinked(nextPulseUnlinked);
    {
      const hasNewModes =
        (snap as { mixerLayerMode?: unknown }).mixerLayerMode !== undefined ||
        (snap as { trainerMode?: unknown }).trainerMode !== undefined;
      const fallback = deriveNewModesFromLegacySnapshot({
        squarePlaybackMode: (snap as { squarePlaybackMode?: unknown }).squarePlaybackMode,
        squarePassiveLayerMuted: (snap as { squarePassiveLayerMuted?: unknown }).squarePassiveLayerMuted,
        dictantMode: (snap as { dictantMode?: unknown }).dictantMode,
        onlyAccents: (snap as { onlyAccents?: unknown }).onlyAccents,
      });
      const nextMixer = hasNewModes
        ? normalizeMixerLayerModeFromSnapshot((snap as { mixerLayerMode?: unknown }).mixerLayerMode)
        : fallback.mixerLayerMode;
      const nextTrainer = hasNewModes
        ? normalizeTrainerModeFromSnapshot((snap as { trainerMode?: unknown }).trainerMode)
        : fallback.trainerMode;
      const nextHoldMute = (snap as { trainerHoldMute?: boolean }).trainerHoldMute === true;
      setMixerLayerMode(nextMixer);
      mixerLayerModeRef.current = nextMixer;
      setTrainerMode(nextTrainer);
      trainerModeRef.current = nextTrainer;
      setTrainerHoldMute(nextHoldMute);
      trainerHoldMuteRef.current = nextHoldMute;
      dictantModeRef.current = nextTrainer === 'dictation';
    }
    const nextFirstBeatByLane = cloneLaneBoolMap(
      (snap as { firstBeatAccentByLane?: Partial<Record<number, boolean>> }).firstBeatAccentByLane,
      snap.firstBeatAccent !== false,
    );
    setFirstBeatAccentByLane(nextFirstBeatByLane);
    firstBeatAccentByLaneRef.current = { ...nextFirstBeatByLane };
    setFirstBeatAccent(Boolean(nextFirstBeatByLane[0]));
    setAccentMapVersion((snap as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0);
    let nextRandomMode: RandomMode = 'free';
    let nextFormPresetId: FormPresetId = 'random';
    {
      const nextMode: RandomMode = isRandomMode((snap as { randomMode?: unknown }).randomMode)
        ? ((snap as { randomMode: RandomMode }).randomMode)
        : 'free';
      nextRandomMode = nextMode;
      randomModeRef.current = nextMode;
      setRandomMode(nextMode);
      const pg = parentGenomeFromJSON((snap as { parentGenome?: unknown }).parentGenome);
      parentGenomeRef.current = pg;
      setParentGenome(pg);
      const plRaw = parseInt(String((snap as { parentLength?: unknown }).parentLength), 10);
      const pl: ParentLength = plRaw === 2 ? 2 : 1;
      parentLengthRef.current = pl;
      setParentLength(pl);
      const emIn = (snap as { enabledMutations?: unknown }).enabledMutations;
      const em: MutationType[] = Array.isArray(emIn)
        ? emIn.filter(isMutationType)
        : [...PRESET_ENABLED_MUTATIONS.random];
      enabledMutationsRef.current = em;
      setEnabledMutations(em);
      const fpIn = (snap as { formPresetId?: unknown }).formPresetId;
      const fp: FormPresetId = isFormPresetId(fpIn) ? fpIn : 'random';
      nextFormPresetId = fp;
      formPresetIdRef.current = fp;
      setFormPresetId(fp);
    }
    {
      // Snapshot may restore pulse-unlink rows, but jatiPulseActiveByRow is runtime-only.
      // Rebuild it deterministically to avoid stale "stuck pulse menu" rows from previous session.
      const allowPulseJati = nextRandomMode === 'parent' && nextFormPresetId === 'progressive';
      if (!allowPulseJati) {
        setJatiPulseActiveByRow({});
        progressiveDensityModeRef.current = 'gati_mode';
        deSyncJatiActiveRef.current = false;
        deSyncCycleLengthRef.current = undefined;
        setProgressiveDensityMode('gati_mode');
        setDeSyncJatiActive(false);
        setDeSyncCycleLength(undefined);
      } else {
        const nextJatiRows: Record<number, boolean> = {};
        for (const [k, v] of Object.entries(nextPulseUnlinked)) {
          const ri = parseInt(k, 10);
          if (Number.isFinite(ri) && ri >= 0 && v) nextJatiRows[ri] = true;
        }
        setJatiPulseActiveByRow(nextJatiRows);
      }
    }
    setIsTaEditorMode(false);
    /**
     * Agent note (snapshot contract):
     * `firstBeatDingSuppressedRows` can arrive as Set (runtime snapshot) or Array (JSON/clipboard).
     * Always normalize both shapes, otherwise suppressed rows are lost and default first-beat marks come back.
     */
    setFirstBeatDingSuppressedRows(
      normalizeSuppressedRows(
        (snap as { firstBeatDingSuppressedRows?: unknown }).firstBeatDingSuppressedRows,
        snap.bars,
      ),
    );
    const nextMute = normalizeSyllableReadMuteModeFromSnapshot(
      snap.syllableReadMuteMode,
      (snap as { syllableReadMuteLatched?: boolean }).syllableReadMuteLatched,
    );
    setSyllableReadMuteMode(nextMute);
    syllableReadMuteModeRef.current = nextMute;
    setFrozenScale(
      typeof snap.frozenScale === 'number' && snap.frozenScale >= 1 ? snap.frozenScale : null,
    );
    setLowPerfMode((snap as { lowPerfMode?: unknown }).lowPerfMode === true);
    setPolyMode(snap.polyMode === true);
    setPolyVoices(snapVoices);
    setActiveClickVoiceTarget(0);
    if (!options?.preservePanel) {
      setIsPanelExpanded(snap.panelExpanded === true);
    }
    /**
     * Press Matrix: snapshot owns matrix state explicitly.
     * We only arm when snapshot stores `pressMatrixArmSource`; no implicit
     * "non-empty snapshot => matrix on" behavior.
     */
    {
      const snapSuppressed = normalizeSuppressedRows(
        (snap as { firstBeatDingSuppressedRows?: unknown }).firstBeatDingSuppressedRows,
        snap.bars,
      );
      const snapPressState: PressState = {
        bars: snap.bars,
        syllables: snap.syllables,
        polyMode: snap.polyMode === true,
        polyVoices: snapVoices,
        customSyllables: { ...snap.customSyllables },
        customMultipliers: { ...(snap.customMultipliers || {}) },
        customSubdivisions: { ...(snap.customSubdivisions || {}) },
        cellStepMasks: { ...((snap as { cellStepMasks?: CellStepMasks }).cellStepMasks || {}) },
        customCellSyllables: { ...((snap as { customCellSyllables?: Record<string, string> }).customCellSyllables || {}) },
        accents: new Set(nextAccents),
        taDingKeys: new Set(nextTaDing),
        accentsByLane: cloneLaneSetMap(nextAccByLane),
        taDingKeysByLane: cloneLaneSetMap(nextTaByLane),
        firstBeatDingSuppressedRows: new Set(snapSuppressed),
        pulseMeterUnlinked: { ...nextPulseUnlinked },
        deadCells: { ...((snap as { deadCells?: DeadCellsMap }).deadCells || {}) },
      };
      const snapArmSourceRaw = (snap as { pressMatrixArmSource?: unknown }).pressMatrixArmSource;
      const snapArmSource: PressArmSource | null =
        snapArmSourceRaw === 'slider' || snapArmSourceRaw === 'star' ? snapArmSourceRaw : null;
      if (snapArmSource === null || isPressStateEmpty(snapPressState)) {
        detachMobileSliderCoarseDisarmRef.current();
        notifyPressErased();
        setPressMatrixArmSourceUi(null);
      } else {
        armPressFromState(snapPressState, snapArmSource);
        setPressMatrixArmSourceUi(snapArmSource);
        if (snapArmSource === 'slider') attachMobileSliderCoarseDisarm();
        else detachMobileSliderCoarseDisarmRef.current();
      }
    }
  };

  const loadSnapshot = (id: number) => {
    onWindowPointerEndCaptureRef.current();
    flushLiveSnapshotToActiveSlotRef.current();
    flushChaosToActiveSnapshot();
    activeSnapshotRef.current = id;
    setActiveSnapshot(id);
    const snap = snapshots[id] ?? createEmptySnapshot();
    applySnapshotDataToUi(snap, { preservePanel: true });
  };

  const normalizeSnapshotForStorage = (
    s: ReturnType<typeof createEmptySnapshot>,
  ): ReturnType<typeof createEmptySnapshot> => ({
    ...s,
    accents: s.accents instanceof Set ? new Set(s.accents) : new Set(Array.isArray(s.accents) ? s.accents : []),
    taDingKeys:
      s.taDingKeys instanceof Set ? new Set(s.taDingKeys) : new Set(Array.isArray(s.taDingKeys) ? s.taDingKeys : []),
    customSyllables: { ...s.customSyllables },
    deadCells: { ...((s as { deadCells?: DeadCellsMap }).deadCells || {}) },
    customMultipliers: { ...s.customMultipliers },
    customSubdivisions: { ...s.customSubdivisions },
    cellStepMasks: { ...(s.cellStepMasks || {}) },
    customCellSyllables: { ...((s as { customCellSyllables?: Record<string, string> }).customCellSyllables || {}) },
    panelExpanded: s.panelExpanded === true,
    clickSoundByPolyVoice: normalizeClickSoundByPolyVoice(s.clickSoundByPolyVoice),
    polyVoiceGains:
      parsePolyVoiceGainsFromUnknown((s as { polyVoiceGains?: unknown }).polyVoiceGains) ?? {
        ...DEFAULT_POLY_VOICE_GAINS,
      },
    pulseMeterUnlinked: { ...(s.pulseMeterUnlinked || {}) },
    frozenScale: typeof s.frozenScale === 'number' && s.frozenScale >= 1 ? s.frozenScale : null,
    lowPerfMode: (s as { lowPerfMode?: unknown }).lowPerfMode === true,
    polyMode: s.polyMode === true,
    polyVoices: parsePolyVoices(s.polyVoices),
    mixerLayerMode: normalizeMixerLayerModeFromSnapshot((s as { mixerLayerMode?: unknown }).mixerLayerMode),
    trainerMode: normalizeTrainerModeFromSnapshot((s as { trainerMode?: unknown }).trainerMode),
    trainerHoldMute: (s as { trainerHoldMute?: boolean }).trainerHoldMute === true,
    ...mapNewModesToLegacySnapshot(
      normalizeMixerLayerModeFromSnapshot((s as { mixerLayerMode?: unknown }).mixerLayerMode),
      normalizeTrainerModeFromSnapshot((s as { trainerMode?: unknown }).trainerMode),
    ),
    onlyAccents: false,
    firstBeatAccent: s.firstBeatAccent !== false,
    accentMapVersion: (s as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
    syllableReadMuteMode: normalizeSyllableReadMuteModeFromSnapshot(s.syllableReadMuteMode, undefined),
    dictantMode: normalizeTrainerModeFromSnapshot((s as { trainerMode?: unknown }).trainerMode) === 'dictation',
  });

  const copySnapshotSlotToClipboard = async (slot: number) => {
    try {
      const payload = getSnapshotPayloadForSlotExport(slot);
      await navigator.clipboard.writeText(encodeSnapshotClipboard(payload));
      showClipboardToast('Settings copied to clipboard!');
      closeSnapshotClipMenu();
    } catch (e) {
      console.warn('[konnakol_trainer] clipboard write failed', e);
      showClipboardToast('Could not write to clipboard');
      closeSnapshotClipMenu();
    }
  };

  const handleExportMidi = async (opts?: { autoAlignTwoVoice?: boolean }) => {
    try {
      let exportSnapshot: ReturnType<typeof createEmptySnapshot> | null = null;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          const clip = await navigator.clipboard.readText();
          const parsed = tryDecodeSnapshotClipboard(clip);
          if (parsed) {
            exportSnapshot = normalizeSnapshotForStorage(parsed);
          }
        }
      } catch {
        // Clipboard may be unavailable; silently fall back to current UI state.
      }

      const src = exportSnapshot;
      const exportPolyMode = src ? src.polyMode === true : polyModeRef.current;
      const exportPolyVoices = src ? parsePolyVoices(src.polyVoices) : polyVoicesRef.current;
      const pv = exportPolyVoices === 3 ? 3 : 2;
      const autoAlignRequested = opts?.autoAlignTwoVoice === true;
      const autoAlignEnabled = autoAlignRequested && exportPolyMode && pv === 2;
      if (autoAlignRequested && !autoAlignEnabled) {
        showClipboardToast('Auto-align MIDI доступен только в 2-voice poly');
      } else if (autoAlignEnabled) {
        showClipboardToast('MIDI: auto-align по первым нотам (лимит 100 тактов)');
      }
      const laneRoleGains: Partial<Record<0 | 1 | 2, { accent: number; alt: number; passive: number }>> = {};
      const laneCount = exportPolyMode ? pv : 1;
      for (let lane = 0; lane < laneCount; lane++) {
        const voiceIdx = (lane <= 0 ? 0 : lane === 1 ? 1 : 2) as 0 | 1 | 2;
        const sourceVoiceGains = src
          ? parsePolyVoiceGainsFromUnknown((src as { polyVoiceGains?: unknown }).polyVoiceGains) ?? DEFAULT_POLY_VOICE_GAINS
          : polyVoiceGainsRef.current;
        const sourceClickSound = src ? src.clickSound : clickSoundRef.current;
        const sourceClickSoundByVoice = src ? normalizeClickSoundByPolyVoice(src.clickSoundByPolyVoice) : clickSoundByPolyVoiceRef.current;
        const sourceBusByVoice = src
          ? parseClickBusBalanceByVoicePresetFromUnknown((src as { clickBusBalanceByVoicePreset?: unknown }).clickBusBalanceByVoicePreset) ?? {}
          : clickPresetBusGainsByVoiceRef.current;
        const sourceBusByPreset = src
          ? parseClickBusBalanceByPresetFromUnknown((src as { clickBusBalanceByPreset?: unknown }).clickBusBalanceByPreset) ?? {}
          : clickPresetBusGainsRef.current;
        const voiceGain = exportPolyMode
          ? Math.max(0, Math.min(1.6, sourceVoiceGains[voiceIdx] ?? 1))
          : Math.max(0, Math.min(1.6, sourceVoiceGains[0] ?? 1));
        const preset = resolveClickSoundForPolyVoice(
          voiceIdx,
          exportPolyMode,
          sourceClickSoundByVoice,
          sourceClickSound,
        );
        const bus = getClickPresetBusGainsForVoicePreset(
          sourceBusByVoice,
          sourceBusByPreset,
          voiceIdx,
          preset,
        );
        laneRoleGains[voiceIdx] = {
          accent: Math.max(0, voiceGain * bus.accent),
          alt: Math.max(0, voiceGain * bus.alt),
          passive: Math.max(0, voiceGain * bus.passive),
        };
      }
      const blob = generateMidiBlob({
        bpm: src ? src.tempo : tempoRef.current,
        bars: src ? src.bars : barsRef.current,
        baseSyllables: src ? src.syllables : syllablesRef.current,
        customSyllables: src ? { ...src.customSyllables } : { ...customSyllablesRef.current },
        customSubdivisions: src ? { ...src.customSubdivisions } : { ...customSubdivisionsRef.current },
        cellStepMasks: src ? { ...(src.cellStepMasks || {}) } : { ...cellStepMasksRef.current },
        pulseMeterUnlinked: src ? { ...(src.pulseMeterUnlinked || {}) } : { ...pulseMeterUnlinkedRef.current },
        customMultipliers: src ? { ...src.customMultipliers } : { ...customMultipliersRef.current },
        rowRuntimeContexts,
        progressiveDensityMode: src ? src.progressiveDensityMode : progressiveDensityModeRef.current,
        deSyncJatiActive: src ? src.deSyncJatiActive : deSyncJatiActiveRef.current,
        deSyncCycleLength: src ? src.deSyncCycleLength : deSyncCycleLengthRef.current,
        accents: src ? new Set(src.accents) : new Set(accentsRef.current),
        accentsByLane: src ? cloneLaneSetMap(src.accentsByLane) : cloneLaneSetMap(accentsByLaneRef.current),
        taDingKeys: src ? new Set(src.taDingKeys) : new Set(taDingKeysRef.current),
        taDingKeysByLane: src ? cloneLaneSetMap(src.taDingKeysByLane) : cloneLaneSetMap(taDingKeysByLaneRef.current),
        firstBeatAccent: src ? src.firstBeatAccent : firstBeatAccentRef.current,
        firstBeatAccentByLane: src ? { ...src.firstBeatAccentByLane } : { ...firstBeatAccentByLaneRef.current },
        firstBeatDingSuppressedRows: src ? new Set(src.firstBeatDingSuppressedRows ?? []) : new Set(firstBeatDingSuppressedRowsRef.current),
        deadCells: src ? { ...(src.deadCells || {}) } : { ...deadCellsRef.current },
        polyMode: exportPolyMode,
        polyVoices: pv,
        mixerLayerMode: src ? src.mixerLayerMode : mixerLayerModeRef.current,
        trainerMode: src ? src.trainerMode : trainerModeRef.current,
        trainerHoldMute: src ? src.trainerHoldMute : trainerHoldMuteRef.current,
        ...mapNewModesToLegacySnapshot(src ? src.mixerLayerMode : mixerLayerModeRef.current, src ? src.trainerMode : trainerModeRef.current),
        syllableReadMuteMode: src ? src.syllableReadMuteMode : syllableReadMuteModeRef.current,
        dictantMode: src ? src.dictantMode : dictantModeRef.current,
        clickSound: src ? src.clickSound : clickSoundRef.current,
        clickSoundByPolyVoice: src ? { ...normalizeClickSoundByPolyVoice(src.clickSoundByPolyVoice) } : { ...clickSoundByPolyVoiceRef.current },
        laneRoleGains,
        twoVoiceAutoAlignByFirstNotes: autoAlignEnabled,
        twoVoiceAutoAlignMaxBars: 100,
      });
      const exportBpm = Math.max(1, Math.round(src ? src.tempo : tempoRef.current));
      const exportVoices = exportPolyMode ? pv : 1;
      const name = `midi_${exportBpm}bpm_${exportVoices}v.mid`;
      const file = new File([blob], name, { type: 'audio/midi' });
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        const can = navigator.canShare?.({ files: [file] });
        if (can) {
          void navigator.share({ files: [file], title: 'Konnakol MIDI' }).catch((err) => {
            console.warn('[konnakol_trainer] Web Share failed, falling back to download', err);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name;
            a.click();
            URL.revokeObjectURL(url);
          });
          return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn('[konnakol_trainer] export MIDI failed', e);
    }
  };

  const pasteSnapshotFromClipboard = async (slot: number) => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      console.warn('[konnakol_trainer] clipboard read failed', e);
      showClipboardToast('Clipboard access denied');
      return;
    }
    const parsed = tryDecodeSnapshotClipboard(text);
    if (!parsed) {
      showClipboardToast('No snapshot marker found in clipboard');
      return;
    }
    try {
      const stored = normalizeSnapshotForStorage(parsed);
      // Clipboard paste must not carry armed Press Matrix state.
      stored.pressMatrixArmSource = null;
      onWindowPointerEndCaptureRef.current();
      flushChaosToActiveSnapshot();
      setSnapshots((prev) => ({
        ...prev,
        [slot]: stored,
      }));
      activeSnapshotRef.current = slot;
      setActiveSnapshot(slot);
      applySnapshotDataToUi(stored, { preservePanel: true });
      showClipboardToast('Preset applied!');
    } catch (e) {
      console.warn('[konnakol_trainer] apply preset failed', e);
      showClipboardToast('Could not apply preset');
    }
    closeSnapshotClipMenu();
  };

  const openSnapshotClipMenu = (slot: number) => {
    const el = snapshotSlotButtonRefs.current[slot];
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const margin = 52;
    const x = Math.min(window.innerWidth - margin, Math.max(margin, cx));
    setSnapshotClipMenu({
      slot,
      x,
      y: r.bottom + 8,
    });
  };

  const closeSnapshotClipMenu = () => setSnapshotClipMenu(null);

  useEffect(() => {
    if (!snapshotClipMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSnapshotClipMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshotClipMenu]);

  // Ensure currentStepRef bounds are respected if grid shrinks
  useEffect(() => {
    if (polyMode) {
      currentStepRef.current = 0;
      return;
    }
    if (currentStepRef.current >= sequence.length) {
      currentStepRef.current = 0;
    }
  }, [polyMode, polyChunks.length, sequence.length]);

  /** Poly sub_legacy: пересборка линий только при смене bars/polyVoices **уже во время** play (не на edge isPlaying→true: иначе затирает resetFromPatternBar). */
  const polyPlayRebuildSigRef = useRef({ bars, polyVoices, wasPlaying: false });
  useEffect(() => {
    const prev = polyPlayRebuildSigRef.current;
    polyPlayRebuildSigRef.current = { bars, polyVoices, wasPlaying: isPlaying };
    if (!isPlaying || !polyMode || !audioCtxRef.current) return;
    const poly = polySubLegacyRef.current;
    if (!poly) return;
    if (!prev.wasPlaying) return;
    if (prev.bars === bars && prev.polyVoices === polyVoices) return;
    poly.rebuildLanes(
      audioCtxRef.current.currentTime + schedulerConfigRef.current.scheduleAheadSec,
    );
  }, [isPlaying, polyMode, bars, polyVoices]);

  // Display metrics (displayScaleBars / allBarsFitViewport объявлены выше — общая шкала для сетки и скролла)
  // Важно: сам факт freeze не должен менять геометрию строк, если реальный масштаб не изменился.
  const baseScaleBars = Math.min(bars, 10);
  const useFixedFlex = bars >= 10 || displayScaleBars !== baseScaleBars;
  
  // Create a scroll stride that overlaps by 1 row
  const scrollStride = Math.max(1, displayScaleBars - 1);

  const setRowElStable = useCallback((absR: number, el: HTMLDivElement | null) => {
    rowRefs.current[absR] = el;
  }, []);
  const performAutoscrollToRow = useCallback((rowEl: HTMLDivElement) => {
    if (programmaticAutoscrollFallbackTimerRef.current !== null) {
      window.clearTimeout(programmaticAutoscrollFallbackTimerRef.current);
      programmaticAutoscrollFallbackTimerRef.current = null;
    }
    if (programmaticAutoscrollSettleTimerRef.current !== null) {
      window.clearTimeout(programmaticAutoscrollSettleTimerRef.current);
      programmaticAutoscrollSettleTimerRef.current = null;
    }
    programmaticAutoscrollRef.current = true;
    programmaticAutoscrollSawScrollRef.current = false;
    rowEl.scrollIntoView({ behavior: lowPerfMode ? 'auto' : 'smooth', block: 'start' });
    const AUTOSCROLL_FALLBACK_MS = 1600;
    programmaticAutoscrollFallbackTimerRef.current = window.setTimeout(() => {
      programmaticAutoscrollFallbackTimerRef.current = null;
      if (programmaticAutoscrollSawScrollRef.current) {
        return;
      }
      if (programmaticAutoscrollSettleTimerRef.current !== null) {
        window.clearTimeout(programmaticAutoscrollSettleTimerRef.current);
        programmaticAutoscrollSettleTimerRef.current = null;
      }
      programmaticAutoscrollRef.current = false;
    }, AUTOSCROLL_FALLBACK_MS);
  }, [lowPerfMode]);
  const primaryActivePos = useMemo(() => {
    if (!polyMode || activePositions.length === 0) return activePos;
    const masters = activePositions.filter((pos) => pos.voice === 0);
    const master =
      masters.length > 0
        ? masters.reduce((a, b) => (a.absR >= b.absR ? a : b))
        : activePositions[0];
    return { r: master.r, c: master.c, absR: master.absR };
  }, [activePos, activePositions, polyMode]);

  /**
   * Автоскролл при воспроизведении.
   * Если freeze даёт ровно **1** видимый такт (`frozenScale === 1`) и тактов в паттерне > 1:
   * листаем через 10 ms после **начала** подсветки последней доли такта (следующая строка в ленте).
   * Иначе — прежняя логика «страниц» по scrollStride и половине такта.
   */
  useEffect(() => {
    let tid: number | null = null;
    const cleanup = () => {
      if (tid !== null) {
        window.clearTimeout(tid);
        tid = null;
      }
    };

    if (!isPlaying) {
      if (wasPlayingAutoscrollRef.current) {
        lastScrolledPageRef.current = -1;
        if (gridRef.current) gridRef.current.scrollTop = 0;
      }
      wasPlayingAutoscrollRef.current = false;
      return cleanup;
    }
    wasPlayingAutoscrollRef.current = true;
    if (autoscrollDisabledByUserRef.current) {
      return cleanup;
    }

    const frozenOneBarViewport =
      frozenScale !== null && Math.min(frozenScale, 10) === 1 && bars > 1;

    if (frozenOneBarViewport) {
      if (primaryActivePos.absR >= 0) {
        const rowSylls =
          customSyllables[primaryActivePos.r] !== undefined ? customSyllables[primaryActivePos.r] : syllables;
        if (rowSylls >= 1 && primaryActivePos.c === rowSylls - 1) {
          tid = window.setTimeout(() => {
            tid = null;
            const nextAbs = primaryActivePos.absR + 1;
            const rowEl = rowRefs.current[nextAbs];
            if (rowEl) {
              performAutoscrollToRow(rowEl);
            }
          }, 10);
        }
      }
      return cleanup;
    }

    if (bars <= displayScaleBars) {
      return cleanup;
    }

    if (primaryActivePos.absR >= 0 && gridRef.current) {
      let logicalPage = Math.floor(primaryActivePos.absR / scrollStride);
      
      if (primaryActivePos.absR > 0 && primaryActivePos.absR % scrollStride === 0) {
        const rIdx = primaryActivePos.absR % bars;
        const rowSylls = customSyllables[rIdx] !== undefined ? customSyllables[rIdx] : syllables;
        const isPastHalfway = primaryActivePos.c >= Math.floor(rowSylls / 2);
        
        if (!isPastHalfway) {
          logicalPage -= 1;
        }
      }

      if (logicalPage !== lastScrolledPageRef.current) {
        const pageStartAbsR = logicalPage * scrollStride;
        const rowEl = rowRefs.current[pageStartAbsR];
        // Не отмечаем страницу «перелистанной», пока нет DOM-строки: иначе при отстающем virtual strip
        // скролл молча пропускается и пагинация залипает навсегда.
        if (rowEl) {
          lastScrolledPageRef.current = logicalPage;
          performAutoscrollToRow(rowEl);
        }
      }
    }

    return cleanup;
  }, [
    primaryActivePos.absR,
    primaryActivePos.c,
    primaryActivePos.r,
    isPlaying,
    scrollStride,
    customSyllables,
    syllables,
    bars,
    displayScaleBars,
    legacyStripVirtualRowCount,
    performAutoscrollToRow,
  ]);

  useEffect(() => {
    const node = gridRef.current;
    if (!node) return;
    const disableAutoscrollByUser = (reason: 'wheel' | 'touchmove' | 'scroll') => {
      if (!isPlayingRef.current) return;
      if (autoscrollDisabledByUserRef.current) return;
      autoscrollDisabledByUserRef.current = true;
      setAutoscrollVirtualRowsEnabled(false);
    };
    const onWheel = () => {
      disableAutoscrollByUser('wheel');
    };
    const onTouchMove = () => {
      disableAutoscrollByUser('touchmove');
    };
    const AUTOSCROLL_SETTLE_MS = 160;
    const onScroll = () => {
      if (!isPlayingRef.current) return;
      if (programmaticAutoscrollRef.current) {
        programmaticAutoscrollSawScrollRef.current = true;
        if (programmaticAutoscrollSettleTimerRef.current !== null) {
          window.clearTimeout(programmaticAutoscrollSettleTimerRef.current);
        }
        programmaticAutoscrollSettleTimerRef.current = window.setTimeout(() => {
          programmaticAutoscrollSettleTimerRef.current = null;
          programmaticAutoscrollRef.current = false;
          if (programmaticAutoscrollFallbackTimerRef.current !== null) {
            window.clearTimeout(programmaticAutoscrollFallbackTimerRef.current);
            programmaticAutoscrollFallbackTimerRef.current = null;
          }
        }, AUTOSCROLL_SETTLE_MS);
        return;
      }
      disableAutoscrollByUser('scroll');
    };
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('scroll', onScroll);
    };
  }, [gridRef]);

  useEffect(() => {
    return () => {
      if (tempoThrottleTimerRef.current !== null) {
        window.clearTimeout(tempoThrottleTimerRef.current);
        tempoThrottleTimerRef.current = null;
      }
      if (tempoHoldTimeoutRef.current !== null) {
        window.clearTimeout(tempoHoldTimeoutRef.current);
        tempoHoldTimeoutRef.current = null;
      }
      if (tempoHoldIntervalRef.current !== null) {
        window.clearInterval(tempoHoldIntervalRef.current);
        tempoHoldIntervalRef.current = null;
      }
      if (timerIDRef.current) clearTimeout(timerIDRef.current);
      if (previewResetTimerRef.current !== null) {
        window.clearTimeout(previewResetTimerRef.current);
        previewResetTimerRef.current = null;
      }
      if (snapshotHoldTimerRef.current !== null) {
        window.clearTimeout(snapshotHoldTimerRef.current);
        snapshotHoldTimerRef.current = null;
      }
      if (squareHoldTimerRef.current !== null) {
        window.clearTimeout(squareHoldTimerRef.current);
        squareHoldTimerRef.current = null;
      }
      if (clickPresetBusTwoBarsPreviewDebounceRef.current !== null) {
        window.clearTimeout(clickPresetBusTwoBarsPreviewDebounceRef.current);
        clickPresetBusTwoBarsPreviewDebounceRef.current = null;
      }
      if (clickPresetBusTwoBarsPreviewRetryTimerRef.current !== null) {
        window.clearTimeout(clickPresetBusTwoBarsPreviewRetryTimerRef.current);
        clickPresetBusTwoBarsPreviewRetryTimerRef.current = null;
      }
      if (clickBusSliderHoldRef.current.timer !== null) {
        window.clearTimeout(clickBusSliderHoldRef.current.timer);
        clickBusSliderHoldRef.current.timer = null;
        clickBusSliderHoldRef.current.moved = false;
        clickBusSliderHoldRef.current.token = null;
      }
      if (randomDiceHoldTimerRef.current !== null) {
        window.clearTimeout(randomDiceHoldTimerRef.current);
        randomDiceHoldTimerRef.current = null;
      }
      if (taHoldTimerRef.current !== null) {
        window.clearTimeout(taHoldTimerRef.current);
        taHoldTimerRef.current = null;
      }
      if (midiHoldTimerRef.current !== null) {
        window.clearTimeout(midiHoldTimerRef.current);
        midiHoldTimerRef.current = null;
      }
      cancelTaHoldFillAnim();
      if (eraserHoldTimerRef.current !== null) {
        window.clearTimeout(eraserHoldTimerRef.current);
        eraserHoldTimerRef.current = null;
      }
      if (randomDiceMintFlashClearRef.current !== null) {
        window.clearTimeout(randomDiceMintFlashClearRef.current);
        randomDiceMintFlashClearRef.current = null;
      }
      syllableReadMuteModeRef.current = 'off';
      setSyllableReadMuteMode('off');
      if (playheadTimerRef.current !== null) {
        window.clearTimeout(playheadTimerRef.current);
        playheadTimerRef.current = null;
      }
      playheadQueueRef.current = [];
      gridPreviewAudioActiveRef.current = false;
      clearPendingGridClickTimers();
      if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
    };
  }, []);

  const flushChaosToActiveSnapshot = () => {
    const slot = activeSnapshotRef.current;
    const chaos = chaosLevelRef.current;
    startTransition(() => {
      setSnapshots((prev) => {
        const cur = prev[slot];
        if (!cur || cur.chaosLevel === chaos) return prev;
        return { ...prev, [slot]: { ...cur, chaosLevel: chaos } };
      });
    });
  };

  const resetAudioTimingMetrics = () => {
    const next = makeAudioTimingMetrics();
    next.enabled = audioTimingMetricsRef.current.enabled;
    audioTimingMetricsRef.current = next;
  };

  const logAudioTimingMetricsIfDue = (nowMs: number) => {
    const metrics = audioTimingMetricsRef.current;
    if (!metrics.enabled) return;
    if (metrics.lastLogAtMs !== 0 && nowMs - metrics.lastLogAtMs < metrics.logEveryMs) return;
    const summarize = (values: number[]) => {
      if (values.length === 0) return { p50Ms: 0, p95Ms: 0, p99Ms: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      return {
        p50Ms: percentile(sorted, 0.5) * 1000,
        p95Ms: percentile(sorted, 0.95) * 1000,
        p99Ms: percentile(sorted, 0.99) * 1000,
      };
    };
    const mono = summarize(metrics.latenessSamples.mono);
    const poly = summarize(metrics.latenessSamples.poly);
    const deferRatio =
      metrics.totalSubHitCount > 0 ? metrics.deferSubHitCount / metrics.totalSubHitCount : 0;
    console.info('[audio-metrics]', {
      profile: schedulerProfileRef.current,
      scheduledEvents: metrics.scheduledEvents,
      lateEvents: metrics.lateEvents,
      droppedEvents: metrics.droppedEvents,
      recoveryCount: metrics.recoveryCount,
      maxLatenessMs: metrics.maxLatenessSec * 1000,
      maxLagMs: metrics.maxLagSec * 1000,
      mono,
      poly,
      deferSubHitCount: metrics.deferSubHitCount,
      totalSubHitCount: metrics.totalSubHitCount,
      deferRatio,
      liveWindowActiveMs: metrics.liveWindowActiveMs,
      modeSwitchCount: metrics.modeSwitchCount,
      flapCount: metrics.flapCount,
      deferCanceledCount: metrics.deferCanceledCount,
      deferRescheduledCount: metrics.deferRescheduledCount,
    });
    metrics.lastLogAtMs = nowMs;
    metrics.latenessSamples.mono = [];
    metrics.latenessSamples.poly = [];
  };

  const recordAudioScheduledEvent = (ctx: AudioContext, scheduledTime: number, domain: TimingDomain) => {
    const metrics = audioTimingMetricsRef.current;
    if (!metrics.enabled) return;
    metrics.scheduledEvents += 1;
    const latenessSec = Math.max(0, ctx.currentTime - scheduledTime);
    if (latenessSec > 0) {
      metrics.lateEvents += 1;
      if (latenessSec > metrics.maxLatenessSec) metrics.maxLatenessSec = latenessSec;
      metrics.latenessSamples[domain].push(latenessSec);
    }
  };

  const recordAudioDroppedEvent = () => {
    const metrics = audioTimingMetricsRef.current;
    if (!metrics.enabled) return;
    metrics.droppedEvents += 1;
  };

  const recordSchedulerRecovery = (lagSec: number) => {
    const metrics = audioTimingMetricsRef.current;
    if (!metrics.enabled) return;
    metrics.recoveryCount += 1;
    if (lagSec > metrics.maxLagSec) metrics.maxLagSec = lagSec;
  };

  const clearPlayheadScheduling = () => {
    if (playheadTimerRef.current !== null) {
      window.clearTimeout(playheadTimerRef.current);
      playheadTimerRef.current = null;
    }
    playheadQueueRef.current = [];
    polySubLegacyLaneIndicatorStoreRef.current.clear();
  };

  function schedulePlayheadWake() {
    if (playheadTimerRef.current !== null) {
      window.clearTimeout(playheadTimerRef.current);
      playheadTimerRef.current = null;
    }
    if (!isPlayingRef.current || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const q = playheadQueueRef.current;
    let lastPos: PlayheadPosition | null = null;
    const laneIndicatorStore = polySubLegacyLaneIndicatorStoreRef.current;
    while (q.length > 0 && q[0].t <= ctx.currentTime) {
      const due = q.shift()!.pos;
      if (polyModeRef.current) {
        laneIndicatorStore.recordLaneEmit(due);
      }
      lastPos = due;
    }
    if (polyModeRef.current) {
      const nextActive = laneIndicatorStore.orderedSnapshot();
      if (nextActive.length > 0) {
        setActivePositions(nextActive);
        const masters = nextActive.filter((pos) => pos.voice === 0);
        const primary =
          masters.length > 0
            ? masters.reduce((a, b) => (a.absR >= b.absR ? a : b))
            : nextActive[0];
        setActivePos({ r: primary.r, c: primary.c, absR: primary.absR });
      }
    } else if (lastPos !== null) {
      setActivePos({ r: lastPos.r, c: lastPos.c, absR: lastPos.absR });
      setActivePositions([]);
    }
    if (q.length === 0) return;
    const delayMs = Math.max(0, (q[0].t - ctx.currentTime) * 1000);
    playheadTimerRef.current = window.setTimeout(() => {
      playheadTimerRef.current = null;
      schedulePlayheadWake();
    }, delayMs);
  }

  const toggleAccent = useCallback((r: number, c: number) => {
    if (isStartBarPickModeRef.current) return;
    // USER-SOURCE-OF-TRUTH: accent map is defined only by explicit user taps on grid cells.
    if (c === 0) setAccentMapVersion(1);
    const key = `${r}-${c}`;
    if (polyModeRef.current) {
      const lane = laneForRow(r, polyVoicesRef.current);
      setAccentsByLane((prev) => {
        const next = cloneLaneSetMap(prev);
        const laneSet = next[lane];
        if (laneSet.has(key)) laneSet.delete(key);
        else laneSet.add(key);
        const flat = flattenLaneSetMap(next, barsRef.current, polyVoicesRef.current);
        accentsRef.current = flat;
        setAccents(flat);
        accentsByLaneRef.current = cloneLaneSetMap(next);
        return next;
      });
      return;
    }
    setAccents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // FRAGILE — Ta editor + poly lanes + firstBeatDingSuppressedRows; easy to break white rim vs audio.
  // IMPORTANT ACCENT CONTRACT (DO NOT BREAK):
  // 1) White Ta frame and purple square accent are different maps/roles.
  //    - taDing (white) is NOT the same as accent (purple).
  // 2) Default first-beat Ta on col0 is stateful (firstBeatAccent*), not an explicit taDing key.
  // 3) In Ta editor, tapping col0 while default is ON toggles suppression for that row only.
  //    It must NOT create an explicit taDing key on col0.
  // 4) If default is OFF, col0 behaves like a regular explicit taDing cell.
  // 5) Audio mapping must stay: Ta(white) -> accent bus, Square(purple) -> alt bus, plain -> passive.
  const toggleTaDing = useCallback((r: number, c: number) => {
    if (isStartBarPickModeRef.current) return;
    if (c < 0) return;
    const key = `${r}-${c}`;
    if (polyModeRef.current) {
      const lane = laneForRow(r, polyVoicesRef.current);
      if (isTaEditorModeRef.current && c === 0) {
        setTaDingKeysByLane((prev) => {
          const next = cloneLaneSetMap(prev);
          const laneSet = next[lane];
          const hadKey = laneSet.has(key);
          const suppressed = firstBeatDingSuppressedRowsRef.current.has(r);
          const fa = Boolean(firstBeatAccentByLaneRef.current[lane]);
          let action: 'toggle_suppression_on' | 'toggle_suppression_off' | 'explicit_add' | 'explicit_remove' = 'explicit_add';

          if (fa) {
            // Default first-beat Ta is ON: tap on col0 toggles only suppression.
            // Explicit col0 key must stay cleared to avoid mixed semantics.
            laneSet.delete(key);
            if (suppressed) {
              action = 'toggle_suppression_off';
              setFirstBeatDingSuppressedRows((prevRows) => {
                const n = new Set(prevRows);
                n.delete(r);
                return n;
              });
            } else {
              action = 'toggle_suppression_on';
              setFirstBeatDingSuppressedRows((prevRows) => new Set(prevRows).add(r));
            }
          } else {
            // Default first-beat Ta is OFF: col0 behaves like a regular explicit Ta cell.
            if (hadKey) {
              action = 'explicit_remove';
              laneSet.delete(key);
            } else {
              action = 'explicit_add';
              laneSet.add(key);
            }
          }
          const flat = flattenLaneSetMap(next, barsRef.current, polyVoicesRef.current);
          taDingKeysRef.current = flat;
          setTaDingKeys(flat);
          taDingKeysByLaneRef.current = cloneLaneSetMap(next);
          return next;
        });
        return;
      }
      setTaDingKeysByLane((prev) => {
        const next = cloneLaneSetMap(prev);
        const laneSet = next[lane];
        if (laneSet.has(key)) laneSet.delete(key);
        else laneSet.add(key);
        const flat = flattenLaneSetMap(next, barsRef.current, polyVoicesRef.current);
        taDingKeysRef.current = flat;
        setTaDingKeys(flat);
        taDingKeysByLaneRef.current = cloneLaneSetMap(next);
        return next;
      });
      return;
    }
    if (!isTaEditorModeRef.current || c !== 0) {
      setTaDingKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }
    const hadKey = taDingKeysRef.current.has(key);
    const suppressed = firstBeatDingSuppressedRowsRef.current.has(r);
    const fa = Boolean(
      firstBeatAccentRef.current ||
      firstBeatAccentByLaneRef.current[0] ||
      firstBeatAccentByLaneRef.current[1] ||
      firstBeatAccentByLaneRef.current[2]
    );
    if (fa) {
      // Default first-beat Ta is ON: tap on col0 toggles suppression only.
      setTaDingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      if (suppressed) {
        setFirstBeatDingSuppressedRows((prev) => {
          const n = new Set(prev);
          n.delete(r);
          return n;
        });
      } else {
        setFirstBeatDingSuppressedRows((prev) => new Set(prev).add(r));
      }
      return;
    }
    // Default first-beat Ta is OFF: col0 behaves like regular explicit Ta cell.
    setTaDingKeys((prev) => {
      const next = new Set(prev);
      if (hadKey) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const triggerDeadCut = useCallback((barIndex: number, startCell: number) => {
    const baseNow = customSyllablesRef.current[barIndex] !== undefined
      ? customSyllablesRef.current[barIndex]
      : syllablesRef.current;
    const activeCount = Math.max(0, Math.min(baseNow, startCell));
    const prevDead = deadCellsRef.current[barIndex];
    const displayLen = prevDead?.displayLen ?? baseNow;
    const baseLen = prevDead?.baseLen ?? baseNow;
    setDeadCells((prev) => {
      const next = {
        ...prev,
        [barIndex]: { deadStart: activeCount, displayLen, baseLen },
      };
      deadCellsRef.current = { ...next };
      return next;
    });
  }, []);

  const restoreDeadRow = useCallback((barIndex: number) => {
    const meta = deadCellsRef.current[barIndex];
    if (!meta) return;
    setDeadCells((prev) => {
      if (prev[barIndex] === undefined) return prev;
      const next = { ...prev };
      delete next[barIndex];
      deadCellsRef.current = { ...next };
      return next;
    });
  }, []);

  const nextNote = () => {
    try {
      const seq = sequenceRef.current;
      if (seq.length === 0) {
        nextNoteTimeRef.current += 0.5;
        return;
      }
      
      // Boundary safety net
      if (currentStepRef.current >= seq.length || currentStepRef.current < 0) {
        currentStepRef.current = 0;
      }

      let currentSeqItem = seq[currentStepRef.current];

      // Randomizer Orchestration at bar boundary
      if (currentSeqItem && currentSeqItem.c === 0 && isPlayingRef.current) {
        if (coldStartRef.current) {
          coldStartRef.current = false;
        } else if (
          // Parent-mode: live-дорандомизация на bar-boundary отключена.
          // В parent работаем через единичный prefill по кнопке random.
          randomModeEnabledRef.current && randomModeRef.current !== 'parent'
        ) {
          const targetR = currentSeqItem.r;
          const prevBar = (targetR - 1 + barsRef.current) % barsRef.current;

          const chaos = chaosLevelRef.current;
          const m = {
            customSyllables: customSyllablesRef.current,
            accents: accentsRef.current,
            customSubdivisions: customSubdivisionsRef.current,
            customCellSyllables: customCellSyllablesRef.current,
            customMultipliers: customMultipliersRef.current,
            deadCells: deadCellsRef.current,
          };
          const barSeed = (Math.random() * 0xffffffff) >>> 0;
          lastBarSeedRef.current[prevBar] = barSeed;
          const rng = mulberry32(barSeed);
          const useParent =
            randomModeRef.current === 'parent' && parentGenomeRef.current !== null;
          const didChange = useParent
            ? applyParentModeBar({
                barIdx: prevBar,
                parent: parentGenomeRef.current!,
                schedule: phraseScheduleRef.current,
                chaos,
                syllablesDefault: syllablesRef.current,
                m,
                rng,
                freeAxes: {
                  randomPulsation: randomPulsationRef.current,
                  randomPattern: randomPatternRef.current,
                  randomSpeed: randomSpeedRef.current,
                  randomBarSpeed: randomBarSpeedRef.current,
                  forceFirstBeat: dictantModeRef.current || chaos < 80,
                },
              })
            : applyRandomizerEffectsToBar(
                prevBar,
                chaos,
                randomPulsationRef.current,
                randomPatternRef.current,
                randomSpeedRef.current,
                randomBarSpeedRef.current,
                false,
                syllablesRef.current,
                m,
                rng,
                dictantModeRef.current || chaos < 80,
              );

          if (didChange) {
            sequenceRef.current = buildLegacyPlaybackSequence(
              barsRef.current,
              customSyllablesRef.current,
              syllablesRef.current,
              deadCellsRef.current,
              customCellSyllablesRef.current,
              customSubdivisionsRef.current,
              cellStepMasksRef.current,
            );
            
            const targetStepIndex = sequenceRef.current.findIndex(item => item.r === targetR && item.c === 0);
            if (targetStepIndex !== -1) {
              currentStepRef.current = targetStepIndex;
            } else {
              currentStepRef.current = 0;
            }
            
            currentSeqItem = sequenceRef.current[currentStepRef.current];

            setTimeout(() => {
              startTransition(() => {
                if (useParent) {
                  // Parent-mode мутирует любые оси — обновляем все state-сетки разом.
                  setCustomSyllables({ ...customSyllablesRef.current });
                  setAccents(new Set(accentsRef.current));
                  setCustomSubdivisions({ ...customSubdivisionsRef.current });
                  setCustomCellSyllables({ ...customCellSyllablesRef.current });
                  setDeadCells({ ...deadCellsRef.current });
                } else {
                  if (randomPulsationRef.current) setCustomSyllables({ ...customSyllablesRef.current });
                  if (randomPatternRef.current) setAccents(new Set(accentsRef.current));
                  if (randomSpeedRef.current) setCustomSubdivisions({ ...customSubdivisionsRef.current });
                  if (randomBarSpeedRef.current) setDeadCells({ ...deadCellsRef.current });
                }
              });
            }, 0);
          }
          // Chaos auto-ramp: один тик на границу такта (только при включённом рандомайзере).
          advanceChaosRampOneStep();
        }
      }

      if (!currentSeqItem) {
        nextNoteTimeRef.current += 0.5;
        return; 
      }

      const rowR = currentSeqItem.r;
      // Dead-cells не должны менять внутренний множитель темпа: считаем его от базовой пульсации такта.
      const effectiveSyllables =
        customSyllablesRef.current[rowR] !== undefined
          ? customSyllablesRef.current[rowR]
          : syllablesRef.current;
      const pulseSyllables = pulseMeterUnlinkedRef.current[rowR]
        ? PULSE_METER_BASE_SYLLABLES
        : effectiveSyllables;
      const mult = customMultipliersRef.current[rowR] || 1;
      
      const effectiveBpm = tempoRef.current * (pulseSyllables / 4) * mult;
      if (effectiveBpm > 0) {
        nextNoteTimeRef.current += 60.0 / effectiveBpm;
      } else {
        nextNoteTimeRef.current += 0.5;
      }
      
      const oldR = currentSeqItem.r;
      currentStepRef.current = (currentStepRef.current + 1) % Math.max(1, sequenceRef.current.length);
      const nextSeqItem = sequenceRef.current[currentStepRef.current];
      
      if (nextSeqItem) {
          const newR = nextSeqItem.r;
          if (newR !== oldR) {
              const dsb =
                frozenScaleRef.current !== null
                  ? Math.min(frozenScaleRef.current, 10)
                  : Math.min(barsRef.current, 10);
              const compact = barsRef.current <= dsb;
              if (compact) {
                /* Loop on same screen: playhead row index stays 0..bars-1. */
                playAbsBarRef.current = newR;
              } else if (newR === 0 && oldR === barsRef.current - 1) {
                  playAbsBarRef.current += 1;
              } else if (newR > oldR) {
                playAbsBarRef.current += newR - oldR;
              } else {
                  playAbsBarRef.current = newR;
              }
          }
      }
    } catch (e) {
      console.error("Critical error in nextNote:", e);
      // Emergency fallback to prevent the browser from freezing in an infinite while loop!
      nextNoteTimeRef.current += 0.5; 
      currentStepRef.current = 0; // Wrap around safely
    }
  };

  const getLegacyNoteDurationSeconds = useCallback((rowIdx: number) => {
    const rowSyllables = customSyllablesRef.current[rowIdx] !== undefined ? customSyllablesRef.current[rowIdx] : syllablesRef.current;
    const pulseSyllables = pulseMeterUnlinkedRef.current[rowIdx] ? PULSE_METER_BASE_SYLLABLES : rowSyllables;
    const mult = customMultipliersRef.current[rowIdx] || 1;
    const effectiveBpm = tempoRef.current * (pulseSyllables / 4) * mult;
    if (effectiveBpm <= 0) return 0.5;
    return 60.0 / effectiveBpm;
  }, []);

  const getBarTimeWindowSeconds = useCallback((rowIdx: number) => {
    const noteDuration = getLegacyNoteDurationSeconds(rowIdx);
    const rowSyllables =
      customSyllablesRef.current[rowIdx] !== undefined ? customSyllablesRef.current[rowIdx] : syllablesRef.current;
    return noteDuration * Math.max(1, rowSyllables);
  }, [getLegacyNoteDurationSeconds]);

  const scheduleGridCellAtTime = useCallback(
    (
      rIdx: number,
      cIdx: number,
      absR: number,
      time: number,
      voice: number,
      step: number,
      noteDuration: number,
      forcedSoundPreset?: ClickSoundPreset,
    ) => {
      if (!audioCtxRef.current) return;
      const subdivs = customSubdivisionsRef.current[`${rIdx}-${cIdx}`] || 1;
      const stepMask = resolveEffectiveStepMask(`${rIdx}-${cIdx}`, subdivs, cellStepMasksRef.current);
      const subDuration = Math.max(0.001, noteDuration / Math.max(1, subdivs));
      const taStableRoutingActive = debugTaEngineModeRef.current;
      const laneTaDingEarly = getLaneTaSetRef(rIdx);
      const laneFirstBeatEarly = getLaneFirstBeatRef(rIdx);
      const on0AccentEarly = getLaneAccentsSetRef(rIdx).has(`${rIdx}-0`);
      const on0DingEarly = laneTaDingEarly.has(`${rIdx}-0`);
      const firstBeatHitRowEarly = resolveFirstBeatHitRow(
        resolveRuntimeFirstBeatPolicy(polyModeRef.current, laneForRow(rIdx, polyVoicesRef.current)),
        on0AccentEarly,
        on0DingEarly,
        laneFirstBeatEarly,
        firstBeatDingSuppressedRowsRef.current.has(rIdx),
      );
      const taCellScheduled =
        (cIdx === 0 && laneFirstBeatEarly && firstBeatHitRowEarly) ||
        (laneFirstBeatEarly && cIdx >= 1 && laneTaDingEarly.has(`${rIdx}-${cIdx}`));
      const forceStableForTaCell = taStableRoutingActive && taCellScheduled;

      const isPauseSyllableToken = (raw: unknown): boolean => {
        if (typeof raw !== 'string') return false;
        const s = raw.trim().toLowerCase();
        return s === '-' || s === '–' || s === '—' || s === '.';
      };
      const emitGridSubAudio = (sub: number, subTime: number) => {
        const ctx = audioCtxRef.current;
        if (!ctx) return;
        if (!isPlayingRef.current && !gridPreviewAudioActiveRef.current) return;
        const isClickSelectorPreview = gridPreviewAudioActiveRef.current && !isPlayingRef.current;
        const tooLateBy = ctx.currentTime - subTime;
        if (tooLateBy > schedulerConfigRef.current.maxCatchUpLagSec) {
          recordAudioDroppedEvent();
          return;
        }
        recordAudioScheduledEvent(ctx, subTime, polyModeRef.current ? 'poly' : 'mono');
        const soundPreset =
          forcedSoundPreset ??
          resolveClickSoundForPolyVoice(
            voice,
            polyModeRef.current,
            clickSoundByPolyVoiceRef.current,
            clickSoundRef.current,
          );
        const cellSylOv = customCellSyllablesRef.current[`${rIdx}-${cIdx}`];
        const cellHasExplicitPlayableToken =
          typeof cellSylOv === 'string' &&
          cellSylOv.trim().length > 0 &&
          !isPauseSyllableToken(cellSylOv);
        const deadCut = deadCellsRef.current[rIdx]?.deadStart;
        if (typeof deadCut === 'number' && cIdx >= deadCut && !cellHasExplicitPlayableToken) return;
        // USER-SOURCE-OF-TRUTH: no auto-accent/auto-alt by beat index; only lane/user maps drive voice choice.
        const laneAccents = getLaneAccentsSetRef(rIdx);
        const laneTaDing = getLaneTaSetRef(rIdx);
        const laneFirstBeat = getLaneFirstBeatRef(rIdx);
        const isAccent = laneAccents.has(`${rIdx}-${cIdx}`);
        const muteMode: SyllableReadMuteMode = isClickSelectorPreview ? 'off' : syllableReadMuteModeRef.current;
        const on0Accent = laneAccents.has(`${rIdx}-0`);
        const on0Ding = laneTaDing.has(`${rIdx}-0`);
        const supRow = firstBeatDingSuppressedRowsRef.current.has(rIdx);
        const fa = laneFirstBeat;
        const laneId = laneForRow(rIdx, polyVoicesRef.current);
        const firstBeatHitPolicy: FirstBeatHitPolicy = resolveRuntimeFirstBeatPolicy(
          polyModeRef.current,
          laneId,
        );
        const polyVoiceGain = polyModeRef.current
          ? Math.max(0, Math.min(1.6, polyVoiceGainsRef.current[voice as 0 | 1 | 2] ?? 1))
          : Math.max(0, Math.min(1.6, polyVoiceGainsRef.current[0] ?? 1));
        const busG = getClickPresetBusGainsForVoicePreset(
          clickPresetBusGainsByVoiceRef.current,
          clickPresetBusGainsRef.current,
          voice,
          soundPreset,
        );
        const gainMulForRole = (role: 'accent' | 'base' | 'alt'): number => {
          const roleLinear = role === 'accent' ? busG.accent : role === 'alt' ? busG.alt : busG.passive;
          return polyVoiceGain * roleLinear;
        };
        const accentGain = gainMulForRole('accent');
        const firstBeatCellHitRow = resolveFirstBeatHitRow(
          firstBeatHitPolicy,
          on0Accent,
          on0Ding,
          fa,
          supRow,
        );
        const polySlotKey = polyModeRef.current
          ? voice * 1_000_000_000_000 + rIdx * 1_000_000_000 + Math.round(subTime * 1_000_000)
          : -1;
        const shouldDedupPolyClick = polyModeRef.current && polyClickSlotsRef.current.has(polySlotKey);
        const isFirstBarCell = cIdx === 0;
        // Accent articulation stays on the first subdivision only.
        // Subdivision tails are carried by role routing (alt/passive) for layer texture.
        const mainAccentClick = isAccent && sub === 0;
        const shouldPlayFirstBeatTa =
          isFirstBarCell && fa && firstBeatCellHitRow && sub === 0;
        if (shouldPlayFirstBeatTa && !debugTaEngineModeRef.current && accentGain > 0) {
          playBarFirstHighClick(
            ctx,
            subTime,
            soundPreset,
            accentGain,
          );
          if (polyModeRef.current) {
            polyClickSlotsRef.current.add(polySlotKey);
          }
        }
        // Vocal karvai is silence in syllable layer, but physical Sam click must survive on c=0.
        if (isPauseSyllableToken(cellSylOv) && !shouldPlayFirstBeatTa) return;
        if (shouldDedupPolyClick) {
          return;
        }
        const mixerMode: MixerLayerMode = isClickSelectorPreview ? 'full_mix' : mixerLayerModeRef.current;
        const trainerMode: TrainerMode = isClickSelectorPreview ? 'normal' : trainerModeRef.current;
        const trainerMuted = isClickSelectorPreview ? false : trainerHoldMuteRef.current;
        const taEnabled = laneFirstBeat;
        const isTaDingCell = taEnabled && cIdx >= 1 && laneTaDing.has(`${rIdx}-${cIdx}`);
        /** Accent articulation should stay single-hit even on subdivided cells. */
        const shouldPlayTaDingSound = isTaDingCell && sub === 0;
        const hasTaDingHere = taEnabled && laneTaDing.has(`${rIdx}-${cIdx}`);
        const dictantActive = trainerMode === 'dictation';
        const trainerTaOnly = trainerMode === 'ta_only';
        const shouldPlayBeat =
          trainerTaOnly ? hasTaDingHere || shouldPlayFirstBeatTa : true;
        const isTaFirstBeatArticulation =
          cIdx === 0 && fa && firstBeatCellHitRow && (subdivs > 1 || sub === 0);
        const sharpAsChecked = (() => {
          if (dictantActive) return mainAccentClick;
          if (muteMode === 'no_accent_sharp' && mainAccentClick && !isTaFirstBeatArticulation) return false;
          return mainAccentClick;
        })();
        if (shouldPlayTaDingSound && !debugTaEngineModeRef.current && accentGain > 0) {
          playBarFirstHighClick(
            ctx,
            subTime,
            soundPreset,
            accentGain,
          );
          if (polyModeRef.current) {
            polyClickSlotsRef.current.add(polySlotKey);
          }
        }
        if (trainerMuted || muteMode === 'full') return;
        if (!shouldPlayBeat) return;
        if (shouldPlayTaDingSound && !sharpAsChecked && trainerTaOnly) {
          return;
        }
        if (shouldPlayFirstBeatTa && !sharpAsChecked && trainerTaOnly) {
          return;
        }
        const accentOnlyPlayback =
          (trainerTaOnly || dictantActive) &&
          !(shouldPlayTaDingSound && isAccent) &&
          !(shouldPlayFirstBeatTa && isAccent);
        // USER-SOURCE-OF-TRUTH:
        // - white frame (Ta) drives ACCENT bus
        // - purple fill (square accent) → ALT bus, кроме серого (passive_no_alt): пассив
        // - plain cell drives PASSIVE bus
        const hasUserWhiteAccent =
          shouldPlayFirstBeatTa || shouldPlayTaDingSound || hasTaDingHere;
        const hasUserPurpleAltAccent = isAccent;
        const taStableSampleMode = debugTaEngineModeRef.current && hasUserWhiteAccent;
        if (taStableSampleMode) {
          if (accentGain <= 0) return;
          playBarFirstHighClick(ctx, subTime, soundPreset, accentGain);
          if (polyModeRef.current) {
            polyClickSlotsRef.current.add(polySlotKey);
          }
          return;
        }
        // Mixer button controls only base/alt buses; Ta/first-beat accent bus stays independent.
        const mixerAllowsBase = mixerMode === 'full_mix' || mixerMode === 'no_alt';
        const mixerAllowsAlt = mixerMode === 'full_mix' || mixerMode === 'alt_only';
        // Stable-style single-role routing per sub-hit.
        // In no_alt, purple-marked cells intentionally fall back to base(passive) timbre.
        const hasExplicitDualAccentAlt = hasUserWhiteAccent && hasUserPurpleAltAccent && mixerAllowsAlt;
        if (hasExplicitDualAccentAlt) {
          const altGain = gainMulForRole('alt');
          if (mainAccentClick && accentGain > 0) {
            playSharpClick(
              ctx,
              subTime,
              sharpAsChecked,
              soundPreset,
              accentOnlyPlayback,
              'accent',
              accentGain,
            );
          }
          if (altGain > 0) {
            playSharpClick(
              ctx,
              subTime,
              false,
              soundPreset,
              accentOnlyPlayback,
              'alt',
              altGain,
            );
          }
          if (polyModeRef.current) {
            polyClickSlotsRef.current.add(polySlotKey);
          }
          return;
        }
        const voiceRole: 'accent' | 'base' | 'alt' | null =
          hasUserWhiteAccent
            ? 'accent'
            : hasUserPurpleAltAccent
              ? (mixerAllowsAlt ? 'alt' : mixerAllowsBase ? 'base' : null)
              : (mixerAllowsBase ? 'base' : null);
        if (voiceRole === null) {
          if (polyModeRef.current) {
            polyClickSlotsRef.current.add(polySlotKey);
          }
          return;
        }
        if (voiceRole === 'accent' && (!mainAccentClick || accentGain <= 0)) {
          if (polyModeRef.current) {
            polyClickSlotsRef.current.add(polySlotKey);
          }
          return;
        }
        const voiceGain = gainMulForRole(voiceRole);
        if (voiceGain > 0) {
          playSharpClick(
            ctx,
            subTime,
            sharpAsChecked,
            soundPreset,
            accentOnlyPlayback,
            voiceRole,
            voiceGain,
          );
        }
        // USER-SOURCE-OF-TRUTH:
        // Alt bus sounds only on explicit alt request, plus explicit overlap dual-mix branch above.
        if (polyModeRef.current) {
          polyClickSlotsRef.current.add(polySlotKey);
        }
      };

      const resolveHybridMode = (ctx: AudioContext, subTime: number): 'stable' | 'live' => {
        const nowPerf = performance.now();
        const deltaMs = (subTime - ctx.currentTime) * 1000;
        if (!Number.isFinite(deltaMs) || !Number.isFinite(subDuration) || subDuration <= 0) {
          registerModeSwitch('stable', nowPerf);
          settleDeferredQueueForStable();
          return 'stable';
        }
        const nearHitMs = Math.max(
          HYBRID_NEAR_HIT_MIN_MS,
          Math.min(HYBRID_NEAR_HIT_MAX_MS, 0.35 * subDuration * 1000),
        );
        const liveWindowActive = liveControlActiveRef.current || nowPerf < liveControlUntilRef.current;
        const wantsLive = liveWindowActive && deltaMs > 0 && deltaMs <= nearHitMs;
        const lockUntil = hybridModeLockUntilRef.current;
        if (hybridModeRef.current === 'live' && !wantsLive && nowPerf < lockUntil) {
          audioTimingMetricsRef.current.flapCount += 1;
          return 'live';
        }
        if (hybridModeRef.current === 'stable' && wantsLive && nowPerf < lockUntil) {
          audioTimingMetricsRef.current.flapCount += 1;
          return 'stable';
        }
        if (wantsLive) {
          registerModeSwitch('live', nowPerf);
          return 'live';
        }
        registerModeSwitch('stable', nowPerf);
        settleDeferredQueueForStable();
        return 'stable';
      };

      for (let sub = 0; sub < subdivs; sub++) {
        if (stepMask[sub] === false) continue;
        audioTimingMetricsRef.current.totalSubHitCount += 1;
        const subTime = time + sub * subDuration;
        const ctx = audioCtxRef.current;
        if (!ctx) continue;
        latestSubStepSecRef.current = subDuration;
        const mode: 'stable' | 'live' = forceStableForTaCell ? 'stable' : resolveHybridMode(ctx, subTime);
        if (mode === 'live') {
          audioTimingMetricsRef.current.deferSubHitCount += 1;
          const delayMs = Math.max(0, (subTime - ctx.currentTime - schedulerConfigRef.current.safetyLeadSec) * 1000);
          const subI = sub;
          const subTimeI = subTime;
          const timer = window.setTimeout(() => {
            pendingGridClickDeferredRef.current = pendingGridClickDeferredRef.current.filter((p) => p.id !== timer);
            emitGridSubAudio(subI, subTimeI);
          }, delayMs);
          pendingGridClickDeferredRef.current.push({
            id: timer,
            targetTime: subTimeI,
            fire: () => emitGridSubAudio(subI, subTimeI),
          });
        } else {
          emitGridSubAudio(sub, subTime);
        }
      }
      if (!dictantModeRef.current || cIdx === 0) {
        insertPlayheadSorted(playheadQueueRef.current, {
          t: time,
          pos: { r: rIdx, c: cIdx, absR, voice, step },
        });
        schedulePlayheadWake();
      }
    },
    [],
  );

  /**
   * Poly sub_legacy: рандомайзер вызывается на каждой границе такта каждой линии (N голосов → N независимых
   * рандомизаторов). Такты партиционированы по `barIdx % V === laneId`, поэтому каждый bar принадлежит
   * ровно одной линии — мутации refs по bar изолированы между линиями.
   * `coldStart` здесь не нужен: колбек срабатывает только после того, как такт уже был полностью отыгран.
   */
  const polyHandleLaneBarBoundary = useCallback((prevBar: number, _laneId: number, _wrappedPattern: boolean) => {
    if (!isPlayingRef.current) return;
    if (!randomModeEnabledRef.current) return;
    // Parent-mode в poly пока не поддерживается (см. план §11, риск poly-голосов).
    // В этом режиме границы такта в poly остаются без рандомизации.
    if (randomModeRef.current === 'parent') return;
    // Chaos auto-ramp: тик только от lane 0 → один инкремент на такт primary-голоса.
    if (_laneId === 0) advanceChaosRampOneStep();
    const chaos = chaosLevelRef.current;
    const m = {
      customSyllables: customSyllablesRef.current,
      accents: accentsRef.current,
      customSubdivisions: customSubdivisionsRef.current,
      customCellSyllables: customCellSyllablesRef.current,
      customMultipliers: customMultipliersRef.current,
      deadCells: deadCellsRef.current,
    };
    const barSeed = (Math.random() * 0xffffffff) >>> 0;
    lastBarSeedRef.current[prevBar] = barSeed;
    const didChange = applyRandomizerEffectsToBar(
      prevBar,
      chaos,
      randomPulsationRef.current,
      randomPatternRef.current,
      randomSpeedRef.current,
      randomBarSpeedRef.current,
      false,
      syllablesRef.current,
      m,
      mulberry32(barSeed),
      dictantModeRef.current || chaos < 80,
    );
    if (!didChange) return;
    setTimeout(() => {
      startTransition(() => {
        if (randomPulsationRef.current) setCustomSyllables({ ...customSyllablesRef.current });
        if (randomPatternRef.current) setAccents(new Set(accentsRef.current));
        if (randomSpeedRef.current) setCustomSubdivisions({ ...customSubdivisionsRef.current });
        if (randomBarSpeedRef.current) setDeadCells({ ...deadCellsRef.current });
      });
    }, 0);
  }, [advanceChaosRampOneStep]);

  const getPolySubLegacyScheduler = useCallback((): PolySubLegacyScheduler => {
    if (!polySubLegacyRef.current) {
      polySubLegacyRef.current = createPolySubLegacyScheduler({
        polyVoices: () => (polyVoicesRef.current === 3 ? 3 : 2),
        barCount: () => barsRef.current,
        getBarTimeWindowSeconds,
        getRowSyllables: (barIdx) =>
          customSyllablesRef.current[barIdx] !== undefined
            ? customSyllablesRef.current[barIdx]!
            : syllablesRef.current,
        getDeadStart: (barIdx) => deadCellsRef.current[barIdx]?.deadStart,
        emit: (bar, c, absR, t, voice, step, dBar) => {
          if (voice === 0) {
            playAbsBarRef.current = bar;
          }
          scheduleGridCellAtTime(bar, c, absR, t, voice, step, dBar);
        },
        onLaneBarBoundary: polyHandleLaneBarBoundary,
      });
    }
    return polySubLegacyRef.current;
  }, [getBarTimeWindowSeconds, polyHandleLaneBarBoundary, scheduleGridCellAtTime]);

  const playTwoBarsPreviewFromGrid = useCallback((soundPreset: ClickSoundPreset) => {
    if (isPlayingRef.current || isTaEditorModeRef.current || isDeadCellsEditorModeRef.current) return;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (previewResetTimerRef.current !== null) {
      window.clearTimeout(previewResetTimerRef.current);
      previewResetTimerRef.current = null;
    }
    gridPreviewAudioActiveRef.current = false;
    clearPendingGridClickTimers();
    polyClickSlotsRef.current.clear();
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    audioCtxRef.current = new AudioContextClass();
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    if (!audioCtxRef.current) return;
    gridPreviewAudioActiveRef.current = true;
    {
      const ctxBoot = audioCtxRef.current;
      const gBoot = clickMixerGroupRef.current;
      if (soundPreset === 'hi_hat') {
        void ensureTaHiHatBuffer(ctxBoot);
      }
      if (gBoot) {
        for (const v of ['accent', 'alt', 'passive'] as const) {
          getVoiceLayerSumInput(ctxBoot, v);
          applyVoiceGroupChain(ctxBoot, v, gBoot[v].groupHpHz, gBoot[v].groupLpHz, gBoot[v].groupMasterLinear);
        }
      }
    }
    clearPlayheadScheduling();
    setActivePos({ r: -1, c: -1, absR: -1 });
    setActivePositions([]);
    polyClickSlotsRef.current.clear();
    cloneClickMixerFromLibrary(soundPreset);
    const barsCount = Math.max(1, barsRef.current);
    let cursor = audioCtxRef.current.currentTime + schedulerConfigRef.current.scheduleAheadSec;
    for (let i = 0; i < 2; i++) {
      const rowIdx = i % barsCount;
      const rowSyllables =
        customSyllablesRef.current[rowIdx] !== undefined
          ? customSyllablesRef.current[rowIdx]
          : syllablesRef.current;
      const noteDuration = getLegacyNoteDurationSeconds(rowIdx);
      for (let cIdx = 0; cIdx < rowSyllables; cIdx++) {
        const noteTime = cursor + cIdx * noteDuration;
        scheduleGridCellAtTime(rowIdx, cIdx, rowIdx, noteTime, 0, cIdx, noteDuration, soundPreset);
      }
      cursor += noteDuration * Math.max(1, rowSyllables);
    }
    const resetDelayMs = Math.max(120, (cursor - audioCtxRef.current.currentTime) * 1000 + 80);
    previewResetTimerRef.current = window.setTimeout(() => {
      previewResetTimerRef.current = null;
      gridPreviewAudioActiveRef.current = false;
      clearPendingGridClickTimers();
      clearPlayheadScheduling();
      setActivePos({ r: -1, c: -1, absR: -1 });
      setActivePositions([]);
    }, resetDelayMs);
  }, [clearPlayheadScheduling, getLegacyNoteDurationSeconds, scheduleGridCellAtTime]);

  /** After bus 1/2/3 moves: same two-bar grid preview as preset selection (debounced). If preview is already running, restart immediately to reflect slider movement live. */
  const scheduleClickPresetBusTwoBarsPreview = useCallback(() => {
    if (isTaEditorModeRef.current || isDeadCellsEditorModeRef.current) return;
    if (clickPresetBusTwoBarsPreviewRetryTimerRef.current !== null) {
      window.clearTimeout(clickPresetBusTwoBarsPreviewRetryTimerRef.current);
      clickPresetBusTwoBarsPreviewRetryTimerRef.current = null;
    }
    if (clickPresetBusTwoBarsPreviewDebounceRef.current !== null) {
      window.clearTimeout(clickPresetBusTwoBarsPreviewDebounceRef.current);
      clickPresetBusTwoBarsPreviewDebounceRef.current = null;
    }
    clickPresetBusTwoBarsPreviewDebounceRef.current = window.setTimeout(() => {
      clickPresetBusTwoBarsPreviewDebounceRef.current = null;
      const preset = polyModeRef.current
        ? resolveClickSoundForPolyVoice(
            activeClickVoiceTargetRef.current,
            true,
            clickSoundByPolyVoiceRef.current,
            clickSoundRef.current,
          )
        : clickSoundRef.current;
      playTwoBarsPreviewFromGrid(preset);
    }, CLICK_PRESET_BUS_TWO_BARS_PREVIEW_DEBOUNCE_MS);
  }, [playTwoBarsPreviewFromGrid]);

  const scheduleNote = (stepIdx: number, absR: number, time: number) => {
    const seq = sequenceRef.current;
    const currentSeqItem = seq[stepIdx];
    if (!currentSeqItem) return;

    const { r: rIdx, c: cIdx } = currentSeqItem;
    const noteDuration = getLegacyNoteDurationSeconds(rIdx);
    scheduleGridCellAtTime(rIdx, cIdx, absR, time, 0, stepIdx, noteDuration);
  };

  const scheduler = () => {
    if (!isPlayingRef.current || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const cfg = schedulerConfigRef.current;
    const nowPerf = performance.now();
    const prevTickPerf = schedulerLastTickPerfRef.current;
    schedulerLastTickPerfRef.current = nowPerf;
    const observedTickGapMs =
      prevTickPerf === null ? 0 : Math.max(0, nowPerf - prevTickPerf);
    const longStallThresholdMs = Math.max(
      AUDIO_SCHEDULER_LONG_STALL_MIN_MS,
      cfg.lookaheadMs * AUDIO_SCHEDULER_LONG_STALL_LOOKAHEAD_MULT,
    );
    const longStallDetected =
      prevTickPerf !== null && observedTickGapMs > longStallThresholdMs;
    const horizon = ctx.currentTime + cfg.scheduleAheadSec;
    let recoveredThisTick = false;
    if (longStallDetected) {
      const stallLagSec = observedTickGapMs / 1000;
      recordSchedulerRecovery(stallLagSec);
      recoveredThisTick = true;
      schedulerPostStallCooldownUntilPerfRef.current =
        nowPerf + AUDIO_SCHEDULER_POST_STALL_COOLDOWN_MS;
      armPassiveBurstCooldown(ctx, AUDIO_SCHEDULER_POST_STALL_COOLDOWN_MS);
      const hardResyncTime = ctx.currentTime + Math.max(0.01, cfg.scheduleAheadSec);
      if (polyModeRef.current) {
        const poly = getPolySubLegacyScheduler();
        for (const L of poly.lanes) {
          if (L.barIndices.length > 0) {
            L.nextTime = Math.max(L.nextTime, hardResyncTime);
          }
        }
      } else {
        nextNoteTimeRef.current = Math.max(nextNoteTimeRef.current, hardResyncTime);
      }
    }
    if (polyModeRef.current) {
      const poly = getPolySubLegacyScheduler();
      const minT = poly.getMinNextTime();
      if (Number.isFinite(minT) && minT !== Infinity && ctx.currentTime > minT + cfg.lateResetThresholdSec) {
        const lagSec = ctx.currentTime - minT;
        recordSchedulerRecovery(lagSec);
        recoveredThisTick = true;
        const r = ctx.currentTime + Math.max(0.01, cfg.scheduleAheadSec - Math.min(cfg.maxCatchUpLagSec, lagSec));
        for (const L of poly.lanes) {
          if (L.barIndices.length > 0) {
            L.nextTime = Math.max(L.nextTime, r);
          }
        }
      }
      poly.fillLookahead(horizon);
    } else {
      if (ctx.currentTime > nextNoteTimeRef.current + cfg.lateResetThresholdSec) {
        const lagSec = ctx.currentTime - nextNoteTimeRef.current;
        recordSchedulerRecovery(lagSec);
        recoveredThisTick = true;
        nextNoteTimeRef.current = ctx.currentTime + Math.max(0.01, cfg.scheduleAheadSec - Math.min(cfg.maxCatchUpLagSec, lagSec));
      }
      let catchUpBatches = 0;
      while (nextNoteTimeRef.current < horizon && catchUpBatches < cfg.maxCatchUpBatchesPerTick) {
        scheduleNote(currentStepRef.current, playAbsBarRef.current, nextNoteTimeRef.current);
        nextNote();
        catchUpBatches += 1;
      }
      if (nextNoteTimeRef.current < horizon) {
        const lagSec = horizon - nextNoteTimeRef.current;
        recordSchedulerRecovery(lagSec);
        recoveredThisTick = true;
        nextNoteTimeRef.current = Math.max(nextNoteTimeRef.current, ctx.currentTime + 0.01);
      }
    }
    if (recoveredThisTick) {
      schedulerSafeProfileEscalationsRef.current += 1;
      if (schedulerSafeProfileEscalationsRef.current >= 3 && schedulerProfileRef.current !== 'safe') {
        schedulerProfileRef.current = 'safe';
        schedulerConfigRef.current = getMetraSchedulerConfig('safe');
      }
    } else if (nowPerf < schedulerPostStallCooldownUntilPerfRef.current) {
      schedulerProfileRef.current = 'safe';
      schedulerConfigRef.current = getMetraSchedulerConfig('safe');
    } else {
      schedulerSafeProfileEscalationsRef.current = 0;
    }
    logAudioTimingMetricsIfDue(nowPerf);
    timerIDRef.current = window.setTimeout(scheduler, cfg.lookaheadMs);
  };

  const clearPlayHoldTimer = useCallback(() => {
    if (playHoldTimerRef.current !== null) {
      window.clearTimeout(playHoldTimerRef.current);
      playHoldTimerRef.current = null;
    }
  }, []);

  const initLastScrolledPageForPlayAbs = useCallback((playAbs0: number, c0: number, b: number, dsb0: number) => {
    if (b <= dsb0) return;
    const scrollStride0 = Math.max(1, dsb0 - 1);
    let logicalPage = Math.floor(playAbs0 / scrollStride0);
    if (playAbs0 > 0 && playAbs0 % scrollStride0 === 0) {
      const rIdx0 = playAbs0 % b;
      const rowSyl0 =
        customSyllablesRef.current[rIdx0] !== undefined
          ? customSyllablesRef.current[rIdx0]!
          : syllablesRef.current;
      if (c0 < Math.floor(rowSyl0 / 2)) logicalPage -= 1;
    }
    lastScrolledPageRef.current = logicalPage;
  }, []);

  const resolveLegacyPlaybackStartFromViewport = useCallback(() => {
    const seq = sequenceRef.current;
    const b = barsRef.current;
    if (seq.length === 0) {
      currentStepRef.current = 0;
      playAbsBarRef.current = 0;
      return;
    }
    const grid = gridRef.current;
    let topAbs = 0;
    if (grid) {
      const gTop = grid.getBoundingClientRect().top;
      for (let absR = 0; absR < b; absR++) {
        const el = rowRefs.current[absR];
        if (!el) continue;
        if (el.getBoundingClientRect().bottom > gTop) {
          topAbs = absR;
          break;
        }
      }
    }
    const patternR = topAbs % Math.max(1, b);
    let stepIdx = seq.findIndex((it) => it.r === patternR);
    if (stepIdx === -1) stepIdx = seq.findIndex((it) => it.r > patternR);
    if (stepIdx === -1) stepIdx = 0;
    const item = seq[stepIdx];
    const fs0 = frozenScaleRef.current;
    const dsb0 = fs0 !== null ? Math.min(fs0, 10) : Math.min(b, 10);
    const compact0 = b <= dsb0;
    currentStepRef.current = stepIdx;
    if (!item) {
      playAbsBarRef.current = 0;
    } else {
      playAbsBarRef.current = compact0 ? item.r : topAbs;
    }
    if (b > dsb0 && item) {
      initLastScrolledPageForPlayAbs(playAbsBarRef.current, item.c, b, dsb0);
    }
  }, [initLastScrolledPageForPlayAbs]);

  const resolveLegacyPlaybackStartFromPatternBar = useCallback((patternBarN: number) => {
    const seq = sequenceRef.current;
    const b = barsRef.current;
    const N = Math.max(0, Math.min(b - 1, Math.floor(patternBarN)));
    if (seq.length === 0) {
      currentStepRef.current = 0;
      playAbsBarRef.current = N;
      return;
    }
    let stepIdx = seq.findIndex((it) => it.r === N && it.c === 0);
    if (stepIdx === -1) stepIdx = seq.findIndex((it) => it.r === N);
    if (stepIdx === -1) stepIdx = seq.findIndex((it) => it.r > N);
    if (stepIdx === -1) stepIdx = 0;
    const item = seq[stepIdx];
    const fs0 = frozenScaleRef.current;
    const dsb0 = fs0 !== null ? Math.min(fs0, 10) : Math.min(b, 10);
    const compact0 = b <= dsb0;
    currentStepRef.current = stepIdx;
    playAbsBarRef.current = compact0 ? (item?.r ?? N) : N;
    if (b > dsb0 && item) {
      initLastScrolledPageForPlayAbs(playAbsBarRef.current, item.c, b, dsb0);
    }
  }, [initLastScrolledPageForPlayAbs]);

  const scrollGridToPatternBar = useCallback(
    (patternBarN: number) => {
      const rowEl = rowRefs.current[patternBarN];
      if (rowEl) performAutoscrollToRow(rowEl);
    },
    [performAutoscrollToRow],
  );

  const applyPlaybackStartAnchor = useCallback(() => {
    const override = playbackStartBarOverrideRef.current;
    if (polyModeRef.current) {
      const startBar = override ?? 0;
      playAbsBarRef.current = startBar;
      scrollGridToPatternBar(startBar);
      currentStepRef.current = 0;
      return;
    }
    if (override === null) {
      resolveLegacyPlaybackStartFromViewport();
    } else {
      resolveLegacyPlaybackStartFromPatternBar(override);
      scrollGridToPatternBar(override);
    }
  }, [
    resolveLegacyPlaybackStartFromViewport,
    resolveLegacyPlaybackStartFromPatternBar,
    scrollGridToPatternBar,
  ]);

  const enterStartBarPickMode = useCallback(() => {
    if (isPlayingRef.current || isTaEditorModeRef.current || isDeadCellsEditorModeRef.current) return;
    setStartBarPickHighlight(playbackStartBarOverrideRef.current);
    setIsStartBarPickMode(true);
    isStartBarPickModeRef.current = true;
  }, []);

  const handleStartBarPick = useCallback(
    (rIdx: number) => {
      const b = barsRef.current;
      if (b <= 0) return;
      const safeR = Math.max(0, Math.min(b - 1, Math.floor(rIdx)));
      const patternBarN = patternBarFromRowTap(safeR, polyModeRef.current, polyVoicesRef.current);
      playbackStartBarOverrideRef.current = patternBarN === 0 ? null : patternBarN;
      setStartBarPickHighlight(patternBarN === 0 ? null : patternBarN);
      setIsStartBarPickMode(false);
      isStartBarPickModeRef.current = false;
      scrollGridToPatternBar(patternBarN);
      clearPlayHoldTimer();
      playHoldAteClickRef.current = false;
      if (!isPlayingRef.current) {
        togglePlaybackRef.current();
      }
    },
    [scrollGridToPatternBar, clearPlayHoldTimer],
  );

  useEffect(() => {
    if (!isStartBarPickMode) return;
    const onPointerDown = (e: PointerEvent) => {
      const grid = gridRef.current;
      if (!grid) return;
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (grid.contains(target)) return;
      setIsStartBarPickMode(false);
      isStartBarPickModeRef.current = false;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [isStartBarPickMode]);

  const togglePlayback = () => {
    if (previewResetTimerRef.current !== null) {
      window.clearTimeout(previewResetTimerRef.current);
      previewResetTimerRef.current = null;
    }
    if (isPlaying) {
      endLiveControlWindow();
      setIsPlaying(false);
      setAutoscrollVirtualRowsEnabled(false);
      isPlayingRef.current = false;
      logAudioTimingMetricsIfDue(Number.MAX_SAFE_INTEGER);
      // Chaos auto-ramp: pause/stop всегда выключает автопилот.
      if (chaosRampActiveRef.current) {
        chaosRampActiveRef.current = false;
        setChaosRampActive(false);
      }
      cancelChaosRampPress();
      clearTempoHoldRepeat();
      tempoMinusHoldAteClickRef.current = false;
      tempoPlusHoldAteClickRef.current = false;
      clearPlayheadScheduling();
      setActivePos({ r: -1, c: -1, absR: -1 });
      setActivePositions([]);
      clearPendingGridClickTimers();
      gridPreviewAudioActiveRef.current = false;
      polyClickSlotsRef.current.clear();
      polySubLegacyRef.current = null;
      schedulerLastTickPerfRef.current = null;
      schedulerPostStallCooldownUntilPerfRef.current = 0;
      currentStepRef.current = 0; // Reset pattern position to start
      if (timerIDRef.current) clearTimeout(timerIDRef.current);
      if (programmaticAutoscrollFallbackTimerRef.current !== null) {
        window.clearTimeout(programmaticAutoscrollFallbackTimerRef.current);
        programmaticAutoscrollFallbackTimerRef.current = null;
      }
      if (programmaticAutoscrollSettleTimerRef.current !== null) {
        window.clearTimeout(programmaticAutoscrollSettleTimerRef.current);
        programmaticAutoscrollSettleTimerRef.current = null;
      }
      programmaticAutoscrollRef.current = false;
      if (squareHoldTimerRef.current !== null) {
        window.clearTimeout(squareHoldTimerRef.current);
        squareHoldTimerRef.current = null;
      }
      if (clickPresetBusTwoBarsPreviewDebounceRef.current !== null) {
        window.clearTimeout(clickPresetBusTwoBarsPreviewDebounceRef.current);
        clickPresetBusTwoBarsPreviewDebounceRef.current = null;
      }
      if (clickPresetBusTwoBarsPreviewRetryTimerRef.current !== null) {
        window.clearTimeout(clickPresetBusTwoBarsPreviewRetryTimerRef.current);
        clickPresetBusTwoBarsPreviewRetryTimerRef.current = null;
      }
      if (clickBusSliderHoldRef.current.timer !== null) {
        window.clearTimeout(clickBusSliderHoldRef.current.timer);
        clickBusSliderHoldRef.current.timer = null;
        clickBusSliderHoldRef.current.moved = false;
        clickBusSliderHoldRef.current.token = null;
      }
      if (randomDiceHoldTimerRef.current !== null) {
        window.clearTimeout(randomDiceHoldTimerRef.current);
        randomDiceHoldTimerRef.current = null;
      }
      if (taHoldTimerRef.current !== null) {
        window.clearTimeout(taHoldTimerRef.current);
        taHoldTimerRef.current = null;
      }
      cancelTaHoldFillAnim();
      if (eraserHoldTimerRef.current !== null) {
        window.clearTimeout(eraserHoldTimerRef.current);
        eraserHoldTimerRef.current = null;
      }
      if (panelChevronHoldTimerRef.current !== null) {
        window.clearTimeout(panelChevronHoldTimerRef.current);
        panelChevronHoldTimerRef.current = null;
      }
      panelChevronHoldLongPressReadyRef.current = false;
      if (randomDiceMintFlashClearRef.current !== null) {
        window.clearTimeout(randomDiceMintFlashClearRef.current);
        randomDiceMintFlashClearRef.current = null;
      }
      syllableReadMuteModeRef.current = 'off';
      setSyllableReadMuteMode('off');
      trainerHoldMuteRef.current = false;
      setTrainerHoldMute(false);
      squareHoldAteClickRef.current = false;
      randomDiceHoldAteClickRef.current = false;
      taHoldAteClickRef.current = false;
      eraserHoldAteClickRef.current = false;
      clearPlayHoldTimer();
      playHoldAteClickRef.current = false;
      setIsStartBarPickMode(false);
      isStartBarPickModeRef.current = false;
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    } else {
      endLiveControlWindow();
      if (isTaEditorModeRef.current || isDeadCellsEditorModeRef.current) return;
      if (!isClickSoundSelectorOpen) {
        if (!panelCollapseFrozenRef.current) {
          setIsPanelExpanded(false);
        }
        setShowRandomSettings(false);
      }
      setIsPlaying(true);
      isPlayingRef.current = true;
      autoscrollDisabledByUserRef.current = false;
      setAutoscrollVirtualRowsEnabled(true);
      clearPlayheadScheduling();
      setActivePositions([]);
      coldStartRef.current = true; // Mark cold start
      applyPlaybackStartAnchor();
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      {
        const ctxBoot = audioCtxRef.current;
        const gBoot = clickMixerGroupRef.current;
        if (ctxBoot) {
          const activeSound = resolveClickSoundForPolyVoice(
            0,
            polyModeRef.current,
            clickSoundByPolyVoiceRef.current,
            clickSoundRef.current,
          );
          if (activeSound === 'hi_hat') {
            void ensureTaHiHatBuffer(ctxBoot);
          }
        }
        if (ctxBoot && gBoot) {
          for (const v of ['accent', 'alt', 'passive'] as const) {
            getVoiceLayerSumInput(ctxBoot, v);
            applyVoiceGroupChain(ctxBoot, v, gBoot[v].groupHpHz, gBoot[v].groupLpHz, gBoot[v].groupMasterLinear);
          }
        }
      }
      // Guarantee loop limits if grid resized
      if (polyModeRef.current) {
        if (currentStepRef.current >= polyChunksRef.current.length) {
          currentStepRef.current = 0;
        }
      } else if (currentStepRef.current >= sequenceRef.current.length) {
        currentStepRef.current = 0;
      }
      clearPendingGridClickTimers();
      polyClickSlotsRef.current.clear();
      polySubLegacyRef.current = null;
      schedulerProfileRef.current = DEFAULT_SCHEDULER_PROFILE;
      schedulerConfigRef.current = getMetraSchedulerConfig(DEFAULT_SCHEDULER_PROFILE);
      schedulerSafeProfileEscalationsRef.current = 0;
      schedulerLastTickPerfRef.current = null;
      schedulerPostStallCooldownUntilPerfRef.current = 0;
      resetAudioTimingMetrics();
      nextNoteTimeRef.current =
        audioCtxRef.current.currentTime + schedulerConfigRef.current.scheduleAheadSec;
      if (polyModeRef.current) {
        const polyStart = playbackStartBarOverrideRef.current ?? 0;
        const poly = getPolySubLegacyScheduler();
        if (playbackStartBarOverrideRef.current !== null) {
          poly.resetFromPatternBar(nextNoteTimeRef.current, polyStart);
        } else {
          poly.reset(nextNoteTimeRef.current);
        }
      }
      scheduler();
    }
  };
  togglePlaybackRef.current = togglePlayback;

  const handlePlayButtonClick = () => {
    if (playHoldAteClickRef.current) {
      playHoldAteClickRef.current = false;
      return;
    }
    if (isStartBarPickModeRef.current) {
      setIsStartBarPickMode(false);
      isStartBarPickModeRef.current = false;
      return;
    }
    togglePlayback();
  };

  /* Синхронизация refs с render до pointerup flush (до useEffect по deps). */
  /* Прямое присваивание (без spread) — чтобы ref === state. Тогда in-place мутации ref
   * (в poly randomizer и прочих ref-first путях) мутируют и state, и сохраняются
   * между перерендерами до `setTimeout(0) → setState`. Spread-копия создавала
   * disconnected объект, который перезаписывался на каждом рендере → мутация терялась. */
  tempoRef.current = pendingTempoRef.current ?? tempo;
  barsRef.current = bars;
  syllablesRef.current = syllables;
  accentsRef.current = accents;
  accentsByLaneRef.current = accentsByLane;
  taDingKeysRef.current = taDingKeys;
  taDingKeysByLaneRef.current = taDingKeysByLane;
  customSyllablesRef.current = customSyllables;
  deadCellsRef.current = deadCells;
  customMultipliersRef.current = customMultipliers;
  customSubdivisionsRef.current = customSubdivisions;
  customCellSyllablesRef.current = customCellSyllables;
  pulseMeterUnlinkedRef.current = pulseMeterUnlinked;
  polyModeRef.current = polyMode;
  polyVoicesRef.current = polyVoices;
  accentMapVersionRef.current = accentMapVersion;
  isTaEditorModeRef.current = isTaEditorMode;
  isDeadCellsEditorModeRef.current = isDeadCellsEditorMode;
  isStartBarPickModeRef.current = isStartBarPickMode;
  firstBeatAccentRef.current = firstBeatAccent;
  firstBeatAccentByLaneRef.current = firstBeatAccentByLane;
  mixerLayerModeRef.current = mixerLayerMode;
  trainerModeRef.current = trainerMode;
  onlyAccentsRef.current = false;
  trainerHoldMuteRef.current = trainerHoldMute;
  dictantModeRef.current = dictantMode;
  firstBeatDingSuppressedRowsRef.current = firstBeatDingSuppressedRows;
  clickSoundRef.current = clickSound;
  clickSoundByPolyVoiceRef.current = { ...clickSoundByPolyVoice };
  polyVoiceGainsRef.current = { ...polyVoiceGains };
  activeClickVoiceTargetRef.current = activeClickVoiceTarget;
  if (clickSoundMixerClonedKeyRef.current !== clickSound) {
    clickSoundMixerClonedKeyRef.current = clickSound;
    cloneClickMixerFromLibrary(clickSound);
  }

  const firstBeatEditorSuppressedRowsSorted: number[] = [];
  for (const row of firstBeatDingSuppressedRows) firstBeatEditorSuppressedRowsSorted.push(row);
  firstBeatEditorSuppressedRowsSorted.sort((a, b) => a - b);
  const firstBeatEditorSuppressedSig = firstBeatEditorSuppressedRowsSorted.join(',');
  const deadStartByRow = useMemo(() => {
    const out: Record<number, number> = {};
    for (const [rk, meta] of Object.entries(deadCells as DeadCellsMap)) {
      const r = parseInt(rk, 10);
      if (!Number.isFinite(r) || !meta) continue;
      out[r] = meta.deadStart;
    }
    return out;
  }, [deadCells]);
  const deadDisplayByRow = useMemo(() => {
    const out: Record<number, number> = {};
    for (const [rk, meta] of Object.entries(deadCells as DeadCellsMap)) {
      const r = parseInt(rk, 10);
      if (!Number.isFinite(r) || !meta) continue;
      out[r] = meta.displayLen;
    }
    return out;
  }, [deadCells]);
  const rowRuntimeContexts = useMemo((): Record<number, RowRuntimeContext> => {
    const out: Record<number, RowRuntimeContext> = {};
    const schedule = phraseScheduleRef.current;
    for (let r = 0; r < bars; r++) {
      const role = schedule[r];
      const rowSylls = customSyllables[r] !== undefined ? customSyllables[r]! : syllables;
      const pulseSyllables = pulseMeterUnlinked[r] ? PULSE_METER_BASE_SYLLABLES : rowSylls;
      const mult = customMultipliers[r] ?? 1;
      const effectiveBpm = tempoUi * (pulseSyllables / 4) * mult;
      out[r] = {
        localJati: role?.deSyncJati ? role.localCycleLength : undefined,
        gatiTargetSub: role?.gatiTargetSub,
        roleType: role?.type,
        effectiveBpm,
        rowMultiplier: mult,
      };
    }
    return out;
  }, [bars, customSyllables, syllables, pulseMeterUnlinked, customMultipliers, tempoUi, randomMode]);

  // FRAGILE — grid reads flattened lane sets in poly; must match SequencerGrid taDingSig / accents bits.
  const accentsUi = useMemo(
    () => (polyMode ? flattenLaneSetMap(accentsByLane, bars, polyVoices) : accents),
    [polyMode, accentsByLane, accents, bars, polyVoices],
  );
  const taDingKeysUi = useMemo(
    () => (polyMode ? flattenLaneSetMap(taDingKeysByLane, bars, polyVoices) : taDingKeys),
    [polyMode, taDingKeysByLane, taDingKeys, bars, polyVoices],
  );
  // FRAGILE — editor visibility gate for legacy col0 defaults.
  // Keep this as "effective first-beat enabled" only.
  // Do not mix explicit taDing map semantics into this gate.
  const forceFirstBeatEditorFrames = useMemo(() => {
    const anyLaneFirstBeat = Boolean(firstBeatAccentByLane[0] || firstBeatAccentByLane[1] || firstBeatAccentByLane[2]);
    const anyFirstBeat = polyMode ? anyLaneFirstBeat : (firstBeatAccent || anyLaneFirstBeat);
    return anyFirstBeat;
  }, [polyMode, firstBeatAccentByLane, firstBeatAccent]);
  // FRAGILE — UI source for explicit Ta markers.
  // Must always expose explicit taDing keys; do not hide them in normal mode based on firstBeatAccent.
  // Hiding explicit keys causes "can't place Ta where I want" regressions.
  const visibleTaDingKeys = useMemo(() => {
    return taDingKeysUi;
  }, [taDingKeysUi]);
  const hasAnyVisibleAccentOutsideFirstBeat = useMemo(() => {
    for (const key of accentsUi) {
      const [rRaw, cRaw] = key.split('-');
      const r = parseInt(rRaw ?? '', 10);
      const c = parseInt(cRaw ?? '', 10);
      if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
      if (r < 0 || r >= bars) continue;
      if (c <= 0) continue;
      const rowSylls = customSyllables[r] !== undefined ? customSyllables[r]! : syllables;
      if (c >= rowSylls) continue;
      const deadStart = deadCells[r]?.deadStart;
      if (typeof deadStart === 'number' && c >= deadStart) continue;
      return true;
    }
    return false;
  }, [accentsUi, bars, customSyllables, syllables, deadCells]);
  const hasAnyExplicitTaOutsideFirstBeat = useMemo(() => {
    for (const key of taDingKeysUi) {
      const [rRaw, cRaw] = key.split('-');
      const r = parseInt(rRaw ?? '', 10);
      const c = parseInt(cRaw ?? '', 10);
      if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
      if (r < 0 || r >= bars) continue;
      if (c <= 0) continue;
      const rowSylls = customSyllables[r] !== undefined ? customSyllables[r]! : syllables;
      if (c >= rowSylls) continue;
      const deadStart = deadCells[r]?.deadStart;
      if (typeof deadStart === 'number' && c >= deadStart) continue;
      return true;
    }
    return false;
  }, [taDingKeysUi, bars, customSyllables, syllables, deadCells]);
  const canShowDefaultTaInNormal =
    firstBeatDingSuppressedRows.size > 0 ||
    hasAnyExplicitTaOutsideFirstBeat;
  sequencerGridRowActionsRef.current = {
    cellGestureMutexRef,
    isHoldingRef,
    holdTimerRef,
    pulseUnlinkHoldTimerRef,
    pulseUnlinkJustFiredRef,
    isPanelExpandedRef,
    showRandomSettingsRef,
    syllables,
    setActiveEditRow,
    setActiveEditCell,
    setIsPanelExpanded,
    setCustomMultipliers,
    setCustomSubdivisions,
    applyCellIntent,
    handleCellDivUpdate,
    toggleCellStepMute,
    setCustomSyllables,
    triggerDeadCut,
    restoreDeadRow,
    deadSwipeSessionRef,
    deadCellsRef,
    setPulseMeterUnlinked,
    toggleAccent,
    toggleTaDing,
    customSyllablesRef,
    customMultipliersRef,
    pulseMeterUnlinkedRef,
    subdivHoldSessionRef,
    onPulseLongPressModeSwitch: (rowIdx, rowSylls, nextPulseUnlinked) => {
      // Возвращаем управление gati/jati в random parent без изменения пульса такта.
      if (randomModeRef.current !== 'parent') return;
      if (formPresetIdRef.current !== 'progressive') return;

      if (nextPulseUnlinked) {
        const base = Math.max(3, Math.min(9, Math.round(rowSylls)));
        const nearestJati = normalizeJatiCycleLength(base);
        progressiveDensityModeRef.current = 'jati_mode';
        deSyncJatiActiveRef.current = true;
        deSyncCycleLengthRef.current = nearestJati;
        setProgressiveDensityMode('jati_mode');
        setDeSyncJatiActive(true);
        setDeSyncCycleLength(nearestJati);
        setJatiPulseActiveByRow((prev) => ({ ...prev, [rowIdx]: true }));
        return;
      }

      setJatiPulseActiveByRow((prev) => {
        if (!prev[rowIdx]) {
          if (Object.keys(prev).length === 0) {
            progressiveDensityModeRef.current = 'gati_mode';
            deSyncJatiActiveRef.current = false;
            deSyncCycleLengthRef.current = undefined;
            setProgressiveDensityMode('gati_mode');
            setDeSyncJatiActive(false);
            setDeSyncCycleLength(undefined);
          }
          return prev;
        }
        const nextRows = { ...prev };
        delete nextRows[rowIdx];
        if (Object.keys(nextRows).length === 0) {
          progressiveDensityModeRef.current = 'gati_mode';
          deSyncJatiActiveRef.current = false;
          deSyncCycleLengthRef.current = undefined;
          setProgressiveDensityMode('gati_mode');
          setDeSyncJatiActive(false);
          setDeSyncCycleLength(undefined);
        }
        return nextRows;
      });
    },
  };

  const mixerButtonSurface =
    mixerLayerMode === 'full_mix'
      ? `border border-purple-500/40 bg-purple-700/30 hover:bg-purple-700/40 active:bg-purple-700/20 text-purple-200`
      : mixerLayerMode === 'alt_only'
        ? `border border-purple-500/60 bg-purple-900/35 hover:bg-purple-900/45 active:bg-purple-900/30 text-purple-100`
        : `border border-[#23314f] hover:bg-[#1a253c] active:bg-[#131b2c] text-slate-300 hover:text-slate-200`;
  const trainerButtonSurface =
    trainerHoldMute
      ? `border-amber-400/90 ${lowPerfMode ? '' : 'shadow-[0_0_14px_rgba(251,191,36,0.28)]'} text-amber-100`
      : trainerMode === 'dictation'
        ? `border-teal-400/80 bg-teal-900/20 text-teal-100`
        : trainerMode === 'ta_only'
          ? `border-transparent bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950${
              lowPerfMode ? '' : ' shadow-[0_8px_20px_rgba(16,185,129,0.2)]'
            }`
          : `border-[#23314f] hover:bg-[#1a253c] active:bg-[#131b2c] text-slate-300 hover:text-slate-200`;
  const mixerModeLabel =
    mixerLayerMode === 'full_mix'
      ? 'Mixer: base + alt'
      : mixerLayerMode === 'no_alt'
        ? 'Mixer: base only (no alt)'
        : 'Mixer: alt only';
  const trainerModeLabel =
    trainerHoldMute
      ? 'Mode: silent hold (grid muted)'
      : trainerMode === 'dictation'
        ? 'Mode: dictation'
        : trainerMode === 'ta_only'
          ? 'Mode: Ta-only'
          : 'Mode: normal';
  const isMatrixUiActive = pressMatrixArmSourceUi !== null;
  const matrixBlockSurfaceClass = isMatrixUiActive
    ? `bg-violet-500/10 border-violet-500/55 ${lowPerfMode ? '' : 'shadow-[0_0_14px_rgba(167,139,250,0.22)]'}`
    : 'bg-[#161f33] border-[#23314f]';
  const matrixInnerBlockSurfaceClass = isMatrixUiActive
    ? `bg-violet-500/12 border-violet-500/45 ${lowPerfMode ? '' : 'shadow-[inset_0_0_10px_rgba(167,139,250,0.16)]'}`
    : 'bg-[#161f33] border-[#23314f]';

  return (
    <div className="h-[100dvh] bg-[#0b101e] sm:bg-black/95 text-slate-200 p-0 sm:p-6 font-sans flex flex-col items-center justify-center">
      {/* Phone emulator container */}
      <div className="relative flex h-[100dvh] min-h-0 w-full max-w-[390px] shrink-0 flex-col gap-2 overflow-hidden bg-[#0b101e] px-3 pb-3 pt-1.5 shadow-2xl sm:h-[844px] sm:rounded-[2.5rem] sm:border-[6px] border-[#1e2a45]">
        
        {/* Top Header Controls */}
        {/* HEADER WIDTH CONTRACT: эта строка (с Eraser) — референс по правой X-линии для выравнивания BAR.
            При регрессии сравнивать правую грань BAR именно с правой гранью кнопки Eraser здесь. */}
        <div className="flex w-full gap-2 items-center">
          <button 
            ref={settingsGearButtonRef}
            onClick={() => {
              if (!showRandomSettings) {
                setShowRandomSettings(true);
                setIsPanelExpanded(true);
              } else {
                setShowRandomSettings(false);
              }
            }}
            className="p-3 bg-[#161f33] rounded-xl border border-[#23314f] text-slate-400 hover:text-slate-200 transition-colors"
          >
            <Settings size={20} />
          </button>
          {!isPanelExpanded && !showRandomSettings ? (
            <div className={`flex-1 flex items-center gap-2 min-w-0 py-2 px-1.5 rounded-xl border touch-none transition-colors ${matrixInnerBlockSurfaceClass}`}>
          <button 
                type="button"
                onPointerDown={beginTempoMinusHold}
                onPointerUp={endTempoHoldRepeat}
                onPointerLeave={endTempoHoldRepeat}
                onPointerCancel={endTempoHoldRepeat}
                onClick={() => {
                  if (tempoMinusHoldAteClickRef.current) {
                    tempoMinusHoldAteClickRef.current = false;
                    return;
                  }
                  applyTempoImmediate(tempoUi - 1);
                }}
                className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
              >
                <Minus size={18} strokeWidth={2.5} />
              </button>
              <TempoSliderTrack
                tempoUi={tempoUi}
                tempoRef={tempoRef}
                scheduleTempoCommit={scheduleTempoCommit}
                flushTempoCommit={flushTempoCommit}
                tempoInlineEditing={tempoInlineEditing}
                tempoInlineFocusSlot={tempoInlineFocusSlot}
                tempoSliderSlot="hdr"
                tempoManualText={tempoManualText}
                onTempoManualTextChange={setTempoManualText}
                onCommitTempoInline={commitTempoInlineEdit}
                onCancelTempoInline={cancelTempoInlineEdit}
                onBeginInlineEdit={beginTempoInlineEdit}
                className="flex-1 relative flex items-center h-8 min-w-0"
              />
              <button
                type="button"
                onPointerDown={beginTempoPlusHold}
                onPointerUp={endTempoHoldRepeat}
                onPointerLeave={endTempoHoldRepeat}
                onPointerCancel={endTempoHoldRepeat}
                onClick={() => {
                  if (tempoPlusHoldAteClickRef.current) {
                    tempoPlusHoldAteClickRef.current = false;
                    return;
                  }
                  applyTempoImmediate(tempoUi + 1);
                }}
                className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
              >
                <Plus size={18} strokeWidth={2.5} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onPointerDown={onTapButtonPointerDown}
              onClick={() => {
                if (tapBpmHoldAteClickRef.current) {
                  tapBpmHoldAteClickRef.current = false;
                  return;
                }
                handleTap();
              }}
              className="flex-1 py-3 bg-[#161f33] rounded-xl border border-[#23314f] font-semibold text-slate-300 tracking-wide hover:bg-[#1a253c] active:bg-purple-900/50 active:border-purple-500/50 active:text-purple-100 transition-all active:scale-95 duration-75 min-h-[48px] flex items-center justify-center"
            >
              {tempoInlineEditing && tempoInlineFocusSlot === 'tap' ? (
                <input
                  ref={tempoTapInlineInputRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="BPM"
                  className="min-w-0 w-full max-w-[7rem] mx-auto bg-transparent text-center text-sm font-bold text-slate-100 outline-none tabular-nums"
                  value={tempoManualText}
                  onChange={(e) => setTempoManualText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitTempoInlineEdit();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelTempoInlineEdit();
                    }
                  }}
                  onBlur={() => commitTempoInlineEdit()}
                  onClick={(ev) => ev.stopPropagation()}
                  onPointerDown={(ev) => ev.stopPropagation()}
                />
              ) : (
                'Tap'
              )}
            </button>
          )}
          <button 
            onPointerDown={() => {
              clearPlayHoldTimer();
              playHoldAteClickRef.current = false;
              eraserHoldAteClickRef.current = false;
              if (eraserHoldTimerRef.current !== null) {
                window.clearTimeout(eraserHoldTimerRef.current);
                eraserHoldTimerRef.current = null;
              }
              eraserHoldTimerRef.current = window.setTimeout(() => {
                eraserHoldTimerRef.current = null;
                eraserHoldAteClickRef.current = true;
                setIsDeadCellsEditorMode((prev) => {
                  const next = !prev;
                  if (next) setIsTaEditorMode(false);
                  return next;
                });
              }, SNAPSHOT_MENU_HOLD_MS);
            }}
            onPointerUp={() => {
              if (eraserHoldTimerRef.current !== null) {
                window.clearTimeout(eraserHoldTimerRef.current);
                eraserHoldTimerRef.current = null;
              }
            }}
            onPointerLeave={() => {
              if (eraserHoldTimerRef.current !== null) {
                window.clearTimeout(eraserHoldTimerRef.current);
                eraserHoldTimerRef.current = null;
              }
            }}
            onPointerCancel={() => {
              if (eraserHoldTimerRef.current !== null) {
                window.clearTimeout(eraserHoldTimerRef.current);
                eraserHoldTimerRef.current = null;
              }
            }}
            onClick={() => {
              if (eraserHoldAteClickRef.current) {
                eraserHoldAteClickRef.current = false;
                return;
              }
              if (isDeadCellsEditorModeRef.current) {
                setIsDeadCellsEditorMode(false);
                return;
              }
              clearSequencer();
            }}
            className={`p-3 rounded-xl border transition-all duration-200 ${
              isDeadCellsEditorMode
                ? `bg-red-600/25 border-red-400/70 text-red-200 ${lowPerfMode ? '' : 'shadow-[0_0_14px_rgba(248,113,113,0.35)]'}`
                : 'bg-[#161f33] border-[#23314f] text-slate-400 hover:text-red-400 hover:border-red-500/30 active:bg-red-500/20'
            }`}
          >
            <Eraser size={20} />
          </button>
        </div>

        {/* Global Settings (Tempo & Row Selectors) */}
        <div
          className={`relative flex shrink-0 flex-col rounded-2xl border transition-colors ${matrixBlockSurfaceClass} ${
            isClickSoundSelectorOpen ? 'mb-1' : 'mb-2'
          }`}
        >
              {showRandomSettings ? (
            <div className={`grid ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div
                ref={randomSettingsPanelRef}
                className={`overflow-hidden flex flex-col ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${
                  isPanelExpanded
                    ? isClickSoundSelectorOpen
                      ? 'gap-3 px-2.5 py-2'
                      : 'gap-5 px-2.5 py-4'
                    : 'gap-0 px-2.5 py-0'
                }`}
              >
                <div className={`flex flex-col px-1 pb-1 ${isClickSoundSelectorOpen ? 'gap-2 flex-1 min-h-0' : 'gap-4'}`}>
                  {isClickSoundSelectorOpen ? (
                    <div className="bg-[#0b101e] border border-[#2f4066]/50 rounded-xl p-3 pt-10 flex flex-col gap-3 min-h-0 flex-1 max-h-[66dvh] relative overflow-hidden">
                      <div className="absolute left-3 right-3 top-3 flex items-center justify-between pointer-events-none">
                        <button
                          type="button"
                          onClick={() => setIsClickSoundSelectorOpen(false)}
                          onPointerDown={() => {}}
                          className="w-8 h-8 rounded-lg bg-[#131722] border border-[#1f2438] flex items-center justify-center text-[#5b6385] hover:text-[#c0c5db] hover:bg-[#1a2030] transition-colors pointer-events-auto"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <div className="h-8 min-w-0 flex-1" />
                        <div className="h-8 w-8 shrink-0" aria-hidden />
                      </div>
                      <div
                        className="flex items-start gap-2 w-full min-w-0 shrink-0 justify-between"
                        onPointerDownCapture={() => {}}
                      >
                        {polyMode ? (
                          <div className="flex items-center gap-1 shrink-0 translate-y-12">
                            {([0, 1, 2] as const).filter((v) => v < (polyVoices === 3 ? 3 : 2)).map((voiceIdx) => {
                              const isActive = activeClickVoiceTarget === voiceIdx;
                              const label = `V${voiceIdx + 1}`;
                              const activeCls =
                                voiceIdx === 0
                                  ? 'border-emerald-400 text-emerald-200 bg-emerald-500/10'
                                  : voiceIdx === 1
                                    ? 'border-sky-400 text-sky-200 bg-sky-500/10'
                                    : 'border-violet-400 text-violet-200 bg-violet-500/10';
                              return (
                                <button
                                  key={voiceIdx}
                                  type="button"
                                  onClick={() => {
                                    activeClickVoiceTargetRef.current = voiceIdx;
                                    setActiveClickVoiceTarget(voiceIdx);
                                  }}
                                  className={`px-2 py-1 rounded-md border text-[10px] font-bold transition-colors ${
                                    isActive
                                      ? activeCls
                                      : 'border-[#2a385b] text-slate-400 hover:text-slate-200 hover:border-[#3b4f7a]'
                                  }`}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="min-w-0 flex-1 shrink" aria-hidden />
                        )}
                        {(() => {
                          const busPreset =
                            polyMode
                              ? resolveClickSoundForPolyVoice(
                                  activeClickVoiceTarget,
                                  true,
                                  clickSoundByPolyVoice,
                                  clickSound,
                                )
                              : clickSound;
                          const busVoice = (polyMode ? activeClickVoiceTarget : 0) as 0 | 1 | 2;
                          const gRow = getClickPresetBusGainsForVoicePreset(
                            clickPresetBusGainsByVoice,
                            clickPresetBusGains,
                            busVoice,
                            busPreset,
                          );
                          const busKeys: { key: keyof ClickPresetBusGains; aria: string; swatchClass: string }[] = [
                            {
                              key: 'accent',
                              aria: 'Accent — accented syllable (white rim)',
                              swatchClass: `inline-block h-4 min-w-[18px] shrink-0 rounded-md border-2 box-border bg-[#4b5563] border-white/90 ${
                                lowPerfMode ? '' : 'shadow-[0_1px_4px_rgba(255,255,255,0.18)]'
                              }`,
                            },
                            {
                              key: 'alt',
                              aria: 'Alt — purple syllable',
                              swatchClass: `inline-block h-4 min-w-[18px] shrink-0 rounded-md border-2 box-border bg-purple-900/40 border-purple-500/50 ${
                                lowPerfMode ? '' : 'shadow-[inset_0_1px_3px_rgba(168,85,247,0.22)]'
                              }`,
                            },
                            {
                              key: 'passive',
                              aria: 'Passive — normal step',
                              swatchClass: `inline-block h-4 min-w-[18px] shrink-0 rounded-md border-2 box-border bg-[#1e2a45] border-[#2f4066] ${
                                lowPerfMode ? '' : 'shadow-[0_1px_2px_rgba(0,0,0,0.25)]'
                              }`,
                            },
                          ];
                          const busRowSliderClass =
                            'min-w-0 flex-1 h-2 rounded-md bg-[#0f1526] appearance-none cursor-pointer touch-manipulation';
                          const labelColClass =
                            'w-7 shrink-0 text-left text-[10px] font-bold text-slate-500 leading-none';
                          const volVoiceIdx = (polyMode ? activeClickVoiceTarget : 0) as 0 | 1 | 2;
                          return (
                            <div className="relative z-10 flex flex-col justify-start gap-2.5 min-w-0 max-w-[10.5rem] w-full shrink -mt-6">
                              {busKeys.map(({ key, aria, swatchClass }) => (
                                <label
                                  key={key}
                                  aria-label={aria}
                                  className="flex items-center gap-2 w-full min-w-0 py-1"
                                >
                                  {(() => {
                                    const sliderToken = `${busVoice}-${busPreset}-${key}`;
                                    const cancelBusSliderHold = () => {
                                      const hold = clickBusSliderHoldRef.current;
                                      if (hold.timer !== null) {
                                        window.clearTimeout(hold.timer);
                                        hold.timer = null;
                                      }
                                      hold.moved = false;
                                      hold.token = null;
                                    };
                                    const markBusSliderMoved = () => {
                                      const hold = clickBusSliderHoldRef.current;
                                      if (hold.token !== sliderToken) return;
                                      hold.moved = true;
                                      if (hold.timer !== null) {
                                        window.clearTimeout(hold.timer);
                                        hold.timer = null;
                                      }
                                    };
                                    return (
                                      <>
                                  <span className="w-7 shrink-0 flex items-center justify-center pointer-events-none">
                                    <span className={swatchClass} aria-hidden />
                                  </span>
                                  <input
                                    type="range"
                                    min={0}
                                    max={1.6}
                                    step={0.01}
                                    value={busFaderVisualByKey[sliderToken] ?? 1}
                                    onInput={(e) => {
                                      beginLiveControlWindow();
                                      markBusSliderMoved();
                                      const raw = Number((e.target as HTMLInputElement).value);
                                      const nextVal = Number.isFinite(raw)
                                        ? Math.max(0, Math.min(1.6, raw))
                                        : 1;
                                      setBusFaderVisualByKey((prev) => ({ ...prev, [sliderToken]: nextVal }));
                                      setClickPresetBusGainsByVoice((prev) => {
                                        const voiceMap = { ...(prev[busVoice] ?? {}) };
                                        const cur = getClickPresetBusGainsForVoicePreset(
                                          prev,
                                          clickPresetBusGainsRef.current,
                                          busVoice,
                                          busPreset,
                                        );
                                        const row: ClickPresetBusGains = { ...cur, [key]: nextVal };
                                        const updatedVoice = { ...voiceMap, [busPreset]: row };
                                        const updated = { ...prev, [busVoice]: updatedVoice };
                                        clickPresetBusGainsByVoiceRef.current = updated;
                                        return updated;
                                      });
                                      scheduleClickPresetBusTwoBarsPreview();
                                    }}
                                    onChange={(e) => {
                                      beginLiveControlWindow();
                                      markBusSliderMoved();
                                      const raw = Number(e.target.value);
                                      const nextVal = Number.isFinite(raw)
                                        ? Math.max(0, Math.min(1.6, raw))
                                        : 1;
                                      setBusFaderVisualByKey((prev) => ({ ...prev, [sliderToken]: nextVal }));
                                      setClickPresetBusGainsByVoice((prev) => {
                                        const voiceMap = { ...(prev[busVoice] ?? {}) };
                                        const cur = getClickPresetBusGainsForVoicePreset(
                                          prev,
                                          clickPresetBusGainsRef.current,
                                          busVoice,
                                          busPreset,
                                        );
                                        const row: ClickPresetBusGains = { ...cur, [key]: nextVal };
                                        const updatedVoice = { ...voiceMap, [busPreset]: row };
                                        const updated = { ...prev, [busVoice]: updatedVoice };
                                        clickPresetBusGainsByVoiceRef.current = updated;
                                        return updated;
                                      });
                                      scheduleClickPresetBusTwoBarsPreview();
                                    }}
                                    onDoubleClick={(e) => {
                                      e.preventDefault();
                                      beginLiveControlWindow();
                                      setBusFaderVisualByKey((prev) => ({ ...prev, [sliderToken]: 1 }));
                                      setClickPresetBusGainsByVoice((prev) => {
                                        const voiceMap = { ...(prev[busVoice] ?? {}) };
                                        const cur = getClickPresetBusGainsForVoicePreset(
                                          prev,
                                          clickPresetBusGainsRef.current,
                                          busVoice,
                                          busPreset,
                                        );
                                        const row: ClickPresetBusGains = { ...cur, [key]: 1 };
                                        const updatedVoice = { ...voiceMap, [busPreset]: row };
                                        const updated = { ...prev, [busVoice]: updatedVoice };
                                        clickPresetBusGainsByVoiceRef.current = updated;
                                        return updated;
                                      });
                                      scheduleClickPresetBusTwoBarsPreview();
                                    }}
                                    onPointerDown={() => {
                                      beginLiveControlWindow();
                                      const hold = clickBusSliderHoldRef.current;
                                      if (hold.timer !== null) window.clearTimeout(hold.timer);
                                      hold.token = sliderToken;
                                      hold.moved = false;
                                      hold.timer = window.setTimeout(() => {
                                        const current = clickBusSliderHoldRef.current;
                                        if (current.token !== sliderToken || current.moved) return;
                                        current.timer = null;
                                        setBusFaderVisualByKey((prev) => ({ ...prev, [sliderToken]: 1 }));
                                        setClickPresetBusGainsByVoice((prev) => {
                                          const voiceMap = { ...(prev[busVoice] ?? {}) };
                                          const cur = getClickPresetBusGainsForVoicePreset(
                                            prev,
                                            clickPresetBusGainsRef.current,
                                            busVoice,
                                            busPreset,
                                          );
                                          const row: ClickPresetBusGains = { ...cur, [key]: 1 };
                                          const updatedVoice = { ...voiceMap, [busPreset]: row };
                                          const updated = { ...prev, [busVoice]: updatedVoice };
                                          clickPresetBusGainsByVoiceRef.current = updated;
                                          return updated;
                                        });
                                        scheduleClickPresetBusTwoBarsPreview();
                                      }, CLICK_BUS_SLIDER_HOLD_MS);
                                    }}
                                    onPointerEnter={() => {}}
                                    onPointerUp={() => {
                                      endLiveControlWindow();
                                      cancelBusSliderHold();
                                    }}
                                    onPointerCancel={() => {
                                      endLiveControlWindow();
                                      cancelBusSliderHold();
                                    }}
                                    onPointerLeave={() => {
                                      endLiveControlWindow();
                                      cancelBusSliderHold();
                                    }}
                                    className={busRowSliderClass}
                                  />
                                  <span className="w-7 shrink-0" aria-hidden />
                                      </>
                                    );
                                  })()}
                                </label>
                              ))}
                              <label className="-mt-1 flex items-center gap-2 w-full min-w-0 py-1 -mb-0.5 touch-manipulation">
                                <span className={labelColClass}>vol</span>
                                <input
                                  type="range"
                                  min={0}
                                  max={1.6}
                                  step={0.01}
                                  value={polyVoiceFaderVisual[volVoiceIdx] ?? 1}
                                  onChange={(e) => {
                                    beginLiveControlWindow();
                                    const raw = Number(e.target.value);
                                    const next = Number.isFinite(raw) ? Math.max(0, Math.min(1.6, raw)) : 1;
                                    setPolyVoiceFaderVisual((prev) => ({ ...prev, [volVoiceIdx]: next }));
                                    setPolyVoiceGains((prev) => {
                                      const updated: PolyVoiceGainMap = {
                                        ...prev,
                                        [volVoiceIdx]: next,
                                      };
                                      polyVoiceGainsRef.current = { ...updated };
                                      return updated;
                                    });
                                  }}
                                  onDoubleClick={() => {
                                    beginLiveControlWindow();
                                    setPolyVoiceFaderVisual((prev) => ({ ...prev, [volVoiceIdx]: 1 }));
                                    setPolyVoiceGains((prev) => {
                                      const updated: PolyVoiceGainMap = {
                                        ...prev,
                                        [volVoiceIdx]: DEFAULT_POLY_VOICE_GAINS[volVoiceIdx] ?? 1,
                                      };
                                      polyVoiceGainsRef.current = { ...updated };
                                      return updated;
                                    });
                                  }}
                                  onPointerDown={() => {
                                    beginLiveControlWindow();
                                  }}
                                  onPointerUp={() => {
                                    endLiveControlWindow();
                                  }}
                                  onPointerLeave={() => {
                                    endLiveControlWindow();
                                  }}
                                  onPointerCancel={() => {
                                    endLiveControlWindow();
                                  }}
                                  className={busRowSliderClass}
                                />
                                <span className="w-7 shrink-0 text-right text-[10px] text-slate-400 tabular-nums leading-tight">
                                  {Math.round((polyVoiceGains[volVoiceIdx] ?? 1) * 100)}%
                                </span>
                              </label>
                            </div>
                          );
                        })()}
                      </div>
                      <div className="grid grid-cols-4 gap-2.5 flex-1 min-h-0 content-start overflow-y-auto overflow-x-hidden pr-1.5 -mr-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[#2f4066] [&::-webkit-scrollbar-thumb]:rounded-full">
                        {CLICK_SOUND_PRESET_META.map((preset) => {
                          const selectedForTarget = polyMode
                            ? resolveClickSoundForPolyVoice(
                                activeClickVoiceTarget,
                                true,
                                clickSoundByPolyVoice,
                                clickSound,
                              )
                            : clickSound;
                          const isSelected = selectedForTarget === preset.mappedSound;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => {
                                const targetVoice = polyMode
                                  ? (activeClickVoiceTargetRef.current as 0 | 1 | 2)
                                  : 0;
                                if (polyMode) {
                                  if (targetVoice === 0) {
                                    setClickSound(preset.mappedSound);
                                    clickSoundRef.current = preset.mappedSound;
                                    const next = { ...clickSoundByPolyVoiceRef.current };
                                    delete next[0];
                                    clickSoundByPolyVoiceRef.current = { ...next };
                                    setClickSoundByPolyVoice(next);
                                  } else {
                                    const next = { ...clickSoundByPolyVoiceRef.current };
                                    if (preset.mappedSound === clickSoundRef.current) delete next[targetVoice];
                                    else next[targetVoice] = preset.mappedSound;
                                    clickSoundByPolyVoiceRef.current = { ...next };
                                    setClickSoundByPolyVoice(next);
                                  }
                                } else {
                                  setClickSound(preset.mappedSound);
                                  clickSoundRef.current = preset.mappedSound;
                                }
                                // Force immediate snapshot sync for click-type changes.
                                // Prevents losing click preset in slot save due to async UI/state races.
                                startTransition(() => {
                                  const slot = activeSnapshotRef.current;
                                  setSnapshots((prev) => {
                                    const cur = prev[slot] ?? createEmptySnapshot();
                                    return {
                                      ...prev,
                                      [slot]: {
                                        ...cur,
                                        clickSound: clickSoundRef.current,
                                        clickSoundByPolyVoice: { ...clickSoundByPolyVoiceRef.current },
                                      },
                                    };
                                  });
                                });
                                playTwoBarsPreviewFromGrid(preset.mappedSound);
                              }}
                              className={`rounded-xl border p-3 min-h-[64px] text-center flex items-center justify-center transition-all ${
                                isSelected
                                  ? 'bg-[#24365c] border-[#5a7cc5] text-white'
                                  : 'bg-[#131a2a] border-[#2a385b] text-slate-300 hover:text-white hover:bg-[#1a243b]'
                              }`}
                            >
                              <div className="text-[10px] font-semibold leading-tight">{preset.label}</div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <>
                  <div className="flex justify-between items-center text-slate-300 font-bold text-[11px] uppercase tracking-wider">
                    <span className={`flex items-center gap-2 text-blue-300 ${lowPerfMode ? '' : 'drop-shadow-[0_0_8px_rgba(59,130,246,0.5)]'}`}>
                      <Dices size={14} /> Randomizer
                    </span>
                    <span className="text-[10px] font-medium normal-case tracking-normal text-slate-500">
                      {APP_COMMIT_VERSION}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                     <button 
                       onClick={() => toggleRandomFeature('pulsation')}
                       className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                         randomPulsation 
                           ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
                           : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                       }`}
                     >
                       Pulse
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('pattern')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomPattern 
                            ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Accent
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('speed')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomSpeed 
                            ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                       Divs
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('barSpeed')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomBarSpeed 
                            ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                       Length
                     </button>
                  </div>

                  <div className="flex flex-col gap-2 px-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 font-bold tracking-wider uppercase">
                        Chaos
                      </span>
                      <span className="text-purple-300 font-mono text-xs font-bold">{chaosLevel}</span>
                     </div>
                    <div className="relative w-full flex items-center">
                    <input 
                       type="range" 
                      min={0}
                      max={100}
                      value={chaosLevel}
                      onChange={(e) => {
                        const raw = parseInt(e.target.value, 10);
                        handleChaosSliderChange(raw);
                        // Training: DOM-thumb мог "убежать" за пальцем при drag'е — фиксируем обратно к chaos.
                        if (chaosRampActiveRef.current) {
                          e.currentTarget.value = String(chaosLevelRef.current);
                        }
                      }}
                      onPointerDown={handleChaosSliderPointerDown}
                      onPointerMove={handleChaosSliderPointerMove}
                      onPointerUp={() => {
                        cancelChaosRampPress();
                        flushChaosToActiveSnapshot();
                      }}
                      onPointerCancel={() => {
                        cancelChaosRampPress();
                        flushChaosToActiveSnapshot();
                      }}
                      onBlur={() => flushChaosToActiveSnapshot()}
                        className="w-full h-2 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110"
                      />
                      {chaosRampActive ? (
                        <>
                          <span
                            aria-hidden
                            className="pointer-events-none absolute top-1/2 w-4 h-4 rounded-full -translate-y-1/2 -translate-x-1/2"
                            style={{ left: `calc(8px + (100% - 16px) * ${chaosLevel / 100})` }}
                          >
                            <span className="absolute inset-0 rounded-full bg-purple-400/70 animate-ping" />
                            <span className="absolute inset-0 rounded-full ring-2 ring-purple-300/60" />
                          </span>
                          {chaosRampTarget !== null && Math.abs(chaosRampTarget - chaosLevel) >= 1 ? (
                            <span
                              aria-hidden
                              className="pointer-events-none absolute top-1/2 w-3 h-3 rounded-full -translate-y-1/2 -translate-x-1/2"
                              style={{ left: `calc(8px + (100% - 16px) * ${chaosRampTarget / 100})` }}
                            >
                              <span className="absolute inset-0 rounded-full ring-2 ring-fuchsia-400/80" />
                            </span>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="w-full h-px bg-[#1e2a45]/80 my-0.5"></div>

                  <div className="flex items-center justify-between gap-2">
                    <span className={`shrink-0 text-[11px] font-bold tracking-wider uppercase text-blue-300 ${lowPerfMode ? '' : 'drop-shadow-[0_0_8px_rgba(59,130,246,0.5)]'}`}>
                      Click Sound
                    </span>
                    <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setIsClickSoundSelectorOpen(true)}
                        className="group flex min-w-0 max-w-[min(100%,11rem)] flex-1 items-center justify-center rounded-lg border border-[#2f4066]/50 bg-[#0b101e] px-2 py-1 transition-all hover:bg-[#151d2f] sm:max-w-[13rem]"
                      >
                        <span className="truncate text-center text-[11px] font-semibold text-slate-300 transition-colors group-hover:text-white">
                          {CLICK_SOUND_PRESET_META.find((preset) => preset.mappedSound === clickSound)?.label ?? 'Classic'}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="w-full h-px bg-[#1e2a45]/80 my-0.5"></div>
                  <div className="w-1/2 self-center flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setLowPerfMode((v) => !v)}
                      className={`flex-1 flex items-center justify-center py-1.5 px-2 rounded-md text-[11px] font-bold transition-colors border ${
                        lowPerfMode
                          ? 'bg-emerald-500/20 border-emerald-300/70 text-emerald-200'
                          : 'bg-[#16332f]/35 border-emerald-700/50 text-emerald-300 hover:text-emerald-200 hover:bg-[#16332f]/60'
                      }`}
                    >
                      <span className="whitespace-nowrap">Potato Mode</span>
                    </button>
                    <button
                      type="button"
                      onPointerDown={() => {
                        midiHoldAteClickRef.current = false;
                        if (midiHoldTimerRef.current !== null) {
                          window.clearTimeout(midiHoldTimerRef.current);
                          midiHoldTimerRef.current = null;
                        }
                        midiHoldTimerRef.current = window.setTimeout(() => {
                          midiHoldTimerRef.current = null;
                          midiHoldAteClickRef.current = true;
                          void handleExportMidi({ autoAlignTwoVoice: true });
                        }, 520);
                      }}
                      onPointerUp={() => {
                        if (midiHoldTimerRef.current !== null) {
                          window.clearTimeout(midiHoldTimerRef.current);
                          midiHoldTimerRef.current = null;
                        }
                      }}
                      onPointerLeave={() => {
                        if (midiHoldTimerRef.current !== null) {
                          window.clearTimeout(midiHoldTimerRef.current);
                          midiHoldTimerRef.current = null;
                        }
                      }}
                      onPointerCancel={() => {
                        if (midiHoldTimerRef.current !== null) {
                          window.clearTimeout(midiHoldTimerRef.current);
                          midiHoldTimerRef.current = null;
                        }
                      }}
                      onClick={() => {
                        if (midiHoldAteClickRef.current) {
                          midiHoldAteClickRef.current = false;
                          return;
                        }
                        void handleExportMidi();
                      }}
                      className="w-8 h-8 rounded-md border bg-[#1a253c]/60 border-[#2a385b] text-slate-300 hover:text-white hover:bg-[#1a243b] transition-colors flex items-center justify-center"
                    >
                      <span className="text-[7px] font-semibold tracking-wide">MIDI</span>
                    </button>
                    {/* <button
                      type="button"
                      title="Скачать markdown-лог урока"
                      onClick={() => {
                        try {
                          const hasParentLog = lessonLogger.getMeta() !== null && lessonLogger.getBars().length > 0;
                          if (hasParentLog) {
                            downloadAestheticScore();
                            return;
                          }
                          const fallbackMd = buildGridLessonLogMarkdown({
                            tempoBpm: tempoRef.current,
                            bars: barsRef.current,
                            syllablesDefault: syllablesRef.current,
                            customSyllables: customSyllablesRef.current,
                            accentsByLane: accentsByLaneRef.current,
                            taDingKeysByLane: taDingKeysByLaneRef.current,
                            customSubdivisions: customSubdivisionsRef.current,
                            customMultipliers: customMultipliersRef.current,
                            deadCells: deadCellsRef.current,
                            polyMode: polyModeRef.current,
                            polyVoices: polyVoicesRef.current,
                            progressiveDensityMode: progressiveDensityModeRef.current,
                            deSyncJatiActive: deSyncJatiActiveRef.current,
                            deSyncCycleLength: deSyncCycleLengthRef.current,
                            firstBeatAccent: firstBeatAccentRef.current,
                            firstBeatAccentByLane: firstBeatAccentByLaneRef.current,
                            firstBeatDingSuppressedRows: firstBeatDingSuppressedRowsRef.current,
                            mixerLayerMode: mixerLayerModeRef.current,
                            trainerMode: trainerModeRef.current,
                            trainerHoldMute: trainerHoldMuteRef.current,
                            syllableReadMuteMode: syllableReadMuteModeRef.current,
                            dictantMode: dictantModeRef.current,
                          });
                          downloadAestheticScore({ text: fallbackMd, seed: 0 });
                        } catch (err) {
                          console.error('[LOG export] failed', err);
                          const safeError = err instanceof Error ? err.message : String(err);
                          const emergencyMd = [
                            '# Lesson Log',
                            '',
                            '## Export Error',
                            `- message: ${safeError}`,
                            `- tempo: ${tempoRef.current}`,
                            `- bars: ${barsRef.current}`,
                            `- poly: ${polyModeRef.current ? `on (${polyVoicesRef.current} voices)` : 'off'}`,
                          ].join('\n');
                          downloadAestheticScore({ text: `${emergencyMd}\n`, seed: 0 });
                        }
                      }}
                      className="w-8 h-8 rounded-md border bg-[#1a253c]/60 border-[#2a385b] text-slate-300 hover:text-white hover:bg-[#1a243b] transition-colors flex items-center justify-center"
                    >
                      <span className="text-[7px] font-semibold tracking-wide">LOG</span>
                    </button> */}
                  </div>
                  <div className="w-full h-px bg-[#1e2a45]/80 my-0.5"></div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold tracking-wider uppercase text-blue-300">Polyrhythm</span>
                      <button
                        type="button"
                        onClick={() => {
                          flushSync(() => {
                            setPolyMode((prev) => !prev);
                          });
                        }}
                        className={`px-3 py-1.5 rounded-md text-[11px] font-bold border transition-colors ${
                          polyMode
                            ? 'bg-blue-500/20 border-blue-400/70 text-blue-200'
                            : 'bg-[#1a253c]/50 border-[#2f4066] text-slate-400 hover:text-slate-300'
                        }`}
                      >
                        {polyMode ? 'On' : 'Off'}
                      </button>
                    </div>
                    {polyMode ? (
                      <div className="grid grid-cols-3 gap-2">
                        {/* {[2, 3, 4].map((voices) => ( */}
                        {[2, 3].map((voices) => (
                          <button
                            key={voices}
                            type="button"
                            onClick={() => {
                              flushSync(() => {
                                setPolyVoices(parsePolyVoices(voices));
                              });
                            }}
                            className={`py-1.5 rounded-md text-xs font-bold border transition-colors ${
                              polyVoices === voices
                                ? 'bg-blue-600/25 border-blue-400/70 text-blue-200'
                                : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            {voices} pulses
                          </button>
                        ))}
                        {/* ))} */}
                      </div>
                    ) : null}
                  </div>
                  </>
                  )}
                    </div>
                  </div>
                </div>
              ) : (
            <>
              {isPanelExpanded ? (
                <div className="px-2.5 pt-3 pb-1">
                  <div className="flex items-center gap-2">
                    <button 
                      type="button"
                      onPointerDown={beginTempoMinusHold}
                      onPointerUp={endTempoHoldRepeat}
                      onPointerLeave={endTempoHoldRepeat}
                      onPointerCancel={endTempoHoldRepeat}
                      onClick={() => {
                        if (tempoMinusHoldAteClickRef.current) {
                          tempoMinusHoldAteClickRef.current = false;
                          return;
                        }
                        applyTempoImmediate(tempoUi - 1);
                      }}
                      className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
                    >
                      <Minus size={18} strokeWidth={2.5} />
                    </button>
                    <TempoSliderTrack
                      tempoUi={tempoUi}
                      tempoRef={tempoRef}
                      scheduleTempoCommit={scheduleTempoCommit}
                      flushTempoCommit={flushTempoCommit}
                      tempoInlineEditing={tempoInlineEditing}
                      tempoInlineFocusSlot={tempoInlineFocusSlot}
                      tempoSliderSlot="pnl"
                      tempoManualText={tempoManualText}
                      onTempoManualTextChange={setTempoManualText}
                      onCommitTempoInline={commitTempoInlineEdit}
                      onCancelTempoInline={cancelTempoInlineEdit}
                      onBeginInlineEdit={beginTempoInlineEdit}
                      className="flex-1 relative flex items-center h-8"
                    />
                    <button 
                      type="button"
                      onPointerDown={beginTempoPlusHold}
                      onPointerUp={endTempoHoldRepeat}
                      onPointerLeave={endTempoHoldRepeat}
                      onPointerCancel={endTempoHoldRepeat}
                      onClick={() => {
                        if (tempoPlusHoldAteClickRef.current) {
                          tempoPlusHoldAteClickRef.current = false;
                          return;
                        }
                        applyTempoImmediate(tempoUi + 1);
                      }}
                      className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
                    >
                      <Plus size={18} strokeWidth={2.5} />
                    </button>
                  </div>
                </div>
              ) : null}
              <div
                className={`grid ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
              >
                <div
                  className={`overflow-hidden flex flex-col ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'px-2.5 pb-2 pt-0' : 'px-2.5 py-0'}`}
                >
                  <div className="flex flex-col">
                    <div className="flex justify-between items-center px-1 translate-y-[3px]">
                      {[1, 2, 3, 4, 5, 6, 7].map((num) => {
                        const isActive = activeSnapshot === num;
                        const hasData =
                          isActive || snapSlotLooksUsed(snapshots[num] ?? createEmptySnapshot());
                        
                        return (
                          <button 
                            key={num} 
                            type="button"
                            ref={(el) => {
                              snapshotSlotButtonRefs.current[num] = el;
                            }}
                            className={`w-8 h-8 flex items-center justify-center rounded-full text-[13px] font-bold transition-all touch-none select-none ${
                              isActive
                                ? 'bg-[#1e2a45] text-white shadow-sm ring-1 ring-[#3a5080] scale-110' 
                                : hasData 
                                  ? 'text-slate-300 bg-[#1e2a45]/30 hover:bg-[#1e2a45]/60 hover:text-white'
                                  : 'text-slate-600 hover:text-slate-400'
                            }`}
                            onPointerDown={() => {
                              snapshotHoldAteClickRef.current = false;
                              snapshotHoldSlotRef.current = num;
                              if (snapshotHoldTimerRef.current !== null) {
                                window.clearTimeout(snapshotHoldTimerRef.current);
                                snapshotHoldTimerRef.current = null;
                              }
                              snapshotHoldTimerRef.current = window.setTimeout(() => {
                                snapshotHoldTimerRef.current = null;
                                const s = snapshotHoldSlotRef.current;
                                snapshotHoldSlotRef.current = null;
                                if (s == null) return;
                                snapshotHoldAteClickRef.current = true;
                                openSnapshotClipMenu(s);
                              }, SNAPSHOT_SLOT_HOLD_MS);
                            }}
                            onPointerUp={() => {
                              if (snapshotHoldTimerRef.current !== null) {
                                window.clearTimeout(snapshotHoldTimerRef.current);
                                snapshotHoldTimerRef.current = null;
                              }
                            }}
                            onPointerCancel={() => {
                              if (snapshotHoldTimerRef.current !== null) {
                                window.clearTimeout(snapshotHoldTimerRef.current);
                                snapshotHoldTimerRef.current = null;
                              }
                            }}
                            onClick={() => {
                              if (snapshotHoldAteClickRef.current) {
                                snapshotHoldAteClickRef.current = false;
                                return;
                              }
                              loadSnapshot(num);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                            }}
                          >
                            {num}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
            </div>
            </>
          )}

          {/* Bars / Syllables: скрыты пока открыто окно Settings (Randomizer). */}
          {!showRandomSettings ? (
          <div className={`px-2.5 pt-1 pb-3 flex flex-col mb-2 ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'gap-4' : 'gap-0'}`}>
            <div className="flex items-center gap-2">
              <div className="flex items-center w-12 justify-between pr-1 shrink-0">
                <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">Bars</span>
                <button 
                  type="button"
                  onPointerDown={handlePressStarPointerDown}
                  onPointerMove={handlePressStarPointerMove}
                  onPointerUp={cancelPressStarLongPress}
                  onPointerLeave={cancelPressStarLongPress}
                  onPointerCancel={cancelPressStarLongPress}
                  onClick={() => {
                    if (consumePressStarLongPress()) return;
                    setFrozenScale((prev) => {
                      const next = prev !== null ? null : bars;
                      const firstRowHeight = rowRefs.current[0]?.getBoundingClientRect().height ?? null;
                      if (next !== null) setFrozenRowHeightPx(firstRowHeight);
                      else setFrozenRowHeightPx(null);
                      if (next !== null) {
                        const byRow: Record<number, number> = {};
                        for (let i = 0; i < bars; i++) {
                          const h = rowRefs.current[i]?.getBoundingClientRect().height;
                          if (typeof h === 'number' && Number.isFinite(h) && h > 0) byRow[i] = h;
                        }
                        setFrozenRowHeightsByRIdx(byRow);
                      } else {
                        setFrozenRowHeightsByRIdx({});
                      }
                      return next;
                    });
                  }}
                  className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-all duration-300 ${
                    isPressStarLongPressing
                      ? `bg-violet-500/25 text-violet-300 ring-1 ring-violet-500/60 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(167,139,250,0.35)]'}`
                      : pressMatrixArmSourceUi !== null && frozenScale !== null
                        ? `bg-violet-500/25 text-violet-300 ring-1 ring-violet-500/60 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(167,139,250,0.35)]'}`
                        : pressMatrixArmSourceUi !== null
                          ? `bg-violet-500/25 text-violet-300 ring-1 ring-violet-500/60 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(167,139,250,0.35)]'}`
                          : frozenScale !== null 
                            ? `bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/50 ${lowPerfMode ? '' : 'shadow-[0_0_8px_rgba(59,130,246,0.3)]'}` 
                            : 'bg-[#1e2a45]/40 text-slate-400 hover:text-slate-200 hover:bg-[#1e2a45] ring-1 ring-[#2f4066]/30'
                  }`}
                  aria-label={frozenScale !== null ? 'Unfreeze row height' : 'Freeze row scale'}
                >
                  <Snowflake size={12} />
                </button>
              </div>
              <StructuralSlider
                label="Bars"
                min={barsStructuralRange.min}
                max={barsStructuralRange.max}
                step={barsStructuralRange.step}
                value={bars}
                colorClass={
                  pressMatrixArmSourceUi !== null
                    ? '[&::-webkit-slider-thumb]:bg-violet-500 [&::-moz-range-thumb]:bg-violet-500'
                    : '[&::-webkit-slider-thumb]:bg-blue-400 [&::-moz-range-thumb]:bg-blue-400'
                }
                thumbIdleArm={{
                  holdMs: PRESS_LONG_PRESS_MS,
                  slopPx: PRESS_BARS_SLIDER_ARM_SLOP_PX,
                  cancelArmOnValueChange: true,
                  onArm: handleBarsSliderThumbIdleArm,
                }}
                onThumbPointerSessionEnd={handleBarsSliderThumbSessionEnd}
                onBeginDrag={() => {
                  barsSliderDraggingRef.current = true;
                  attachSliderWindowListeners();
                  beginLiveControlWindow();
                }}
                onLiveChange={(next) => {
                  applyBarsWithPotatoFreeze(next);
                }}
                onCommit={(next) => {
                  applyBarsWithPotatoFreeze(next);
                }}
              />
              <div className="w-5 shrink-0 flex justify-end">
                {barsInlineEditing ? (
                  <input
                    ref={barsInlineInputRef}
                    type="text"
                    inputMode="numeric"
                    value={barsManualText}
                    onChange={(e) => setBarsManualText(e.target.value)}
                    onBlur={() => commitBarsInlineEdit()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitBarsInlineEdit();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelBarsInlineEdit();
                      }
                    }}
                    className="w-full text-xs font-bold text-slate-300 text-right bg-transparent hover:bg-[#1e2a45] focus:bg-[#1e2a45] rounded outline-none transition-colors py-1 cursor-text select-text"
                  />
                ) : (
                  <span
                    onDoubleClick={() => beginBarsInlineEdit()}
                    className="w-full text-xs font-bold text-slate-300 text-right bg-transparent hover:bg-[#1e2a45] rounded outline-none transition-colors py-1 cursor-text select-none"
                    title="Double click to edit (1-100)"
                  >
                    {bars}
                  </span>
                )}
              </div>
            </div>

            <div className={`grid ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="relative h-6 w-full">
                  {/* Global Syllables Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${((activeEditCell !== null) || activeEditRow !== null) ? 'opacity-0 pointer-events-none scale-y-50' : 'opacity-100 scale-y-100'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold w-12 shrink-0">Syllbs</span>
                    <StructuralSlider
                      label="Syllbs"
                      min={1}
                      max={9}
                      value={syllables}
                      colorClass="[&::-webkit-slider-thumb]:bg-emerald-500 [&::-moz-range-thumb]:bg-emerald-500"
                      onBeginDrag={() => {
                        syllablesSliderDraggingRef.current = true;
                        attachSliderWindowListeners();
                        beginLiveControlWindow();
                      }}
                      onLiveChange={(next) => {
                        applyGlobalSyllablesFromSlider(String(next));
                      }}
                      onCommit={(next) => {
                        applyGlobalSyllablesFromSlider(String(next));
                      }}
                    />
                    <div className="w-5 shrink-0 flex justify-end">
                      <span className="w-full py-1 text-xs font-bold text-slate-300 text-right">{syllables}</span>
                    </div>
                  </div>

                  {/* Specific Bar Syllables Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${activeEditRow !== null && activeEditCell === null ? 'opacity-100 scale-y-100 z-10' : 'opacity-0 pointer-events-none scale-y-50 translate-y-4'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-purple-400 font-bold w-12 shrink-0 truncate">Bar {activeEditRow !== null ? activeEditRow + 1 : ''}</span>
                    <input 
                      type="range" 
                      min="1" 
                      max="9" 
                      value={activeEditRow !== null ? (customSyllables[activeEditRow] || syllables) : 1} 
                      onChange={(e) => {
                        if (activeEditRow !== null) {
                          setCustomSyllables(prev => ({...prev, [activeEditRow]: parseInt(e.target.value)}));
                        }
                      }} 
                      className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
                    />
                    <div className="w-5 shrink-0 flex items-center justify-end gap-0.5">
                      <span className="text-[11px] font-bold text-purple-300 text-right">{activeEditRow !== null ? (customSyllables[activeEditRow] || syllables) : ''}</span>
                      <button onClick={() => setActiveEditRow(null)} className="w-[14px] h-[14px] flex shrink-0 items-center justify-center rounded-full bg-purple-900/60 text-[8px] text-purple-300 hover:bg-purple-800 transition-colors">✕</button>
                    </div>
                  </div>

                  {/* Specific Cell Subdivisions Slider */}
                  <div
                    ref={cellDivsSliderPanelRef}
                    className={`absolute inset-0 flex items-center gap-2 ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${activeEditCell !== null ? 'opacity-100 scale-y-100 z-20' : 'opacity-0 pointer-events-none scale-y-50 translate-y-4'}`}
                  >
                    <span className="text-[11px] uppercase tracking-wider text-purple-400 font-bold w-12 shrink-0 truncate">Divs</span>
                    <input 
                      type="range" 
                      min="0" 
                      max="9" 
                      value={activeEditCell !== null ? (() => {
                        const config = ensureCellConfig(
                          activeEditCell,
                          customSubdivisions[activeEditCell] || 1,
                          cellConfigs,
                          cellStepMasks,
                        );
                        return config.isMuted ? 0 : config.subdivs;
                      })() : 1} 
                      onChange={(e) => {
                        const nextValue = parseInt(e.target.value, 10);
                        if (Number.isNaN(nextValue) || nextValue < 0 || nextValue > 9) return;
                        if (activeEditCell === null) return;
                        handleCellDivUpdate(activeEditCell, nextValue);
                      }} 
                      className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
                    />
                    <div className="w-5 shrink-0 flex items-center justify-end">
                      <span className="text-[11px] font-bold text-purple-300 text-right">{activeEditCell !== null ? (() => {
                        const config = ensureCellConfig(
                          activeEditCell,
                          customSubdivisions[activeEditCell] || 1,
                          cellConfigs,
                          cellStepMasks,
                        );
                        return config.isMuted ? 0 : config.subdivs;
                      })() : ''}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          ) : null}
          
          {/* Collapse Arrow Toggle: тап — свернуть/развернуть; удержание как слот снепшота — заморозка сворачивания (снять повторным удержанием). */}
          <button
            type="button"
            onPointerDown={(e) => {
              const el = e.currentTarget;
              panelChevronHoldLongPressReadyRef.current = false;
              panelChevronHoldAteClickRef.current = false;
              if (panelChevronHoldTimerRef.current !== null) {
                window.clearTimeout(panelChevronHoldTimerRef.current);
                panelChevronHoldTimerRef.current = null;
              }
              try {
                el.setPointerCapture(e.pointerId);
              } catch {
                /* already captured */
              }
              panelChevronHoldTimerRef.current = window.setTimeout(() => {
                panelChevronHoldTimerRef.current = null;
                panelChevronHoldLongPressReadyRef.current = true;
              }, SNAPSHOT_SLOT_HOLD_MS);
            }}
            onPointerUp={(e) => {
              const el = e.currentTarget;
              if (panelChevronHoldTimerRef.current !== null) {
                window.clearTimeout(panelChevronHoldTimerRef.current);
                panelChevronHoldTimerRef.current = null;
              }
              const ready = panelChevronHoldLongPressReadyRef.current;
              panelChevronHoldLongPressReadyRef.current = false;
              if (ready) {
                setPanelCollapseFrozen((f) => !f);
                panelChevronHoldAteClickRef.current = true;
              }
              try {
                el.releasePointerCapture(e.pointerId);
              } catch {
                /* */
              }
            }}
            onPointerLeave={() => {
              if (panelChevronHoldTimerRef.current !== null) {
                window.clearTimeout(panelChevronHoldTimerRef.current);
                panelChevronHoldTimerRef.current = null;
              }
            }}
            onPointerCancel={(e) => {
              const el = e.currentTarget;
              if (panelChevronHoldTimerRef.current !== null) {
                window.clearTimeout(panelChevronHoldTimerRef.current);
                panelChevronHoldTimerRef.current = null;
              }
              panelChevronHoldLongPressReadyRef.current = false;
              try {
                el.releasePointerCapture(e.pointerId);
              } catch {
                /* */
              }
            }}
            onClick={() => {
              if (panelChevronHoldAteClickRef.current) {
                panelChevronHoldAteClickRef.current = false;
                return;
              }
              setIsPanelExpanded((prev) => {
                if (panelCollapseFrozenRef.current && prev) return true;
                return !prev;
              });
            }}
            className={`group absolute bottom-0 left-4 z-30 flex h-8 w-8 translate-y-1/2 touch-none select-none items-center justify-center overflow-hidden rounded-full border shadow-lg ${
              panelCollapseFrozen
                ? 'border-teal-300/55 text-emerald-100 shadow-[0_0_18px_rgba(110,231,183,0.4)] ring-2 ring-emerald-300/45'
                : 'border-[#2f4066] text-slate-400 hover:text-white'
            }`}
          >
            {/* Тройной серый «пирог» — всегда снизу; мятный слой только в режиме заморозки. */}
            <span
              className="pointer-events-none absolute inset-0 z-0 rounded-full"
              aria-hidden
            >
              <span className="absolute inset-0 rounded-full bg-[#323e56]" />
              <span className="absolute inset-[2px] rounded-full bg-[#2a3448]" />
              <span className="absolute inset-[5px] rounded-full bg-[#1e2a45]" />
            </span>
            {panelCollapseFrozen ? (
              <span
                className="pointer-events-none absolute inset-0 z-[1] rounded-full bg-emerald-300/22 shadow-[inset_0_0_12px_rgba(52,211,153,0.28)]"
                aria-hidden
              />
            ) : null}
            <span className="relative z-[3] flex items-center justify-center">
              {isPanelExpanded ? <ChevronUp size={16} strokeWidth={3} /> : <ChevronDown size={16} strokeWidth={3} />}
            </span>
          </button>
        </div>

        <div className={`flex w-full min-h-0 flex-1 flex-col gap-1 ${isClickSoundSelectorOpen ? 'justify-end' : ''}`}>
        {!isClickSoundSelectorOpen ? (
        <SequencerGrid
          gridRef={gridRef}
          bars={bars}
          syllables={syllables}
          lowPerfMode={lowPerfMode}
          isTaEditorMode={isTaEditorMode}
          isDeadCellsEditorMode={isDeadCellsEditorMode}
          isStartBarPickMode={isStartBarPickMode}
          startBarPickHighlight={startBarPickHighlight}
          onStartBarPick={handleStartBarPick}
          accentMapVersion={accentMapVersion}
          forceFirstBeatEditorFrames={forceFirstBeatEditorFrames}
          canShowDefaultTaInNormal={canShowDefaultTaInNormal}
          firstBeatEditorSuppressedSig={firstBeatEditorSuppressedSig}
          deadStartByRow={deadStartByRow}
          deadDisplayByRow={deadDisplayByRow}
          bpm={tempoUi}
          customSyllables={customSyllables}
          customCellSyllables={customCellSyllables}
          customSubdivisions={customSubdivisions}
          cellStepMasks={cellStepMasks}
          cellConfigs={cellConfigs}
          customMultipliers={customMultipliers}
          rowRuntimeContexts={rowRuntimeContexts}
          accents={accentsUi}
          taDingKeys={visibleTaDingKeys}
          pulseMeterUnlinked={pulseMeterUnlinked}
          jatiPulseActiveByRow={jatiPulseActiveByRow}
          isPlaying={isPlaying}
          autoscrollVirtualRowsEnabled={autoscrollVirtualRowsEnabled}
          activePos={activePos}
          activePositions={activePositions}
          polyMode={polyMode}
          polyVoices={polyVoices}
          displayScaleBars={displayScaleBars}
          useFixedFlex={useFixedFlex}
          useFrozenRowHeight={frozenScale !== null && bars !== frozenScale}
          frozenRowHeightPx={frozenRowHeightPx}
          frozenRowHeightsByRIdx={frozenRowHeightsByRIdx}
          allBarsFitViewport={allBarsFitViewport}
          activeEditRow={activeEditRow}
          activeEditCell={activeEditCell}
          sequencerGridRowActionsRef={sequencerGridRowActionsRef}
          setRowElStable={setRowElStable}
        />
        ) : null}

        {/* Bottom Actions */}
        <div className="flex h-[60px] shrink-0 gap-1">
          {/* Randomizer: короткий тап — префилл всех тактов. В parent-режиме long-press отключён. */}
                <button 
            type="button"
            disabled={isDeadCellsEditorMode}
            aria-label="Randomizer"
            onPointerDown={() => {
              if (isDeadCellsEditorMode) return;
              randomDiceHoldAteClickRef.current = false;
              randomDicePointerTapHandledRef.current = false;
              if (randomModeRef.current === 'parent') {
                randomDiceHoldStartedAtRef.current = null;
                if (randomDiceHoldTimerRef.current !== null) {
                  window.clearTimeout(randomDiceHoldTimerRef.current);
                  randomDiceHoldTimerRef.current = null;
                }
                return;
              }
              randomDiceHoldStartedAtRef.current = Date.now();
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
              randomDiceHoldTimerRef.current = window.setTimeout(() => {
                randomDiceHoldTimerRef.current = null;
                const next = !randomModeEnabledRef.current;
                randomModeEnabledRef.current = next;
                setRandomModeEnabled(next);
                if (next) applyImmediateRandomOnEnable();
                randomDiceHoldAteClickRef.current = true;
              }, RANDOM_DICE_PREFILL_HOLD_MS);
                  }}
                  onPointerUp={() => {
              if (isDeadCellsEditorMode) return;
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
              const startedAt = randomDiceHoldStartedAtRef.current;
              randomDiceHoldStartedAtRef.current = null;
              if (randomDiceHoldAteClickRef.current) return;
              if (
                randomModeRef.current !== 'parent' &&
                startedAt !== null &&
                Date.now() - startedAt >= RANDOM_DICE_PREFILL_HOLD_MS
              ) {
                const next = !randomModeEnabledRef.current;
                randomModeEnabledRef.current = next;
                setRandomModeEnabled(next);
                if (next) applyImmediateRandomOnEnable();
                randomDiceHoldAteClickRef.current = true;
                return;
              }
              randomDicePointerTapHandledRef.current = true;
              prefillAllTactsRandomizer();
                  }}
                  onPointerLeave={() => {
              if (isDeadCellsEditorMode) return;
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
              randomDiceHoldStartedAtRef.current = null;
            }}
            onPointerCancel={() => {
              if (isDeadCellsEditorMode) return;
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
              randomDiceHoldStartedAtRef.current = null;
                      }}
                      onClick={() => {
              if (isDeadCellsEditorMode) return;
              if (randomDiceHoldAteClickRef.current) {
                randomDiceHoldAteClickRef.current = false;
                return;
              }
              if (randomDicePointerTapHandledRef.current) {
                randomDicePointerTapHandledRef.current = false;
                return;
              }
              prefillAllTactsRandomizer();
            }}
            className={`flex-1 rounded-xl border flex justify-center items-center transition-all duration-200 relative ${
              randomDiceMintFlash
                ? `bg-teal-500/25 border-teal-300/75 text-teal-100 ${lowPerfMode ? '' : 'shadow-[0_0_22px_rgba(45,212,191,0.55)]'} ring-2 ring-teal-300/70`
                : isDeadCellsEditorMode
                ? 'bg-[#161f33] border-[#23314f] text-slate-600 opacity-45 cursor-not-allowed'
                : randomMode !== 'parent' && randomModeEnabled
                ? `bg-blue-600/30 border-blue-400/60 ${lowPerfMode ? '' : 'shadow-[0_0_15px_rgba(59,130,246,0.3)]'} text-blue-200`
                : 'bg-[#161f33] border-[#23314f] text-slate-400 hover:text-slate-200 hover:bg-[#1a253c]'
            }`}
          >
            <Dices size={24} />
          </button>
          
          {/* First Beat Accent ("Ta"): тап — глобальный Ta; удерживание — сетка правки Ta без автовключения Ta. */}
          {/* FRAGILE — bottom Ta control: tap vs hold and poly flushSync lane sync; see docs reserve-hub 02. */}
          <button
            type="button"
            disabled={isDeadCellsEditorMode}
            onPointerDown={() => {
              if (isDeadCellsEditorMode) return;
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
              cancelTaHoldFillAnim();
              setIsTaButtonPressed(true);
              taHoldAteClickRef.current = false;
              /* Вход в Ta editor — после паузы заливка включается сразу целиком (без RAF); выход long-press — без заливки. */
              if (!isTaEditorModeRef.current) {
                taHoldFillSnapTimerRef.current = window.setTimeout(() => {
                  taHoldFillSnapTimerRef.current = null;
                  setTaHoldFill(1);
                }, TA_EDITOR_HOLD_FILL_DEAD_MS);
              }
              taHoldTimerRef.current = window.setTimeout(() => {
                taHoldTimerRef.current = null;
                taHoldAteClickRef.current = true;
                setIsTaButtonPressed(false);
                cancelTaHoldFillAnim();
                if (isTaEditorModeRef.current) {
                  setIsTaEditorMode(false);
                } else {
                  setIsTaEditorMode(true);
                }
              }, TA_EDITOR_HOLD_MS);
            }}
            onPointerUp={() => {
              if (isDeadCellsEditorMode) return;
              setIsTaButtonPressed(false);
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
              cancelTaHoldFillAnim();
            }}
            onPointerLeave={() => {
              if (isDeadCellsEditorMode) return;
              setIsTaButtonPressed(false);
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
              cancelTaHoldFillAnim();
            }}
            onPointerCancel={() => {
              if (isDeadCellsEditorMode) return;
              setIsTaButtonPressed(false);
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
              cancelTaHoldFillAnim();
            }}
            onClick={() => {
              if (isDeadCellsEditorMode) return;
              if (taHoldAteClickRef.current) {
                taHoldAteClickRef.current = false;
                return;
              }
              if (isTaEditorModeRef.current) {
                setIsTaEditorMode(false);
                return;
              }
              flushSync(() => {
                if (polyModeRef.current) {
                  /* Как в легаси: один тап инвертирует общий Ta для всех линий (канон — lane 0). */
                  const nextVal = !firstBeatAccentByLaneRef.current[0];
                  const next = { 0: nextVal, 1: nextVal, 2: nextVal } as LaneBoolMap;
                  firstBeatAccentByLaneRef.current = next;
                  firstBeatAccentRef.current = nextVal;
                  setFirstBeatAccentByLane(next);
                  setFirstBeatAccent(nextVal);
                } else {
                  setFirstBeatAccent((prev) => !prev);
                }
              });
            }}
            /* Всегда border-2: иначе при входе в редактор (2px) соседний «Квадрат» в flex-ряду смещается. */
            className={`flex-1 basis-0 min-h-[48px] rounded-xl box-border flex justify-center items-center relative overflow-hidden bg-[#161f33] border-2 ${
              isDeadCellsEditorMode
                ? 'border-[#23314f] text-slate-600 opacity-45 cursor-not-allowed'
                : isTaEditorMode
                ? `border-white/90 text-white ${lowPerfMode ? '' : 'shadow-[0_0_18px_rgba(255,255,255,0.25)]'}`
                : isTaButtonPressed
                ? `border-[#23314f] text-white ${lowPerfMode ? '' : 'shadow-[0_0_14px_rgba(255,255,255,0.2)]'}`
                : (polyMode ? Boolean(firstBeatAccentByLane[activeClickVoiceTarget]) : firstBeatAccent)
                  ? `border-white/90 text-white ${lowPerfMode ? '' : 'shadow-[0_0_15px_rgba(255,255,255,0.25)]'}`
                  : 'border-[#23314f] text-slate-400 hover:text-slate-200 hover:bg-[#1a253c] active:bg-[#131b2c]'
            }`}
          >
            {isTaButtonPressed && !isTaEditorMode && taHoldFill > 0 ? (
              <span aria-hidden className="pointer-events-none absolute inset-0 bg-white/45" />
            ) : isTaEditorMode ? (
              <span aria-hidden className="pointer-events-none absolute inset-0 bg-white/30" />
            ) : null}
            <span className="relative z-10 font-bold text-[22px] tracking-wide">Ta</span>
          </button>

          <button
            type="button"
            disabled={isDeadCellsEditorMode}
            onClick={() => {
              if (isDeadCellsEditorMode) return;
              setMixerLayerMode((prev) => {
                const next = nextMixerLayerMode(prev);
                mixerLayerModeRef.current = next;
                return next;
              });
            }}
            className={`flex-1 basis-0 min-h-[48px] rounded-xl flex justify-center items-center transition-colors touch-none select-none relative bg-[#161f33] active:scale-100 active:translate-y-0 ${
              isDeadCellsEditorMode
                ? 'border border-[#23314f] text-slate-600 opacity-45 cursor-not-allowed'
                : mixerButtonSurface
            }`}
            aria-label={mixerModeLabel}
          >
            <span className="flex items-center gap-1">
              {(mixerLayerMode === 'full_mix' || mixerLayerMode === 'no_alt') ? (
                <span
                  aria-hidden
                  className={`inline-block h-4 min-w-[12px] shrink-0 rounded-[4px] border-2 box-border bg-[#4b5563] border-[#6b7280] ${
                    lowPerfMode ? '' : 'shadow-[0_1px_4px_rgba(255,255,255,0.18)]'
                  }`}
                />
              ) : null}
              {(mixerLayerMode === 'full_mix' || mixerLayerMode === 'alt_only') ? (
                <span
                  aria-hidden
                  className={`inline-block h-4 min-w-[12px] shrink-0 rounded-[4px] border-2 box-border bg-purple-900/40 border-purple-500/50 ${
                    lowPerfMode ? '' : 'shadow-[inset_0_1px_3px_rgba(168,85,247,0.22)]'
                  }`}
                />
              ) : null}
            </span>
          </button>

          <button
            type="button"
            disabled={isDeadCellsEditorMode}
            onPointerDown={() => {
              if (isDeadCellsEditorMode) return;
              squareHoldAteClickRef.current = false;
              if (squareHoldTimerRef.current !== null) {
                window.clearTimeout(squareHoldTimerRef.current);
                squareHoldTimerRef.current = null;
              }
              squareHoldTimerRef.current = window.setTimeout(() => {
                squareHoldTimerRef.current = null;
                squareHoldAteClickRef.current = true;
                setTrainerHoldMute((prev) => {
                  const next = !prev;
                  trainerHoldMuteRef.current = next;
                  syllableReadMuteModeRef.current = next ? 'full' : 'off';
                  setSyllableReadMuteMode(next ? 'full' : 'off');
                  return next;
                });
              }, 400);
            }}
            onPointerUp={() => {
              if (isDeadCellsEditorMode) return;
              if (squareHoldTimerRef.current !== null) {
                window.clearTimeout(squareHoldTimerRef.current);
                squareHoldTimerRef.current = null;
              }
            }}
            onPointerLeave={() => {
              if (isDeadCellsEditorMode) return;
              if (squareHoldTimerRef.current !== null) {
                window.clearTimeout(squareHoldTimerRef.current);
                squareHoldTimerRef.current = null;
              }
            }}
            onPointerCancel={() => {
              if (isDeadCellsEditorMode) return;
              if (squareHoldTimerRef.current !== null) {
                window.clearTimeout(squareHoldTimerRef.current);
                squareHoldTimerRef.current = null;
              }
            }}
            onClick={() => {
              if (isDeadCellsEditorMode) return;
              if (squareHoldAteClickRef.current) {
                squareHoldAteClickRef.current = false;
                return;
              }
              flushSync(() => {
                setTrainerMode((prev) => {
                  const next = nextTrainerMode(prev);
                  trainerModeRef.current = next;
                  dictantModeRef.current = next === 'dictation';
                  return next;
                });
                setTrainerHoldMute(false);
                trainerHoldMuteRef.current = false;
                syllableReadMuteModeRef.current = 'off';
                setSyllableReadMuteMode('off');
              });
            }}
            onContextMenu={(e) => e.preventDefault()}
            className={`flex-1 basis-0 min-h-[48px] rounded-xl box-border border-2 flex justify-center items-center transition-colors touch-none select-none relative bg-[#161f33] active:scale-100 active:translate-y-0 ${
              isDeadCellsEditorMode
                ? 'border-[#23314f] text-slate-600 opacity-45 cursor-not-allowed'
                : trainerButtonSurface
            }`}
            aria-label={trainerModeLabel}
          >
            <span
              className={`block w-6 h-6 rounded-sm border-2 border-current ${lowPerfMode ? '' : 'transition-all duration-300'} ${
                trainerMode !== 'normal' || trainerHoldMute
                  ? 'opacity-100 bg-current/25'
                  : 'opacity-55 bg-transparent'
              }`}
            />
          </button>
        </div>
        </div>

        {/* Play Button */}
        <div className="mb-2 shrink-0">
          <button
            type="button"
            disabled={(isTaEditorMode || isDeadCellsEditorMode) && !isPlaying}
            aria-disabled={(isTaEditorMode || isDeadCellsEditorMode) && !isPlaying}
            onPointerDown={() => {
              if (isPlaying) return;
              if (isTaEditorMode || isDeadCellsEditorMode) return;
              playHoldAteClickRef.current = false;
              clearPlayHoldTimer();
              playHoldTimerRef.current = window.setTimeout(() => {
                playHoldTimerRef.current = null;
                playHoldAteClickRef.current = true;
                enterStartBarPickMode();
              }, PLAY_START_PICK_HOLD_MS);
            }}
            onPointerUp={() => {
              clearPlayHoldTimer();
            }}
            onPointerLeave={() => {
              clearPlayHoldTimer();
            }}
            onPointerCancel={() => {
              clearPlayHoldTimer();
            }}
            onClick={handlePlayButtonClick}
            className={`w-full py-4 rounded-xl font-black text-lg tracking-[0.2em] flex items-center justify-center gap-2 ${lowPerfMode ? '' : 'shadow-[0_8px_20px_rgba(16,185,129,0.2)]'} transition-all transform ${
              (isTaEditorMode || isDeadCellsEditorMode) && !isPlaying
                ? 'opacity-45 cursor-not-allowed bg-emerald-600/50 text-slate-800'
                : 'active:scale-[0.98] ' +
                  (isPlaying
                    ? 'bg-rose-500 hover:bg-rose-400 active:bg-rose-600 shadow-rose-500/20 text-white'
                    : isStartBarPickMode
                      ? 'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950 ring-2 ring-emerald-300/60'
                      : 'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950')
            }`}
          >
            {isPlaying ? (
              <>■ STOP</>
            ) : isStartBarPickMode ? (
              <>PICK BAR</>
            ) : (
              <><Play fill="currentColor" size={22} className="-ml-2" /> PLAY</>
            )}
          </button>
        </div>

      </div>

      {snapshotClipMenu ? (
        <>
          <div
            className="fixed inset-0 z-[200] bg-black/50"
            aria-hidden
            onPointerDown={closeSnapshotClipMenu}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Preset: copy or paste"
            className="fixed z-[201] flex items-center gap-1 rounded-xl border border-[#2f4066] bg-[#161f33] p-1.5 shadow-2xl ring-1 ring-black/30"
            style={{
              left: snapshotClipMenu.x,
              top: snapshotClipMenu.y,
              transform: 'translate(-50%, 0)',
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#23314f] text-slate-200 transition-colors hover:bg-[#2c3d63] active:bg-[#1b253b] ring-1 ring-[#2f4066]/40"
              aria-label="Copy slot preset to clipboard"
              onClick={() => void copySnapshotSlotToClipboard(snapshotClipMenu.slot)}
            >
              <Copy size={20} strokeWidth={2.25} />
            </button>
            <div className="h-8 w-px shrink-0 bg-[#2f4066]/70" aria-hidden />
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#23314f] text-slate-200 transition-colors hover:bg-[#2c3d63] active:bg-[#1b253b] ring-1 ring-[#2f4066]/40"
              aria-label="Paste preset from clipboard into slot"
              onClick={() => void pasteSnapshotFromClipboard(snapshotClipMenu.slot)}
            >
              <ClipboardPaste size={20} strokeWidth={2.25} />
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}