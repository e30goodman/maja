import React, { useMemo, useCallback, useRef } from 'react';
import { buildRowCellSyllableLabels, getSyllableStyles, type KalamMap } from './sequencerLabels';
import type { PlayheadPosition } from './playheadTypes';

/** Доступные поддоли для long-press: в свернутом UI только 2/3/4, в развернутом — 2..9. */
function allowedSubdivisions(panelExpanded: boolean): number[] {
	return panelExpanded ? [2, 3, 4, 5, 6, 7, 8, 9] : [2, 3, 4];
}

/** Следующее значение в цикле доступных поддолей. */
function nextSubdivLongPress(current: number, panelExpanded: boolean): number {
	const allowed = allowedSubdivisions(panelExpanded);
	const idx = allowed.indexOf(current);
	if (idx < 0) return allowed[0]!;
	return allowed[(idx + 1) % allowed.length]!;
}

/** Сдвиг поддоли на delta шагов в доступном цикле (для жеста вверх/вниз). */
function stepSubdivByDelta(base: number, delta: number, panelExpanded: boolean): number {
	const allowed = allowedSubdivisions(panelExpanded);
	const len = allowed.length;
	if (len === 0) return 2;
	const baseIdxRaw = allowed.indexOf(base);
	const baseIdx = baseIdxRaw >= 0 ? baseIdxRaw : 0;
	const idx = ((baseIdx + delta) % len + len) % len;
	return allowed[idx]!;
}

/** Poly play: голос 0 — emerald; 1 — sky; 2 — violet; 3+ — amber (отличие от первого). */
function playheadHighlightCellClasses(
	isDead: boolean,
	polyMode: boolean,
	isPlaying: boolean,
	polyVoiceIdx: number,
	lowPerfMode: boolean,
): string {
	if (isDead) {
		return lowPerfMode
			? 'bg-slate-700/35 border-2 box-border border-slate-500/70 z-10 text-slate-400'
			: 'bg-slate-700/40 border-2 box-border border-slate-500/80 shadow-[0_0_10px_rgba(100,116,139,0.22)] z-10 text-slate-300';
	}
	const polyActive = polyMode && isPlaying;
	if (!polyActive || polyVoiceIdx === 0) {
		return lowPerfMode
			? 'bg-emerald-500/20 border-2 box-border border-emerald-500 z-10 text-emerald-100'
			: 'bg-emerald-500/20 border-2 box-border border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)] z-10 text-emerald-100';
	}
	if (polyVoiceIdx === 1) {
		return lowPerfMode
			? 'bg-sky-500/20 border-2 box-border border-sky-400 z-10 text-sky-100'
			: 'bg-sky-500/20 border-2 box-border border-sky-400 shadow-[0_0_15px_rgba(56,189,248,0.28)] z-10 text-sky-100';
	}
	if (polyVoiceIdx === 2) {
		return lowPerfMode
			? 'bg-violet-500/20 border-2 box-border border-violet-400 z-10 text-violet-100'
			: 'bg-violet-500/20 border-2 box-border border-violet-400 shadow-[0_0_15px_rgba(167,139,250,0.28)] z-10 text-violet-100';
	}
	return lowPerfMode
		? 'bg-amber-500/20 border-2 box-border border-amber-400 z-10 text-amber-100'
		: 'bg-amber-500/20 border-2 box-border border-amber-400 shadow-[0_0_15px_rgba(251,191,36,0.26)] z-10 text-amber-100';
}

function rowCellLabelsEqual(a: string[][], b: string[][]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const ra = a[i];
		const rb = b[i];
		if (ra === rb) continue;
		if (!ra || !rb || ra.length !== rb.length) return false;
		for (let j = 0; j < ra.length; j++) {
			if (ra[j] !== rb[j]) return false;
		}
	}
	return true;
}

function useStableRowCellLabelsCache(
	bars: number,
	syllables: number,
	customSyllables: Record<number, number>,
	customSubdivisions: Record<string, number>,
	deadStartByRow: Record<number, number>,
	bpm: number,
): string[][][] {
	const prevRef = useRef<string[][][]>([]);
	const kalamMapRef = useRef<KalamMap>(new Map());
	return useMemo(() => {
		const prev = prevRef.current;
		const next: string[][][] = [];
		const touched = new Set<string>();
		for (let r = 0; r < bars; r++) {
			const rowSylls = customSyllables[r] !== undefined ? customSyllables[r] : syllables;
			const built = buildRowCellSyllableLabels(rowSylls, customSubdivisions, r, {
				bpm,
				deadStart: deadStartByRow[r],
				kalamMap: kalamMapRef.current,
				touchedKeys: touched,
			});
			const oldRow = prev[r];
			if (oldRow !== undefined && rowCellLabelsEqual(oldRow, built)) {
				next[r] = oldRow;
			} else {
				next[r] = built;
			}
		}
		/** GC: удаляем hysteresis-ключи сегментов/клеток, которых больше нет в сетке. */
		const km = kalamMapRef.current;
		const stale: string[] = [];
		km.forEach((_, key) => {
			if (!touched.has(key)) stale.push(key);
		});
		for (const key of stale) km.delete(key);
		prevRef.current = next;
		return next;
	}, [bars, syllables, customSyllables, customSubdivisions, deadStartByRow, bpm]);
}

