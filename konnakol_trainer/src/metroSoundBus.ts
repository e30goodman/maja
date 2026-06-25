/**
 * Per-voice sound buses:
 * layer sum → group HP → group LP → group delay → group master → parallel limiter → metronome summing.
 */

import { getMetronomeSummingInput } from './metraAudioBus';
import {
	applyBakedParallelChain,
	BAKED_VOICE_PARALLEL_LIMITER,
	createParallelBusChain,
	type ParallelBusChainNodes,
	type ParallelLimiterSettings,
} from './parallelBusChain';

export type MetroVoiceKey = 'accent' | 'alt' | 'passive';
const MIN_HP_HZ = 20;

const VOICE_MICRO_DELAY_SEC: Record<MetroVoiceKey, number> = {
	accent: 0,
	alt: 0.00045,
	passive: 0.0009,
};
const FILTER_Q_FLAT = 0.7071;

type VoiceBus = {
	layerSum: GainNode;
	groupHp: BiquadFilterNode;
	groupLp: BiquadFilterNode;
	groupDelay: DelayNode;
	groupMaster: GainNode;
	parallel: ParallelBusChainNodes;
};

const voiceBusesByContext = new WeakMap<AudioContext, Record<MetroVoiceKey, VoiceBus>>();

function ensureVoiceBuses(ctx: AudioContext): Record<MetroVoiceKey, VoiceBus> {
	const cached = voiceBusesByContext.get(ctx);
	if (cached) return cached;
	const masterIn = getMetronomeSummingInput(ctx);
	const mk = (voice: MetroVoiceKey): VoiceBus => {
		const layerSum = ctx.createGain();
		layerSum.gain.value = 1;
		const groupHp = ctx.createBiquadFilter();
		groupHp.type = 'highpass';
		groupHp.frequency.value = 20;
		groupHp.Q.value = FILTER_Q_FLAT;
		const groupLp = ctx.createBiquadFilter();
		groupLp.type = 'lowpass';
		groupLp.frequency.value = 20000;
		groupLp.Q.value = FILTER_Q_FLAT;
		const groupDelay = ctx.createDelay(0.05);
		groupDelay.delayTime.value = 0;
		const groupMaster = ctx.createGain();
		groupMaster.gain.value = 1;
		layerSum.connect(groupHp);
		groupHp.connect(groupLp);
		groupLp.connect(groupDelay);
		groupDelay.connect(groupMaster);
		const parallel = createParallelBusChain(ctx, groupMaster, masterIn);
		const bus: VoiceBus = { layerSum, groupHp, groupLp, groupDelay, groupMaster, parallel };
		applyBakedParallelChain(ctx, parallel, BAKED_VOICE_PARALLEL_LIMITER, 1);
		return bus;
	};
	const buses: Record<MetroVoiceKey, VoiceBus> = {
		accent: mk('accent'),
		alt: mk('alt'),
		passive: mk('passive'),
	};
	voiceBusesByContext.set(ctx, buses);
	return buses;
}

/** Connect each layer graph (…→ layerLp) here; signals sum linearly. */
export function getVoiceLayerSumInput(ctx: AudioContext, voice: MetroVoiceKey): GainNode {
	return ensureVoiceBuses(ctx)[voice].layerSum;
}

export function applyVoiceGroupChain(
	ctx: AudioContext,
	voice: MetroVoiceKey,
	hpHz: number,
	lpHz: number,
	masterLinear: number,
	atTime?: number,
): void {
	const t = atTime ?? ctx.currentTime;
	const b = ensureVoiceBuses(ctx)[voice];
	const hp = Math.max(MIN_HP_HZ, hpHz);
	const lp = Math.max(20, lpHz);
	b.groupHp.frequency.setValueAtTime(hp, t);
	b.groupHp.Q.setValueAtTime(FILTER_Q_FLAT, t);
	b.groupLp.frequency.setValueAtTime(lp, t);
	b.groupLp.Q.setValueAtTime(FILTER_Q_FLAT, t);
	const microDelaySec = VOICE_MICRO_DELAY_SEC[voice] ?? 0;
	b.groupDelay.delayTime.setValueAtTime(microDelaySec, t);
	const g = Math.max(0, Math.min(4, masterLinear));
	b.groupMaster.gain.setValueAtTime(g, t);
}

export type VoiceBusFaderLevels = {
	accent: number;
	alt: number;
	passive: number;
};

/** Couple parallel wet to per-bus UI faders; fader 0 → wet 0. */
export function applyVoiceBusParallelWetLevels(
	ctx: AudioContext | null | undefined,
	busFaders: VoiceBusFaderLevels,
	chainSettings: ParallelLimiterSettings = BAKED_VOICE_PARALLEL_LIMITER,
): void {
	if (!ctx) return;
	const buses = voiceBusesByContext.get(ctx);
	if (!buses) return;
	const voices: MetroVoiceKey[] = ['accent', 'alt', 'passive'];
	for (const voice of voices) {
		const fader = busFaders[voice];
		applyBakedParallelChain(ctx, buses[voice].parallel, chainSettings, fader);
	}
}
