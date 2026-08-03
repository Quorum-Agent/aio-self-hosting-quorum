;------------------------------------------------------------------------------
; Quorum NSIS Installer — Windows Setup
;
; Builds a professional Windows installer for Quorum.exe.
; Supports: silent install, code signing, start menu shortcuts,
;           registry integration, clean uninstall, auto-update channel.
;
; Build command:
;   makensis /DVERSION=0.1.0 /DBUILD_DIR=..\..\dist installer\nsis\quorum.nsi
;
; Signing (post-build):
;   signtool sign /fd SHA256 /f cert.pfx /p <pass> /tr http://timestamp.digicert.com Quorum-Setup.exe
;------------------------------------------------------------------------------

;------------------------------------------------------------------------------
; Metadata
;------------------------------------------------------------------------------
!define PRODUCT_NAME "Quorum"
!define PRODUCT_PUBLISHER "Quorum"
!define PRODUCT_WEB_SITE "https://github.com/quorum/Quorum"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\${PRODUCT_NAME}.exe"
!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!define PRODUCT_UNINST_ROOT_KEY "HKLM"
!define PRODUCT_STARTMENU_REGVAL "StartMenuFolder"

; Allow overrides from command line
!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef BUILD_DIR
  !define BUILD_DIR "..\..\dist"
!endif

;------------------------------------------------------------------------------
; Compression & UI
;------------------------------------------------------------------------------
SetCompressor /SOLID lzma
SetCompressorDictSize 64

; Modern UI 2
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

;------------------------------------------------------------------------------
; Installer attributes
;------------------------------------------------------------------------------
Name "${PRODUCT_NAME} ${VERSION}"
OutFile "${BUILD_DIR}\Quorum-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"
InstallDirRegKey HKLM "${PRODUCT_DIR_REGKEY}" ""
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show
BrandingText "${PRODUCT_NAME} ${VERSION}"

;------------------------------------------------------------------------------
; Interface settings
;------------------------------------------------------------------------------
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${NSISDIR}\Contrib\Graphics\Wizard\modern-wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${NSISDIR}\Contrib\Graphics\Wizard\modern-wizard.bmp"

;------------------------------------------------------------------------------
; Pages
;------------------------------------------------------------------------------
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_STARTMENU Application $PRODUCT_STARTMENU_REGVAL
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

