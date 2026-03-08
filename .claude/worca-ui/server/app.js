// server/app.js
import express from 'express';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export function createApp() {
  const app = express();
  const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
  app.use(express.static(appDir));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile('index.html', { root: appDir });
  });
  return app;
}
