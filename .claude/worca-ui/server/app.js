// server/app.js
import express from 'express';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { validateSettingsPayload } from './settings-validator.js';

export function createApp(options = {}) {
  const app = express();
  const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
  const { settingsPath } = options;

  app.use(express.json());

  // GET /api/settings
  app.get('/api/settings', (_req, res) => {
    if (!settingsPath) return res.status(501).json({ error: { code: 'not_configured', message: 'settingsPath not configured' } });
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      res.json({ worca: raw.worca || {}, permissions: raw.permissions || {} });
    } catch (err) {
      res.status(500).json({ error: { code: 'read_error', message: err.message } });
    }
  });

  // POST /api/settings
  app.post('/api/settings', (req, res) => {
    if (!settingsPath) return res.status(501).json({ error: { code: 'not_configured', message: 'settingsPath not configured' } });

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'Request body must be a JSON object', details: [] } });
    }

    const validation = validateSettingsPayload(body);
    if (!validation.valid) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'Invalid settings payload', details: validation.details } });
    }

    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));

      // Merge worca sub-keys (replace each top-level sub-key wholesale)
      if (body.worca && typeof body.worca === 'object') {
        if (!raw.worca) raw.worca = {};
        for (const key of Object.keys(body.worca)) {
          raw.worca[key] = body.worca[key];
        }
      }

      // Replace permissions wholesale
      if (body.permissions !== undefined) {
        raw.permissions = body.permissions;
      }

      // Never touch hooks
      writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      res.json({ worca: raw.worca || {}, permissions: raw.permissions || {} });
    } catch (err) {
      res.status(500).json({ error: { code: 'write_error', message: err.message } });
    }
  });

  app.use(express.static(appDir));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile('index.html', { root: appDir });
  });
  return app;
}
