import { resolveEffectiveStepMask, type CellStepMasks } from './stepMask';

export type Kalam = 'slow' | 'medium' | 'fast';
export type Gati = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * Asymmetric hysteresis thresholds for Kalam transitions (NPS = notes per second).
 * Boundaries chosen so UI doesn't thrash on BPM slider near the switching point.
 */
export const KALAM_THRESHOLDS = {
	slowToMedium: 4.4,
	mediumToSlow: 3.6,
	mediumToFast: 8.4,
	fastToMedium: 7.6,
} as const;

/**
 * Streaming-form Konnakol dictionary (Sarva Laghu — continuous flow, no terminal Thom/Num).
 * Indexed by Gati (1..9) then by Kalam (slow/medium/fast).
 * Transitions (Dhi Mi → Ju Nu) happen on fast Kalam to keep articulation clean at high density.
 */
export const KONNAKOL_DICTIONARY: Record<Gati, Record<Kalam, string[]>> = {
	1: { slow: ['Ta'], medium: ['Ta'], fast: ['Ta'] },
	2: { slow: ['Ta', 'Ka'], medium: ['Ta', 'Ka'], fast: ['Ta', 'Ka'] },
	3: { slow: ['Ta', 'Ki', 'Ta'], medium: ['Ta', 'Ki', 'Ta'], fast: ['Ta', 'Ki', 'Ta'] },
	4: {
		slow: ['Ta', 'Ka', 'Dhi', 'Mi'],
		medium: ['Ta', 'Ka', 'Dhi', 'Mi'],
		fast: ['Ta', 'Ka', 'Ju', 'Nu'],
	},
	5: {
		slow: ['Ta', 'Ka', 'Ta', 'Ki', 'Ta'],
		medium: ['Ta', 'Ka', 'Ta', 'Ki', 'Ta'],
		fast: ['Ta', 'Ka', 'Ta', 'Ki', 'Ta'],
	},
	6: {
		slow: ['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ka'],
		medium: ['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ka'],
		fast: ['Ta', 'Ka', 'Ju', 'Nu', 'Ta', 'Ka'],
	},
	7: {
		slow: ['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ki', 'Ta'],
		medium: ['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ki', 'Ta'],
		fast: ['Ta', 'Ka', 'Ju', 'Nu', 'Ta', 'Ki', 'Ta'],
	},
	8: {
		slow: ['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ka', 'Dhi', 'Mi'],
		medium: ['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ka', 'Ju', 'Nu'],
		fast: ['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ka', 'Ju', 'Nu'],
	},
	9: {
		slow: ['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ka', 'Ta', 'Ki', 'Ta'],
		medium: ['Ta', 'Ka', 'Dhi', 'Mi', 'Ta', 'Ka', 'Ta', 'Ki', 'Ta'],
		fast: ['Ta', 'Ka', 'Ju', 'Nu', 'Ta', 'Ka', 'Ta', 'Ki', 'Ta'],
	},
};

export type KalamMap = Map<string, Kalam>;
export type SyllableLabel = { syl: string; accent: boolean };
export type RowRuntimeContext = {
	localJati?: number;
	gatiTargetSub?: number;
	effectiveBpm?: number;
	rowMultiplier?: number;
	roleType?: string;
};
export type LabelTraceEvent = {
	rowIdx: number;
	cellIdx: number;
	key: string;
	subdivs: number;
	nps: number;
	prevKalam?: Kalam;
	nextKalam: Kalam;
	localJati?: number;
	gatiTargetSub?: number;
	roleType?: string;
};

function shouldEnableFastFourChunkAlternation(runtimeCtx?: RowRuntimeContext): boolean {
	const mult = runtimeCtx?.rowMultiplier ?? 1;
	const isDivContext =
		runtimeCtx?.roleType === 'substitution' ||
		(typeof runtimeCtx?.gatiTargetSub === 'number' && runtimeCtx.gatiTargetSub > 1);
	return mult > 1 && isDivContext;
}

