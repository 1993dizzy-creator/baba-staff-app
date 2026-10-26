@echo off
rem Read-only BABA Git status. See docs/agents/baba-status.md.
node "%~dp0scripts\agent\baba-status.mjs" %*
exit /b %ERRORLEVEL%
