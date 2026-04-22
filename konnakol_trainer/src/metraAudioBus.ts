/**
 * METRA-style master path: linear sum of all metronome layers → soft limiter → destination.
 * One chain per AudioContext (WeakMap); safe when context is closed/GC’d.
 */

const masterBusByContext = new WeakMap<
	AudioContext,
	{ summing: GainNode; compressor: DynamicsCompressorNode }
>();

export const METRA_LOOKAHEAD_MS = 25;
export const METRA_SCHEDULE_AHEAD_SEC = 0.1;

/** Input node: connect all layer tails here (linear sum). */
export function getMetronomeSummingInput(ctx: AudioContext): GainNode {
	let entry = masterBusByContext.get(ctx);
	if (!entry) {
		const summing = ctx.createGain();
		summing.gain.value = 1;
		const compressor = ctx.createDynamicsCompressor();
		compressor.threshold.value = -1;
		compressor.ratio.value = 20;
		compressor.attack.value = 0.003;
		compressor.release.value = 0.1;
		compressor.knee.value = 0;
		summing.connect(compressor);
		compressor.connect(ctx.destination);
		entry = { summing, compressor };
		masterBusByContext.set(ctx, entry);
	}
	return entry.summing;
}
