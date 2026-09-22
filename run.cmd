@echo off
rem Double-click to set up and open Autopane. Passes any arguments through to run.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
