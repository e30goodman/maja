export type CellStepMasks = Record<string, boolean[]>;

function clampSubdivs(subdivs: number): number {
	if (!Number.isFinite(subdivs)) return 1;
	return Math.max(1, Math.min(9, Math.floor(subdivs)));
}

export function normalizeStoredStepMask(mask: unknown): boolean[] | null {
	if (!Array.isArray(mask)) return null;
	const out = mask.map((v) => Boolean(v)).slice(0, 9);
	return out.length > 0 ? out : null;
}

export function resolveEffectiveStepMask(
	cellKey: string,
	subdivs: number,
	cellStepMasks: CellStepMasks | undefined,
): boolean[] {
	const safeSubdivs = clampSubdivs(subdivs);
	const stored = cellStepMasks?.[cellKey];
	if (!Array.isArray(stored) || stored.length <= 0) {
		return Array.from({ length: safeSubdivs }, () => true);
	}
	const normalized = stored.map((v) => Boolean(v)).slice(0, 9);
	if (normalized.length >= safeSubdivs) return normalized.slice(0, safeSubdivs);
	return normalized.concat(Array.from({ length: safeSubdivs - normalized.length }, () => true));
}

export function makeAllFalseMask(subdivs: number): boolean[] {
	return Array.from({ length: clampSubdivs(subdivs) }, () => false);
}

export function isAllTrueMask(mask: boolean[]): boolean {
	return mask.every((v) => v === true);
}

export function toggleStepMute(
	cellKey: string,
	subdivs: number,
	stepIdx: number,
	cellStepMasks: CellStepMasks,
): CellStepMasks {
	const safeSubdivs = clampSubdivs(subdivs);
	if (!Number.isFinite(stepIdx) || stepIdx < 0 || stepIdx >= safeSubdivs) return cellStepMasks;
	const current = resolveEffectiveStepMask(cellKey, safeSubdivs, cellStepMasks);
	current[stepIdx] = !current[stepIdx];
	if (isAllTrueMask(current)) {
		const next = { ...cellStepMasks };
		delete next[cellKey];
		return next;
	}
	return { ...cellStepMasks, [cellKey]: current };
}

export function stepMaskSignatureByRow(
	rowIdx: number,
	rowSyllCount: number,
	customSubdivs: Record<string, number>,
	cellStepMasks: CellStepMasks,
): string {
	const parts: string[] = [];
	for (let c = 0; c < rowSyllCount; c++) {
		const key = `${rowIdx}-${c}`;
		const subdivs = customSubdivs[key] ?? 1;
		const mask = resolveEffectiveStepMask(key, subdivs, cellStepMasks);
		parts.push(mask.map((v) => (v ? '1' : '0')).join(''));
	}
	return parts.join(',');
}

