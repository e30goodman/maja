import { ParallelLimiterKnob } from './parallelLimiterKnob';
import {
	CALIBRATION_ENVELOPE_ATTACK_MS_MAX,
	CALIBRATION_ENVELOPE_DECAY_MS_MAX,
	CALIBRATION_ENVELOPE_GAIN_MAX,
	CALIBRATION_VOICE_LABELS,
	CALIBRATION_VOICE_ORDER,
	CLICK_TAIL_ENVELOPE_SHAPE_ORDER,
	type CalibrationVoiceKey,
	type SoundPresetCalibrationId,
	SOUND_PRESET_CALIBRATION_ORDER,
	type VoiceCalibrationSlice,
} from './soundPresetCalibration';
import { PARALLEL_LIMITER_PRESET_LABELS } from './parallelBusChain';
import type { ClickTailEnvelopeShapeId } from './clickTailEnvelope';
import {
	CLICK_ATTACK_FADE_SHAPE_LABELS,
	CLICK_TAIL_ENVELOPE_SHAPE_LABELS,
} from './clickTailEnvelope';
import type { ParallelLimiterSettings } from './parallelBusChain';

type SoundPresetCalibrationPanelProps = {
	editPreset: SoundPresetCalibrationId;
	editVoice: CalibrationVoiceKey;
	slice: VoiceCalibrationSlice;
	onPresetChange: (preset: SoundPresetCalibrationId) => void;
	onVoiceChange: (voice: CalibrationVoiceKey) => void;
	onPatch: (patch: Partial<VoiceCalibrationSlice>) => void;
	onPatchParallel: (patch: Partial<ParallelLimiterSettings>) => void;
	onCycleParallelPreset: () => void;
	onCycleAttackShape: () => void;
	onCycleDecayShape: () => void;
	onResetSlice: () => void;
	onResetEnvelopeNative: () => void;
};

