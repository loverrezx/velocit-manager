!macro NSIS_HOOK_POSTINSTALL
  ; สร้าง Desktop Shortcut หลังติดตั้ง โดยใช้ไอคอน Velocit จาก executable หลัก
  CreateShortCut "$DESKTOP\Velocit Manager.lnk" "$INSTDIR\tauri-account-manager.exe" "" "$INSTDIR\tauri-account-manager.exe" 0 SW_SHOWNORMAL "" "เปิด Velocit Manager"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; ลบ Desktop Shortcut ที่สร้างโดยตัวติดตั้ง
  Delete "$DESKTOP\Velocit Manager.lnk"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\Velocit Manager.lnk"
!macroend

!macro NSIS_HOOK_PREINSTALL
!macroend
