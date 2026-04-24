import type { DeadCellsMap } from './randomLogic';

type LaneId = 0 | 1 | 2;
type LaneSetMap = Record<LaneId, Set<string>>;

function laneForRow(row: number, voices: 2 | 3 | 4): LaneId {
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

