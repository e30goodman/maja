/**
 * UI-слой для Parent-mode: какие мутации включены при выборе Form preset.
 * Логика операторов / scheduler не меняется — только дефолтные пулы для `enabledMutations`.
 */
import { ALL_MUTATION_TYPES, type FormPresetId, type MutationType } from './parentMode';

const MIN_PARENT_BARS = 1;
const MAX_PARENT_BARS = 32;

/** Пул мутаций для каждого пресета формы (subset или полный набор). */
export const PRESET_ENABLED_MUTATIONS: Record<FormPresetId, readonly MutationType[]> = {
	random: [...ALL_MUTATION_TYPES],
	tihai_heavy: [
		'tihai',
		'truncation',
		'prepend_append',
		'echo_decay',
		'substitution',
		'retrograde',
	],
	/** Scheduler сам выбирает порядок «простое→сложное» среди включённых кандидатов. */
	progressive: [...ALL_MUTATION_TYPES],
	call_fill: [
		'call_fill',
		'prepend_append',
		'substitution',
		'diminution',
		'fractal',
		'echo_decay',
		'retrograde',
	],
};

/** Целевая «композиционная» длина по стилю (в барах). */
export const PRESET_TARGET_BARS: Record<FormPresetId, number> = {
	random: 16,
	tihai_heavy: 24,
	progressive: 32,
	call_fill: 16,
};

export function clampParentTargetBars(raw: number): number {
	const n = Math.floor(raw);
	if (!Number.isFinite(n)) return MIN_PARENT_BARS;
	return Math.max(MIN_PARENT_BARS, Math.min(MAX_PARENT_BARS, n));
}

export function mutationSetsEqual(a: readonly MutationType[], b: readonly MutationType[]): boolean {
	if (a.length !== b.length) return false;
	const sa = [...a].sort();
	const sb = [...b].sort();
	for (let i = 0; i < sa.length; i++) {
		if (sa[i] !== sb[i]) return false;
	}
	return true;
}

/** true если набор мутаций не совпадает со стандартным пулом выбранного пресета (ручная правка / снэпшот). */
export function isEnabledMutationsCustomForPreset(enabled: MutationType[], preset: FormPresetId): boolean {
	return !mutationSetsEqual(enabled, PRESET_ENABLED_MUTATIONS[preset]);
}
