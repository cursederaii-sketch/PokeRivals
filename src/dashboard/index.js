import 'dotenv/config';
import { initDb } from '../db.js';
import { createApp } from './server.js';

// Dashboard independiente del bot: comparte con él la base de datos (Turso) y habla con Discord por la API REST.
for (const k of ['DASHBOARD_PASSWORD', 'DISCORD_TOKEN', 'GUILD_ID']) {
  if (!process.env[k]) { console.error(`Falta ${k} en las variables de entorno.`); process.exit(1); }
}

await initDb();
const port = Number(process.env.PORT || process.env.DASHBOARD_PORT) || 3000;
const host = process.env.DASHBOARD_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
createApp().listen(port, host, () => console.log(`Dashboard en http://${host}:${port}`));