/** Ref-filled each App render — stable identity for memoized grid row. */
export type SequencerGridRowActions = {
	isHoldingRef: React.MutableRefObject<boolean>;
	holdTimerRef: React.MutableRefObject<number | null>;
	pulseUnlinkHoldTimerRef: React.MutableRefObject<number | null>;
	/** true только после long-press unlink на кнопке пульса — подавить один click, не глотать клик после long-press клетки. */
	pulseUnlinkJustFiredRef: React.MutableRefObject<boolean>;
	deadSwipeSessionRef: React.MutableRefObject<{
		row: number;
		startCell: number;
		triggered: boolean;
		fromCenter: boolean;
		restoreMode: boolean;
		startX: number;
		startY: number;
		rect: { left: number; right: number; top: number; bottom: number };
	} | null>;
	deadCellsRef: React.MutableRefObject<Record<number, { deadStart: number; displayLen: number; baseLen: number }>>;
	isPanelExpandedRef: React.MutableRefObject<boolean>;
	showRandomSettingsRef: React.MutableRefObject<boolean>;
	syllables: number;
	setActiveEditRow: React.Dispatch<React.SetStateAction<number | null>>;
	setActiveEditCell: React.Dispatch<React.SetStateAction<string | null>>;
	setIsPanelExpanded: React.Dispatch<React.SetStateAction<boolean>>;
	setCustomMultipliers: React.Dispatch<React.SetStateAction<Record<number, number>>>;
	setCustomSubdivisions: React.Dispatch<React.SetStateAction<Record<string, number>>>;
	setCustomSyllables: React.Dispatch<React.SetStateAction<Record<number, number>>>;
	setPulseMeterUnlinked: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
	triggerDeadCut: (r: number, deadStart: number) => void;
	restoreDeadRow: (r: number) => void;
	toggleAccent: (r: number, c: number) => void;
	toggleTaDing: (r: number, c: number) => void;
	customSyllablesRef: React.MutableRefObject<Record<number, number>>;
	customMultipliersRef: React.MutableRefObject<Record<number, number>>;
	pulseMeterUnlinkedRef: React.MutableRefObject<Record<number, boolean>>;
	subdivHoldSessionRef: React.MutableRefObject<{
		key: string;
		startY: number;
		baseSubdiv: number;
		lastDeltaSteps: number;
		panelExpanded: boolean;
	} | null>;
};

type SequencerGridRowProps = {
	absR: number;
	rIdx: number;
	stepLabel?: string;
	voiceLabel?: string;
	isPolyRow?: boolean;
	polyMode: boolean;
	polyVoices: 2 | 3 | 4;
	rowSylls: number;
	rowMult: number;
	subdivSig: string;
	accentSig: string;
	taDingSig: string;
	pulseUnlinkedRow: boolean;
	activeEditRow: number | null;
	activeEditCell: string | null;
	highlightCol: number | null;
	isPlaying: boolean;
	isTaEditorMode: boolean;
	isDeadCellsEditorMode: boolean;
	accentMapVersion: number;
	firstBeatAccent: boolean;
	forceFirstBeatEditorFrames: boolean;
	/** Сортированные r через запятую: снятые в редакторе дефолтные белые на первой доле. */
	firstBeatEditorSuppressedSig: string;
	deadStartByRow: Record<number, number>;
	deadDisplayByRow: Record<number, number>;
	rowCellLabels: string[][];
	effectiveUseFixedFlex: boolean;
	displayScaleBars: number;
	syllables: number;
	lowPerfMode: boolean;
	/** В плоском poly: визуальный разрыв между шагами (не влияет на аудио). */
	polyStepTopRule?: boolean;
	actionsRef: React.MutableRefObject<SequencerGridRowActions | null>;
	setRowEl: (absR: number, el: HTMLDivElement | null) => void;
};

