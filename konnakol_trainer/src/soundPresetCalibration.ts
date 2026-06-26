/**
 * Per sound-preset × voice calibration (parallel + attack/decay envelope).
 * Persisted in localStorage; baked defaults as fallback.
 */

import { BAKED_CLASSIC_PASSIVE_PARALLEL } from './classicPassiveParallel';
import {
	BAKED_VOICE_PARALLEL_LIMITER,
	type ParallelLimiterSettings,
} from './parallelBusChain';
import {
	CLICK_TAIL_ENVELOPE_SHAPE_ORDER,
	isClickTailEnvelopeShapeId,
	type ClickTailEnvelopeShapeId,
} from './clickTailEnvelope';
import {
	BAKED_CLASSIC_PASSIVE_FRONT_MS,
	BAKED_CLASSIC_PASSIVE_FRONT_SHAPE,
	BAKED_CLASSIC_PASSIVE_TAIL_MS,
	BAKED_CLASSIC_PASSIVE_TAIL_SHAPE,
	BAKED_CLASSIC_TA_ACCENT_TAIL_MS,
} from './taAccentEnvelope';
import {
	BAKED_CLASSIC_TA_ACCENT_PARALLEL,
	BAKED_DRUM_MACHINE_TA_ACCENT_PARALLEL,
} from './taAccentParallel';

export const SOUND_PRESET_CALIBRATION_ORDER = [
	'classic',
	'oldschool',
	'standard',
	'modern_daw',
	'woodblock',
	'punchy',
	'sharp_digital',
	'deep_sub',
	'laser_snap',
	'drum_machine',
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
] as const;

export type SoundPresetCalibrationId = (typeof SOUND_PRESET_CALIBRATION_ORDER)[number];

/** User-facing calibration layers (3 musical roles — not the internal accent DSP bus). */
export type CalibrationVoiceKey = 'passive' | 'alt' | 'ta';

export const CALIBRATION_VOICE_ORDER: CalibrationVoiceKey[] = ['passive', 'alt', 'ta'];

export const CALIBRATION_VOICE_LABELS: Record<CalibrationVoiceKey, string> = {
	passive: 'Passive',
	alt: 'Alt accent',
	ta: 'Accent Ta',
};

export const CALIBRATION_ENVELOPE_DECAY_MS_MAX = 120;
export const CALIBRATION_ENVELOPE_ATTACK_MS_MAX = 20;
export const CALIBRATION_ENVELOPE_GAIN_MAX = 2;

export type VoiceCalibrationSlice = {
	parallel: ParallelLimiterSettings;
	/** 0 = native layer decay, 1 = full custom gate envelope. */
	envelopeMix: number;
	/** Wet/gate path output level (makeup after envelope). 1 = unity. */
	envelopeGain: number;
	attackMs: number;
	attackShape: ClickTailEnvelopeShapeId;
	decayMs: number;
	decayShape: ClickTailEnvelopeShapeId;
};

export type SoundPresetCalibrationStore = Partial<
	Record<string, Partial<Record<CalibrationVoiceKey, VoiceCalibrationSlice>>>
>;

const STORAGE_KEY = 'konnakol_sound_preset_calibration_v1';

const DEFAULT_ENVELOPE: Pick<
	VoiceCalibrationSlice,
	'envelopeMix' | 'envelopeGain' | 'attackMs' | 'attackShape' | 'decayMs' | 'decayShape'
> = {
	envelopeMix: 0,
	envelopeGain: 1,
	attackMs: 0,
	attackShape: 'snap',
	decayMs: 12,
	decayShape: 'snap',
};

export const NATIVE_ENVELOPE_UI: Pick<
	VoiceCalibrationSlice,
	'envelopeMix' | 'envelopeGain' | 'attackMs' | 'attackShape' | 'decayMs' | 'decayShape'
> = { ...DEFAULT_ENVELOPE };

const ENVELOPE_MIX_EPS = 0.0005;

let runtimeStore: SoundPresetCalibrationStore = {};

function normalizeCalibrationPresetId(preset: string): string {
	return preset === 'hi_hat' ? 'drum_machine' : preset;
}

function cloneSlice(slice: VoiceCalibrationSlice): VoiceCalibrationSlice {
	return {
		parallel: { ...slice.parallel },
		envelopeMix: slice.envelopeMix,
		envelopeGain: slice.envelopeGain,
		attackMs: slice.attackMs,
		attackShape: slice.attackShape,
		decayMs: slice.decayMs,
		decayShape: slice.decayShape,
	};
}

function bakedEnvelopeMixFor(preset: string, voice: CalibrationVoiceKey): number {
	if (preset === 'classic' && (voice === 'passive' || voice === 'ta')) return 1;
	return 0;
}

