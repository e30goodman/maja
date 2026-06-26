/**
 * Cajon accent Ta only: envelope gate after shared parallel sum (per-hit tap gain).
 */

import {
	schedulePassiveClickGateEnvelope,
	type ClickTailEnvelopeShapeId,
} from './clickTailEnvelope';
import { scheduleLayerToBus, type MetroLayerGraphConfig } from './metroLayerGraph';
import { getParallelBusAlignLatencySec } from './parallelBusChain';
import { getVoiceLayerSumInput } from './metroSoundBus';
import { getTaAccentParallelSettings } from './taAccentParallel';

const PARALLEL_TAIL_PAD_SEC = 0.14;

function scheduleParallelSumTapDisconnect(
	ctx: AudioContext,
	parallelSum: GainNode,
	tap: GainNode,
	endTimeSec: number,
): void {
	const delayMs = Math.max(0, (endTimeSec - ctx.currentTime + PARALLEL_TAIL_PAD_SEC) * 1000);
	window.setTimeout(() => {
		try {
			parallelSum.disconnect(tap);
		} catch {
			/* already disconnected */
		}
		try {
			tap.disconnect();
		} catch {
			/* already disconnected */
		}
	}, delayMs);
}

function attachParallelSumUnityTap(
	ctx: AudioContext,
	parallelSum: GainNode,
	accent: AudioNode,
	endTimeSec: number,
): void {
	const tap = ctx.createGain();
	tap.gain.value = 1;
	parallelSum.connect(tap);
	tap.connect(accent);
	scheduleParallelSumTapDisconnect(ctx, parallelSum, tap, endTimeSec);
}

function attachParallelSumGateTap(
	ctx: AudioContext,
	parallelSum: GainNode,
	accent: AudioNode,
	scheduleTime: number,
	outGain: number,
	tailGateMs: number,
	tailShape: ClickTailEnvelopeShapeId,
	frontGateMs: number,
	frontShape: ClickTailEnvelopeShapeId,
): void {
	const tap = ctx.createGain();
	parallelSum.connect(tap);
	tap.connect(accent);
	const parallelLatencySec = getParallelBusAlignLatencySec(getTaAccentParallelSettings('cajon'));
	const gateT0 = scheduleTime + parallelLatencySec;
	const endTimeSec = schedulePassiveClickGateEnvelope(
		tap,
		ctx,
		gateT0,
		outGain,
		tailGateMs,
		tailShape,
		frontGateMs,
		frontShape,
	);
	scheduleParallelSumTapDisconnect(ctx, parallelSum, tap, endTimeSec);
}

/**
 * Cajon Ta: dry = native → accent (bypass parallel). Wet = native → parallel → gate tap → accent.
 */
export function scheduleCajonTaAccentLayerToBus(
	ctx: AudioContext,
	scheduleTime: number,
	layer: MetroLayerGraphConfig,
	peakLinear: number,
	decaySec: number,
	parallelIn: GainNode,
	parallelSum: GainNode,
	tailGateMs: number | undefined,
	tailShape: ClickTailEnvelopeShapeId,
	frontGateMs: number,
	frontShape: ClickTailEnvelopeShapeId,
	envelopeMix: number,
	envelopeGain: number,
): void {
	const mix = Math.max(0, Math.min(1, envelopeMix));
	const outGain = Math.max(0, Math.min(2, envelopeGain));
	const hasGate = typeof tailGateMs === 'number' && Number.isFinite(tailGateMs);
	const accent = getVoiceLayerSumInput(ctx, 'accent');
	const nativeEnd = scheduleTime + decaySec + 0.06;

	if (!hasGate || mix <= 0) {
		scheduleLayerToBus(ctx, scheduleTime, layer, peakLinear, decaySec, parallelIn);
		attachParallelSumUnityTap(ctx, parallelSum, accent, nativeEnd);
		return;
	}

	if (mix >= 1) {
		scheduleLayerToBus(ctx, scheduleTime, layer, peakLinear, decaySec, parallelIn);
		attachParallelSumGateTap(
			ctx,
			parallelSum,
			accent,
			scheduleTime,
			outGain,
			tailGateMs,
			tailShape,
			frontGateMs,
			frontShape,
		);
		return;
	}

	const dry = 1 - mix;
	const wet = mix;
	if (dry > 0) {
		scheduleLayerToBus(ctx, scheduleTime, layer, peakLinear * dry, decaySec, accent);
	}
	if (wet > 0) {
		scheduleLayerToBus(ctx, scheduleTime, layer, peakLinear * wet, decaySec, parallelIn);
		attachParallelSumGateTap(
			ctx,
			parallelSum,
			accent,
			scheduleTime,
			outGain,
			tailGateMs,
			tailShape,
			frontGateMs,
			frontShape,
		);
	}
}