function sequencerGridRowPropsEqual(a: SequencerGridRowProps, b: SequencerGridRowProps) {
	return (
		a.absR === b.absR &&
		a.rIdx === b.rIdx &&
		a.stepLabel === b.stepLabel &&
		a.voiceLabel === b.voiceLabel &&
		a.isPolyRow === b.isPolyRow &&
		a.polyMode === b.polyMode &&
		a.polyVoices === b.polyVoices &&
		a.rowSylls === b.rowSylls &&
		a.rowMult === b.rowMult &&
		a.subdivSig === b.subdivSig &&
		a.accentSig === b.accentSig &&
		a.taDingSig === b.taDingSig &&
		a.pulseUnlinkedRow === b.pulseUnlinkedRow &&
		a.activeEditRow === b.activeEditRow &&
		a.activeEditCell === b.activeEditCell &&
		a.highlightCol === b.highlightCol &&
		a.isPlaying === b.isPlaying &&
		a.isTaEditorMode === b.isTaEditorMode &&
		a.isDeadCellsEditorMode === b.isDeadCellsEditorMode &&
		a.accentMapVersion === b.accentMapVersion &&
		a.firstBeatAccent === b.firstBeatAccent &&
		a.forceFirstBeatEditorFrames === b.forceFirstBeatEditorFrames &&
		a.firstBeatEditorSuppressedSig === b.firstBeatEditorSuppressedSig &&
		a.deadStartByRow === b.deadStartByRow &&
		a.deadDisplayByRow === b.deadDisplayByRow &&
		a.rowCellLabels === b.rowCellLabels &&
		a.effectiveUseFixedFlex === b.effectiveUseFixedFlex &&
		a.displayScaleBars === b.displayScaleBars &&
		a.syllables === b.syllables &&
		a.lowPerfMode === b.lowPerfMode &&
		(a.polyStepTopRule ?? false) === (b.polyStepTopRule ?? false) &&
		a.actionsRef === b.actionsRef &&
		a.setRowEl === b.setRowEl
	);
}

