/**
 * Random logic for the konnakol trainer: chaos curves, Markov bias, per-bar application.
 *
 * Extracted from App.tsx for isolation and unit testing without React tree
 * (see `randomCurves.test.ts`). All functions are pure - RNG is injected as a parameter.
 *
 * Architecture:
 * - `*ChangeProbFromChaos`: probability of re-randomizing an axis at bar boundary (gate).
 * - `pick*`: sample a concrete value with Markov bias to previous value (smoothness).
 * - `applyRandomizerEffectsToBar`: orchestrator: gate -> mutate, in order
 *   pulsation -> barSpeed -> pattern -> speed (dead-cells before pattern/speed).
 */

import { resolveEffectiveStepMask, type CellStepMasks } from './stepMask';

export const CHAOS_SLIDER_MAX = 100;

/** RNG compatible with Math.random. Seed injection for bar replay (see mulberry32). */
export type RNG = () => number;

/** mulberry32: deterministic PRNG from 32-bit seed. */
export function mulberry32(seed: number): RNG {
	let s = seed | 0;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Cubic smoothstep 3t^2-2t^3, clamped to [0, 1]. Base for all chaos curves. */
export function smoothstep01(t: number): number {
	const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
	return x * x * (3 - 2 * x);
}

/** Probability of pulsation change at bar boundary: 0 <= chaos <= 5 -> 0; >=80 -> 1. */
export function pulsationChangeProbFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	return smoothstep01((c - 5) / 75);
}
/** Probability of accent-pattern change: base 0.15 + smoothstep -> 1.0 at chaos=100. */
export function patternChangeProbFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	return 0.15 + 0.85 * smoothstep01(c / 100);
}
/** Probability to re-randomize cell speed in bar: base 0.1 + smoothstep -> 1 near chaos=60. */
export function speedChangeProbFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	return Math.min(1, 0.1 + 0.9 * smoothstep01(c / 60));
}
/** Probability of dead-cells update: 0 at chaos<=30; -> 1 near chaos=80. */
export function barSpeedChangeProbFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	return smoothstep01((c - 30) / 50);
}

/**
 * Random pulsation: pool by chaos. Pulsations 1 and 2 are excluded as full meters:
 * in Tala Shastra there are no standalone Anga of 1 or 2 beats; minimum is Tisra (3).
 * Ones/twos exist only as phrase parts (2+3=5), but not as a full bar.
 */
export const RANDOM_PULSE_POOL_LE_30 = [3, 4, 5] as const;
export const RANDOM_PULSE_POOL_LE_70 = [3, 4, 5, 6, 7] as const;
export const RANDOM_PULSE_POOL_FULL = [3, 4, 5, 6, 7, 8, 9] as const;

export function pulsationPoolForChaos(chaos: number): readonly number[] {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	return c <= 30 ? RANDOM_PULSE_POOL_LE_30 : c <= 70 ? RANDOM_PULSE_POOL_LE_70 : RANDOM_PULSE_POOL_FULL;
}

/** Uniform sampling of pulsation from pool (without Markov). */
function pickPulsationWeighted(chaos: number, rng: RNG): number {
	const pool = pulsationPoolForChaos(chaos);
	return pool[Math.floor(rng() * pool.length)]!;
}

/**
 * Random pulsation: Markov bias to prevMeter at low chaos, otherwise weighted pool.
 * In stick branch delta can be {-1, 0, +1}; out-of-pool values fall back to previous.
 * stickProb decreases linearly 0.6 -> 0.1 as chaos goes 0 -> 100 (beginner avoids 2->9->4 jumps).
 */
export function pickRandomPulsationMeter(
	chaos: number,
	prevMeter?: number,
	rng: RNG = Math.random,
): number {
	const pool = pulsationPoolForChaos(chaos);
	if (
		typeof prevMeter === 'number' &&
		pool.includes(prevMeter as (typeof pool)[number])
	) {
		const stickProb = Math.max(0.1, 0.6 - chaos * 0.005);
		if (rng() < stickProb) {
			const delta = Math.floor(rng() * 3) - 1;
			const target = prevMeter + delta;
			if (pool.includes(target as (typeof pool)[number])) return target;
			return prevMeter;
		}
	}
	return pickPulsationWeighted(chaos, rng);
}

/** Доля акцентуемых долей: непрерывная smoothstep-кривая 0 → 0.9 при chaos 0 → 100. */
export function accentFillRatioFromChaos(c: number): number {
	const x = Math.max(0, Math.min(CHAOS_SLIDER_MAX, c));
	return 0.9 * smoothstep01(x / 100);
}

