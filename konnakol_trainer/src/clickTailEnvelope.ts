/**
 * Front/tail gate envelopes for scheduled click layers and accent Ta.
 */

import { metroEnvelopeEndFromPeak } from './metroLayerGraph';

export type ClickTailEnvelopeShapeId =
	| 'snap'
	| 'linear'
	| 'exp_tight'
	| 'exp_soft'
	| 'plateau'
	| 'punch';

export const CLICK_TAIL_ENVELOPE_SHAPE_ORDER: ClickTailEnvelopeShapeId[] = [
	'snap',
	'linear',
	'exp_tight',
	'exp_soft',
	'plateau',
	'punch',
];

export const CLICK_TAIL_ENVELOPE_SHAPE_LABELS: Record<ClickTailEnvelopeShapeId, string> = {
	snap: 'Snap',
	linear: 'Linear',
	exp_tight: 'Exp tight',
	exp_soft: 'Exp soft',
	plateau: 'Plateau',
	punch: 'Punch',
};

/** Fade-in (attack) curve presets — duration comes from attackMs only. */
export const CLICK_ATTACK_FADE_SHAPE_LABELS: Record<ClickTailEnvelopeShapeId, string> = {
	snap: 'Snap in',
	linear: 'Linear',
	exp_tight: 'Exp tight',
	exp_soft: 'Exp soft',
	plateau: 'S-curve',
	punch: 'Punch in',
};

const EPS_GAIN = 0.00001;
const INSTANT_ATTACK_SEC = 0.0005;

/** Offline bake offset in `renderTaDrumMachineBuffer` — playback envelope aligns to this, not grid t0. */
export const DRUM_MACHINE_TA_SAMPLE_ONSET_SEC = 0.006;

export function isClickTailEnvelopeShapeId(value: unknown): value is ClickTailEnvelopeShapeId {
	return (
		value === 'snap' ||
		value === 'linear' ||
		value === 'exp_tight' ||
		value === 'exp_soft' ||
		value === 'plateau' ||
		value === 'punch'
	);
}

export function clampPassiveTailMs(ms: number, fallback: number): number {
	if (!Number.isFinite(ms)) return fallback;
	return Math.max(1, Math.min(120, ms));
}

export function clampPassiveFrontMs(ms: number, fallback = 0): number {
	if (!Number.isFinite(ms)) return fallback;
	return Math.max(0, Math.min(20, ms));
}

/** Legacy wide clamp — accent Ta baked path only. */
export function clampClickTailMs(ms: number, fallback: number): number {
	if (!Number.isFinite(ms)) return fallback;
	return Math.max(1, Math.min(120, ms));
}

function primeGainAtHit(gain: GainNode, ctx: AudioContext, t0: number): void {
	const now = ctx.currentTime;
	gain.gain.cancelScheduledValues(now);
	gain.gain.setValueAtTime(0, now);
	gain.gain.setValueAtTime(0, t0);
}

/**
 * Fade-in from silence to peak over exactly `frontSec` (attackMs).
 * Shape presets only change the curve; peak is always reached at t0 + frontSec.
 */
function scheduleFrontAttack(
	gain: GainNode,
	t0: number,
	peak: number,
	frontSec: number,
	shape: ClickTailEnvelopeShapeId,
): number {
	const frontEnd = t0 + frontSec;
	const eps = Math.max(EPS_GAIN, peak * 0.0001);

	switch (shape) {
		case 'linear':
			gain.gain.setValueAtTime(0, t0);
			gain.gain.linearRampToValueAtTime(peak, frontEnd);
			break;
		case 'exp_tight':
			gain.gain.setValueAtTime(eps, t0);
			gain.gain.exponentialRampToValueAtTime(Math.max(eps, peak), frontEnd);
			break;
		case 'exp_soft': {
			const mid = t0 + frontSec * 0.58;
			gain.gain.setValueAtTime(eps, t0);
			gain.gain.exponentialRampToValueAtTime(Math.max(eps, peak * 0.32), mid);
			gain.gain.exponentialRampToValueAtTime(peak, frontEnd);
			break;
		}
		case 'plateau': {
			const mid = t0 + frontSec * 0.52;
			gain.gain.setValueAtTime(0, t0);
			gain.gain.linearRampToValueAtTime(peak * 0.28, mid);
			gain.gain.linearRampToValueAtTime(peak, frontEnd);
			break;
		}
		case 'punch': {
			const knee = t0 + frontSec * 0.34;
			gain.gain.setValueAtTime(0, t0);
			gain.gain.linearRampToValueAtTime(peak * 0.9, knee);
			gain.gain.linearRampToValueAtTime(peak, frontEnd);
			break;
		}
		case 'snap':
		default: {
			const knee = t0 + frontSec * 0.38;
			gain.gain.setValueAtTime(eps, t0);
			gain.gain.exponentialRampToValueAtTime(Math.max(eps, peak * 0.86), knee);
			gain.gain.exponentialRampToValueAtTime(peak, frontEnd);
			break;
		}
	}
	return frontEnd;
}

