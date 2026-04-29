# HANDBOOK: Atomic Gesture-Mutex Logic

## Purpose
Standard for complex UI grids to eliminate Tap vs Hold race conditions.

## The Mutex Mechanism
Replace `clearTimeout` dependency with a state-machine mutex.

### ARMED
- Trigger: `onPointerDown`.
- Action: timer started.
- State: waiting for hold duration or `pointerUp`.

### HOLD-FIRED
- Trigger: hold timer fired.
- Action: execute domain hold action (example: Unmute).
- State: LOCK SET for this cell.
- Rule: ignore all other events for this cell until reset.

### CLICK-FIRED
- Trigger: `onPointerUp` before hold timer.
- Action: execute click action.
- State: LOCK SET for this cell.
- Rule: kill timer immediately.

## Technical Constraint: Proxy Method
If a slider already works, gesture handler must call the same internal function used by that slider.

Do not duplicate domain logic inside gesture event handlers.
