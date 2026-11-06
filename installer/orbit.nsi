; SPDX-License-Identifier: MPL-2.0
; Orbit for Windows: a per-user installer that needs no administrator rights.
;
; Build it with scripts/package_installer.py, which checks the packaged
; browser and passes ORBIT_SOURCE, ORBIT_OUTPUT and the version defines.
;
; Layout of an installation (default %LOCALAPPDATA%\Programs\Orbit):
;   orbit.exe, xul.dll, ...   the packaged browser, replaced on every install
;   profile\                  the user's Orbit data, kept on update/reinstall
;   .orbit-install\           this uninstaller and the shortcut icon
; Update-Orbit.ps1 ignores .orbit-install when it fingerprints the engine.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
CRCCheck on

!ifndef ORBIT_SOURCE
  !error "Define ORBIT_SOURCE as the packaged Orbit folder (scripts/package_installer.py does this)."
!endif
!ifndef ORBIT_OUTPUT
  !define ORBIT_OUTPUT "Orbit-Setup.exe"
!endif
!ifndef ORBIT_VERSION
  !define ORBIT_VERSION "0.1.0"
!endif
!ifndef ORBIT_FILE_VERSION
  !define ORBIT_FILE_VERSION "0.1.0.0"
!endif

!define ORBIT_URL "https://github.com/Marvinhaemke/orbit-browser"
!define ORBIT_APP_KEY "Software\Orbit"
!define ORBIT_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Orbit"
!define ORBIT_STATE_DIR ".orbit-install"
!define ORBIT_UNINSTALLER "Uninstall Orbit.exe"
; application.ini has Vendor=Mozilla and Name=Orbit, so Gecko keeps Orbit's
; profile list here, separate from Firefox's.
!define ORBIT_PROFILE_ROOT "$APPDATA\Mozilla\Orbit"

Name "Orbit"
Caption "Orbit Setup"
UninstallCaption "Uninstall Orbit"
OutFile "${ORBIT_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Orbit"
InstallDirRegKey HKCU "${ORBIT_APP_KEY}" "InstallLocation"
BrandingText "Orbit ${ORBIT_VERSION}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "orbit.ico"
!define MUI_UNICON "orbit.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "wizard.bmp"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Welcome to Orbit"
!define MUI_WELCOMEPAGE_TEXT "Orbit is a spatial web browser built on the Gecko engine.$\r$\n$\r$\nSetup installs Orbit for your Windows account only, so it does not need administrator rights.$\r$\n$\r$\nYour bookmarks, history and canvas boards stay on this computer and are kept when you update or reinstall Orbit.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME

!define MUI_DIRECTORYPAGE_TEXT_TOP "Setup will install Orbit in the following folder. The default location works for most people."
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateInstallDirectory
!insertmacro MUI_PAGE_DIRECTORY

!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Orbit is ready"
!define MUI_FINISHPAGE_TEXT "Orbit is installed. You can start it any time from the Start menu.$\r$\n$\r$\nTo get the newest Orbit interface later, close Orbit and open Update Orbit from the Start menu."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Start Orbit now"
!define MUI_FINISHPAGE_RUN_FUNCTION StartOrbit
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Add an Orbit shortcut to the desktop"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION AddDesktopShortcut
!define MUI_FINISHPAGE_LINK "Orbit on GitHub"
!define MUI_FINISHPAGE_LINK_LOCATION "${ORBIT_URL}"
!insertmacro MUI_PAGE_FINISH

