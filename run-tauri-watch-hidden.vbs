Option Explicit

Dim shell, root, command
Set shell = CreateObject("WScript.Shell")
root = "C:\Users\Master\Desktop\tauri-account-manager"
shell.CurrentDirectory = root
command = "cmd.exe /d /c """ & root & "\run-tauri-watch.cmd"""

' Run the existing watchdog without creating a visible console window.
shell.Run command, 0, False
Set shell = Nothing
