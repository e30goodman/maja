/**
 * Per-layer DSP graph aligned with `engine example/src/audio/engine.ts` scheduleNote:
 * Tone: osc → gain (AD) → HP → LP → bus
 * Noise: buffer → noiseFilter (character) → gain (AD) → HP → LP → bus
 * Filter cutoff scheduling uses setValueAtTime at `scheduleTime` like the reference.
 */

import { fillChannelDeterministicWhiteNoise, SHARED_AUDIO_NOISE_SEED } from './deterministicWhiteNoiseFill';

export type MetroLayerGraphType = OscillatorType | 'noise' | 'none';

export type MetroLayerGraphConfig = {
	type: MetroLayerGraphType;
	sweep: boolean;
	noiseFilterType: BiquadFilterType;
	params: {
		volume: number;
		decay: number;
		freq: number;
		hpFreq: number;
		lpFreq: number;
	};
};

const METRO_LAYER_ATTACK_SEC = 0.002;
const OSC_START_JITTER_MAX_SEC = 0.002;
const SHARED_NOISE_BUFFER_SEC = 2;
const FILTER_Q_FLAT = 0.7071;
const MIN_HP_HZ = 20;
const sharedNoiseBufferByContext = new WeakMap<AudioContext, Map<number, AudioBuffer>>();

/** Same floor as engine example (`max(1e-5, peak * 0.001)`). */
export function metroEnvelopeEndFromPeak(peakLinear: number): number {
	return Math.max(0.00001, peakLinear * 0.001);
}

function getSharedNoiseBuffer(ctx: AudioContext, seed: number): AudioBuffer {
	const bySeed = sharedNoiseBufferByContext.get(ctx) ?? new Map<number, AudioBuffer>();
	const cached = bySeed.get(seed);
	if (cached) return cached;
	const frameCount = Math.max(1, Math.floor(ctx.sampleRate * SHARED_NOISE_BUFFER_SEC));
	const buf = ctx.createBuffer(1, frameCount, ctx.sampleRate);
	const output = buf.getChannelData(0);
	fillChannelDeterministicWhiteNoise(output, seed);
	bySeed.set(seed, buf);
	sharedNoiseBufferByContext.set(ctx, bySeed);
	return buf;
}

type ScheduleLayerOptions = {
	isOffline?: boolean;
	noiseSeed?: number;
};

/**
 * @param scheduleTime AudioContext time for scheduling (e.g. t0 after guard)
 * @param peakLinear Peak linear gain after orchestration (e.g. accent_only scaling)
 * @param decaySec Clamped decay duration in seconds
 */
export function scheduleLayerToBus(
	ctx: AudioContext,
	scheduleTime: number,
	layer: MetroLayerGraphConfig,
	peakLinear: number,
	decaySec: number,
	summingInput: AudioNode,
	options?: ScheduleLayerOptions,
): void {
	const now = ctx.currentTime;
	const isOffline = options?.isOffline === true;
	const noiseSeed = options?.noiseSeed ?? SHARED_AUDIO_NOISE_SEED;
	const p = layer.params;
	const hpFreq = Math.max(MIN_HP_HZ, p.hpFreq || 20);
	const lpFreq = p.lpFreq || 20000;

	const layerLp = ctx.createBiquadFilter();
	layerLp.type = 'lowpass';
	layerLp.frequency.setValueAtTime(lpFreq, scheduleTime);
	layerLp.Q.setValueAtTime(FILTER_Q_FLAT, scheduleTime);

	const layerHp = ctx.createBiquadFilter();
	layerHp.type = 'highpass';
	layerHp.frequency.setValueAtTime(hpFreq, scheduleTime);
	layerHp.Q.setValueAtTime(FILTER_Q_FLAT, scheduleTime);

	layerHp.connect(layerLp);
	layerLp.connect(summingInput);

	if (layer.type === 'noise') {
		const noiseSrc = ctx.createBufferSource();
		noiseSrc.buffer = getSharedNoiseBuffer(ctx, noiseSeed);

		const noiseFilter = ctx.createBiquadFilter();
		noiseFilter.type = layer.noiseFilterType || 'highpass';
		noiseFilter.frequency.setValueAtTime(p.freq, scheduleTime);
		noiseFilter.Q.setValueAtTime(FILTER_Q_FLAT, scheduleTime);

		const noiseGain = ctx.createGain();
		const nVol = peakLinear * 0.5;
		const nEndVol = Math.max(0.00001, nVol * 0.001);

		noiseGain.gain.cancelScheduledValues(now);
		noiseGain.gain.setValueAtTime(0, 0);
		noiseGain.gain.linearRampToValueAtTime(0, scheduleTime);
		noiseGain.gain.setValueAtTime(0, scheduleTime);
		noiseGain.gain.linearRampToValueAtTime(nVol, scheduleTime + METRO_LAYER_ATTACK_SEC);
		noiseGain.gain.exponentialRampToValueAtTime(nEndVol, scheduleTime + decaySec);

		noiseSrc.connect(noiseFilter);
		noiseFilter.connect(noiseGain);
		noiseGain.connect(layerHp);

		noiseSrc.start(scheduleTime);
		noiseSrc.stop(scheduleTime + decaySec + 0.05);
		return;
	}

	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	const endVol = metroEnvelopeEndFromPeak(peakLinear);
	const oscStartTime = isOffline ? scheduleTime : scheduleTime + Math.random() * OSC_START_JITTER_MAX_SEC;

	osc.type = layer.type as OscillatorType;
	osc.frequency.setValueAtTime(Math.max(1, p.freq), oscStartTime);
	if (layer.sweep) {
		osc.frequency.exponentialRampToValueAtTime(Math.max(10, p.freq * 0.1), oscStartTime + decaySec);
	}

	gain.gain.cancelScheduledValues(now);
	gain.gain.setValueAtTime(0, 0);
	gain.gain.linearRampToValueAtTime(0, oscStartTime);
	gain.gain.setValueAtTime(0, oscStartTime);
	gain.gain.linearRampToValueAtTime(peakLinear, oscStartTime + METRO_LAYER_ATTACK_SEC);
	gain.gain.exponentialRampToValueAtTime(endVol, oscStartTime + decaySec);

	osc.connect(gain);
	gain.connect(layerHp);

	osc.start(oscStartTime);
	osc.stop(oscStartTime + decaySec + 0.05);
}
