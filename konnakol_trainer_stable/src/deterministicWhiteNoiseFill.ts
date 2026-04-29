/**
 * Stable "white" noise for Web Audio buffers: same timbre across sessions
 * and `AudioContext` recreations (unlike `Math.random()`).
 * Does not affect grid/bar randomization - only audio-buffer filling.
 */

export const SHARED_AUDIO_NOISE_SEED = 0x2f6b9a3e;

/**
 * Fills ch with values in ~[-1, 1] using a deterministic PRNG (mulberry32-style step).
 * Same `ch.length` + `seed` → bit-identical output across runtimes and browsers.
 */
export function fillChannelDeterministicWhiteNoise(
	ch: Float32Array,
	seed: number = SHARED_AUDIO_NOISE_SEED,
): void {
	let a = seed | 0;
	for (let i = 0; i < ch.length; i++) {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = t + Math.imul(t ^ (t + 0x7), 61 | t) ^ t;
		ch[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
	}
}
