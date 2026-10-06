# Orbit Browser

Orbit is a Windows-first Firefox source fork exploring spatial browsing and new browser interactions. Its canvas and radial menus are compiled into Firefox’s browser interface. Websites render through Gecko, tabs are native Firefox tabs, and no browser extension is installed.

This repository contains a small source overlay and guarded build scripts rather than a duplicate of Firefox’s entire history. The scripts fetch a pinned Firefox revision, apply the Orbit changes, and produce a native browser package.

## Windows prototype

Download `Orbit-Windows-x64` from the latest successful [Windows build](https://github.com/Marvinhaemke/orbit-browser/actions/workflows/windows-prototype.yml).

Runtime verification uses physical mouse input to test the toolbar, radial page actions, held tab switching, grouped tabs, and nested overflow rings. It captures native screenshots and checks link opening, editing, clipboard actions, cross-origin iframe targets, real Gecko rendering, SessionStore persistence, previews, and native split views. Windows artifacts are retained for 14 days; the workflow can build a fresh package afterward.

The [Windows prototype workflow](https://github.com/Marvinhaemke/orbit-browser/actions/workflows/windows-prototype.yml) runs on pushes to `main`, pull requests, and manual requests. A downloadable package is published as a workflow artifact **only after the built browser passes the native runtime smoke test**.

After a successful run, download its `Orbit-Windows-x64` artifact and extract it once to a writable folder. Run `Launch-Orbit.cmd` beside `orbit.exe` and `START-HERE.txt`. Windows may show the launcher as **Launch-Orbit** when file extensions are hidden. The launcher uses a dedicated Orbit profile. The native executable is `orbit.exe`, using Mozilla’s compiled Gecko engine with Orbit’s rebuilt browser interface.

Every new tab opens the **Orbit canvas**. Ctrl+T and the native plus button retain address-bar focus so you can immediately type a website. The **Orbit canvas** toolbar button or **Alt + Shift + O** also opens the workspace over an existing page. Multiple canvas tabs share the same window’s workspace.

## Radial browser interaction

- **Quick right-click on a webpage:** release the button to open page actions. **Open in new tab** sits in the center and uses the clicked link or image when available; otherwise it opens the current page in a new tab.
- **Hold the right button:** the tab wheel appears on button down. Move onto a tab and release to switch to it. Releasing without choosing a tab opens page actions.
- **Hover a submenu:** a compact fan opens outside the item you hovered. Its options stay near their parent rather than filling the entire outer ring. Native tab groups and **More** work the same way, including further layers. Each ring contains at most eight options.
- **Escape:** move back one layer, then dismiss. Arrow keys and Enter also navigate the menu. Clicking outside dismisses it.

The page wheel uses Firefox’s actual context commands for links, images, selected text, editing, media, and extension actions. Its animations follow the operating system’s reduced-motion preference, and its colors adapt to light, dark, and high-contrast settings.

## Connected browsing

**Orbit commands** opens from its toolbar button or **Ctrl + Shift + Space** (**Command + Shift + Space** on macOS). Search open tabs and saved frames, then use the arrow keys and Enter to jump to a result. The same command bar opens the canvas and toggles focus mode. Escape dismisses it and returns focus to your previous control.

**Send to canvas** in a webpage's radial menu collects the page, a clicked link, or selected text. Cards keep the website's address and container; text becomes an editable note with its source address. Collecting a link does not create another browser tab. Captures join the current window's workspace, and private captures stay in memory.

**Focus mode** (**Alt + Shift + F**) gives the page room while browser controls become three independent islands. Approach the **top middle** for the floating address bar; click it or press **Ctrl + L** (**Command + L** on macOS) to expand the real address bar and its suggestions. Approach the **top left** for the tools radial menu, including native extension actions and browser settings. Approach the **top right** for the rounded island containing the original window controls. Each island stays open while you use it and recedes after you leave. The visible **Address bar** and **Exit focus** buttons also provide direct access. **Escape** dismisses active controls before restoring the full interface. This uses ordinary browser chrome and leaves Firefox's fullscreen mode available separately.

## Test interface changes without downloading the whole browser

For an existing Orbit installation, download [Orbit-Update-Setup.zip](https://github.com/Marvinhaemke/orbit-browser/releases/download/windows-prototype/Orbit-Update-Setup.zip) once and extract its two files beside `orbit.exe` and `Launch-Orbit.cmd`. New full browser packages already include these files.

For the liquid-interface release, refresh these two updater files even if you installed an earlier setup ZIP. Replace the existing copies; subsequent interface changes can use **Update-Orbit.cmd** directly.

Close Orbit, then double-click **Update-Orbit.cmd**. It downloads the latest tested interface package, applies it to the existing installation, and reopens the same portable profile. Tabs, bookmarks, notes, and canvas layouts stay in that profile. No Git checkout, GitHub sign-in, or build tools are needed.

The updater replaces the two packaged interface archives, verifies their hashes and the installed engine, keeps a backup, and clears Firefox’s compiled interface caches on restart. It refuses an incompatible engine or an update while Orbit is running. If Gecko changes, use a new full browser download instead.

The [Windows prototype update channel](https://github.com/Marvinhaemke/orbit-browser/releases/tag/windows-prototype) is published only after the native browser passes runtime verification, the Windows updater passes integrity and rollback tests, and the updated installation passes the same native runtime checks. Only successful builds on `main` publish updates.

Orbit’s default appearance combines moonstone and mineral-ink surfaces, lagoon cyan accents, an orbital O logo, and sculpted controls. The toolbar, tabs, address bar, canvas, and radial menus share this identity. Fluid transitions respect reduced motion, and explicitly selected Firefox themes keep their colors.

The source implements:

- A pan-and-zoom canvas populated from real browser tabs.
- Draggable tab cards and named, resizable frames that open their tabs together.
- Editable sticky notes, connections, freehand drawing, and undo.
- Radial webpage actions and a held right-button tab switcher, with nested groups and overflow.
- A radial context menu on the canvas.
- A searchable native command bar for open tabs, saved frames, and browser actions.
- Page, link, and selected-text capture into the canvas from the webpage radial menu.
- Reversible focus mode with independent floating address, tools, and window controls.
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
python scripts/smoke_radial.py --binary artifacts/Orbit/orbit.exe --report test-results/radial/smoke.json
python scripts/smoke_ux.py --binary artifacts/Orbit/orbit.exe --report test-results/ux/smoke.json
```

`prepare_source.py` verifies the exact upstream revision and the original files before changing them. It refuses unexpected source changes. Repeating preparation on a matching checkout is supported.

Firefox artifact builds reuse Mozilla’s compiled engine while rebuilding the native JS, HTML, CSS, and browser packaging. That is appropriate for this interface prototype. Changes to Gecko or other compiled code require a full source build instead.

## Platform scope

The runtime code uses Firefox’s platform-neutral browser APIs. The first packaging and runtime verification target **Windows x64**. Linux and macOS source builds are planned; they are not verified distributions yet. Keep operating-system assumptions in build and packaging scripts, not the canvas implementation.

## Prototype boundaries

- The native tab strip and browser toolbar keep Firefox’s underlying controls with Orbit’s default styling. Webpage context actions use the radial interface; operating-system menus remain native.
- Workspace persistence follows Firefox’s session restoration. Private workspaces are not written into session state.
- Removing a canvas card does not close its browser tab.
- Automatic Firefox application updates are disabled so an upstream update cannot replace Orbit’s modified interface. Orbit’s prototype updater delivers tested interface changes; engine upgrades need a full package.
- Orbit has its own canvas, toolbar, and About artwork. The artifact engine still carries upstream executable/taskbar artwork. Installer creation, code signing, full engine updates, and release builds are future work.

See [architecture](docs/architecture.md) for the integration points and [the source pin](firefox-source.json) for upstream provenance. New Orbit source is licensed under [MPL 2.0](LICENSE); Firefox retains its upstream and third-party licenses.
