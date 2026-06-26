/**
 * Tail gate for accent Ta hits — cuts source before parallel limiter wet pumps rustle.
 */

import { metroEnvelopeEndFromPeak } from './metroLayerGraph';

const ACCENT_TA_ATTACK_SEC = 0.002;

/** User-calibrated Classic accent Ta tail close (ms from hit). */
export const BAKED_CLASSIC_TA_ACCENT_TAIL_MS = 23;

export function getClassicTaAccentTailMs(): number {
	return BAKED_CLASSIC_TA_ACCENT_TAIL_MS;
}

/**
 * Attack → decay → hard close at `tailMs` from `t0`.
 * @returns audio time when the source node should stop.
 */
export function scheduleClassicAccentTaTailEnvelope(
	gain: GainNode,
	ctx: AudioContext,
	t0: number,
	peak: number,
	tailMs = getClassicTaAccentTailMs(),
): number {
	const gateSec = Math.max(ACCENT_TA_ATTACK_SEC + 0.004, tailMs / 1000);
	const releaseSec = Math.min(0.01, Math.max(0.002, gateSec * 0.22));
	const attackEnd = t0 + ACCENT_TA_ATTACK_SEC;
	const gateEnd = t0 + gateSec;
	const decayEnd = Math.max(attackEnd + 0.001, gateEnd - releaseSec);
	const endVol = metroEnvelopeEndFromPeak(peak);
	const now = ctx.currentTime;

	gain.gain.cancelScheduledValues(now);
	gain.gain.setValueAtTime(0, now);
	gain.gain.setValueAtTime(0, t0);
	gain.gain.linearRampToValueAtTime(peak, attackEnd);
	gain.gain.exponentialRampToValueAtTime(endVol, decayEnd);
	gain.gain.exponentialRampToValueAtTime(0.00001, gateEnd);

	return gateEnd + 0.012;
}
