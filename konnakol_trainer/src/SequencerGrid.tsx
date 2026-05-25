import React, { useMemo, useCallback, useRef, useEffect } from 'react';
import {
	buildRowCellSyllableLabels,
	getSyllableStyles,
	type KalamMap,
	type RowRuntimeContext,
	type SyllableLabel,
} from './sequencerLabels';
import type { PlayheadPosition } from './playheadTypes';
import {
	distributeFusedGroupJatiSum,
	findGroupForBar,
	formatFusedBarStepLabel,
	getDisplayPulseSyllables,
	getFusedBarStepDisplay,
	getFusedGroupJatiSumBounds,
	getGroupMultiplier,
	getGroupPulseSyllables,
	incrementFusedGroupJatiFromBar,
	isFusedGroupFirstBeatCell,
	sumGroupJati,
	type FusedGroupState,
} from './fusedBarGroups';
import {
	stepMaskSignatureByRow,
	getRowDataHash,
	type CellConfigs,
	type CellIntent,
	type CellStepMasks,
} from './stepMask';

/** Keep long-press pulse switching consistent with collapsed behavior. */
function allowedSubdivisions(_panelExpanded: boolean): number[] {
	return _panelExpanded ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : [1, 2, 3, 4];
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

/** stopPropagation always; preventDefault only when the browser allows it (non-passive). */
function swallowPointerLikeEvent(e: { stopPropagation: () => void; cancelable?: boolean; preventDefault?: () => void }) {
	e.stopPropagation();
	if (e.cancelable !== false) {
		try {
			e.preventDefault?.();
		} catch {
			/* passive touch listener */
		}
	}
}

const CELL_SUBDIV_ARM_SLOP_Y_PX = 10;
const PULSE_ROULETTE_SLOP_Y_PX = 0;
const PULSE_MODE_TOGGLE_CANCEL_SLOP_Y_PX = 8;
const PULSE_HOLD_MS = 450;
const MULT_FUSED_HOLD_MS = 450;
const CELL_HOLD_MS = 250;

/**
 * Poly/legacy playhead on a syllable cell: border + opaque fill + text tint in one class string
 * (not separate layers). Voice colors: 0 emerald, 1 sky, 2 violet.
 */
function playheadHighlightCellClasses(
	isDead: boolean,
	polyMode: boolean,
	isPlaying: boolean,
	polyVoiceIdx: number,
	lowPerfMode: boolean,
): string {
	if (isDead) {
		return lowPerfMode
			? 'bg-slate-800 border-2 box-border border-slate-500 z-10 text-slate-400'
			: 'bg-slate-800 border-2 box-border border-slate-500 shadow-[0_0_10px_rgba(100,116,139,0.22)] z-10 text-slate-300';
	}
	const polyActive = polyMode && isPlaying;
	if (!polyActive || polyVoiceIdx === 0) {
		return lowPerfMode
			? 'bg-emerald-950 border-2 box-border border-emerald-500 z-10 text-emerald-100'
			: 'bg-emerald-950 border-2 box-border border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)] z-10 text-emerald-100';
	}
	if (polyVoiceIdx === 1) {
		return lowPerfMode
			? 'bg-sky-950 border-2 box-border border-sky-400 z-10 text-sky-100'
			: 'bg-sky-950 border-2 box-border border-sky-400 shadow-[0_0_15px_rgba(56,189,248,0.28)] z-10 text-sky-100';
	}
	if (polyVoiceIdx === 2) {
		return lowPerfMode
			? 'bg-violet-950 border-2 box-border border-violet-400 z-10 text-violet-100'
			: 'bg-violet-950 border-2 box-border border-violet-400 shadow-[0_0_15px_rgba(167,139,250,0.28)] z-10 text-violet-100';
	}
	return lowPerfMode
		? 'bg-amber-950 border-2 box-border border-amber-400 z-10 text-amber-100'
		: 'bg-amber-950 border-2 box-border border-amber-400 shadow-[0_0_15px_rgba(251,191,36,0.26)] z-10 text-amber-100';
}

/** Fused multiplier ring: lane colors match poly playhead (V0 emerald, V1 sky, V2 violet). */
function fusedLaneMultiplierRingClasses(laneId: number, lowPerfMode: boolean): string {
	if (laneId === 1) {
		return lowPerfMode
			? 'ring-2 ring-sky-400/90 border-sky-400/70'
			: 'ring-2 ring-sky-400/90 border-sky-400/70 shadow-[0_0_10px_rgba(56,189,248,0.25)]';
	}
	if (laneId === 2) {
		return lowPerfMode
			? 'ring-2 ring-violet-400/90 border-violet-400/70'
			: 'ring-2 ring-violet-400/90 border-violet-400/70 shadow-[0_0_10px_rgba(167,139,250,0.25)]';
	}
	return lowPerfMode
		? 'ring-2 ring-emerald-500/90 border-emerald-500/70'
		: 'ring-2 ring-emerald-500/90 border-emerald-500/70 shadow-[0_0_10px_rgba(16,185,129,0.25)]';
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
			const aSyl = ra[j]?.syl ?? '';
			const bSyl = rb[j]?.syl ?? '';
			if (aSyl !== bSyl) return false;
			if (Boolean(ra[j]?.accent) !== Boolean(rb[j]?.accent)) return false;
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
	fusedBarGroups: FusedGroupState[],
): number {
	const group = findGroupForBar(fusedBarGroups, rowIdx);
	if (group) {
		const pulseSyl = getGroupPulseSyllables(group, customSyllables, baseSyllables, pulseMeterUnlinked);
		const mult = getGroupMultiplier(group, customMultipliers);
		return bpm * (pulseSyl / 4) * mult;
	}
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
	cellStepMasks: CellStepMasks,
	pulseMeterUnlinked: Record<number, boolean>,
	customMultipliers: Record<number, number>,
	fusedBarGroups: FusedGroupState[],
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
					rowMultiplier: findGroupForBar(fusedBarGroups, r)
						? getGroupMultiplier(findGroupForBar(fusedBarGroups, r)!, customMultipliers)
						: (customMultipliers[r] ?? 1),
					effectiveBpm: effectiveBpmForGridRow(
						bpm,
						r,
						syllables,
						customSyllables,
						pulseMeterUnlinked,
						customMultipliers,
						fusedBarGroups,
					),
				},
				cellSyllableOverrides: Object.keys(cellOv).length > 0 ? cellOv : undefined,
				cellStepMasks,
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
		cellStepMasks,
		pulseMeterUnlinked,
		customMultipliers,
		fusedBarGroups,
		rowRuntimeContexts,
		accents,
		deadStartByRow,
		bpm,
	]);
}

