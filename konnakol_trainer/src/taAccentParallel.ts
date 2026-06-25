/**
 * Per click-sound-preset parallel limiter for accent Ta only (`playBarFirstHighClick`).
 * Each sound preset has its own Ta parallel chain → accent voice bus input.
 */

import { getVoiceLayerSumInput } from './metroSoundBus';
import {
	applyBakedParallelChain,
	BAKED_VOICE_PARALLEL_LIMITER,
	createParallelBusChain,
	type ParallelBusChainNodes,
	type ParallelLimiterSettings,
} from './parallelBusChain';

/** User-calibrated accent Ta parallel for Drum machine (hi_hat sample path). */
export const BAKED_HI_HAT_TA_ACCENT_PARALLEL: ParallelLimiterSettings = {
	gain: 0,
	volume: 0.6,
	preset: 'tight',
	lookAheadMs: 4,
	phaseAlignMs: 0,
};

type TaAccentParallelEntry = {
	taIn: GainNode;
	parallel: ParallelBusChainNodes;
};

const taParallelByContext = new WeakMap<AudioContext, Map<string, TaAccentParallelEntry>>();

export function getTaAccentParallelSettings(soundPreset: string): ParallelLimiterSettings {
	if (soundPreset === 'hi_hat') return BAKED_HI_HAT_TA_ACCENT_PARALLEL;
	return BAKED_VOICE_PARALLEL_LIMITER;
}

function ensureTaAccentParallelEntry(ctx: AudioContext, soundPreset: string): TaAccentParallelEntry {
	let byPreset = taParallelByContext.get(ctx);
	if (!byPreset) {
		byPreset = new Map();
		taParallelByContext.set(ctx, byPreset);
	}
	const cached = byPreset.get(soundPreset);
	if (cached) return cached;

	const taIn = ctx.createGain();
	taIn.gain.value = 1;
	const accentIn = getVoiceLayerSumInput(ctx, 'accent');
	const parallel = createParallelBusChain(ctx, taIn, accentIn);
	const entry: TaAccentParallelEntry = { taIn, parallel };
	byPreset.set(soundPreset, entry);
	applyBakedParallelChain(ctx, parallel, getTaAccentParallelSettings(soundPreset), 1);
	return entry;
}

/** Connect each accent Ta hit (buffer/osc tail) here — not the whole accent bus. */
export function getTaAccentParallelInput(ctx: AudioContext, soundPreset: string): GainNode {
	return ensureTaAccentParallelEntry(ctx, soundPreset).taIn;
}

export function applyTaAccentParallelChain(
	ctx: AudioContext | null | undefined,
	soundPreset: string,
	accentFaderLinear = 1,
): void {
	if (!ctx) return;
	const settings = getTaAccentParallelSettings(soundPreset);
	const byPreset = taParallelByContext.get(ctx);
	const entry = byPreset?.get(soundPreset) ?? ensureTaAccentParallelEntry(ctx, soundPreset);
	applyBakedParallelChain(ctx, entry.parallel, settings, accentFaderLinear);
}

export { BAKED_VOICE_PARALLEL_LIMITER, type ParallelLimiterSettings };