export const CELL_SPEED_RANDOM_POOL = [2, 3, 4] as const;

/** Полный набор подделений (совпадает с KONNAKOL_DICTIONARY / Ta-редактором). */
export const CELL_SPEED_FULL_POOL = [2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * Веса базового пула (chaos≤50): 2 (Chatusra) и 4 — основа, 3 (Tisra) — специя.
 * 5–9 получают вес 0 до начала смешивания с равномеркой (см. `cellSpeedExtendedBlendFromChaos`).
 */
const BASE_CELL_SPEED_WEIGHT: Record<(typeof CELL_SPEED_FULL_POOL)[number], number> = {
	2: 0.5,
	3: 0.15,
	4: 0.35,
	5: 0,
	6: 0,
	7: 0,
	8: 0,
	9: 0,
};

/**
 * 50→0, 90→1: между базовыми весами на {2..4} и равномерным распределением по {2..9}.
 * При chaos≥90 (и 100) все подделения участвуют с равной долей.
 */
export function cellSpeedExtendedBlendFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (c <= 50) return 0;
	if (c >= 90) return 1;
	return smoothstep01((c - 50) / 40);
}

/**
 * Random Speed: при низком хаосе — только {2,3,4} с базовыми весами; с chaos>50 плавно
 * подмешивается равномерка по {2..9}; с 90 — полная равномерка. При наличии prev —
 * Markov-bias (stickProb = 1 − chaos/100) для любого допустимого подделения из полного пула.
 */
export function pickRandomCellSpeedSubdiv(
	rng: RNG = Math.random,
	prev?: number,
	chaos: number = 100,
): number {
	const blend = cellSpeedExtendedBlendFromChaos(chaos);
	const uniform = 1 / CELL_SPEED_FULL_POOL.length;

	if (typeof prev === 'number' && (CELL_SPEED_FULL_POOL as readonly number[]).includes(prev)) {
		const stickProb = Math.max(0, 1 - chaos / 100);
		if (rng() < stickProb) return prev;
	}

	let sum = 0;
	const weights: number[] = [];
	for (const v of CELL_SPEED_FULL_POOL) {
		const base = BASE_CELL_SPEED_WEIGHT[v];
		const w = (1 - blend) * base + blend * uniform;
		weights.push(w);
		sum += w;
	}
	let r = rng() * sum;
	for (let i = 0; i < CELL_SPEED_FULL_POOL.length; i++) {
		r -= weights[i]!;
		if (r <= 0) return CELL_SPEED_FULL_POOL[i]!;
	}
	return CELL_SPEED_FULL_POOL[CELL_SPEED_FULL_POOL.length - 1]!;
}

/**
 * Плотность cell-speed подделений в такте (на одну ячейку-кандидата).
 * 0..25: линейно 0 → 0.15 (максимум одна ячейка ощущается естественно на малом хаосе).
 * 25..100: smoothstep 0.15 → 1.0. Без ступенек-плато, без cliff на стыке 25/26.
 */
export function cellSpeedHitPFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (c <= 25) return (c / 25) * 0.15;
	return 0.15 + smoothstep01((c - 25) / 75) * (1 - 0.15);
}

export function pickAccentCountForBar(chaos: number, curSyl: number, rng: RNG = Math.random): number {
	const x = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (curSyl < 1) return 0;
	// Малые такты (≤3): пол=1 всегда. Не насыщаем акцентами — всегда остаётся ориентир.
	const minAcc = curSyl <= 3 ? 1 : Math.min(curSyl, x > 15 ? 2 : 1);
	const maxCap = Math.min(curSyl, Math.max(minAcc, Math.floor(curSyl * 0.9)));
	const ratio = accentFillRatioFromChaos(x);
	const cap = Math.floor(curSyl * ratio);
	const spread = 1 + Math.floor(curSyl * 0.12);
	const jitter = Math.floor((rng() - 0.5) * spread);
	let n = Math.max(0, Math.min(curSyl, cap + jitter));
	n = Math.min(maxCap, Math.max(minAcc, n));
	return n;
}

export type DeadCellsMap = Record<number, { deadStart: number; displayLen: number; baseLen: number }>;

export type BarRandomizerMutable = {
	customSyllables: Record<number, number>;
	accents: Set<string>;
	customSubdivisions: Record<string, number>;
	/** Переопределение отображаемого/логируемого слога по ключу `${row}-${cell}` (parent mode). */
	customCellSyllables: Record<string, string>;
	customMultipliers: Record<number, number>;
	deadCells: DeadCellsMap;
};

