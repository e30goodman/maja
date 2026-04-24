/**
 * Parent Mode — наследственные мутации мотива.
 *
 * Контракт: один ParentGenome (1 или 2 такта) служит тематическим ядром, а каждый такт
 * плейлиста получает роль (`PhraseRole`) из расписания (`PhraseSchedule`). Роль говорит,
 * какой оператор мутации применять и какой "кадр" фразы возвращать.
 *
 * Этот модуль строго отделён от `randomLogic.ts`: free-random продолжает работать через
 * `applyRandomizerEffectsToBar`, а parent-mode — через `applyParentModeBar`. Маршрутизация
 * в `App.tsx` смотрит на `randomMode`.
 *
 * Phase 1: skeleton без реальных операторов — каждая роль, отличная от 'parent'/'free',
 * возвращает копию parent.bars[0]. Phase 2+ добавит настоящие мутации.
 */

import type { BarRandomizerMutable, RNG } from './randomLogic';
import { smoothstep01, applyRandomizerEffectsToBar } from './randomLogic';

/** 13 типов наследственных мутаций + служебные 'parent' (чистая копия) и 'free' (free-random filler). */
export type MutationType =
	| 'substitution'
	| 'retrograde'
	| 'inversion'
	| 'rotation'
	| 'truncation'
	| 'augmentation'
	| 'diminution'
	| 'prepend_append'
	| 'fractal'
	| 'tihai'
	| 'echo_decay'
	| 'neighbour_pulsation'
	| 'call_fill';

export const ALL_MUTATION_TYPES: readonly MutationType[] = [
	'substitution',
	'retrograde',
	'inversion',
	'rotation',
	'truncation',
	'augmentation',
	'diminution',
	'prepend_append',
	'fractal',
	'tihai',
	'echo_decay',
	'neighbour_pulsation',
	'call_fill',
] as const;

/**
 * Длина фразы (число тактов), которую занимает каждый тип мутации. Scheduler
 * гарантирует, что фраза проигрывается целиком — никаких "половинок".
 *
 * Числа — см. §3 плана. Tihai = 4 (3 повтора + landing) канонично. Augmentation/Diminution/
 * Rotation/Fractal/Neighbour = 3 (плавное развитие). Prepend/Echo/Call = 4. Truncation = 5.
 * Substitution/Retrograde/Inversion = 2 (одноходовка parent→variant).
 */
export const MUTATION_PHRASE_LEN: Record<MutationType, number> = {
	substitution: 2,
	retrograde: 2,
	inversion: 2,
	rotation: 3,
	truncation: 5,
	augmentation: 3,
	diminution: 3,
	prepend_append: 4,
	fractal: 3,
	tihai: 4,
	echo_decay: 4,
	neighbour_pulsation: 3,
	call_fill: 4,
};

/** Человекочитаемое имя для UI (короткое, влезает в чекбокс). */
export const MUTATION_LABEL: Record<MutationType, string> = {
	substitution: 'Substitution',
	retrograde: 'Retrograde',
	inversion: 'Inversion',
	rotation: 'Rotation',
	truncation: 'Truncation',
	augmentation: 'Augmentation',
	diminution: 'Diminution',
	prepend_append: 'Prepend/Append',
	fractal: 'Fractal',
	tihai: 'Tihai',
	echo_decay: 'Echo decay',
	neighbour_pulsation: 'Neighbour pulse',
	call_fill: 'Call & fill',
};

/** Категории для группировки чекбоксов в UI (Phase 5). */
export type MutationCategory = 'structural' | 'pattern' | 'density' | 'meta';
export const MUTATION_CATEGORY: Record<MutationType, MutationCategory> = {
	tihai: 'structural',
	truncation: 'structural',
	prepend_append: 'structural',
	call_fill: 'structural',
	substitution: 'pattern',
	rotation: 'pattern',
	inversion: 'pattern',
	retrograde: 'pattern',
	augmentation: 'density',
	diminution: 'density',
	echo_decay: 'density',
	neighbour_pulsation: 'meta',
	fractal: 'meta',
};

export type FormPresetId = 'random' | 'tihai_heavy' | 'progressive' | 'call_fill';

export const ALL_FORM_PRESETS: readonly FormPresetId[] = [
	'random',
	'tihai_heavy',
	'progressive',
	'call_fill',
] as const;

export const FORM_PRESET_LABEL: Record<FormPresetId, string> = {
	random: 'Random',
	tihai_heavy: 'Tihay',
	progressive: 'Progressive',
	call_fill: 'Call-fill',
};

/**
 * Полный слепок одного такта в parent-mode-формате. Позиции относительные (0..curSyl-1),
 * без префикса "r-". Это делает геномы переносимыми между барами.
 */
export type BarGenome = {
	curSyl: number;
	/** Индексы долей с акцентом. Сет — идентичная семантика с `accents: Set<"r-c">`. */
	accents: Set<number>;
	/** Поддоли (cell-speed): {cellIdx → subdiv ∈ [2,3,4]}. */
	subdivisions: Record<number, number>;
	/** Начало dead-зоны внутри такта. Все клетки >= deadStart — мёртвые. */
	deadStart?: number;
};