/** Notes per second = BPM × phraseLen / 60. `phraseLen` is Gati (inside cell) or segment length (bar-level). */
export function computeNps(bpm: number, phraseLen: number): number {
	if (!Number.isFinite(bpm) || !Number.isFinite(phraseLen) || bpm <= 0 || phraseLen <= 0) return 0;
	return (bpm * phraseLen) / 60;
}

/**
 * Classify Kalam by NPS with asymmetric hysteresis.
 * When `prev` is undefined (first frame), uses symmetric thresholds ≤4.0 slow, ≤8.0 medium, else fast.
 * With `prev` provided, transitions use asymmetric bands from {@link KALAM_THRESHOLDS}.
 */
export function pickKalam(nps: number, prev: Kalam | undefined): Kalam {
	if (prev === undefined) {
		if (nps <= 4.0) return 'slow';
		if (nps <= 8.0) return 'medium';
		return 'fast';
	}
	const T = KALAM_THRESHOLDS;
	if (prev === 'slow') return nps > T.slowToMedium ? 'medium' : 'slow';
	if (prev === 'fast') return nps < T.fastToMedium ? 'medium' : 'fast';
	if (nps < T.mediumToSlow) return 'slow';
	if (nps > T.mediumToFast) return 'fast';
	return 'medium';
}

function delayFastJuNu(kalam: Kalam, runtimeCtx?: RowRuntimeContext): Kalam {
	if (kalam !== 'fast') return kalam;
	if (!shouldEnableFastFourChunkAlternation(runtimeCtx)) return 'medium';
	const mult = runtimeCtx?.rowMultiplier ?? 1;
	const effBpm = runtimeCtx?.effectiveBpm ?? 0;
	if (mult >= 2 && effBpm <= 200) return 'medium';
	return kalam;
}

/** Fetch syllables array for a given Gati/Kalam; `gati` clamped to [1..9]. */
export function getSyllablesForGati(gati: number, kalam: Kalam): string[] {
	const g = Math.min(9, Math.max(1, Math.floor(gati))) as Gati;
	return KONNAKOL_DICTIONARY[g][kalam];
}

/**
 * Build a syllable array for a bar-level segment longer than 9 cells.
 * Strategy:
 * 1) Prefer exact equal-group factorization in musical priority 4 -> 3 -> 5 (groups > 1).
 * 2) Fallback to greedy decomposition into blocks of size <=9 (9 + ... + remainder).
 * Example: segLen=12, kalam=slow -> Dict[4] + Dict[4] + Dict[4].
 */
export function composeLongBar(
	segLen: number,
	kalam: Kalam,
	opts?: { enableFastFourChunkAlternation?: boolean },
): string[] {
	if (!Number.isFinite(segLen) || segLen <= 0) return [];
	if (segLen <= 9) return getSyllablesForGati(segLen, kalam);

	const wholeLen = Math.floor(segLen);
	const allowFastFourChunkAlternation = opts?.enableFastFourChunkAlternation === true;
	const pickChunk = (chunk: Gati, chunkIndex: number): string[] => {
		if (allowFastFourChunkAlternation && kalam === 'fast' && chunk === 4 && chunkIndex % 2 === 1) {
			return KONNAKOL_DICTIONARY[4].medium;
		}
		return KONNAKOL_DICTIONARY[chunk][kalam];
	};
	const factorPriority: Array<4 | 3 | 5> = [4, 3, 5];
	for (const factor of factorPriority) {
		if (wholeLen % factor !== 0) continue;
		const groups = wholeLen / factor;
		if (groups <= 1) continue;
		const out: string[] = [];
		for (let i = 0; i < groups; i++) out.push(...pickChunk(factor, i));
		return out;
	}

	const out: string[] = [];
	let remaining = wholeLen;
	let chunkIndex = 0;
	while (remaining > 0) {
		const chunk = Math.min(9, remaining) as Gati;
		out.push(...pickChunk(chunk, chunkIndex));
		remaining -= chunk;
		chunkIndex++;
	}
	return out;
}