const SequencerGridRow = React.memo(
	function SequencerGridRow(p: SequencerGridRowProps) {
		const {
			absR,
			rIdx,
			stepLabel,
			voiceLabel,
			isPolyRow,
			polyMode,
			polyVoices,
			rowSylls,
			rowMult,
			subdivSig,
			accentSig,
			taDingSig,
			pulseUnlinkedRow,
			activeEditRow,
			activeEditCell,
			highlightCol,
			isPlaying,
			isTaEditorMode,
			isDeadCellsEditorMode,
			accentMapVersion,
			firstBeatAccent,
			forceFirstBeatEditorFrames,
			firstBeatEditorSuppressedSig,
			deadStartByRow,
			deadDisplayByRow,
			rowCellLabels,
			effectiveUseFixedFlex,
			displayScaleBars,
			syllables,
			lowPerfMode,
			polyStepTopRule = false,
			actionsRef,
			setRowEl,
		} = p;
		const rowSubdivs = useMemo(
			() => subdivSig.split(',').map((x) => parseInt(x, 10) || 1),
			[subdivSig],
		);
		const accentBits = accentSig;
		const taDingBits = taDingSig;
		const firstBeatRowSuppressed = useMemo(() => {
			if (!firstBeatEditorSuppressedSig) return new Set<number>();
			return new Set(
				firstBeatEditorSuppressedSig
					.split(',')
					.map((x) => parseInt(x, 10))
					.filter((n) => Number.isFinite(n)),
			);
		}, [firstBeatEditorSuppressedSig]);
		const polyVoiceIdx = polyMode ? rIdx % polyVoices : 0;
		return (
			<div
				ref={(el) => setRowEl(absR, el)}
				className={`flex items-stretch bg-[#161f33] border border-[#23314f] min-h-0 relative ${
					displayScaleBars > 7 ? 'gap-1 p-1 rounded-lg' : 'gap-2 p-1.5 rounded-xl'
				} ${isPolyRow ? 'border-l-4 border-l-blue-500/45' : ''} ${
					polyStepTopRule ? 'mt-1.5 border-t border-[#2a3d66]/90 pt-1.5' : ''
				} ${!effectiveUseFixedFlex ? 'flex-1' : ''}`}
				style={{
					flex: effectiveUseFixedFlex
						? `0 0 calc((100% - ${(displayScaleBars - 1) * 6}px) / ${displayScaleBars})`
						: undefined,
				}}
			>
				<div className={`flex flex-col gap-1 justify-center ${isPolyRow ? 'w-14' : 'w-8'} shrink-0`}>
					<button
						type="button"
						onClick={() => {
							const a = actionsRef.current;
							if (!a) return;
							a.setCustomMultipliers((prev) => {
								const m = prev[rIdx] || 1;
								const next = m === 1 ? 2 : m === 2 ? 3 : m === 3 ? 4 : 1;
								if (next === 1) {
									const copy = { ...prev };
									delete copy[rIdx];
									return copy;
								}
								return { ...prev, [rIdx]: next };
							});
						}}
						onContextMenu={(e) => {
							e.preventDefault();
							const a = actionsRef.current;
							if (!a) return;
							a.setCustomMultipliers((prev) => {
								const copy = { ...prev };
								delete copy[rIdx];
								return copy;
							});
						}}
						className={`relative flex-1 rounded-md border flex items-center justify-center text-[9px] font-bold min-h-[50%] transition-colors ${
							rowMult === 1
								? 'bg-[#1e2a45] border-[#2f4066] text-slate-300 hover:bg-[#253353] active:bg-[#1a253c]'
								: rowMult === 2
									? `bg-blue-900/40 border-blue-500/50 text-blue-300 ${lowPerfMode ? '' : 'shadow-[inset_0_1px_3px_rgba(59,130,246,0.1)]'}`
									: rowMult === 3
										? `bg-rose-900/40 border-rose-500/50 text-rose-300 ${lowPerfMode ? '' : 'shadow-[inset_0_1px_3px_rgba(244,63,94,0.1)]'}`
										: `bg-amber-900/40 border-amber-500/50 text-amber-200 ${lowPerfMode ? '' : 'shadow-[inset_0_1px_3px_rgba(245,158,11,0.12)]'}`
						}`}
					>
						{stepLabel ? (
							<span className="absolute top-[2px] left-[3px] text-[7.5px] text-blue-300/80 font-mono pointer-events-none leading-none uppercase">
								{stepLabel}
							</span>
						) : (
							<span className="absolute top-[2px] left-[3px] text-[7.5px] text-slate-500 font-mono pointer-events-none leading-none opacity-80">
								{rIdx + 1}
							</span>
						)}
						x{rowMult}
					</button>
					<button
						type="button"
						onMouseDown={(e) => {
							// Не даём кнопке забирать фокус при клике: в overflow-контейнере это
							// может вызывать резкий jump-scroll (особенно на нижних строках).
							e.preventDefault();
						}}
						onPointerDown={(e) => {
							const a = actionsRef.current;
							if (!a) return;
							a.pulseUnlinkJustFiredRef.current = false;
							a.isHoldingRef.current = false;
							if (a.pulseUnlinkHoldTimerRef.current) clearTimeout(a.pulseUnlinkHoldTimerRef.current);
							try {
								(e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
							} catch {
								/* duplicate capture */
							}
							a.pulseUnlinkHoldTimerRef.current = window.setTimeout(() => {
								a.pulseUnlinkJustFiredRef.current = true;
								a.isHoldingRef.current = true;
								a.setPulseMeterUnlinked((prev) => {
									const nextVal = !prev[rIdx];
									const next = { ...prev, [rIdx]: nextVal };
									a.pulseMeterUnlinkedRef.current = { ...next };
									/* Включаем отвязку пульсации от слогов такта → сбрасываем множитель скорости такта (x2…x4), иначе он остаётся в поли как визуально, так и в аудио. */
									if (nextVal) {
										a.setCustomMultipliers((pm) => {
											if (pm[rIdx] === undefined) return pm;
											const copy = { ...pm };
											delete copy[rIdx];
											a.customMultipliersRef.current = { ...copy };
											return copy;
										});
									}
									return next;
								});
								a.pulseUnlinkHoldTimerRef.current = null;
							}, 400);
						}}
						onPointerUp={(e) => {
							const a = actionsRef.current;
							if (!a) return;
							if (a.pulseUnlinkHoldTimerRef.current) {
								clearTimeout(a.pulseUnlinkHoldTimerRef.current);
								a.pulseUnlinkHoldTimerRef.current = null;
							}
							try {
								const el = e.currentTarget as HTMLButtonElement;
								if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
							} catch {
								/* */
							}
						}}
						onPointerLeave={(e) => {
							const a = actionsRef.current;
							if (!a) return;
							const el = e.currentTarget as HTMLButtonElement;
							if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(e.pointerId)) return;
							if (a.pulseUnlinkHoldTimerRef.current) {
								clearTimeout(a.pulseUnlinkHoldTimerRef.current);
								a.pulseUnlinkHoldTimerRef.current = null;
							}
						}}
						onPointerCancel={(e) => {
							const a = actionsRef.current;
							if (!a) return;
							if (a.pulseUnlinkHoldTimerRef.current) {
								clearTimeout(a.pulseUnlinkHoldTimerRef.current);
								a.pulseUnlinkHoldTimerRef.current = null;
							}
							try {
								const el = e.currentTarget as HTMLButtonElement;
								if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
							} catch {
								/* */
							}
						}}
						onClick={() => {
							const a = actionsRef.current;
							if (!a) return;
							if (a.isHoldingRef.current) {
								a.isHoldingRef.current = false;
								if (a.pulseUnlinkJustFiredRef.current) {
									a.pulseUnlinkJustFiredRef.current = false;
									return;
								}
								/* click пришёл без pointerdown на пульсе (capture с клетки): isHoldingRef от long-press сетки — цикл слогов всё равно. */
							}
							a.setCustomSyllables((prev) => {
								const current = prev[rIdx] !== undefined ? prev[rIdx] : a.syllables;
								const next = current >= 9 ? 1 : current + 1;
								const out = { ...prev, [rIdx]: next };
								a.customSyllablesRef.current = { ...out };
								return out;
							});
						}}
						onContextMenu={(e) => e.preventDefault()}
						className={`flex-1 rounded-md border flex items-center justify-center text-[12px] font-extrabold leading-none ${lowPerfMode ? '' : 'shadow-[inset_0_1px_3px_rgba(0,0,0,0.1)]'} min-h-[50%] transition-colors select-none ${
							activeEditRow === rIdx
								? `ring-2 ring-purple-500 ${lowPerfMode ? '' : 'shadow-purple-500/30'} bg-[#1e2a45] border-[#2f4066] text-slate-400`
								: pulseUnlinkedRow
									? `bg-teal-500/25 border-teal-400/70 text-teal-50 ring-1 ring-teal-400/80 ${lowPerfMode ? '' : 'shadow-[inset_0_1px_8px_rgba(20,184,166,0.25),0_0_12px_rgba(45,212,191,0.2)]'}`
									: 'bg-[#1e2a45] border-[#2f4066] text-slate-400 hover:bg-[#253353] active:bg-[#1e2a45]'
						}`}
					>
						{rowSylls}
					</button>
				</div>
				<div className="flex flex-1 gap-1 items-stretch min-w-0">
					{Array.from({ length: Math.max(rowSylls, deadDisplayByRow[rIdx] ?? rowSylls) }).map((_, cIdx) => {
						const checkKey = `${rIdx}-${cIdx}`;
						const deadStart = deadStartByRow[rIdx];
						const isDead = typeof deadStart === 'number' ? cIdx >= deadStart : cIdx >= rowSylls;
						const isAccent = accentBits[cIdx] === '1';
						const isTaDing = taDingBits[cIdx] === '1';
						/** В редакторе Ta: белый ding на первой доле при глобальном Ta, пока строка не в «снятых». */
						const showEditorDing =
							isTaDing ||
							(cIdx === 0 &&
								isTaEditorMode &&
								!firstBeatRowSuppressed.has(rIdx) &&
								(firstBeatAccent || forceFirstBeatEditorFrames));
						const showNonEditorDing =
							(!isDead && cIdx > 0 && isTaDing) ||
							(cIdx === 0 &&
								!isTaEditorMode &&
								forceFirstBeatEditorFrames &&
								!firstBeatRowSuppressed.has(rIdx));
						const isActive = highlightCol === cIdx;
						const subdivs = isDead ? 1 : (rowSubdivs[cIdx] ?? 1);
						const cellBorder2 = 'border-2 box-border border-[#2f4066]';
						const purpleAccentCell =
							`bg-purple-900/40 border-2 box-border border-purple-500/50 ${lowPerfMode ? '' : 'shadow-[inset_0_1px_4px_rgba(168,85,247,0.2)]'} hover:bg-purple-900/50 text-purple-100`;
						let cellClasses = `bg-[#1e2a45] ${cellBorder2} ${lowPerfMode ? '' : 'shadow-[0_2px_4px_rgba(0,0,0,0.2)]'} hover:bg-[#253353] text-slate-300`;
						if (isDead) {
							cellClasses = lowPerfMode
								? 'bg-slate-800/60 border-2 box-border border-slate-700 text-slate-500'
								: 'bg-slate-800/60 border-2 box-border border-slate-700 text-slate-500';
						} else if (isTaEditorMode) {
							if (isAccent && showEditorDing) {
								cellClasses = lowPerfMode
									? `${purpleAccentCell} z-[1] ring-2 ring-inset ring-white`
									: `${purpleAccentCell} z-[1] ring-2 ring-inset ring-white/95 shadow-[0_0_12px_rgba(255,255,255,0.18)]`;
							} else if (showEditorDing) {
								cellClasses = lowPerfMode
									? 'bg-[#1e2a45] border-2 box-border border-white text-white z-[1]'
									: 'bg-[#1e2a45] border-2 box-border border-white/95 text-white shadow-[0_0_14px_rgba(255,255,255,0.2)] z-[1] hover:bg-[#253353]';
							} else if (isAccent) {
								cellClasses = purpleAccentCell;
							}
						} else if (isAccent && showNonEditorDing) {
							cellClasses = lowPerfMode
								? `${purpleAccentCell} z-[1] ring-2 ring-inset ring-white`
								: `${purpleAccentCell} z-[1] ring-2 ring-inset ring-white/95 shadow-[0_0_12px_rgba(255,255,255,0.18)]`;
						} else if (isAccent) {
							cellClasses = purpleAccentCell;
						} else if (showNonEditorDing) {
							// В обычном режиме сохраняем видимость белых рамок, если пользователь сделал кастомный сдвиг Ta-рамок.
							cellClasses = lowPerfMode
								? 'bg-[#1e2a45] border-2 box-border border-white text-white z-[1]'
								: 'bg-[#1e2a45] border-2 box-border border-white/95 text-white shadow-[0_0_14px_rgba(255,255,255,0.2)] z-[1] hover:bg-[#253353]';
						}
						const accentForGlyph =
							isAccent ||
							(isTaEditorMode &&
								(isTaDing ||
									(cIdx === 0 && firstBeatAccent && !firstBeatRowSuppressed.has(rIdx)))) ||
							(!isTaEditorMode && showNonEditorDing);
						if (isActive) {
							cellClasses = playheadHighlightCellClasses(
								isDead,
								polyMode,
								isPlaying,
								polyVoiceIdx,
								lowPerfMode,
							);
						}
						return (
							<button
								type="button"
								key={cIdx}
								onPointerDown={(e) => {
									const a = actionsRef.current;
									if (!a) return;
									const btn = e.currentTarget as HTMLButtonElement;
									btn.setPointerCapture(e.pointerId);
									if (isDead) {
										if (a.holdTimerRef.current) clearTimeout(a.holdTimerRef.current);
										a.deadSwipeSessionRef.current = null;
										a.holdTimerRef.current = window.setTimeout(() => {
											a.isHoldingRef.current = true;
											a.restoreDeadRow(rIdx);
										}, 360);
										return;
									}
									a.deadSwipeSessionRef.current = null;
									if (isDeadCellsEditorMode) {
										a.isHoldingRef.current = false;
										if (a.holdTimerRef.current) clearTimeout(a.holdTimerRef.current);
										return;
									}
									a.isHoldingRef.current = false;
									a.subdivHoldSessionRef.current = null;
									if (a.holdTimerRef.current) clearTimeout(a.holdTimerRef.current);
									a.holdTimerRef.current = window.setTimeout(() => {
										a.isHoldingRef.current = true;
										const panelExpanded = a.isPanelExpandedRef.current;
										a.setCustomSubdivisions((prev) => {
											const current = prev[checkKey] || 1;
											const next = nextSubdivLongPress(current, panelExpanded);
											const out = { ...prev, [checkKey]: next };
											a.subdivHoldSessionRef.current = {
												key: checkKey,
												startY: e.clientY,
												baseSubdiv: next,
												lastDeltaSteps: 0,
												panelExpanded,
											};
											return out;
										});
										if (a.isPanelExpandedRef.current && !a.showRandomSettingsRef.current) {
											a.setActiveEditRow(null);
											a.setActiveEditCell(checkKey);
											a.setIsPanelExpanded(true);
										}
									}, 400);
								}}
								onPointerMove={(e) => {
									const a = actionsRef.current;
									if (!a) return;
									const s = a.subdivHoldSessionRef.current;
									if (!s || !a.isHoldingRef.current) return;
									if (s.key !== checkKey) return;
									const pxPerStep = 16;
									const dy = e.clientY - s.startY;
									const deltaSteps = Math.trunc(dy / pxPerStep);
									if (deltaSteps === s.lastDeltaSteps) return;
									s.lastDeltaSteps = deltaSteps;
									a.setCustomSubdivisions((prev) => {
										const next = stepSubdivByDelta(s.baseSubdiv, deltaSteps, s.panelExpanded);
										if ((prev[checkKey] || 1) === next) return prev;
										return { ...prev, [checkKey]: next };
									});
								}}
								onPointerUp={(e) => {
									const a = actionsRef.current;
									if (!a) return;
									const btn = e.currentTarget as HTMLButtonElement;
									if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
									a.deadSwipeSessionRef.current = null;
									a.subdivHoldSessionRef.current = null;
									if (a.holdTimerRef.current) clearTimeout(a.holdTimerRef.current);
								}}
								onPointerCancel={(e) => {
									const a = actionsRef.current;
									if (!a) return;
									const btn = e.currentTarget as HTMLButtonElement;
									if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
									a.deadSwipeSessionRef.current = null;
									a.subdivHoldSessionRef.current = null;
									if (a.holdTimerRef.current) clearTimeout(a.holdTimerRef.current);
								}}
								onPointerLeave={() => {
									const a = actionsRef.current;
									if (!a) return;
									a.subdivHoldSessionRef.current = null;
									if (a.holdTimerRef.current) clearTimeout(a.holdTimerRef.current);
								}}
								onClick={() => {
									const a = actionsRef.current;
									if (!a) return;
									if (isDeadCellsEditorMode) {
										if (isDead) a.restoreDeadRow(rIdx);
										else a.triggerDeadCut(rIdx, cIdx);
										return;
									}
									if (isDead) {
										if (a.isHoldingRef.current) a.isHoldingRef.current = false;
										return;
									}
									if (a.isHoldingRef.current) {
										a.isHoldingRef.current = false;
										return;
									}
									if (isTaEditorMode) {
										a.toggleTaDing(rIdx, cIdx);
										return;
									}
									a.toggleAccent(rIdx, cIdx);
								}}
								className={`flex-1 flex flex-col items-center justify-center min-w-0 ${lowPerfMode ? '' : 'transition-all duration-75'} ${
									rowSylls > 7 ? 'rounded-md' : 'rounded-xl'
								} ${cellClasses} ${activeEditCell === checkKey ? `ring-2 ring-inset ring-purple-500 z-20 ${lowPerfMode ? '' : 'shadow-purple-500/30'}` : ''}`}
							>
								<div
									className={`w-full h-full rounded-[inherit] overflow-hidden ${
										subdivs === 1
											? 'flex items-center justify-center'
											: subdivs === 2
												? 'grid grid-cols-1 grid-rows-2'
												: subdivs === 3
													? 'grid grid-cols-1 grid-rows-3'
													: subdivs === 4
														? 'grid grid-cols-2 grid-rows-2'
														: subdivs <= 6
															? 'grid grid-cols-2 grid-rows-3'
															: 'grid grid-cols-3 grid-rows-3'
									}`}
								>
									{Array.from({ length: subdivs }).map((_, i) => (
										<span
											key={i}
											className={`flex items-center justify-center w-full h-full min-w-0 overflow-hidden text-center px-px font-sans ${getSyllableStyles(rowSylls, subdivs)} ${
												isDead
													? 'text-transparent'
													: isActive
														? lowPerfMode
															? 'text-inherit'
															: 'text-inherit drop-shadow-md'
														: accentForGlyph
															? (lowPerfMode ? 'text-white' : 'drop-shadow-md')
															: 'text-slate-300'
											} ${subdivs > 1 ? 'border-[0.5px] border-[#2f4066]/50' : ''}`}
										>
											{isDead
												? ''
												: (rowCellLabels[cIdx]?.[i] ?? 'Ta')}
										</span>
									))}
								</div>
							</button>
						);
					})}
				</div>
			</div>
		);
	},
	sequencerGridRowPropsEqual,
);

