/**
 * METRA-style master path: linear sum of всех слоёв метронома → **мастер-лимитер** → destination.
 * В Web Audio нет отдельного LimiterNode: используем `DynamicsCompressor` с настройками пикового лимитера.
 * One chain per AudioContext (WeakMap); safe when context is closed/GC’d.
 */

const masterBusByContext = new WeakMap<AudioContext, { summing: GainNode; masterLimiter: DynamicsCompressorNode }>();

function createMasterPeakLimiter(ctx: AudioContext): DynamicsCompressorNode {
	const lim = ctx.createDynamicsCompressor();
	lim.threshold.value = -0.5;
	lim.knee.value = 0;
	lim.ratio.value = 20;
	lim.attack.value = 0.001;
	lim.release.value = 0.05;
	return lim;
}

export const METRA_LOOKAHEAD_MS = 25;
export const METRA_SCHEDULE_AHEAD_SEC = 0.1;

export type MetraSchedulerProfile = 'safe' | 'balanced' | 'aggressive';

export type MetraSchedulerConfig = {
	lookaheadMs: number;
	scheduleAheadSec: number;
	lateResetThresholdSec: number;
	maxCatchUpBatchesPerTick: number;
	maxCatchUpLagSec: number;
	safetyLeadSec: number;
};

function computeSafetyLeadSec(lookaheadMs: number): number {
	return Math.max(0.006, Math.min(0.02, (lookaheadMs / 1000) * 0.5));
}

export const METRA_SCHEDULER_PROFILES: Record<MetraSchedulerProfile, MetraSchedulerConfig> = {
	safe: {
		lookaheadMs: 20,
		scheduleAheadSec: 0.2,
		lateResetThresholdSec: 0.8,
		maxCatchUpBatchesPerTick: 128,
		maxCatchUpLagSec: 0.35,
		safetyLeadSec: computeSafetyLeadSec(20),
	},
	balanced: {
		lookaheadMs: METRA_LOOKAHEAD_MS,
		scheduleAheadSec: 0.15,
		lateResetThresholdSec: 0.65,
		maxCatchUpBatchesPerTick: 96,
		maxCatchUpLagSec: 0.25,
		safetyLeadSec: computeSafetyLeadSec(METRA_LOOKAHEAD_MS),
	},
	aggressive: {
		lookaheadMs: 16,
		scheduleAheadSec: 0.12,
		lateResetThresholdSec: 0.5,
		maxCatchUpBatchesPerTick: 64,
		maxCatchUpLagSec: 0.15,
		safetyLeadSec: computeSafetyLeadSec(16),
	},
};

export function getMetraSchedulerConfig(profile: MetraSchedulerProfile): MetraSchedulerConfig {
	return METRA_SCHEDULER_PROFILES[profile];
}

/** Input node: connect all layer tails here (linear sum). */
export function getMetronomeSummingInput(ctx: AudioContext): GainNode {
	let entry = masterBusByContext.get(ctx);
	if (!entry) {
		const summing = ctx.createGain();
		summing.gain.value = 1;
		const masterLimiter = createMasterPeakLimiter(ctx);
		summing.connect(masterLimiter);
		masterLimiter.connect(ctx.destination);
		entry = { summing, masterLimiter };
		masterBusByContext.set(ctx, entry);
	}
	return entry.summing;
}