/**
 * Per-cell bar labels (row-level). Stable algorithm with optional accent wrapping.
 */
export function buildRowCellSyllableLabels(
	rowSyllCount: number,
	customSubdivs: Record<string, number>,
	rowIdx: number,
	opts?: {
		bpm?: number;
		deadStart?: number;
		kalamMap?: KalamMap;
		rowRuntimeContext?: RowRuntimeContext;
		touchedKeys?: Set<string>;
		debugTrace?: (event: LabelTraceEvent) => void;
		cellSyllableOverrides?: Record<string, string>;
		accentCells?: Set<number>;
		cellStepMasks?: CellStepMasks;
		isLessonLastRow?: boolean;
		strictByManual?: boolean;
	},
): SyllableLabel[][] {
	const fallbackBpm = typeof opts?.bpm === 'number' && opts.bpm > 0 ? opts.bpm : 60;
	const bpm =
		typeof opts?.rowRuntimeContext?.effectiveBpm === 'number' && opts.rowRuntimeContext.effectiveBpm > 0
			? opts.rowRuntimeContext.effectiveBpm
			: fallbackBpm;
	const rawDead = opts?.deadStart;
	const dead =
		typeof rawDead === 'number' && rawDead >= 0 && rawDead <= rowSyllCount
			? Math.floor(rawDead)
			: rowSyllCount;
	const kalamMap = opts?.kalamMap;
	const touched = opts?.touchedKeys;
	const accentCells = opts?.accentCells;
	const overrides = opts?.cellSyllableOverrides;
	const runtimeCtx = opts?.rowRuntimeContext;
	const debugTrace = opts?.debugTrace;

	const out: SyllableLabel[][] = [];
	if (rowSyllCount <= 0) return out;

	const normalizedSubdivs: number[] = [];
	const mutedCells: boolean[] = [];
	for (let cIdx = 0; cIdx < rowSyllCount; cIdx++) {
		const raw = customSubdivs[`${rowIdx}-${cIdx}`];
		const sd = Math.min(9, Math.max(1, typeof raw === 'number' && raw >= 1 ? raw : 1));
		normalizedSubdivs.push(sd);
		const mask = resolveEffectiveStepMask(`${rowIdx}-${cIdx}`, sd, opts?.cellStepMasks);
		mutedCells.push(mask.every((v) => v === false));
	}

	const withAccent = (cellIdx: number, phrase: string[]): SyllableLabel[] => {
		const accent = accentCells?.has(cellIdx) === true;
		return phrase.map((s) => ({ syl: s, accent }));
	};
	const resolveCellSyllable = (cellIdx: number, fallback: string, stepMask: boolean[]): string => {
		if (stepMask[0] === false) return '-';
		const override = overrides?.[`${rowIdx}-${cellIdx}`];
		if (typeof override === 'string' && override.trim().length > 0) return override.trim();
		return fallback;
	};

	const pickAndRemember = (key: string, nps: number, cellIdx: number, subdivs: number): Kalam => {
		const prev = kalamMap?.get(key);
		const picked = pickKalam(nps, prev);
		const next = delayFastJuNu(picked, runtimeCtx);
		kalamMap?.set(key, next);
		touched?.add(key);
		debugTrace?.({
			rowIdx,
			cellIdx,
			key,
			subdivs,
			nps,
			prevKalam: prev,
			nextKalam: next,
			localJati: runtimeCtx?.localJati,
			gatiTargetSub: runtimeCtx?.gatiTargetSub,
			roleType: runtimeCtx?.roleType,
		});
		return next;
	};

	let cIdx = 0;
	while (cIdx < rowSyllCount) {
		if (cIdx >= dead) {
			out.push([]);
			cIdx++;
			continue;
		}
		const subdivs = normalizedSubdivs[cIdx] ?? 1;
		if (mutedCells[cIdx] === true && subdivs > 1) {
			// Divs=0 (fully muted cell): skip from phrase flow and keep cell visually empty.
			out.push([]);
			cIdx++;
			continue;
		}
		const cellKey = `${rowIdx}-${cIdx}`;
		const stepMask = resolveEffectiveStepMask(cellKey, subdivs, opts?.cellStepMasks);

		if (subdivs > 1) {
			const key = `${rowIdx}-c${cIdx}`;
			const kalam = pickAndRemember(key, computeNps(bpm, subdivs), cIdx, subdivs);
			const phrase = getSyllablesForGati(subdivs, kalam)
				.slice()
				.map((syl, idx) => (stepMask[idx] === false ? '-' : syl));
			out.push(withAccent(cIdx, phrase));
			cIdx++;
			continue;
		}
		const segStart = cIdx;
		while (cIdx < dead && (normalizedSubdivs[cIdx] ?? 1) === 1) cIdx++;
		const segEnd = cIdx;
		const segActiveCells: number[] = [];
		for (let i = segStart; i < segEnd; i++) {
			if (mutedCells[i] !== true) segActiveCells.push(i);
		}
		const segLen = segActiveCells.length;
		if (segLen <= 0) {
			for (let i = segStart; i < segEnd; i++) out.push([]);
			continue;
		}
		const key = `${rowIdx}-seg${segStart}`;
		const kalam = pickAndRemember(key, computeNps(bpm, segLen), segStart, segLen);
		const phrase =
			segLen <= 9
				? getSyllablesForGati(segLen, kalam)
				: composeLongBar(segLen, kalam, {
						enableFastFourChunkAlternation: shouldEnableFastFourChunkAlternation(runtimeCtx),
				  });
		let phraseIdx = 0;
		for (let segCellIdx = segStart; segCellIdx < segEnd; segCellIdx++) {
			if (mutedCells[segCellIdx] === true) {
				out.push([]);
				continue;
			}
			const segCellKey = `${rowIdx}-${segCellIdx}`;
			const mask = resolveEffectiveStepMask(segCellKey, 1, opts?.cellStepMasks);
			const syl = resolveCellSyllable(segCellIdx, phrase[phraseIdx] ?? 'Ta', mask);
			phraseIdx++;
			out.push(withAccent(segCellIdx, [syl]));
		}
	}

	return out;
}

