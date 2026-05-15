import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import chatRouter from './routes/chat.js';
import configRouter from './routes/config.js';
import keepRouter from './routes/keep.js';
import vikunjaRouter from './routes/vikunja.js';
import homeAssistantRouter from './routes/homeassistant.js';
import openrouterMetaRouter from './routes/openrouter.js';
import skyEventsRouter from './routes/sky-events.js';
import hostHealthRouter from './routes/host-health.js';
import dashboardCheckRouter from './routes/dashboard-check.js';
import networkHealthRouter from './routes/network-health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const docsDir = path.join(root, 'docs');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(
  express.static(publicDir, {
    extensions: ['html'],
    /** Revalidate on reload so icon/calendar/asset edits show up without fighting the disk cache. */
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    },
  }),
);
app.use('/docs', express.static(docsDir));

app.use('/api/config', configRouter);
app.use('/api/chat', chatRouter);
app.use('/api/vikunja', vikunjaRouter);
app.use('/api/keep', keepRouter);
app.use('/api/home-assistant', homeAssistantRouter);
app.use('/api/openrouter', openrouterMetaRouter);
app.use('/api/sky-events', skyEventsRouter);
app.use('/api/host-health', hostHealthRouter);
app.use('/api/network-health', networkHealthRouter);
app.use('/api/dashboard-check', dashboardCheckRouter);

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal_error' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`dashbird listening on http://0.0.0.0:${port}`);
});
