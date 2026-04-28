import React, { useMemo, useCallback, useRef, useEffect } from 'react';
import {
	buildRowCellSyllableLabels,
	getSyllableStyles,
	type KalamMap,
	type RowRuntimeContext,
	type SyllableLabel,
} from './sequencerLabels';
import type { PlayheadPosition } from './playheadTypes';

/** Keep long-press pulse switching consistent with collapsed behavior. */
function allowedSubdivisions(_panelExpanded: boolean): number[] {
	return [1, 2, 3, 4];
}

/** Next value in the available subdivision cycle. */
function nextSubdivLongPress(current: number, panelExpanded: boolean): number {
	const allowed = allowedSubdivisions(panelExpanded);
	const idx = allowed.indexOf(current);
	if (idx < 0) return allowed[0]!;
	return allowed[(idx + 1) % allowed.length]!;
}

/** Shift subdivision by delta steps inside the available cycle (for up/down gesture). */
function stepSubdivByDelta(base: number, delta: number, panelExpanded: boolean): number {
	const allowed = allowedSubdivisions(panelExpanded);
	const len = allowed.length;
	if (len === 0) return 1;
	const baseIdxRaw = allowed.indexOf(base);
	const baseIdx = baseIdxRaw >= 0 ? baseIdxRaw : 0;
	const idx = ((baseIdx + delta) % len + len) % len;
	return allowed[idx]!;
}

function triggerHapticPulse(durationMs = 50): void {
	try {
		if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
			navigator.vibrate(durationMs);
		}
	} catch {
		/* ignore */
	}
}

const CELL_SUBDIV_ARM_SLOP_Y_PX = 10;
const PULSE_ROULETTE_SLOP_Y_PX = 0;
const PULSE_MODE_TOGGLE_CANCEL_SLOP_Y_PX = 8;
const PULSE_HOLD_MS = 450;
const CELL_HOLD_MS = 1000;

/** Poly playback: voice 0 = emerald; 1 = sky; 2 = violet; 3+ = amber. */
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

function rowCellLabelsEqual(a: SyllableLabel[][], b: SyllableLabel[][]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const ra = a[i];
		const rb = b[i];
		if (ra === rb) continue;
		if (!ra || !rb || ra.length !== rb.length) return false;
		for (let j = 0; j < ra.length; j++) {
			if (ra[j]?.syl !== rb[j]?.syl || Boolean(ra[j]?.accent) !== Boolean(rb[j]?.accent)) return false;
		}
	}
	return true;
}

const PULSE_METER_BASE_SYLLABLES = 4;

function effectiveBpmForGridRow(
	bpm: number,
	rowIdx: number,
	baseSyllables: number,
	customSyllables: Record<number, number>,
	pulseMeterUnlinked: Record<number, boolean>,
	customMultipliers: Record<number, number>,
): number {
	const rowSyllables = customSyllables[rowIdx] !== undefined ? customSyllables[rowIdx]! : baseSyllables;
	const pulseSyllables = pulseMeterUnlinked[rowIdx] ? PULSE_METER_BASE_SYLLABLES : rowSyllables;
	const mult = customMultipliers[rowIdx] ?? 1;
	return bpm * (pulseSyllables / 4) * mult;
}

