/** Playhead position on grid; in poly mode `voice` equals sub_legacy scheduler laneId. */
export type PlayheadPosition = {
	r: number;
	c: number;
	absR: number;
	voice: number;
	/** Poly cycle label; grid highlight matches `step` + `voice` (fused uses display step from scheduler). */
	step: number;
};

export type PlayheadHighlightEvent = {
	t: number;
	pos: PlayheadPosition;
};

export function playheadActiveSignature(positions: readonly PlayheadPosition[]): string {
	return positions.map((p) => `${p.voice}:${p.r}:${p.c}:${p.step}`).join('|');
}
