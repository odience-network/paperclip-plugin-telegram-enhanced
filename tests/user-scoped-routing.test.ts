import { describe, it, expect } from "vitest";
import {
  resolveOwnerChatId,
  resolveActorUserId,
  evaluateDecisionActor,
  resolveInteractionRouting,
} from "../src/decision-routing.js";

/**
 * Regression tests for user-scoped Telegram decision routing (ODIAA-938 / TWX-517/525)
 * and its ownership guard, mapped to the ODIAA-942 security review acceptance conditions.
 *
 * Each guard test is written so it FAILS against pre-guard behaviour (which had no
 * ownership concept and let any actor act) and PASSES with the deny-by-default guard.
 *
 * The authorization boundary lives entirely in the pure functions exercised here; the
 * callback and native-reply paths in worker.ts both delegate to `evaluateDecisionActor`,
 * and the dispatch path delegates routing to `resolveInteractionRouting`, so testing
 * these functions covers both code paths' security behaviour.
 */

const ALICE = "user-alice";
const BOB = "user-bob";
const ALICE_TG_ID = 1001; // immutable numeric Telegram id
const BOB_TG_ID = 2002;

describe("resolveOwnerChatId (userChatMappings)", () => {
  const mappings = { [ALICE]: "chat-alice", [BOB]: "chat-bob", "user-empty": "" };

  it("routes a mapped owner to their chat", () => {
    expect(resolveOwnerChatId(mappings, ALICE)).toBe("chat-alice");
  });
  it("returns null for an unmapped user", () => {
    expect(resolveOwnerChatId(mappings, "user-nobody")).toBeNull();
  });
  it("treats an empty chat id as unmapped", () => {
    expect(resolveOwnerChatId(mappings, "user-empty")).toBeNull();
  });
  it("returns null when mappings/userId absent", () => {
    expect(resolveOwnerChatId(undefined, ALICE)).toBeNull();
    expect(resolveOwnerChatId(mappings, null)).toBeNull();
  });
});

describe("resolveActorUserId — keyed strictly on immutable numeric id (Finding 2)", () => {
  it("resolves a bare numeric-id key", () => {
    expect(resolveActorUserId({ [String(ALICE_TG_ID)]: ALICE }, ALICE_TG_ID)).toBe(ALICE);
  });
  it("resolves a namespaced tg_id: key", () => {
    expect(resolveActorUserId({ [`tg_id:${ALICE_TG_ID}`]: ALICE }, ALICE_TG_ID)).toBe(ALICE);
  });
  it("NEVER resolves via a username key (username takeover must not grant ownership)", () => {
    // Admin misconfigured a username-style key. The attacker now holds @alice but a
    // different numeric id. Resolution by id must ignore the username entry entirely.
    const usernameKeyed = { "@alice": ALICE, alice: ALICE };
    expect(resolveActorUserId(usernameKeyed, 9999)).toBeNull();
  });
  it("returns null for missing / non-finite ids", () => {
    expect(resolveActorUserId({ "1001": ALICE }, undefined)).toBeNull();
    expect(resolveActorUserId({ "1001": ALICE }, null)).toBeNull();
    expect(resolveActorUserId({ "1001": ALICE }, Number.NaN)).toBeNull();
  });
});