/** Parent mode хранит 1 или 2 такта. Длина >= 1, <= 2. */
export type ParentGenome = {
	bars: BarGenome[];
};

export type ParentLength = 1 | 2;

/**
 * Роль одного такта в расписании. `phraseId` группирует последовательные такты одной фразы;
 * `phraseStep` — индекс внутри фразы [0, phraseLength). `parentBarIdx` ∈ {0,1} — какой из
 * двух parent-тактов используется (для ParentLength=1 всегда 0).
 */
export type PhraseRole =
	| {
			type: MutationType;
			phraseId: number;
			phraseStep: number;
			phraseLength: number;
			parentBarIdx: 0 | 1;
	  }
	| {
			type: 'parent';
			phraseId: number;
			phraseStep: 0;
			phraseLength: 1;
			parentBarIdx: 0 | 1;
	  }
	| {
			type: 'free';
			phraseId: number;
			phraseStep: 0;
			phraseLength: 1;
			parentBarIdx: 0;
	  };

export type PhraseSchedule = PhraseRole[];

export type RandomMode = 'free' | 'parent';

// ============================================================================
// Chaos → intensity (ослабленное влияние per требованию)
// ============================================================================

/**
 * chaos=0 → 0.2 (минимальное отклонение, parent узнаётся моментально).
 * chaos=50 → ~0.7.
 * chaos=100 → 1.2 (экстремальные вариации, «до абсурда» по запросу).
 */
export function chaosToIntensity(chaos: number): number {
	const c = Math.max(0, Math.min(100, chaos));
	return 0.2 + 1.0 * smoothstep01(c / 100);
}

// ============================================================================
// Genome ↔ BarRandomizerMutable converters
// ============================================================================

/**
 * Снимает BarGenome из текущего состояния бара. curSyl берётся из customSyllables[r]
 * или падает на baseSyl. deadStart — из deadCells[r] если есть.
 */
export function snapshotBarGenome(
	barIdx: number,
	baseSyl: number,
	state: {
		customSyllables: Record<number, number>;
		accents: Set<string>;
		customSubdivisions: Record<string, number>;
		deadCells: { [r: number]: { deadStart: number } | undefined };
	},
): BarGenome {
	const curSyl = state.customSyllables[barIdx] ?? baseSyl;
	const accents = new Set<number>();
	const subdivisions: Record<number, number> = {};
	for (let c = 0; c < curSyl; c++) {
		const k = `${barIdx}-${c}`;
		if (state.accents.has(k)) accents.add(c);
		const s = state.customSubdivisions[k];
		if (typeof s === 'number' && s >= 2 && s <= 9) subdivisions[c] = s;
	}
	const ds = state.deadCells[barIdx]?.deadStart;
	const out: BarGenome = { curSyl, accents, subdivisions };
	if (typeof ds === 'number' && ds >= 0 && ds < curSyl) out.deadStart = ds;
	return out;
}

/**
 * Пишет BarGenome обратно в BarRandomizerMutable для такта `barIdx`. Перезаписывает
 * accents/subdivisions/deadCells данного бара, не трогая остальные бары.
 */