!define MUI_UNCONFIRMPAGE_TEXT_TOP "Orbit will be removed from the following folder. You can choose whether to keep your browsing data."
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${ORBIT_FILE_VERSION}"
VIFileVersion "${ORBIT_FILE_VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductName" "Orbit"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileDescription" "Orbit Setup"
VIAddVersionKey /LANG=${LANG_ENGLISH} "CompanyName" "Orbit"
VIAddVersionKey /LANG=${LANG_ENGLISH} "LegalCopyright" "Mozilla Public License 2.0"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileVersion" "${ORBIT_VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductVersion" "${ORBIT_VERSION}"

Var OrbitRoot
Var RemoveProfile

; ---------------------------------------------------------------------------
; Shared helpers

; Stops while any Orbit process from the folder on the stack is running.
; A running executable cannot be opened for writing, which also covers
; content processes and Orbit windows started without the shortcut.
!macro ORBIT_ENSURE_CLOSED PREFIX
Function ${PREFIX}EnsureOrbitClosed
  Exch $0
  Push $1
  retry:
  ${If} ${FileExists} "$0\orbit.exe"
    ClearErrors
    FileOpen $1 "$0\orbit.exe" a
    ${If} ${Errors}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Orbit is still running.$\r$\n$\r$\nClose all Orbit windows, then click Retry." /SD IDCANCEL IDRETRY retry
      Abort "Orbit is still running. Close it and run Setup again."
    ${EndIf}
    FileClose $1
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd
!macroend
!insertmacro ORBIT_ENSURE_CLOSED ""
!insertmacro ORBIT_ENSURE_CLOSED "un."

; Removes everything in the folder on the stack except the profile and the
; installer state. Only called for folders that hold an Orbit installation.
!macro ORBIT_REMOVE_PROGRAM_FILES PREFIX
Function ${PREFIX}RemoveProgramFiles
  Exch $0
  Push $1
  Push $2
  FindFirst $1 $2 "$0\*"
  ${DoWhile} $2 != ""
    ${If} $2 != "."
    ${AndIf} $2 != ".."
    ${AndIf} $2 != "profile"
    ${AndIf} $2 != "${ORBIT_STATE_DIR}"
      ${If} ${FileExists} "$0\$2\*"
        RMDir /r "$0\$2"
      ${Else}
        Delete "$0\$2"
      ${EndIf}
    ${EndIf}
    FindNext $1 $2
  ${Loop}
  FindClose $1
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend
!insertmacro ORBIT_REMOVE_PROGRAM_FILES ""
!insertmacro ORBIT_REMOVE_PROGRAM_FILES "un."

; ---------------------------------------------------------------------------
; Installer

Function .onInit
  ; One Setup at a time, so two copies cannot write the same folder.
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "OrbitSetupMutex") p .r0 ?e'
  Pop $1
  ${If} $1 = 183
    MessageBox MB_ICONEXCLAMATION "Orbit Setup is already running." /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

; Accept a new or empty folder, or an existing Orbit installation. Updates
; and uninstalling replace everything in the folder except the profile, so
; Orbit must never share a folder with other files. Sets $0 to "ok" or "used".
Function CheckInstallDirectory
  Push $1
  Push $2
  StrCpy $0 "ok"
  ${If} ${FileExists} "$INSTDIR\*"
  ${AndIfNot} ${FileExists} "$INSTDIR\application.ini"
    FindFirst $1 $2 "$INSTDIR\*"
    ${DoWhile} $2 != ""
      ${If} $2 != "."
      ${AndIf} $2 != ".."
        StrCpy $0 "used"
        ${Break}
      ${EndIf}
      FindNext $1 $2
    ${Loop}
    FindClose $1
  ${EndIf}
  Pop $2
  Pop $1
FunctionEnd

Function ValidateInstallDirectory
  Call CheckInstallDirectory
  ${If} $0 == "used"
    MessageBox MB_ICONEXCLAMATION "$INSTDIR already contains other files.$\r$\n$\r$\nChoose an empty folder or an existing Orbit installation."
    Abort
  ${EndIf}
FunctionEnd