export type SequencerSeqItem = { r: number; c: number; activeSyllables: number };

/**
 * Порядок долей в legacy (не poly): только живые клетки `c < deadStart`.
 * Иначе мёртвые слоги занимают время в `nextNote`, хотя клик уже глушится в `emitGridSubAudio`.
 */
export function buildLegacyPlaybackSequence(
	barCount: number,
	customSyllables: Record<number, number>,
	baseSyllables: number,
	deadCells: DeadCellsMap,
	/** kept for call-site compatibility; ignored by stable algorithm */
	customCellSyllables?: Record<string, string>,
	customSubdivisions?: Record<string, number>,
	cellStepMasks?: CellStepMasks,
): SequencerSeqItem[] {
	void customCellSyllables;
	const seq: SequencerSeqItem[] = [];
	for (let r = 0; r < barCount; r++) {
		const syls = customSyllables[r] !== undefined ? customSyllables[r] : baseSyllables;
		const ds = deadCells[r]?.deadStart;
		const lastLiveExclusive =
			typeof ds === 'number' ? Math.min(Math.max(0, Math.floor(ds)), syls) : syls;
		for (let c = 0; c < lastLiveExclusive; c++) {
			const cellKey = `${r}-${c}`;
			const subdivs = customSubdivisions?.[cellKey] ?? 1;
			const stepMask = resolveEffectiveStepMask(cellKey, subdivs, cellStepMasks);
			if (stepMask.every((v) => v === false)) continue;
			seq.push({ r, c, activeSyllables: syls });
		}
	}
	return seq;
}

/**
 * Одна итерация рандома на такт `prevBar` (как на границе такта в плеере).
 *
 * Каждый axis (pulsation / barSpeed / pattern / speed) проходит два шлюза:
 * 1. User toggle — axis «разрешён» вообще;
 * 2. Probability gate от chaos — реально мутирует такт или оставляет прежнее состояние (persistence).
 *
 * Порядок: pulsation → barSpeed → pattern → speed. Dead-cells считаются до pattern/speed,
 * чтобы не назначать акценты/подделения на уже срубленные ячейки.
 *
 * `forceFirstBeat`: гарантирует акцент на доле 0 при мутации pattern (диктант-режим / низкий
 * chaos). Первая доля такта — Sam/Eduppu, гравитационный центр Тала; без неё ученик теряет
 * сетку. Вызывающая сторона обычно даёт `dictantMode || chaos < 80`.
 *
 * `onlyAccents` оставлен в сигнатуре для backward-compat снэпшотов, но на генерацию
 * рандома не влияет: подделения (Speed) всегда могут попадать на любые живые клетки,
 * включая безакцентные (проходящие ноты в индийской традиции дробятся для скорости).
 *
 * `rng` по умолчанию Math.random; для replay такта передаётся mulberry32(seed).
 */
