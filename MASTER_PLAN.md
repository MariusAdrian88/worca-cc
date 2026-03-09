# Pipeline Stage Editor — REST API for Settings

## Goal
Add missing /api/settings REST endpoints so the Settings UI can load and save pipeline configuration.

## Status: Approved

## Tasks

1. Update `settings-reader.js` — add `readFullSettings()` and `writeSettings()`, include `stages` and `governance` in `readSettings()`
2. Add `/api/settings` GET and POST Express routes to `app.js`
3. Update `settings-reader.test.js` for new exports
4. Verify end-to-end: tests pass, UI loads/saves settings