;------------------------------------------------------------------------------
; Version info (embedded in installer EXE)
;------------------------------------------------------------------------------
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2025 ${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

;------------------------------------------------------------------------------
; AUTO-UPDATE CHANNEL CONFIG
; Customize this section to point to your update server.
;------------------------------------------------------------------------------
!define UPDATE_CHECK_URL "https://releases.quorum.example.com/latest.yml"
!define UPDATE_FEED_URL  "https://releases.quorum.example.com/"

;------------------------------------------------------------------------------
; Section: Main Installation
;------------------------------------------------------------------------------
Section "Quorum (required)" SecQuorum
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; --- Core executable ---
  File "${BUILD_DIR}\Quorum.exe"

  ; --- Runtime directories (created at install time) ---
  CreateDirectory "$INSTDIR\runtime"

  ; --- Write registry keys ---
  WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "" "$INSTDIR\Quorum.exe"
  WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "Path" "$INSTDIR"

  ; --- Uninstall information ---
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "DisplayName" "${PRODUCT_NAME} ${VERSION}"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "DisplayIcon" "$INSTDIR\Quorum.exe,0"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "QuietUninstallString" "$INSTDIR\uninstall.exe /S"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKLM "${PRODUCT_UNINST_KEY}" "EstimatedSize" 200000

  ; --- Auto-update channel (read by Hermes updater) ---
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "UpdateURL" "${UPDATE_CHECK_URL}"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "UpdateFeedURL" "${UPDATE_FEED_URL}"
  WriteRegStr HKLM "${PRODUCT_UNINST_KEY}" "UpdateChannel" "stable"

  ; --- Write uninstaller ---
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; --- Start menu shortcuts ---
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    CreateDirectory "$SMPROGRAMS\$Application"
    CreateShortCut "$SMPROGRAMS\$Application\Quorum.lnk" "$INSTDIR\Quorum.exe"
    CreateShortCut "$SMPROGRAMS\$Application\Uninstall Quorum.lnk" "$INSTDIR\uninstall.exe"
  !insertmacro MUI_STARTMENU_WRITE_END

  ; --- Send to (add to PATH for current user convenience) ---
  ; We add the install directory to the user's PATH for CLI convenience
  EnVar::SetHKCU
  EnVar::AddValue "PATH" "$INSTDIR"
  Pop $0
  ${If} $0 != 0
    ; Non-fatal: PATH may already have it or EnVar plugin may be absent
  ${EndIf}
SectionEnd

;------------------------------------------------------------------------------
; Section: Desktop Shortcut (optional)
;------------------------------------------------------------------------------
Section "Desktop Shortcut" SecDesktop
  CreateShortCut "$DESKTOP\Quorum.lnk" "$INSTDIR\Quorum.exe"
SectionEnd

;------------------------------------------------------------------------------
; Uninstaller Section
;------------------------------------------------------------------------------
Section "Uninstall"
  ; --- Remove PATH entry ---
  EnVar::SetHKCU
  EnVar::DeleteValue "PATH" "$INSTDIR"
  Pop $0

  ; --- Remove start menu entries ---
  !insertmacro MUI_STARTMENU_GETFOLDER Application $Application
  Delete "$SMPROGRAMS\$Application\Quorum.lnk"
  Delete "$SMPROGRAMS\$Application\Uninstall Quorum.lnk"
  RMDir "$SMPROGRAMS\$Application"

  ; --- Remove desktop shortcut ---
  Delete "$DESKTOP\Quorum.lnk"

  ; --- Remove files ---
  Delete "$INSTDIR\Quorum.exe"
  Delete "$INSTDIR\uninstall.exe"

  ; --- Remove runtime directory ---
  RMDir /r "$INSTDIR\runtime"

  ; --- Remove install directory if empty ---
  RMDir "$INSTDIR"

  ; --- Remove registry keys ---
  DeleteRegKey HKLM "${PRODUCT_UNINST_KEY}"
  DeleteRegKey HKLM "${PRODUCT_DIR_REGKEY}"

  ; --- Remove per-user runtime data (clean uninstall) ---
  ; F5-UR-001: Clean up per-user data while in 'current' context before
  ;   switching to 'all' to avoid misinterpreting $LOCALAPPDATA.
  SetShellVarContext current
  RMDir /r "$LOCALAPPDATA\Quorum"
  RMDir /r "$APPDATA\Quorum"
  ; Also remove stray files in case RMDir /r missed something
  Delete "$LOCALAPPDATA\Quorum\*.*"
  RMDir "$LOCALAPPDATA\Quorum"
  SetShellVarContext all
SectionEnd

;------------------------------------------------------------------------------
; Silent install support
;------------------------------------------------------------------------------
; When run with /S, skip all pages and use defaults
; /D=<path> overrides InstallDir

;------------------------------------------------------------------------------
; Section descriptions
;------------------------------------------------------------------------------
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecQuorum} "Core Quorum executable and runtime files."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Create a shortcut on the desktop."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

;------------------------------------------------------------------------------
; Callbacks
;------------------------------------------------------------------------------
Function .onInit
  ; Require 64-bit Windows
  ${If} ${RunningX64}
    SetRegView 64
  ${Else}
    MessageBox MB_OK|MB_ICONSTOP "Quorum requires 64-bit Windows."
    Abort
  ${EndIf}

  ; Check for previous installation
  ReadRegStr $0 HKLM "${PRODUCT_UNINST_KEY}" "UninstallString"
  ${If} $0 != ""
    ; Offer upgrade
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Quorum ${VERSION} is already installed.$\r$\nDo you want to upgrade?" \
      IDYES upgrade IDNO abort_install
    abort_install:
      Abort
    upgrade:
      ; Uninstall silently first, then proceed
      ExecWait '"$0" /S _?=$INSTDIR'
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  ; Optional: prompt to launch after install
  ; MessageBox MB_YESNO|MB_ICONQUESTION \
  ;   "Quorum has been installed successfully.$\r$\nLaunch now?" \
  ;   IDNO no_launch
  ;   Exec '"$INSTDIR\Quorum.exe"'
  ; no_launch:
FunctionEnd