export type SequencerGridProps = {
	gridRef: React.RefObject<HTMLDivElement | null>;
	bars: number;
	syllables: number;
	customSyllables: Record<number, number>;
	customSubdivisions: Record<string, number>;
	customMultipliers: Record<number, number>;
	accents: Set<string>;
	taDingKeys: Set<string>;
	pulseMeterUnlinked: Record<number, boolean>;
	isPlaying: boolean;
	activePos: { r: number; c: number; absR: number };
	activePositions: PlayheadPosition[];
	polyMode: boolean;
	polyVoices: 2 | 3 | 4;
	displayScaleBars: number;
	useFixedFlex: boolean;
	allBarsFitViewport: boolean;
	lowPerfMode: boolean;
	isTaEditorMode: boolean;
	isDeadCellsEditorMode: boolean;
	accentMapVersion: number;
	firstBeatAccent: boolean;
	forceFirstBeatEditorFrames: boolean;
	firstBeatEditorSuppressedSig: string;
	deadStartByRow: Record<number, number>;
	deadDisplayByRow: Record<number, number>;
	/** BPM доли. Используется для расчёта NPS и выбора Kalam (slow/medium/fast) в слогах. */
	bpm: number;
	activeEditRow: number | null;
	activeEditCell: string | null;
	sequencerGridRowActionsRef: React.MutableRefObject<SequencerGridRowActions | null>;
	setRowElStable: (absR: number, el: HTMLDivElement | null) => void;
};

