# Rivals Dashboard

Panel web del bot Rivals. Es independiente del bot: comparte con él la base de datos (Turso) y habla con Discord por la API REST usando el token del bot, así que funciona aunque el bot esté caído.

## Variables (ver `.env.example`)
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (las mismas que el bot), `DISCORD_TOKEN`, `GUILD_ID`, `DASHBOARD_PASSWORD`.

## En local
`npm install` → `npm start` → http://127.0.0.1:3000

## En un hosting web gratuito (ejemplo: Render)
1. Sube esta carpeta a un repositorio de GitHub (`.gitignore` ya excluye `.env`; **nunca lo subas**).
2. Render → *New → Web Service* → tu repositorio. Build: `npm install`. Start: `npm start`. Instancia: Free.
3. En *Environment* añade las 5 variables de arriba. El puerto lo pone Render solo.
4. Entra a la URL que te da y usa la clave.

El plan gratuito de Render se duerme tras 15 min sin visitas (la primera carga tarda cerca de un minuto). No guarda nada en disco y la sesión es una cookie firmada, así que sobrevive a los reinicios. `/health` responde sin clave por si quieres un ping.

## ForceSpawn
Anuncia el Pokémon por la API de Discord y lo registra en la base. Si el bot está apagado, el Pokémon no huirá hasta que el bot vuelva.

## Primeros pasos
1. **Pokémon**: carga los Pokémon (a mano o por lote JSON).
2. **Spawn**: activa las categorías y llena sus tablas.
3. **Ajustes**: marca las zonas viajables, precios y probabilidad shiny.