/** Dynamic text sizing based on grid density (pure). */
export function getSyllableStyles(rowSylls: number, cellSubdivs: number = 1): string {
	let pseudoSylls = rowSylls;
	if (cellSubdivs === 2) pseudoSylls = rowSylls * 1.5;
	else if (cellSubdivs === 3) pseudoSylls = rowSylls * 2;
	else if (cellSubdivs === 4) pseudoSylls = rowSylls * 2;
	else if (cellSubdivs >= 5 && cellSubdivs <= 6) pseudoSylls = rowSylls * 2.5;
	else if (cellSubdivs >= 7) pseudoSylls = rowSylls * 3;

	if (pseudoSylls >= 20) return 'text-[6px] font-semibold tracking-tighter leading-none';
	if (pseudoSylls >= 14) return 'text-[7px] font-semibold tracking-tighter leading-none';
	if (pseudoSylls >= 12) return 'text-[8px] font-medium tracking-tight leading-none';
	if (pseudoSylls >= 9) return 'text-[9px] font-medium tracking-tight leading-none';
	if (pseudoSylls >= 7) return 'text-[10px] font-medium tracking-tight leading-none';
	if (pseudoSylls >= 5) return 'text-[11px] font-medium tracking-normal leading-none';
	return 'text-sm font-medium tracking-wide leading-none';
}
