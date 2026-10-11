@echo off
REM launch_chrome.bat — Opens Chrome with YOUR real profile + remote debugging port.
REM This gives the agent access to your existing LinkedIn, Gmail, X logins.
REM
REM IMPORTANT: Close Chrome completely before running this, then use this
REM            as your normal Chrome from now on.

"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="C:\Users\ABC\AppData\Local\Google\Chrome\User Data" ^
  --profile-directory="Default" ^
  --no-first-run ^
  --no-default-browser-check