function useStableRowCellLabelsCache(
	bars: number,
	syllables: number,
	customSyllables: Record<number, number>,
	customSubdivisions: Record<string, number>,
	customCellSyllables: Record<string, string>,
	pulseMeterUnlinked: Record<number, boolean>,
	customMultipliers: Record<number, number>,
	rowRuntimeContexts: Record<number, RowRuntimeContext>,
	accents: Set<string>,
	deadStartByRow: Record<number, number>,
	bpm: number,
): SyllableLabel[][][] {
	const prevRef = useRef<SyllableLabel[][][]>([]);
	const kalamMapRef = useRef<KalamMap>(new Map());
	return useMemo(() => {
		const prev = prevRef.current;
		const next: SyllableLabel[][][] = [];
		const touched = new Set<string>();
		for (let r = 0; r < bars; r++) {
			const rowSylls = customSyllables[r] !== undefined ? customSyllables[r] : syllables;
			const cellOv: Record<string, string> = {};
			for (let c = 0; c < rowSylls; c++) {
				const k = `${r}-${c}`;
				const t = customCellSyllables[k];
				if (typeof t === 'string' && t.length > 0) cellOv[k] = t;
			}
			const built = buildRowCellSyllableLabels(rowSylls, customSubdivisions, r, {
				bpm,
				deadStart: deadStartByRow[r],
				kalamMap: kalamMapRef.current,
				touchedKeys: touched,
				rowRuntimeContext: {
					...(rowRuntimeContexts[r] ?? {}),
					effectiveBpm: effectiveBpmForGridRow(
						bpm,
						r,
						syllables,
						customSyllables,
						pulseMeterUnlinked,
						customMultipliers,
					),
				},
				cellSyllableOverrides: Object.keys(cellOv).length > 0 ? cellOv : undefined,
				accentCells: new Set(Array.from({ length: rowSylls }, (_, c) => c).filter((c) => accents.has(`${r}-${c}`))),
				isLessonLastRow: r === bars - 1,
			});
			const oldRow = prev[r];
			if (oldRow !== undefined && rowCellLabelsEqual(oldRow, built)) {
				next[r] = oldRow;
			} else {
				next[r] = built;
			}
		}
		/** GC: remove hysteresis keys for segments/cells that no longer exist in the grid. */
		const km = kalamMapRef.current;
		const stale: string[] = [];
		km.forEach((_, key) => {
			if (!touched.has(key)) stale.push(key);
		});
		for (const key of stale) km.delete(key);
		prevRef.current = next;
		return next;
	}, [
		bars,
		syllables,
		customSyllables,
		customSubdivisions,
		customCellSyllables,
		pulseMeterUnlinked,
		customMultipliers,
		rowRuntimeContexts,
		accents,
		deadStartByRow,
		bpm,
	]);
}