export const SequencerGrid = React.memo(function SequencerGrid({
	gridRef,
	bars,
	syllables,
	customSyllables,
	customSubdivisions,
	customMultipliers,
	accents,
	taDingKeys,
	pulseMeterUnlinked,
	isPlaying,
	activePos,
	activePositions,
	polyMode,
	polyVoices,
	displayScaleBars,
	useFixedFlex,
	allBarsFitViewport,
	lowPerfMode,
	isTaEditorMode,
	isDeadCellsEditorMode,
	accentMapVersion,
	firstBeatAccent,
	forceFirstBeatEditorFrames,
	firstBeatEditorSuppressedSig,
	deadStartByRow,
	deadDisplayByRow,
	bpm,
	activeEditRow,
	activeEditCell,
	sequencerGridRowActionsRef,
	setRowElStable,
}: SequencerGridProps) {
	const rowCellLabelsCache = useStableRowCellLabelsCache(
		bars,
		syllables,
		customSyllables,
		customSubdivisions,
		deadStartByRow,
		bpm,
	);

	/**
	 * Legacy: при play и длинной ленте — дубли строк для скролла (playAbsBar растёт).
	 * Poly: playhead absR всегда 0..bars-1 — дубликаты дали бы ложную подсветку; только bars строк.
	 */
	const virtualRowCount = useMemo(() => {
		if (polyMode || !isPlaying || allBarsFitViewport) return bars;
		return Math.max(bars, activePos.absR + displayScaleBars * 2);
	}, [polyMode, isPlaying, allBarsFitViewport, bars, displayScaleBars, activePos.absR]);

	return (
		<div
			ref={gridRef}
			className={`relative flex flex-col gap-1.5 flex-1 overflow-y-auto overflow-x-hidden ${
				isPlaying
					? 'scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]'
					: '[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[#2f4066] [&::-webkit-scrollbar-thumb]:rounded-full'
			}`}
		>
			{Array.from({ length: virtualRowCount }).map((_, absR) => {
				const rIdx = absR % bars;
				const rowSylls = customSyllables[rIdx] !== undefined ? customSyllables[rIdx] : syllables;
				const rowCellLabels = rowCellLabelsCache[rIdx] ?? [];
				const rowMult = customMultipliers[rIdx] || 1;
				const effectiveUseFixedFlex = useFixedFlex || (isPlaying && !allBarsFitViewport);
				const subdivSig = Array.from({ length: rowSylls }, (_, c) =>
					String(customSubdivisions[`${rIdx}-${c}`] ?? 1),
				).join(',');
				const accentSig = Array.from({ length: rowSylls }, (_, c) =>
					accents.has(`${rIdx}-${c}`) ? '1' : '0',
				).join('');
				const taDingSig = Array.from({ length: rowSylls }, (_, c) =>
					taDingKeys.has(`${rIdx}-${c}`) ? '1' : '0',
				).join('');
				const pulseUnlinkedRow = Boolean(pulseMeterUnlinked[rIdx]);

				let highlightCol: number | null;
				let stepLabel: string | undefined;
				let isPolyRow: boolean | undefined;
				let polyStepTopRule = false;
				if (!polyMode) {
					highlightCol = isPlaying
						? activePos.absR === absR
							? activePos.c
							: null
						: activePos.r === rIdx
							? activePos.c
							: null;
				} else {
					const voiceIdx = rIdx % polyVoices;
					const stepIdx = Math.floor(rIdx / polyVoices);
					const voiceHighlight = activePositions.find(
						(pos) => pos.step === stepIdx && pos.voice === voiceIdx,
					);
					highlightCol =
						isPlaying && voiceHighlight
							? voiceHighlight.c
							: !isPlaying && activePos.r === rIdx
								? activePos.c
								: null;
					stepLabel = voiceIdx === 0 ? `${stepIdx + 1}` : '';
					isPolyRow = true;
					polyStepTopRule = stepIdx > 0 && voiceIdx === 0;
				}

				return (
					<SequencerGridRow
						key={absR}
						absR={absR}
						rIdx={rIdx}
						stepLabel={stepLabel}
						isPolyRow={isPolyRow}
						rowSylls={rowSylls}
						rowMult={rowMult}
						subdivSig={subdivSig}
						accentSig={accentSig}
						taDingSig={taDingSig}
						pulseUnlinkedRow={pulseUnlinkedRow}
						activeEditRow={activeEditRow}
						activeEditCell={activeEditCell}
						highlightCol={highlightCol}
						isPlaying={isPlaying}
						isTaEditorMode={isTaEditorMode}
						isDeadCellsEditorMode={isDeadCellsEditorMode}
						accentMapVersion={accentMapVersion}
						firstBeatAccent={firstBeatAccent}
						forceFirstBeatEditorFrames={forceFirstBeatEditorFrames}
						firstBeatEditorSuppressedSig={firstBeatEditorSuppressedSig}
						deadStartByRow={deadStartByRow}
						deadDisplayByRow={deadDisplayByRow}
						rowCellLabels={rowCellLabels}
						effectiveUseFixedFlex={effectiveUseFixedFlex}
						displayScaleBars={displayScaleBars}
						syllables={syllables}
						lowPerfMode={lowPerfMode}
						polyStepTopRule={polyStepTopRule}
						polyMode={polyMode}
						polyVoices={polyVoices}
						actionsRef={sequencerGridRowActionsRef}
						setRowEl={setRowElStable}
					/>
				);
			})}
		</div>
	);
});