function scheduleTailRelease(
	gain: GainNode,
	attackEnd: number,
	peak: number,
	gateEnd: number,
	shape: ClickTailEnvelopeShapeId,
): void {
	const releaseSec = Math.max(0.0004, gateEnd - attackEnd);
	const endVol = metroEnvelopeEndFromPeak(peak);

	switch (shape) {
		case 'linear':
			gain.gain.linearRampToValueAtTime(EPS_GAIN, gateEnd);
			return;
		case 'exp_tight': {
			const mid = attackEnd + releaseSec * 0.45;
			gain.gain.exponentialRampToValueAtTime(endVol, mid);
			gain.gain.exponentialRampToValueAtTime(EPS_GAIN, gateEnd);
			return;
		}
		case 'exp_soft':
			gain.gain.exponentialRampToValueAtTime(EPS_GAIN, gateEnd);
			return;
		case 'plateau': {
			const holdEnd = attackEnd + releaseSec * 0.48;
			gain.gain.setValueAtTime(peak, holdEnd);
			gain.gain.exponentialRampToValueAtTime(EPS_GAIN, gateEnd);
			return;
		}
		case 'punch': {
			const holdEnd = attackEnd + releaseSec * 0.2;
			gain.gain.setValueAtTime(peak, holdEnd);
			gain.gain.exponentialRampToValueAtTime(endVol, attackEnd + releaseSec * 0.72);
			gain.gain.exponentialRampToValueAtTime(EPS_GAIN, gateEnd);
			return;
		}
		case 'snap':
		default: {
			const decayEnd = Math.max(attackEnd + 0.0003, gateEnd - releaseSec * 0.22);
			gain.gain.exponentialRampToValueAtTime(endVol, decayEnd);
			gain.gain.exponentialRampToValueAtTime(EPS_GAIN, gateEnd);
		}
	}
}

function scheduleLegacyShapeEnvelope(
	gain: GainNode,
	t0: number,
	peak: number,
	gateSec: number,
	shape: ClickTailEnvelopeShapeId,
): void {
	const gateEnd = t0 + gateSec;
	const endVol = metroEnvelopeEndFromPeak(peak);

	switch (shape) {
		case 'linear': {
			const attackEnd = t0 + gateSec * 0.12;
			gain.gain.linearRampToValueAtTime(peak, attackEnd);
			gain.gain.linearRampToValueAtTime(EPS_GAIN, gateEnd);
			return;
		}
		case 'exp_tight': {
			const attackEnd = t0 + gateSec * 0.08;
			const mid = t0 + gateSec * 0.42;
			gain.gain.linearRampToValueAtTime(peak, attackEnd);
			gain.gain.exponentialRampToValueAtTime(endVol, mid);
			gain.gain.exponentialRampToValueAtTime(EPS_GAIN, gateEnd);
			return;
		}
		case 'exp_soft': {
			const attackEnd = t0 + gateSec * 0.16;
			gain.gain.linearRampToValueAtTime(peak, attackEnd);
			gain.gain.exponentialRampToValueAtTime(EPS_GAIN, gateEnd);
			return;
		}
		case 'plateau': {
			const attackEnd = t0 + gateSec * 0.1;
			const holdEnd = t0 + gateSec * 0.55;
			gain.gain.linearRampToValueAtTime(peak, attackEnd);
			gain.gain.setValueAtTime(peak, holdEnd);
			gain.gain.exponentialRampToValueAtTime(EPS_GAIN, gateEnd);
			return;
		}
		case 'punch': {
			const attackEnd = t0 + gateSec * 0.05;
			const holdEnd = t0 + gateSec * 0.22;
			gain.gain.linearRampToValueAtTime(peak, attackEnd);
			gain.gain.setValueAtTime(peak, holdEnd);
			gain.gain.exponentialRampToValueAtTime(endVol, t0 + gateSec * 0.72);
			gain.gain.exponentialRampToValueAtTime(EPS_GAIN, gateEnd);
			return;
		}
		case 'snap':
		default: {
			const attackSec = Math.min(0.002, gateSec * 0.35);
			const attackEnd = t0 + attackSec;
			const releaseSec = Math.min(0.008, Math.max(0.0008, gateSec * 0.22));
			const decayEnd = Math.max(attackEnd + 0.0004, gateEnd - releaseSec);
			gain.gain.linearRampToValueAtTime(peak, attackEnd);
			gain.gain.exponentialRampToValueAtTime(endVol, decayEnd);
			gain.gain.exponentialRampToValueAtTime(EPS_GAIN, gateEnd);
		}
	}
}

