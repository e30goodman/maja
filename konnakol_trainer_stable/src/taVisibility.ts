import type { DeadCellsMap } from './randomLogic';

type TaVisibilityInput = {
	totalBars: number;
	accentMapVersion: number;
	firstBeatDingSuppressedRows: Set<number>;
	accentsUi: Set<string>;
	taDingKeysUi: Set<string>;
	customSyllables: Record<number, number>;
	syllables: number;
	deadCells: DeadCellsMap;
};

type TaVisibilityDerived = {
	hasAnyVisibleAccentOutsideFirstBeat: boolean;
	hasAnyExplicitTaOutsideFirstBeat: boolean;
	isTaGridAtDefault: boolean;
	canShowDefaultTaInNormal: boolean;
};

function hasAnyValidNonFirstBeatKey(
	keys: Set<string>,
	totalBars: number,
	customSyllables: Record<number, number>,
	syllables: number,
	deadCells: DeadCellsMap,
): boolean {
	for (const key of keys) {
		const [rRaw, cRaw] = key.split('-');
		const r = parseInt(rRaw ?? '', 10);
		const c = parseInt(cRaw ?? '', 10);
		if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
		if (r < 0 || r >= totalBars) continue;
		if (c <= 0) continue;
		const rowSylls = customSyllables[r] !== undefined ? customSyllables[r]! : syllables;
		if (c >= rowSylls) continue;
		const deadStart = deadCells[r]?.deadStart;
		if (typeof deadStart === 'number' && c >= deadStart) continue;
		return true;
	}
	return false;
}

export function deriveTaNormalVisibility(input: TaVisibilityInput): TaVisibilityDerived {
	const hasAnyVisibleAccentOutsideFirstBeat = hasAnyValidNonFirstBeatKey(
		input.accentsUi,
		input.totalBars,
		input.customSyllables,
		input.syllables,
		input.deadCells,
	);
	const hasAnyExplicitTaOutsideFirstBeat = hasAnyValidNonFirstBeatKey(
		input.taDingKeysUi,
		input.totalBars,
		input.customSyllables,
		input.syllables,
		input.deadCells,
	);
	const isTaGridAtDefault =
		input.accentMapVersion === 0 &&
		input.firstBeatDingSuppressedRows.size === 0 &&
		!hasAnyExplicitTaOutsideFirstBeat;
	const canShowDefaultTaInNormal =
		input.accentMapVersion === 1 ||
		input.firstBeatDingSuppressedRows.size > 0 ||
		hasAnyExplicitTaOutsideFirstBeat;
	return {
		hasAnyVisibleAccentOutsideFirstBeat,
		hasAnyExplicitTaOutsideFirstBeat,
		isTaGridAtDefault,
		canShowDefaultTaInNormal,
	};
}
