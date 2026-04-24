/**
 * Индикаторы playhead для poly sub_legacy: у каждой временной линии (`PolySubLegacyScheduler` lane)
 * свой слот. Очередь событий общая по времени — без persistent-хранилища при wake срабатывает только
 * последняя порция снятых событий, остальные линии «гаснут» до следующего своего t.
 */
import type { PlayheadPosition } from './playheadTypes';

export function comparePolyPlayheadRows(a: PlayheadPosition, b: PlayheadPosition): number {
	if (a.step !== b.step) return a.step - b.step;
	return a.voice - b.voice;
}

export function createPolySubLegacyLaneIndicatorStore() {
	const slotByLaneId = new Map<number, PlayheadPosition>();

	return {
		recordLaneEmit(pos: PlayheadPosition) {
			slotByLaneId.set(pos.voice, pos);
		},
		orderedSnapshot(): PlayheadPosition[] {
			return Array.from(slotByLaneId.values()).sort(comparePolyPlayheadRows);
		},
		clear() {
			slotByLaneId.clear();
		},
	};
}

export type PolySubLegacyLaneIndicatorStore = ReturnType<typeof createPolySubLegacyLaneIndicatorStore>;
