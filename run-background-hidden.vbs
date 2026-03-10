Set shell = CreateObject("WScript.Shell")
projectRoot = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = projectRoot
command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ & projectRoot & "\start-background.ps1"""
shell.Run command, 0, False