export function applyRandomizerEffectsToBar(
	prevBar: number,
	chaos: number,
	randomPulsation: boolean,
	randomPattern: boolean,
	randomSpeed: boolean,
	randomBarSpeed: boolean,
	_onlyAccents: boolean,
	syllablesDefault: number,
	m: BarRandomizerMutable,
	rng: RNG = Math.random,
	forceFirstBeat: boolean = false,
): boolean {
	let didChange = false;

	if (randomPulsation && rng() < pulsationChangeProbFromChaos(chaos)) {
		const prevMeter = m.customSyllables[prevBar];
		const newMeter = pickRandomPulsationMeter(chaos, prevMeter, rng);
		if (newMeter !== prevMeter) {
			m.customSyllables[prevBar] = newMeter;
			// Prune stale accents/subdivs за пределами нового curSyl.
			for (let i = newMeter; i < 9; i++) {
				m.accents.delete(`${prevBar}-${i}`);
				delete m.customSubdivisions[`${prevBar}-${i}`];
			}
			didChange = true;
		}
	}

	const curSyl = m.customSyllables[prevBar] ?? syllablesDefault;

	if (randomBarSpeed && rng() < barSpeedChangeProbFromChaos(chaos)) {
		const maxDeadPossible = Math.max(0, curSyl - 1); // минимум одна активная клетка.
		if (maxDeadPossible <= 0) {
			if (m.deadCells[prevBar] !== undefined) {
				delete m.deadCells[prevBar];
				didChange = true;
			}
		} else {
			const flatCap = Math.min(2, maxDeadPossible);
			let deadCount = 0;
			if (chaos < 70) {
				// Soft 0/1/2 distribution, независимо от accents (тишина-Karvai и акцент —
				// разные концепты: динамика vs структура времени). Непрерывная кривая от
				// 90/9/1 при chaos=0 до 40/25/35 при chaos=70.
				const t = Math.max(0, Math.min(1, chaos / 70));
				const p0 = 0.9 - 0.5 * t;
				const p1 = 0.09 + 0.16 * t;
				const roll = rng();
				const deadCountSoft = roll < p0 ? 0 : roll < p0 + p1 ? 1 : 2;
				deadCount = Math.min(deadCountSoft, flatCap);
			} else {
				// 70..100: экспоненциальная кривая к capу 80% — Vilambit Laya, где
				// большая часть такта удерживается внутренним пульсом.
				const tail = Math.max(0, Math.min(1, (chaos - 70) / 30));
				const exp01 = Math.expm1(3 * tail) / Math.expm1(3);
				const deadAt100 = Math.min(maxDeadPossible, Math.max(flatCap, Math.floor(curSyl * 0.8)));
				deadCount = Math.max(
					flatCap,
					Math.min(deadAt100, Math.round(flatCap + exp01 * (deadAt100 - flatCap))),
				);
			}
			const activeCount = Math.max(1, curSyl - deadCount);
			if (activeCount >= curSyl) {
				if (m.deadCells[prevBar] !== undefined) {
					delete m.deadCells[prevBar];
					didChange = true;
				}
			} else {
				const prevMeta = m.deadCells[prevBar];
				if (
					!prevMeta ||
					prevMeta.deadStart !== activeCount ||
					prevMeta.displayLen !== curSyl ||
					prevMeta.baseLen !== curSyl
				) {
					m.deadCells[prevBar] = { deadStart: activeCount, displayLen: curSyl, baseLen: curSyl };
					didChange = true;
				}
				// Prune accents/subdivs в dead-зоне.
				for (let i = activeCount; i < curSyl; i++) {
					m.accents.delete(`${prevBar}-${i}`);
					delete m.customSubdivisions[`${prevBar}-${i}`];
				}
			}
		}
	}

	const deadStart = m.deadCells[prevBar]?.deadStart;
	const liveEnd = typeof deadStart === 'number' ? Math.max(0, Math.min(deadStart, curSyl)) : curSyl;

	if (randomPattern && rng() < patternChangeProbFromChaos(chaos)) {
		for (let i = 0; i < 9; i++) m.accents.delete(`${prevBar}-${i}`);
		const fillCount = pickAccentCountForBar(chaos, liveEnd, rng);
		if (forceFirstBeat && liveEnd >= 1) {
			// Первая доля (Sam/Eduppu) — гарантированный акцент; остальные fillCount-1
			// раскидываем по [1..liveEnd) с sort-bias (см. точка 7 ревизии эксперта).
			m.accents.add(`${prevBar}-0`);
			const rest = Array.from({ length: Math.max(0, liveEnd - 1) }, (_, i) => i + 1)
				.sort(() => rng() - 0.5);
			const remaining = Math.max(0, fillCount - 1);
			for (let i = 0; i < remaining && i < rest.length; i++) {
				m.accents.add(`${prevBar}-${rest[i]}`);
			}
		} else {
			const candidates = Array.from({ length: liveEnd }, (_, i) => i).sort(() => rng() - 0.5);
			for (let i = 0; i < fillCount && i < candidates.length; i++) {
				m.accents.add(`${prevBar}-${candidates[i]}`);
			}
		}
		didChange = true;
	}

	if (randomSpeed && rng() < speedChangeProbFromChaos(chaos)) {
		// Speed бьёт любые живые клетки, включая безакцентные — проходящие ноты
		// часто дробятся для скорости, акценты держат устойчивость (индийская традиция).
		const candidates = Array.from({ length: liveEnd }, (_, i) => i);
		for (let i = 0; i < 9; i++) delete m.customSubdivisions[`${prevBar}-${i}`];
		const hitP = cellSpeedHitPFromChaos(chaos);
		let prevSubdiv: number | undefined;
		for (const i of candidates) {
			if (rng() < hitP) {
				const picked = pickRandomCellSpeedSubdiv(rng, prevSubdiv, chaos);
				m.customSubdivisions[`${prevBar}-${i}`] = picked;
				prevSubdiv = picked;
			} else {
				prevSubdiv = undefined;
			}
		}
		didChange = true;
	}

	return didChange;
}
