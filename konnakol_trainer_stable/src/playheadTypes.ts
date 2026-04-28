/** Playhead position on grid; in poly mode `voice` equals sub_legacy scheduler laneId. */
export type PlayheadPosition = { r: number; c: number; absR: number; voice: number; step: number };

export type PlayheadHighlightEvent = { t: number; pos: PlayheadPosition };
