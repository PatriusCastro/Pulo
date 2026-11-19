; Installer wording, included near the top of Tauri's NSIS template, before the pages.

; Icon on the right of the white page header.
!define MUI_HEADERIMAGE_RIGHT

!define MUI_WELCOMEPAGE_TITLE "Welcome to Pulo"
!define MUI_WELCOMEPAGE_TEXT "Pulo puts a Dynamic Island at the top of your screen: your music, timers and what your apps are up to, one hover away.$\r$\n$\r$\nIt installs for your account only, so it won't ask for admin rights.$\r$\n$\r$\nClick Next to continue."

!define MUI_FINISHPAGE_TITLE "Pulo is ready"
!define MUI_FINISHPAGE_TEXT "Look at the top of your screen. Hover the island to peek, click it to open, or press Ctrl+Alt+Space.$\r$\n$\r$\nSettings and updates live in the Pulo icon in the system tray."
!define MUI_FINISHPAGE_RUN_TEXT "Start Pulo now"
; Pulo lives at the top of the screen, so a desktop icon is opt-in.
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