export function applyGenomeToBar(
	barIdx: number,
	genome: BarGenome,
	m: BarRandomizerMutable,
): void {
	m.customSyllables[barIdx] = genome.curSyl;

	for (let c = 0; c < 9; c++) {
		m.accents.delete(`${barIdx}-${c}`);
		delete m.customSubdivisions[`${barIdx}-${c}`];
	}
	for (const c of genome.accents) {
		if (c >= 0 && c < genome.curSyl) m.accents.add(`${barIdx}-${c}`);
	}
	for (const [cStr, s] of Object.entries(genome.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (Number.isFinite(c) && c >= 0 && c < genome.curSyl) {
			m.customSubdivisions[`${barIdx}-${c}`] = s;
		}
	}

	if (typeof genome.deadStart === 'number' && genome.deadStart >= 0 && genome.deadStart < genome.curSyl) {
		m.deadCells[barIdx] = {
			deadStart: genome.deadStart,
			displayLen: genome.curSyl,
			baseLen: genome.curSyl,
		};
	} else {
		delete m.deadCells[barIdx];
	}
}

/** Глубокое клонирование BarGenome (Set и объекты — новые ссылки). */
export function cloneBarGenome(g: BarGenome): BarGenome {
	const out: BarGenome = {
		curSyl: g.curSyl,
		accents: new Set(g.accents),
		subdivisions: { ...g.subdivisions },
	};
	if (typeof g.deadStart === 'number') out.deadStart = g.deadStart;
	return out;
}

export function cloneParentGenome(p: ParentGenome): ParentGenome {
	return { bars: p.bars.map(cloneBarGenome) };
}

// ============================================================================
// Phrase scheduler
// ============================================================================

export type SchedulerContext = {
	bars: number;
	enabledMutations: MutationType[];
	preset: FormPresetId;
	parentLength: ParentLength;
	rng: RNG;
};

/**
 * Greedy-планировщик. Пока `remaining > 0`:
 *  1. Выбирает мутацию из `enabled` по правилу пресета.
 *  2. Если её phraseLength > remaining или > bars — откатывается на 'parent' filler.
 *  3. Разворачивает фразу на phraseLength ролей (step=0..len-1).
 *
 * Phase 1: пресеты-заглушки ведут себя как 'random'. Реальное поведение пресетов —
 * Phase 4.
 */
export function buildPhraseSchedule(ctx: SchedulerContext): PhraseSchedule {
	const { bars, enabledMutations, preset, parentLength, rng } = ctx;
	const out: PhraseSchedule = [];
	let remaining = bars;
	let phraseId = 0;
	let parentBarIdx: 0 | 1 = 0;
	const progressiveBars = { early: 0, mid: 0, late: 0 };

	const pickMutation = (fit: number, progress: number): MutationType | null => {
		const candidates = enabledMutations.filter((t) => MUTATION_PHRASE_LEN[t] <= fit);
		if (candidates.length === 0) return null;
		// Phase 4 переопределит это для пресетов. Пока везде uniform.
		if (preset === 'tihai_heavy' && candidates.includes('tihai') && rng() < 0.85) {
			return 'tihai';
		}
		if (preset === 'progressive') {
			// Явная драматургия: начало проще, середина плотнее, финал структурнее.
			const early: MutationType[] = ['substitution', 'inversion', 'retrograde', 'rotation'];
			const mid: MutationType[] = ['augmentation', 'diminution', 'echo_decay', 'neighbour_pulsation', 'fractal'];
			const late: MutationType[] = ['prepend_append', 'truncation', 'tihai', 'call_fill'];

			const goals = {
				early: Math.round(bars * 0.3),
				mid: Math.round(bars * 0.35),
				late: bars - Math.round(bars * 0.3) - Math.round(bars * 0.35),
			} as const;
			const deficit = {
				early: goals.early - progressiveBars.early,
				mid: goals.mid - progressiveBars.mid,
				late: goals.late - progressiveBars.late,
			} as const;
			const progressStage: 'early' | 'mid' | 'late' =
				progress < 0.33 ? 'early'
				: progress < 0.66 ? 'mid'
				: 'late';
			const byStage: Record<'early' | 'mid' | 'late', MutationType[]> = { early, mid, late };
			const orderedStages = [...(['early', 'mid', 'late'] as const)].sort((a, b) => {
				// Жёсткий приоритет текущей фазы формы.
				if (a === progressStage && b !== progressStage) return -1;
				if (b === progressStage && a !== progressStage) return 1;
				const affinity = (st: 'early' | 'mid' | 'late'): number => {
					const order: Record<'early' | 'mid' | 'late', number> = { early: 0, mid: 1, late: 2 };
					return Math.abs(order[st] - order[progressStage]) === 1 ? 25 : 0;
				};
				const scoreA = deficit[a] + affinity(a);
				const scoreB = deficit[b] + affinity(b);
				const byNeed = scoreB - scoreA;
				if (byNeed !== 0) return byNeed;
				const order: Record<'early' | 'mid' | 'late', number> = { early: 0, mid: 1, late: 2 };
				return Math.abs(order[a] - order[progressStage]) - Math.abs(order[b] - order[progressStage]);
			});
			for (const st of orderedStages) {
				for (const t of byStage[st]) if (candidates.includes(t)) return t;
			}

			// Fallback, если текущий fit не позволяет мутации выбранной стадии.
			const order: MutationType[] = [...early, ...mid, ...late];
			for (const t of order) if (candidates.includes(t)) return t;
			return candidates[0]!;
		}
		if (preset === 'call_fill' && candidates.includes('call_fill') && rng() < 0.7) {
			return 'call_fill';
		}
		return candidates[Math.floor(rng() * candidates.length)]!;
	};

	let safety = 0;
	while (remaining > 0 && safety++ < 1000) {
		const barPos = bars - remaining;
		// Progressive: каждые 8 тактов явный возврат темы (parent-anchor),
		// чтобы 32-тактовая форма держала "общую нить".
		if (preset === 'progressive' && barPos % 8 === 0) {
			out.push({
				type: 'parent',
				phraseId: phraseId++,
				phraseStep: 0,
				phraseLength: 1,
				parentBarIdx,
			});
			parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
			remaining -= 1;
			continue;
		}
		// Tihai-heavy: 8-тактовые секции как единый организм:
		// 1) такт-ссылка на тему (parent-anchor),
		// 2) в конце секции обязательная 4-тактовая tihai-каденция.
		if (preset === 'tihai_heavy') {
			const inSection = barPos % 8;
			if (inSection === 0) {
				out.push({
					type: 'parent',
					phraseId: phraseId++,
					phraseStep: 0,
					phraseLength: 1,
					parentBarIdx,
				});
				parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
				remaining -= 1;
				continue;
			}
			if (inSection === 4 && remaining >= MUTATION_PHRASE_LEN.tihai && enabledMutations.includes('tihai')) {
				const pid = phraseId++;
				for (let step = 0; step < MUTATION_PHRASE_LEN.tihai; step++) {
					out.push({
						type: 'tihai',
						phraseId: pid,
						phraseStep: step,
						phraseLength: MUTATION_PHRASE_LEN.tihai,
						parentBarIdx,
					});
				}
				parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
				remaining -= MUTATION_PHRASE_LEN.tihai;
				continue;
			}
		}
		// Call-fill: секции по 8 тактов как "вопрос-ответ":
		// 1) такт-ссылка на тему,
		// 2) ранний обязательный 4-тактовый call_fill блок (чтобы стиль не вырождался в random).
		if (preset === 'call_fill') {
			const inSection = barPos % 8;
			if (inSection === 0) {
				out.push({
					type: 'parent',
					phraseId: phraseId++,
					phraseStep: 0,
					phraseLength: 1,
					parentBarIdx,
				});
				parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
				remaining -= 1;
				continue;
			}
			if (
				inSection === 1 &&
				remaining >= MUTATION_PHRASE_LEN.call_fill &&
				enabledMutations.includes('call_fill')
			) {
				const pid = phraseId++;
				for (let step = 0; step < MUTATION_PHRASE_LEN.call_fill; step++) {
					out.push({
						type: 'call_fill',
						phraseId: pid,
						phraseStep: step,
						phraseLength: MUTATION_PHRASE_LEN.call_fill,
						parentBarIdx,
					});
				}
				parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
				remaining -= MUTATION_PHRASE_LEN.call_fill;
				continue;
			}
		}
		const progress = bars > 0 ? (bars - remaining) / bars : 0;
		const progressiveWindow =
			preset === 'progressive'
				? Math.min(remaining, 8 - (barPos % 8))
				: remaining;
		const sectionWindow =
			preset === 'tihai_heavy'
				? (() => {
					const inSection = barPos % 8;
					const hardSectionEnd = 8 - inSection;
					// Резервируем хвост секции (4 такта) под обязательную tihai-каденцию.
					if (inSection > 0 && inSection < 4) return Math.min(progressiveWindow, 4 - inSection, hardSectionEnd);
					return Math.min(progressiveWindow, hardSectionEnd);
				})()
				: preset === 'call_fill'
				? Math.min(progressiveWindow, 8 - (barPos % 8))
				: progressiveWindow;
		const chosen = enabledMutations.length > 0 ? pickMutation(sectionWindow, progress) : null;
		if (chosen === null) {
			out.push({
				type: 'parent',
				phraseId: phraseId++,
				phraseStep: 0,
				phraseLength: 1,
				parentBarIdx,
			});
			parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
			remaining -= 1;
			continue;
		}
		const len = MUTATION_PHRASE_LEN[chosen];
		if (preset === 'progressive') {
			const earlySet = new Set<MutationType>(['substitution', 'inversion', 'retrograde', 'rotation']);
			const midSet = new Set<MutationType>(['augmentation', 'diminution', 'echo_decay', 'neighbour_pulsation', 'fractal']);
			if (earlySet.has(chosen)) progressiveBars.early += len;
			else if (midSet.has(chosen)) progressiveBars.mid += len;
			else progressiveBars.late += len;
		}
		const pid = phraseId++;
		for (let step = 0; step < len; step++) {
			out.push({
				type: chosen,
				phraseId: pid,
				phraseStep: step,
				phraseLength: len,
				parentBarIdx,
			});
		}
		parentBarIdx = parentLength === 2 ? ((parentBarIdx === 0 ? 1 : 0) as 0 | 1) : 0;
		remaining -= len;
	}
	return out;
}

// ============================================================================
// Mutation operators (Phase 1 = заглушки, Phase 2+ = реальные)
// ============================================================================

export type MutationOperator = (
	parent: ParentGenome,
	role: Extract<PhraseRole, { type: MutationType }>,
	intensity: number,
	rng: RNG,
) => BarGenome;

/** Заглушка-оператор: возвращает копию указанного parent-бара. Phase 3+ заменит реальными. */
const stubOperator: MutationOperator = (parent, role) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	return cloneBarGenome(src);
};

