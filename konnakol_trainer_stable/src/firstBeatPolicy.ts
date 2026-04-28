/**
 * First-beat policy для Ta/c0 — audio layer (runtime + midi).
 *
 * Этот модуль намеренно чистый (без React/audio), чтобы покрывать его тестами
 * и фиксировать контракт из `TA_LOGIC_GUIDE.md` §5, §14.
 *
 * КОНТРАКТ (не менять без обновления гайда):
 * - `resolveFirstBeatHitRow` зависит ТОЛЬКО от 5 аргументов:
 *   `policy`, `on0Accent`, `on0Ding`, `firstBeatEnabled`, `suppressedRow`.
 *   Никаких hidden dependency (`accentMapVersion`, `squarePlaybackMode`, ...).
 * - `resolveRuntimeFirstBeatPolicy`:
 *   - mono → `'legacy'`;
 *   - poly lane0 → `'legacy'`;
 *   - poly lane>0 → `'explicit_ta_only'`.
 *
 * Identical duplicates живут в `App.tsx` / `midiExport.ts` для backward-compat;
 * поведение ОБЯЗАНО совпадать (см. parity тесты).
 */

export type FirstBeatHitPolicy = 'legacy' | 'explicit_any' | 'explicit_ta_only';
export type LaneId = 0 | 1 | 2;

export function resolveFirstBeatHitRow(
	policy: FirstBeatHitPolicy,
	on0Accent: boolean,
	on0Ding: boolean,
	firstBeatEnabled: boolean,
	suppressedRow: boolean,
): boolean {
	if (policy === 'explicit_ta_only') return on0Ding;
	if (policy === 'explicit_any') return on0Accent || on0Ding;
	/** legacy */
	if (suppressedRow) return on0Ding;
	return on0Accent || on0Ding || firstBeatEnabled;
}

export function resolveRuntimeFirstBeatPolicy(isPoly: boolean, laneId: LaneId): FirstBeatHitPolicy {
	if (!isPoly) return 'legacy';
	return laneId === 0 ? 'legacy' : 'explicit_ta_only';
}
