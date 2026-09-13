# ADR 0001 — Browser tile rendering architecture

Status: accepted, 2026-09-03 (supersedes the 2026-09-02 native-view record).
Source spec: `specs/browser-overlay-coexistence/browser-overlay-coexistence.md` (internal repo).

## Context

A co-located Electron browser tile is a renderer-owned `<webview>` element, not a native `WebContentsView` and not a DOM iframe.
The canvas also renders DOM overlays on top of tiles: dialogs, popovers, selects, dropdown menus, tooltips, context menus, toasts.

The previous record kept a main-process `WebContentsView` as the local plane and solved overlay coexistence with an occlusion coordinator: capture a stand-in, park the native view, restore after paint-ack.
That physics is what produced the GitHub divider stall: motion registered as a synthetic occlusion owner, the live guest was replaced with a stale `object-contain` screenshot, and the site reflowed only after six idle frames.

## Physics and foundation

A `<webview>` participates in the trusted renderer's DOM compositor.
Ordinary `z-index`, stacking contexts, and CSS anchors apply.
No native-above-DOM interleaving remains for the local visible tile (`electron#15899` no longer describes this plane).

Guest birth is still main-owned for security.
The renderer receives identity and the granted partition only.
Main mints a one-use window-scoped attach grant, admits the blank guest at `will-attach-webview` / `did-attach-webview`, seeds cookies and localStorage, installs policy/CDP, then navigates.
`seedStorageState` never crosses into the renderer heap.
A guest's lifetime is bounded by its birth window, so a host-owned tab whose birth window closes is re-created, never migrated.

Placement is CSS, not bounds IPC.
Each tile surface publishes `anchor-name: --traycer-bv-<registrationId>`.
The persistent guest wrapper uses `position: fixed`, `position-anchor`, `anchor()`, and `anchor-size()`.
The guest is never reparented; pane and tile movement change only the assigned anchor.

Responsive testing keeps this topology. Fixed viewport intent supplies the
guest's intrinsic size; a CSS transform fits that page into the anchored
presentation rectangle. Fit clears the metrics override and resumes pane
sizing. The native bridge acknowledges logical viewport application, not
screen position or pane motion. Page state and guest identity survive both
operations; preview scale remains separate from browser page zoom.

Presentation states:

- selected and visible: anchored, opaque, interactive;
- retained (mounted tile, not presented): offscreen fixed viewport, `opacity: 0`, inert, still composited;
- live but surface-less (agent/CDP/PiP): fixed offscreen viewport, opacity 0, inert, still composited.

Electron documents `<webview>` as a tag Chromium may change.
Traycer accepts that platform risk in exchange for CSS-native resize, ordinary overlay stacking, and the deletion of the native geometry/occlusion subsystem.
Fail-closed attach hardening, incarnation-safe mount/release, crash rematerialization, and reserved-chord forwarding are load-bearing, not optional.

Two alternatives remain rejected.

**OSR shared-texture.**
Rejected for the same reasons as before: IME, accessibility, cursor, and focus have no path; the API is experimental.

**Transparent overlay-`WebContentsView` for popovers.**
Rejected: Radix portals live in the main renderer's React tree.

**Native `WebContentsView` with live bounds and no motion freeze.**
That would have fixed the divider stall with a smaller blast radius.
Rejected as the product plane: overlay stacking, CSS placement, and the deletion of the native geometry/occlusion subsystem require the `<webview>` cutover, not a motion-only patch.

Remote JPEG/WebRTC viewers and host-local/headless placement are unchanged.
A non-co-located GUI never creates a `<webview>`.

This cutover does not claim to fix the independent intermittent image-network failure.
Both planes use Chromium's network/session stack.

## Requirements

| Id  | Requirement                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The local compositing plane is a persistent renderer-owned `<webview>`. Geometry follows CSS anchors continuously, including through divider drag. There is no bounds IPC and no accepted one-frame native-view trail. |
| R2  | DOM overlays paint and receive input above the guest through ordinary stacking. There is no `capturePage` stand-in, paint-ack, or park/restore handshake for overlay coexistence.                                      |
| R3  | Guest identity (`webContentsId` and DOM parent) survives pane reorder, split reversal, tab selection, and tile transfer. Only the CSS `position-anchor` assignment changes.                                            |
| R4  | Focusing or clicking the guest activates its owning canvas pane. App and browser shortcuts target that pane.                                                                                                           |
| R5  | A presented guest is interactive. A retained guest is inert, offscreen and still composited. An unbound paintable guest cannot appear or receive user input, but remains composited for CDP/capture.                   |
| R6  | Main admits only a blank guest matching a pending one-use grant for the same window, partition, and registration. Privilege stripping, request gating, and seed secrecy are unchanged.                                 |
| R7  | Host-local, headless, and remote JPEG/WebRTC selection plus `browser.sessions` protocol behavior remain unchanged.                                                                                                     |
| R8  | Toast placement may prefer positions that avoid live tile rects. That is UX, not native occlusion.                                                                                                                     |
| R9  | Canvas motion does not freeze, hide, or snapshot the guest.                                                                                                                                                            |
| R10 | Light-dismiss clicks on overlays behave as ordinary DOM. There is no parked native view to swallow or forward input into.                                                                                              |
| R11 | Portal primitives stay behind the shadcn wrappers in `src/components/ui/`.                                                                                                                                             |
| R12 | No runtime flag and no supported `WebContentsView` fallback ship.                                                                                                                                                      |

Historical R2–R10 from the 2026-09-02 native-view record (paint-ack, frame cache, six-frame motion hysteresis, `capturePage` stand-ins) are withdrawn.
The measured numbers in that record described the deleted native handshake and are not physics of the current plane.

## Addendum — the guest is also a mirror source (2026-09-12)

The accepted decision above is unchanged. For the local user, a co-located tile
is still a persistent renderer-owned `<webview>` on CSS anchors, and every
requirement R1–R12 still holds as written.

What changed is who else reads that guest's pixels. A natively placed tab used
to have no plane a remote viewer could be served on, and the host answered a
remote open by tearing the tab down and re-opening it headless. That machinery
is deleted. The guest is now additionally the pixel **source** for remote
viewers of the same tab: the desktop runs `Page.startScreencast` on it over the
guest's shared `BrowserDebugSession` and pumps JPEG frames to the host on a
per-tab `browser.mirror` stream, which fans them out to that tab's
`browser.screencast` subscribers. The tab never moves, and a desktop too old to
mirror yields a refusal rather than a relocation. R7's "remote JPEG/WebRTC
selection unchanged" now reads: a mirrored native tab is JPEG-only; the WebRTC
plane remains for headless tabs only, since its capture needs a page the host
itself owns.

Two consequences matter to this ADR's readers.

**The guest keeps rendering while a mirror viewer is attached.** A minimized,
occluded or locked window must still produce frames, so the desktop holds
`setBackgroundThrottling(false)` on the mirrored guest for the life of the
mirror and restores it on every exit path, with a low-rate `capturePage` poller
behind the screencast for the states a screencast does not survive. This is not
the withdrawn occlusion handshake returning: nothing is parked, snapshotted or
substituted for the live guest, and the local user's tile is untouched. The
`capturePage` here is an out-of-band read of a window nobody is looking at, not
a stand-in composited in the tile's place.

**A remote viewer's Fit reflows the local user's own tile.** Fit follows the
last deliberately active viewer and the report now carries a pointer class, so a
phone holding Fit lays the shared page out as a phone in the desktop window too
— rendered like the tile's own responsive viewport control. Accepted; a desktop
click takes Fit back.