function bakedParallelFor(preset: string, voice: CalibrationVoiceKey): ParallelLimiterSettings {
	if (voice === 'ta') {
		if (preset === 'drum_machine') return { ...BAKED_DRUM_MACHINE_TA_ACCENT_PARALLEL };
		if (preset === 'classic') return { ...BAKED_CLASSIC_TA_ACCENT_PARALLEL };
	}
	if (preset === 'classic' && voice === 'passive') return { ...BAKED_CLASSIC_PASSIVE_PARALLEL };
	return { ...BAKED_VOICE_PARALLEL_LIMITER };
}

function bakedEnvelopeFor(
	preset: string,
	voice: CalibrationVoiceKey,
): Pick<VoiceCalibrationSlice, 'attackMs' | 'attackShape' | 'decayMs' | 'decayShape'> {
	if (preset === 'classic' && voice === 'passive') {
		return {
			attackMs: BAKED_CLASSIC_PASSIVE_FRONT_MS,
			attackShape: BAKED_CLASSIC_PASSIVE_FRONT_SHAPE,
			decayMs: BAKED_CLASSIC_PASSIVE_TAIL_MS,
			decayShape: BAKED_CLASSIC_PASSIVE_TAIL_SHAPE,
		};
	}
	if (preset === 'classic' && voice === 'ta') {
		return {
			attackMs: 0,
			attackShape: 'snap',
			decayMs: BAKED_CLASSIC_TA_ACCENT_TAIL_MS,
			decayShape: 'snap',
		};
	}
	return { ...DEFAULT_ENVELOPE };
}

export function getBakedDefaultCalibrationSlice(
	preset: string,
	voice: CalibrationVoiceKey,
): VoiceCalibrationSlice {
	return {
		parallel: bakedParallelFor(preset, voice),
		envelopeMix: bakedEnvelopeMixFor(preset, voice),
		envelopeGain: 1,
		...bakedEnvelopeFor(preset, voice),
	};
}

function normalizeSlice(raw: unknown, preset: string, voice: CalibrationVoiceKey): VoiceCalibrationSlice {
	const baked = getBakedDefaultCalibrationSlice(preset, voice);
	if (!raw || typeof raw !== 'object') return baked;
	const row = raw as Partial<VoiceCalibrationSlice>;
	const p = row.parallel;
	const parallel: ParallelLimiterSettings = {
		gain: Number.isFinite(Number(p?.gain)) ? Math.max(0, Math.min(1, Number(p!.gain))) : baked.parallel.gain,
		volume: Number.isFinite(Number(p?.volume))
			? Math.max(0, Math.min(1, Number(p!.volume)))
			: baked.parallel.volume,
		preset:
			p?.preset === 'tight' ||
			p?.preset === 'punch' ||
			p?.preset === 'glue' ||
			p?.preset === 'sustain'
				? p.preset
				: baked.parallel.preset,
		lookAheadMs: Number.isFinite(Number(p?.lookAheadMs))
			? Math.max(0, Math.min(12, Number(p!.lookAheadMs)))
			: baked.parallel.lookAheadMs,
		phaseAlignMs: Number.isFinite(Number(p?.phaseAlignMs))
			? Math.max(-12, Math.min(12, Number(p!.phaseAlignMs)))
			: baked.parallel.phaseAlignMs,
	};
	return {
		parallel,
		envelopeMix: Number.isFinite(Number(row.envelopeMix))
			? Math.max(0, Math.min(1, Number(row.envelopeMix)))
			: 1,
		envelopeGain: Number.isFinite(Number(row.envelopeGain))
			? Math.max(0, Math.min(CALIBRATION_ENVELOPE_GAIN_MAX, Number(row.envelopeGain)))
			: baked.envelopeGain,
		attackMs: Number.isFinite(Number(row.attackMs))
			? Math.max(0, Math.min(CALIBRATION_ENVELOPE_ATTACK_MS_MAX, Number(row.attackMs)))
			: baked.attackMs,
		attackShape: isClickTailEnvelopeShapeId(row.attackShape) ? row.attackShape : baked.attackShape,
		decayMs: Number.isFinite(Number(row.decayMs))
			? Math.max(1, Math.min(CALIBRATION_ENVELOPE_DECAY_MS_MAX, Number(row.decayMs)))
			: baked.decayMs,
		decayShape: isClickTailEnvelopeShapeId(row.decayShape) ? row.decayShape : baked.decayShape,
	};
}

