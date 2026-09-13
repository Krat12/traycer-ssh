import { describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import { draftClaimUserMessage } from "@/hooks/drafts/use-draft-claim";

const STUB_DRAFT: DraftDocument = {
  draftId: "draft-1",
  kind: "landing",
  target: { epicId: null, chatId: null, blockId: null },
  revision: 1,
  lastTouchedAt: 1,
  workspace: null,
  ownerHostId: "host-a",
  origin: "own",
  adoption: { state: "adopted", hostId: "host-a" },
  publication: {
    status: "unpublished",
    lastPublishedAt: null,
    publishedRevision: null,
    halted: null,
  },
  portable: {
    content: { type: "doc", content: [] },
    selection: null,
    runSettings: null,
    composerMode: "chat",
    blobHashes: [],
    closed: false,
  },
};

describe("draftClaimUserMessage", () => {
  it("names unsupported-version instead of a generic failure", () => {
    expect(
      draftClaimUserMessage({
        status: "unavailable",
        reason: "unsupported-version",
      }),
    ).toBe("This draft needs a newer Traycer to sync.");
  });

  it("answers every non-takeover outcome, so the banner is never mute", () => {
    // A silent claim under the user's edit failed; a null here would hide
    // that their edits are staying on this device until it succeeds.
    expect(
      draftClaimUserMessage({
        status: "unavailable",
        reason: "plan-ineligible",
      }),
    ).toBe("Syncing this draft needs a paid plan. Edits stay on this device.");
    expect(
      draftClaimUserMessage({
        status: "unavailable",
        reason: "not-found",
      }),
    ).toBe("This draft was deleted elsewhere. Edits stay on this device.");
    expect(
      draftClaimUserMessage({
        status: "unavailable",
        reason: "not-published",
      }),
    ).toBe("This draft has not been backed up yet. Edits stay on this device.");
    expect(
      draftClaimUserMessage({
        status: "unavailable",
        reason: "publication-not-ready",
      }),
    ).toBe("Backup is still starting. Edits stay on this device for now.");
    expect(draftClaimUserMessage({ status: "unsupported" })).toBe(
      "Edits stay on this device until Traycer is updated here.",
    );
    expect(draftClaimUserMessage({ status: "failed" })).toBe(
      "Edits stay on this device for now. Could not sync this draft.",
    );
  });

  it("returns null only for a takeover - ok or already-owned", () => {
    expect(
      draftClaimUserMessage({ status: "ok", draft: STUB_DRAFT }),
    ).toBeNull();
    expect(
      draftClaimUserMessage({ status: "already-owned", draft: STUB_DRAFT }),
    ).toBeNull();
  });
});
