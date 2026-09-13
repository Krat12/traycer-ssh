import { beforeEach, describe, expect, it } from "vitest";
import {
  selectLandingReceipt,
  useLandingReceiptsStore,
  type LandingReceipt,
} from "@/stores/onboarding/landing-receipts-store";

function receipt(attemptId: string): LandingReceipt {
  return {
    kind: "prompt-accepted",
    attemptId,
    draftId: `draft-${attemptId}`,
    epicId: `epic-${attemptId}`,
    tabId: `tab-${attemptId}`,
    hostId: "host-a",
  };
}

beforeEach(() => {
  useLandingReceiptsStore.getState().reset();
});

describe("landing receipts store", () => {
  it("keeps the first receipt for an attempt (duplicate emit is idempotent)", () => {
    const store = useLandingReceiptsStore.getState();
    store.emit(receipt("a"));
    const before = useLandingReceiptsStore.getState().byAttemptId;
    store.emit({ ...receipt("a"), epicId: "epic-other" });
    expect(useLandingReceiptsStore.getState().byAttemptId).toBe(before);
    expect(selectLandingReceipt(useLandingReceiptsStore.getState(), "a")).toEqual(
      receipt("a"),
    );
  });

  it("consume hands the receipt out exactly once and drops its dispatch", () => {
    const store = useLandingReceiptsStore.getState();
    store.announce({
      kind: "prompt-accepted",
      attemptId: "a",
      draftId: "draft-a",
      hostId: "host-a",
    });
    store.emit(receipt("a"));
    expect(store.consume("a")).toEqual(receipt("a"));
    expect(store.consume("a")).toBeNull();
    expect(useLandingReceiptsStore.getState().dispatchedByAttemptId).toEqual(
      {},
    );
    expect(selectLandingReceipt(useLandingReceiptsStore.getState(), null)).toBe(
      undefined,
    );
  });

  it("is bounded: unrelated creates evict the oldest, never a newer relevant one", () => {
    const store = useLandingReceiptsStore.getState();
    for (let index = 0; index < 12; index += 1) {
      store.emit(receipt(`r${index}`));
    }
    const kept = Object.keys(useLandingReceiptsStore.getState().byAttemptId);
    expect(kept).toHaveLength(8);
    expect(kept[0]).toBe("r4");
    expect(kept[7]).toBe("r11");
  });

  it("reset clears receipts and dispatches, and bumps nothing else", () => {
    const store = useLandingReceiptsStore.getState();
    store.announce({
      kind: "tui-accepted",
      attemptId: "t",
      draftId: null,
      hostId: "host-a",
    });
    store.emit(receipt("t"));
    const sequence = useLandingReceiptsStore.getState().dispatchSequence;
    store.reset();
    expect(useLandingReceiptsStore.getState().byAttemptId).toEqual({});
    expect(useLandingReceiptsStore.getState().dispatchedByAttemptId).toEqual(
      {},
    );
    expect(useLandingReceiptsStore.getState().dispatchSequence).toBe(sequence);
  });
});