/** Живая длина такта (до deadStart если задан, иначе curSyl). */
function liveLen(g: BarGenome): number {
	if (typeof g.deadStart === 'number') return Math.max(0, Math.min(g.deadStart, g.curSyl));
	return g.curSyl;
}

/**
 * Substitution: step=0 — чистый parent; step=1 — parent с k=1+floor(intensity*3)
 * заменёнными клетками (переключение accent на случайной живой клетке).
 *
 * Почему именно accent-toggle: это самая "читаемая" мутация уха — фраза остаётся той же
 * метрически, но ритмический акцент смещается на новую точку. Подделения намеренно не
 * трогаем (они дали бы слишком сильную вариацию, сливающуюся с Speed-осью free-режима).
 */
const substitutionOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 1) return out;
	const k = Math.max(1, Math.min(live, 1 + Math.floor(intensity * 6)));
	const pool = Array.from({ length: live }, (_, i) => i);
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = pool[i]!;
		pool[i] = pool[j]!;
		pool[j] = tmp;
	}
	for (let i = 0; i < k && i < pool.length; i++) {
		const idx = pool[i]!;
		if (out.accents.has(idx)) out.accents.delete(idx);
		else out.accents.add(idx);
	}
	return out;
};

/**
 * Retrograde: step=0 — parent; step=1 — parent с обратным порядком accents + subdivisions
 * по живым клеткам. Pulsation/curSyl/deadStart сохраняются.
 */
