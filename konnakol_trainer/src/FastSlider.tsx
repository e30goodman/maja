import React, { useCallback, useEffect, useState, type ReactNode } from 'react';

function clampInt(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.round(n)));
}

type FastSliderNativeProps = {
	variant: 'native';
	min: number;
	max: number;
	step?: number;
	value: number;
	onCommit: (next: number) => void;
	onLiveChange?: (next: number) => void;
	className?: string;
	rangeClassName?: string;
	'aria-label'?: string;
	disabled?: boolean;
	/** Доп. колонка справа (например крупная цифра черновика). */
	renderTrailing?: (local: number) => ReactNode;
};

type FastSliderTempoProps = {
	variant: 'tempoTrack';
	min: number;
	max: number;
	value: number;
	onCommit: (next: number) => void;
	onLiveChange?: (next: number) => void;
	/** Узкий трек в шапке (thumbHalf 24). */
	compact?: boolean;
	className?: string;
	disabled?: boolean;
};

export type FastSliderProps = FastSliderNativeProps | FastSliderTempoProps;

export function FastSlider(props: FastSliderProps) {
	const { min, max, value, onCommit, onLiveChange, disabled } = props;
	const [local, setLocal] = useState(() => clampInt(value, min, max));

	useEffect(() => {
		setLocal(clampInt(value, min, max));
	}, [value, min, max]);

	const commit = useCallback(
		(next: number) => {
			const v = clampInt(next, min, max);
			setLocal(v);
			onCommit(v);
		},
		[min, max, onCommit],
	);

	if (props.variant === 'native') {
		const { className, rangeClassName, step = 1, renderTrailing, 'aria-label': ariaLabel } = props;
		return (
			<div className={className ?? 'flex flex-1 items-center gap-2 min-w-0'}>
				<input
					type="range"
					min={min}
					max={max}
					step={step}
					disabled={disabled}
					aria-label={ariaLabel}
					value={local}
					onChange={(e) => {
						const n = clampInt(parseInt(e.target.value, 10), min, max);
						setLocal(n);
						onLiveChange?.(n);
					}}
					onPointerUp={(e) =>
						commit(clampInt(parseInt((e.currentTarget as HTMLInputElement).value, 10), min, max))
					}
					onPointerCancel={(e) =>
						commit(clampInt(parseInt((e.currentTarget as HTMLInputElement).value, 10), min, max))
					}
					onBlur={(e) =>
						commit(clampInt(parseInt((e.currentTarget as HTMLInputElement).value, 10), min, max))
					}
					className={
						rangeClassName ??
						'flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110'
					}
				/>
				{renderTrailing ? renderTrailing(local) : null}
			</div>
		);
	}

	// tempoTrack
	const thumbHalf = props.compact ? 24 : 24;
	const { className: trackClassName, compact } = props;

	const valueFromClientX = useCallback(
		(clientX: number, rect: DOMRect) => {
			const activeWidth = rect.width - thumbHalf * 2;
			const x = Math.max(0, Math.min(activeWidth, clientX - rect.left - thumbHalf));
			const span = max - min;
			const percent = x / Math.max(1, activeWidth);
			return clampInt(min + percent * span, min, max);
		},
		[min, max, thumbHalf],
	);

	const span = Math.max(1e-6, max - min);
	const fillFrac = (local - min) / span;
	const thumbPosStyle = {
		left: `calc(${thumbHalf}px + (100% - ${thumbHalf * 2}px) * ${fillFrac})`,
	} as const;
	const fillWidthStyle = {
		width: `calc(${thumbHalf}px + (100% - ${thumbHalf * 2}px) * ${fillFrac})`,
	} as const;

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (disabled) return;
		const el = e.currentTarget;
		el.setPointerCapture(e.pointerId);
		const rect = el.getBoundingClientRect();
		let lastVal = valueFromClientX(e.clientX, rect);
		setLocal(lastVal);
		onLiveChange?.(lastVal);

		const onMove = (moveEvt: PointerEvent) => {
			lastVal = valueFromClientX(moveEvt.clientX, rect);
			setLocal(lastVal);
			onLiveChange?.(lastVal);
		};
		const onUp = () => {
			el.removeEventListener('pointermove', onMove);
			el.removeEventListener('pointerup', onUp);
			el.removeEventListener('pointercancel', onUp);
			try {
				if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
			} catch {
				/* */
			}
			commit(lastVal);
		};
		el.addEventListener('pointermove', onMove);
		el.addEventListener('pointerup', onUp);
		el.addEventListener('pointercancel', onUp);
	};

	return (
		<div
			className={
				trackClassName ??
				`flex-1 relative flex items-center ${compact ? 'h-8 min-w-0' : 'h-8'} cursor-pointer touch-none`
			}
			onPointerDown={onPointerDown}
		>
			<div className="absolute w-full h-1.5 bg-[#0b101e] rounded-full overflow-hidden">
				<div className="h-full bg-[#364976]" style={fillWidthStyle} />
			</div>
			<div
				className="absolute z-10 bg-[#23314f] border border-[#2f4066] px-3 w-12 text-center py-1 rounded-full text-sm font-bold shadow-md -translate-x-1/2 flex items-center justify-center select-none pointer-events-none"
				style={thumbPosStyle}
			>
				{local}
			</div>
		</div>
	);
}
