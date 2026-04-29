/**
 * Playhead indicators for poly sub_legacy: each temporal lane (`PolySubLegacyScheduler` lane)
 * has its own slot. Event queue is time-shared; without persistent storage on wake only the latest
 * drained event batch survives, so other lanes "dim" until their next scheduled t.
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
