/**
 * Shared parallel limiter chain for per-voice buses.
 * Baked defaults from user calibration (Tight / gain 100% / wet 60% / phase 0 / LA 4ms).
 */

export type ParallelLimiterPresetId = 'tight' | 'punch' | 'glue' | 'sustain';

export type ParallelLimiterSettings = {
	gain: number;
	volume: number;
	preset: ParallelLimiterPresetId;
	lookAheadMs: number;
	phaseAlignMs: number;
};

/** Production defaults — dev knobs removed; same character on accent / alt / passive. */
export const BAKED_VOICE_PARALLEL_LIMITER: ParallelLimiterSettings = {
	gain: 1,
	volume: 0.6,
	preset: 'tight',
	lookAheadMs: 4,
	phaseAlignMs: 0,
};

export const DEFAULT_PARALLEL_LIMITER_SETTINGS: ParallelLimiterSettings = {
	...BAKED_VOICE_PARALLEL_LIMITER,
};

type LimiterPresetDef = {
	attack: number;
	release: number;
	knee: number;
	ratioBase: number;
	thresholdBase: number;
	baseAlignMs: number;
};

const PARALLEL_LIMITER_PRESETS: Record<ParallelLimiterPresetId, LimiterPresetDef & { label: string }> = {
	tight: {
		label: 'Tight',
		attack: 0.001,
		release: 0.035,
		knee: 0,
		ratioBase: 16,
		thresholdBase: -6,
		baseAlignMs: 2,
	},
	punch: {
		label: 'Punch',
		attack: 0.003,
		release: 0.055,
		knee: 0,
		ratioBase: 12,
		thresholdBase: -8,
		baseAlignMs: 5,
	},
	glue: {
		label: 'Glue',
		attack: 0.008,
		release: 0.11,
		knee: 2,
		ratioBase: 8,
		thresholdBase: -12,
		baseAlignMs: 9,
	},
	sustain: {
		label: 'Sustain',
		attack: 0.012,
		release: 0.17,
		knee: 3,
		ratioBase: 6,
		thresholdBase: -16,
		baseAlignMs: 12,
	},
};

export const PARALLEL_LIMITER_PRESET_ORDER: ParallelLimiterPresetId[] = [
	'tight',
	'punch',
	'glue',
	'sustain',
];

export const PARALLEL_LIMITER_PRESET_LABELS: Record<ParallelLimiterPresetId, string> = {
	tight: PARALLEL_LIMITER_PRESETS.tight.label,
	punch: PARALLEL_LIMITER_PRESETS.punch.label,
	glue: PARALLEL_LIMITER_PRESETS.glue.label,
	sustain: PARALLEL_LIMITER_PRESETS.sustain.label,
};

export function parseParallelLimiterSettings(raw: string | null): ParallelLimiterSettings {
	try {
		if (!raw) return { ...BAKED_VOICE_PARALLEL_LIMITER };
		const parsed = JSON.parse(raw) as Partial<ParallelLimiterSettings>;
		const gain = Number(parsed.gain);
		const volume = Number(parsed.volume);
		const lookAheadMs = Number(parsed.lookAheadMs);
		const phaseAlignMs = Number(parsed.phaseAlignMs);
		const preset = isParallelLimiterPresetId(parsed.preset)
			? parsed.preset
			: BAKED_VOICE_PARALLEL_LIMITER.preset;
		return {
			gain: Number.isFinite(gain) ? clamp01(gain) : BAKED_VOICE_PARALLEL_LIMITER.gain,
			volume: Number.isFinite(volume) ? clamp01(volume) : BAKED_VOICE_PARALLEL_LIMITER.volume,
			preset,
			lookAheadMs: clampRange(lookAheadMs, 0, 12, BAKED_VOICE_PARALLEL_LIMITER.lookAheadMs),
			phaseAlignMs: clampRange(phaseAlignMs, -12, 12, BAKED_VOICE_PARALLEL_LIMITER.phaseAlignMs),
		};
	} catch {
		return { ...BAKED_VOICE_PARALLEL_LIMITER };
	}
}

export const MAX_PARALLEL_PATH_DELAY_MS = 24;

export type ParallelBusChainNodes = {
	dryDelay: DelayNode;
	dryGain: GainNode;
	parallelDrive: GainNode;
	parallelLimiter: DynamicsCompressorNode;
	wetDelay: DelayNode;
	wetMix: GainNode;
	voiceOut: GainNode;
};

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function clampRange(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, value));
}

function isParallelLimiterPresetId(value: unknown): value is ParallelLimiterPresetId {
	return value === 'tight' || value === 'punch' || value === 'glue' || value === 'sustain';
}

