export type CellStepMasks = Record<string, boolean[]>;
export type CellConfig = {
	subdivs: number;
	mask: boolean[];
	isMuted: boolean;
};
export type CellConfigs = Record<string, CellConfig>;
export type CellIntent =
	| { type: 'SLIDER_TO_ZERO' }
	| { type: 'LONG_PRESS'; nextSubdivs: number }
	| { type: 'SET_SUBDIVS'; nextSubdivs: number }
	| { type: 'TOGGLE_SUBSTEP'; stepIdx: number }
	| { type: 'RESET_MASK' };

function clampSubdivs(subdivs: number): number {
	if (!Number.isFinite(subdivs)) return 1;
	return Math.max(1, Math.min(9, Math.floor(subdivs)));
}

function normalizeMaskForSubdivs(mask: boolean[] | undefined, safeSubdivs: number): boolean[] {
	const base = Array.isArray(mask) ? mask.map((v) => Boolean(v)).slice(0, 9) : [];
	if (base.length >= safeSubdivs) return base.slice(0, safeSubdivs);
	return base.concat(Array.from({ length: safeSubdivs - base.length }, () => true));
}

export function normalizeCellConfig(config: CellConfig): CellConfig {
	const safeSubdivs = clampSubdivs(config.subdivs);
	const normalizedMask = normalizeMaskForSubdivs(config.mask, safeSubdivs);
	const isMuted = config.isMuted === true || normalizedMask.every((v) => v === false);
	return {
		subdivs: safeSubdivs,
		mask: isMuted ? makeAllFalseMask(safeSubdivs) : normalizedMask,
		isMuted,
	};
}

export function ensureCellConfig(
	cellKey: string,
	fallbackSubdivs: number,
	cellConfigs: CellConfigs | undefined,
	legacyMasks?: CellStepMasks,
): CellConfig {
	const safeSubdivs = clampSubdivs(fallbackSubdivs);
	const fromConfig = cellConfigs?.[cellKey];
	if (fromConfig) return normalizeCellConfig(fromConfig);
	const legacyMask = resolveEffectiveStepMask(cellKey, safeSubdivs, legacyMasks);
	const legacyMuted = legacyMask.every((v) => v === false);
	return {
		subdivs: safeSubdivs,
		mask: legacyMuted ? makeAllFalseMask(safeSubdivs) : legacyMask,
		isMuted: legacyMuted,
	};
}

export function buildCellConfigsFromLegacy(
	customSubdivs: Record<string, number>,
	cellStepMasks: CellStepMasks,
): CellConfigs {
	const keys = new Set<string>([...Object.keys(customSubdivs), ...Object.keys(cellStepMasks)]);
	const out: CellConfigs = {};
	for (const cellKey of keys) {
		const safeSubdivs = clampSubdivs(customSubdivs[cellKey] ?? 1);
		out[cellKey] = ensureCellConfig(cellKey, safeSubdivs, undefined, cellStepMasks);
	}
	return out;
}

export function splitCellConfigsToLegacy(cellConfigs: CellConfigs): {
	customSubdivs: Record<string, number>;
	cellStepMasks: CellStepMasks;
} {
	const customSubdivs: Record<string, number> = {};
	const cellStepMasks: CellStepMasks = {};
	for (const [cellKey, rawConfig] of Object.entries(cellConfigs)) {
		const config = normalizeCellConfig(rawConfig);
		if (config.subdivs !== 1) customSubdivs[cellKey] = config.subdivs;
		if (!isAllTrueMask(config.mask)) cellStepMasks[cellKey] = config.mask.slice();
	}
	return { customSubdivs, cellStepMasks };
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
	cellConfigs?: CellConfigs,
): boolean[] {
	const safeSubdivs = clampSubdivs(subdivs);
	const fromConfig = cellConfigs?.[cellKey];
	if (fromConfig) {
		const normalized = normalizeCellConfig(fromConfig);
		if (normalized.subdivs === safeSubdivs) return normalized.mask.slice();
		const resized = normalizeMaskForSubdivs(normalized.mask, safeSubdivs);
		if (normalized.isMuted) return makeAllFalseMask(safeSubdivs);
		return resized;
	}
	const stored = cellStepMasks?.[cellKey];
	if (!Array.isArray(stored) || stored.length <= 0) {
		return Array.from({ length: safeSubdivs }, () => true);
	}
	return normalizeMaskForSubdivs(stored, safeSubdivs);
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
	cellConfigs?: CellConfigs,
): string {
	const parts: string[] = [];
	for (let c = 0; c < rowSyllCount; c++) {
		const key = `${rowIdx}-${c}`;
		const subdivs = customSubdivs[key] ?? 1;
		const mask = resolveEffectiveStepMask(key, subdivs, cellStepMasks, cellConfigs);
		parts.push(mask.map((v) => (v ? '1' : '0')).join(''));
	}
	return parts.join(',');
}

export function getRowDataHash(
	rowIdx: number,
	rowSyllCount: number,
	customSubdivs: Record<string, number>,
	cellStepMasks: CellStepMasks,
	cellConfigs?: CellConfigs,
): string {
	const parts: string[] = [];
	for (let c = 0; c < rowSyllCount; c++) {
		const cellKey = `${rowIdx}-${c}`;
		const subdivs = clampSubdivs(customSubdivs[cellKey] ?? cellConfigs?.[cellKey]?.subdivs ?? 1);
		const config = ensureCellConfig(cellKey, subdivs, cellConfigs, cellStepMasks);
		parts.push(`${config.subdivs}:${config.isMuted ? '1' : '0'}:${config.mask.map((v) => (v ? '1' : '0')).join('')}`);
	}
	return parts.join('|');
}

export function applyCellIntentToConfig(base: CellConfig, intent: CellIntent): CellConfig {
	const normalized = normalizeCellConfig(base);
	if (intent.type === 'SLIDER_TO_ZERO') {
		return {
			subdivs: normalized.subdivs,
			mask: makeAllFalseMask(normalized.subdivs),
			isMuted: true,
		};
	}
	if (intent.type === 'SET_SUBDIVS') {
		const safeSubdivs = clampSubdivs(intent.nextSubdivs);
		return normalizeCellConfig({
			subdivs: safeSubdivs,
			mask: Array.from({ length: safeSubdivs }, () => true),
			isMuted: false,
		});
	}
	if (intent.type === 'LONG_PRESS') {
		const safeSubdivs = clampSubdivs(intent.nextSubdivs);
		const shouldUnmute = normalized.isMuted;
		return normalizeCellConfig({
			subdivs: safeSubdivs,
			mask: shouldUnmute ? Array.from({ length: safeSubdivs }, () => true) : normalized.mask,
			isMuted: false,
		});
	}
	if (intent.type === 'TOGGLE_SUBSTEP') {
		const safeSubdivs = normalized.subdivs;
		if (!Number.isFinite(intent.stepIdx) || intent.stepIdx < 0 || intent.stepIdx >= safeSubdivs) {
			return normalized;
		}
		const nextMask = normalized.mask.slice();
		nextMask[intent.stepIdx] = !nextMask[intent.stepIdx];
		return normalizeCellConfig({
			subdivs: safeSubdivs,
			mask: nextMask,
			isMuted: nextMask.every((v) => v === false),
		});
	}
	return normalizeCellConfig({
		subdivs: normalized.subdivs,
		mask: Array.from({ length: normalized.subdivs }, () => true),
		isMuted: false,
	});
}

