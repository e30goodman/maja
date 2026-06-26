/**
 * Classic passive bus parallel limiter (voice bus `passive` only, Classic preset).
 */

import type { ParallelLimiterSettings } from './parallelBusChain';

/** User-calibrated Classic passive parallel — wet 31% at UI fader 100%. */
export const BAKED_CLASSIC_PASSIVE_PARALLEL: ParallelLimiterSettings = {
	gain: 1,
	volume: 0.31,
	preset: 'tight',
	lookAheadMs: 3.2,
	phaseAlignMs: 0,
};

export function getClassicPassiveParallelSettings(): ParallelLimiterSettings {
	return BAKED_CLASSIC_PASSIVE_PARALLEL;
}
