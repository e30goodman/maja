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
	if (prev === 'slow') {
		return nps > T.slowToMedium ? 'medium' : 'slow';
	}
	if (prev === 'fast') {
		return nps < T.fastToMedium ? 'medium' : 'fast';
	}
	if (nps < T.mediumToSlow) return 'slow';
	if (nps > T.mediumToFast) return 'fast';
	return 'medium';
}

/** Fetch syllables array for a given Gati/Kalam; `gati` clamped to [1..9]. */
export function getSyllablesForGati(gati: number, kalam: Kalam): string[] {
	const g = Math.min(9, Math.max(1, Math.floor(gati))) as Gati;
	return KONNAKOL_DICTIONARY[g][kalam];
}

/**
 * Build a syllable array for a bar-level segment longer than 9 cells by greedy decomposition
 * into blocks of size ≤9 (priority 9→8→7→6→5→4→3→2→1). Blocks use the same Kalam.
 * Example: segLen=12, kalam=slow → Dict[9] + Dict[3] = 9+3 = 12 syllables.
 */
export function composeLongBar(segLen: number, kalam: Kalam): string[] {
	if (!Number.isFinite(segLen) || segLen <= 0) return [];
	if (segLen <= 9) return getSyllablesForGati(segLen, kalam);
	const out: string[] = [];
	let remaining = Math.floor(segLen);
	while (remaining > 0) {
		const chunk = Math.min(9, remaining) as Gati;
		out.push(...KONNAKOL_DICTIONARY[chunk][kalam]);
		remaining -= chunk;
	}
	return out;
}

/**
 * Подписи по клеткам такта (row-level).
 *
 * Input:
 * - `rowSyllCount`: общее число клеток в ряду (визуальная длина).
 * - `customSubdivs`: per-cell Gati (поддолей) по ключу `${rowIdx}-${cellIdx}`.
 * - `rowIdx`: индекс ряда (используется только для построения ключей `customSubdivs` и `kalamMap`).
 * - `opts.bpm`: BPM доли для расчёта NPS и выбора Kalam (default 60).
 * - `opts.deadStart`: индекс первой мёртвой клетки (1..rowSyllCount). Мёртвые клетки хвоста
 *   получают пустой массив меток; инвариант `labels.length === rowSyllCount`.
 * - `opts.kalamMap`: состояние хистерезиса Kalam per-cell/per-segment; мутируется in-place
 *   (новые ключи добавляются, старые caller подчищает по нужде).
 *
 * Правила:
 * - Клетка с `subdivs > 1` — локальная фраза, Gati=subdivs, Kalam по BPM × subdivs / 60.
 * - Смежные клетки с `subdivs === 1` — Sarva Laghu сегмент, виртуальный Gati = segLen,
 *   Kalam по BPM × segLen / 60. При segLen > 9 — композиция {@link composeLongBar}.
 * - Sandhi на стыках клеток не применяется (streaming-form словарь уже фонетически чист).
 */
export function buildRowCellSyllableLabels(
	rowSyllCount: number,
	customSubdivs: Record<string, number>,
	rowIdx: number,
	opts?: {
		bpm?: number;
		deadStart?: number;
		kalamMap?: KalamMap;
		/** Optional collector: функция пишет сюда каждый touched key, caller может GC-нуть стейл. */
		touchedKeys?: Set<string>;
	},
): string[][] {
	const bpm = typeof opts?.bpm === 'number' && opts.bpm > 0 ? opts.bpm : 60;
	const rawDead = opts?.deadStart;
	const dead =
		typeof rawDead === 'number' && rawDead >= 0 && rawDead <= rowSyllCount
			? Math.floor(rawDead)
			: rowSyllCount;
	const kalamMap = opts?.kalamMap;
	const touched = opts?.touchedKeys;

	const out: string[][] = [];
	if (rowSyllCount <= 0) return out;

	const normalizedSubdivs: number[] = [];
	for (let cIdx = 0; cIdx < rowSyllCount; cIdx++) {
		const raw = customSubdivs[`${rowIdx}-${cIdx}`];
		const sd = Math.min(9, Math.max(1, typeof raw === 'number' && raw >= 1 ? raw : 1));
		normalizedSubdivs.push(sd);
	}

	const pickAndRemember = (key: string, nps: number): Kalam => {
		const prev = kalamMap?.get(key);
		const next = pickKalam(nps, prev);
		kalamMap?.set(key, next);
		touched?.add(key);
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

		if (subdivs > 1) {
			const key = `${rowIdx}-c${cIdx}`;
			const kalam = pickAndRemember(key, computeNps(bpm, subdivs));
			out.push(getSyllablesForGati(subdivs, kalam).slice());
			cIdx++;
			continue;
		}

		const segStart = cIdx;
		while (cIdx < dead && (normalizedSubdivs[cIdx] ?? 1) === 1) cIdx++;
		const segLen = cIdx - segStart;
		const key = `${rowIdx}-seg${segStart}`;
		const kalam = pickAndRemember(key, computeNps(bpm, segLen));
		const phrase = segLen <= 9 ? getSyllablesForGati(segLen, kalam) : composeLongBar(segLen, kalam);
		for (let i = 0; i < segLen; i++) {
			out.push([phrase[i] ?? 'Ta']);
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

	if (pseudoSylls >= 20) return 'text-[6px] font-black tracking-tighter leading-none';
	if (pseudoSylls >= 14) return 'text-[7px] font-black tracking-tighter leading-none';
	if (pseudoSylls >= 12) return 'text-[8px] font-extrabold tracking-tight leading-none';
	if (pseudoSylls >= 9) return 'text-[9px] font-extrabold tracking-tight leading-none';
	if (pseudoSylls >= 7) return 'text-[10px] font-bold tracking-tight leading-none';
	if (pseudoSylls >= 5) return 'text-[11px] font-bold tracking-normal leading-none';
	return 'text-sm font-bold tracking-wide leading-none';
}
