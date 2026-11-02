import { removeDatabaseEnvironment } from '../../scripts/e2e-env.mjs';

removeDatabaseEnvironment(process.env);
process.env.E2E_WEB_PORT = '5174';
process.env.VITE_API_PROXY_TARGET = 'http://127.0.0.1:3301';

const { createServer } = await import('vite');
const server = await createServer({
  mode: 'e2e',
  server: { host: '127.0.0.1', strictPort: true },
});

await server.listen();
server.printUrls();

let closing = false;
async function closeServer() {
  if (closing) return;
  closing = true;
  await server.close();
}

process.once('SIGINT', () => void closeServer());
process.once('SIGTERM', () => void closeServer());