export function loadSoundPresetCalibrationStore(): SoundPresetCalibrationStore {
	const out: SoundPresetCalibrationStore = {};
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return out;
		const parsed = JSON.parse(raw) as SoundPresetCalibrationStore & { hi_hat?: SoundPresetCalibrationStore[string] };
		if (!parsed || typeof parsed !== 'object') return out;
		if (parsed.hi_hat && typeof parsed.hi_hat === 'object') {
			parsed.drum_machine = { ...(parsed.drum_machine ?? {}), ...parsed.hi_hat };
			delete parsed.hi_hat;
		}
		for (const preset of SOUND_PRESET_CALIBRATION_ORDER) {
			const presetBag = parsed[preset];
			if (!presetBag || typeof presetBag !== 'object') continue;
			out[preset] = {};
			for (const voice of CALIBRATION_VOICE_ORDER) {
				const slice = presetBag[voice];
				if (slice) out[preset]![voice] = normalizeSlice(slice, preset, voice);
			}
			// Legacy: `accent` was a mistaken fourth UI layer (internal bus, not a sound role).
			delete (out[preset] as Partial<Record<string, VoiceCalibrationSlice>>).accent;
		}
	} catch {
		/* keep empty — baked defaults apply per lookup */
	}
	return out;
}

export function persistSoundPresetCalibrationStore(store: SoundPresetCalibrationStore): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
	} catch {
		/* ignore */
	}
}

export function setSoundPresetCalibrationRuntime(store: SoundPresetCalibrationStore): void {
	runtimeStore = store;
}

export function hasStoredCalibrationSlice(preset: string, voice: CalibrationVoiceKey): boolean {
	const key = normalizeCalibrationPresetId(preset);
	return Boolean(runtimeStore[key]?.[voice]);
}

export type ActiveEnvelope = Pick<
	VoiceCalibrationSlice,
	'attackMs' | 'attackShape' | 'decayMs' | 'decayShape' | 'envelopeMix' | 'envelopeGain'
>;

/** Custom envelope when baked classic (full mix) or stored slice with mix > 0. */
export function getActiveCalibrationEnvelope(
	preset: string,
	voice: CalibrationVoiceKey,
): ActiveEnvelope | null {
	const key = normalizeCalibrationPresetId(preset);
	if (hasStoredCalibrationSlice(key, voice)) {
		const slice = getCalibrationSlice(key, voice);
		if (slice.envelopeMix <= ENVELOPE_MIX_EPS) return null;
		return {
			attackMs: slice.attackMs,
			attackShape: slice.attackShape,
			decayMs: slice.decayMs,
			decayShape: slice.decayShape,
			envelopeMix: slice.envelopeMix,
			envelopeGain: slice.envelopeGain,
		};
	}
	if (key === 'classic' && (voice === 'passive' || voice === 'ta')) {
		return {
			...bakedEnvelopeFor(key, voice),
			envelopeMix: 1,
			envelopeGain: 1,
		};
	}
	return null;
}

/** Custom parallel only when baked (classic passive / ta presets) or user saved this slice. */
export function getActiveCalibrationParallel(
	preset: string,
	voice: CalibrationVoiceKey,
): ParallelLimiterSettings | null {
	const key = normalizeCalibrationPresetId(preset);
	if (hasStoredCalibrationSlice(key, voice)) {
		return { ...getCalibrationSlice(key, voice).parallel };
	}
	if (voice === 'ta') {
		if (key === 'classic' || key === 'drum_machine') return bakedParallelFor(key, voice);
		return null;
	}
	if (key === 'classic' && voice === 'passive') {
		return bakedParallelFor(key, voice);
	}
	return null;
}

export function getCalibrationEditBase(
	preset: string,
	voice: CalibrationVoiceKey,
	store: SoundPresetCalibrationStore,
): VoiceCalibrationSlice {
	const key = normalizeCalibrationPresetId(preset);
	const stored = store[key]?.[voice];
	if (stored) return cloneSlice(stored);
	return { ...getBakedDefaultCalibrationSlice(key, voice), envelopeMix: 0 };
}

export function getCalibrationSlice(preset: string, voice: CalibrationVoiceKey): VoiceCalibrationSlice {
	const key = normalizeCalibrationPresetId(preset);
	const stored = runtimeStore[key]?.[voice];
	if (stored) return cloneSlice(stored);
	return getBakedDefaultCalibrationSlice(key, voice);
}

export function isSoundPresetCalibrationId(value: string): value is SoundPresetCalibrationId {
	return (SOUND_PRESET_CALIBRATION_ORDER as readonly string[]).includes(value);
}

export {
	CLICK_TAIL_ENVELOPE_SHAPE_ORDER,
	type ClickTailEnvelopeShapeId,
};
