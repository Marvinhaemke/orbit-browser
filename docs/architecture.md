# Native Firefox integration

## Source and build

`firefox-source.json` pins Mozilla’s `mozilla-firefox/firefox` Git repository to revision `3f73c528a1ae5784ea5e1ee2c5ad3762507395f2`. The first artifact build targets that same revision, rather than silently mixing an arbitrary engine with the UI source.

`overlay/` mirrors Firefox source paths. Preparation verifies Git blob hashes for the upstream files it needs to modify, installs the overlay, registers the new component, packages its UI assets into Firefox’s browser chrome, and applies Orbit’s prototype branding. An upstream upgrade is a deliberate change to the pin and hook expectations.

The Windows pipeline bootstraps the supported Mozilla toolchain, rebuilds the frontend, packages the browser, then launches that browser with a disposable profile for a native runtime smoke test. It must pass before the downloadable artifact is uploaded.

## Prototype interface updates

`scripts/package_update.py` packages only `omni.ja` and `browser/omni.ja` from a verified native build. Its manifest records the source commit, exact upstream pin, payload hashes, and hashes of the unchanged native executables and DLLs. The application executable, engine, and profile are omitted from the update. Both `application.ini` and `platform.ini` stay with the installed application; their per-build identifiers are not used as engine fingerprints.

The Windows PowerShell updater fetches the fixed repository’s `windows-prototype` prerelease assets. It validates the installed engine and staged files before replacing either archive, rejects unexpected ZIP paths, requires Orbit to be closed, and restores the previous archives on an installation failure. It saves the initial interface in `.orbit-update-backup`, records the installed UI commit, and adds `browser/.purgecaches`. Restarting with `-purgecaches` invalidates compiled interface caches while keeping the existing profile. An unchanged interface skips downloading the payload.

CI tests the Windows updater, applies the bundle to a copy of the actual native package with different existing archives, checks profile preservation, and runs the native browser smoke test again. A separate job with release-write permission publishes the rolling prerelease only after all Windows checks pass. The manifest is uploaded after its payload; any mismatched assets during publication fail hash validation. Pull requests never publish the update channel. This prototype channel handles interface changes on a compatible engine; a Gecko upgrade requires a full browser package.

## Runtime

`browser/components/orbit/Orbit.sys.mjs` is a privileged browser component loaded during Firefox’s delayed window startup. It manages the toolbar entry, keyboard shortcut, canvas lifecycle, and a narrow bridge to native browser operations.

`browser/base/content/orbit/orbit.html`, `orbit.css`, and `orbit.js` form the spatial canvas. They are packaged as `chrome://browser/content/orbit/` resources. The canvas lives inside Firefox’s own chrome; it is not an extension page or a standalone website.

The canvas bridge manages real `gBrowser` tabs and uses the current native split-view support. Peek renders a real Gecko content browser. Browser navigation keeps Firefox’s process isolation, normal URL handling, and container context. Saved cards retain URLs for tabs that have been closed, so frames can be reopened.

Workspace data is stored through Firefox SessionStore custom window values. Tab identities use custom tab values. Private windows keep a separate in-memory workspace. Layout restoration follows session restoration, rather than a cloud account or browser localStorage.

The browser component controls the boundary between the canvas and website content. Website titles and URLs are untrusted text. Canvas actions accept website URLs and explicit native tab identifiers; they must not expose arbitrary evaluation or unrestricted privileged navigation.

## What remains upstream

Gecko rendering, the native tab strip, extensions, downloads, settings, permissions, developer tools, and the operating-system integrations come from Firefox. This prototype concentrates changes in browser chrome and packaging. Their continued behavior needs platform regression testing as the fork grows.

Desktop platform support should share one runtime implementation. Windows, Linux, and macOS each need their own build, launch, package, and verification steps.
