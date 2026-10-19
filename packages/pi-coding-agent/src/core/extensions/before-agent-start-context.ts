/**
 * Module-scoped dispatch context attached to `before_agent_start` events.
 *
 * The embedding host (e.g. the gsd auto-dispatch loop) knows which unit/phase
 * it is about to run an agent turn for, but the `BeforeAgentStartEvent` is
 * constructed inside the extension runner without that knowledge. The host
 * writes the context here right before dispatch; the runner reads it at
 * emission time and attaches it to the event. Cleared when the dispatch ends
 * so non-dispatch turns never observe stale fields (#1997).
 */

export interface BeforeAgentStartDispatchContext {
	/** Unit type being dispatched, if known (e.g. "execute-unit"). */
	unitType?: string;
	/** GSD phase being dispatched, if known (e.g. "executing"). */
	phase?: string;
}

let _context: BeforeAgentStartDispatchContext | undefined;

export function setBeforeAgentStartContext(context: BeforeAgentStartDispatchContext | undefined): void {
	// Copy so later mutation of the caller's object cannot change what the
	// runner attaches to events emitted after the setter call.
	_context = context ? { ...context } : undefined;
}

export function getBeforeAgentStartContext(): BeforeAgentStartDispatchContext | undefined {
	return _context;
}
