# Rivals Dashboard

Panel web del bot Rivals. Es independiente del bot: comparte con él la base de datos (Turso) y habla con Discord por la API REST usando el token del bot, así que funciona aunque el bot esté caído.

## Variables (ver `.env.example`)
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (las mismas que el bot), `DISCORD_TOKEN`, `GUILD_ID`, `DASHBOARD_PASSWORD` y `PUBLIC_URL` (la dirección pública del dashboard; opcional en un hosting, donde se detecta sola, pero obligatoria si subes imágenes entrando por `localhost`).

## En local
`npm install` → `npm start` → http://127.0.0.1:3000

## En un hosting web gratuito (ejemplo: Render)
1. Sube esta carpeta a un repositorio de GitHub (`.gitignore` ya excluye `.env`; **nunca lo subas**).
2. Render → *New → Web Service* → tu repositorio. Build: `npm install`. Start: `npm start`. Instancia: Free.
3. En *Environment* añade las variables de arriba (con `PUBLIC_URL` = la URL que te dé Render). El puerto lo pone Render solo.
4. Entra a la URL que te da y usa la clave.

El plan gratuito de Render se duerme tras 15 min sin visitas (la primera carga tarda cerca de un minuto). No guarda nada en disco y la sesión es una cookie firmada, así que sobrevive a los reinicios. `/health` responde sin clave por si quieres un ping.

## Imágenes (sprites e iconos)
Los sprites, las variantes shiny y los iconos de objetos **se suben como archivo** (PNG, JPG, GIF o WebP, máx. 1 MB) desde el editor. Se guardan en la base de datos y el dashboard las publica en `PUBLIC_URL/img/<id>`, que es la URL que usa el bot en sus mensajes. Los sprites que ya tenías como URL siguen funcionando hasta que los cambies.

⚠️ Como las sirve el dashboard, si tu hosting lo duerme (Render gratis) la imagen puede tardar en cargar la primera vez que Discord la pida. Un ping periódico a `/health` (por ejemplo con UptimeRobot) lo evita.

## ForceSpawn
Anuncia el Pokémon por la API de Discord y lo registra en la base. Si el bot está apagado, el Pokémon no huirá hasta que el bot vuelva.

## Primeros pasos
1. **Pokémon**: carga los Pokémon (a mano o por lote JSON).
2. **Spawn**: activa las categorías y llena sus tablas.
3. **Ajustes**: marca las zonas viajables, precios y probabilidad shiny, y qué canales son **Centros Pokémon** (donde se puede intercambiar).
4. **Objetos**: crea los objetos (no se "usan"; sirven como requisito de evolución).
5. **Pokémon → Editar → Evolución**: en qué evoluciona y qué pide (EXP, Amistad u Objeto + cantidad).