; Writes text to an open file handle as UTF-8, which Gecko expects for paths
; in profiles.ini. NSIS's own FileWrite would use the ANSI code page.
Function WriteUtf8
  Exch $0 ; text
  Exch
  Exch $1 ; file handle
  Push $2
  Push $3
  Push $4
  System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0, w r0, i -1, p 0, i 0, p 0, p 0) i .r2'
  ${If} $2 > 1
    System::Alloc $2
    Pop $3
    System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0, w r0, i -1, p r3, i r2, p 0, p 0)'
    IntOp $2 $2 - 1
    System::Call 'kernel32::WriteFile(p r1, p r3, i r2, *i .r4, p 0) i .r2'
    System::Free $3
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Makes Orbit open the installed profile even when Windows starts orbit.exe
; without arguments, as a pinned taskbar button or a jump list task does.
; Gecko adopts the default profile of an unclaimed profiles.ini on the first
; such start, once the profile has a compatibility.ini. A profile list that
; already names profiles belongs to earlier Orbit starts and is never changed.
!define ORBIT_PROFILE_ENTRY "[Profile0]$\r$\nName=Orbit$\r$\nIsRelative=0$\r$\nPath=$INSTDIR\profile$\r$\nDefault=1$\r$\n"
Function RegisterProfile
  ${IfNot} ${FileExists} "$INSTDIR\profile\compatibility.ini"
    ; No LastVersion: Gecko treats the profile as new and rewrites the file.
    FileOpen $0 "$INSTDIR\profile\compatibility.ini" w
    FileWrite $0 "[Compatibility]$\r$\n"
    FileClose $0
  ${EndIf}
  ${If} ${FileExists} "${ORBIT_PROFILE_ROOT}\profiles.ini"
    ReadINIStr $1 "${ORBIT_PROFILE_ROOT}\profiles.ini" "Profile0" "Path"
    ${If} $1 != ""
      DetailPrint "Keeping the existing Orbit profile list."
      Return
    ${EndIf}
    ; Gecko's background tasks can create the list before any profile exists.
    ; Keep their entries and add the installed profile after them.
    ClearErrors
    FileOpen $0 "${ORBIT_PROFILE_ROOT}\profiles.ini" a
    ${If} ${Errors}
      DetailPrint "Could not update the Orbit profile list."
      Return
    ${EndIf}
    ; FileOpen's append mode starts at the beginning of the file.
    FileSeek $0 0 END
    Push $0
    Push "$\r$\n${ORBIT_PROFILE_ENTRY}"
  ${Else}
    CreateDirectory "${ORBIT_PROFILE_ROOT}"
    ClearErrors
    FileOpen $0 "${ORBIT_PROFILE_ROOT}\profiles.ini" w
    ${If} ${Errors}
      DetailPrint "Could not write the Orbit profile list."
      Return
    ${EndIf}
    Push $0
    Push "[General]$\r$\nStartWithLastProfile=1$\r$\nVersion=2$\r$\n$\r$\n${ORBIT_PROFILE_ENTRY}"
  ${EndIf}
  Call WriteUtf8
  FileClose $0
FunctionEnd

Section "Orbit" SecOrbit
  SectionIn RO
  SetShellVarContext current
  ; Silent installs skip the directory page, so check the folder here too.
  Call CheckInstallDirectory
  ${If} $0 == "used"
    Abort "$INSTDIR already contains other files. Choose an empty folder or an existing Orbit installation."
  ${EndIf}
  Push $INSTDIR
  Call EnsureOrbitClosed
  ${If} ${FileExists} "$INSTDIR\application.ini"
    DetailPrint "Replacing the previous Orbit program files..."
    Push $INSTDIR
    Call RemoveProgramFiles
  ${EndIf}

  SetOutPath "$INSTDIR"
  ; START-HERE.txt explains the portable ZIP; the Start menu replaces it here.
  File /r /x "START-HERE.txt" "${ORBIT_SOURCE}\*"
  ; New interface archives can keep the engine's build ID, so tell Gecko to
  ; drop its compiled interface caches on the next start, as Update-Orbit does.
  FileOpen $0 "$INSTDIR\browser\.purgecaches" w
  FileClose $0
  CreateDirectory "$INSTDIR\profile"
  Call RegisterProfile

  SetOutPath "$INSTDIR\${ORBIT_STATE_DIR}"
  File "orbit.ico"
  WriteUninstaller "$INSTDIR\${ORBIT_STATE_DIR}\${ORBIT_UNINSTALLER}"
  SetFileAttributes "$INSTDIR\${ORBIT_STATE_DIR}" HIDDEN

  ; Shortcuts start in the installation folder and name the profile, so they
  ; open the installed profile even beside other Orbit copies.
  SetOutPath "$INSTDIR"
  CreateShortcut "$SMPROGRAMS\Orbit.lnk" "$INSTDIR\orbit.exe" '-profile "$INSTDIR\profile"' "$INSTDIR\${ORBIT_STATE_DIR}\orbit.ico" 0 SW_SHOWNORMAL "" "Browse the web with Orbit"
  CreateShortcut "$SMPROGRAMS\Update Orbit.lnk" "$INSTDIR\Update-Orbit.cmd" "" "$INSTDIR\${ORBIT_STATE_DIR}\orbit.ico" 0 SW_SHOWNORMAL "" "Install the newest tested Orbit interface"
  ${If} ${FileExists} "$DESKTOP\Orbit.lnk"
    Call AddDesktopShortcut
  ${EndIf}

  WriteRegStr HKCU "${ORBIT_APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${ORBIT_APP_KEY}" "Version" "${ORBIT_VERSION}"
  WriteRegStr HKCU "${ORBIT_UNINSTALL_KEY}" "DisplayName" "Orbit"
  WriteRegStr HKCU "${ORBIT_UNINSTALL_KEY}" "DisplayVersion" "${ORBIT_VERSION}"
  WriteRegStr HKCU "${ORBIT_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${ORBIT_STATE_DIR}\orbit.ico"
  WriteRegStr HKCU "${ORBIT_UNINSTALL_KEY}" "Publisher" "Orbit"
  WriteRegStr HKCU "${ORBIT_UNINSTALL_KEY}" "URLInfoAbout" "${ORBIT_URL}"
  WriteRegStr HKCU "${ORBIT_UNINSTALL_KEY}" "HelpLink" "${ORBIT_URL}"
  WriteRegStr HKCU "${ORBIT_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${ORBIT_UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\${ORBIT_STATE_DIR}\${ORBIT_UNINSTALLER}"'
  WriteRegStr HKCU "${ORBIT_UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${ORBIT_STATE_DIR}\${ORBIT_UNINSTALLER}" /S'
  WriteRegDWORD HKCU "${ORBIT_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${ORBIT_UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${ORBIT_UNINSTALL_KEY}" "EstimatedSize" "$0"
