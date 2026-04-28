/**
 * Square playback gate (runtime audio).
 *
 * Контракт (TA_LOGIC_GUIDE.md §9 + §14):
 * - `all_beats`: играют все клетки.
 * - `accent_only`: играют только accent/Ta/first-beat-Ta.
 * - `passive_only`: играют только Ta/first-beat-Ta события; обычные passive клетки глушатся.
 *
 * КРИТИЧНО: в `passive_only` gate НЕ должен обнулять Ta/first-beat события
 * из-за `isAccent=true`. Иначе клетка с mixed `Ta+accent` останется немой,
 * хотя на ней был explicit Ta и slot ожидает звук.
 *
 * Helper отделён от App.tsx, чтобы покрывать контракт unit-тестами и
 * защитить его от регрессий при будущих правках gate-логики.
 */

export type SquarePlaybackMode = 'all_beats' | 'accent_only' | 'passive_only';

export type SquareGateInput = {
	playbackMode: SquarePlaybackMode;
	isAccent: boolean;
	hasTaDingHere: boolean;
	shouldPlayFirstBeatTa: boolean;
};

export function shouldPlayBeatForSquareGate(input: SquareGateInput): boolean {
	const { playbackMode, isAccent, hasTaDingHere, shouldPlayFirstBeatTa } = input;
	if (playbackMode === 'all_beats') return true;
	if (playbackMode === 'accent_only') return isAccent || hasTaDingHere || shouldPlayFirstBeatTa;
	/** passive_only */
	return hasTaDingHere || shouldPlayFirstBeatTa;
}
