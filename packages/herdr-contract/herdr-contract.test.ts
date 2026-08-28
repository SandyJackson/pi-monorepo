import { describe, expect, it } from "vitest";
import { HERDR_BLOCKED_EVENT, type HerdrBlockedPayload, isHerdrBlockedPayload } from "./index.js";

describe("herdr-contract", () => {
  describe("event name", () => {
    it("exports the correct event name", () => {
      expect(HERDR_BLOCKED_EVENT).toBe("herdr:blocked");
    });
  });

  describe("payload type guard", () => {
    it("accepts valid payload with active true", () => {
      const payload: HerdrBlockedPayload = { active: true };
      expect(isHerdrBlockedPayload(payload)).toBe(true);
    });

    it("accepts valid payload with active false", () => {
      const payload: HerdrBlockedPayload = { active: false };
      expect(isHerdrBlockedPayload(payload)).toBe(true);
    });

    it("accepts payload with label", () => {
      const payload: HerdrBlockedPayload = { active: true, label: "Waiting" };
      expect(isHerdrBlockedPayload(payload)).toBe(true);
    });

    it("rejects null", () => {
      expect(isHerdrBlockedPayload(null)).toBe(false);
    });

    it("rejects undefined", () => {
      expect(isHerdrBlockedPayload(undefined)).toBe(false);
    });

    it("rejects non-object", () => {
      expect(isHerdrBlockedPayload("string")).toBe(false);
    });

    it("rejects missing active field", () => {
      expect(isHerdrBlockedPayload({ label: "test" })).toBe(false);
    });

    it("rejects non-boolean active", () => {
      expect(isHerdrBlockedPayload({ active: "true" })).toBe(false);
    });
  });
});
