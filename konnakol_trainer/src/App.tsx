import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, startTransition } from 'react';
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
	SlidersHorizontal,
} from 'lucide-react';
import { SequencerGrid, type SequencerGridRowActions } from './SequencerGrid';
import { getMetronomeSummingInput, METRA_LOOKAHEAD_MS, METRA_SCHEDULE_AHEAD_SEC } from './metraAudioBus';
import { applyVoiceGroupChain, getVoiceLayerSumInput, type MetroVoiceKey } from './metroSoundBus';
import { metroEnvelopeEndFromPeak, scheduleLayerToBus } from './metroLayerGraph';

type PlayheadPosition = { r: number; c: number; absR: number; voice: number; step: number };
type PlayheadHighlightEvent = { t: number; pos: PlayheadPosition };

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

const CHAOS_SLIDER_MAX = 100;
/** При «отвязке» пульса от числа долей такта длительность шага считается как при 4 долях (квартальная сетка). */
const PULSE_METER_BASE_SYLLABLES = 4;

/** Long-press квадрата: off | только акцентные щелчки выкл (пассивы играют) | все щелчки по сетке выкл. */
type SyllableReadMuteMode = 'off' | 'full' | 'no_accent_sharp';
type SquarePlaybackMode = 'all_beats' | 'accent_only' | 'passive_only';

function nextSquarePlaybackMode(mode: SquarePlaybackMode): SquarePlaybackMode {
	if (mode === 'all_beats') return 'accent_only';
	if (mode === 'accent_only') return 'passive_only';
	return 'all_beats';
}

function normalizeSyllableReadMuteModeFromSnapshot(modeRaw: unknown, legacyLatched: unknown): SyllableReadMuteMode {
	if (modeRaw === 'full' || modeRaw === 'no_accent_sharp') return modeRaw;
	if (legacyLatched === true) return 'no_accent_sharp';
	return 'off';
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
/** Random pulsation: пул по chaos; пульсации 1 и 2 (Ta) с сильно пониженным весом к 3–9. */
const RANDOM_PULSE_POOL_LE_30 = [1, 2, 3, 4, 5] as const;
const RANDOM_PULSE_POOL_LE_70 = [1, 2, 3, 4, 5, 6, 7] as const;
const RANDOM_PULSE_POOL_FULL = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
/** Вес пульсации 1 vs остальные (=1), кроме 2 — отдельно. */
const RANDOM_PULSE_1_WEIGHT = 0.06;
/** Вес пульсации 2 (Ta): как у 1 — редко относительно 3–9. */
const RANDOM_PULSE_2_WEIGHT = 0.06;

function pickRandomPulsationMeter(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	const pool =
		c <= 30 ? RANDOM_PULSE_POOL_LE_30 : c <= 70 ? RANDOM_PULSE_POOL_LE_70 : RANDOM_PULSE_POOL_FULL;
	let sum = 0;
	const w: number[] = [];
	for (const v of pool) {
		const wi = v === 1 ? RANDOM_PULSE_1_WEIGHT : v === 2 ? RANDOM_PULSE_2_WEIGHT : 1;
		w.push(wi);
		sum += wi;
	}
	let r = Math.random() * sum;
	for (let i = 0; i < pool.length; i++) {
		r -= w[i]!;
		if (r <= 0) return pool[i]!;
	}
	return pool[pool.length - 1]!;
}

/** Доля акцентуемых долей: 0→0, 25→25%, 50→50%, 75→75%, 100→90% (кусочно-линейно). */
function accentFillRatioFromChaos(c: number): number {
	const x = Math.max(0, Math.min(CHAOS_SLIDER_MAX, c));
	if (x <= 25) return 0.25 * (x / 25);
	if (x <= 50) return 0.25 + (x - 25) * (0.25 / 25);
	if (x <= 75) return 0.5 + (x - 50) * (0.25 / 25);
	return 0.75 + (x - 75) * (0.15 / 25);
}

/** Random pulsation (длина такта / поддоли): chaos≤30 → 1–5; 31–70 → 1–7; >70 → 1–9; 1 и 2 редки. */
function pickWeightedMeter2to9(chaos: number): number {
	return pickRandomPulsationMeter(chaos);
}

const CELL_SPEED_RANDOM_POOL = [2, 3, 4] as const;

/** Random Speed (cell speed): только поддоли 2, 3 или 4. */
function pickRandomCellSpeedSubdiv(): number {
	return CELL_SPEED_RANDOM_POOL[Math.floor(Math.random() * CELL_SPEED_RANDOM_POOL.length)]!;
}

function parsePolyVoices(raw: unknown): 2 | 3 | 4 {
	const n = parseInt(String(raw), 10);
	// return n === 3 || n === 4 ? n : 2;
	// 4-voice polyrythm temporarily disabled.
	return n === 3 ? n : 2;
}

/**
 * Доля долей такта, в которых random speed выставляет новую поддоль (остальные сбрасываются в дефолт).
 * Используется только при chaos > 25: chaos 26–33 → 33%; 34–66 → 66%; 67–89 → линейно 66%→100%; ≥90 → 100%.
 * При chaos 0–25 см. ветку в планировщике: не более одной ячейки на такт.
 */
function cellSpeedFillFractionFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (c <= 33) return 0.33;
	if (c <= 66) return 0.66;
	if (c >= 90) return 1;
	return 0.66 + ((c - 66) / (90 - 66)) * (1 - 0.66);
}

function pickAccentCountForBar(chaos: number, curSyl: number): number {
	const x = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (curSyl < 1) return 0;
	const minAcc = Math.min(curSyl, x > 15 ? 2 : 1);
	const maxCap = Math.min(curSyl, Math.max(minAcc, Math.floor(curSyl * 0.9)));
	const ratio = accentFillRatioFromChaos(x);
	const cap = Math.floor(curSyl * ratio);
	const spread = 1 + Math.floor(curSyl * 0.12);
	const jitter = Math.floor((Math.random() - 0.5) * spread);
	let n = Math.max(0, Math.min(curSyl, cap + jitter));
	n = Math.min(maxCap, Math.max(minAcc, n));
	return n;
}

function pickBarSpeedMultiplier(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (c <= 40) return 1;
	if (c <= 70) {
		const p2 = ((c - 40) / 30) * 0.5;
		return Math.random() < p2 ? 2 : 1;
	}
	const t = (c - 70) / 30;
	const w1 = 0.38 * (1 - t) + 0.1;
	const w2 = 0.32 + 0.06 * t;
	const w3 = 0.15 * t + 0.05;
	const w4 = 0.15 * t + 0.05;
	const tot = w1 + w2 + w3 + w4;
	let r = Math.random() * tot;
	if ((r -= w1) <= 0) return 1;
	if ((r -= w2) <= 0) return 2;
	if ((r -= w3) <= 0) return 3;
	return 4;
}

type BarRandomizerMutable = {
	customSyllables: Record<number, number>;
	accents: Set<string>;
	customSubdivisions: Record<string, number>;
	customMultipliers: Record<number, number>;
	deadCells: DeadCellsMap;
};

type DeadCellsMap = Record<number, { deadStart: number; displayLen: number; baseLen: number }>;

/** Одна итерация рандома на такт `prevBar` (как на границе такта в плеере). */
function applyRandomizerEffectsToBar(
	prevBar: number,
	chaos: number,
	randomPulsation: boolean,
	randomPattern: boolean,
	randomSpeed: boolean,
	randomBarSpeed: boolean,
	onlyAccents: boolean,
	syllablesDefault: number,
	m: BarRandomizerMutable,
): boolean {
	let didChange = false;

	if (randomPulsation) {
		m.customSyllables[prevBar] = pickWeightedMeter2to9(chaos);
		didChange = true;
	}

	const curSyl = m.customSyllables[prevBar] ?? syllablesDefault;

	if (randomPattern) {
		for (let i = 0; i < 9; i++) m.accents.delete(`${prevBar}-${i}`);
		const candidates = Array.from({ length: curSyl }, (_, i) => i).sort(() => Math.random() - 0.5);
		const fillCount = pickAccentCountForBar(chaos, curSyl);
		for (let i = 0; i < fillCount; i++) {
			m.accents.add(`${prevBar}-${candidates[i]}`);
		}
		didChange = true;
	}

	if (randomSpeed) {
		const curSylSpeed = m.customSyllables[prevBar] ?? syllablesDefault;
		const candidates = onlyAccents
			? Array.from({ length: curSylSpeed }, (_, i) => i).filter((i) => m.accents.has(`${prevBar}-${i}`))
			: Array.from({ length: curSylSpeed }, (_, i) => i);
		for (let i = 0; i < 9; i++) delete m.customSubdivisions[`${prevBar}-${i}`];
		if (chaos <= 25) {
			const pOne = chaos <= 0 ? 0 : chaos / 25;
			if (candidates.length > 0 && Math.random() < pOne) {
				const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
				m.customSubdivisions[`${prevBar}-${pick}`] = pickRandomCellSpeedSubdiv();
			}
		} else {
			const cellSpeedHitP = cellSpeedFillFractionFromChaos(chaos);
			candidates.forEach((i) => {
				if (Math.random() < cellSpeedHitP) {
					m.customSubdivisions[`${prevBar}-${i}`] = pickRandomCellSpeedSubdiv();
				}
			});
		}
		didChange = true;
	}

	if (randomBarSpeed) {
		// Dead Cells random:
		// 1) базовая плотность как у accents (через pickAccentCountForBar),
		// 2) до 50 chaos используем мягкое распределение: в основном 0, реже 1, очень редко 2,
		// 3) с 70+ chaos лимит dead-клеток растет по экспоненте,
		// 4) шанс полного отсутствия dead-cells:
		//    chaos < 50  -> 70%
		//    50..69      -> 30%
		const baseActive = Math.max(1, Math.min(curSyl, pickAccentCountForBar(chaos, curSyl)));
		const maxDeadPossible = Math.max(0, curSyl - 1); // минимум одна активная клетка должна остаться.
		if (maxDeadPossible <= 0) {
			delete m.deadCells[prevBar];
			didChange = true;
			return didChange;
		}
		const flatCap = Math.min(2, maxDeadPossible);
		if (chaos < 50) {
			const t = Math.max(0, Math.min(1, chaos / 50));
			// На низком хаосе: 0 доминирует; 1 встречается редко; 2 — очень редко.
			const p0 = 0.9 - 0.2 * t; // 90% -> 70%
			const p1 = 0.09 + 0.16 * t; // 9% -> 25%
			const p2 = 1 - p0 - p1; // 1% -> 5%
			const roll = Math.random();
			const deadCountSoft = roll < p0 ? 0 : roll < p0 + p1 ? 1 : 2;
			const deadCount = Math.min(deadCountSoft, flatCap);
			const activeCount = Math.max(1, curSyl - deadCount);
			if (activeCount >= curSyl) {
				delete m.deadCells[prevBar];
			} else {
				m.deadCells[prevBar] = {
					deadStart: activeCount,
					displayLen: curSyl,
					baseLen: curSyl,
				};
			}
			didChange = true;
			return didChange;
		}
		const noDeadChance = chaos < 70 ? 0.3 : 0;
		if (noDeadChance > 0 && Math.random() < noDeadChance) {
			delete m.deadCells[prevBar];
			didChange = true;
			return didChange;
		}
		const maxDeadForChaos = (() => {
			if (chaos < 70) return flatCap;
			const tail = Math.max(0, Math.min(1, (chaos - 70) / 30));
			// Экспоненциальная кривая 0..1 с быстрым ростом ближе к 100.
			const exp01 = Math.expm1(3 * tail) / Math.expm1(3);
			// На 100% chaos цель: ~80% мертвых клеток в такте (с учетом дискретности длины).
			const deadAt100 = Math.min(maxDeadPossible, Math.max(flatCap, Math.floor(curSyl * 0.8)));
			return Math.max(flatCap, Math.min(deadAt100, Math.round(flatCap + exp01 * (deadAt100 - flatCap))));
		})();
		const baseDead = Math.max(0, curSyl - baseActive);
		// Для high-chaos (>70) приоритет у целевой dead-кривой, а не у акцентной плотности.
		const deadCount = chaos >= 70 ? maxDeadForChaos : Math.min(baseDead, maxDeadForChaos);
		const activeCount = Math.max(1, curSyl - deadCount);
		if (activeCount >= curSyl) {
			delete m.deadCells[prevBar];
		} else {
			m.deadCells[prevBar] = {
				deadStart: activeCount,
				displayLen: curSyl,
				baseLen: curSyl,
			};
		}
		didChange = true;
	}

	return didChange;
}

const SNAPSHOT_SLOT_COUNT = 7;
const SNAPSHOT_STORAGE_KEY = 'konnakolTrainerSnapshotsV1';
const LITE_UI_STORAGE_KEY = 'konnakol_lite_ui';
const POLY_MODE_STORAGE_KEY = 'konnakol_poly_mode';
const POLY_VOICES_STORAGE_KEY = 'konnakol_poly_voices';
const APP_COMMIT_VERSION = (() => {
	if (typeof __GIT_SHA7__ === 'string' && __GIT_SHA7__.length >= 7) return __GIT_SHA7__.slice(0, 7);
	return '9222e9d';
})();
const TEMPO_THROTTLE_MS = 56;
/** Удержание −/+ темпа: после задержки шаг ±5 каждые 0,1 с. */
const TEMPO_HOLD_REPEAT_MS = 100;
const TEMPO_HOLD_REPEAT_STEP = 5;
/** Long press on tempo slider track (without much move) → inline BPM on thumb. */
const TEMPO_MANUAL_HOLD_MS = 520;
const TEMPO_MANUAL_MAX_MOVE_PX = 14;
/** Clipboard export: kawaii magic marker for compact preset payload. */
const SNAPSHOT_CLIPBOARD_MARKER = '(⁠ʘ⁠ᴗ⁠ʘ⁠)⁠♪:';
/** Accept marker with/without zero-width separators from messengers. */
const SNAPSHOT_CLIPBOARD_MARKER_REGEX =
	/^\([\s\u200b\u200c\u200d\ufeff\u2060]*ʘ[\s\u200b\u200c\u200d\ufeff\u2060]*ᴗ[\s\u200b\u200c\u200d\ufeff\u2060]*ʘ[\s\u200b\u200c\u200d\ufeff\u2060]*\)[\s\u200b\u200c\u200d\ufeff\u2060]*♪[\s\u200b\u200c\u200d\ufeff\u2060]*:/;