/** Ref-filled each App render — stable identity for memoized grid row. */
export type SequencerGridRowActions = {
	cellGestureMutexRef: React.MutableRefObject<{
		key: string;
		phase: 'armed' | 'hold-fired' | 'click-fired';
		pointerId: number | null;
	} | null>;
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
	applyCellIntent: (row: number, cell: number, intent: CellIntent) => void;
	handleCellDivUpdate: (cellKey: string, nextValue: number) => void;
	toggleCellStepMute: (cellKey: string, stepIdx: number) => void;
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
	/** Long-press on multiplier: fused group create / extend / dissolve. */
	onFusedMultiplierHold?: (rowIdx: number) => void;
	/** Long-press on pulse: gati/jati for fused block or single row. */
	onTogglePulseUnlinkedRow?: (rowIdx: number) => void;
	/** Short click multiplier: cycle x1–x4 for fused group or row. */
	onCycleRowMultiplier?: (rowIdx: number) => void;
	fusedBarGroupsRef: React.MutableRefObject<FusedGroupState[]>;
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
	displayRowSylls: number;
	/** Poly lane id (0/1/2) when row is in a fused block; null otherwise. */
	fusedHighlightLaneId: number | null;
	/** Non-leader fused bar: pulse shows slice jati, not block Σ. */
	fusedPulseIsFollower: boolean;
	subdivSig: string;
	rowStepMaskSig: string;
	rowDataHash: string;
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
	isStartBarPickMode: boolean;
	startBarPickHighlight: number | null;
	onStartBarPick: (rIdx: number) => void;
	accentMapVersion: number;
	forceFirstBeatEditorFrames: boolean;
	canShowDefaultTaInNormal: boolean;
	/** Comma-sorted row indices: rows where default first-beat white marker was disabled in editor. */
	firstBeatEditorSuppressedSig: string;
	/** Row col0 is downbeat of fused mega-bar (or ordinary bar when not fused). */
	fusedAllowsFirstBeatTa: boolean;
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
		a.displayRowSylls === b.displayRowSylls &&
		a.fusedHighlightLaneId === b.fusedHighlightLaneId &&
		a.fusedPulseIsFollower === b.fusedPulseIsFollower &&
		a.subdivSig === b.subdivSig &&
		a.rowStepMaskSig === b.rowStepMaskSig &&
		a.rowDataHash === b.rowDataHash &&
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
		a.isStartBarPickMode === b.isStartBarPickMode &&
		a.startBarPickHighlight === b.startBarPickHighlight &&
		a.onStartBarPick === b.onStartBarPick &&
		a.accentMapVersion === b.accentMapVersion &&
		a.forceFirstBeatEditorFrames === b.forceFirstBeatEditorFrames &&
		a.canShowDefaultTaInNormal === b.canShowDefaultTaInNormal &&
		a.firstBeatEditorSuppressedSig === b.firstBeatEditorSuppressedSig &&
		a.fusedAllowsFirstBeatTa === b.fusedAllowsFirstBeatTa &&
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
			displayRowSylls,
			fusedHighlightLaneId,
			fusedPulseIsFollower,
			subdivSig,
			rowStepMaskSig,
			rowDataHash,
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
			isStartBarPickMode,
			startBarPickHighlight,
			onStartBarPick,
			accentMapVersion,
			forceFirstBeatEditorFrames,
			canShowDefaultTaInNormal,
			firstBeatEditorSuppressedSig,
			fusedAllowsFirstBeatTa,
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
		void rowDataHash;
		const rowSubdivs = useMemo(
			() => subdivSig.split(',').map((x) => parseInt(x, 10) || 1),
			[subdivSig],
		);
		const rowMaskBits = useMemo(
			() => rowStepMaskSig.split(','),
			[rowStepMaskSig],
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
		const multFusedHoldTimerRef = useRef<number | null>(null);
		const multFusedHoldFiredRef = useRef(false);
		const barPickHandledAtRef = useRef(0);
		const barPickOverlayRef = useRef<HTMLDivElement>(null);
		const polyStepVoices = polyVoices === 3 ? 3 : 2;
		const isBarPickHighlighted =
			isStartBarPickMode &&
			startBarPickHighlight !== null &&
			(!polyMode
				? rIdx === startBarPickHighlight
				: Math.floor(rIdx / polyStepVoices) === Math.floor(startBarPickHighlight / polyStepVoices));
		const commitBarPickFromRow = () => {
			const now = Date.now();
			if (now - barPickHandledAtRef.current < 300) return;
			barPickHandledAtRef.current = now;
			onStartBarPick(rIdx);
		};
		const commitBarPickFromRowRef = useRef(commitBarPickFromRow);
		commitBarPickFromRowRef.current = commitBarPickFromRow;
		const swallowBarPickEvent = (e: React.SyntheticEvent) => {
			swallowPointerLikeEvent(e);
		};
		const commitBarPickFromOverlay = (e: React.SyntheticEvent) => {
			swallowBarPickEvent(e);
			commitBarPickFromRow();
		};
		useEffect(() => {
			if (!isStartBarPickMode) return;
			const node = barPickOverlayRef.current;
			if (!node) return;
			const swallowNative = (e: Event) => {
				e.stopPropagation();
				if (e.cancelable) e.preventDefault();
			};
			const onTouchEnd = (e: TouchEvent) => {
				swallowNative(e);
				commitBarPickFromRowRef.current();
			};
			node.addEventListener('touchstart', swallowNative, { passive: false, capture: true });
			node.addEventListener('touchmove', swallowNative, { passive: false, capture: true });
			node.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
			node.addEventListener('touchcancel', swallowNative, { passive: false, capture: true });
			return () => {
				node.removeEventListener('touchstart', swallowNative, true);
				node.removeEventListener('touchmove', swallowNative, true);
				node.removeEventListener('touchend', onTouchEnd, true);
				node.removeEventListener('touchcancel', swallowNative, true);
			};
		}, [isStartBarPickMode]);
		return (
			<div
				ref={(el) => setRowEl(absR, el)}
				className={`z-[12] flex w-full items-stretch min-h-0 relative ${
					displayScaleBars > 7 ? 'gap-1 p-1 rounded-lg' : 'gap-1.5 p-1 rounded-xl'
				} ${
					isStartBarPickMode
						? isBarPickHighlighted
							? 'cursor-pointer touch-none border-2 border-emerald-300/90 bg-emerald-950/30 ring-2 ring-emerald-300/55'
							: 'cursor-pointer touch-none border-2 border-emerald-500/50 bg-[#132218] hover:border-emerald-400/70 active:border-emerald-300/80'
						: 'bg-[#161f33] border border-[#23314f]'
				} ${lowPerfMode ? '' : 'transition-colors duration-150'} ${
					isPolyRow
						? isStartBarPickMode
							? 'border-l-4 border-l-emerald-400/55'
							: 'border-l-4 border-l-blue-500/45'
						: ''
				} ${
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
				{/* СТРОГО-НАСТРОГО НЕ ТРОГАТЬ (BAR WIDTH CONTRACT):
				    - BAR ДОЛЖЕН оставаться в нормальном потоке: `w-full` + обычный border.
				    - CELLS (внутренние кнопки) НЕ править для фикса правой границы BAR.
				    - НЕЛЬЗЯ возвращать `translateX/Y`, negative offsets, fake extension-layer.
				    - НЕЛЬЗЯ добавлять правые gutter-хаки (width-calc/paddingRight/marginRight) на root scroll.
				    Причина: это уже многократно ломало визуальное совпадение правой границы BAR с линией кнопки Eraser. */}
				<div
					className={`flex flex-col gap-1 justify-center w-8 shrink-0 ${
						isStartBarPickMode ? 'pointer-events-none opacity-60' : ''
					}`}
					aria-disabled={isStartBarPickMode}
					{...(isStartBarPickMode ? { inert: true } : {})}
				>
					<button
						type="button"
						disabled={isStartBarPickMode}
						tabIndex={isStartBarPickMode ? -1 : undefined}
						onPointerDown={(e) => {
							if (isStartBarPickMode) return;
							const a = actionsRef.current;
							if (!a) return;
							multFusedHoldFiredRef.current = false;
							if (multFusedHoldTimerRef.current) clearTimeout(multFusedHoldTimerRef.current);
							multFusedHoldTimerRef.current = window.setTimeout(() => {
								multFusedHoldFiredRef.current = true;
								a.onFusedMultiplierHold?.(rIdx);
								triggerHapticPulse(50);
								multFusedHoldTimerRef.current = null;
							}, MULT_FUSED_HOLD_MS);
						}}
						onPointerUp={() => {
							if (multFusedHoldTimerRef.current) {
								clearTimeout(multFusedHoldTimerRef.current);
								multFusedHoldTimerRef.current = null;
							}
						}}
						onPointerCancel={() => {
							if (multFusedHoldTimerRef.current) {
								clearTimeout(multFusedHoldTimerRef.current);
								multFusedHoldTimerRef.current = null;
							}
						}}
						onClick={() => {
							if (isStartBarPickMode) return;
							if (multFusedHoldFiredRef.current) {
								multFusedHoldFiredRef.current = false;
								return;
							}
							const a = actionsRef.current;
							if (!a) return;
							if (a.onCycleRowMultiplier) {
								a.onCycleRowMultiplier(rIdx);
								return;
							}
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
							fusedHighlightLaneId !== null
								? fusedLaneMultiplierRingClasses(fusedHighlightLaneId, lowPerfMode)
								: ''
						} ${
							rowMult === 1
								? 'bg-[#1e2a45] border-[#2f4066] text-slate-300 hover:bg-[#253353] active:bg-[#1a253c]'
								: rowMult === 2
									? `bg-blue-900/40 border-blue-500/50 text-blue-300 ${lowPerfMode ? '' : 'shadow-[inset_0_1px_3px_rgba(59,130,246,0.1)]'}`
									: rowMult === 3
										? `bg-rose-900/40 border-rose-500/50 text-rose-300 ${lowPerfMode ? '' : 'shadow-[inset_0_1px_3px_rgba(244,63,94,0.1)]'}`
										: `bg-amber-900/40 border-amber-500/50 text-amber-200 ${lowPerfMode ? '' : 'shadow-[inset_0_1px_3px_rgba(245,158,11,0.12)]'}`
						}`}
					>
						{stepLabel !== undefined ? (
							stepLabel !== '' ? (
								<span className="absolute top-[2px] left-[3px] text-[7.5px] text-blue-300/80 font-mono pointer-events-none leading-none uppercase">
									{stepLabel}
								</span>
							) : null
						) : (
							<span className="absolute top-[2px] left-[3px] text-[7.5px] text-slate-500 font-mono pointer-events-none leading-none opacity-80">
								{rIdx + 1}
							</span>
						)}
						x{rowMult}
					</button>
					<button
						type="button"
						disabled={isStartBarPickMode}
						tabIndex={isStartBarPickMode ? -1 : undefined}
						onMouseDown={(e) => {
							if (isStartBarPickMode) return;
							// Prevent button focus on click: in an overflow container this may
							// trigger abrupt jump-scroll (especially on lower rows).
							e.preventDefault();
						}}
						onPointerDown={(e) => {
							if (isStartBarPickMode) return;
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
									if (a.onTogglePulseUnlinkedRow) {
										a.onTogglePulseUnlinkedRow(rIdx);
									} else {
										a.setPulseMeterUnlinked((prev) => {
											const nextVal = !prev[rIdx];
											a.onPulseLongPressModeSwitch?.(rIdx, rowSylls, nextVal);
											const next = { ...prev, [rIdx]: nextVal };
											a.pulseMeterUnlinkedRef.current = { ...next };
											return next;
										});
									}
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
									const fusedForRoulette = findGroupForBar(a.fusedBarGroupsRef.current, rIdx);
									const basePulse = fusedForRoulette
										? sumGroupJati(fusedForRoulette, a.customSyllablesRef.current, a.syllables)
										: a.customSyllablesRef.current[rIdx] !== undefined
											? a.customSyllablesRef.current[rIdx]!
											: a.syllables;
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
								const fusedHoldRoulette = findGroupForBar(a.fusedBarGroupsRef.current, rIdx);
								const basePulse = fusedHoldRoulette
									? sumGroupJati(fusedHoldRoulette, a.customSyllablesRef.current, a.syllables)
									: a.customSyllablesRef.current[rIdx] !== undefined
										? a.customSyllablesRef.current[rIdx]!
										: a.syllables;
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
							const fusedGroup = findGroupForBar(a.fusedBarGroupsRef.current, rIdx);
							a.setCustomSyllables((prev) => {
								if (fusedGroup) {
									const { minSum, maxSum } = getFusedGroupJatiSumBounds(fusedGroup);
									const targetSum = Math.max(minSum, Math.min(maxSum, s.basePulse + deltaSteps));
									const patch = distributeFusedGroupJatiSum(
										fusedGroup,
										targetSum,
										prev,
										a.syllables,
										rIdx,
									);
									const out = { ...prev, ...patch };
									a.customSyllablesRef.current = { ...out };
									return out;
								}
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
							if (isStartBarPickMode) return;
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
								const fusedGroup = findGroupForBar(a.fusedBarGroupsRef.current, rIdx);
								if (fusedGroup) {
									const patch = incrementFusedGroupJatiFromBar(
										fusedGroup,
										rIdx,
										prev,
										a.syllables,
									);
									const out = { ...prev, ...patch };
									a.customSyllablesRef.current = { ...out };
									return out;
								}
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
									: fusedPulseIsFollower
										? 'bg-[#1a2238] border-[#2a3d66] text-slate-500'
										: 'bg-[#1e2a45] border-[#2f4066] text-slate-400 hover:bg-[#253353] active:bg-[#1e2a45]'
						}`}
					>
						{displayRowSylls}
					</button>
				</div>
				{/* СТРОГО-НАСТРОГО НЕ ТРОГАТЬ ЭТО МЕСТО: ЭТО CELLS. Их не двигать и не растягивать для калибровки правой стенки.
				    По "первому сообщению" сюда НЕ применять: h-full/-my-1/py-1/top-bottom offsets/translate/right-shift. */}
				<div
					className={`relative flex-1 self-stretch min-w-0 ${isStartBarPickMode ? 'opacity-75' : ''}`}
					aria-disabled={isStartBarPickMode}
				>
					<div className="absolute inset-x-0 -top-[2px] -bottom-[2px] w-full flex gap-1 items-stretch">
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
								fusedAllowsFirstBeatTa &&
								!firstBeatRowSuppressed.has(rIdx) &&
								forceFirstBeatEditorFrames);
						const showLegacyDefaultInNormal =
							cIdx === 0 &&
							!isDead &&
							fusedAllowsFirstBeatTa &&
							forceFirstBeatEditorFrames &&
							canShowDefaultTaInNormal &&
							!firstBeatRowSuppressed.has(rIdx);
						const showNonEditorDing = !isDead && isTaDing;
						const showNonEditorDingWithLegacy = showNonEditorDing || showLegacyDefaultInNormal;
						const isActive = highlightCol === cIdx;
						const subdivs = isDead ? 1 : (rowSubdivs[cIdx] ?? 1);
						const cellLabels = rowCellLabels[cIdx] ?? [];
						const cellMaskBits = rowMaskBits[cIdx] ?? '';
						const cellFullyMuted =
							!isDead &&
							cellMaskBits.length > 0 &&
							!cellMaskBits.includes('1');
						const visualSubdivs = cellFullyMuted ? 1 : subdivs;
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
						const cellShellTransition =
							isPlaying || isActive ? '' : lowPerfMode ? '' : 'transition-all duration-75';
						const cellShellClass = `flex-1 h-full self-stretch flex flex-col items-center justify-center min-w-0 ${
							isStartBarPickMode ? 'pointer-events-none touch-none' : 'touch-pan-y'
						} ${cellShellTransition} ${
							rowSylls > 7 ? 'rounded-md' : 'rounded-xl'
						} ${cellClasses} ${activeEditCell === checkKey ? `ring-2 ring-inset ring-purple-500 z-20 ${lowPerfMode ? '' : 'shadow-purple-500/30'}` : ''}`;
						const cellSubdivPanel = (
							<div
								className={`w-full h-full rounded-[inherit] overflow-hidden ${
									visualSubdivs === 1
										? 'flex items-center justify-center'
										: visualSubdivs === 2
											? 'grid grid-cols-1 grid-rows-2'
											: visualSubdivs === 3
												? 'grid grid-cols-1 grid-rows-3'
												: visualSubdivs === 4
													? 'grid grid-cols-2 grid-rows-2'
													: visualSubdivs <= 6
														? 'grid grid-cols-2 grid-rows-3'
														: 'grid grid-cols-3 grid-rows-3'
								}`}
							>
								{Array.from({ length: visualSubdivs }).map((_, i) => {
									const syl = rowCellLabels[cIdx]?.[i]?.syl ?? '';
									const mutedGlyph = syl === '-' || syl === '–';
									return (
										<span
											key={i}
											data-muted={mutedGlyph ? 'true' : 'false'}
											onClick={(e) => {
												if (isStartBarPickMode) return;
												if (!e.shiftKey) return;
												e.stopPropagation();
												actionsRef.current?.toggleCellStepMute(checkKey, i);
											}}
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
											} ${visualSubdivs > 1 ? 'border-[0.5px] border-[#2f4066]/50' : ''}`}
										>
											{isDead || mutedGlyph ? '' : syl}
										</span>
									);
								})}
							</div>
						);
						if (isStartBarPickMode) {
							return (
								<div
									key={cIdx}
									className={cellShellClass}
									data-bar-pick-cell="true"
									aria-hidden
								>
									{cellSubdivPanel}
								</div>
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
									a.cellGestureMutexRef.current = {
										key: checkKey,
										phase: 'armed',
										pointerId: e.pointerId,
									};
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
										const gesture = a.cellGestureMutexRef.current;
										if (!gesture || gesture.key !== checkKey || gesture.phase !== 'armed') return;
										gesture.phase = 'hold-fired';
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
										if (cellFullyMuted) {
											// Divs=0 long-press must affect only this exact cell.
											// Use per-cell intent path (no row/neighbor side-effects).
											a.applyCellIntent(rIdx, cIdx, { type: 'SET_SUBDIVS', nextSubdivs: 1 });
											return;
										}
										const next = nextSubdivLongPress(subdivs, panelExpanded);
										a.applyCellIntent(rIdx, cIdx, { type: 'LONG_PRESS', nextSubdivs: next });
										a.subdivHoldSessionRef.current = {
											key: checkKey,
											startY: Number.isFinite(armedStartY) ? armedStartY : e.clientY,
											baseSubdiv: next,
											lastDeltaSteps: 0,
											panelExpanded,
										};
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
									const next = stepSubdivByDelta(s.baseSubdiv, deltaSteps, s.panelExpanded);
									a.applyCellIntent(rIdx, cIdx, { type: 'LONG_PRESS', nextSubdivs: next });
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
									const gesture = a.cellGestureMutexRef.current;
									if (gesture?.key === checkKey && gesture.phase === 'click-fired') {
										a.cellGestureMutexRef.current = null;
									}
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
									const gesture = a.cellGestureMutexRef.current;
									if (gesture?.key === checkKey) a.cellGestureMutexRef.current = null;
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
									if (a.holdTimerRef.current) {
										clearTimeout(a.holdTimerRef.current);
										a.holdTimerRef.current = null;
									}
									const gesture = a.cellGestureMutexRef.current;
									if (gesture?.key === checkKey && gesture.phase === 'hold-fired') {
										a.isHoldingRef.current = false;
										a.cellGestureMutexRef.current = null;
										return;
									}
									if (gesture?.key === checkKey) {
										gesture.phase = 'click-fired';
									}
									// Divs=0 cell: allow direct layer edits on single tap.
									// Normal mode -> accent layer; Ta editor -> Ta layer.
									if (cellFullyMuted) {
										if (isTaEditorMode) {
											a.toggleTaDing(rIdx, cIdx);
										} else {
											a.toggleAccent(rIdx, cIdx);
										}
										a.isHoldingRef.current = false;
										a.cellGestureMutexRef.current = null;
										return;
									}
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
										a.cellGestureMutexRef.current = null;
										return;
									}
									a.toggleAccent(rIdx, cIdx);
									a.cellGestureMutexRef.current = null;
								}}
								onContextMenu={(e) => e.preventDefault()}
								className={cellShellClass}
							>
								{cellSubdivPanel}
							</button>
						);
					})}
					</div>
					{isStartBarPickMode ? (
					<div
						ref={barPickOverlayRef}
						className="absolute inset-0 z-50 cursor-pointer touch-none pointer-events-auto"
						aria-label="Pick start bar"
						data-start-bar-pick-overlay="true"
						onPointerDown={swallowBarPickEvent}
						onPointerUp={commitBarPickFromOverlay}
						onClick={swallowBarPickEvent}
					/>
					) : null}
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
	cellStepMasks: CellStepMasks;
	cellConfigs: CellConfigs;
	customMultipliers: Record<number, number>;
	accents: Set<string>;
	taDingKeys: Set<string>;
	pulseMeterUnlinked: Record<number, boolean>;
	fusedBarGroups: FusedGroupState[];
	rowRuntimeContexts: Record<number, RowRuntimeContext>;
	jatiPulseActiveByRow: Record<number, boolean>;
	isPlaying: boolean;
	autoscrollVirtualRowsEnabled: boolean;
	/** Абсолютный индекс строки для роста virtual strip (в диктанте — невидимый бегунок). */
	virtualStripLeadingAbsR: number;
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
	isStartBarPickMode: boolean;
	startBarPickHighlight: number | null;
	onStartBarPick: (rIdx: number) => void;
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
	cellStepMasks,
	cellConfigs,
	customMultipliers,
	accents,
	taDingKeys,
	pulseMeterUnlinked,
	fusedBarGroups,
	rowRuntimeContexts,
	jatiPulseActiveByRow,
	isPlaying,
	autoscrollVirtualRowsEnabled,
	virtualStripLeadingAbsR,
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
	isStartBarPickMode,
	startBarPickHighlight,
	onStartBarPick,
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
		cellStepMasks,
		pulseMeterUnlinked,
		customMultipliers,
		fusedBarGroups,
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

	useEffect(() => {
		if (!isStartBarPickMode) return;
		const gridEl = gridRef.current;
		if (!gridEl) return;
		const isPickOverlay = (target: Element | null) =>
			Boolean(target?.closest('[data-start-bar-pick-overlay="true"]'));
		const shouldBlockGridTarget = (target: Element | null) => {
			if (!target || !gridEl.contains(target)) return false;
			if (isPickOverlay(target)) return false;
			return Boolean(
				target.closest('[data-subdiv-cell-key]') ||
					target.closest('[data-bar-pick-cell="true"]') ||
					target.closest('button'),
			);
		};
		const blockTouch = (e: TouchEvent) => {
			if (!shouldBlockGridTarget(e.target as Element | null)) return;
			e.stopPropagation();
			if (e.cancelable) e.preventDefault();
		};
		const blockClick = (e: MouseEvent) => {
			if (!shouldBlockGridTarget(e.target as Element | null)) return;
			e.stopPropagation();
			e.preventDefault();
		};
		gridEl.addEventListener('touchstart', blockTouch, { capture: true, passive: false });
		gridEl.addEventListener('touchend', blockTouch, { capture: true, passive: false });
		gridEl.addEventListener('click', blockClick, { capture: true });
		return () => {
			gridEl.removeEventListener('touchstart', blockTouch, true);
			gridEl.removeEventListener('touchend', blockTouch, true);
			gridEl.removeEventListener('click', blockClick, true);
		};
	}, [isStartBarPickMode, gridRef]);

	/**
	 * Legacy: while playing with a long strip, duplicate rows for scrolling (playAbsBar grows).
	 * Poly: playhead absR is always 0..bars-1, so duplicates would cause false highlight; keep bars rows only.
	 */
	const virtualRowCount = useMemo(() => {
		if (polyMode || !isPlaying || allBarsFitViewport) return bars;
		if (autoscrollVirtualRowsEnabled) {
			return Math.max(bars, virtualStripLeadingAbsR + displayScaleBars * 2);
		}
		const limitedCycles = 3;
		return bars * limitedCycles;
	}, [
		polyMode,
		isPlaying,
		allBarsFitViewport,
		bars,
		displayScaleBars,
		virtualStripLeadingAbsR,
		autoscrollVirtualRowsEnabled,
	]);
	return (
		<div className="relative flex min-h-0 flex-1 w-full">
			{/* СТРОГО-НАСТРОГО НЕ ТРОГАТЬ (ROOT SCROLL CONTRACT):
			    у scroll-контейнера запрещены внешние right-gutter хаки (paddingRight/marginRight/width-calc)
			    и любые геометрические сдвиги для "дотягивания" BAR.
			    Здесь должен быть только нативный поток: flex-ширина контейнера + overflow-x-hidden. */}
			<div
				ref={gridRef}
				className="relative z-10 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[#2f4066] [&::-webkit-scrollbar-thumb]:rounded-full"
				style={{
					overscrollBehaviorY: 'contain',
					touchAction: 'pan-y',
					scrollbarColor: '#2f4066 transparent',
					scrollbarWidth: 'thin',
					/* Scrollbar-only nudge: move vertical thumb/track 5px to the right. */
					width: 'calc(100% + 5px)',
					paddingRight: '5px',
					marginRight: '-5px',
				}}
			>
				{Array.from({ length: virtualRowCount }).map((_, absR) => {
				const rIdx = absR % bars;
				const rowSylls = customSyllables[rIdx] !== undefined ? customSyllables[rIdx] : syllables;
				const fusedGroup = findGroupForBar(fusedBarGroups, rIdx);
				const displayRowSylls = getDisplayPulseSyllables(rIdx, customSyllables, syllables, fusedGroup);
				const rowCellLabels = rowCellLabelsCache[rIdx] ?? [];
				const rowMult = fusedGroup
					? getGroupMultiplier(fusedGroup, customMultipliers)
					: customMultipliers[rIdx] || 1;
				const fusedHighlightLaneId =
					fusedGroup !== null ? fusedGroup.laneId : null;
				const fusedPulseIsFollower =
					fusedGroup !== null && rIdx !== fusedGroup.bars[0]!;
				const effectiveUseFixedFlex = useFrozenRowHeight || useFixedFlex || (isPlaying && !allBarsFitViewport);
				const subdivSig = Array.from({ length: rowSylls }, (_, c) =>
					String(customSubdivisions[`${rIdx}-${c}`] ?? 1),
				).join(',');
				const stepMaskSig = stepMaskSignatureByRow(rIdx, rowSylls, customSubdivisions, cellStepMasks, cellConfigs);
				const rowDataHash = getRowDataHash(rIdx, rowSylls, customSubdivisions, cellStepMasks, cellConfigs);
				const accentSig = Array.from({ length: rowSylls }, (_, c) =>
					accents.has(`${rIdx}-${c}`) ? '1' : '0',
				).join('');
				const taDingSig = Array.from({ length: rowSylls }, (_, c) =>
					taDingKeys.has(`${rIdx}-${c}`) ? '1' : '0',
				).join('');
				const pulseLeaderRow = fusedGroup ? fusedGroup.bars[0]! : rIdx;
				const pulseUnlinkedRow = fusedGroup
					? Boolean(pulseMeterUnlinked[pulseLeaderRow])
					: Boolean(pulseMeterUnlinked[rIdx]);
				const jatiPulseActiveRow = Boolean(jatiPulseActiveByRow[pulseLeaderRow]);

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
					if (fusedBarGroups.length > 0) {
						const label = formatFusedBarStepLabel(
							getFusedBarStepDisplay(rIdx, fusedBarGroups, bars, false, 2, deadStartByRow),
						);
						stepLabel = label === '' ? '' : label;
					} else if (deadStartByRow[rIdx] === 0) {
						stepLabel = '';
					}
				} else {
					const voiceIdx = rIdx % polyVoices;
					const voiceHighlight = activePositions.find(
						(pos) => pos.voice === voiceIdx && pos.r === rIdx,
					);
					highlightCol =
						isPlaying && voiceHighlight
							? voiceHighlight.c
							: !isPlaying && activePos.r === rIdx
								? activePos.c
								: null;
					const polyV = polyVoices === 3 ? 3 : 2;
					const stepDisplay = getFusedBarStepDisplay(
						rIdx,
						fusedBarGroups,
						bars,
						true,
						polyV,
						deadStartByRow,
					);
					const label = formatFusedBarStepLabel(stepDisplay);
					stepLabel = label === '' ? '' : label;
					isPolyRow = true;
					polyStepTopRule =
						!stepDisplay.hideLabel &&
						stepDisplay.stepNum > 1 &&
						voiceIdx === 0 &&
						!stepDisplay.isFollower;
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
						displayRowSylls={displayRowSylls}
						fusedHighlightLaneId={fusedHighlightLaneId}
						fusedPulseIsFollower={fusedPulseIsFollower}
						subdivSig={subdivSig}
						rowStepMaskSig={stepMaskSig}
						rowDataHash={rowDataHash}
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
						isStartBarPickMode={isStartBarPickMode}
						startBarPickHighlight={startBarPickHighlight}
						onStartBarPick={onStartBarPick}
						accentMapVersion={accentMapVersion}
						forceFirstBeatEditorFrames={forceFirstBeatEditorFrames}
						canShowDefaultTaInNormal={canShowDefaultTaInNormal}
						firstBeatEditorSuppressedSig={firstBeatEditorSuppressedSig}
						fusedAllowsFirstBeatTa={isFusedGroupFirstBeatCell(fusedBarGroups, rIdx, 0)}
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
