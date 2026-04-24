import type { DeadCellsMap } from './randomLogic';

/**
 * bars-domain утилиты для резиза / нормализации state.
 *
 * КОНТРАКТ ДОМЕНОВ (см. TA_LOGIC_GUIDE.md §7.1):
 * - `totalBars` — data domain (источник истины). Все pruning/normalize операции
 *   Ta/accents/snapshot/audio используют ТОЛЬКО этот домен.
 * - `visibleBars`/`virtualBars` — view/render домены: не влияют на Ta-решения,
 *   не используются в этом модуле.
 *
 * Все helper'ы здесь чистые, без React, и предназначены для unit-тестирования.
 */

type LaneId = 0 | 1 | 2;
type LaneSetMap = Record<LaneId, Set<string>>;
type LaneBoolMap = Record<LaneId, boolean>;

export type PolyVoices = 2 | 3 | 4;

function laneForRow(row: number, voices: PolyVoices): LaneId {
	return (voices === 3 ? row % 3 : row % 2) as LaneId;
}

function parseRowFromKey(key: string): number | null {
	const [rowRaw] = key.split('-');
	const row = parseInt(rowRaw ?? '', 10);
	return Number.isFinite(row) ? row : null;
}

export function pruneGridKeySetByBars(input: Set<string>, totalBars: number): Set<string> {
	const next = new Set<string>();
	for (const key of input) {
		const row = parseRowFromKey(key);
		if (row === null || row < 0 || row >= totalBars) continue;
		next.add(key);
	}
	return next;
}

export function pruneLaneSetMapByBars(
	input: LaneSetMap,
	totalBars: number,
	voices: 2 | 3 | 4,
): LaneSetMap {
	const flat = new Set<string>();
	for (const lane of [0, 1, 2] as const) {
		for (const key of input[lane]) {
			const row = parseRowFromKey(key);
			if (row === null || row < 0 || row >= totalBars) continue;
			if (laneForRow(row, voices) !== lane) continue;
			flat.add(key);
		}
	}
	const next: LaneSetMap = { 0: new Set<string>(), 1: new Set<string>(), 2: new Set<string>() };
	for (const key of flat) {
		const row = parseRowFromKey(key);
		if (row === null) continue;
		next[laneForRow(row, voices)].add(key);
	}
	return next;
}

export function pruneSuppressedRowsByBars(input: Set<number>, totalBars: number): Set<number> {
	const next = new Set<number>();
	for (const row of input) {
		if (Number.isFinite(row) && row >= 0 && row < totalBars) next.add(row);
	}
	return next;
}

export function pruneNumericRecordByBars<T>(input: Record<number, T>, totalBars: number): Record<number, T> {
	const next: Record<number, T> = {};
	for (const [rowRaw, value] of Object.entries(input)) {
		const row = parseInt(rowRaw, 10);
		if (!Number.isFinite(row) || row < 0 || row >= totalBars) continue;
		next[row] = value;
	}
	return next;
}

export function pruneDeadCellsByBars(input: DeadCellsMap, totalBars: number): DeadCellsMap {
	return pruneNumericRecordByBars(input as Record<number, DeadCellsMap[number]>, totalBars) as DeadCellsMap;
}

/**
 * Прунинг Record<string, T> с ключом вида `r-c` по `totalBars`
 * (например, `customSubdivisions`). Все записи с `r >= totalBars`, `r < 0`
 * или невалидным ключом удаляются.
 */
export function pruneStringKeyRecordByBars<T>(
	input: Record<string, T>,
	totalBars: number,
): Record<string, T> {
	const next: Record<string, T> = {};
	for (const [key, value] of Object.entries(input)) {
		const row = parseRowFromKey(key);
		if (row === null || row < 0 || row >= totalBars) continue;
		next[key] = value;
	}
	return next;
}

/**
 * Агрегированный row-based state (без UI / audio зависимостей),
 * который полностью управляется data-domain (`totalBars`).
 *
 * Все поля обязаны проходить через `normalizeBarsAndLaneState` перед
 * записью в React state на путях:
 * - resize (`totalBars` слайдер),
 * - snapshot/apply/paste,
 * - clear/reset.
 */
export type BarsDomainState = {
	accents: Set<string>;
	taDingKeys: Set<string>;
	accentsByLane: LaneSetMap;
	taDingKeysByLane: LaneSetMap;
	firstBeatDingSuppressedRows: Set<number>;
	firstBeatAccentByLane: LaneBoolMap;
	deadCells: DeadCellsMap;
	customSyllables: Record<number, number>;
	customMultipliers: Record<number, number>;
	pulseMeterUnlinked: Record<number, boolean>;
	customSubdivisions: Record<string, number>;
};

export type BarsDomainNormalizedReport = {
	prunedAnything: boolean;
	/** Список полей, где был выполнен прунинг (для debug/trace). */
	changedFields: string[];
};

/**
 * Централизованный нормализатор всех row-based полей по `totalBars`.
 *
 * Контракты:
 * - downsize: значения с `r >= totalBars` удаляются.
 * - upsize:   новые строки НЕ получают stale-данные (исходный state не добавляет значений).
 * - poly:     lane-maps чистятся под правило `laneForRow(r, polyVoices)` — защита от ghost Ta.
 * - `firstBeatAccentByLane` и плоские derived set'ы (`accents`/`taDingKeys`)
 *   пересобираются из lane-контейнеров в poly режиме для защиты контракта
 *   "lane — source of truth" (см. TA_LOGIC_GUIDE.md §3).
 *
 * Возвращает новую структуру (без мутации входа) и отчёт для тестов/отладки.
 */
