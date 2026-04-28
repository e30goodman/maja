/**
 * Per-voice sound buses: sum of layer tails → group HP → group LP → group master → metronome summing.
 */

import { getMetronomeSummingInput } from './metraAudioBus';

export type MetroVoiceKey = 'accent' | 'alt' | 'passive';

type VoiceBus = {
	layerSum: GainNode;
	groupHp: BiquadFilterNode;
	groupLp: BiquadFilterNode;
	groupMaster: GainNode;
};

const voiceBusesByContext = new WeakMap<AudioContext, Record<MetroVoiceKey, VoiceBus>>();

function ensureVoiceBuses(ctx: AudioContext): Record<MetroVoiceKey, VoiceBus> {
	const cached = voiceBusesByContext.get(ctx);
	if (cached) return cached;
	const masterIn = getMetronomeSummingInput(ctx);
	const mk = (): VoiceBus => {
		const layerSum = ctx.createGain();
		layerSum.gain.value = 1;
		const groupHp = ctx.createBiquadFilter();
		groupHp.type = 'highpass';
		groupHp.frequency.value = 20;
		const groupLp = ctx.createBiquadFilter();
		groupLp.type = 'lowpass';
		groupLp.frequency.value = 20000;
		const groupMaster = ctx.createGain();
		groupMaster.gain.value = 1;
		layerSum.connect(groupHp);
		groupHp.connect(groupLp);
		groupLp.connect(groupMaster);
		groupMaster.connect(masterIn);
		return { layerSum, groupHp, groupLp, groupMaster };
	};
	const buses: Record<MetroVoiceKey, VoiceBus> = {
		accent: mk(),
		alt: mk(),
		passive: mk(),
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
	const hp = Math.max(10, hpHz);
	const lp = Math.max(20, lpHz);
	b.groupHp.frequency.setValueAtTime(hp, t);
	b.groupLp.frequency.setValueAtTime(lp, t);
	const g = Math.max(0, Math.min(4, masterLinear));
	b.groupMaster.gain.setValueAtTime(g, t);
}
