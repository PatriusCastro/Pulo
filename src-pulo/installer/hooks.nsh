; Installer wording, included near the top of Tauri's NSIS template, before the pages.

; Icon on the right of the white page header.
!define MUI_HEADERIMAGE_RIGHT

!define MUI_WELCOMEPAGE_TITLE "Welcome to Pulo"
!define MUI_WELCOMEPAGE_TEXT "Pulo puts a Dynamic Island at the top of your screen: your music, timers and what your apps are up to, one hover away.$\r$\n$\r$\nIt installs for your account only, so it won't ask for admin rights.$\r$\n$\r$\nClick Next to continue."

!define MUI_FINISHPAGE_TITLE "Pulo is ready"
!define MUI_FINISHPAGE_TEXT "Look at the top of your screen. Hover the island to peek, click it to open, or press Ctrl+Alt+Space.$\r$\n$\r$\nPulo now starts with Windows. To change that, untick $\"Start Pulo with Windows$\" in Settings, from the Pulo icon in the system tray."
!define MUI_FINISHPAGE_RUN_TEXT "Start Pulo now"
; Pulo lives at the top of the screen, so a desktop icon is opt-in.
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

; Start with Windows on a fresh install. Same Run value the app's Settings toggle writes
; (lib.rs set_autostart), and the uninstaller already removes it. Auto-updates pass
; /UPDATE, so they leave the user's choice alone.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode <> 1
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  ${EndIf}
!macroend
