; NSIS installer hooks for Prism
;
; NSIS_HOOK_PREUNINSTALL: runs before the uninstaller removes files,
; registry keys, and shortcuts. We use it to clean up all Prism user
; data directories so uninstalling truly removes everything.
;
; NSIS_HOOK_PREINSTALL / NSIS_HOOK_POSTINSTALL: reserved for future use.
; NSIS_HOOK_POSTUNINSTALL: reserved for future use.

!macro NSIS_HOOK_PREUNINSTALL
  ; ── Prism app-data directory (SQLite database, Tauri-managed files) ──
  ; On Windows this resolves to %APPDATA%\com.prism.app
  ; $APPDATA is already set by NSIS to the current user's roaming profile
  DetailPrint "Removing Prism app data..."
  RMDir /r "$APPDATA\com.prism.app"

  ; ── Prism user-data directory (settings, logs, models, venv) ──
  ; ~/.prism on all platforms. On Windows NSIS, $PROFILE points to the
  ; user's home folder (e.g. C:\Users\Shiver).
  DetailPrint "Removing Prism user data..."
  RMDir /r "$PROFILE\.prism"
!macroend