import React, { useCallback, useEffect, useRef, useState } from 'react';

function clampInt(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.round(n)));
}

export type CommittedSliderProps = Omit<
	React.ComponentProps<'input'>,
	'type' | 'value' | 'defaultValue' | 'onChange' | 'onInput' | 'min' | 'max' | 'step'
> & {
	value: number;
	min: number;
	max: number;
	step?: number;
	onCommit: (next: number) => void;
	/** true при pointerdown до завершения жеста (window pointerup/cancel). */
	onDragState?: (dragging: boolean) => void;
	/** Черновик для подписи рядом; null после commit. */
	onDraftChange?: (draft: number | null) => void;
};

/**
 * Нативный range: во время жеста меняется только локальный draft;
 * родительский стейт — только в onCommit (window pointerup/cancel + pointerup на элементе).
 */
export function CommittedSlider({
	value,
	min,
	max,
	step = 1,
	onCommit,
	onDragState,
	onDraftChange,
	onPointerDown: onPointerDownProp,
	...rest
}: CommittedSliderProps) {
	const [draft, setDraft] = useState(value);
	const draftRef = useRef(value);
	const draggingRef = useRef(false);

	useEffect(() => {
		if (!draggingRef.current) {
			setDraft(value);
			draftRef.current = value;
		}
	}, [value]);

	const endDrag = useCallback(() => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		window.removeEventListener('pointerup', endDrag, true);
		window.removeEventListener('pointercancel', endDrag, true);
		const next = clampInt(draftRef.current, min, max);
		onCommit(next);
		onDragState?.(false);
		onDraftChange?.(null);
	}, [min, max, onCommit, onDragState, onDraftChange]);

	const startDrag = useCallback(() => {
		if (draggingRef.current) return;
		draggingRef.current = true;
		const v = clampInt(value, min, max);
		draftRef.current = v;
		setDraft(v);
		window.addEventListener('pointerup', endDrag, true);
		window.addEventListener('pointercancel', endDrag, true);
		onDragState?.(true);
		onDraftChange?.(draftRef.current);
	}, [value, min, max, endDrag, onDragState, onDraftChange]);

	return (
		<input
			type="range"
			{...rest}
			min={min}
			max={max}
			step={step}
			value={draft}
			onPointerDown={(e) => {
				startDrag();
				onPointerDownProp?.(e);
			}}
			onInput={(e) => {
				const v = clampInt(parseInt((e.target as HTMLInputElement).value, 10), min, max);
				draftRef.current = v;
				setDraft(v);
				onDraftChange?.(v);
			}}
			onPointerUp={() => {
				endDrag();
			}}
			onPointerCancel={() => {
				endDrag();
			}}
			onBlur={() => {
				endDrag();
			}}
		/>
	);
}

const TEMPO_MIN = 20;
const TEMPO_MAX = 400;

function clientXToTempo(clientX: number, rect: DOMRect): number {
	const thumbHalf = 24;
	const activeWidth = rect.width - thumbHalf * 2;
	const x = Math.max(0, Math.min(activeWidth, clientX - rect.left - thumbHalf));
	const percent = x / Math.max(1, activeWidth);
	return clampInt(TEMPO_MIN + percent * (TEMPO_MAX - TEMPO_MIN), TEMPO_MIN, TEMPO_MAX);
}

export type TempoTrackSliderProps = {
	committedTempo: number;
	onTempoLive: (t: number) => void;
	onCommit: (t: number) => void;
	className?: string;
	thumbClassName?: string;
	trackClassName?: string;
};

/**
 * Кастомный трек темпа: draft для thumb/цифры; onTempoLive на каждом move; onCommit по окончании жеста.
 */
export function TempoTrackSlider({
	committedTempo,
	onTempoLive,
	onCommit,
	className,
	thumbClassName,
	trackClassName,
}: TempoTrackSliderProps) {
	const [draft, setDraft] = useState(committedTempo);
	const draggingRef = useRef(false);
	const lastTRef = useRef(committedTempo);
	const onTempoLiveRef = useRef(onTempoLive);
	const onCommitRef = useRef(onCommit);
	onTempoLiveRef.current = onTempoLive;
	onCommitRef.current = onCommit;

	const winUpRef = useRef<(() => void) | null>(null);
	const pointerSessionRef = useRef<{
		el: HTMLDivElement;
		pointerId: number;
		onMove: (ev: PointerEvent) => void;
		onElUp: () => void;
	} | null>(null);

	useEffect(() => {
		if (!draggingRef.current) {
			setDraft(committedTempo);
			lastTRef.current = committedTempo;
		}
	}, [committedTempo]);

	const finishDrag = useCallback(() => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		const sess = pointerSessionRef.current;
		pointerSessionRef.current = null;
		if (sess) {
			sess.el.removeEventListener('pointermove', sess.onMove);
			sess.el.removeEventListener('pointerup', sess.onElUp);
			try {
				if (sess.el.hasPointerCapture(sess.pointerId)) sess.el.releasePointerCapture(sess.pointerId);
			} catch {
				/* */
			}
		}
		if (winUpRef.current) {
			window.removeEventListener('pointerup', winUpRef.current, true);
			window.removeEventListener('pointercancel', winUpRef.current, true);
			winUpRef.current = null;
		}
		const t = lastTRef.current;
		onTempoLiveRef.current(t);
		onCommitRef.current(t);
	}, []);

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		const el = e.currentTarget;
		if (draggingRef.current) return;
		draggingRef.current = true;
		el.setPointerCapture(e.pointerId);
		const rect = el.getBoundingClientRect();
		const apply = (clientX: number) => {
			const t = clientXToTempo(clientX, rect);
			lastTRef.current = t;
			onTempoLiveRef.current(t);
			setDraft(t);
		};
		apply(e.clientX);
		const onMove = (moveEvt: PointerEvent) => {
			apply(moveEvt.clientX);
		};
		const onElUp = () => {
			finishDrag();
		};
		const winUp = () => finishDrag();
		winUpRef.current = winUp;
		window.addEventListener('pointerup', winUp, true);
		window.addEventListener('pointercancel', winUp, true);
		pointerSessionRef.current = { el, pointerId: e.pointerId, onMove, onElUp };
		el.addEventListener('pointermove', onMove);
		el.addEventListener('pointerup', onElUp);
	};

	return (
		<div className={className} onPointerDown={onPointerDown}>
			<div
				className={
					trackClassName ??
					'absolute w-full h-1.5 bg-[#0b101e] rounded-full overflow-hidden'
				}
			>
				<div
					className="h-full bg-[#364976]"
					style={{
						width: `calc(24px + ${((draft - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN))} * calc(100% - 48px))`,
					}}
				/>
			</div>
			<div
				className={
					thumbClassName ??
					'absolute z-10 bg-[#23314f] border border-[#2f4066] px-3 w-12 text-center py-1 rounded-full text-sm font-bold shadow-md -translate-x-1/2 flex items-center justify-center select-none'
				}
				style={{
					left: `calc(24px + ${((draft - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN))} * calc(100% - 48px))`,
				}}
			>
				{draft}
			</div>
		</div>
	);
}
