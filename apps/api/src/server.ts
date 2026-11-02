import { createApp } from './app.js';
import { pool } from './db/pool.js';

const app = createApp(pool);

const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

app.listen(port, () => {
  console.info(`Trade reconciliation API listening on http://localhost:${port}`);
});
