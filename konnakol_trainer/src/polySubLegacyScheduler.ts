/**
 * Poly «sub_legacy»: N независимых временных линий (по одной на голос).
 * Семантика: каждая линия — как legacy по своим тактам; общая только стартовая точка времени,
 * далее линии дрейфуют, если длины тактов различаются (нет chunk-alignment и паузы «короткого» голоса).
 */

export type PolyVoicesCount = 2 | 3;

/** `voice` = laneId той же линии, что и слот UI в `polySubLegacyLaneIndicatorStore` / `activePositions`. */
export type PolySubLegacyEmit = (
	bar: number,
	c: number,
	absR: number,
	t: number,
	voice: number,
	step: number,
	dBar: number,
) => void;

export type PolySubLegacyDeps = {
	polyVoices: () => PolyVoicesCount;
	barCount: () => number;
	getBarTimeWindowSeconds: (bar: number) => number;
	getRowSyllables: (bar: number) => number;
	getDeadStart: (bar: number) => number | undefined;
	emit: PolySubLegacyEmit;
	/** Lane 0 завершила полный круг по своим тактам (для randomizer / wrap паттерна). `prevBar` — такт, с которого ушли в ноль первого такта линии. */
	onLane0PatternWrap?: (prevBar: number) => void;
};

/** Совместимо с прежним `nextPolyCell` в schedulePolyStep: следующий индекс клетки (0 = рестарт внутри такта). */
export function nextPolyCell(c: number, rowSyl: number, deadStart: number | undefined): number {
	const n = c + 1;
	if (n >= rowSyl) return 0;
	if (typeof deadStart === 'number' && n >= deadStart) return 0;
	return n;
}

/**
 * Различает: (а) мёртвые → клетка 0 того же такта; (б) конец такта по слогам → клетка 0 и `advanceBar`.
 * В `fillLookahead` после emit к **следующему такту линии** нужно переходить при любом «мёртвом» возврате
 * на клетку 0 (`advanceBar === false`, `nextC === 0`), в т.ч. когда жива только c=0 (`deadStart === 1`):
 * иначе `c !== 0` в условии вечно держит линию на этом такте.
 */
export function advancePolyLaneAfterEmit(
	c: number,
	rowSyl: number,
	deadStart: number | undefined,
): { nextC: number; advanceBar: boolean } {
	const n = c + 1;
	if (typeof deadStart === 'number' && n >= deadStart) {
		return { nextC: 0, advanceBar: false };
	}
	if (n >= rowSyl) {
		return { nextC: 0, advanceBar: true };
	}
	return { nextC: n, advanceBar: false };
}

/**
 * `barIdx % V === laneId` — согласовано с нарезкой `buildPolyChunks` (подряд V тактов в чанке).
 */
export function buildLaneBarIndices(barCount: number, polyVoices: PolyVoicesCount): number[][] {
	const V = polyVoices === 3 ? 3 : 2;
	const lanes: number[][] = Array.from({ length: V }, () => []);
	for (let b = 0; b < barCount; b++) {
		lanes[b % V]!.push(b);
	}
	return lanes;
}

export type PolyLaneState = {
	laneId: number;
	barIndices: number[];
	barCursor: number;
	cellCursor: number;
	nextTime: number;
};

export type PolySubLegacyScheduler = {
	lanes: PolyLaneState[];
	reset: (startTime: number) => void;
	fillLookahead: (horizon: number) => void;
	rebuildLanes: (startTime: number) => void;
	getMinNextTime: () => number;
};

export function createPolySubLegacyScheduler(deps: PolySubLegacyDeps): PolySubLegacyScheduler {
	let lanes: PolyLaneState[] = [];

	const rebuildLaneArrays = () => {
		const bc = Math.max(0, Math.floor(deps.barCount()));
		const V = deps.polyVoices() === 3 ? 3 : 2;
		const idx = buildLaneBarIndices(bc, deps.polyVoices());
		lanes = idx.map((barIndices, laneId) => ({
			laneId,
			barIndices,
			barCursor: 0,
			cellCursor: 0,
			nextTime: 0,
		}));
	};

	const reset = (startTime: number) => {
		rebuildLaneArrays();
		for (const L of lanes) {
			L.barCursor = 0;
			L.cellCursor = 0;
			L.nextTime = startTime;
		}
	};

	const rebuildLanes = (startTime: number) => {
		const nonemptyOld = lanes.filter((l) => l.barIndices.length > 0);
		const oldMin =
			nonemptyOld.length > 0 ? Math.min(...nonemptyOld.map((l) => l.nextTime)) : startTime;
		const t0 = Math.max(startTime, oldMin);
		rebuildLaneArrays();
		for (const L of lanes) {
			L.barCursor = Math.min(L.barCursor, Math.max(0, L.barIndices.length - 1));
			L.cellCursor = 0;
			L.nextTime = t0;
		}
	};

	const getMinNextTime = () => {
		const nonempty = lanes.filter((l) => l.barIndices.length > 0);
		if (nonempty.length === 0) return Infinity;
		return Math.min(...nonempty.map((l) => l.nextTime));
	};

	const fillLookahead = (horizon: number) => {
		const guardMax = 50_000;
		let guard = 0;
		while (guard < guardMax) {
			guard += 1;
			let best: PolyLaneState | null = null;
			let bestT = Infinity;
			for (const L of lanes) {
				if (L.barIndices.length === 0) continue;
				if (L.nextTime < bestT) {
					bestT = L.nextTime;
					best = L;
				}
			}
			if (best === null || bestT >= horizon) break;

			const bar = best.barIndices[best.barCursor]!;
			const rowSyl = deps.getRowSyllables(bar);
			const dBar = deps.getBarTimeWindowSeconds(bar) / Math.max(1, rowSyl);
			const deadStart = deps.getDeadStart(bar);
			const c = best.cellCursor;
			const voice = best.laneId;
			const V = deps.polyVoices() === 3 ? 3 : 2;
			const chunkStep = Math.floor(bar / V);

			deps.emit(bar, c, bar, bestT, voice, chunkStep, dBar);

			const { nextC, advanceBar } = advancePolyLaneAfterEmit(c, rowSyl, deadStart);
			const advanceLaneBar = advanceBar || (!advanceBar && nextC === 0);
			if (advanceLaneBar) {
				const prevBar = bar;
				const prevCursor = best.barCursor;
				best.barCursor = (best.barCursor + 1) % best.barIndices.length;
				best.cellCursor = 0;
				const wrappedPattern =
					best.laneId === 0 && best.barCursor === 0 && prevCursor === best.barIndices.length - 1;
				if (wrappedPattern) {
					deps.onLane0PatternWrap?.(prevBar);
				}
			} else {
				best.cellCursor = nextC;
			}
			best.nextTime += dBar;
		}
	};

	rebuildLaneArrays();

	return {
		get lanes() {
			return lanes;
		},
		reset,
		fillLookahead,
		rebuildLanes,
		getMinNextTime,
	};
}
