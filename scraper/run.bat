@echo off
cd /d %~dp0
node scraper.js >> logs\scraper.log 2>&1
