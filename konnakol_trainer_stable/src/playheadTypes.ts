/** Позиция playhead на сетке; в poly `voice` совпадает с laneId планировщика sub_legacy. */
export type PlayheadPosition = { r: number; c: number; absR: number; voice: number; step: number };

export type PlayheadHighlightEvent = { t: number; pos: PlayheadPosition };
