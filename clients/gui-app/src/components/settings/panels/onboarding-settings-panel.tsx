/**
 * Docs: see ../SETTINGS.md
 * Update that file whenever this settings surface changes.
 */
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { ONBOARDING } from "@/components/settings/panels/onboarding-settings.definitions";
import { isSettingsSectionVisible } from "@/lib/settings-sections";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";

/**
 * Settings ▸ Onboarding: the desktop learning page. The progress summary,
 * tour cards and lesson demos land here next; this is the registered page
 * they mount into, so the section already resolves as a route, a modal
 * section and a remembered tab path before any of them exist.
 *
 * The builds that omit the section (the mobile app) never list it and their
 * route redirects, but a retained `SettingsSurface` can still mount this
 * panel from a remembered path it resolved itself. The visibility check here
 * is that last guard: on such a build the page says so and renders no lesson
 * surface, rather than offering desktop lessons a phone cannot run.
 */
export function OnboardingSettingsPanel() {
  const compact = useSettingsDensity() === "compact";
  const offered = isSettingsSectionVisible("onboarding");
  return (
    <SettingsPanelShell
      title={ONBOARDING.page.label}
      description={ONBOARDING.page.description}
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div
        data-testid="onboarding-settings-panel"
        data-lessons={offered ? "desktop" : "unavailable"}
        className={cn("flex flex-col", compact ? "gap-3.5" : "gap-5")}
      >
        {offered ? null : (
          <p className="max-w-[72ch] text-ui-sm text-muted-foreground">
            The tours and lessons cover the desktop app. Open Settings ▸
            Onboarding on your desktop to play them.
          </p>
        )}
      </div>
    </SettingsPanelShell>
  );
}
