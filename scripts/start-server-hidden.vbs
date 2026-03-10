Set shell = CreateObject("WScript.Shell")
repoRoot = "c:\Users\Joey\Documents\Code\TogetherVideo"
command = "cmd.exe /c cd /d """ & repoRoot & """ && node server.js >> server-hidden.log 2>&1"
shell.Run command, 0, False