const retrogradeOperator: MutationOperator = (parent, role) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 2) return out;
	const lastLive = live - 1;
	const revAccents = new Set<number>();
	for (const c of out.accents) {
		if (c < live) revAccents.add(lastLive - c);
		else revAccents.add(c); // мёртвая зона — не зеркалим
	}
	out.accents = revAccents;

	const revSubs: Record<number, number> = {};
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (c < live) revSubs[lastLive - c] = s;
		else revSubs[c] = s;
	}
	out.subdivisions = revSubs;
	return out;
};

/**
 * Inversion: step=0 — parent; step=1 — акценты только на тех живых клетках, где у parent их
 * НЕ было (и наоборот). Subdivisions сохраняются — инвертируем только акцентную поверхность.
 */
const inversionOperator: MutationOperator = (parent, role) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 1) return out;
	const nextAccents = new Set<number>();
	for (let c = 0; c < live; c++) {
		if (!out.accents.has(c)) nextAccents.add(c);
	}
	// Акценты в dead-зоне — не сохраняем (они и так не слышны).
	out.accents = nextAccents;
	return out;
};

// ============================================================================
// Phase 3 operators
// ============================================================================

/**
 * Rotation (len=3): parent → сдвиг на k1 → сдвиг на k2.
 * Accents/subdivisions живой зоны циклически смещаются; мёртвая зона не трогается.
 * k = round(step * (0.5 + intensity * 1.5)), ограничено [1, live-1].
 */
const rotationOperator: MutationOperator = (parent, role, intensity) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 2) return out;
	const raw = Math.round(role.phraseStep * (0.5 + intensity * 1.5));
	const k = Math.max(1, Math.min(live - 1, raw));

	const rotAcc = new Set<number>();
	for (const c of out.accents) {
		if (c < live) rotAcc.add((c + k) % live);
		else rotAcc.add(c);
	}
	out.accents = rotAcc;

	const rotSub: Record<number, number> = {};
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (c < live) rotSub[(c + k) % live] = s;
		else rotSub[c] = s;
	}
	out.subdivisions = rotSub;
	return out;
};

/**
 * Truncation (len=5): parent → постепенно урезанная live-зона через растущий deadStart.
 * На последнем шаге intensity=0.8 удаляет ≈0.95*live0 клеток в dead, оставляя опорный «огрызок».
 */
const truncationOperator: MutationOperator = (parent, role, intensity) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live0 = liveLen(out);
	if (live0 < 2) return out;
	const maxStep = Math.max(1, role.phraseLength - 1);
	const shrink = (role.phraseStep / maxStep) * (0.3 + intensity * 0.7);
	const targetLive = Math.max(1, Math.round(live0 * (1 - shrink)));
	const deadStart = Math.min(out.curSyl, Math.max(1, targetLive));
	out.deadStart = deadStart;

	const liveAcc = new Set<number>();
	for (const c of out.accents) if (c < deadStart) liveAcc.add(c);
	out.accents = liveAcc;
	const liveSubs: Record<number, number> = {};
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (c < deadStart) liveSubs[c] = s;
	}
	out.subdivisions = liveSubs;
	return out;
};

/**
 * Augmentation (len=3): parent → растущая плотность подделений на живых клетках без subdiv.
 * Это «augmentation» в смысле Carnatic-Gati-усложнения — больше ударов внутри долей,
 * а не удлинение времени (CurSyl/meter — это Jati, не трогаем).
 */
const augmentationOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 1) return out;
	const maxStep = Math.max(1, role.phraseLength - 1);
	const fraction = (role.phraseStep / maxStep) * (0.3 + intensity * 0.6);
	const free: number[] = [];
	for (let c = 0; c < live; c++) if (!(c in out.subdivisions)) free.push(c);
	if (free.length === 0) return out;
	const target = Math.max(1, Math.round(fraction * live));

	for (let i = free.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = free[i]!;
		free[i] = free[j]!;
		free[j] = tmp;
	}
	for (let i = 0; i < target && i < free.length; i++) {
		out.subdivisions[free[i]!] = 2 + Math.floor(rng() * 3);
	}
	return out;
};

/**
 * Diminution (len=3): обратное Augmentation — постепенно снимаем подделения, возвращая
 * клетки к плоскому пульсу. step=2 при intensity=0.8 снимает ~80% подделений.
 */
const diminutionOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const keys = Object.keys(out.subdivisions).map((k) => parseInt(k, 10)).filter((n) => Number.isFinite(n));
	if (keys.length === 0) return out;
	const maxStep = Math.max(1, role.phraseLength - 1);
	const fraction = (role.phraseStep / maxStep) * (0.4 + intensity * 0.6);
	const removeN = Math.max(1, Math.round(fraction * keys.length));

	for (let i = keys.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = keys[i]!;
		keys[i] = keys[j]!;
		keys[j] = tmp;
	}
	for (let i = 0; i < removeN && i < keys.length; i++) {
		delete out.subdivisions[keys[i]!];
	}
	return out;
};

/**
 * Prepend/Append (len=4): step=0 parent; step=1 добавляет opening-accent (idx=0);
 * step=2 добавляет closing-accent (idx=live-1); step=3 ставит оба (tihai-подобная рамка).
 */
const prependAppendOperator: MutationOperator = (parent, role) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 2) return out;
	const prepend = role.phraseStep === 1 || role.phraseStep === 3;
	const append = role.phraseStep === 2 || role.phraseStep === 3;
	if (prepend) out.accents.add(0);
	if (append) out.accents.add(live - 1);
	return out;
};

