/**
 * herdr-contract — shared event contract for herdr:blocked events
 *
 * Defines the stable event name and payload type used by authored emitters
 * (bash-permission, herdr-bridge) to communicate blocking state to Herdr.
 *
 * This contract is versioned with the workspace and must not change the
 * runtime event name or payload shape.
 */

/** Event name for herdr blocked state changes. */
export const HERDR_BLOCKED_EVENT: string = "herdr:blocked";

/** Payload for herdr:blocked events. */
export interface HerdrBlockedPayload {
  /** Whether a blocking interaction is active. */
  active: boolean;
  /** Human-friendly label shown in herdr status bar. */
  label?: string;
}

/**
 * Type guard for herdr:blocked event payloads.
 * Useful for testing that emitters produce the correct shape.
 */
export function isHerdrBlockedPayload(payload: unknown): payload is HerdrBlockedPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "active" in payload &&
    typeof (payload as HerdrBlockedPayload).active === "boolean"
  );
}
