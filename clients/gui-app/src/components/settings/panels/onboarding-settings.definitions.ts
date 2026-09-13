import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

/**
 * Page-only for now: the lesson cards and their anchors arrive with the
 * page's content. Indexing an anchor before the card that carries it exists
 * would make a search result that scrolls to nothing.
 */
export const ONBOARDING = defineSettingsSection("onboarding", {
  page: {
    label: "Onboarding",
    description:
      "Guided tours and lessons for the desktop app - pick up where you left off, or replay one.",
    keywords: [
      "onboarding",
      "tour",
      "product tour",
      "welcome",
      "first run",
      "learn",
      "lessons",
      "replay",
      "walkthrough",
      "guide",
      "intro",
    ],
  },
});
