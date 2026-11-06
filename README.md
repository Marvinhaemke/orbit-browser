# Orbit Browser

Orbit is a Windows-first Firefox source fork exploring spatial browsing and new browser interactions. Its canvas and radial menus are compiled into Firefox’s browser interface. Websites render through Gecko, tabs are native Firefox tabs, and no browser extension is installed.

This repository contains a small source overlay and guarded build scripts rather than a duplicate of Firefox’s entire history. The scripts fetch a pinned Firefox revision, apply the Orbit changes, and produce a native browser package.

## Download for Windows

**[Download Orbit-Setup.exe](https://github.com/Marvinhaemke/orbit-browser/releases/download/windows-prototype/Orbit-Setup.exe)** (64-bit Windows 10 or 11), run it, and click through three short steps. Orbit installs for your Windows account only, so it does not need administrator rights. It adds **Orbit** and **Update Orbit** to the Start menu and, if you like, a desktop shortcut. Remove it from **Settings › Apps** like any other app; the uninstaller keeps your browsing data unless you choose to delete it.

This early build is not code-signed yet, so Windows SmartScreen may say it protected your PC. Choose **More info**, then **Run anyway**.

Prefer no installation? [Orbit-Windows-x64-portable.zip](https://github.com/Marvinhaemke/orbit-browser/releases/download/windows-prototype/Orbit-Windows-x64-portable.zip) is the same browser. Extract it to a writable folder and run `Launch-Orbit.cmd`. Both downloads, with SHA-256 checksums, are on the [Orbit for Windows release](https://github.com/Marvinhaemke/orbit-browser/releases/tag/windows-prototype).

### Links for a website

These addresses always serve the newest tested build, so a download page never needs editing:

- Installer: `https://github.com/Marvinhaemke/orbit-browser/releases/latest/download/Orbit-Setup.exe`
- Portable ZIP: `https://github.com/Marvinhaemke/orbit-browser/releases/latest/download/Orbit-Windows-x64-portable.zip`
- Checksums: the same addresses with `.sha256` appended

`installer/orbit-icon-256.png` is the Orbit app icon for a download page.

### What the installer does

- Installs to `%LOCALAPPDATA%\Programs\Orbit` (you can choose another empty folder). The profile, with bookmarks, history, settings, and canvas boards, lives in its `profile` folder.
- Registers that profile as Orbit's default, so a pinned taskbar button or a jump-list entry opens it too. If Orbit already has its own profiles on the computer, Setup leaves that list unchanged.
- Running a newer `Orbit-Setup.exe` updates in place and keeps the profile. Setup refuses to run while Orbit is open.
- Silent installs work for scripted setups: `Orbit-Setup.exe /S` (optionally `/D=C:\path\to\Orbit` as the last argument).

To move your data from a portable folder, close Orbit and copy the contents of the portable `profile` folder into the installed `profile` folder before you first start the installed Orbit.

### Build details

The [Windows prototype workflow](https://github.com/Marvinhaemke/orbit-browser/actions/workflows/windows-prototype.yml) runs on pushes to `main`, pull requests, and manual requests. Runtime verification uses physical mouse input to test the toolbar, radial page actions, held tab switching, grouped tabs, and nested overflow rings. It captures native screenshots and checks link opening, editing, clipboard actions, cross-origin iframe targets, real Gecko rendering, SessionStore persistence, previews, and native split views.

The installer is built from the same tested browser. CI installs it silently, compares every installed file with the tested package, checks the shortcuts and Apps registration, starts Orbit without arguments to confirm it adopts the installed profile, applies an interface update to the installed copy, reinstalls over it, runs the native smoke test on the installed browser, and uninstalls it. Only successful builds on `main` publish the release. Workflow runs also keep each build as the `Orbit-Windows-Installer` and `Orbit-Windows-x64` artifacts for 14 days.

The installed or portable browser's executable is `orbit.exe`, Mozilla's compiled Gecko engine with Orbit's rebuilt browser interface. Each launcher uses a dedicated Orbit profile, never your Firefox profile.

## Using Orbit

Every new tab and every new window opens the **Orbit canvas**; it is also the default home page, which you can change in Settings. Ctrl+T and the native plus button retain address-bar focus so you can immediately type a website. The **Orbit canvas** toolbar button or **Alt + Shift + O** also opens the workspace over an existing page. Multiple canvas tabs share the same window’s workspace.

The canvas fills the whole page. Its sidebar and top bar float over it, so the workspace runs edge to edge beneath them. The top bar greets you with the date and a live summary of your open tabs, cards, frames, and notes. Its **Search the web or enter an address** field hands whatever you type to Firefox's real address bar, so search engines, suggestions, and URL handling stay Firefox's own; this also works in focus mode, where the address bar is otherwise hidden. Beside it, shortcuts to your most visited sites open in the same tab (Ctrl+click or middle-click opens a background tab). Remove a shortcut with its **×**, or hide the row with **Hide**. Private windows never show shortcuts.

## Radial browser interaction

- **Quick right-click on a webpage:** release the button to open page actions. **Open in new tab** sits in the center and uses the clicked link or image when available; otherwise it opens the current page in a new tab.
- **Hold the right button:** the tab wheel appears on button down. Move onto a tab and release to switch to it. Releasing without choosing a tab opens page actions.
- **Hover a submenu:** a compact fan opens outside the item you hovered. Its options stay near their parent rather than filling the entire outer ring. Native tab groups and **More** work the same way, including further layers. Each ring contains at most eight options.
- **Escape:** move back one layer, then dismiss. Arrow keys and Enter also navigate the menu. Clicking outside dismisses it.
- **Keyboard letters:** Firefox's own context-menu access keys work in the wheel (for example **T** opens a link in a new tab), including commands paged behind **More**. While you use the keyboard, each circle shows its key. Typing a letter without an access key highlights the next matching command.

Every command has a descriptive icon. The hub's rim points toward the hovered command, and the caption below the wheel adds context: a tab's site, how many tabs a group holds, or how many options a submenu offers. Right-clicking the canvas opens a smaller wheel whose actions match what you clicked: a website card, a note, a frame, or empty space. Each action there also has a letter.

The page wheel uses Firefox’s actual context commands for links, images, selected text, editing, media, and extension actions. Its animations follow the operating system’s reduced-motion preference, and its colors adapt to light, dark, and high-contrast settings.

## Connected browsing

**Orbit commands** opens from its toolbar button or **Ctrl + Shift + Space** (**Command + Shift + Space** on macOS). Search open tabs and saved frames, then use the arrow keys and Enter to jump to a result. The same command bar opens the canvas and toggles focus mode. Escape dismisses it and returns focus to your previous control.

**Send to canvas** in a webpage's radial menu collects the page, a clicked link, or selected text. Cards keep the website's address and container; text becomes an editable note with its source address. Collecting a link does not create another browser tab. Captures join the current window's workspace, and private captures stay in memory.

**Focus mode** is the default: every new browser window opens with the page given room while browser controls become three independent islands. **Alt + Shift + F** toggles it in the current window. To start new windows with the full toolbar instead, open **Orbit commands** and choose **Always start with the full toolbar** (or set `browser.orbit.focus.default` to `false` in `about:config`). Pop-up windows always keep their native layout.

In focus mode, approach the **top middle** for the floating address bar; click it or press **Ctrl + L** (**Command + L** on macOS) to expand the real address bar and its suggestions. Move the pointer into the **top-left corner** and a quarter-circle tools menu grows out of it. The corner piece itself is **New tab** (the tab strip is hidden in focus mode; Ctrl+T also works). Around it are extensions, bookmarks, history, downloads, settings (including the browser menu), the canvas, Orbit commands, and **Exit focus**. Each key shown while you use the keyboard selects its item, and **Browser tools** in Orbit commands opens the menu without a mouse. Approach the **top right** for the rounded island containing the original window controls. Each island stays open while you use it and recedes after you leave. Focus mode adds no permanent on-screen buttons: **Escape** dismisses active controls before restoring the full interface, and **Alt + Shift + F** toggles it. This uses ordinary browser chrome and leaves Firefox's fullscreen mode available separately.

## Test interface changes without downloading the whole browser

Installed copies and current portable downloads already contain the updater. Close Orbit, then open **Update Orbit** from the Start menu (in a portable folder, double-click **Update-Orbit.cmd**). It downloads the latest tested interface package, applies it to the existing installation, and reopens the same profile. Tabs, bookmarks, notes, and canvas layouts stay in that profile. No Git checkout, GitHub sign-in, or build tools are needed.

The updater replaces the two packaged interface archives, verifies their hashes and the installed engine, keeps a backup, and clears Firefox’s compiled interface caches on restart. It refuses an incompatible engine or an update while Orbit is running. If Gecko changes, use a new full browser download instead.

Older portable folders without the current updater need [Orbit-Update-Setup.zip](https://github.com/Marvinhaemke/orbit-browser/releases/download/windows-prototype/Orbit-Update-Setup.zip) once: extract its two files beside `orbit.exe` and `Launch-Orbit.cmd`, replacing the existing copies.

The [update channel](https://github.com/Marvinhaemke/orbit-browser/releases/tag/windows-prototype) is published only after the native browser passes runtime verification, the Windows updater passes integrity and rollback tests, and the updated installation passes the same native runtime checks. Only successful builds on `main` publish updates.

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
python scripts/package_installer.py --package artifacts/Orbit --output artifacts/installer
```

`package_installer.py` needs [NSIS 3](https://nsis.sourceforge.io/) (`makensis`) and writes `Orbit-Setup.exe` with its checksum. The installer script is `installer/orbit.nsi`; `node installer/render-art.mjs` regenerates its icon and artwork from the SVG sources.

`prepare_source.py` verifies the exact upstream revision and the original files before changing them. It refuses unexpected source changes. Repeating preparation on a matching checkout is supported.

Firefox artifact builds reuse Mozilla’s compiled engine while rebuilding the native JS, HTML, CSS, and browser packaging. That is appropriate for this interface prototype. Changes to Gecko or other compiled code require a full source build instead.

## Platform scope

The runtime code uses Firefox’s platform-neutral browser APIs. The first packaging and runtime verification target **Windows x64**. Linux and macOS source builds are planned; they are not verified distributions yet. Keep operating-system assumptions in build and packaging scripts, not the canvas implementation.

## Prototype boundaries

- The native tab strip and browser toolbar keep Firefox’s underlying controls with Orbit’s default styling. Webpage context actions use the radial interface; operating-system menus remain native.
- Workspace persistence follows Firefox’s session restoration. Private workspaces are not written into session state.
- Removing a canvas card does not close its browser tab.
- Automatic Firefox application updates are disabled so an upstream update cannot replace Orbit’s modified interface. Orbit’s prototype updater delivers tested interface changes; engine upgrades need a full package.
- Orbit has its own canvas, toolbar, About, installer, and shortcut artwork. The artifact engine still carries upstream executable artwork, which Windows shows on the taskbar. Code signing, default-browser registration, and full engine updates are future work.

See [architecture](docs/architecture.md) for the integration points and [the source pin](firefox-source.json) for upstream provenance. New Orbit source is licensed under [MPL 2.0](LICENSE); Firefox retains its upstream and third-party licenses.
