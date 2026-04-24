/**
 * Per-layer DSP graph aligned with `engine example/src/audio/engine.ts` scheduleNote:
 * Tone: osc → gain (AD) → HP → LP → bus
 * Noise: buffer → noiseFilter (character) → gain (AD) → HP → LP → bus
 * Filter cutoff scheduling uses setValueAtTime at `scheduleTime` like the reference.
 */

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
const SHARED_NOISE_BUFFER_SEC = 2;
/** Фиксированный сид: один и тот же «белый» буфер при новом `AudioContext`, без `Math.random`. */
const SHARED_NOISE_SEED = 0x2f6b9a3e;
const sharedNoiseBufferByContext = new WeakMap<AudioContext, AudioBuffer>();

/**
 * White noise in [-1,1), bit-identical for same `ch.length` across sessions (unlike `Math.random` fill).
 * Mulberry32-style step (bryc); independent of `AudioContext` aside from buffer length.
 */
function fillChannelDeterministicWhiteNoise(ch: Float32Array): void {
	let a = SHARED_NOISE_SEED | 0;
	for (let i = 0; i < ch.length; i++) {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = t + Math.imul(t ^ (t + 0x7), 61 | t) ^ t;
		ch[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
	}
}

/** Same floor as engine example (`max(1e-5, peak * 0.001)`). */
export function metroEnvelopeEndFromPeak(peakLinear: number): number {
	return Math.max(0.00001, peakLinear * 0.001);
}

function getSharedNoiseBuffer(ctx: AudioContext): AudioBuffer {
	const cached = sharedNoiseBufferByContext.get(ctx);
	if (cached) return cached;
	const frameCount = Math.max(1, Math.floor(ctx.sampleRate * SHARED_NOISE_BUFFER_SEC));
	const buf = ctx.createBuffer(1, frameCount, ctx.sampleRate);
	const output = buf.getChannelData(0);
	fillChannelDeterministicWhiteNoise(output);
	sharedNoiseBufferByContext.set(ctx, buf);
	return buf;
}

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
): void {
	const p = layer.params;
	const hpFreq = p.hpFreq || 20;
	const lpFreq = p.lpFreq || 20000;

	const layerLp = ctx.createBiquadFilter();
	layerLp.type = 'lowpass';
	layerLp.frequency.setValueAtTime(lpFreq, scheduleTime);

	const layerHp = ctx.createBiquadFilter();
	layerHp.type = 'highpass';
	layerHp.frequency.setValueAtTime(hpFreq, scheduleTime);

	layerHp.connect(layerLp);
	layerLp.connect(summingInput);

	if (layer.type === 'noise') {
		const noiseSrc = ctx.createBufferSource();
		noiseSrc.buffer = getSharedNoiseBuffer(ctx);

		const noiseFilter = ctx.createBiquadFilter();
		noiseFilter.type = layer.noiseFilterType || 'highpass';
		noiseFilter.frequency.setValueAtTime(p.freq, scheduleTime);

		const noiseGain = ctx.createGain();
		const nVol = peakLinear * 0.5;
		const nEndVol = Math.max(0.00001, nVol * 0.001);

		noiseGain.gain.cancelScheduledValues(scheduleTime);
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

	osc.type = layer.type as OscillatorType;
	osc.frequency.setValueAtTime(Math.max(1, p.freq), scheduleTime);
	if (layer.sweep) {
		osc.frequency.exponentialRampToValueAtTime(Math.max(10, p.freq * 0.1), scheduleTime + decaySec);
	}

	gain.gain.cancelScheduledValues(scheduleTime);
	gain.gain.setValueAtTime(0, scheduleTime);
	gain.gain.linearRampToValueAtTime(peakLinear, scheduleTime + METRO_LAYER_ATTACK_SEC);
	gain.gain.exponentialRampToValueAtTime(endVol, scheduleTime + decaySec);

	osc.connect(gain);
	gain.connect(layerHp);

	osc.start(scheduleTime);
	osc.stop(scheduleTime + decaySec + 0.05);
}