/**
 * `frontMs` = fade-in length (0–20 ms), `tailMs` = decay/hold tail after peak (independent).
 * Attack shapes = fade-in curve; decay shapes = release curve.
 */
export function schedulePassiveClickGateEnvelope(
	gain: GainNode,
	ctx: AudioContext,
	t0: number,
	peak: number,
	tailMs: number,
	tailShape: ClickTailEnvelopeShapeId = 'snap',
	frontMs = 0,
	frontShape: ClickTailEnvelopeShapeId = 'snap',
): number {
	const decaySec = Math.max(0.001, clampPassiveTailMs(tailMs, tailMs) / 1000);
	const frontSec = clampPassiveFrontMs(frontMs, 0) / 1000;

	primeGainAtHit(gain, ctx, t0);

	let peakTime: number;
	if (frontSec <= 0.0001) {
		peakTime = t0 + INSTANT_ATTACK_SEC;
		gain.gain.linearRampToValueAtTime(peak, peakTime);
	} else {
		peakTime = scheduleFrontAttack(gain, t0, peak, frontSec, frontShape);
	}

	const gateEnd = peakTime + decaySec;
	scheduleTailRelease(gain, peakTime, peak, gateEnd, tailShape);
	return gateEnd + 0.008;
}

/**
 * Pre-rendered sample path: fade-in from baked onset; decay = release length after peak
 * (gain gate — source keeps running silently; no early src.stop).
 */
export function scheduleSampleAlignedGateEnvelope(
	gain: GainNode,
	ctx: AudioContext,
	t0: number,
	peak: number,
	_bufferDurationSec: number,
	tailMs: number,
	tailShape: ClickTailEnvelopeShapeId = 'snap',
	frontMs = 0,
	frontShape: ClickTailEnvelopeShapeId = 'snap',
	contentOnsetSec = DRUM_MACHINE_TA_SAMPLE_ONSET_SEC,
): void {
	const hitTime = t0 + Math.max(0, contentOnsetSec);
	const decaySec = Math.max(0.001, clampPassiveTailMs(tailMs, tailMs) / 1000);
	const frontSec = clampPassiveFrontMs(frontMs, 0) / 1000;

	const now = ctx.currentTime;
	gain.gain.cancelScheduledValues(now);
	gain.gain.setValueAtTime(0, now);
	gain.gain.setValueAtTime(0, t0);
	if (hitTime > t0 + 0.00005) {
		gain.gain.setValueAtTime(0, hitTime);
	}

	let peakTime: number;
	if (frontSec <= 0.0001) {
		peakTime = hitTime + INSTANT_ATTACK_SEC;
		gain.gain.linearRampToValueAtTime(peak, peakTime);
	} else {
		peakTime = scheduleFrontAttack(gain, hitTime, peak, frontSec, frontShape);
	}

	const gateEnd = peakTime + decaySec;
	scheduleTailRelease(gain, peakTime, peak, gateEnd, tailShape);
}

export type BlendEnvelopeParams = {
	envelopeMix: number;
	envelopeGain: number;
	attackMs: number;
	attackShape: ClickTailEnvelopeShapeId;
	decayMs: number;
	decayShape: ClickTailEnvelopeShapeId;
};

function wetEnvelopePeak(peak: number, splitWet: number, envelopeGain: number): number {
	const g = Number.isFinite(envelopeGain) ? Math.max(0, Math.min(2, envelopeGain)) : 1;
	return peak * splitWet * g;
}

export function splitEnvelopeMix(mix: number): { wet: number; dry: number; gated: boolean } {
	const m = Math.max(0, Math.min(1, mix));
	if (m <= 0.0005) return { wet: 0, dry: 1, gated: false };
	if (m >= 0.9995) return { wet: 1, dry: 0, gated: true };
	return { wet: m, dry: 1 - m, gated: true };
}