/** Ref-filled each App render — stable identity for memoized grid row. */
export type SequencerGridRowActions = {
	isHoldingRef: React.MutableRefObject<boolean>;
	holdTimerRef: React.MutableRefObject<number | null>;
	pulseUnlinkHoldTimerRef: React.MutableRefObject<number | null>;
	/** True only after pulse-button long-press unlink: suppress one click without swallowing cell long-press click. */
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
	/** Long-press on Pulse: switch progressive mode to jati/de-sync mode. */
	onPulseLongPressModeSwitch?: (rowIdx: number, rowSylls: number, nextPulseUnlinked: boolean) => void;
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
	jatiPulseActiveRow: boolean;
	activeEditRow: number | null;
	activeEditCell: string | null;
	highlightCol: number | null;
	isPlaying: boolean;
	isTaEditorMode: boolean;
	isDeadCellsEditorMode: boolean;
	accentMapVersion: number;
	forceFirstBeatEditorFrames: boolean;
	canShowDefaultTaInNormal: boolean;
	/** Comma-sorted row indices: rows where default first-beat white marker was disabled in editor. */
	firstBeatEditorSuppressedSig: string;
	deadStartByRow: Record<number, number>;
	deadDisplayByRow: Record<number, number>;
	rowCellLabels: SyllableLabel[][];
	effectiveUseFixedFlex: boolean;
	displayScaleBars: number;
	useFrozenRowHeight: boolean;
	frozenRowHeightPx: number | null;
	frozenRowHeightsByRIdx: Record<number, number>;
	syllables: number;
	lowPerfMode: boolean;
	/** In flat poly mode: visual separator between steps (does not affect audio). */
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
		a.jatiPulseActiveRow === b.jatiPulseActiveRow &&
		a.activeEditRow === b.activeEditRow &&
		a.activeEditCell === b.activeEditCell &&
		a.highlightCol === b.highlightCol &&
		a.isPlaying === b.isPlaying &&
		a.isTaEditorMode === b.isTaEditorMode &&
		a.isDeadCellsEditorMode === b.isDeadCellsEditorMode &&
		a.accentMapVersion === b.accentMapVersion &&
		a.forceFirstBeatEditorFrames === b.forceFirstBeatEditorFrames &&
		a.canShowDefaultTaInNormal === b.canShowDefaultTaInNormal &&
		a.firstBeatEditorSuppressedSig === b.firstBeatEditorSuppressedSig &&
		a.deadStartByRow === b.deadStartByRow &&
		a.deadDisplayByRow === b.deadDisplayByRow &&
		a.rowCellLabels === b.rowCellLabels &&
		a.effectiveUseFixedFlex === b.effectiveUseFixedFlex &&
		a.displayScaleBars === b.displayScaleBars &&
		a.useFrozenRowHeight === b.useFrozenRowHeight &&
		a.frozenRowHeightPx === b.frozenRowHeightPx &&
		a.frozenRowHeightsByRIdx === b.frozenRowHeightsByRIdx &&
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
			jatiPulseActiveRow,
			activeEditRow,
			activeEditCell,
			highlightCol,
			isPlaying,
			isTaEditorMode,
			isDeadCellsEditorMode,
			accentMapVersion,
			forceFirstBeatEditorFrames,
			canShowDefaultTaInNormal,
			firstBeatEditorSuppressedSig,
			deadStartByRow,
			deadDisplayByRow,
			rowCellLabels,
			effectiveUseFixedFlex,
			displayScaleBars,
			useFrozenRowHeight,
			frozenRowHeightPx,
			frozenRowHeightsByRIdx,
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
		// FRAGILE — Ta white rim / poly vs App.tsx taDingKeysUi + forceFirstBeatEditorFrames; easy visual/audio split.
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
		const pulsePointerStartYRef = useRef<number | null>(null);
		const pulsePointerLatestYRef = useRef<number | null>(null);
		const pulseMovedBeforeHoldRef = useRef(false);
		const pulseHoldReadyRef = useRef(false);
		const pulseRouletteSessionRef = useRef<{
			startY: number;
			basePulse: number;
			lastDeltaSteps: number;
		} | null>(null);
		return (
			<div
				ref={(el) => setRowEl(absR, el)}
				className={`z-[12] flex items-stretch bg-[#161f33] border border-[#23314f] min-h-0 relative ${
					displayScaleBars > 7 ? 'gap-1 p-1 rounded-lg' : 'gap-1.5 p-1 rounded-xl'
				} ${isPolyRow ? 'border-l-4 border-l-blue-500/45' : ''} ${
					polyStepTopRule ? 'mt-1.5 border-t border-[#2a3d66]/90 pt-1.5' : ''
				} ${!effectiveUseFixedFlex ? 'flex-1' : ''}`}
				style={{
					flex: effectiveUseFixedFlex
						? `0 0 ${(useFrozenRowHeight && Math.max(1, (frozenRowHeightsByRIdx[rIdx] ?? frozenRowHeightPx ?? 0)) > 1)
							? `${Math.max(1, (frozenRowHeightsByRIdx[rIdx] ?? frozenRowHeightPx ?? 0))}px`
							: `calc((100% - ${(displayScaleBars - 1) * 6}px) / ${displayScaleBars})`}`
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
							// Prevent button focus on click: in an overflow container this may
							// trigger abrupt jump-scroll (especially on lower rows).
							e.preventDefault();
						}}
						onPointerDown={(e) => {
							const a = actionsRef.current;
							if (!a) return;
							const el = e.currentTarget as HTMLButtonElement;
							a.pulseUnlinkJustFiredRef.current = false;
							a.isHoldingRef.current = false;
							pulsePointerStartYRef.current = e.clientY;
							pulsePointerLatestYRef.current = e.clientY;
							pulseMovedBeforeHoldRef.current = false;
							pulseHoldReadyRef.current = false;
							pulseRouletteSessionRef.current = null;
							if (a.pulseUnlinkHoldTimerRef.current) clearTimeout(a.pulseUnlinkHoldTimerRef.current);
							a.pulseUnlinkHoldTimerRef.current = window.setTimeout(() => {
								try {
									el.setPointerCapture(e.pointerId);
								} catch {
									/* best effort capture */
								}
								a.isHoldingRef.current = true;
								/* Long-press + no pre-move: включаем/выключаем gati-jati сразу под удержанием. */
								if (!pulseMovedBeforeHoldRef.current) {
									a.pulseUnlinkJustFiredRef.current = true;
									a.setPulseMeterUnlinked((prev) => {
										const nextVal = !prev[rIdx];
										a.onPulseLongPressModeSwitch?.(rIdx, rowSylls, nextVal);
										const next = { ...prev, [rIdx]: nextVal };
										a.pulseMeterUnlinkedRef.current = { ...next };
										return next;
									});
								}
								/* После hold: можно перейти в Y-roulette без ожидания pointerup. */
								pulseHoldReadyRef.current = true;
								triggerHapticPulse(50);
								a.pulseUnlinkHoldTimerRef.current = null;
							}, PULSE_HOLD_MS);
						}}
						onPointerMove={(e) => {
							const a = actionsRef.current;
							if (!a) return;
							const el = e.currentTarget as HTMLButtonElement;
							const startY = pulsePointerStartYRef.current;
							if (startY === null) return;
							pulsePointerLatestYRef.current = e.clientY;
							if (!a.isHoldingRef.current && Math.abs(e.clientY - startY) > PULSE_MODE_TOGGLE_CANCEL_SLOP_Y_PX) {
								pulseMovedBeforeHoldRef.current = true;
								// Fast path: if user already slides, enter roulette immediately (like Bars slider),
								// skip waiting long-press timer for gati/jati mode toggle.
								if (pulseRouletteSessionRef.current === null) {
									if (a.pulseUnlinkHoldTimerRef.current) {
										clearTimeout(a.pulseUnlinkHoldTimerRef.current);
										a.pulseUnlinkHoldTimerRef.current = null;
									}
									try {
										el.setPointerCapture(e.pointerId);
									} catch {
										/* best effort capture */
									}
									a.isHoldingRef.current = true;
									const basePulse =
										a.customSyllablesRef.current[rIdx] !== undefined ? a.customSyllablesRef.current[rIdx]! : a.syllables;
									pulseRouletteSessionRef.current = {
										startY: e.clientY,
										basePulse,
										lastDeltaSteps: 0,
									};
									pulseHoldReadyRef.current = false;
									a.pulseUnlinkJustFiredRef.current = true;
									triggerHapticPulse(50);
								}
							}
							if (!a.isHoldingRef.current) return;
							if (pulseHoldReadyRef.current && !pulseRouletteSessionRef.current) {
								if (Math.abs(e.clientY - startY) <= PULSE_ROULETTE_SLOP_Y_PX) return;
								const basePulse =
									a.customSyllablesRef.current[rIdx] !== undefined ? a.customSyllablesRef.current[rIdx]! : a.syllables;
								pulseRouletteSessionRef.current = {
									startY: e.clientY,
									basePulse,
									lastDeltaSteps: 0,
								};
								pulseHoldReadyRef.current = false;
								a.pulseUnlinkJustFiredRef.current = true;
							}
							const s = pulseRouletteSessionRef.current;
							if (!s) return;
							const pxPerStep = 16;
							const deltaSteps = -Math.trunc((e.clientY - s.startY) / pxPerStep);
							if (deltaSteps === s.lastDeltaSteps) return;
							s.lastDeltaSteps = deltaSteps;
							a.setCustomSyllables((prev) => {
								const next = Math.max(1, Math.min(9, s.basePulse + deltaSteps));
								const cur = prev[rIdx] !== undefined ? prev[rIdx] : a.syllables;
								if (cur === next) return prev;
								const out = { ...prev, [rIdx]: next };
								a.customSyllablesRef.current = { ...out };
								return out;
							});
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
							pulsePointerStartYRef.current = null;
							pulsePointerLatestYRef.current = null;
							pulseMovedBeforeHoldRef.current = false;
							pulseHoldReadyRef.current = false;
							pulseRouletteSessionRef.current = null;
							a.isHoldingRef.current = false;
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
							pulsePointerStartYRef.current = null;
							pulsePointerLatestYRef.current = null;
							pulseMovedBeforeHoldRef.current = false;
							pulseHoldReadyRef.current = false;
							pulseRouletteSessionRef.current = null;
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
							pulsePointerStartYRef.current = null;
							pulsePointerLatestYRef.current = null;
							pulseMovedBeforeHoldRef.current = false;
							pulseHoldReadyRef.current = false;
							pulseRouletteSessionRef.current = null;
							a.isHoldingRef.current = false;
						}}
						onClick={() => {
							const a = actionsRef.current;
							if (!a) return;
							if (a.pulseUnlinkJustFiredRef.current) {
								a.pulseUnlinkJustFiredRef.current = false;
								return;
							}
							if (a.isHoldingRef.current) {
								a.isHoldingRef.current = false;
								/* Click arrived without pulse pointerdown (captured from cell): still run syllable cycle based on grid long-press isHoldingRef. */
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
						className={`flex-1 rounded-md border flex items-center justify-center text-[12px] font-extrabold leading-none ${lowPerfMode ? '' : 'shadow-[inset_0_1px_3px_rgba(0,0,0,0.1)]'} min-h-[50%] transition-colors select-none touch-pan-y ${
							activeEditRow === rIdx
								? `ring-2 ring-purple-500 ${lowPerfMode ? '' : 'shadow-purple-500/30'} bg-[#1e2a45] border-[#2f4066] text-slate-400`
								: jatiPulseActiveRow
									? `bg-teal-500/25 border-teal-400/70 text-teal-50 ring-1 ring-teal-400/80 ${lowPerfMode ? '' : 'shadow-[inset_0_1px_8px_rgba(20,184,166,0.25),0_0_12px_rgba(45,212,191,0.2)]'}`
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
						// FRAGILE — showEditorDing / showNonEditorDing gate all white-ring styling; must stay aligned with emitGridSubAudio Ta paths.
						// ACCENT CONTRACT (read before changing):
						// - showEditorDing (Ta editor): default col0 Ta + explicit taDing markers.
						// - showNonEditorDing (normal): explicit taDing markers, plus legacy default col0 display
						//   only after default pattern was changed (there is at least one suppressed row).
						// - Never derive white-frame visibility from purple accent map.
						// - White Ta and purple accent are independent layers and must not be merged.
						/** In Ta editor, legacy mode must show default Ta on beat 1 (unless explicitly suppressed). */
						const showEditorDing =
							isTaDing ||
							(cIdx === 0 &&
								!isDead &&
								!firstBeatRowSuppressed.has(rIdx) &&
								forceFirstBeatEditorFrames);
						const showLegacyDefaultInNormal =
							cIdx === 0 &&
							!isDead &&
							forceFirstBeatEditorFrames &&
							canShowDefaultTaInNormal &&
							!firstBeatRowSuppressed.has(rIdx);
						const showNonEditorDing = !isDead && isTaDing;
						const showNonEditorDingWithLegacy = showNonEditorDing || showLegacyDefaultInNormal;
						const isActive = highlightCol === cIdx;
						const subdivs = isDead ? 1 : (rowSubdivs[cIdx] ?? 1);
						const cellBorder2 = 'border-2 box-border border-[#2f4066]';
						const taPressedOverlayClasses =
							'relative overflow-hidden active:after:content-[\'\'] active:after:absolute active:after:inset-0 active:after:bg-white/30 active:after:pointer-events-none';
						const purpleAccentCell =
							`bg-purple-900/40 border-2 box-border border-purple-500/50 ${lowPerfMode ? '' : 'shadow-[inset_0_1px_4px_rgba(168,85,247,0.2)]'} hover:bg-purple-900/50 text-purple-100`;
						let cellClasses = `bg-[#1e2a45] ${cellBorder2} ${lowPerfMode ? '' : 'shadow-[0_2px_4px_rgba(0,0,0,0.2)]'} hover:bg-[#253353] text-slate-300`;
						const taBaseCell = lowPerfMode
							? `bg-[#1e2a45] border-2 box-border border-white text-white z-[1] ${taPressedOverlayClasses}`
							: `bg-[#1e2a45] border-2 box-border border-white/95 text-white shadow-[0_0_14px_rgba(255,255,255,0.2)] z-[1] hover:bg-[#253353] ${taPressedOverlayClasses}`;
						const taAccentOverlapCell = lowPerfMode
							? `bg-purple-900/40 border-2 box-border border-white text-white z-[1] ${taPressedOverlayClasses}`
							: `bg-purple-900/45 border-2 box-border border-white/95 text-white shadow-[0_0_14px_rgba(255,255,255,0.2),inset_0_1px_4px_rgba(168,85,247,0.2)] z-[1] hover:bg-purple-900/50 ${taPressedOverlayClasses}`;
						if (isDead) {
							cellClasses = lowPerfMode
								? 'bg-slate-800/60 border-2 box-border border-slate-700 text-slate-500'
								: 'bg-slate-800/60 border-2 box-border border-slate-700 text-slate-500';
						} else if (isTaEditorMode) {
							if (isAccent && showEditorDing) {
								cellClasses = taAccentOverlapCell;
							} else if (showEditorDing) {
								cellClasses = taBaseCell;
							} else if (isAccent) {
								cellClasses = purpleAccentCell;
							}
						} else if (isAccent && showNonEditorDingWithLegacy) {
							cellClasses = taAccentOverlapCell;
						} else if (isAccent) {
							cellClasses = purpleAccentCell;
						} else if (showNonEditorDingWithLegacy) {
							// In normal mode keep white frame visibility if user made a custom Ta-frame offset.
							cellClasses = taBaseCell;
						}
						const accentForGlyph =
							isAccent ||
							(isTaEditorMode && isTaDing) ||
							(!isTaEditorMode && showNonEditorDingWithLegacy);
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
								data-subdiv-cell-key={checkKey}
								onPointerDown={(e) => {
									const a = actionsRef.current;
									if (!a) return;
									const btn = e.currentTarget as HTMLButtonElement;
									btn.dataset.subdivArmStartY = String(e.clientY);
									btn.dataset.subdivArmLatestY = String(e.clientY);
									btn.dataset.subdivArmActive = '1';
									if (isDead) {
										if (a.holdTimerRef.current) clearTimeout(a.holdTimerRef.current);
										a.deadSwipeSessionRef.current = null;
										a.holdTimerRef.current = window.setTimeout(() => {
											a.isHoldingRef.current = true;
											triggerHapticPulse(50);
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
										let captureOk = false;
										try {
											btn.setPointerCapture(e.pointerId);
											captureOk = typeof btn.hasPointerCapture === 'function' && btn.hasPointerCapture(e.pointerId);
										} catch {
											/* pointer may already be released */
										}
										if (!captureOk) return;
										a.isHoldingRef.current = true;
										triggerHapticPulse(50);
										const armedStartY = Number(btn.dataset.subdivArmLatestY ?? btn.dataset.subdivArmStartY ?? e.clientY);
										const panelExpanded = a.isPanelExpandedRef.current;
										a.setCustomSubdivisions((prev) => {
											const current = prev[checkKey] || 1;
											const next = nextSubdivLongPress(current, panelExpanded);
											const out = { ...prev, [checkKey]: next };
											a.subdivHoldSessionRef.current = {
												key: checkKey,
												startY: Number.isFinite(armedStartY) ? armedStartY : e.clientY,
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
										btn.dataset.subdivArmActive = '0';
									}, CELL_HOLD_MS);
								}}
								onPointerMove={(e) => {
									const a = actionsRef.current;
									if (!a) return;
									const btn = e.currentTarget as HTMLButtonElement;
									btn.dataset.subdivArmLatestY = String(e.clientY);
									if (btn.dataset.subdivArmActive === '1' && a.holdTimerRef.current) {
										const startY = Number(btn.dataset.subdivArmStartY ?? e.clientY);
										if (Number.isFinite(startY) && Math.abs(e.clientY - startY) > CELL_SUBDIV_ARM_SLOP_Y_PX) {
											clearTimeout(a.holdTimerRef.current);
											a.holdTimerRef.current = null;
											btn.dataset.subdivArmActive = '0';
										}
									}
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
									delete btn.dataset.subdivArmStartY;
									delete btn.dataset.subdivArmLatestY;
									delete btn.dataset.subdivArmActive;
									a.deadSwipeSessionRef.current = null;
									a.subdivHoldSessionRef.current = null;
									if (a.holdTimerRef.current) clearTimeout(a.holdTimerRef.current);
								}}
								onPointerCancel={(e) => {
									const a = actionsRef.current;
									if (!a) return;
									const btn = e.currentTarget as HTMLButtonElement;
									if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
									delete btn.dataset.subdivArmStartY;
									delete btn.dataset.subdivArmLatestY;
									delete btn.dataset.subdivArmActive;
									a.deadSwipeSessionRef.current = null;
									a.subdivHoldSessionRef.current = null;
									if (a.holdTimerRef.current) clearTimeout(a.holdTimerRef.current);
								}}
								onPointerLeave={(e) => {
									const a = actionsRef.current;
									if (!a) return;
									const btn = e.currentTarget as HTMLButtonElement;
									if (typeof btn.hasPointerCapture === 'function' && btn.hasPointerCapture(e.pointerId)) return;
									delete btn.dataset.subdivArmStartY;
									delete btn.dataset.subdivArmLatestY;
									delete btn.dataset.subdivArmActive;
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
									// In expanded pulse edit, single tap on the same syllable exits edit mode.
									if (activeEditCell === checkKey) {
										a.setActiveEditCell(null);
										return;
									}
									if (isTaEditorMode) {
										a.toggleTaDing(rIdx, cIdx);
										return;
									}
									a.toggleAccent(rIdx, cIdx);
								}}
								onContextMenu={(e) => e.preventDefault()}
								className={`flex-1 flex flex-col items-center justify-center min-w-0 touch-pan-y ${lowPerfMode ? '' : 'transition-all duration-75'} ${
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
														: (accentForGlyph || rowCellLabels[cIdx]?.[i]?.accent === true)
															? (lowPerfMode ? 'text-white' : 'drop-shadow-md')
															: 'text-slate-300'
											} ${subdivs > 1 ? 'border-[0.5px] border-[#2f4066]/50' : ''}`}
										>
											{isDead
												? ''
												: (rowCellLabels[cIdx]?.[i]?.syl ?? '')}
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
	/** Parent / Karvai: syllable override by `${row}-${cell}` key on top of gati dictionary. */
	customCellSyllables: Record<string, string>;
	customSubdivisions: Record<string, number>;
	customMultipliers: Record<number, number>;
	accents: Set<string>;
	taDingKeys: Set<string>;
	pulseMeterUnlinked: Record<number, boolean>;
	rowRuntimeContexts: Record<number, RowRuntimeContext>;
	jatiPulseActiveByRow: Record<number, boolean>;
	isPlaying: boolean;
	autoscrollVirtualRowsEnabled: boolean;
	activePos: { r: number; c: number; absR: number };
	activePositions: PlayheadPosition[];
	polyMode: boolean;
	polyVoices: 2 | 3 | 4;
	displayScaleBars: number;
	useFixedFlex: boolean;
	useFrozenRowHeight: boolean;
	frozenRowHeightPx: number | null;
	frozenRowHeightsByRIdx: Record<number, number>;
	allBarsFitViewport: boolean;
	lowPerfMode: boolean;
	isTaEditorMode: boolean;
	isDeadCellsEditorMode: boolean;
	accentMapVersion: number;
	forceFirstBeatEditorFrames: boolean;
	canShowDefaultTaInNormal: boolean;
	firstBeatEditorSuppressedSig: string;
	deadStartByRow: Record<number, number>;
	deadDisplayByRow: Record<number, number>;
	/** Beat BPM. Used to compute NPS and pick Kalam (slow/medium/fast) for syllables. */
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
	customCellSyllables,
	customSubdivisions,
	customMultipliers,
	accents,
	taDingKeys,
	pulseMeterUnlinked,
	rowRuntimeContexts,
	jatiPulseActiveByRow,
	isPlaying,
	autoscrollVirtualRowsEnabled,
	activePos,
	activePositions,
	polyMode,
	polyVoices,
	displayScaleBars,
	useFixedFlex,
	useFrozenRowHeight,
	frozenRowHeightPx,
	frozenRowHeightsByRIdx,
	allBarsFitViewport,
	lowPerfMode,
	isTaEditorMode,
	isDeadCellsEditorMode,
	accentMapVersion,
	forceFirstBeatEditorFrames,
	canShowDefaultTaInNormal,
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
		customCellSyllables,
		pulseMeterUnlinked,
		customMultipliers,
		rowRuntimeContexts,
		accents,
		deadStartByRow,
		bpm,
	);
	useEffect(() => {
		const gridEl = gridRef.current;
		if (!gridEl) return;
		const handleTouchMove = (e: TouchEvent) => {
			if (sequencerGridRowActionsRef.current?.isHoldingRef.current) {
				e.preventDefault();
			}
		};
		gridEl.addEventListener('touchmove', handleTouchMove, { passive: false });
		return () => {
			gridEl.removeEventListener('touchmove', handleTouchMove);
		};
	}, [gridRef, sequencerGridRowActionsRef]);

	/**
	 * Legacy: while playing with a long strip, duplicate rows for scrolling (playAbsBar grows).
	 * Poly: playhead absR is always 0..bars-1, so duplicates would cause false highlight; keep bars rows only.
	 */
	const virtualRowCount = useMemo(() => {
		if (polyMode || !isPlaying || allBarsFitViewport) return bars;
		if (autoscrollVirtualRowsEnabled) {
			return Math.max(bars, activePos.absR + displayScaleBars * 2);
		}
		const limitedCycles = 3;
		return bars * limitedCycles;
	}, [polyMode, isPlaying, allBarsFitViewport, bars, displayScaleBars, activePos.absR, autoscrollVirtualRowsEnabled]);
	return (
		<div className="relative flex min-h-0 flex-1">
			<div
				ref={gridRef}
				className="relative z-10 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[#2f4066] [&::-webkit-scrollbar-thumb]:rounded-full"
				style={{
					overscrollBehaviorY: 'contain',
					touchAction: 'pan-y',
					scrollbarGutter: 'stable',
					scrollbarColor: '#2f4066 transparent',
					scrollbarWidth: 'thin',
					width: 'calc(100% + 10px)',
					paddingRight: '10px',
					marginRight: '-10px',
				}}
			>
				{Array.from({ length: virtualRowCount }).map((_, absR) => {
				const rIdx = absR % bars;
				const rowSylls = customSyllables[rIdx] !== undefined ? customSyllables[rIdx] : syllables;
				const rowCellLabels = rowCellLabelsCache[rIdx] ?? [];
				const rowMult = customMultipliers[rIdx] || 1;
				const effectiveUseFixedFlex = useFrozenRowHeight || useFixedFlex || (isPlaying && !allBarsFitViewport);
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
				const jatiPulseActiveRow = Boolean(jatiPulseActiveByRow[rIdx]);

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
					/** In polyrhythm show step number on each row (V1/V2[/V3]): 1,1,2,2... */
					stepLabel = `${stepIdx + 1}`;
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
						jatiPulseActiveRow={jatiPulseActiveRow}
						activeEditRow={activeEditRow}
						activeEditCell={activeEditCell}
						highlightCol={highlightCol}
						isPlaying={isPlaying}
						isTaEditorMode={isTaEditorMode}
						isDeadCellsEditorMode={isDeadCellsEditorMode}
						accentMapVersion={accentMapVersion}
						forceFirstBeatEditorFrames={forceFirstBeatEditorFrames}
						canShowDefaultTaInNormal={canShowDefaultTaInNormal}
						firstBeatEditorSuppressedSig={firstBeatEditorSuppressedSig}
						deadStartByRow={deadStartByRow}
						deadDisplayByRow={deadDisplayByRow}
						rowCellLabels={rowCellLabels}
						effectiveUseFixedFlex={effectiveUseFixedFlex}
						displayScaleBars={displayScaleBars}
						useFrozenRowHeight={useFrozenRowHeight}
						frozenRowHeightPx={frozenRowHeightPx}
						frozenRowHeightsByRIdx={frozenRowHeightsByRIdx}
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
		</div>
	);
});
