/**
 * Per click-sound-preset parallel limiter for accent Ta only (`playBarFirstHighClick`).
 * Cajon: shared parallel → per-hit gate tap (`parallelSum`).
 */

import { getVoiceLayerSumInput } from './metroSoundBus';
import {
	applyBakedParallelChain,
	BAKED_VOICE_PARALLEL_LIMITER,
	createParallelBusChain,
	type ParallelBusChainNodes,
	type ParallelLimiterSettings,
} from './parallelBusChain';

import { getActiveCalibrationParallel } from './soundPresetCalibration';

/** User-calibrated Accent Ta parallel for Drum machine (pre-rendered sample path). */
export const BAKED_DRUM_MACHINE_TA_ACCENT_PARALLEL: ParallelLimiterSettings = {
	gain: 0,
	volume: 0.6,
	preset: 'tight',
	lookAheadMs: 4,
	phaseAlignMs: 0,
};

/** User-calibrated accent Ta parallel for Classic (osc path). */
export const BAKED_CLASSIC_TA_ACCENT_PARALLEL: ParallelLimiterSettings = {
	gain: 1,
	volume: 1,
	preset: 'punch',
	lookAheadMs: 4.9,
	phaseAlignMs: -2.4,
};

type TaAccentParallelEntry = {
	taIn: GainNode;
	parallel: ParallelBusChainNodes;
	/** Cajon only: parallel voiceOut sum — per-hit envelope taps connect here. */
	parallelSum?: GainNode;
};

const taParallelByContext = new WeakMap<AudioContext, Map<string, TaAccentParallelEntry>>();

function normalizePresetKey(soundPreset: string): string {
	if (soundPreset === 'hi_hat') return 'drum_machine';
	if (soundPreset === 'vinyl_crackle') return 'cajon';
	return soundPreset;
}

export function isCajonAccentTaPostParallelPreset(soundPreset: string): boolean {
	return normalizePresetKey(soundPreset) === 'cajon';
}

export function getTaAccentParallelSettings(soundPreset: string): ParallelLimiterSettings {
	const active = getActiveCalibrationParallel(soundPreset, 'ta');
	if (active) return active;
	const key = normalizePresetKey(soundPreset);
	if (key === 'drum_machine') return BAKED_DRUM_MACHINE_TA_ACCENT_PARALLEL;
	if (key === 'classic') return BAKED_CLASSIC_TA_ACCENT_PARALLEL;
	return BAKED_VOICE_PARALLEL_LIMITER;
}

function ensureTaAccentParallelEntry(ctx: AudioContext, soundPreset: string): TaAccentParallelEntry {
	const presetKey = normalizePresetKey(soundPreset);
	let byPreset = taParallelByContext.get(ctx);
	if (!byPreset) {
		byPreset = new Map();
		taParallelByContext.set(ctx, byPreset);
	}
	const cached = byPreset.get(presetKey);
	if (cached) return cached;

	const taIn = ctx.createGain();
	taIn.gain.value = 1;
	const accentIn = getVoiceLayerSumInput(ctx, 'accent');

	if (presetKey === 'cajon') {
		const parallelSum = ctx.createGain();
		parallelSum.gain.value = 1;
		const parallel = createParallelBusChain(ctx, taIn, parallelSum);
		const entry: TaAccentParallelEntry = { taIn, parallel, parallelSum };
		byPreset.set(presetKey, entry);
		applyBakedParallelChain(ctx, parallel, getTaAccentParallelSettings(presetKey), 1);
		return entry;
	}

	const parallel = createParallelBusChain(ctx, taIn, accentIn);
	const entry: TaAccentParallelEntry = { taIn, parallel };
	byPreset.set(presetKey, entry);
	applyBakedParallelChain(ctx, parallel, getTaAccentParallelSettings(presetKey), 1);
	return entry;
}

/** Connect each accent Ta hit (buffer/osc tail) here — not the whole accent bus. */
export function getTaAccentParallelInput(ctx: AudioContext, soundPreset: string): GainNode {
	return ensureTaAccentParallelEntry(ctx, soundPreset).taIn;
}

/** Cajon accent Ta: fan-out point after parallel dry+wet sum. */
export function getCajonTaAccentParallelSum(ctx: AudioContext): GainNode {
	return ensureTaAccentParallelEntry(ctx, 'cajon').parallelSum!;
}

export function applyTaAccentParallelChain(
	ctx: AudioContext | null | undefined,
	soundPreset: string,
	accentFaderLinear = 1,
): void {
	if (!ctx) return;
	const presetKey = normalizePresetKey(soundPreset);
	const settings = getTaAccentParallelSettings(presetKey);
	const byPreset = taParallelByContext.get(ctx);
	const entry = byPreset?.get(presetKey) ?? ensureTaAccentParallelEntry(ctx, presetKey);
	applyBakedParallelChain(ctx, entry.parallel, settings, accentFaderLinear);
}

export { BAKED_VOICE_PARALLEL_LIMITER, type ParallelLimiterSettings };
