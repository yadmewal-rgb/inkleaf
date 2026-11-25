@echo off
rem Run after every push: waits until the website and the Cloudflare server both run the new version.
cd /d "%~dp0"
node after-publish.mjs