/** Backward compatibility for previously shared compact snapshots. */
const SNAPSHOT_CLIPBOARD_PREFIX_LEGACY_COMPACT = 'METRONOME_CONFIG:';
/** Legacy prefix with raw JSON after colon — still accepted when pasting. */
const SNAPSHOT_CLIPBOARD_PREFIX_LEGACY = 'konnakolTrainerSnapshotV1:';
/** Hold snapshot slot to open Copy / Paste menu. */
const SNAPSHOT_SLOT_HOLD_MS = 300;
/** Long-press Ta / ластик dead-editor / прочие UI-таймеры (~0,5 с). */
const SNAPSHOT_MENU_HOLD_MS = 520;
/** Удерживание кнопки «кости»: переключение режима Randomizer (вкл/выкл рандом на границах тактов). */
const RANDOM_DICE_PREFILL_HOLD_MS = SNAPSHOT_MENU_HOLD_MS;

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
const SNAPSHOT_SOUND_ID_CLASSIC = 0;
const SNAPSHOT_SOUND_ID_OLDSCHOOL = 1;
const AUDIO_START_GUARD_SEC = 0.004;
/** Percussion AD envelope: linear attack (s), exponential decay floor vs peak (-60 dB rel.). */
const CLICK_ENV_ATTACK_SEC = 0.002;
const CLICK_LAYER_VOLUME_GATE = 0.001;
const CLICK_DECAY_MIN_SEC = 0.001;
const CLICK_DECAY_MAX_SEC = 3;

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

const CLICK_SOUND_LIBRARY: Record<ClickSoundPreset, ClickSoundConfig> = {
	classic: {
		oscType: 'sine',
		baseFreq: 800,
		accentFreq: 920,
		altFreq: 800,
		decay: 0.04,
		decayAccent: 0.04,
		decayAlt: 0.04,
		volume: 0.4,
		volumeAccent: 0.5,
		volumeAlt: 0.4,
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
		altFreq: 250,
		decay: 0.02,
		decayAccent: 0.04,
		decayAlt: 0.02,
		sweep: true,
		volume: 0.48,
		volumeAccent: 0.9,
		volumeAlt: 0.48,
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
		volume: 0.3,
		decay: 0.025,
		baseFreq: 400,
		volumeAccent: 2.3,
		decayAccent: 0.025,
		accentFreq: 1890,
		volumeAlt: 1.6,
		decayAlt: 0.025,
		altFreq: 1410,
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
		altFreq: 670,
		decay: 0.08,
		decayAccent: 0.08,
		decayAlt: 0.08,
		volume: 0.3,
		volumeAccent: 0.3,
		volumeAlt: 0.3,
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
	{ id: 'preset-15', label: 'Cowbell', mappedSound: 'cowbell' },
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

function encodeDeadCellsToken(deadCells: DeadCellsMap, bars: number): string {
	const parts: string[] = [];
	for (const [rk, meta] of Object.entries(deadCells || {})) {
		const row = parseInt(rk, 10);
		if (!Number.isFinite(row) || row < 0 || row >= bars) continue;
		const deadStart = Math.max(1, Math.min(9, Math.floor(meta.deadStart)));
		const displayLen = Math.max(1, Math.min(9, Math.floor(meta.displayLen)));
		const baseLen = Math.max(1, Math.min(9, Math.floor(meta.baseLen)));
		parts.push(`${row.toString(36)}:${deadStart.toString(36)}${displayLen.toString(36)}${baseLen.toString(36)}`);
	}
	if (parts.length === 0) return '0';
	parts.sort();
	return parts.join('_');
}

function decodeDeadCellsToken(token: string, bars: number): DeadCellsMap {
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
		out[row] = {
			deadStart: Math.max(1, Math.min(9, deadStart)),
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
	const gridVersion = useV3 ? 0x03 : useV2 ? 0x02 : 0x01;
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

	if (useV2) {
		out.push(Math.min(255, Math.max(0, Math.floor(snapshot.accentMapVersion ?? 1))) & 0xff);
	}

	const prefix = gridVersion === 0x03 ? 'p3' : useV2 ? 'p2' : 'p1';
	return `${prefix}${toBase64Url(new Uint8Array(out))}`;
}

function unpackGridTokenPacked(
	token: string,
	d: ReturnType<typeof createEmptySnapshot>,
): boolean {
	let b64 = token;
	if (token.startsWith('p3')) b64 = token.slice(2);
	else if (token.startsWith('p2')) b64 = token.slice(2);
	else if (token.startsWith('p1')) b64 = token.slice(2);
	else return false;
	const bytes = fromBase64Url(b64);
	if (!bytes || bytes.length < 6) return false;
	let off = 0;
	const magic = bytes[off++]!;
	const version = bytes[off++]!;
	if (magic !== 0x50 || (version !== 0x01 && version !== 0x02 && version !== 0x03)) return false;
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
	}
	return true;
}

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
	return flags;
}

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

/** Восстановление акцентов и поддолей из плотной сетки (имеет приоритет над legacy-полями). */
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
			const pul = Number.isFinite(p) && p >= 1 && p <= 9 ? p : 1;
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
		customSyllables: {} as Record<number, number>,
		customMultipliers: {} as Record<number, number>,
		customSubdivisions: {} as Record<string, number>,
		/** Дефолт рандомайзера: режим вкл., pulsation + cell speed + accents (pattern), chaos 15. */
		randomModeEnabled: true,
		randomPulsation: true,
		randomPattern: true,
		randomSpeed: true,
		randomBarSpeed: false,
		chaosLevel: 15,
		/** Classic = legacy maja без `konnakol_metronome`: акцент / пассив + Ta на первой доле. */
		clickSound: 'classic' as ClickSoundPreset,
		/** Верхняя панель: темп + слайдеры (Chevron) развёрнута. */
		panelExpanded: false,
		/** Ряд r: длительность клетки от PULSE_METER_BASE_SYLLABLES, не от customSyllables[r]. */
		pulseMeterUnlinked: {} as Record<number, boolean>,
		/** Заморозка высоты ряда (число видимых тактов) или null. */
		frozenScale: null as number | null,
		polyMode: false,
		polyVoices: 2 as 2 | 3 | 4,
		onlyAccents: false,
		squarePlaybackMode: 'all_beats' as SquarePlaybackMode,
		firstBeatAccent: true,
		/** 0 = legacy: первая доля Ta без явных ключей `r-0` считается включённой; 1 = карта `accents` для первых долей. */
		accentMapVersion: 0,
		syllableReadMuteMode: 'off' as SyllableReadMuteMode,
		/** Диктант: только первый слог такта с зелёным бегунком; пассивные щелчки выключены. */
		dictantMode: false,
		deadCells: {} as DeadCellsMap,
		/** Звук 1 (Ta-динг): любые `r-c`, включая `r-0` (белая рамка в редакторе Ta без записи в `accents`). */
		taDingKeys: new Set<string>(),
	};
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
			if (typeof k === 'string' && Number.isFinite(vi) && vi >= 1 && vi <= 9) d.customSubdivisions[k] = vi;
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
	if (
		o.squarePlaybackMode === 'all_beats' ||
		o.squarePlaybackMode === 'accent_only' ||
		o.squarePlaybackMode === 'passive_only'
	) {
		d.squarePlaybackMode = o.squarePlaybackMode;
	}
	if (typeof o.dictantMode === 'boolean') d.dictantMode = o.dictantMode;
	if (typeof o.firstBeatAccent === 'boolean') d.firstBeatAccent = o.firstBeatAccent;
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
			if (deadStart < 1 || displayLen < 1 || baseLen < 1) continue;
			nextDead[r] = {
				deadStart: Math.min(deadStart, 9),
				displayLen: Math.min(displayLen, 9),
				baseLen: Math.min(baseLen, 9),
			};
		}
		d.deadCells = nextDead;
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
	return d;
}

