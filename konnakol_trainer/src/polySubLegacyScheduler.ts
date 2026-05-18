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
	/**
	 * Любая lane пересекла границу такта (advanceBar): `prevBar` — такт, который только что доиграл,
	 * `laneId` — индекс линии, `wrappedPattern` — линия замкнула круг по своим тактам.
	 * Используется per-voice рандомайзером в режиме sub_legacy: каждому голосу — свой рандомизатор.
	 */
	onLaneBarBoundary?: (prevBar: number, laneId: number, wrappedPattern: boolean) => void;
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

/** Pick lane barCursor for pattern-bar anchor: exact bar, else first bar >= N, else 0. */
function laneBarCursorForPatternBar(barIndices: number[], patternBar: number): number {
	if (barIndices.length === 0) return 0;
	const exact = barIndices.indexOf(patternBar);
	if (exact >= 0) return exact;
	for (let i = 0; i < barIndices.length; i++) {
		if (barIndices[i]! >= patternBar) return i;
	}
	return 0;
}

export type PolySubLegacyScheduler = {
	lanes: PolyLaneState[];
	reset: (startTime: number) => void;
	/** All lanes seek to `patternBar` (col 0): lanes without N use first bar >= N in cycle. */
	resetFromPatternBar: (startTime: number, patternBar: number) => void;
	fillLookahead: (horizon: number) => void;
	rebuildLanes: (startTime: number) => void;
	handleRowSyllablesHotSwitch: (
		barIdx: number,
		prevRowSyllables: number,
		nextRowSyllables: number,
		anchorTime: number,
	) => void;
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

	const resetFromPatternBar = (startTime: number, patternBar: number) => {
		const anchor = Math.max(0, Math.floor(patternBar));
		const bc = Math.max(0, Math.floor(deps.barCount()));
		const V = deps.polyVoices() === 3 ? 3 : 2;
		const stepIdx = Math.floor(anchor / V);
		const stepLeadBar = stepIdx * V;
		rebuildLaneArrays();
		for (const L of lanes) {
			const targetBar = stepLeadBar + L.laneId;
			if (targetBar < bc) {
				const exact = L.barIndices.indexOf(targetBar);
				L.barCursor =
					exact >= 0 ? exact : laneBarCursorForPatternBar(L.barIndices, stepLeadBar);
			} else {
				L.barCursor = laneBarCursorForPatternBar(L.barIndices, anchor);
			}
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

	const handleRowSyllablesHotSwitch = (
		barIdx: number,
		prevRowSyllables: number,
		nextRowSyllables: number,
		anchorTime: number,
	) => {
		if (!Number.isInteger(barIdx) || barIdx < 0) return;
		const prevSyl = Math.max(1, Math.floor(prevRowSyllables));
		const nextSyl = Math.max(1, Math.floor(nextRowSyllables));
		if (prevSyl === nextSyl) return;
		const lane = lanes.find((l) => {
			if (l.barIndices.length === 0) return false;
			return l.barIndices[l.barCursor] === barIdx;
		});
		if (!lane) return;
		const barWindow = deps.getBarTimeWindowSeconds(barIdx);
		if (!Number.isFinite(barWindow) || barWindow <= 0) return;

		const prevStepDur = barWindow / prevSyl;
		const nextStepDur = barWindow / nextSyl;
		const barStartTime = lane.nextTime - lane.cellCursor * prevStepDur;
		const rawPhase = (anchorTime - barStartTime) / barWindow;
		const phase = Math.max(0, Math.min(0.999999, rawPhase));
		let nextCell = Math.ceil(phase * nextSyl - 1e-9);
		if (!Number.isFinite(nextCell)) nextCell = 0;
		nextCell = Math.max(0, Math.min(nextSyl - 1, nextCell));
		let nextTime = barStartTime + nextCell * nextStepDur;
		if (nextTime < anchorTime + 1e-4) {
			nextCell += 1;
			nextTime += nextStepDur;
			if (nextCell >= nextSyl) {
				if (lane.barIndices.length > 0) {
					lane.barCursor = (lane.barCursor + 1) % lane.barIndices.length;
				}
				nextCell = 0;
			}
		}
		lane.cellCursor = nextCell;
		lane.nextTime = nextTime;
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

			const rowFullyDead = typeof deadStart === 'number' && deadStart <= 0;
			if (!rowFullyDead) {
				deps.emit(bar, c, bar, bestT, voice, chunkStep, dBar);
			}
			if (rowFullyDead) {
				const prevBar = bar;
				const prevCursor = best.barCursor;
				best.barCursor = (best.barCursor + 1) % best.barIndices.length;
				best.cellCursor = 0;
				const wrappedPattern =
					best.barCursor === 0 && prevCursor === best.barIndices.length - 1;
				deps.onLaneBarBoundary?.(prevBar, best.laneId, wrappedPattern);
				// Truncation policy: fully-dead bar consumes zero physical time.
				continue;
			}

			const { nextC, advanceBar } = advancePolyLaneAfterEmit(c, rowSyl, deadStart);
			const laneHeadSingleLiveHold =
				best.barCursor === 0 &&
				c === 0 &&
				typeof deadStart === 'number' &&
				deadStart === 1 &&
				rowSyl >= 2;
			const nextCWithHeadHold = laneHeadSingleLiveHold ? 1 : nextC;
			const advanceLaneBar =
				!laneHeadSingleLiveHold && (advanceBar || (!advanceBar && nextCWithHeadHold === 0));
			if (advanceLaneBar) {
				const prevBar = bar;
				const prevCursor = best.barCursor;
				best.barCursor = (best.barCursor + 1) % best.barIndices.length;
				best.cellCursor = 0;
				const wrappedPattern =
					best.barCursor === 0 && prevCursor === best.barIndices.length - 1;
				deps.onLaneBarBoundary?.(prevBar, best.laneId, wrappedPattern);
			} else {
				best.cellCursor = nextCWithHeadHold;
			}
			// Truncation policy: one emitted cell always advances by one cell duration.
			best.nextTime += dBar;
		}
	};

	rebuildLaneArrays();

	return {
		get lanes() {
			return lanes;
		},
		reset,
		resetFromPatternBar,
		fillLookahead,
		rebuildLanes,
		handleRowSyllablesHotSwitch,
		getMinNextTime,
	};
}