/**
 * Tihai (len=4): три пульса «вызова» + агрессивный landing.
 *
 * - step=0: parent-call
 * - step=1: вариация call (легче)
 * - step=2: вариация call (сильнее)
 * - step=3: landing на Sam (и конец фразы)
 *
 * При intensity >= ~1.0 (примерно chaos 70+) включается «turbo»: шаги 1/2
 * уплотняют subdivisions и расширяют акцентный рисунок заметно сильнее.
 */
const tihaiOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	const live = liveLen(out);
	if (live < 1) return out;

	if (role.phraseStep === 1 || role.phraseStep === 2) {
		// intensity>=0.7 ~= chaos 50+: heavy
		// intensity>=1.0 ~= chaos 70+: super tihai
		const heavy = intensity >= 0.7;
		const superTihai = intensity >= 1.0;
		const stepMul = role.phraseStep === 1 ? 1 : 2;
		const shift = Math.max(1, Math.min(Math.max(1, live - 1), Math.round(stepMul * (0.5 + intensity * 0.8))));

		// 1) Акцентный сдвиг + наращивание опорных точек.
		const nextAcc = new Set<number>();
		for (const c of out.accents) {
			if (c < live) nextAcc.add((c + shift) % live);
		}
		nextAcc.add(0);
		if (live > 1) nextAcc.add(live - 1);
		if (heavy) {
			for (let c = 1; c < live; c += 2) nextAcc.add(c);
		}
		if (superTihai) {
			for (let c = 0; c < live; c++) if (c % 3 === 0) nextAcc.add(c);
		}
		out.accents = nextAcc;

		// 2) Подплотнение: чем выше intensity, тем больше ячеек получают subdivisions.
		const density = superTihai
			? (role.phraseStep === 1 ? 0.85 : 1.0)
			: heavy
				? (role.phraseStep === 1 ? 0.65 : 0.9)
				: (role.phraseStep === 1 ? 0.35 : 0.6);
		for (let c = 0; c < live; c++) {
			if (rng() < density) {
				out.subdivisions[c] = superTihai
					? (4 + Math.floor(rng() * 3)) // 4..6
					: heavy
					? (3 + Math.floor(rng() * 3)) // 3..5
					: (2 + Math.floor(rng() * 3)); // 2..4
			}
		}
		// На step=2 в heavy/super убираем dead-зону — call перед landing должен "кричать".
		if ((heavy || superTihai) && role.phraseStep === 2) {
			delete out.deadStart;
		}
		return out;
	}

	// Landing: всегда звучный, фиксируем Sam + конец.
	if (role.phraseStep === 3) {
		out.accents.add(0);
		if (live > 1) out.accents.add(live - 1);
		// Landing должен быть слышимым даже если parent имел длинную dead-зону.
		delete out.deadStart;
	}
	return out;
};

/**
 * Echo decay (len=4): parent → затухающие эхо. На каждом шаге часть accents и subdivisions
 * снимается (amnesia-curve). intensity регулирует скорость затухания.
 */
const echoDecayOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const maxStep = Math.max(1, role.phraseLength - 1);
	// keepRatio: step=1 ≈ 0.7, step=3 ≈ 0.1 при intensity=0.8.
	const decayFactor = (role.phraseStep / maxStep) * (0.5 + intensity * 0.8);
	const keepRatio = Math.max(0, 1 - decayFactor);

	const pruneSet = <K>(set: Set<K>, rng: RNG) => {
		const arr = [...set];
		const kept = new Set<K>();
		for (const v of arr) {
			if (rng() < keepRatio) kept.add(v);
		}
		return kept;
	};

	out.accents = pruneSet(out.accents, rng);

	const keptSubs: Record<number, number> = {};
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		if (rng() < keepRatio) keptSubs[parseInt(cStr, 10)] = s;
	}
	out.subdivisions = keptSubs;
	return out;
};

/**
 * Neighbour pulsation (len=3): parent → соседняя пульсация ±1 клетка → parent.
 * step=0 parent (curSyl=N); step=1 curSyl=N±1 (направление — детерминистски от rng);
 * step=2 возвращает curSyl=N. Accent-каркас масштабируется пропорционально.
 *
 * «Neighbour» в Carnatic-смысле: движение по родственным Jati, не прыжок на дальние пульсы.
 */
const neighbourPulsationOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;
	if (role.phraseStep === 2) return out; // возврат к parent

	// step=1: соседняя пульсация. Направление: ±1 (ограничено [3..9]).
	const delta = rng() < 0.5 ? -1 : 1;
	const nextSyl = Math.max(3, Math.min(9, src.curSyl + delta));
	if (nextSyl === src.curSyl) return out;

	const scale = nextSyl / src.curSyl;
	const scaled: BarGenome = {
		curSyl: nextSyl,
		accents: new Set<number>(),
		subdivisions: {},
	};
	for (const c of out.accents) {
		const mapped = Math.min(nextSyl - 1, Math.max(0, Math.round(c * scale)));
		scaled.accents.add(mapped);
	}
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		const c = parseInt(cStr, 10);
		const mapped = Math.min(nextSyl - 1, Math.max(0, Math.round(c * scale)));
		scaled.subdivisions[mapped] = s;
	}
	// deadStart масштабируем пропорционально
	if (typeof out.deadStart === 'number') {
		scaled.deadStart = Math.min(nextSyl, Math.max(1, Math.round(out.deadStart * scale)));
	}
	// intensity не меняет структуру neighbour — она про соседство, не про силу.
	void intensity;
	return scaled;
};