SectionEnd

Function StartOrbit
  Exec '"$INSTDIR\orbit.exe" -profile "$INSTDIR\profile"'
FunctionEnd

Function AddDesktopShortcut
  SetOutPath "$INSTDIR"
  CreateShortcut "$DESKTOP\Orbit.lnk" "$INSTDIR\orbit.exe" '-profile "$INSTDIR\profile"' "$INSTDIR\${ORBIT_STATE_DIR}\orbit.ico" 0 SW_SHOWNORMAL "" "Browse the web with Orbit"
FunctionEnd

; ---------------------------------------------------------------------------
; Uninstaller (runs from <installation>\.orbit-install)

Function un.onInit
  ${GetFileName} "$INSTDIR" $0
  ${GetParent} "$INSTDIR" $OrbitRoot
  ${If} $0 != "${ORBIT_STATE_DIR}"
  ${OrIfNot} ${FileExists} "$OrbitRoot\application.ini"
    MessageBox MB_ICONSTOP "This uninstaller is not inside an Orbit installation." /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Push $OrbitRoot
  Call un.EnsureOrbitClosed

  StrCpy $RemoveProfile "0"
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Orbit browsing data?$\r$\n$\r$\nThis permanently removes bookmarks, history, saved passwords, settings and canvas boards. Choose No to keep them for a later reinstall." /SD IDNO IDNO keep_profile
    StrCpy $RemoveProfile "1"
  keep_profile:

  DetailPrint "Removing Orbit program files..."
  Push $OrbitRoot
  Call un.RemoveProgramFiles
  ${If} $RemoveProfile == "1"
    RMDir /r "$OrbitRoot\profile"
  ${EndIf}

  Delete "$SMPROGRAMS\Orbit.lnk"
  Delete "$SMPROGRAMS\Update Orbit.lnk"
  Delete "$DESKTOP\Orbit.lnk"
  DeleteRegKey HKCU "${ORBIT_UNINSTALL_KEY}"
  DeleteRegKey HKCU "${ORBIT_APP_KEY}"

  Delete "$INSTDIR\orbit.ico"
  Delete "$INSTDIR\${ORBIT_UNINSTALLER}"
  RMDir "$INSTDIR"
  ; Removed only when empty, so a kept profile stays where Setup finds it.
  RMDir "$OrbitRoot"
SectionEnd