function snapSlotLooksUsed(s: ReturnType<typeof createEmptySnapshot>) {
	if (s.tempo !== 100 || s.bars !== 4 || s.syllables !== 4) return true;
	if (s.accents.size > 0) return true;
	if (s.taDingKeys.size > 0) return true;
	if (Object.keys(s.customSyllables).length > 0) return true;
	if (Object.keys(s.customMultipliers).length > 0) return true;
	if (Object.keys(s.customSubdivisions).length > 0) return true;
	if (s.randomModeEnabled || s.randomPulsation || !s.randomPattern || s.randomSpeed || s.randomBarSpeed) return true;
	if (s.chaosLevel !== 0) return true;
	if (s.clickSound !== 'classic') return true;
	if (s.panelExpanded === true) return true;
	if (s.pulseMeterUnlinked && Object.values(s.pulseMeterUnlinked).some(Boolean)) return true;
	if (s.onlyAccents) return true;
	if ((s as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode === 'accent_only') return true;
	if ((s as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode === 'passive_only') return true;
	if (s.firstBeatAccent === false) return true;
	if (s.frozenScale != null) return true;
	if (s.polyMode) return true;
	if (s.polyVoices !== 2) return true;
	if (s.syllableReadMuteMode !== 'off') return true;
	if ((s as { accentMapVersion?: number }).accentMapVersion === 1) return true;
	if ((s as { dictantMode?: boolean }).dictantMode === true) return true;
	if ((s as { deadCells?: DeadCellsMap }).deadCells && Object.keys((s as { deadCells?: DeadCellsMap }).deadCells || {}).length > 0) return true;
	return false;
}

function snapshotToJSON(s: ReturnType<typeof createEmptySnapshot>) {
	return {
		tempo: s.tempo,
		bars: s.bars,
		syllables: s.syllables,
		accents: [...s.accents],
		sequencerCells: buildSequencerCellsForSnapshot(s),
		customSyllables: s.customSyllables,
		customMultipliers: s.customMultipliers,
		customSubdivisions: s.customSubdivisions,
		randomModeEnabled: s.randomModeEnabled,
		randomPulsation: s.randomPulsation,
		randomPattern: s.randomPattern,
		randomSpeed: s.randomSpeed,
		randomBarSpeed: s.randomBarSpeed,
		chaosLevel: s.chaosLevel,
		clickSound: s.clickSound,
		panelExpanded: s.panelExpanded,
		pulseMeterUnlinked: Object.fromEntries(
			Object.entries(s.pulseMeterUnlinked || {}).filter(([, v]) => v),
		) as Record<string, boolean>,
		frozenScale: s.frozenScale ?? null,
		polyMode: s.polyMode === true,
		polyVoices: parsePolyVoices(s.polyVoices),
		onlyAccents: s.onlyAccents,
		squarePlaybackMode: (s as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode ?? (s.onlyAccents ? 'accent_only' : 'all_beats'),
		firstBeatAccent: s.firstBeatAccent,
		accentMapVersion: (s as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
		taEditorMode: false,
		syllableReadMuteMode: s.syllableReadMuteMode,
		dictantMode: s.dictantMode === true,
		deadCells: (s as { deadCells?: DeadCellsMap }).deadCells ?? {},
		taDingKeys: [...s.taDingKeys],
	};
}

function encodeSnapshotClipboard(s: ReturnType<typeof createEmptySnapshot>): string {
	const accents = s.accents instanceof Set ? s.accents : new Set(Array.isArray(s.accents) ? s.accents : []);
	const cells = buildCellIndexMapForSnapshot(s.bars, s.syllables, s.customSyllables);
	const gridToken = packGridTokenPacked(s, cells, accents);
	const deadCellsToken = encodeDeadCellsToken((s as { deadCells?: DeadCellsMap }).deadCells ?? {}, s.bars);
	const flags = buildSnapshotFlags(s);
	const soundId = buildSnapshotSoundId(s);
	const compact = `${s.tempo}.${s.bars}.${s.syllables}.${gridToken}.${deadCellsToken}.${s.chaosLevel}.${flags}.${soundId}`;
	return SNAPSHOT_CLIPBOARD_MARKER + compact;
}

function tryDecodeSnapshotClipboard(text: string): ReturnType<typeof createEmptySnapshot> | null {
	const t = text.trim();
	const markerMatch = t.match(SNAPSHOT_CLIPBOARD_MARKER_REGEX);
	const hasNewMarker = markerMatch !== null;
	const hasLegacyCompactMarker = t.startsWith(SNAPSHOT_CLIPBOARD_PREFIX_LEGACY_COMPACT);
	if (hasNewMarker || hasLegacyCompactMarker) {
		const markerLength = hasNewMarker
			? markerMatch![0].length
			: SNAPSHOT_CLIPBOARD_PREFIX_LEGACY_COMPACT.length;
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
			const soundId = parseInt(soundRaw, 10);
			if (!Number.isFinite(tempo) || tempo < 20 || tempo > 400) return null;
			if (!Number.isFinite(bars) || bars < 1 || bars > 100) return null;
			if (!Number.isFinite(syllables) || syllables < 1 || syllables > 9) return null;
			if (!Number.isFinite(chaosLevel) || chaosLevel < 0 || chaosLevel > 100) return null;
			if (!Number.isFinite(flags) || flags < 0) return null;
			if (!Number.isFinite(soundId)) return null;
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
			applySnapshotSoundId(soundId, d);
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
			const soundId = parseInt(soundRaw, 10);
			if (!Number.isFinite(tempo) || tempo < 20 || tempo > 400) return null;
			if (!Number.isFinite(bars) || bars < 1 || bars > 100) return null;
			if (!Number.isFinite(syllables) || syllables < 1 || syllables > 9) return null;
			if (!Number.isFinite(chaosLevel) || chaosLevel < 0 || chaosLevel > 100) return null;
			if (!Number.isFinite(flags) || flags < 0) return null;
			if (!Number.isFinite(soundId)) return null;
			d.tempo = tempo;
			d.bars = bars;
			d.syllables = syllables;
			d.chaosLevel = chaosLevel;
			applySnapshotFlags(flags, d);
			applySnapshotSoundId(soundId, d);
			if (gridTokenRaw.startsWith('p1') || gridTokenRaw.startsWith('p2') || gridTokenRaw.startsWith('p3')) {
				if (!unpackGridTokenPacked(gridTokenRaw, d)) return null;
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
			d.deadCells = decodeDeadCellsToken(deadCellsRaw, d.bars);
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
			const soundId = parseInt(soundRaw, 10);
			if (!Number.isFinite(tempo) || tempo < 20 || tempo > 400) return null;
			if (!Number.isFinite(bars) || bars < 1 || bars > 100) return null;
			if (!Number.isFinite(syllables) || syllables < 1 || syllables > 9) return null;
			if (!Number.isFinite(chaosLevel) || chaosLevel < 0 || chaosLevel > 100) return null;
			if (!Number.isFinite(flags) || flags < 0) return null;
			if (!Number.isFinite(soundId)) return null;
			d.tempo = tempo;
			d.bars = bars;
			d.syllables = syllables;
			d.chaosLevel = chaosLevel;
			applySnapshotFlags(flags, d);
			applySnapshotSoundId(soundId, d);
			if (gridTokenRaw.startsWith('p1') || gridTokenRaw.startsWith('p2') || gridTokenRaw.startsWith('p3')) {
				if (!unpackGridTokenPacked(gridTokenRaw, d)) return null;
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
	return null;
}

function loadSnapshotStorage(): {
	activeSnapshot: number;
	snapshots: Record<number, ReturnType<typeof createEmptySnapshot>>;
} {
	const snapshots: Record<number, ReturnType<typeof createEmptySnapshot>> = {};
	for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) snapshots[i] = createEmptySnapshot();
	let activeSnapshot = 1;
	try {
		const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
		if (!raw) {
			for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) snapshots[i].randomModeEnabled = false;
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
				if (row) snapshots[i] = parseSnapshotRow(row);
			}
		}
	} catch {
		/* keep defaults */
	}
	return { activeSnapshot, snapshots };
}

type ClickMixerGroup = { groupHpHz: number; groupLpHz: number; groupMasterLinear: number };

const clickMixerLayerClonesRef: {
	current: { accent: ClickLayerConfig[]; alt: ClickLayerConfig[]; passive: ClickLayerConfig[] } | null;
} = { current: null };

const clickMixerGroupRef: { current: Record<MetroVoiceKey, ClickMixerGroup> | null } = { current: null };

function cloneClickMixerFromLibrary(soundType: ClickSoundPreset): void {
	const cfg = CLICK_SOUND_LIBRARY[soundType] ?? CLICK_SOUND_LIBRARY.classic;
	const built = cfg.layers ?? buildLegacyVoiceLayers(cfg);
	clickMixerLayerClonesRef.current = {
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
) => {
  const cfg = CLICK_SOUND_LIBRARY[soundType] ?? CLICK_SOUND_LIBRARY.classic;
  const t0 = Math.max(time, ctx.currentTime + AUDIO_START_GUARD_SEC);
  const voiceKey: MetroVoiceKey = voiceRole === 'accent' ? 'accent' : voiceRole === 'alt' ? 'alt' : 'passive';
  const busIn = getVoiceLayerSumInput(ctx, voiceKey);
  const libLayers = (cfg.layers ?? buildLegacyVoiceLayers(cfg))[voiceKey];
  const layers = clickMixerLayerClonesRef.current?.[voiceKey] ?? libLayers;
  const activeLayers = layers.filter(
    (layer) => layer.mute !== true && layer.params.volume > CLICK_LAYER_VOLUME_GATE && layer.type !== 'none',
  );
  const soloLayers = activeLayers.filter((layer) => layer.solo === true);
  const runLayers = soloLayers.length > 0 ? soloLayers : activeLayers;
  for (const layer of runLayers) {
    const layerDecay = Math.min(CLICK_DECAY_MAX_SEC, Math.max(CLICK_DECAY_MIN_SEC, layer.params.decay));
    const layerVol = accentOnlyPlayback && voiceRole === 'accent' ? layer.params.volume * 0.72 : layer.params.volume;
    scheduleLayerToBus(ctx, t0, layer, layerVol, layerDecay, busIn);
  }
};

const playBarFirstHighClick = (ctx: AudioContext, time: number, soundType: ClickSoundPreset = 'classic') => {
  const t0 = Math.max(time, ctx.currentTime + AUDIO_START_GUARD_SEC);
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
    const classicPeak = 0.36;
    gain.gain.cancelScheduledValues(t0);
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
    const oldschoolPeak = 0.78;
    gain.gain.cancelScheduledValues(t0);
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
  playSharpClick(ctx, time, true, soundType, false);
};

type StructuralSliderProps = {
  label: string;
  min: number;
  max: number;
  value: number;
  colorClass: string;
  onCommit: (next: number) => void;
  onLiveChange?: (next: number) => void;
  onBeginDrag?: () => void;
};

function StructuralSlider({
  label,
  min,
  max,
  value,
  colorClass,
  onCommit,
  onLiveChange,
  onBeginDrag,
}: StructuralSliderProps) {
  const [localValue, setLocalValue] = useState(value);
  const committedValueRef = useRef(value);
  const lastLiveValueRef = useRef(value);
  const pointerActiveRef = useRef(false);

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

  return (
    <input
      aria-label={label}
      type="range"
      min={String(min)}
      max={String(max)}
      value={localValue}
      onPointerDown={() => {
        pointerActiveRef.current = true;
        onBeginDrag?.();
      }}
      onPointerUp={() => {
        if (pointerActiveRef.current) pointerActiveRef.current = false;
        commitLocalValue(localValue);
      }}
      onPointerCancel={() => {
        if (pointerActiveRef.current) pointerActiveRef.current = false;
        commitLocalValue(localValue);
      }}
      onBlur={() => {
        commitLocalValue(localValue);
      }}
      onInput={(e) => {
        applyLiveValue(normalizeValue(e.currentTarget.value));
      }}
      onChange={(e) => {
        applyLiveValue(normalizeValue(e.currentTarget.value));
      }}
      className={`flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 ${colorClass} [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110`}
    />
  );
}

type TempoSliderSlot = 'hdr' | 'pnl';

type TempoSliderTrackProps = {
	tempoUi: number;
	tempoRef: React.MutableRefObject<number>;
	scheduleTempoCommit: (raw: number) => void;
	flushTempoCommit: () => void;
	onBeginTempoBpmInlineEdit: () => void;
	tempoInlineEditing: boolean;
	tempoInlineFocusSlot: TempoSliderSlot | null;
	tempoSliderSlot: TempoSliderSlot;
	tempoManualText: string;
	onTempoManualTextChange: (v: string) => void;
	onCommitTempoInline: () => void;
	onCancelTempoInline: () => void;
	className?: string;
};

function TempoSliderTrack({
	tempoUi,
	tempoRef,
	scheduleTempoCommit,
	flushTempoCommit,
	onBeginTempoBpmInlineEdit,
	tempoInlineEditing,
	tempoInlineFocusSlot,
	tempoSliderSlot,
	tempoManualText,
	onTempoManualTextChange,
	onCommitTempoInline,
	onCancelTempoInline,
	className = '',
}: TempoSliderTrackProps) {
	const moveCancelSq = TEMPO_MANUAL_MAX_MOVE_PX * TEMPO_MANUAL_MAX_MOVE_PX;
	const inlineInputRef = useRef<HTMLInputElement>(null);
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
				let longPressTimer: number | null = null;
				let finished = false;
				const startX = e.clientX;
				const startY = e.clientY;
				const rect = el.getBoundingClientRect();
				const thumbHalf = 24;
				const updateTempo = (clientX: number) => {
					const activeWidth = rect.width - thumbHalf * 2;
					const x = Math.max(0, Math.min(activeWidth, clientX - rect.left - thumbHalf));
					const percent = x / Math.max(1, activeWidth);
					scheduleTempoCommit(Math.round(20 + percent * 380));
				};
				const cleanup = () => {
					if (finished) return;
					finished = true;
					if (longPressTimer !== null) {
						window.clearTimeout(longPressTimer);
						longPressTimer = null;
					}
					flushTempoCommit();
					el.removeEventListener('pointermove', onMove);
					el.removeEventListener('pointerup', onUp);
					el.removeEventListener('pointercancel', onUp);
					try {
						el.releasePointerCapture(e.pointerId);
					} catch {
						/* already released */
					}
				};
				const onMove = (moveEvt: PointerEvent) => {
					if (finished) return;
					const dx = moveEvt.clientX - startX;
					const dy = moveEvt.clientY - startY;
					if (dx * dx + dy * dy > moveCancelSq) {
						if (longPressTimer !== null) {
							window.clearTimeout(longPressTimer);
							longPressTimer = null;
						}
					}
					updateTempo(moveEvt.clientX);
				};
				const onUp = () => {
					cleanup();
				};
				el.setPointerCapture(e.pointerId);
				updateTempo(e.clientX);
				longPressTimer = window.setTimeout(() => {
					if (finished) return;
					finished = true;
					if (longPressTimer !== null) {
						window.clearTimeout(longPressTimer);
						longPressTimer = null;
					}
					flushTempoCommit();
					el.removeEventListener('pointermove', onMove);
					el.removeEventListener('pointerup', onUp);
					el.removeEventListener('pointercancel', onUp);
					try {
						el.releasePointerCapture(e.pointerId);
					} catch {
						/* */
					}
					onBeginTempoBpmInlineEdit();
				}, TEMPO_MANUAL_HOLD_MS);
				el.addEventListener('pointermove', onMove);
				el.addEventListener('pointerup', onUp);
				el.addEventListener('pointercancel', onUp);
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
  const [bars, setBars] = useState(seed.bars);
  const [syllables, setSyllables] = useState(seed.syllables);

  // Metronome state
  const [isPlaying, setIsPlaying] = useState(false);
  const [accents, setAccents] = useState<Set<string>>(() => new Set(seed.accents));
  const [taDingKeys, setTaDingKeys] = useState<Set<string>>(() => new Set(seed.taDingKeys));
  const [activePos, setActivePos] = useState({ r: -1, c: -1, absR: -1 });
  const [activePositions, setActivePositions] = useState<PlayheadPosition[]>([]);
  const playAbsBarRef = useRef(0);
  const [listOffset, setListOffset] = useState(0);
  const [customSyllables, setCustomSyllables] = useState<Record<number, number>>(() => ({ ...seed.customSyllables }));
  const [deadCells, setDeadCells] = useState<DeadCellsMap>(() => ({ ...((seed as { deadCells?: DeadCellsMap }).deadCells || {}) }));
  const [customMultipliers, setCustomMultipliers] = useState<Record<number, number>>(() => ({ ...seed.customMultipliers }));
  const [customSubdivisions, setCustomSubdivisions] = useState<Record<string, number>>(() => ({ ...seed.customSubdivisions }));
  const [pulseMeterUnlinked, setPulseMeterUnlinked] = useState<Record<number, boolean>>(() =>
    normalizePulseMeterUnlinked(seed.pulseMeterUnlinked),
  );

  // Metronome Sound Toggles
  const [squarePlaybackMode, setSquarePlaybackMode] = useState<SquarePlaybackMode>(() => {
    const raw = (seed as { squarePlaybackMode?: unknown }).squarePlaybackMode;
    if (raw === 'all_beats' || raw === 'accent_only' || raw === 'passive_only') return raw;
    return seed.onlyAccents === true ? 'accent_only' : 'all_beats';
  });
  const onlyAccents = squarePlaybackMode === 'accent_only';
  const [dictantMode, setDictantMode] = useState(() => (seed as { dictantMode?: boolean }).dictantMode === true);
  const [firstBeatAccent, setFirstBeatAccent] = useState(() => seed.firstBeatAccent !== false);
  const [accentMapVersion, setAccentMapVersion] = useState(() =>
    (seed as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
  );
  const [isTaEditorMode, setIsTaEditorMode] = useState(false);
  const [isDeadCellsEditorMode, setIsDeadCellsEditorMode] = useState(false);
  /** В режиме Ta-редактора: строки, где пользователь снял дефолтную белую метку на первой доле (без ключа taDing). */
  const [firstBeatDingSuppressedRows, setFirstBeatDingSuppressedRows] = useState<Set<number>>(() => new Set());

  // Randomizer States
  const [randomModeEnabled, setRandomModeEnabled] = useState(seed.randomModeEnabled);
  const [randomPulsation, setRandomPulsation] = useState(seed.randomPulsation);
  const [randomPattern, setRandomPattern] = useState(seed.randomPattern);
  const [randomSpeed, setRandomSpeed] = useState(seed.randomSpeed);
  const [randomBarSpeed, setRandomBarSpeed] = useState(seed.randomBarSpeed);
  const [chaosLevel, setChaosLevel] = useState(
    typeof seed.chaosLevel === 'number' && seed.chaosLevel >= 0 && seed.chaosLevel <= 100
      ? seed.chaosLevel
      : 0,
  );
  const [showRandomSettings, setShowRandomSettings] = useState(false);
  const showRandomSettingsRef = useRef(false);
  showRandomSettingsRef.current = showRandomSettings;
  const [lowPerfMode, setLowPerfMode] = useState(() => {
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
  const settingsGearButtonRef = useRef<HTMLButtonElement | null>(null);
  const coldStartRef = useRef(true);

  // Click Sound
  const [clickSound, setClickSound] = useState<ClickSoundPreset>(seed.clickSound);
  const [isClickSoundSelectorOpen, setIsClickSoundSelectorOpen] = useState(false);
  const [mixerPanelOpen, setMixerPanelOpen] = useState(false);
  const [, setMixerUiTick] = useState(0);

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
        panelExpanded: s.panelExpanded === true,
        pulseMeterUnlinked: { ...(s.pulseMeterUnlinked || {}) },
        frozenScale: typeof s.frozenScale === 'number' && s.frozenScale >= 1 ? s.frozenScale : null,
        polyMode: s.polyMode === true,
        polyVoices: parsePolyVoices(s.polyVoices),
        squarePlaybackMode: (() => {
          const raw = (s as { squarePlaybackMode?: unknown }).squarePlaybackMode;
          if (raw === 'all_beats' || raw === 'accent_only' || raw === 'passive_only') return raw;
          return s.onlyAccents === true ? 'accent_only' : 'all_beats';
        })(),
        onlyAccents: ((s as { squarePlaybackMode?: unknown }).squarePlaybackMode === 'accent_only') || s.onlyAccents === true,
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
  const clipboardToastTimerRef = useRef<number | null>(null);
  const [clipboardToast, setClipboardToast] = useState<string | null>(null);

  const showClipboardToast = (message: string) => {
    setClipboardToast(message);
    if (clipboardToastTimerRef.current !== null) {
      window.clearTimeout(clipboardToastTimerRef.current);
    }
    clipboardToastTimerRef.current = window.setTimeout(() => {
      clipboardToastTimerRef.current = null;
      setClipboardToast(null);
    }, 2600);
  };

  const [activeEditCell, setActiveEditCell] = useState<string | null>(null);
  const [activeEditRow, setActiveEditRow] = useState<number | null>(null);
  const [frozenScale, setFrozenScale] = useState<number | null>(() =>
    typeof seed.frozenScale === 'number' && seed.frozenScale >= 1 ? seed.frozenScale : null,
  );
  const frozenScaleBeforeMenuRef = useRef<number | null>(null);
  const menuForcedFreezeRef = useRef(false);
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

  useEffect(() => {
    const menuOpen = showRandomSettings || isClickSoundSelectorOpen;
    if (menuOpen) {
      if (!menuForcedFreezeRef.current) {
        frozenScaleBeforeMenuRef.current = frozenScale;
        menuForcedFreezeRef.current = true;
      }
      setFrozenScale(2);
      return;
    }
    if (menuForcedFreezeRef.current) {
      menuForcedFreezeRef.current = false;
      setFrozenScale(frozenScaleBeforeMenuRef.current);
      frozenScaleBeforeMenuRef.current = null;
      return;
    }
    setFrozenScale(null);
  }, [showRandomSettings, isClickSoundSelectorOpen]);

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

  const potatoAutoFreezeArmedRef = useRef(true);
  const prevLowPerfModeRef = useRef(lowPerfMode);
  const normalizeBarsForMode = useCallback((raw: number) => {
    const rounded = Math.round(raw);
    const clamped = Math.max(1, Math.min(100, rounded));
    if (!polyModeRef.current) return clamped;
    const voices = polyVoicesRef.current;
    const minBars = voices;
    const constrained = Math.max(minBars, clamped);
    const down = Math.floor(constrained / voices) * voices;
    const up = Math.ceil(constrained / voices) * voices;
    let snapped = down;
    if (down < minBars) snapped = up;
    else if (up <= 100 && Math.abs(up - constrained) < Math.abs(constrained - down)) snapped = up;
    if (snapped > 100) {
      snapped = 100 - (100 % voices);
      if (snapped < minBars) snapped = minBars;
    }
    return snapped;
  }, []);
  useEffect(() => {
    const prev = prevLowPerfModeRef.current;
    prevLowPerfModeRef.current = lowPerfMode;
    if (prev === lowPerfMode) return;
    potatoAutoFreezeArmedRef.current = true;
    if (!lowPerfMode) return;
    /* Poly: не навязываем freeze по числу тактов — только кнопка-снежинка. */
    if (polyModeRef.current) {
      if (bars < 6) setFrozenScale(null);
      return;
    }
    if (bars >= 6) setFrozenScale(bars);
    else setFrozenScale(null);
  }, [lowPerfMode, bars]);

  const applyBarsWithPotatoFreeze = useCallback(
    (next: number) => {
      const normalizedNext = normalizeBarsForMode(next);
      const prevBars = barsRef.current;
      setBars(normalizedNext);
      barsRef.current = normalizedNext;
      if (!lowPerfMode) return;
      if (normalizedNext <= 5) {
        potatoAutoFreezeArmedRef.current = true;
        setFrozenScale(null);
        return;
      }
      /* Poly: без авто-freeze при росте тактов (иначе «липнет» масштаб как при freeze). */
      if (polyModeRef.current) return;
      const crossedUpFromLow = prevBars <= 5 && normalizedNext >= 6;
      if (potatoAutoFreezeArmedRef.current && crossedUpFromLow) {
        setFrozenScale(normalizedNext);
      }
    },
    [lowPerfMode, normalizeBarsForMode],
  );

  /** Long-press по клетке такта (поддоли). */
  const holdTimerRef = useRef<number | null>(null);
  /** Long-press по числу слогов в такте: gati / пульс от четвёрки (не смешивать с holdTimerRef клеток). */
  const pulseUnlinkHoldTimerRef = useRef<number | null>(null);
  /** Следующий click по кнопке пульса — только «съесть» после long-press unlink (не путать с isHoldingRef от сетки). */
  const pulseUnlinkJustFiredRef = useRef(false);
  const isHoldingRef = useRef(false);
  /** Long-press square: toggle «без щелчков по клеткам»; ding такта Ta не мьютится. */
  const squareHoldTimerRef = useRef<number | null>(null);
  const squareHoldAteClickRef = useRef(false);
  const randomDiceHoldTimerRef = useRef<number | null>(null);
  const randomDiceHoldAteClickRef = useRef(false);
  const taHoldTimerRef = useRef<number | null>(null);
  const taHoldAteClickRef = useRef(false);
  const eraserHoldTimerRef = useRef<number | null>(null);
  const eraserHoldAteClickRef = useRef(false);
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
    const emptyTaDing = new Set<string>();
    setTaDingKeys(emptyTaDing);
    taDingKeysRef.current = emptyTaDing;
    setAccentMapVersion(0);
    setSquarePlaybackMode('all_beats');
    setDictantMode(false);
    setIsTaEditorMode(false);
    setIsDeadCellsEditorMode(false);
    setFirstBeatDingSuppressedRows(new Set());
    setTempo(defaults.tempo);
    tempoRef.current = defaults.tempo;
    const defaultBars = defaults.bars;
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
    setPulseMeterUnlinked({});
    pulseMeterUnlinkedRef.current = {};
    setFrozenScale(null);
    frozenScaleRef.current = null;
  };

  const toggleRandomFeature = (feature: 'pulsation' | 'pattern' | 'speed' | 'barSpeed') => {
    let willBeEnabled = false;
    if (feature === 'pulsation') {
      willBeEnabled = !randomPulsation;
      setRandomPulsation(!randomPulsation);
    } else if (feature === 'pattern') {
      willBeEnabled = !randomPattern;
      setRandomPattern(!randomPattern);
    } else if (feature === 'speed') {
      willBeEnabled = !randomSpeed;
      setRandomSpeed(!randomSpeed);
    } else if (feature === 'barSpeed') {
      willBeEnabled = !randomBarSpeed;
      setRandomBarSpeed(!randomBarSpeed);
    }
    
    if (willBeEnabled && !randomModeEnabled) {
      setRandomModeEnabled(true);
    }
  };

  // (Removed Djembe hold timers)

  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledPageRef = useRef<number>(-1);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timerIDRef = useRef<number | null>(null);
  const playheadQueueRef = useRef<PlayheadHighlightEvent[]>([]);
  const playheadTimerRef = useRef<number | null>(null);
  const previewResetTimerRef = useRef<number | null>(null);
  const polyClickSlotsRef = useRef<Set<number>>(new Set());
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
  const taDingKeysRef = useRef<Set<string>>(taDingKeys);
  const customSyllablesRef = useRef(customSyllables);
  const deadCellsRef = useRef<DeadCellsMap>(deadCells);
  const customMultipliersRef = useRef(customMultipliers);
  const customSubdivisionsRef = useRef(customSubdivisions);
  const pulseMeterUnlinkedRef = useRef(pulseMeterUnlinked);
  const onlyAccentsRef = useRef(onlyAccents);
  const squarePlaybackModeRef = useRef<SquarePlaybackMode>(squarePlaybackMode);
  const dictantModeRef = useRef(dictantMode);
  const firstBeatAccentRef = useRef(firstBeatAccent);
  const accentMapVersionRef = useRef(accentMapVersion);
  const isTaEditorModeRef = useRef(isTaEditorMode);
  const isDeadCellsEditorModeRef = useRef(isDeadCellsEditorMode);
  const firstBeatDingSuppressedRowsRef = useRef(firstBeatDingSuppressedRows);
  const randomModeEnabledRef = useRef(randomModeEnabled);
  const randomPulsationRef = useRef(randomPulsation);
  const randomPatternRef = useRef(randomPattern);
  const randomSpeedRef = useRef(randomSpeed);
  const randomBarSpeedRef = useRef(randomBarSpeed);
  const chaosLevelRef = useRef(chaosLevel);
  const clickSoundRef = useRef(clickSound);
  const frozenScaleRef = useRef(frozenScale);

  /** Пока тянут глобальные слайдеры Bars/Syllables — не писать `snapshots` из эффекта; flush на pointerup. */
  const barsSliderDraggingRef = useRef(false);
  const syllablesSliderDraggingRef = useRef(false);
  const sliderWindowListenersAttachedRef = useRef(false);
  const onWindowPointerEndCaptureRef = useRef<() => void>(() => {});
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

  useEffect(() => { barsRef.current = bars; }, [bars]);
  useEffect(() => { syllablesRef.current = syllables; }, [syllables]);
  useEffect(() => { tempoRef.current = tempo; }, [tempo]);
  useEffect(() => { setTempoUi(tempo); }, [tempo]);
  useEffect(() => { accentsRef.current = new Set(accents); }, [accents]);
  useEffect(() => { customMultipliersRef.current = { ...customMultipliers }; }, [customMultipliers]);
  useEffect(() => { customSubdivisionsRef.current = { ...customSubdivisions }; }, [customSubdivisions]);
  useEffect(() => {
    pulseMeterUnlinkedRef.current = { ...pulseMeterUnlinked };
  }, [pulseMeterUnlinked]);
  useEffect(() => { customSyllablesRef.current = { ...customSyllables }; }, [customSyllables]);
  useEffect(() => { deadCellsRef.current = { ...deadCells }; }, [deadCells]);
  useEffect(() => {
    onlyAccentsRef.current = squarePlaybackMode === 'accent_only';
    squarePlaybackModeRef.current = squarePlaybackMode;
  }, [squarePlaybackMode]);
  useEffect(() => { firstBeatAccentRef.current = firstBeatAccent; }, [firstBeatAccent]);
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
  useEffect(() => { randomModeEnabledRef.current = randomModeEnabled; }, [randomModeEnabled]);
  useEffect(() => { randomPulsationRef.current = randomPulsation; }, [randomPulsation]);
  useEffect(() => { randomPatternRef.current = randomPattern; }, [randomPattern]);
  useEffect(() => { randomSpeedRef.current = randomSpeed; }, [randomSpeed]);
  useEffect(() => { randomBarSpeedRef.current = randomBarSpeed; }, [randomBarSpeed]);
  useEffect(() => { chaosLevelRef.current = chaosLevel; }, [chaosLevel]);
  useEffect(() => { clickSoundRef.current = clickSound; }, [clickSound]);

  useEffect(() => {
    cloneClickMixerFromLibrary(clickSound);
    setMixerUiTick((x) => x + 1);
  }, [clickSound]);

  const syncMixerVoiceBus = useCallback((voice: MetroVoiceKey) => {
    const ctx = audioCtxRef.current;
    const g = clickMixerGroupRef.current;
    if (!ctx || !g) return;
    getVoiceLayerSumInput(ctx, voice);
    applyVoiceGroupChain(ctx, voice, g[voice].groupHpHz, g[voice].groupLpHz, g[voice].groupMasterLinear);
  }, []);

  useEffect(() => {
    if (!mixerPanelOpen) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    (['accent', 'alt', 'passive'] as const).forEach((v) => syncMixerVoiceBus(v));
  }, [mixerPanelOpen, syncMixerVoiceBus]);
  useEffect(() => { frozenScaleRef.current = frozenScale; }, [frozenScale]);
  useEffect(() => { polyModeRef.current = polyMode; }, [polyMode]);
  useEffect(() => { polyVoicesRef.current = polyVoices; }, [polyVoices]);
  useEffect(() => {
    if (!polyMode) return;
    const normalized = normalizeBarsForMode(barsRef.current);
    if (normalized !== barsRef.current) {
      applyBarsWithPotatoFreeze(normalized);
    }
  }, [polyMode, polyVoices, normalizeBarsForMode, applyBarsWithPotatoFreeze]);

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

  const beginTempoMinusHold = useCallback(() => {
    tempoMinusHoldAteClickRef.current = false;
    clearTempoHoldRepeat();
    tempoHoldTimeoutRef.current = window.setTimeout(() => {
      tempoHoldTimeoutRef.current = null;
      tempoMinusHoldAteClickRef.current = true;
      applyTempoImmediate(tempoRef.current - TEMPO_HOLD_REPEAT_STEP);
      tempoHoldIntervalRef.current = window.setInterval(() => {
        applyTempoImmediate(tempoRef.current - TEMPO_HOLD_REPEAT_STEP);
      }, TEMPO_HOLD_REPEAT_MS);
    }, TEMPO_HOLD_REPEAT_MS);
  }, [applyTempoImmediate, clearTempoHoldRepeat]);

  const beginTempoPlusHold = useCallback(() => {
    tempoPlusHoldAteClickRef.current = false;
    clearTempoHoldRepeat();
    tempoHoldTimeoutRef.current = window.setTimeout(() => {
      tempoHoldTimeoutRef.current = null;
      tempoPlusHoldAteClickRef.current = true;
      applyTempoImmediate(tempoRef.current + TEMPO_HOLD_REPEAT_STEP);
      tempoHoldIntervalRef.current = window.setInterval(() => {
        applyTempoImmediate(tempoRef.current + TEMPO_HOLD_REPEAT_STEP);
      }, TEMPO_HOLD_REPEAT_MS);
    }, TEMPO_HOLD_REPEAT_MS);
  }, [applyTempoImmediate, clearTempoHoldRepeat]);

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

  const buildLiveSnapshotFromRefs = (): ReturnType<typeof createEmptySnapshot> => ({
    tempo: tempoRef.current,
    bars: barsRef.current,
    syllables: syllablesRef.current,
    accents: new Set(accentsRef.current),
    taDingKeys: new Set(taDingKeysRef.current),
    customSyllables: { ...customSyllablesRef.current },
    customMultipliers: { ...customMultipliersRef.current },
    customSubdivisions: { ...customSubdivisionsRef.current },
    randomModeEnabled: randomModeEnabledRef.current,
    randomPulsation: randomPulsationRef.current,
    randomPattern: randomPatternRef.current,
    randomSpeed: randomSpeedRef.current,
    randomBarSpeed: randomBarSpeedRef.current,
    chaosLevel: chaosLevelRef.current,
    clickSound: clickSoundRef.current,
    panelExpanded: isPanelExpandedRef.current,
    pulseMeterUnlinked: { ...pulseMeterUnlinkedRef.current },
    frozenScale: frozenScaleRef.current,
    polyMode: polyModeRef.current,
    polyVoices: polyVoicesRef.current,
    onlyAccents: squarePlaybackModeRef.current === 'accent_only',
    squarePlaybackMode: squarePlaybackModeRef.current,
    firstBeatAccent: firstBeatAccentRef.current,
    accentMapVersion: accentMapVersionRef.current,
    syllableReadMuteMode: syllableReadMuteModeRef.current,
    dictantMode: dictantModeRef.current,
    deadCells: { ...deadCellsRef.current },
  });

  const prefillAllTactsRandomizer = useCallback(() => {
    const chaos = chaosLevelRef.current;
    const nBars = barsRef.current;
    const syllablesDefault = syllablesRef.current;
    const rp = randomPulsationRef.current;
    const rpat = randomPatternRef.current;
    const rs = randomSpeedRef.current;
    const rbs = randomBarSpeedRef.current;
    const oa = onlyAccentsRef.current;
    const hasAny = rp || rpat || rs || rbs;

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

    const cs = { ...customSyllablesRef.current };
    const cd = { ...customSubdivisionsRef.current };
    const cm = { ...customMultipliersRef.current };
    const dc = { ...deadCellsRef.current };
    const acc = new Set<string>(accentsRef.current);

    let any = false;
    for (let r = 0; r < nBars; r++) {
      if (
        applyRandomizerEffectsToBar(r, chaos, rp, rpat, rs, rbs, oa, syllablesDefault, {
          customSyllables: cs,
          accents: acc,
          customSubdivisions: cd,
          customMultipliers: cm,
          deadCells: dc,
        })
      ) {
        any = true;
      }
    }
    if (!any) return;

    customSyllablesRef.current = cs;
    customSubdivisionsRef.current = cd;
    customMultipliersRef.current = cm;
    deadCellsRef.current = dc;
    accentsRef.current = acc;

    startTransition(() => {
      setCustomSyllables({ ...cs });
      setAccents(new Set(acc));
      setCustomSubdivisions({ ...cd });
      setCustomMultipliers({ ...cm });
      setDeadCells({ ...dc });
    });
  }, []);

  const stableWindowPointerEnd = useCallback(() => {
    onWindowPointerEndCaptureRef.current();
  }, []);

  const attachSliderWindowListeners = useCallback(() => {
    if (sliderWindowListenersAttachedRef.current) return;
    sliderWindowListenersAttachedRef.current = true;
    window.addEventListener('pointerup', stableWindowPointerEnd, true);
    window.addEventListener('pointercancel', stableWindowPointerEnd, true);
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

    const prunedAccents = new Set<string>();
    for (const k of accentsRef.current) {
      const parts = k.split('-');
      if (parts.length !== 2) continue;
      const r = parseInt(parts[0], 10);
      const c = parseInt(parts[1], 10);
      if (Number.isFinite(r) && Number.isFinite(c) && r >= 0 && r < nBars && c >= 0 && c < next) {
        prunedAccents.add(k);
      }
    }
    setAccents(prunedAccents);
    accentsRef.current = prunedAccents;

    const prunedTaDing = new Set<string>();
    for (const k of taDingKeysRef.current) {
      const parts = k.split('-');
      if (parts.length !== 2) continue;
      const r = parseInt(parts[0], 10);
      const c = parseInt(parts[1], 10);
      if (Number.isFinite(r) && Number.isFinite(c) && r >= 0 && r < nBars && c >= 0 && c < next) {
        prunedTaDing.add(k);
      }
    }
    setTaDingKeys(prunedTaDing);
    taDingKeysRef.current = prunedTaDing;

    const prevSub = customSubdivisionsRef.current;
    const nextSub: Record<string, number> = {};
    for (const [k, v] of Object.entries(prevSub)) {
      const parts = k.split('-');
      if (parts.length !== 2) continue;
      const r = parseInt(parts[0], 10);
      const c = parseInt(parts[1], 10);
      if (Number.isFinite(r) && Number.isFinite(c) && r >= 0 && r < nBars && c >= 0 && c < next) {
        const vn = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(vn)) nextSub[k] = vn;
      }
    }
    setCustomSubdivisions(nextSub);
    customSubdivisionsRef.current = { ...nextSub };

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
      const live = Math.max(1, Math.min(oldRowSyl, meta.deadStart));
      const newLive = Math.max(1, Math.min(next, Math.round((live * next) / oldRowSyl)));
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

    const newSeq: { r: number; c: number; activeSyllables: number }[] = [];
    for (let r = 0; r < nBars; r++) {
      const syls = next;
      const deadStart = nextDc[r]?.deadStart;
      const playable = typeof deadStart === 'number' ? Math.max(1, Math.min(syls, deadStart)) : syls;
      for (let c = 0; c < playable; c++) {
        newSeq.push({ r, c, activeSyllables: playable });
      }
    }

    if (sequenceRef.current.length > 0 && newSeq.length > 0) {
      const oldItem = sequenceRef.current[currentStepRef.current];
      if (oldItem) {
        const rowDead = nextDc[oldItem.r]?.deadStart;
        const rowPlayable =
          typeof rowDead === 'number' ? Math.max(1, Math.min(next, rowDead)) : next;
        const targetC = Math.min(oldItem.c, rowPlayable - 1);
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

  onWindowPointerEndCaptureRef.current = () => {
    if (!barsSliderDraggingRef.current && !syllablesSliderDraggingRef.current) return;
    barsSliderDraggingRef.current = false;
    syllablesSliderDraggingRef.current = false;
    if (sliderWindowListenersAttachedRef.current) {
      sliderWindowListenersAttachedRef.current = false;
      window.removeEventListener('pointerup', stableWindowPointerEnd, true);
      window.removeEventListener('pointercancel', stableWindowPointerEnd, true);
    }
    flushLiveSnapshotToActiveSlotRef.current();
  };

  useEffect(() => {
    return () => {
      if (sliderWindowListenersAttachedRef.current) {
        sliderWindowListenersAttachedRef.current = false;
        window.removeEventListener('pointerup', stableWindowPointerEnd, true);
        window.removeEventListener('pointercancel', stableWindowPointerEnd, true);
      }
    };
  }, [stableWindowPointerEnd]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        onWindowPointerEndCaptureRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

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
      taDingKeys: taDingKeysArr,
      sequencerCells: raw.sequencerCells,
      customSyllables: raw.customSyllables,
      customMultipliers: raw.customMultipliers,
      customSubdivisions: raw.customSubdivisions,
      randomModeEnabled: raw.randomModeEnabled,
      randomPulsation: raw.randomPulsation,
      randomPattern: raw.randomPattern,
      randomSpeed: raw.randomSpeed,
      randomBarSpeed: raw.randomBarSpeed,
      chaosLevel: raw.chaosLevel,
      clickSound: raw.clickSound,
      panelExpanded: raw.panelExpanded,
      pulseMeterUnlinked: raw.pulseMeterUnlinked,
      frozenScale: raw.frozenScale,
      polyMode: raw.polyMode,
      polyVoices: raw.polyVoices,
      onlyAccents: raw.onlyAccents,
      squarePlaybackMode: (raw as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode,
      firstBeatAccent: raw.firstBeatAccent,
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
  const disableMenuSmoothing = lowPerfMode || bars > 8 || syllables >= 9;

  const sequence = React.useMemo(() => {
    const seq = [];
    for (let r = 0; r < bars; r++) {
      const syls = customSyllables[r] !== undefined ? customSyllables[r] : syllables;
      const deadStart = deadCells[r]?.deadStart;
      const playable = typeof deadStart === 'number' ? Math.max(1, Math.min(syls, deadStart)) : syls;
      for (let c = 0; c < playable; c++) {
        seq.push({ r, c, activeSyllables: playable });
      }
    }
    return seq;
  }, [bars, syllables, customSyllables, deadCells]);

  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence; // Always keep ref atomic with render
  const polyChunks = useMemo(() => buildPolyChunks(bars, polyVoices), [bars, polyVoices]);
  const polyChunksRef = useRef(polyChunks);
  polyChunksRef.current = polyChunks;

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
          taDingKeys,
          customSyllables,
          deadCells,
          customMultipliers,
          customSubdivisions,
          randomModeEnabled,
          randomPulsation,
          randomPattern,
          randomSpeed,
          randomBarSpeed,
          chaosLevel: chaosLevelRef.current,
          clickSound,
          panelExpanded: isPanelExpanded,
          pulseMeterUnlinked: { ...pulseMeterUnlinked },
          frozenScale,
          polyMode,
          polyVoices,
          squarePlaybackMode,
          onlyAccents: squarePlaybackMode === 'accent_only',
          firstBeatAccent,
          accentMapVersion,
          syllableReadMuteMode,
          dictantMode,
        },
      }));
    });
  }, [
    tempo,
    bars,
    syllables,
    accents,
    taDingKeys,
    customSyllables,
    deadCells,
    customMultipliers,
    customSubdivisions,
    pulseMeterUnlinked,
    activeSnapshot,
    randomModeEnabled,
    randomPulsation,
    randomPattern,
    randomSpeed,
    randomBarSpeed,
    clickSound,
    isPanelExpanded,
    frozenScale,
    polyMode,
    polyVoices,
    squarePlaybackMode,
    firstBeatAccent,
    accentMapVersion,
    syllableReadMuteMode,
    dictantMode,
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
      setTempo(snap.tempo);
      setBars(snap.bars);
      setSyllables(snap.syllables);
    setAccents(
      new Set(
        Array.isArray(snap.accents)
          ? snap.accents
          : snap.accents instanceof Set
            ? [...snap.accents]
            : [],
      ),
    );
    setTaDingKeys(
      new Set(
        Array.isArray(snap.taDingKeys)
          ? snap.taDingKeys
          : snap.taDingKeys instanceof Set
            ? [...snap.taDingKeys]
            : [],
      ),
    );
      setCustomSyllables({ ...snap.customSyllables });
      setDeadCells({ ...((snap as { deadCells?: DeadCellsMap }).deadCells || {}) });
      deadCellsRef.current = { ...((snap as { deadCells?: DeadCellsMap }).deadCells || {}) };
      setCustomMultipliers({ ...(snap.customMultipliers || {}) });
      setCustomSubdivisions({ ...(snap.customSubdivisions || {}) });
    setRandomModeEnabled(
      snap.randomModeEnabled !== undefined ? Boolean(snap.randomModeEnabled) : false,
    );
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
    setClickSound(isClickSoundPreset(snap.clickSound) ? snap.clickSound : 'classic');
    setPulseMeterUnlinked(normalizePulseMeterUnlinked(snap.pulseMeterUnlinked));
    const modeFromSnap = (snap as { squarePlaybackMode?: unknown }).squarePlaybackMode;
    if (modeFromSnap === 'all_beats' || modeFromSnap === 'accent_only' || modeFromSnap === 'passive_only') {
      setSquarePlaybackMode(modeFromSnap);
    } else {
      setSquarePlaybackMode(snap.onlyAccents === true ? 'accent_only' : 'all_beats');
    }
    setFirstBeatAccent(snap.firstBeatAccent !== false);
    setAccentMapVersion((snap as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0);
    setDictantMode((snap as { dictantMode?: boolean }).dictantMode === true);
    setIsTaEditorMode(false);
    setFirstBeatDingSuppressedRows(new Set());
    const nextMute = normalizeSyllableReadMuteModeFromSnapshot(
      snap.syllableReadMuteMode,
      (snap as { syllableReadMuteLatched?: boolean }).syllableReadMuteLatched,
    );
    setSyllableReadMuteMode(nextMute);
    syllableReadMuteModeRef.current = nextMute;
    setFrozenScale(
      typeof snap.frozenScale === 'number' && snap.frozenScale >= 1 ? snap.frozenScale : null,
    );
    setPolyMode(snap.polyMode === true);
    setPolyVoices(parsePolyVoices(snap.polyVoices));
    if (!options?.preservePanel) {
      setIsPanelExpanded(snap.panelExpanded === true);
    }
  };

  const loadSnapshot = (id: number) => {
    onWindowPointerEndCaptureRef.current();
    flushChaosToActiveSnapshot();
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
    panelExpanded: s.panelExpanded === true,
    pulseMeterUnlinked: { ...(s.pulseMeterUnlinked || {}) },
    frozenScale: typeof s.frozenScale === 'number' && s.frozenScale >= 1 ? s.frozenScale : null,
    polyMode: s.polyMode === true,
    polyVoices: parsePolyVoices(s.polyVoices),
    squarePlaybackMode:
      (s as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode === 'accent_only' ||
      (s as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode === 'passive_only' ||
      (s as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode === 'all_beats'
        ? (s as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode!
        : s.onlyAccents === true
          ? 'accent_only'
          : 'all_beats',
    onlyAccents:
      ((s as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode === 'accent_only') ||
      ((s as { squarePlaybackMode?: SquarePlaybackMode }).squarePlaybackMode === undefined && s.onlyAccents === true),
    firstBeatAccent: s.firstBeatAccent !== false,
    accentMapVersion: (s as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
    syllableReadMuteMode: normalizeSyllableReadMuteModeFromSnapshot(s.syllableReadMuteMode, undefined),
    dictantMode: (s as { dictantMode?: boolean }).dictantMode === true,
  });

  const closeSnapshotClipMenu = () => setSnapshotClipMenu(null);

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

  const pasteSnapshotFromClipboard = async (slot: number) => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      console.warn('[konnakol_trainer] clipboard read failed', e);
      showClipboardToast('Clipboard access denied');
      closeSnapshotClipMenu();
      return;
    }
    const parsed = tryDecodeSnapshotClipboard(text);
    if (!parsed) {
      showClipboardToast('No snapshot marker found in clipboard');
      closeSnapshotClipMenu();
      return;
    }
    try {
      const stored = normalizeSnapshotForStorage(parsed);
      onWindowPointerEndCaptureRef.current();
      flushChaosToActiveSnapshot();
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
      if (currentStepRef.current >= polyChunks.length) {
        currentStepRef.current = 0;
      }
      return;
    }
    if (currentStepRef.current >= sequence.length) {
      currentStepRef.current = 0;
    }
  }, [polyMode, polyChunks.length, sequence.length]);

  // Display metrics (displayScaleBars / allBarsFitViewport объявлены выше — общая шкала для сетки и скролла)
  const useFixedFlex = frozenScale !== null || bars > 10;
  
  // Create a scroll stride that overlaps by 1 row
  const scrollStride = Math.max(1, displayScaleBars - 1);

  const setRowElStable = useCallback((absR: number, el: HTMLDivElement | null) => {
    rowRefs.current[absR] = el;
  }, []);
  const primaryActivePos = useMemo(() => {
    if (!polyMode || activePositions.length === 0) return activePos;
    const master = activePositions.find((pos) => pos.voice === 0) ?? activePositions[0];
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
      lastScrolledPageRef.current = -1;
      if (gridRef.current) gridRef.current.scrollTop = 0;
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
              rowEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        lastScrolledPageRef.current = logicalPage;
        const pageStartAbsR = logicalPage * scrollStride;
        const rowEl = rowRefs.current[pageStartAbsR];
        
        if (rowEl) {
           rowEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  ]);

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
      if (clipboardToastTimerRef.current !== null) {
        window.clearTimeout(clipboardToastTimerRef.current);
        clipboardToastTimerRef.current = null;
      }
      if (squareHoldTimerRef.current !== null) {
        window.clearTimeout(squareHoldTimerRef.current);
        squareHoldTimerRef.current = null;
      }
      if (randomDiceHoldTimerRef.current !== null) {
        window.clearTimeout(randomDiceHoldTimerRef.current);
        randomDiceHoldTimerRef.current = null;
      }
      if (taHoldTimerRef.current !== null) {
        window.clearTimeout(taHoldTimerRef.current);
        taHoldTimerRef.current = null;
      }
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

  const clearPlayheadScheduling = () => {
    if (playheadTimerRef.current !== null) {
      window.clearTimeout(playheadTimerRef.current);
      playheadTimerRef.current = null;
    }
    playheadQueueRef.current = [];
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
    const polyLatestByVoice = new Map<number, PlayheadPosition>();
    while (q.length > 0 && q[0].t <= ctx.currentTime) {
      const due = q.shift()!.pos;
      if (polyModeRef.current) {
        polyLatestByVoice.set(due.voice, due);
      }
      lastPos = due;
    }
    if (polyModeRef.current) {
      const nextActive = Array.from(polyLatestByVoice.values()).sort((a, b) => a.voice - b.voice);
      if (nextActive.length > 0) {
        setActivePositions(nextActive);
        const primary = nextActive.find((pos) => pos.voice === 0) ?? nextActive[0];
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
    if (c === 0) setAccentMapVersion(1);
    const key = `${r}-${c}`;
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

  const toggleTaDing = useCallback((r: number, c: number) => {
    if (c < 0) return;
    const key = `${r}-${c}`;
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
    const fa = firstBeatAccentRef.current;
    if (hadKey) {
      setTaDingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      /* Иначе при снятии явного taDing на первой доле снова показывается дефолтный белый от `firstBeatAccent`. */
      if (fa) {
        setFirstBeatDingSuppressedRows((prev) => new Set(prev).add(r));
      }
      return;
    }
    if (fa && !suppressed) {
      setFirstBeatDingSuppressedRows((prev) => new Set(prev).add(r));
      return;
    }
    if (suppressed) {
      setFirstBeatDingSuppressedRows((prev) => {
        const n = new Set(prev);
        n.delete(r);
        return n;
      });
    }
    setTaDingKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const triggerDeadCut = useCallback((barIndex: number, startCell: number) => {
    const baseNow = customSyllablesRef.current[barIndex] !== undefined
      ? customSyllablesRef.current[barIndex]
      : syllablesRef.current;
    const activeCount = Math.max(1, Math.min(baseNow, startCell));
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
        } else if (randomModeEnabledRef.current) {
          const targetR = currentSeqItem.r;
          const prevBar = (targetR - 1 + barsRef.current) % barsRef.current;

          const chaos = chaosLevelRef.current;
          const m = {
            customSyllables: customSyllablesRef.current,
            accents: accentsRef.current,
            customSubdivisions: customSubdivisionsRef.current,
            customMultipliers: customMultipliersRef.current,
            deadCells: deadCellsRef.current,
          };
          const didChange = applyRandomizerEffectsToBar(
            prevBar,
            chaos,
            randomPulsationRef.current,
            randomPatternRef.current,
            randomSpeedRef.current,
            randomBarSpeedRef.current,
            onlyAccentsRef.current,
            syllablesRef.current,
            m,
          );

          if (didChange) {
            const newSeq = [];
            for (let r = 0; r < barsRef.current; r++) {
              const syls = customSyllablesRef.current[r] !== undefined ? customSyllablesRef.current[r] : syllablesRef.current;
              const deadStart = deadCellsRef.current[r]?.deadStart;
              const playable = typeof deadStart === 'number' ? Math.max(1, Math.min(syls, deadStart)) : syls;
              for (let c = 0; c < playable; c++) {
                newSeq.push({ r, c, activeSyllables: playable });
              }
            }
            sequenceRef.current = newSeq;
            
            const targetStepIndex = sequenceRef.current.findIndex(item => item.r === targetR && item.c === 0);
            if (targetStepIndex !== -1) {
              currentStepRef.current = targetStepIndex;
            } else {
              currentStepRef.current = 0;
            }
            
            currentSeqItem = sequenceRef.current[currentStepRef.current];

            setTimeout(() => {
              startTransition(() => {
                if (randomPulsationRef.current) setCustomSyllables({ ...customSyllablesRef.current });
              if (randomPatternRef.current) setAccents(new Set(accentsRef.current));
                if (randomSpeedRef.current) setCustomSubdivisions({ ...customSubdivisionsRef.current });
                if (randomBarSpeedRef.current) setDeadCells({ ...deadCellsRef.current });
              });
            }, 0);
          }
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
    (rIdx: number, cIdx: number, absR: number, time: number, voice: number, step: number, noteDuration: number) => {
      if (!audioCtxRef.current) return;
      const isAccent = accentsRef.current.has(`${rIdx}-${cIdx}`);
      const subdivs = customSubdivisionsRef.current[`${rIdx}-${cIdx}`] || 1;
      const subDuration = Math.max(0.001, noteDuration / Math.max(1, subdivs));
      const muteMode = syllableReadMuteModeRef.current;
      const on0Accent = accentsRef.current.has(`${rIdx}-0`);
      const on0Ding = taDingKeysRef.current.has(`${rIdx}-0`);
      const supRow = firstBeatDingSuppressedRowsRef.current.has(rIdx);
      const fa = firstBeatAccentRef.current;
      const firstBeatCellHitRow = on0Accent || on0Ding || (fa && !supRow);
      for (let sub = 0; sub < subdivs; sub++) {
        const subTime = time + sub * subDuration;
        const polySlotKey = Math.round(subTime * 100000);
        const shouldDedupPolyClick = polyModeRef.current && polyClickSlotsRef.current.has(polySlotKey);
        const isFirstOfBar = cIdx === 0 && sub === 0;
        /** Фиолетовый акцент на этой поддоле (до веток Ta / dedup). */
        const mainAccentClick = isAccent && (subdivs > 1 || sub === 0);
        const shouldPlayFirstBeatTa =
          isFirstOfBar &&
          firstBeatAccentRef.current &&
          firstBeatCellHitRow &&
          (!polyModeRef.current || voice === 0);
        if (shouldPlayFirstBeatTa) {
          playBarFirstHighClick(audioCtxRef.current, subTime, clickSoundRef.current);
          if (polyModeRef.current) {
            polyClickSlotsRef.current.add(polySlotKey);
          }
        }
        if (shouldDedupPolyClick) {
          continue;
        }
        const playbackMode = squarePlaybackModeRef.current;
        const taEnabled = firstBeatAccentRef.current;
        const isTaDingCell = taEnabled && cIdx >= 1 && taDingKeysRef.current.has(`${rIdx}-${cIdx}`);
        /** В т.ч. в passive_only: Ta-разметка по сетке должна звучать (не мьютить кастомные позиции). */
        const shouldPlayTaDingSound =
          sub === 0 &&
          isTaDingCell &&
          (!polyModeRef.current || voice === 0);
        const hasTaDingHere = taEnabled && taDingKeysRef.current.has(`${rIdx}-${cIdx}`);
        const dictantActive = dictantModeRef.current;
        const shouldPlayBeat =
          playbackMode === 'all_beats'
            ? true
            : playbackMode === 'accent_only'
              ? isAccent || hasTaDingHere
              : false;
        const isTaFirstBeatArticulation =
          cIdx === 0 && sub === 0 && firstBeatAccentRef.current && firstBeatCellHitRow;
        const sharpAsChecked = (() => {
          if (dictantActive) return mainAccentClick;
          if (muteMode === 'no_accent_sharp' && mainAccentClick && !isTaFirstBeatArticulation) return false;
          return mainAccentClick;
        })();
        /**
         * Составной тембр Ta: всегда ding + пассивный слой (те же параметры, что у пассивной доли в `playSharpClick`).
         * До `muteMode === 'full'`, чтобы полный мьют сетки не резал второй слой Ta.
         */
        if (shouldPlayTaDingSound) {
          playBarFirstHighClick(audioCtxRef.current, subTime, clickSoundRef.current);
          if (polyModeRef.current) {
            polyClickSlotsRef.current.add(polySlotKey);
          }
        }
        if (muteMode === 'full') continue;
        if (!shouldPlayBeat) continue;
        /** Пассив Ta уже в составном тембре — не дублировать тот же щелчок сетки (в т.ч. при no_accent_sharp / мьютах пассива). */
        if (shouldPlayTaDingSound && !sharpAsChecked && playbackMode !== 'all_beats') {
          continue;
        }
        /** Первая доля уже сыграла ding+пассив — не дублировать пассив сетки на (0,0). */
        if (shouldPlayFirstBeatTa && !sharpAsChecked && playbackMode !== 'all_beats') {
          continue;
        }
        /**
         * На Ta+фиолет акцент пассив уже сыгран вторым слоем Ta; в accent_only смесь 800+920 дала бы второй 800.
         * То же для первой доли с акцентом: пассив уже в составном ударе выше.
         * Оставляем только верх акцента (ветка `playSharpClick(..., accentOnlyPlayback: false)` для classic).
         */
        const accentOnlyPlayback =
          (playbackMode !== 'all_beats' || dictantActive) &&
          !(shouldPlayTaDingSound && isAccent) &&
          !(shouldPlayFirstBeatTa && isAccent);
        const voiceRole: 'accent' | 'base' | 'alt' =
          sharpAsChecked
            ? 'accent'
            : shouldPlayFirstBeatTa
              ? 'base'
            : shouldPlayTaDingSound
              ? 'base'
              : 'base';
        playSharpClick(
          audioCtxRef.current,
          subTime,
          sharpAsChecked,
          clickSoundRef.current,
          accentOnlyPlayback,
          voiceRole,
        );
        if (sharpAsChecked && playbackMode === 'all_beats' && !shouldPlayFirstBeatTa && !shouldPlayTaDingSound) {
          playSharpClick(
            audioCtxRef.current,
            subTime,
            false,
            clickSoundRef.current,
            false,
            'alt',
          );
        }
        if (polyModeRef.current) {
          polyClickSlotsRef.current.add(polySlotKey);
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

  const playTwoBarsPreviewFromGrid = useCallback((soundPreset: ClickSoundPreset) => {
    if (isPlayingRef.current || isTaEditorModeRef.current || isDeadCellsEditorModeRef.current) return;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (previewResetTimerRef.current !== null) {
      window.clearTimeout(previewResetTimerRef.current);
      previewResetTimerRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    audioCtxRef.current = new AudioContextClass();
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    if (!audioCtxRef.current) return;
    {
      const ctxBoot = audioCtxRef.current;
      const gBoot = clickMixerGroupRef.current;
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
    clickSoundRef.current = soundPreset;
    const barsCount = Math.max(1, barsRef.current);
    let cursor = audioCtxRef.current.currentTime + METRA_SCHEDULE_AHEAD_SEC;
    for (let i = 0; i < 2; i++) {
      const rowIdx = i % barsCount;
      const rowSyllables =
        customSyllablesRef.current[rowIdx] !== undefined
          ? customSyllablesRef.current[rowIdx]
          : syllablesRef.current;
      const deadStart = deadCellsRef.current[rowIdx]?.deadStart;
      const playable = typeof deadStart === 'number' ? Math.max(1, Math.min(rowSyllables, deadStart)) : rowSyllables;
      const noteDuration = getLegacyNoteDurationSeconds(rowIdx);
      for (let cIdx = 0; cIdx < playable; cIdx++) {
        const noteTime = cursor + cIdx * noteDuration;
        scheduleGridCellAtTime(rowIdx, cIdx, rowIdx, noteTime, 0, cIdx, noteDuration);
      }
      cursor += noteDuration * Math.max(1, playable);
    }
    const resetDelayMs = Math.max(120, (cursor - audioCtxRef.current.currentTime) * 1000 + 80);
    previewResetTimerRef.current = window.setTimeout(() => {
      previewResetTimerRef.current = null;
      clearPlayheadScheduling();
      setActivePos({ r: -1, c: -1, absR: -1 });
      setActivePositions([]);
    }, resetDelayMs);
  }, [clearPlayheadScheduling, getLegacyNoteDurationSeconds, scheduleGridCellAtTime]);

  const scheduleNote = (stepIdx: number, absR: number, time: number) => {
    const seq = sequenceRef.current;
    const currentSeqItem = seq[stepIdx];
    if (!currentSeqItem) return;

    const { r: rIdx, c: cIdx } = currentSeqItem;
    const noteDuration = getLegacyNoteDurationSeconds(rIdx);
    scheduleGridCellAtTime(rIdx, cIdx, absR, time, 0, stepIdx, noteDuration);
  };

  const schedulePolyStep = useCallback((stepIdx: number, time: number) => {
    const chunks = polyChunksRef.current;
    if (chunks.length === 0) return 0.5;
    polyClickSlotsRef.current.clear();
    const safeStep = ((stepIdx % chunks.length) + chunks.length) % chunks.length;
    const chunk = chunks[safeStep];
    if (!chunk || chunk.length === 0) return 0.5;
    const masterBar = chunk[0]!;
    const windowDuration = getBarTimeWindowSeconds(masterBar);
    chunk.forEach((barIdx, voiceIdx) => {
      const rowSyllables =
        customSyllablesRef.current[barIdx] !== undefined ? customSyllablesRef.current[barIdx] : syllablesRef.current;
      const deadStart = deadCellsRef.current[barIdx]?.deadStart;
      const playable =
        typeof deadStart === 'number' ? Math.max(1, Math.min(rowSyllables, deadStart)) : rowSyllables;
      const noteDuration = windowDuration / Math.max(1, rowSyllables);
      for (let cIdx = 0; cIdx < playable; cIdx++) {
        const noteTime = time + cIdx * noteDuration;
        const absR = safeStep * polyVoicesRef.current + voiceIdx;
        scheduleGridCellAtTime(barIdx, cIdx, absR, noteTime, voiceIdx, safeStep, noteDuration);
      }
    });
    return windowDuration;
  }, [getBarTimeWindowSeconds, scheduleGridCellAtTime]);

  const scheduler = () => {
    if (!isPlayingRef.current || !audioCtxRef.current) return;
    if (audioCtxRef.current.currentTime > nextNoteTimeRef.current + 0.5) {
      nextNoteTimeRef.current = audioCtxRef.current.currentTime + METRA_SCHEDULE_AHEAD_SEC;
    }
    while (nextNoteTimeRef.current < audioCtxRef.current.currentTime + METRA_SCHEDULE_AHEAD_SEC) {
      if (polyModeRef.current) {
        const stepDuration = schedulePolyStep(currentStepRef.current, nextNoteTimeRef.current);
        nextNoteTimeRef.current += stepDuration;
        const chunkCount = Math.max(1, polyChunksRef.current.length);
        currentStepRef.current = (currentStepRef.current + 1) % chunkCount;
      } else {
        scheduleNote(currentStepRef.current, playAbsBarRef.current, nextNoteTimeRef.current);
        nextNote();
      }
    }
    timerIDRef.current = window.setTimeout(scheduler, METRA_LOOKAHEAD_MS);
  };

  const togglePlayback = () => {
    if (previewResetTimerRef.current !== null) {
      window.clearTimeout(previewResetTimerRef.current);
      previewResetTimerRef.current = null;
    }
    if (isPlaying) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      clearTempoHoldRepeat();
      tempoMinusHoldAteClickRef.current = false;
      tempoPlusHoldAteClickRef.current = false;
      clearPlayheadScheduling();
      setActivePos({ r: -1, c: -1, absR: -1 });
      setActivePositions([]);
      polyClickSlotsRef.current.clear();
      currentStepRef.current = 0; // Reset pattern position to start
      if (timerIDRef.current) clearTimeout(timerIDRef.current);
      if (squareHoldTimerRef.current !== null) {
        window.clearTimeout(squareHoldTimerRef.current);
        squareHoldTimerRef.current = null;
      }
      if (randomDiceHoldTimerRef.current !== null) {
        window.clearTimeout(randomDiceHoldTimerRef.current);
        randomDiceHoldTimerRef.current = null;
      }
      if (taHoldTimerRef.current !== null) {
        window.clearTimeout(taHoldTimerRef.current);
        taHoldTimerRef.current = null;
      }
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
      squareHoldAteClickRef.current = false;
      randomDiceHoldAteClickRef.current = false;
      taHoldAteClickRef.current = false;
      eraserHoldAteClickRef.current = false;
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    } else {
      if (isTaEditorModeRef.current || isDeadCellsEditorModeRef.current) return;
      if (!isClickSoundSelectorOpen) {
        if (!panelCollapseFrozenRef.current) {
          setIsPanelExpanded(false);
        }
        setShowRandomSettings(false);
      }
      setIsPlaying(true);
      isPlayingRef.current = true;
      clearPlayheadScheduling();
      setActivePositions([]);
      coldStartRef.current = true; // Mark cold start
      if (polyModeRef.current) {
        const startChunk = polyChunksRef.current[currentStepRef.current];
        playAbsBarRef.current = startChunk?.[0] ?? 0;
      } else {
        const startSeqItem = sequenceRef.current[currentStepRef.current];
        playAbsBarRef.current = startSeqItem ? startSeqItem.r : 0;
      }
      
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
      nextNoteTimeRef.current = audioCtxRef.current.currentTime + METRA_SCHEDULE_AHEAD_SEC;
      scheduler();
    }
  };

  /* Синхронизация refs с render до pointerup flush (до useEffect по deps). */
  tempoRef.current = pendingTempoRef.current ?? tempo;
  barsRef.current = bars;
  syllablesRef.current = syllables;
  accentsRef.current = accents;
  taDingKeysRef.current = taDingKeys;
  customSyllablesRef.current = { ...customSyllables };
  deadCellsRef.current = { ...deadCells };
  customMultipliersRef.current = { ...customMultipliers };
  customSubdivisionsRef.current = { ...customSubdivisions };
  pulseMeterUnlinkedRef.current = { ...pulseMeterUnlinked };
  polyModeRef.current = polyMode;
  polyVoicesRef.current = polyVoices;
  accentMapVersionRef.current = accentMapVersion;
  isTaEditorModeRef.current = isTaEditorMode;
  isDeadCellsEditorModeRef.current = isDeadCellsEditorMode;
  firstBeatAccentRef.current = firstBeatAccent;
  squarePlaybackModeRef.current = squarePlaybackMode;
  onlyAccentsRef.current = squarePlaybackMode === 'accent_only';
  dictantModeRef.current = dictantMode;
  firstBeatDingSuppressedRowsRef.current = firstBeatDingSuppressedRows;

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
  const forceFirstBeatEditorFrames = useMemo(() => {
    if (!firstBeatAccent) return false;
    if (firstBeatEditorSuppressedRowsSorted.length > 0) return true;
    // Если есть явные ding-метки не на дефолтной первой доле, держим белые рамки видимыми.
    for (const key of taDingKeys) {
      const parts = key.split('-');
      if (parts.length !== 2) continue;
      const c = parseInt(parts[1]!, 10);
      if (Number.isFinite(c) && c > 0) return true;
    }
    return false;
  }, [firstBeatAccent, firstBeatEditorSuppressedRowsSorted, taDingKeys]);
  const visibleTaDingKeys = useMemo(
    () => (firstBeatAccent ? taDingKeys : new Set<string>()),
    [firstBeatAccent, taDingKeys],
  );

  sequencerGridRowActionsRef.current = {
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
    setCustomSyllables,
    triggerDeadCut,
    restoreDeadRow,
    deadSwipeSessionRef,
    deadCellsRef,
    setPulseMeterUnlinked,
    toggleAccent,
    toggleTaDing,
    customSyllablesRef,
    pulseMeterUnlinkedRef,
  };

  /** Квадрат: заливка/бордер по циклу all / accent / Ta-only; при диктанте — +teal ring (не затирать режим). */
  const squarePlaybackButtonSurface =
    syllableReadMuteMode !== 'off'
      ? syllableReadMuteMode === 'full'
        ? `border border-amber-400/90 ${lowPerfMode ? '' : 'shadow-[0_0_14px_rgba(251,191,36,0.28)]'} text-amber-100`
        : `border border-purple-400 ${lowPerfMode ? '' : 'shadow-[0_0_15px_rgba(192,132,252,0.4)]'} text-purple-200`
      : squarePlaybackMode === 'accent_only'
        ? `border border-purple-500/40 bg-purple-700/30 hover:bg-purple-700/40 active:bg-purple-700/20 text-purple-200`
        : squarePlaybackMode === 'passive_only'
          ? `border border-cyan-500/50 bg-cyan-700/25 hover:bg-cyan-700/35 active:bg-cyan-700/15 text-cyan-200`
          : `border border-[#23314f] hover:bg-[#1a253c] active:bg-[#131b2c] text-slate-400 hover:text-slate-200`;
  const squareDictantChrome = dictantMode
    ? ` ring-2 ring-inset ring-teal-400/85${lowPerfMode ? '' : ' shadow-[0_0_14px_rgba(45,212,191,0.22)]'}`
    : '';
  const squarePlaybackModeLabel =
    syllableReadMuteMode === 'full'
      ? 'тишина по сетке (пресет)'
      : syllableReadMuteMode === 'no_accent_sharp'
        ? 'акценты со звуком пассивных (пресет)'
        : squarePlaybackMode === 'accent_only'
          ? 'только выделенные доли'
          : squarePlaybackMode === 'passive_only'
            ? 'только звук Ta'
            : 'все доли';

  return (
    <div className="min-h-screen bg-[#0b101e] sm:bg-black/95 text-slate-200 p-0 sm:p-6 font-sans flex flex-col items-center justify-center">
      {/* Phone emulator container */}
      <div className="w-full max-w-[390px] h-[100dvh] sm:h-[844px] sm:rounded-[2.5rem] sm:border-[6px] border-[#1e2a45] shadow-2xl bg-[#0b101e] flex flex-col gap-3 p-3 relative overflow-hidden shrink-0">
        
        {/* Top Header Controls */}
        <div className="flex gap-2 items-center">
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
          <button
            type="button"
            title="Mixer: три шины (акцент / alt / пассив) — сумма слоёв → HP → LP → мастер; громкости = параметры слоёв"
            onClick={() => setMixerPanelOpen((o) => !o)}
            className={`shrink-0 p-3 rounded-xl border transition-colors ${
              mixerPanelOpen
                ? 'bg-blue-600/25 border-blue-400/60 text-blue-100'
                : 'bg-[#161f33] border-[#23314f] text-slate-400 hover:text-slate-200'
            }`}
          >
            <SlidersHorizontal size={20} strokeWidth={2.25} />
          </button>
          {!isPanelExpanded && !showRandomSettings ? (
            <div className="flex-1 flex items-center gap-2 min-w-0 py-2 px-1.5 bg-[#161f33] rounded-xl border border-[#23314f] touch-none">
          <button 
                type="button"
                title="Коротко: −1 BPM. Удерживай: −5 каждые 0,1 с"
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
                onBeginTempoBpmInlineEdit={() => beginTempoInlineEdit('hdr')}
                tempoInlineEditing={tempoInlineEditing}
                tempoInlineFocusSlot={tempoInlineFocusSlot}
                tempoSliderSlot="hdr"
                tempoManualText={tempoManualText}
                onTempoManualTextChange={setTempoManualText}
                onCommitTempoInline={commitTempoInlineEdit}
                onCancelTempoInline={cancelTempoInlineEdit}
                className="flex-1 relative flex items-center h-8 min-w-0"
              />
              <button
                type="button"
                title="Коротко: +1 BPM. Удерживай: +5 каждые 0,1 с"
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
            onClick={handleTap}
            className="flex-1 py-3 bg-[#161f33] rounded-xl border border-[#23314f] font-semibold text-slate-300 tracking-wide hover:bg-[#1a253c] active:bg-purple-900/50 active:border-purple-500/50 active:text-purple-100 transition-all active:scale-95 duration-75"
          >
            Tap
          </button>
          )}
          <button 
            onPointerDown={() => {
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
                : polyMode
                  ? 'bg-[#161f33] border-[#23314f] text-slate-600'
                  : 'bg-[#161f33] border-[#23314f] text-slate-400 hover:text-red-400 hover:border-red-500/30 active:bg-red-500/20'
            }`}
            title="Clear Sequencer"
          >
            <Eraser size={20} />
          </button>
        </div>

        {mixerPanelOpen ? (
          <div className="rounded-xl border border-[#2f4066]/80 bg-[#12192a] p-2 shrink-0 max-h-[40vh] overflow-y-auto">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1 px-0.5 leading-tight">
              Mixer · слои → сумма → HP → LP → мастер (на каждый голос)
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-0.5">
              {(['accent', 'alt', 'passive'] as const).map((voice) => {
                const clone = clickMixerLayerClonesRef.current;
                const grp = clickMixerGroupRef.current;
                if (!clone || !grp) {
                  return <div key={voice} className="min-w-[104px] flex-1 rounded-lg bg-[#0b101e]/50" />;
                }
                const title = voice === 'accent' ? 'Акцент' : voice === 'alt' ? 'Alt' : 'Пассив';
                return (
                  <div
                    key={voice}
                    className="min-w-[104px] flex-1 rounded-lg border border-[#23314f]/90 bg-[#0b101e]/85 p-1.5 flex flex-col gap-1"
                  >
                    <div className="text-[10px] font-bold text-blue-200/90 text-center border-b border-[#23314f]/60 pb-0.5">
                      {title}
                    </div>
                    <label className="flex flex-col gap-0.5 text-[9px] text-slate-500">
                      Группа HP
                      <input
                        type="range"
                        min={20}
                        max={8000}
                        value={grp[voice].groupHpHz}
                        onInput={(e) => {
                          grp[voice].groupHpHz = Number(e.currentTarget.value);
                          syncMixerVoiceBus(voice);
                          setMixerUiTick((x) => x + 1);
                        }}
                        className="w-full h-1.5 accent-blue-500"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-[9px] text-slate-500">
                      Группа LP
                      <input
                        type="range"
                        min={500}
                        max={20000}
                        value={grp[voice].groupLpHz}
                        onInput={(e) => {
                          grp[voice].groupLpHz = Number(e.currentTarget.value);
                          syncMixerVoiceBus(voice);
                          setMixerUiTick((x) => x + 1);
                        }}
                        className="w-full h-1.5 accent-blue-500"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-[9px] text-slate-500">
                      Мастер гр.
                      <input
                        type="range"
                        min={0}
                        max={200}
                        value={Math.round(grp[voice].groupMasterLinear * 100)}
                        onInput={(e) => {
                          grp[voice].groupMasterLinear = Number(e.currentTarget.value) / 100;
                          syncMixerVoiceBus(voice);
                          setMixerUiTick((x) => x + 1);
                        }}
                        className="w-full h-1.5 accent-emerald-500"
                      />
                    </label>
                    <div className="text-[9px] text-slate-600 border-t border-[#23314f]/50 pt-1 mt-0.5">Слои</div>
                    {clone[voice].map((layer, i) => (
                      <label key={i} className="flex flex-col gap-0.5 text-[9px] text-slate-500">
                        <span className="truncate">
                          L{i + 1} · {layer.type}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={300}
                          step={1}
                          value={Math.round(layer.params.volume * 100)}
                          onInput={(e) => {
                            layer.params.volume = Number(e.currentTarget.value) / 100;
                            setMixerUiTick((x) => x + 1);
                          }}
                          className="w-full h-1.5 accent-amber-500"
                        />
                      </label>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Global Settings (Tempo & Row Selectors) */}
        <div className="relative bg-[#161f33] rounded-2xl border border-[#23314f] flex flex-col shrink-0 mb-3">
              {showRandomSettings ? (
            <div className={`grid ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div
                ref={randomSettingsPanelRef}
                className={`overflow-hidden flex flex-col ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'px-2.5 py-4 gap-5' : 'px-2.5 py-0 gap-0'}`}
              >
                <div className="flex flex-col gap-4 px-1 pb-1">
                  {isClickSoundSelectorOpen ? (
                    <div className="bg-[#0b101e] border border-[#2f4066]/50 rounded-xl p-3 flex flex-col gap-3 min-h-[400px]">
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setIsClickSoundSelectorOpen(false)}
                          className="w-8 h-8 rounded-lg bg-[#131722] border border-[#1f2438] flex items-center justify-center text-[#5b6385] hover:text-[#c0c5db] hover:bg-[#1a2030] transition-colors"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="font-bold text-[11px] uppercase tracking-wider text-[#a4abc5]">Select Click</span>
                        <div className="w-8 h-8" />
                      </div>
                      <div className="grid grid-cols-4 gap-2.5 flex-1 content-start">
                        {CLICK_SOUND_PRESET_META.map((preset) => {
                          const isSelected = clickSound === preset.mappedSound;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() => {
                                setClickSound(preset.mappedSound);
                                clickSoundRef.current = preset.mappedSound;
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
                       Pulsation
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('pattern')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomPattern 
                            ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Accents
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('speed')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomSpeed 
                            ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Cell Speed
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('barSpeed')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomBarSpeed 
                            ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Dead Cells
                     </button>
                  </div>

                  <div className="flex flex-col gap-2 px-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 font-bold tracking-wider uppercase">
                        Chaos level
                      </span>
                      <span className="text-purple-300 font-mono text-xs font-bold">{chaosLevel}</span>
                     </div>
                     <input 
                        type="range" 
                      min={0}
                      max={100}
                      value={chaosLevel}
                      onChange={(e) => setChaosLevel(parseInt(e.target.value, 10))}
                      onPointerUp={() => flushChaosToActiveSnapshot()}
                      onPointerCancel={() => flushChaosToActiveSnapshot()}
                      onBlur={() => flushChaosToActiveSnapshot()}
                        className="w-full h-2 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110"
                      />
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
                  <button
                    type="button"
                    onClick={() => setLowPerfMode((v) => !v)}
                    className={`w-1/2 self-center flex items-center justify-center py-1.5 px-2 rounded-md text-[11px] font-bold transition-colors border ${
                      lowPerfMode
                        ? 'bg-emerald-500/20 border-emerald-300/70 text-emerald-200'
                        : 'bg-[#16332f]/35 border-emerald-700/50 text-emerald-300 hover:text-emerald-200 hover:bg-[#16332f]/60'
                    }`}
                  >
                    <span>Potato Mode</span>
                  </button>
                  <div className="w-full h-px bg-[#1e2a45]/80 my-0.5"></div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold tracking-wider uppercase text-blue-300">Polyrhythm</span>
                      <button
                        type="button"
                        onClick={() => setPolyMode((prev) => !prev)}
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
                            onClick={() => setPolyVoices(parsePolyVoices(voices))}
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
                      title="Коротко: −1 BPM. Удерживай: −5 каждые 0,1 с"
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
                      onBeginTempoBpmInlineEdit={() => beginTempoInlineEdit('pnl')}
                      tempoInlineEditing={tempoInlineEditing}
                      tempoInlineFocusSlot={tempoInlineFocusSlot}
                      tempoSliderSlot="pnl"
                      tempoManualText={tempoManualText}
                      onTempoManualTextChange={setTempoManualText}
                      onCommitTempoInline={commitTempoInlineEdit}
                      onCancelTempoInline={cancelTempoInlineEdit}
                      className="flex-1 relative flex items-center h-8"
                    />
                    <button 
                      type="button"
                      title="Коротко: +1 BPM. Удерживай: +5 каждые 0,1 с"
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
                            title="Tap: select slot. Hold: copy / paste preset menu"
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
                            onContextMenu={(e) => e.preventDefault()}
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
                  onClick={() => {
                    setFrozenScale((prev) => {
                      const next = prev !== null ? null : bars;
                      if (lowPerfMode) {
                        if (bars >= 6) potatoAutoFreezeArmedRef.current = next !== null;
                        if (bars <= 5) potatoAutoFreezeArmedRef.current = true;
                      }
                      return next;
                    });
                  }}
                  className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-all duration-300 ${
                    frozenScale !== null 
                      ? `bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/50 ${lowPerfMode ? '' : 'shadow-[0_0_8px_rgba(59,130,246,0.3)]'}` 
                      : 'bg-[#1e2a45]/40 text-slate-400 hover:text-slate-200 hover:bg-[#1e2a45] ring-1 ring-[#2f4066]/30'
                  }`}
                  aria-label={frozenScale !== null ? 'Снять фиксацию высоты строк' : 'Зафиксировать масштаб строк'}
                >
                  <Snowflake size={12} />
                </button>
              </div>
              <StructuralSlider
                label="Bars"
                min={1}
                max={32}
                value={bars}
                colorClass="[&::-webkit-slider-thumb]:bg-blue-400"
                onBeginDrag={() => {
                  barsSliderDraggingRef.current = true;
                  attachSliderWindowListeners();
                }}
                onLiveChange={(next) => {
                  applyBarsWithPotatoFreeze(next);
                }}
                onCommit={(next) => {
                  applyBarsWithPotatoFreeze(next);
                }}
              />
              <div className="w-5 shrink-0 flex justify-end">
                <input 
                  type="text"
                  inputMode="numeric"
                  key={`bars-input-${bars}`}
                  defaultValue={bars}
                  onFocus={e => e.target.select()}
                  onBlur={e => {
                    let val = parseInt(e.target.value);
                    if (isNaN(val) || val < 1) val = 1;
                    if (val > 100) val = 100;
                    applyBarsWithPotatoFreeze(val);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  className="w-full text-xs font-bold text-slate-300 text-right bg-transparent hover:bg-[#1e2a45] focus:bg-[#1e2a45] rounded outline-none transition-colors py-1 cursor-text select-text"
                  title="Click to type a number (up to 100)"
                />
              </div>
            </div>

            <div className={`grid ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="relative h-4 w-full">
                  {/* Global Syllables Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${(activeEditCell !== null || activeEditRow !== null) ? 'opacity-0 pointer-events-none scale-y-50' : 'opacity-100 scale-y-100'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold w-12 shrink-0">Syllbs</span>
                    <StructuralSlider
                      label="Syllbs"
                      min={1}
                      max={9}
                      value={syllables}
                      colorClass="[&::-webkit-slider-thumb]:bg-emerald-400"
                      onBeginDrag={() => {
                        syllablesSliderDraggingRef.current = true;
                        attachSliderWindowListeners();
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
                  <div className={`absolute inset-0 flex items-center gap-2 ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${activeEditCell !== null ? 'opacity-100 scale-y-100 z-20' : 'opacity-0 pointer-events-none scale-y-50 translate-y-4'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-purple-400 font-bold w-12 shrink-0 truncate">Divs</span>
                    <input 
                      type="range" 
                      min="1" 
                      max="9" 
                      value={activeEditCell !== null ? (customSubdivisions[activeEditCell] || 1) : 1} 
                      onChange={(e) => {
                        if (activeEditCell !== null) {
                          setCustomSubdivisions(prev => ({...prev, [activeEditCell]: parseInt(e.target.value)}));
                        }
                      }} 
                      className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
                    />
                    <div className="w-5 shrink-0 flex items-center justify-end gap-0.5">
                      <span className="text-[11px] font-bold text-purple-300 text-right">{activeEditCell !== null ? (customSubdivisions[activeEditCell] || 1) : ''}</span>
                      <button onClick={() => setActiveEditCell(null)} className="w-[14px] h-[14px] flex shrink-0 items-center justify-center rounded-full bg-purple-900/60 text-[8px] text-purple-300 hover:bg-purple-800 transition-colors">✕</button>
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

        <SequencerGrid
          gridRef={gridRef}
          bars={bars}
          syllables={syllables}
          lowPerfMode={lowPerfMode}
          isTaEditorMode={isTaEditorMode}
          isDeadCellsEditorMode={isDeadCellsEditorMode}
          accentMapVersion={accentMapVersion}
          firstBeatAccent={firstBeatAccent}
          forceFirstBeatEditorFrames={forceFirstBeatEditorFrames}
          firstBeatEditorSuppressedSig={firstBeatEditorSuppressedSig}
          deadStartByRow={deadStartByRow}
          deadDisplayByRow={deadDisplayByRow}
          customSyllables={customSyllables}
          customSubdivisions={customSubdivisions}
          customMultipliers={customMultipliers}
          accents={accents}
          taDingKeys={visibleTaDingKeys}
          pulseMeterUnlinked={pulseMeterUnlinked}
          isPlaying={isPlaying}
          activePos={activePos}
          activePositions={activePositions}
          polyMode={polyMode}
          polyVoices={polyVoices}
          displayScaleBars={displayScaleBars}
          useFixedFlex={useFixedFlex}
          allBarsFitViewport={allBarsFitViewport}
          activeEditRow={activeEditRow}
          activeEditCell={activeEditCell}
          sequencerGridRowActionsRef={sequencerGridRowActionsRef}
          setRowElStable={setRowElStable}
        />

        {/* Bottom Actions */}
        <div className="flex gap-3 mt-1 shrink-0 h-[60px]">
          {/* Randomizer: короткий тап — префилл всех тактов по галочкам Settings; удерживание — вкл/выкл режима. */}
                <button 
            type="button"
            disabled={isDeadCellsEditorMode}
            aria-label="Randomizer"
            onPointerDown={() => {
              if (isDeadCellsEditorMode) return;
              randomDiceHoldAteClickRef.current = false;
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
              randomDiceHoldTimerRef.current = window.setTimeout(() => {
                randomDiceHoldTimerRef.current = null;
                setRandomModeEnabled((prev) => !prev);
                randomDiceHoldAteClickRef.current = true;
              }, RANDOM_DICE_PREFILL_HOLD_MS);
                  }}
                  onPointerUp={() => {
              if (isDeadCellsEditorMode) return;
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
                  }}
                  onPointerLeave={() => {
              if (isDeadCellsEditorMode) return;
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
            }}
            onPointerCancel={() => {
              if (isDeadCellsEditorMode) return;
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
                      }}
                      onClick={() => {
              if (isDeadCellsEditorMode) return;
              if (randomDiceHoldAteClickRef.current) {
                randomDiceHoldAteClickRef.current = false;
                return;
              }
              prefillAllTactsRandomizer();
            }}
            className={`flex-1 rounded-xl border flex justify-center items-center transition-all duration-200 relative ${
              randomDiceMintFlash
                ? `bg-teal-500/25 border-teal-300/75 text-teal-100 ${lowPerfMode ? '' : 'shadow-[0_0_22px_rgba(45,212,191,0.55)]'} ring-2 ring-teal-300/70`
                : isDeadCellsEditorMode
                ? 'bg-[#161f33] border-[#23314f] text-slate-600 opacity-45 cursor-not-allowed'
                : randomModeEnabled
                ? `bg-blue-600/30 border-blue-400/60 ${lowPerfMode ? '' : 'shadow-[0_0_15px_rgba(59,130,246,0.3)]'} text-blue-200`
                : 'bg-[#161f33] border-[#23314f] text-slate-400 hover:text-slate-200 hover:bg-[#1a253c]'
            }`}
          >
            <Dices size={24} />
          </button>
          
          {/* First Beat Accent ("Ta"): tap — глобальный Ta; удерживание — режим правки первых долей по сетке. */}
          <button
            type="button"
            disabled={isDeadCellsEditorMode}
            onPointerDown={() => {
              if (isDeadCellsEditorMode) return;
              taHoldAteClickRef.current = false;
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
              taHoldTimerRef.current = window.setTimeout(() => {
                taHoldTimerRef.current = null;
                taHoldAteClickRef.current = true;
                if (isTaEditorModeRef.current) {
                  setIsTaEditorMode(false);
                } else {
                  // Долгое удержание Ta из OFF: сначала включаем Ta, затем открываем редактор.
                  if (!firstBeatAccentRef.current) {
                    setFirstBeatAccent(true);
                  }
                  setIsTaEditorMode(true);
                }
              }, SNAPSHOT_MENU_HOLD_MS);
            }}
            onPointerUp={() => {
              if (isDeadCellsEditorMode) return;
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
            }}
            onPointerLeave={() => {
              if (isDeadCellsEditorMode) return;
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
            }}
            onPointerCancel={() => {
              if (isDeadCellsEditorMode) return;
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
            }}
            onClick={() => {
              if (isDeadCellsEditorMode) return;
              if (taHoldAteClickRef.current) {
                taHoldAteClickRef.current = false;
                return;
              }
              if (isTaEditorModeRef.current) return;
              setFirstBeatAccent((prev) => !prev);
            }}
            className={`flex-1 rounded-xl flex justify-center items-center transition-all bg-[#161f33] ${
              isDeadCellsEditorMode
                ? 'border border-[#23314f] text-slate-600 opacity-45 cursor-not-allowed'
                : isTaEditorMode
                ? `border-2 border-white/90 text-white ${lowPerfMode ? '' : 'shadow-[0_0_18px_rgba(255,255,255,0.25)]'}`
                : firstBeatAccent
                  ? `border border-purple-400 ${lowPerfMode ? '' : 'shadow-[0_0_15px_rgba(192,132,252,0.4)]'} text-purple-200`
                  : 'border border-[#23314f] text-slate-400 hover:text-slate-200 hover:bg-[#1a253c] active:bg-[#131b2c]'
            }`}
          >
            <span className="font-bold text-[22px] tracking-wide">Ta</span>
          </button>

          {/* All beats vs accent-only vs Ta-only grid mute (square); долгое нажатие — диктант. */}
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
                setDictantMode((d) => !d);
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
              setSquarePlaybackMode((prev) => nextSquarePlaybackMode(prev));
            }}
            onContextMenu={(e) => e.preventDefault()}
            className={`flex-1 rounded-xl flex justify-center items-center transition-all touch-none select-none relative bg-[#161f33] ${
              isDeadCellsEditorMode
                ? 'border border-[#23314f] text-slate-600 opacity-45 cursor-not-allowed'
                : `${squarePlaybackButtonSurface}${squareDictantChrome}`
            }`}
            aria-label={
              dictantMode
                ? `Диктант. Сейчас: ${squarePlaybackModeLabel}`
                : syllableReadMuteMode === 'full'
                  ? `Тишина по сетке. Сейчас: ${squarePlaybackModeLabel}`
                  : syllableReadMuteMode === 'no_accent_sharp'
                    ? `Акценты как пассивные. Сейчас: ${squarePlaybackModeLabel}`
                    : `Режим сетки: ${squarePlaybackModeLabel}`
            }
          >
            <span
              className={`block w-6 h-6 rounded-sm border-2 border-current ${lowPerfMode ? '' : 'transition-all duration-300'} ${
                dictantMode || syllableReadMuteMode !== 'off' || squarePlaybackMode !== 'all_beats'
                  ? 'opacity-100 scale-110 bg-current/25'
                  : 'opacity-55 scale-100 bg-transparent'
              }`}
            />
          </button>
        </div>

        {clipboardToast ? (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute bottom-[5.5rem] left-1/2 z-[60] max-w-[min(92%,22rem)] -translate-x-1/2 rounded-xl bg-[#1e2a45] px-3.5 py-2.5 text-center text-[13px] font-medium leading-snug text-slate-100 shadow-lg ring-1 ring-[#3a5080]"
          >
            {clipboardToast}
          </div>
        ) : null}

        {/* Play Button */}
        <div className="shrink-0 mb-2">
          <button
            type="button"
            disabled={(isTaEditorMode || isDeadCellsEditorMode) && !isPlaying}
            aria-disabled={(isTaEditorMode || isDeadCellsEditorMode) && !isPlaying}
            onClick={togglePlayback}
            className={`w-full py-4 rounded-xl font-black text-lg tracking-[0.2em] flex items-center justify-center gap-2 ${lowPerfMode ? '' : 'shadow-[0_8px_20px_rgba(16,185,129,0.2)]'} transition-all transform ${
              (isTaEditorMode || isDeadCellsEditorMode) && !isPlaying
                ? 'opacity-45 cursor-not-allowed bg-emerald-600/50 text-slate-800'
                : 'active:scale-[0.98] ' +
                  (isPlaying
                    ? 'bg-rose-500 hover:bg-rose-400 active:bg-rose-600 shadow-rose-500/20 text-white'
                    : 'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950')
            }`}
          >
            {isPlaying ? (
              <>■ STOP</>
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
              title="Copy slot preset to clipboard"
              aria-label="Copy slot preset to clipboard"
              onClick={() => void copySnapshotSlotToClipboard(snapshotClipMenu.slot)}
            >
              <Copy size={20} strokeWidth={2.25} />
            </button>
            <div className="h-8 w-px shrink-0 bg-[#2f4066]/70" aria-hidden />
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#23314f] text-slate-200 transition-colors hover:bg-[#2c3d63] active:bg-[#1b253b] ring-1 ring-[#2f4066]/40"
              title="Paste preset from clipboard into slot"
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