export function SoundPresetCalibrationPanel({
	editPreset,
	editVoice,
	slice,
	onPresetChange,
	onVoiceChange,
	onPatch,
	onPatchParallel,
	onCycleParallelPreset,
	onCycleAttackShape,
	onCycleDecayShape,
	onResetSlice,
	onResetEnvelopeNative,
}: SoundPresetCalibrationPanelProps) {
	return (
		<aside
			className="hidden sm:flex max-h-[min(844px,100dvh)] w-[220px] shrink-0 flex-col gap-2.5 overflow-y-auto rounded-2xl border border-[#23314f] bg-[#0f1524] p-3 self-center"
			aria-label="Sound preset calibration"
		>
			<div className="text-center shrink-0">
				<p className="text-[10px] font-bold uppercase tracking-[0.16em] text-violet-400/90">Calibration</p>
				<p className="mt-0.5 text-[10px] text-slate-500">parallel + envelope</p>
			</div>

			<div className="shrink-0">
				<p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Preset</p>
				<div className="flex flex-wrap gap-1">
					{SOUND_PRESET_CALIBRATION_ORDER.map((preset) => (
						<button
							key={preset}
							type="button"
							onClick={() => onPresetChange(preset)}
							className={`rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide transition-colors ${
								editPreset === preset
									? 'bg-violet-500/25 text-violet-200 ring-1 ring-violet-400/50'
									: 'bg-[#161f33] text-slate-500 hover:text-slate-300'
							}`}
						>
							{preset.replace(/_/g, ' ')}
						</button>
					))}
				</div>
			</div>

			<div className="shrink-0">
				<p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Layer</p>
				<div className="flex flex-col gap-1">
					{CALIBRATION_VOICE_ORDER.map((voice) => (
						<button
							key={voice}
							type="button"
							onClick={() => onVoiceChange(voice)}
							className={`rounded-lg px-2 py-1.5 text-[10px] font-semibold transition-colors ${
								editVoice === voice
									? 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/45'
									: 'bg-[#161f33] text-slate-500 hover:text-slate-300'
							}`}
						>
							{CALIBRATION_VOICE_LABELS[voice]}
						</button>
					))}
				</div>
			</div>

			<div className="shrink-0 border-t border-[#23314f]/80 pt-2">
				<p className="mb-2 text-center text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">
					Parallel
				</p>
				<div className="grid grid-cols-2 gap-x-1 gap-y-2 justify-items-center">
					<ParallelLimiterKnob
						label="Gain"
						value={slice.parallel.gain}
						onChange={(gain) => onPatchParallel({ gain })}
						accentClass="bg-amber-400"
					/>
					<ParallelLimiterKnob
						label="Wet"
						value={slice.parallel.volume}
						onChange={(volume) => onPatchParallel({ volume })}
						accentClass="bg-sky-400"
					/>
					<ParallelLimiterKnob
						label="LA"
						value={slice.parallel.lookAheadMs}
						min={0}
						max={12}
						sensitivity={90}
						onChange={(lookAheadMs) => onPatchParallel({ lookAheadMs })}
						accentClass="bg-violet-400"
						formatValue={(v) => `${v.toFixed(1)} ms`}
					/>
					<ParallelLimiterKnob
						label="Phase"
						value={slice.parallel.phaseAlignMs}
						min={-12}
						max={12}
						sensitivity={90}
						onChange={(phaseAlignMs) => onPatchParallel({ phaseAlignMs })}
						accentClass="bg-emerald-400"
						formatValue={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} ms`}
					/>
				</div>
				<button
					type="button"
					className="mt-2 w-full rounded-lg border border-[#2f4066] bg-[#161f33] px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-300 hover:bg-[#1b253b]"
					onClick={onCycleParallelPreset}
				>
					{PARALLEL_LIMITER_PRESET_LABELS[slice.parallel.preset]}
				</button>
			</div>

			<div className="shrink-0 border-t border-[#23314f]/80 pt-2">
				<p className="mb-2 text-center text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">
					Envelope
				</p>
				<div className="mb-2 grid grid-cols-2 gap-x-1 justify-items-center">
					<ParallelLimiterKnob
						label="Mix"
						value={slice.envelopeMix}
						onChange={(envelopeMix) => onPatch({ envelopeMix })}
						accentClass="bg-violet-400"
						formatValue={(v) => `${Math.round(v * 100)}%`}
					/>
					<ParallelLimiterKnob
						label="Out"
						value={slice.envelopeGain}
						min={0}
						max={CALIBRATION_ENVELOPE_GAIN_MAX}
						onChange={(envelopeGain) => onPatch({ envelopeGain })}
						accentClass="bg-emerald-400"
						formatValue={(v) => `${Math.round(v * 100)}%`}
					/>
				</div>
				<p className="mb-2 text-center text-[9px] leading-snug text-slate-600">
					Mix: натив ↔ gate · Out: громкость gate-выхода
				</p>
				<div className="grid grid-cols-2 gap-x-1 gap-y-2 justify-items-center">
					<ParallelLimiterKnob
						label="Fade in"
						value={slice.attackMs}
						min={0}
						max={CALIBRATION_ENVELOPE_ATTACK_MS_MAX}
						sensitivity={50}
						onChange={(attackMs) => onPatch({ attackMs })}
						accentClass="bg-amber-400"
						formatValue={(v) => `${v.toFixed(1)} ms`}
					/>
					<ParallelLimiterKnob
						label="Decay"
						value={slice.decayMs}
						min={1}
						max={CALIBRATION_ENVELOPE_DECAY_MS_MAX}
						sensitivity={55}
						onChange={(decayMs) => onPatch({ decayMs })}
						accentClass="bg-sky-400"
						formatValue={(v) => `${v.toFixed(1)} ms`}
					/>
				</div>
				<div className="mt-2 flex flex-col gap-1">
					<button
						type="button"
						className="w-full rounded-lg border border-[#2f4066] bg-[#161f33] px-2 py-1.5 text-[10px] font-semibold text-slate-300 hover:bg-[#1b253b]"
						onClick={onCycleAttackShape}
					>
						Fade-in · {attackFadeLabel(slice.attackShape)}
					</button>
					<button
						type="button"
						className="w-full rounded-lg border border-[#2f4066] bg-[#161f33] px-2 py-1.5 text-[10px] font-semibold text-slate-300 hover:bg-[#1b253b]"
						onClick={onCycleDecayShape}
					>
						Decay · {decayShapeLabel(slice.decayShape)}
					</button>
					<button
						type="button"
						className="w-full rounded-lg border border-emerald-900/50 bg-emerald-950/30 px-2 py-1.5 text-[10px] font-semibold text-emerald-300/90 hover:bg-emerald-950/50"
						onClick={onResetEnvelopeNative}
					>
						Envelope → native
					</button>
				</div>
			</div>

			<p className="shrink-0 text-center text-[9px] leading-snug text-slate-600">
				Автосохранение · {editPreset} / {CALIBRATION_VOICE_LABELS[editVoice]}
			</p>
			<button
				type="button"
				className="shrink-0 text-[10px] text-slate-600 underline-offset-2 hover:text-slate-400 hover:underline"
				onClick={onResetSlice}
			>
				Сброс слоя к baked
			</button>
		</aside>
	);
}

function attackFadeLabel(shape: ClickTailEnvelopeShapeId): string {
	return CLICK_ATTACK_FADE_SHAPE_LABELS[shape];
}

function decayShapeLabel(shape: ClickTailEnvelopeShapeId): string {
	return CLICK_TAIL_ENVELOPE_SHAPE_LABELS[shape];
}