/**
 * Call & fill (len=4): диалогическая пара. step=0 parent (call);
 * step=1 fill — уплотнение (augmentation-like subdivisions на свободных клетках);
 * step=2 parent снова (повтор call); step=3 fill — retrograde или сильнее augmentation.
 */
const callFillOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	// call-бары (step 0, 2) — чистый parent
	if (role.phraseStep === 0 || role.phraseStep === 2) return out;

	const live = liveLen(out);
	if (live < 1) return out;

	if (role.phraseStep === 1) {
		// Fill #1: уплотнение subdivisions на свободных клетках.
		const free: number[] = [];
		for (let c = 0; c < live; c++) if (!(c in out.subdivisions)) free.push(c);
		const target = Math.min(
			free.length,
			Math.max(1, Math.round(free.length * (0.5 + intensity * 0.7))),
		);
		for (let i = free.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			const tmp = free[i]!;
			free[i] = free[j]!;
			free[j] = tmp;
		}
		for (let i = 0; i < target && i < free.length; i++) {
			out.subdivisions[free[i]!] = 2 + Math.floor(rng() * 3);
		}
		return out;
	}

	// step=3: сильнее — retrograde + добавить акцент на live-1 (конец фразы).
	const lastLive = live - 1;
	const revAccents = new Set<number>();
	for (const c of out.accents) {
		if (c < live) revAccents.add(lastLive - c);
		else revAccents.add(c);
	}
	revAccents.add(lastLive);
	out.accents = revAccents;
	const revSubs: Record<number, number> = {};
	for (const [cStr, s] of Object.entries(out.subdivisions)) {
		const c = parseInt(cStr, 10);
		if (c < live) revSubs[lastLive - c] = s;
		else revSubs[c] = s;
	}
	out.subdivisions = revSubs;
	return out;
};

/**
 * Fractal (len=3): parent → на случайных живых клетках прописывается subdivision,
 * равный curSyl parent-такта — клетка «становится уменьшенной копией мотива».
 * Число фрактальных клеток растёт по step, ограничено intensity.
 */
const fractalOperator: MutationOperator = (parent, role, intensity, rng) => {
	const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
	const out = cloneBarGenome(src);
	if (role.phraseStep === 0) return out;

	const live = liveLen(out);
	if (live < 1) return out;
	const target = Math.max(1, Math.round((0.2 + intensity * 0.5) * role.phraseStep));
	const recSub = Math.max(2, Math.min(9, src.curSyl));
	const pool: number[] = [];
	for (let c = 0; c < live; c++) pool.push(c);
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = pool[i]!;
		pool[i] = pool[j]!;
		pool[j] = tmp;
	}
	for (let i = 0; i < target && i < pool.length; i++) {
		out.subdivisions[pool[i]!] = recSub;
	}
	return out;
};

/**
 * Реестр операторов по типу. Phase 2: Substitution/Retrograde/Inversion — настоящие.
 * Phase 3: Rotation/Truncation/Augmentation/Diminution/Prepend-Append/Fractal.
 * Phase 4: Tihai/Echo-decay/Neighbour/Call-fill.
 */
export const MUTATION_OPERATORS: Record<MutationType, MutationOperator> = {
	substitution: substitutionOperator,
	retrograde: retrogradeOperator,
	inversion: inversionOperator,
	rotation: rotationOperator,
	truncation: truncationOperator,
	augmentation: augmentationOperator,
	diminution: diminutionOperator,
	prepend_append: prependAppendOperator,
	fractal: fractalOperator,
	tihai: tihaiOperator,
	echo_decay: echoDecayOperator,
	neighbour_pulsation: neighbourPulsationOperator,
	call_fill: callFillOperator,
};

// ============================================================================
// Bar-boundary apply
// ============================================================================

export type ApplyParentModeArgs = {
	barIdx: number;
	parent: ParentGenome;
	schedule: PhraseSchedule;
	chaos: number;
	syllablesDefault: number;
	m: BarRandomizerMutable;
	rng: RNG;
	/** Для role='free' филлера — передаём те же оси, что и во free-режиме. */
	freeAxes: {
		randomPulsation: boolean;
		randomPattern: boolean;
		randomSpeed: boolean;
		randomBarSpeed: boolean;
		forceFirstBeat: boolean;
	};
};

/**
 * Одна итерация parent-режима на границе такта `barIdx` (как `applyRandomizerEffectsToBar`
 * в free-режиме). Маршрутизация по `schedule[barIdx]`:
 *
 * - role='parent' → копия parent.bars[role.parentBarIdx].
 * - role='free' → делегирует во free-random с текущими осями.
 * - role=MutationType → вызывает оператор из MUTATION_OPERATORS.
 *
 * Возвращает true если состояние бара изменилось (для триггера перестройки sequenceRef).
 */
