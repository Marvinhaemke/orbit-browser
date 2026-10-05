# Native Firefox integration

## Source and build

`firefox-source.json` pins Mozilla’s `mozilla-firefox/firefox` Git repository to revision `3f73c528a1ae5784ea5e1ee2c5ad3762507395f2`. The first artifact build targets that same revision, rather than silently mixing an arbitrary engine with the UI source.

`overlay/` mirrors Firefox source paths. Preparation verifies Git blob hashes for the upstream files it needs to modify, installs the overlay, registers the new component, packages its UI assets into Firefox’s browser chrome, and applies Orbit’s prototype branding. An upstream upgrade is a deliberate change to the pin and hook expectations.

The Windows pipeline bootstraps the supported Mozilla toolchain, rebuilds the frontend, packages the browser, then launches that browser with a disposable profile for a native runtime smoke test. It must pass before the downloadable artifact is uploaded. For updater or test changes with unchanged native source, configuration, build environment, and build command, it can reuse a retained native build from this repository's `main` branch. The internal build cache is recorded after packaging and may be untested; source, workflow, run provenance, and every file hash are verified before reuse. All fresh-browser and updated-installation checks still run before public uploads or release publication. Changes to native hooks, modules, markup, branding, registration, the engine pin, configuration, or native build scripts require a new build. Three existing, unprocessed Orbit CSS resources can be repackaged in a matching native build: each original archive entry must match its trusted baseline Git blob hash before any archive is changed, allowing only Windows checkout CRLF normalization. Every other archive entry and all engine/profile files are preserved. The resulting browser runs the same complete fresh and updated runtime checks before publication. An expired or unavailable prior artifact also causes a new build.

## Prototype interface updates

`scripts/package_update.py` packages only `omni.ja` and `browser/omni.ja` from a verified native build. Its manifest records the source commit, exact upstream pin, payload hashes, and hashes of the unchanged native executables and DLLs. The application executable, engine, and profile are omitted from the update. Both `application.ini` and `platform.ini` stay with the installed application; their per-build identifiers are not used as engine fingerprints. The rebuilt `uninstall/helper.exe` utility also stays untouched and is excluded from the engine fingerprint; it does not load the interface or render webpages.

The Windows PowerShell updater fetches the fixed repository’s `windows-prototype` prerelease assets. It validates the installed engine and staged files before replacing either archive, rejects unexpected ZIP paths, requires Orbit to be closed, and restores the previous archives on an installation failure. It saves the initial interface in `.orbit-update-backup`, records the installed UI commit, and adds `browser/.purgecaches`. Restarting with `-purgecaches` invalidates compiled interface caches while keeping the existing profile. An unchanged interface skips downloading the payload.

CI tests the Windows updater, applies the bundle to a copy of the actual native package with different existing archives, checks profile preservation, and runs the native browser smoke test again. A separate job with release-write permission publishes the rolling prerelease only after all Windows checks pass. The manifest is uploaded after its payload; any mismatched assets during publication fail hash validation. Pull requests never publish the update channel. This prototype channel handles interface changes on a compatible engine; a Gecko upgrade requires a full browser package.

## Runtime

`browser/components/orbit/Orbit.sys.mjs` is a privileged browser component loaded during Firefox’s delayed window startup. It manages the toolbar entry, keyboard shortcut, canvas lifecycle, and a narrow bridge to native browser operations. Firefox’s `AboutNewTab.newTabURL` routes native new-tab commands to the packaged canvas while preserving its initial-page address-bar behavior.

`browser/base/content/orbit/orbit.html`, `orbit.css`, and `orbit.js` form the spatial canvas. They are packaged as `chrome://browser/content/orbit/` resources. The canvas lives inside Firefox’s own chrome; it is not an extension page or a standalone website.

The canvas bridge manages real `gBrowser` tabs and uses the current native split-view support. Peek renders a real Gecko content browser. Browser navigation keeps Firefox’s process isolation, normal URL handling, and container context. Saved cards retain URLs for tabs that have been closed, so frames can be reopened.

Workspace data is stored through Firefox SessionStore custom window values. Tab identities use custom tab values. Private windows keep a separate in-memory workspace. Layout restoration follows session restoration, rather than a cloud account or browser localStorage.

Each native canvas tab receives an immutable bridge bound to its current system-principal document and native browser. Navigation, tab closure, BFCache/discard, and foreign browser ownership revoke privileged access. Toolbar overlays retain their separate exact-document guard. Shared workspace changes notify live canvases without echoing the author’s save.

`OrbitTheme.sys.mjs` installs scoped browser chrome styles. It follows Firefox’s effective theme identity, leaving custom theme colors intact. Native default chrome, radial menus, and the canvas use Orbit’s liquid/sculpted palette with reduced-motion and forced-color support. The branding overlay supplies Orbit’s SVG logo, vector wordmarks, and About styling.

The browser component controls the boundary between the canvas and website content. Website titles and URLs are untrusted text. Canvas actions accept website URLs and explicit native tab identifiers; they must not expose arbitrary evaluation or unrestricted privileged navigation.

`OrbitRadial.sys.mjs` owns a radial-menu controller for each browser window. Trusted pointer events arrive through `OrbitRadialChild` and `OrbitRadialParent` JSWindowActors; the parent validates that their current browsing context belongs to the selected native tab. Held tab wheels stay pointer-transparent so the original webpage receives button release and Firefox can construct the correct link, image, selection, or editing context, including cross-origin frames.

The page wheel snapshots Firefox's initialized `contentAreaContextMenu` and invokes its original commands. It retains the native context descriptor for those commands, suppresses the ordinary popup, and completes its cleanup when the wheel closes. The tab wheel reads native open tabs and tab groups, including internal pages and collapsed groups. `OrbitRadialView.sys.mjs` renders scoped SVG rings with child fans anchored to each actual parent sector, hit-tests only their painted angular bounds, paginates overflowing options recursively, and handles hover, keyboard input, animation, viewport bounds, and reduced motion. Website text is rendered as text, and content messages cannot supply privileged commands or menu definitions.

`scripts/smoke_radial.py` exercises physical right-button down/up gestures against the packaged native browser, checks real command effects and group expansion, and captures light and dark screenshots. CI repeats these checks after applying the interface update to an existing installation.

## What remains upstream

Gecko rendering, the native tab strip, extensions, downloads, settings, permissions, developer tools, and the operating-system integrations come from Firefox. This prototype concentrates changes in browser chrome and packaging. Their continued behavior needs platform regression testing as the fork grows.

Desktop platform support should share one runtime implementation. Windows, Linux, and macOS each need their own build, launch, package, and verification steps.