describe("evaluateDecisionActor — deny-by-default ownership guard (Findings 1-3)", () => {
  const actorMap = { [String(ALICE_TG_ID)]: ALICE, [String(BOB_TG_ID)]: BOB };

  // Condition 5 #4 — owner-less / broadcast decisions stay allowed for anyone.
  it("allows anyone when there is no owner (legacy broadcast)", () => {
    expect(evaluateDecisionActor({ ownerUserId: undefined, telegramActorMappings: actorMap, fromId: BOB_TG_ID }).allowed).toBe(true);
    expect(evaluateDecisionActor({ ownerUserId: null, telegramActorMappings: undefined, fromId: 7 }).allowed).toBe(true);
  });

  // Positive control — the real owner is allowed.
  it("allows the mapped owner acting on their own decision", () => {
    const r = evaluateDecisionActor({ ownerUserId: ALICE, telegramActorMappings: actorMap, fromId: ALICE_TG_ID });
    expect(r).toEqual({ allowed: true, actorUserId: ALICE });
  });

  // Condition 5 #1 (callback) + #2 (native-reply) — cross-user reject.
  it("denies a different mapped user acting on someone else's decision", () => {
    const r = evaluateDecisionActor({ ownerUserId: ALICE, telegramActorMappings: actorMap, fromId: BOB_TG_ID });
    expect(r).toEqual({ allowed: false, actorUserId: BOB });
  });

  // Condition 5 #3 — unmapped actor on an owned decision must DENY (fail closed).
  it("denies an unmapped actor on an owned decision (no fail-open)", () => {
    const r = evaluateDecisionActor({ ownerUserId: ALICE, telegramActorMappings: actorMap, fromId: 9999 });
    expect(r).toEqual({ allowed: false, actorUserId: null });
  });

  // Condition 5 #5 — username takeover does NOT grant ownership when guard is id-keyed.
  it("denies an attacker who took the owner's @username but has a different id", () => {
    const usernameKeyed = { "@alice": ALICE }; // misconfig: username key, not id
    const r = evaluateDecisionActor({ ownerUserId: ALICE, telegramActorMappings: usernameKeyed, fromId: 9999 });
    expect(r.allowed).toBe(false);
  });

  it("denies when the owner is set but actor mappings are entirely absent", () => {
    expect(evaluateDecisionActor({ ownerUserId: ALICE, telegramActorMappings: undefined, fromId: ALICE_TG_ID }).allowed).toBe(false);
  });
});

describe("resolveInteractionRouting — owner routing + fail-closed setup notice (Finding 4)", () => {
  const userChat = { [ALICE]: "chat-alice" };

  it("broadcasts (no owner, no notice) when no targetUserId", () => {
    expect(resolveInteractionRouting(null, userChat)).toEqual({ needsSetupNotice: false });
  });

  it("routes to owner chat and stamps ownerUserId when target is mapped", () => {
    expect(resolveInteractionRouting(ALICE, userChat)).toEqual({
      ownerUserId: ALICE,
      targetChatId: "chat-alice",
      needsSetupNotice: false,
    });
  });

  it("requests a setup notice (NOT a broadcast) when target has no chat mapping", () => {
    // Condition: an owned decision with an unmapped owner must never silently fall back
    // to an actionable broadcast in the shared approvals chat.
    const r = resolveInteractionRouting(BOB, userChat);
    expect(r.needsSetupNotice).toBe(true);
    expect(r.ownerUserId).toBeUndefined();
    expect(r.targetChatId).toBeUndefined();
  });
});

describe("Condition 6 — ownerUserId persistence contract", () => {
  // The dispatch handler stamps `ownerUserId` into the mappingOverride only when
  // resolveInteractionRouting returns it; notify() then spreads that same override
  // object into BOTH the msg_<chat>_<msgId> mapping and the pending-decision record
  // (existing, separately-tested notify() behaviour). This test pins the invariant
  // that owner-routed decisions carry an ownerUserId and broadcasts do not — the field
  // a guard relies on to fire at all.
  it("owner-routed decision yields an ownerUserId to persist", () => {
    const routing = resolveInteractionRouting(ALICE, { [ALICE]: "chat-alice" });
    expect(routing.ownerUserId).toBe(ALICE);
  });
  it("broadcast decision yields no ownerUserId (guard stays inert, anyone may act)", () => {
    const routing = resolveInteractionRouting(undefined, { [ALICE]: "chat-alice" });
    expect(routing.ownerUserId).toBeUndefined();
  });
});