export function applyParentModeBar(args: ApplyParentModeArgs): boolean {
	const { barIdx, parent, schedule, chaos, syllablesDefault, m, rng, freeAxes } = args;
	const role = schedule[barIdx];
	if (!role) return false;

	if (role.type === 'free') {
		return applyRandomizerEffectsToBar(
			barIdx,
			chaos,
			freeAxes.randomPulsation,
			freeAxes.randomPattern,
			freeAxes.randomSpeed,
			freeAxes.randomBarSpeed,
			false,
			syllablesDefault,
			m,
			rng,
			freeAxes.forceFirstBeat,
		);
	}

	let nextGenome: BarGenome;
	if (role.type === 'parent') {
		const src = parent.bars[role.parentBarIdx] ?? parent.bars[0]!;
		nextGenome = cloneBarGenome(src);
	} else {
		const op = MUTATION_OPERATORS[role.type];
		const intensity = chaosToIntensity(chaos);
		nextGenome = op(parent, role, intensity, rng);
	}

	const prevSyl = m.customSyllables[barIdx] ?? syllablesDefault;
	const prevAccents = new Set<string>();
	const prevSubs: Record<string, number> = {};
	for (let c = 0; c < 9; c++) {
		const k = `${barIdx}-${c}`;
		if (m.accents.has(k)) prevAccents.add(k);
		if (m.customSubdivisions[k] !== undefined) prevSubs[k] = m.customSubdivisions[k]!;
	}
	const prevDead = m.deadCells[barIdx]?.deadStart;

	applyGenomeToBar(barIdx, nextGenome, m);

	if (prevSyl !== nextGenome.curSyl) return true;
	if (prevDead !== nextGenome.deadStart) return true;
	const nextKeys = new Set<string>();
	for (const c of nextGenome.accents) nextKeys.add(`${barIdx}-${c}`);
	if (nextKeys.size !== prevAccents.size) return true;
	for (const k of nextKeys) if (!prevAccents.has(k)) return true;
	const nextSubKeys = Object.keys(nextGenome.subdivisions);
	if (nextSubKeys.length !== Object.keys(prevSubs).length) return true;
	for (const cStr of nextSubKeys) {
		const c = parseInt(cStr, 10);
		const k = `${barIdx}-${c}`;
		if (prevSubs[k] !== nextGenome.subdivisions[c]) return true;
	}
	return false;
}

// ============================================================================
// Snapshot serialization helpers (компактный JSON)
// ============================================================================

export type ParentGenomeJSON = {
	bars: Array<{
		curSyl: number;
		accents: number[];
		subdivisions: Record<string, number>;
		deadStart?: number;
	}>;
};

export function parentGenomeToJSON(p: ParentGenome): ParentGenomeJSON {
	return {
		bars: p.bars.map((b) => {
			const out: ParentGenomeJSON['bars'][number] = {
				curSyl: b.curSyl,
				accents: [...b.accents].sort((a, bb) => a - bb),
				subdivisions: { ...b.subdivisions },
			};
			if (typeof b.deadStart === 'number') out.deadStart = b.deadStart;
			return out;
		}),
	};
}

export function parentGenomeFromJSON(raw: unknown): ParentGenome | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as { bars?: unknown };
	if (!Array.isArray(o.bars) || o.bars.length < 1 || o.bars.length > 2) return null;
	const bars: BarGenome[] = [];
	for (const b of o.bars) {
		if (!b || typeof b !== 'object') return null;
		const bo = b as Record<string, unknown>;
		const curSyl = parseInt(String(bo.curSyl), 10);
		if (!Number.isFinite(curSyl) || curSyl < 1 || curSyl > 9) return null;
		const accentsIn = Array.isArray(bo.accents) ? bo.accents : [];
		const accents = new Set<number>();
		for (const a of accentsIn) {
			const n = parseInt(String(a), 10);
			if (Number.isFinite(n) && n >= 0 && n < curSyl) accents.add(n);
		}
		const subsIn = bo.subdivisions && typeof bo.subdivisions === 'object' ? (bo.subdivisions as Record<string, unknown>) : {};
		const subdivisions: Record<number, number> = {};
		for (const [k, v] of Object.entries(subsIn)) {
			const c = parseInt(k, 10);
			const s = parseInt(String(v), 10);
			if (Number.isFinite(c) && c >= 0 && c < curSyl && Number.isFinite(s) && s >= 2 && s <= 9) {
				subdivisions[c] = s;
			}
		}
		const barOut: BarGenome = { curSyl, accents, subdivisions };
		const ds = parseInt(String(bo.deadStart), 10);
		if (Number.isFinite(ds) && ds >= 0 && ds < curSyl) barOut.deadStart = ds;
		bars.push(barOut);
	}
	return { bars };
}

export function isMutationType(v: unknown): v is MutationType {
	return typeof v === 'string' && (ALL_MUTATION_TYPES as readonly string[]).includes(v);
}

export function isFormPresetId(v: unknown): v is FormPresetId {
	return typeof v === 'string' && (ALL_FORM_PRESETS as readonly string[]).includes(v);
}

export function isRandomMode(v: unknown): v is RandomMode {
	return v === 'free' || v === 'parent';
}
