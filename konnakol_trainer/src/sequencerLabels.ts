export const KONNAKOL_PYRAMID: Record<number, string[]> = {
	1: ['Ta'],
	2: ['Ta', 'Ka'],
	3: ['Ta', 'Ki', 'Ta'],
	4: ['Ta', 'Ka', 'Di', 'Mi'],
	/** После «Ta Ka» два слога не Ki Ta (как в триоле), а Ta Ka — дуплекс вместо хвоста триоли. */
	5: ['Ta', 'Ka', 'Ta', 'Ta', 'Ka'],
	6: ['Ta', 'Ka', 'Di', 'Mi', 'Ta', 'Ka'],
	7: ['Ta', 'Ka', 'Di', 'Mi', 'Ta', 'Ta', 'Ka'],
	8: ['Ta', 'Ka', 'Di', 'Mi', 'Ta', 'Ka', 'Ju', 'Nu'],
	9: ['Ta', 'Ka', 'Di', 'Mi', 'Ta', 'Ka', 'Ta', 'Ta', 'Ka'],
};

/**
 * Подписи по клеткам: при **subdivs === 1** — паттерн такта + anti-repeat по хвосту (как в legacy; см. `KONNAKOL_PYRAMID`).
 * При **subdivs > 1** — только фиксированная пирамида по числу поддолей (`Ta Ka`, `Ta Ka Dhi Mi`, …),
 * логика сдвига по такту **не** влияет на разбивку клетки.
 * После клетки **4** (Ta Ka Dhi Mi → хвост Mi) следующая клетка с **subdivs === 1** не показывает одну Mi — сразу **Ta**.
 */
export function buildRowCellSyllableLabels(
	rowSyllCount: number,
	customSubdivs: Record<string, number>,
	rowIdx: number,
): string[][] {
	const seq = KONNAKOL_PYRAMID[rowSyllCount] ?? KONNAKOL_PYRAMID[1]!;
	const out: string[][] = [];
	if (seq.length === 0) {
		for (let cIdx = 0; cIdx < rowSyllCount; cIdx++) {
			out.push(['Ta']);
		}
		return out;
	}

	let lastTail: string | null = null;
	/** Предыдущая клетка была именно 4 поддоли (Ta Ka Dhi Mi), хвост Mi. */
	let prevCellWasFourPulse = false;
	for (let cIdx = 0; cIdx < rowSyllCount; cIdx++) {
		const raw = customSubdivs[`${rowIdx}-${cIdx}`];
		const subdivs = Math.min(9, Math.max(1, typeof raw === 'number' && raw >= 1 ? raw : 1));

		if (subdivs > 1) {
			const inner = KONNAKOL_PYRAMID[subdivs] ?? KONNAKOL_PYRAMID[1]!;
			const labels: string[] = [];
			for (let j = 0; j < subdivs; j++) {
				labels.push(inner[j] ?? inner[inner.length - 1] ?? 'Ta');
			}
			out.push(labels);
			lastTail = labels[labels.length - 1] ?? 'Ta';
			prevCellWasFourPulse = subdivs === 4;
			continue;
		}

		const afterTaKaDhiMiCell = prevCellWasFourPulse;
		prevCellWasFourPulse = false;

		const isLastBeat = cIdx === rowSyllCount - 1;
		let start = cIdx % seq.length;
		const firstSyll = seq[start] ?? 'Ta';
		if (!isLastBeat && lastTail != null && firstSyll === lastTail) {
			start = (start - 1 + seq.length) % seq.length;
		}
		let t = seq[start] ?? 'Ta';
		if (afterTaKaDhiMiCell && t === 'Mi') {
			t = 'Ta';
		}
		out.push([t]);
		lastTail = t;
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