function createPeakLimiter(ctx: AudioContext): DynamicsCompressorNode {
	const lim = ctx.createDynamicsCompressor();
	lim.threshold.value = -0.1;
	lim.knee.value = 0;
	lim.ratio.value = 10;
	lim.attack.value = 0.003;
	lim.release.value = 0.05;
	return lim;
}

function mapGainToDrive(gain01: number): number {
	return 1 + gain01 * 5;
}

function computePathDelays(settings: ParallelLimiterSettings): { dryMs: number; wetMs: number } {
	const preset = PARALLEL_LIMITER_PRESETS[settings.preset];
	const lookAheadMs = clampRange(settings.lookAheadMs, 0, 12, BAKED_VOICE_PARALLEL_LIMITER.lookAheadMs);
	const phaseAlignMs = clampRange(
		settings.phaseAlignMs,
		-12,
		12,
		BAKED_VOICE_PARALLEL_LIMITER.phaseAlignMs,
	);
	const baseDryMs = preset.baseAlignMs + lookAheadMs;
	const dryMs = Math.max(0, Math.min(MAX_PARALLEL_PATH_DELAY_MS, baseDryMs + phaseAlignMs));
	const wetMs = Math.max(0, Math.min(MAX_PARALLEL_PATH_DELAY_MS, -phaseAlignMs));
	return { dryMs, wetMs };
}

function setDelayMs(node: DelayNode, ctx: AudioContext, ms: number): void {
	const sec = Math.max(0, Math.min(MAX_PARALLEL_PATH_DELAY_MS / 1000, ms / 1000));
	node.delayTime.setValueAtTime(sec, ctx.currentTime);
}

export function createParallelBusChain(ctx: AudioContext, input: AudioNode, output: AudioNode): ParallelBusChainNodes {
	const dryDelay = ctx.createDelay(MAX_PARALLEL_PATH_DELAY_MS / 1000);
	const dryGain = ctx.createGain();
	const parallelDrive = ctx.createGain();
	const parallelLimiter = createPeakLimiter(ctx);
	const wetDelay = ctx.createDelay(MAX_PARALLEL_PATH_DELAY_MS / 1000);
	const wetMix = ctx.createGain();
	const voiceOut = ctx.createGain();
	voiceOut.gain.value = 1;

	input.connect(dryDelay);
	dryDelay.connect(dryGain);
	input.connect(parallelDrive);
	dryGain.connect(voiceOut);
	parallelDrive.connect(parallelLimiter);
	parallelLimiter.connect(wetDelay);
	wetDelay.connect(wetMix);
	wetMix.connect(voiceOut);
	voiceOut.connect(output);

	return {
		dryDelay,
		dryGain,
		parallelDrive,
		parallelLimiter,
		wetDelay,
		wetMix,
		voiceOut,
	};
}

export function applyBakedParallelChain(
	ctx: AudioContext,
	chain: ParallelBusChainNodes,
	settings: ParallelLimiterSettings = BAKED_VOICE_PARALLEL_LIMITER,
	busFaderLinear = 1,
): void {
	const gain = clamp01(settings.gain);
	const presetId = isParallelLimiterPresetId(settings.preset)
		? settings.preset
		: BAKED_VOICE_PARALLEL_LIMITER.preset;
	const preset = PARALLEL_LIMITER_PRESETS[presetId];
	const fader = Math.max(0, Math.min(1.6, busFaderLinear));

	chain.parallelDrive.gain.value = mapGainToDrive(gain);
	chain.dryGain.gain.value = 1;
	chain.wetMix.gain.value = clamp01(settings.volume) * fader;

	const lim = chain.parallelLimiter;
	lim.attack.value = preset.attack;
	lim.release.value = preset.release + gain * 0.06;
	lim.knee.value = preset.knee;
	lim.ratio.value = preset.ratioBase + gain * 10;
	lim.threshold.value = preset.thresholdBase - gain * 10;

	const { dryMs, wetMs } = computePathDelays({ ...settings, preset: presetId });
	setDelayMs(chain.dryDelay, ctx, dryMs);
	setDelayMs(chain.wetDelay, ctx, wetMs);
}

/** When gate sits after parallel bus: align to dry/wet path + limiter attack. */
export function getParallelBusAlignLatencySec(settings: ParallelLimiterSettings): number {
	const presetId = isParallelLimiterPresetId(settings.preset)
		? settings.preset
		: BAKED_VOICE_PARALLEL_LIMITER.preset;
	const preset = PARALLEL_LIMITER_PRESETS[presetId];
	const { dryMs, wetMs } = computePathDelays({ ...settings, preset: presetId });
	return Math.max(dryMs, wetMs) / 1000 + preset.attack;
}
