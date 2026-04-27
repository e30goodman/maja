/**
 * Press Matrix coordinator.
 *
 * Module-scope state machine for the "printing press" feature. Holds:
 *  - `primed` boolean — true after a successful arm event.
 *  - `baselineState` — frozen `PressState` snapshot captured at arm time.
 *  - `baselineBars` — bar count at arm time. Tile uses this as the cylinder size.
 *
 * Activation contract: arming is explicit (long-press on the Bars slider thumb
 * in `App.tsx`, without pointer slop before hold completes). After arming,
 * edits to the live state DO NOT mutate the
 * baseline — only a re-arm replaces it.
 *
 * Deactivation contract: full Eraser, or explicit `disarm`. After deactivation,
 * baseline is cleared and `primed` returns false.
 */

import { clonePressState, type PressState } from './pressMatrix';

let primed = false;
let baselineState: PressState | null = null;
let baselineBars = 0;

export function isPressPrimed(): boolean {
	return primed && baselineState !== null && baselineBars >= 1;
}

/**
 * Freezes the current `PressState` as the baseline. Re-arming overwrites the
 * previous baseline — that is the intended UX for "give me a new template".
 */
export function armPressFromState(state: PressState): void {
	baselineState = clonePressState(state);
	baselineBars = Math.max(1, state.bars | 0);
	primed = true;
}

export function getPressBaseline(): { state: PressState; bars: number } | null {
	if (!primed || baselineState === null) return null;
	return { state: baselineState, bars: baselineBars };
}

/**
 * Hard reset: drop baseline and disarm. Called from full Eraser handler.
 */
export function notifyPressErased(): void {
	primed = false;
	baselineState = null;
	baselineBars = 0;
}

/**
 * Test helper. Not called from production code.
 */
export function _resetPressCoordinatorForTests(): void {
	primed = false;
	baselineState = null;
	baselineBars = 0;
}
