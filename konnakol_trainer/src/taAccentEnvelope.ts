/**
 * Classic accent Ta / passive gate calibration constants.
 */

import {
	scheduleClickTailEnvelope,
	schedulePassiveClickGateEnvelope,
	type ClickTailEnvelopeShapeId,
} from './clickTailEnvelope';

/** User-calibrated Classic accent Ta tail close (ms from hit). */
export const BAKED_CLASSIC_TA_ACCENT_TAIL_MS = 23;

/** User-calibrated Classic passive attack/decay envelope. */
export const BAKED_CLASSIC_PASSIVE_FRONT_MS = 11.1;
export const BAKED_CLASSIC_PASSIVE_TAIL_MS = 2.6;
export const BAKED_CLASSIC_PASSIVE_FRONT_SHAPE: ClickTailEnvelopeShapeId = 'exp_tight';
export const BAKED_CLASSIC_PASSIVE_TAIL_SHAPE: ClickTailEnvelopeShapeId = 'linear';

export function getClassicTaAccentTailMs(): number {
	return BAKED_CLASSIC_TA_ACCENT_TAIL_MS;
}

export function getClassicPassiveTailMs(): number {
	return BAKED_CLASSIC_PASSIVE_TAIL_MS;
}

export function getClassicPassiveTailShape(): ClickTailEnvelopeShapeId {
	return BAKED_CLASSIC_PASSIVE_TAIL_SHAPE;
}

export function getClassicPassiveFrontMs(): number {
	return BAKED_CLASSIC_PASSIVE_FRONT_MS;
}

export function getClassicPassiveFrontShape(): ClickTailEnvelopeShapeId {
	return BAKED_CLASSIC_PASSIVE_FRONT_SHAPE;
}

export function scheduleClassicAccentTaTailEnvelope(
	gain: GainNode,
	ctx: AudioContext,
	t0: number,
	peak: number,
	tailMs = getClassicTaAccentTailMs(),
): number {
	return scheduleClickTailEnvelope(gain, ctx, t0, peak, tailMs, 'snap');
}

export { scheduleClickTailEnvelope, schedulePassiveClickGateEnvelope, type ClickTailEnvelopeShapeId };