/** Drum machine Accent Ta sample: onset-aligned fade-in; decay gates tail after peak. */
export function scheduleBufferedClickWithBlendEnvelope(
	ctx: AudioContext,
	t0: number,
	buffer: AudioBuffer,
	destination: AudioNode,
	peak: number,
	nativeAttackSec: number,
	env: BlendEnvelopeParams | null,
	contentOnsetSec = DRUM_MACHINE_TA_SAMPLE_ONSET_SEC,
): void {
	const split = env ? splitEnvelopeMix(env.envelopeMix) : { wet: 0, dry: 1, gated: false };
	const now = ctx.currentTime;
	const sourceEnd = t0 + buffer.duration + 0.012;
	const hitTime = t0 + Math.max(0, contentOnsetSec);

	const playNative = (srcPeak: number) => {
		if (srcPeak <= 0) return;
		const src = ctx.createBufferSource();
		const gain = ctx.createGain();
		src.buffer = buffer;
		gain.gain.cancelScheduledValues(now);
		gain.gain.setValueAtTime(0, now);
		gain.gain.setValueAtTime(0, t0);
		gain.gain.linearRampToValueAtTime(srcPeak, hitTime + nativeAttackSec);
		src.connect(gain);
		gain.connect(destination);
		src.start(t0);
		src.stop(sourceEnd);
		src.onended = () => {
			src.disconnect();
			gain.disconnect();
		};
	};

	if (!env || !split.gated) {
		playNative(peak);
		return;
	}
	if (split.dry > 0) playNative(peak * split.dry);
	if (split.wet > 0) {
		const src = ctx.createBufferSource();
		const gain = ctx.createGain();
		src.buffer = buffer;
		scheduleSampleAlignedGateEnvelope(
			gain,
			ctx,
			t0,
			wetEnvelopePeak(peak, split.wet, env.envelopeGain),
			buffer.duration,
			env.decayMs,
			env.decayShape,
			env.attackMs,
			env.attackShape,
			contentOnsetSec,
		);
		src.connect(gain);
		gain.connect(destination);
		src.start(t0);
		src.stop(sourceEnd);
		src.onended = () => {
			src.disconnect();
			gain.disconnect();
		};
	}
}

/** Oscillator Ta: native schedule vs gate, optional dry/wet (dual osc). */
export function scheduleOscClickWithBlendEnvelope(
	ctx: AudioContext,
	t0: number,
	peak: number,
	env: BlendEnvelopeParams | null,
	connectChain: (osc: OscillatorNode, gain: GainNode) => void,
	scheduleNative: (gain: GainNode, srcPeak: number) => number,
): void {
	const split = env ? splitEnvelopeMix(env.envelopeMix) : { wet: 0, dry: 1, gated: false };

	const playNative = (srcPeak: number) => {
		if (srcPeak <= 0) return;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		connectChain(osc, gain);
		const stopAt = scheduleNative(gain, srcPeak);
		osc.start(t0);
		osc.stop(stopAt);
	};

	if (!env || !split.gated) {
		playNative(peak);
		return;
	}
	if (split.dry > 0) playNative(peak * split.dry);
	if (split.wet > 0) {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		connectChain(osc, gain);
		const stopAt = schedulePassiveClickGateEnvelope(
			gain,
			ctx,
			t0,
			wetEnvelopePeak(peak, split.wet, env.envelopeGain),
			env.decayMs,
			env.decayShape,
			env.attackMs,
			env.attackShape,
		);
		osc.start(t0);
		osc.stop(stopAt);
	}
}

/** @deprecated use schedulePassiveClickGateEnvelope */
export function schedulePassiveClickTailEnvelope(
	gain: GainNode,
	ctx: AudioContext,
	t0: number,
	peak: number,
	tailMs: number,
	shape: ClickTailEnvelopeShapeId = 'snap',
): number {
	return schedulePassiveClickGateEnvelope(gain, ctx, t0, peak, tailMs, shape, 0, 'snap');
}

export function scheduleClickTailEnvelope(
	gain: GainNode,
	ctx: AudioContext,
	t0: number,
	peak: number,
	tailMs: number,
	shape: ClickTailEnvelopeShapeId = 'snap',
): number {
	const safeTailMs = clampClickTailMs(tailMs, tailMs);
	const gateSec = Math.max(0.001, safeTailMs / 1000);
	primeGainAtHit(gain, ctx, t0);
	scheduleLegacyShapeEnvelope(gain, t0, peak, gateSec, shape);
	return t0 + gateSec + 0.008;
}
