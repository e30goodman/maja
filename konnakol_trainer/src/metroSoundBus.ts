/**
 * Per-voice sound buses: sum of layer tails → group HP → group LP → group master → metronome summing.
 */

import { getMetronomeSummingInput } from './metraAudioBus';

export type MetroVoiceKey = 'accent' | 'alt' | 'passive';

/**
 * Anti-phase micro-delays per voice bus (seconds).
 * Values are intentionally tiny: audible alignment stays intact,
 * but mono cancellation risk between voices is reduced.
 */
const VOICE_MICRO_DELAY_SEC: Record<MetroVoiceKey, number> = {
	accent: 0,
	alt: 0.00045,
	passive: 0.0009,
};

type VoiceBus = {
	layerSum: GainNode;
	groupHp: BiquadFilterNode;
	groupLp: BiquadFilterNode;
	groupDelay: DelayNode;
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
		const groupDelay = ctx.createDelay(0.05);
		groupDelay.delayTime.value = 0;
		const groupMaster = ctx.createGain();
		groupMaster.gain.value = 1;
		layerSum.connect(groupHp);
		groupHp.connect(groupLp);
		groupLp.connect(groupDelay);
		groupDelay.connect(groupMaster);
		groupMaster.connect(masterIn);
		return { layerSum, groupHp, groupLp, groupDelay, groupMaster };
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
	const microDelaySec = VOICE_MICRO_DELAY_SEC[voice] ?? 0;
	b.groupDelay.delayTime.setValueAtTime(microDelaySec, t);
	const g = Math.max(0, Math.min(4, masterLinear));
	b.groupMaster.gain.setValueAtTime(g, t);
}
