import { useCallback, useRef } from 'react';

type ParallelLimiterKnobProps = {
	label: string;
	value: number;
	onChange: (value: number) => void;
	accentClass?: string;
	min?: number;
	max?: number;
	sensitivity?: number;
	formatValue?: (value: number) => string;
};

export function ParallelLimiterKnob({
	label,
	value,
	onChange,
	accentClass = 'bg-amber-400',
	min = 0,
	max = 1,
	sensitivity = 140,
	formatValue,
}: ParallelLimiterKnobProps) {
	const dragRef = useRef<{ startY: number; startValue: number } | null>(null);
	const span = max - min;
	const clamped = Math.max(min, Math.min(max, value));
	const normalized = span > 0 ? (clamped - min) / span : 0;
	const angle = -135 + normalized * 270;

	const setFromPointer = useCallback(
		(clientY: number) => {
			if (!dragRef.current) return;
			const delta = (dragRef.current.startY - clientY) / sensitivity;
			onChange(Math.max(min, Math.min(max, dragRef.current.startValue + delta * span)));
		},
		[min, max, onChange, sensitivity, span],
	);

	const step = span <= 1 ? 0.02 : span <= 15 ? 0.1 : 0.25;
	const display =
		formatValue?.(clamped) ??
		(span <= 1 ? `${Math.round(normalized * 100)}%` : `${clamped.toFixed(1)}`);

	return (
		<div className="flex flex-col items-center gap-1.5 select-none touch-none">
			<div
				role="slider"
				aria-label={label}
				aria-valuemin={min}
				aria-valuemax={max}
				aria-valuenow={clamped}
				tabIndex={0}
				className="relative h-14 w-14 cursor-ns-resize rounded-full border-2 border-[#2f4066] bg-[#161f33] shadow-[inset_0_2px_10px_rgba(0,0,0,0.45)]"
				onPointerDown={(e) => {
					e.currentTarget.setPointerCapture(e.pointerId);
					dragRef.current = { startY: e.clientY, startValue: clamped };
				}}
				onPointerMove={(e) => {
					if (!dragRef.current) return;
					setFromPointer(e.clientY);
				}}
				onPointerUp={(e) => {
					dragRef.current = null;
					e.currentTarget.releasePointerCapture(e.pointerId);
				}}
				onPointerCancel={() => {
					dragRef.current = null;
				}}
				onKeyDown={(e) => {
					if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
						e.preventDefault();
						onChange(Math.min(max, clamped + step));
					}
					if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
						e.preventDefault();
						onChange(Math.max(min, clamped - step));
					}
				}}
			>
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
					<div
						className={`h-4 w-1 rounded-full ${accentClass}`}
						style={{ transform: `rotate(${angle}deg) translateY(-12px)` }}
					/>
				</div>
			</div>
			<span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">{label}</span>
			<span className="text-[10px] tabular-nums text-slate-400">{display}</span>
		</div>
	);
}
