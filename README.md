# Orbit Browser

Orbit is a Windows-first Firefox source fork exploring spatial browsing. Its canvas is compiled into Firefox’s browser interface. Websites render through Gecko, tabs are native Firefox tabs, and no browser extension is installed.

This repository contains a small source overlay and guarded build scripts rather than a duplicate of Firefox’s entire history. The scripts fetch a pinned Firefox revision, apply the Orbit changes, and produce a native browser package.

## Windows prototype

**[Download the tested Windows x64 prototype](https://github.com/Marvinhaemke/orbit-browser/actions/runs/37231460626/artifacts/11313827549)** · [Successful build and native test results](https://github.com/Marvinhaemke/orbit-browser/actions/runs/37231460626)

This build passed nine checks inside the packaged browser: real Gecko rendering, native startup and toolbar registration, canvas loading, tab import and opening, frame opening without duplicates, SessionStore persistence, live previews, and native split views. Windows artifacts are retained for 14 days; the workflow can build a fresh package afterward.

The [Windows prototype workflow](https://github.com/Marvinhaemke/orbit-browser/actions/workflows/windows-prototype.yml) runs on pushes to `main`, pull requests, and manual requests. A downloadable package is published as a workflow artifact **only after the built browser passes the native runtime smoke test**.

After a successful run, download its `Orbit-Windows-x64` artifact. Extract that download, then extract the included `Orbit-Windows-x64-*.zip` browser package and run `Launch-Orbit.cmd` inside the `Orbit` folder. The launcher uses a dedicated Orbit profile. The native executable is `orbit.exe`, using Mozilla’s compiled Gecko engine with Orbit’s rebuilt browser interface.

Use the **Orbit canvas** toolbar button or **Alt + Shift + O** to open the workspace. Firefox’s normal toolbar and tab strip remain available.

The source implements:

- A pan-and-zoom canvas populated from real browser tabs.
- Draggable tab cards and named, resizable frames that open their tabs together.
- Editable sticky notes, connections, freehand drawing, and undo.
- A radial context menu on the canvas.
- Website peeking and comparison through native Gecko browsers and Firefox split views.
- Session-backed workspace layouts, with private-window data kept in memory.
- Keyboard controls and reduced-motion support.

Native runtime verification and the workflow’s actual result determine which build is ready to use. Source checks alone do not establish that a Windows executable works.

## Build locally on Windows

Use a source directory without spaces, such as `C:/orbit-firefox`. Install the current [MozillaBuild](https://firefox-source-docs.mozilla.org/setup/windows_build.html) environment and run build commands from its shell. Firefox’s bootstrap command downloads the supported build tools.

From this repository:

```sh
python -m unittest discover -s tests -v
python scripts/prepare_source.py --source C:/orbit-firefox
python scripts/build.py --source C:/orbit-firefox
python scripts/package_windows.py --source C:/orbit-firefox --output artifacts
python -m pip install C:/orbit-firefox/testing/marionette/client
python scripts/smoke_test.py --binary artifacts/Orbit/orbit.exe --report test-results/smoke.json
```

`prepare_source.py` verifies the exact upstream revision and the original files before changing them. It refuses unexpected source changes. Repeating preparation on a matching checkout is supported.

Firefox artifact builds reuse Mozilla’s compiled engine while rebuilding the native JS, HTML, CSS, and browser packaging. That is appropriate for this interface prototype. Changes to Gecko or other compiled code require a full source build instead.

## Platform scope

The runtime code uses Firefox’s platform-neutral browser APIs. The first packaging and runtime verification target **Windows x64**. Linux and macOS source builds are planned; they are not verified distributions yet. Keep operating-system assumptions in build and packaging scripts, not the canvas implementation.

## Prototype boundaries

- The radial menu currently applies to the canvas. Ordinary webpages retain Firefox’s native context menus.
- Workspace persistence follows Firefox’s session restoration. Private workspaces are not written into session state.
- Removing a canvas card does not close its browser tab.
- Automatic Firefox application updates are disabled in the packaged prototype so an upstream update cannot replace Orbit’s modified interface. Update this prototype through a newly built Orbit package.
- The prototype uses upstream unofficial artwork. Installer creation, code signing, update infrastructure, and release builds are future work.

See [architecture](docs/architecture.md) for the integration points and [the source pin](firefox-source.json) for upstream provenance. New Orbit source is licensed under [MPL 2.0](LICENSE); Firefox retains its upstream and third-party licenses.