export function normalizeBarsAndLaneState(
	input: BarsDomainState,
	totalBars: number,
	polyVoices: PolyVoices,
	polyMode: boolean,
): { state: BarsDomainState; report: BarsDomainNormalizedReport } {
	const changed: string[] = [];
	const note = (field: string, before: number, after: number) => {
		if (before !== after) changed.push(field);
	};

	const accentsFlat = pruneGridKeySetByBars(input.accents, totalBars);
	note('accents', input.accents.size, accentsFlat.size);

	const taDingFlat = pruneGridKeySetByBars(input.taDingKeys, totalBars);
	note('taDingKeys', input.taDingKeys.size, taDingFlat.size);

	const accentsByLane = pruneLaneSetMapByBars(
		{
			0: new Set(input.accentsByLane[0]),
			1: new Set(input.accentsByLane[1]),
			2: new Set(input.accentsByLane[2]),
		},
		totalBars,
		polyVoices,
	);
	note(
		'accentsByLane',
		input.accentsByLane[0].size + input.accentsByLane[1].size + input.accentsByLane[2].size,
		accentsByLane[0].size + accentsByLane[1].size + accentsByLane[2].size,
	);

	const taDingKeysByLane = pruneLaneSetMapByBars(
		{
			0: new Set(input.taDingKeysByLane[0]),
			1: new Set(input.taDingKeysByLane[1]),
			2: new Set(input.taDingKeysByLane[2]),
		},
		totalBars,
		polyVoices,
	);
	note(
		'taDingKeysByLane',
		input.taDingKeysByLane[0].size + input.taDingKeysByLane[1].size + input.taDingKeysByLane[2].size,
		taDingKeysByLane[0].size + taDingKeysByLane[1].size + taDingKeysByLane[2].size,
	);

	const suppressedRows = pruneSuppressedRowsByBars(input.firstBeatDingSuppressedRows, totalBars);
	note('firstBeatDingSuppressedRows', input.firstBeatDingSuppressedRows.size, suppressedRows.size);

	const deadCells = pruneDeadCellsByBars(input.deadCells, totalBars);
	note(
		'deadCells',
		Object.keys(input.deadCells).length,
		Object.keys(deadCells).length,
	);

	const customSyllables = pruneNumericRecordByBars(input.customSyllables, totalBars);
	note(
		'customSyllables',
		Object.keys(input.customSyllables).length,
		Object.keys(customSyllables).length,
	);

	const customMultipliers = pruneNumericRecordByBars(input.customMultipliers, totalBars);
	note(
		'customMultipliers',
		Object.keys(input.customMultipliers).length,
		Object.keys(customMultipliers).length,
	);

	const pulseMeterUnlinked = pruneNumericRecordByBars(input.pulseMeterUnlinked, totalBars);
	note(
		'pulseMeterUnlinked',
		Object.keys(input.pulseMeterUnlinked).length,
		Object.keys(pulseMeterUnlinked).length,
	);

	const customSubdivisions = pruneStringKeyRecordByBars(input.customSubdivisions, totalBars);
	note(
		'customSubdivisions',
		Object.keys(input.customSubdivisions).length,
		Object.keys(customSubdivisions).length,
	);

	/** firstBeatAccentByLane: не row-based, но участвует в poly-контракте.
	 * Bars-domain не меняет boolean-флаги, только копирует их (иммутабельность).
	 */
	const firstBeatAccentByLane: LaneBoolMap = {
		0: input.firstBeatAccentByLane[0],
		1: input.firstBeatAccentByLane[1],
		2: input.firstBeatAccentByLane[2],
	};

	/**
	 * В poly режиме плоские set'ы должны пересчитываться из lane-контейнеров,
	 * а не наоборот: lane — source of truth.
	 */
	let accents = accentsFlat;
	let taDingKeys = taDingFlat;
	if (polyMode) {
		accents = flattenLaneSetToFlat(accentsByLane, totalBars, polyVoices);
		taDingKeys = flattenLaneSetToFlat(taDingKeysByLane, totalBars, polyVoices);
		note('accents(flat-from-lane)', accentsFlat.size, accents.size);
		note('taDingKeys(flat-from-lane)', taDingFlat.size, taDingKeys.size);
	}

	const state: BarsDomainState = {
		accents,
		taDingKeys,
		accentsByLane,
		taDingKeysByLane,
		firstBeatDingSuppressedRows: suppressedRows,
		firstBeatAccentByLane,
		deadCells,
		customSyllables,
		customMultipliers,
		pulseMeterUnlinked,
		customSubdivisions,
	};

	return {
		state,
		report: {
			prunedAnything: changed.length > 0,
			changedFields: changed,
		},
	};
}

function flattenLaneSetToFlat(
	map: LaneSetMap,
	totalBars: number,
	voices: PolyVoices,
): Set<string> {
	const out = new Set<string>();
	for (const lane of [0, 1, 2] as const) {
		for (const key of map[lane]) {
			const row = parseRowFromKey(key);
			if (row === null || row < 0 || row >= totalBars) continue;
			if (laneForRow(row, voices) !== lane) continue;
			out.add(key);
		}
	}
	return out;
}

