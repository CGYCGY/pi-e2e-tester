All tests done and cleaned up. Here's the full report.

Results

I tested all three from WSL2 Debian (trixie), each launching bash -lc that writes a proof-marker file (capturing hostname/pwd) plus runs echo HELLO; sleep N. "Spawned?" = marker file actually written + live process / visible window (you confirmed two of them via the screenshots you sent).

┌─────┬───────────────────────────────────────────┬─────────┬─────────────────────────────────────────────────────────┬─────────────────────────┐
│  #  │                 Candidate                 │ Exit 0? │                Process actually spawned?                │         Verdict         │
├─────┼───────────────────────────────────────────┼─────────┼─────────────────────────────────────────────────────────┼─────────────────────────┤
│ 1   │ wt.exe -w 0 nt -p Debian wsl.exe …        │ ✅ yes  │ ❌ no — marker never written                            │ Unreliable / broken     │
├─────┼───────────────────────────────────────────┼─────────┼─────────────────────────────────────────────────────────┼─────────────────────────┤
│ 2   │ cmd.exe /c start "" wsl.exe …             │ ✅ yes  │ ✅ yes (visible wsl.exe console window, marker written) │ Works, with sharp edges │
├─────┼───────────────────────────────────────────┼─────────┼─────────────────────────────────────────────────────────┼─────────────────────────┤
│ 3   │ powershell.exe -c Start-Process wsl.exe … │ ✅ yes  │ ✅ yes (visible window, marker written, correct pwd)    │ ✅ Best / recommended   │
└─────┴───────────────────────────────────────────┴─────────┴─────────────────────────────────────────────────────────┴─────────────────────────┘

Why candidate 1 (wt.exe) fails

Exit code is always 0, so it looks fine, but nothing useful runs. Your first screenshot showed it: wt.exe split my one command into separate junk tabs ("echo HELLO", "sleep 30", "sleep 120") and threw error 0x80070002 — system cannot find the file specified. Two compounding reasons:
- wt.exe treats ; in its own command line as a tab/pane delimiter, so echo HELLO; sleep 30 becomes multiple commands.
- When invoked from a WSL shell, the inner '…' quoting is stripped by the launching WSL process before wt.exe sees it, so wt re-tokenizes the multi-word bash script on whitespace. Even a semicolon-free && variant failed (marker still missing). It's fundamentally fragile for passing an arbitrary command from inside WSL.

Why candidate 2 (cmd start) works but is finicky

- Must use an empty title: start "" wsl.exe …. Your second screenshot showed start "pi-window" wsl.exe … failing with "Windows cannot find 'pi-window'" — start consumed the quoted token as the program name. The "" placeholder is mandatory.
- Prints UNC paths are not supported. Defaulting to Windows directory. because cmd can't sit in a \\wsl.localhost\… cwd — so the shell starts in /mnt/c/Windows unless you set the dir explicitly.

Why candidate 3 (PowerShell) wins

No title gotcha, no UNC warning, launched a visible window, marker written with the correct working directory, live sleep 120 confirmed in ps.

The command to use

Recommended (PowerShell):
powershell.exe -NoProfile -Command "Start-Process wsl.exe -ArgumentList '-d Debian --cd /home/cgy -- bash -lic \"echo HELLO; sleep 30\"'"

Solid alternative (cmd) — note the mandatory empty \"\" title:
cmd.exe /c start "" wsl.exe -d Debian --cd /home/cgy -- bash -lic 'echo HELLO; sleep 30'

Setting the working directory

Use wsl.exe --cd <path> — it's launcher-independent and sidesteps the cmd UNC problem entirely. It accepts either a Linux path (--cd /home/cgy/project) or a Windows path, and --cd ~ works for home. This is more reliable than start /D or PowerShell -WorkingDirectory (which want Windows paths). Confirmed: candidate 3 reported pwd=/mnt/wsl/__data/project/private/pi-test correctly.

How to launch pi

Swap the payload for pi. Use an interactive login shell (-lic) so your PATH / nvm / shell init load and pi gets a proper TTY:

# Recommended
powershell.exe -NoProfile -Command "Start-Process wsl.exe -ArgumentList '-d Debian --cd /mnt/wsl/__data/project/private/pi-test -- bash -lic pi'"

If pi isn't on PATH via your rc files, call it by full path (e.g. bash -lic '~/.bun/bin/pi' or wherever it's installed). To keep the window open after pi exits (for inspecting output), append exec bash:
… -- bash -lic 'pi; exec bash'

Bottom line: use powershell.exe -c Start-Process wsl.exe … (candidate 3); fall back to cmd /c start "" wsl.exe … if you want to avoid PowerShell. Avoid wt.exe for command-passing from WSL — it silently exits 0 while mangling the command. Always set the dir with wsl --cd.
