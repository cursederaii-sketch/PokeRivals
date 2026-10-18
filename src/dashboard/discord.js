// Cliente mínimo de la API REST de Discord (sin discord.js ni conexión al gateway).
// Permite al dashboard leer la estructura del servidor y anunciar spawns aunque el bot esté caído.
const API = 'https://discord.com/api/v10';

export async function discord(method, path, body, retried = false) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429 && !retried) {
    const { retry_after: wait = 1 } = await r.json().catch(() => ({}));
    await new Promise((res) => setTimeout(res, Math.ceil(wait * 1000)));
    return discord(method, path, body, true);
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw Object.assign(new Error(`Discord ${r.status}: ${detail.slice(0, 200)}`), { status: r.status });
  }
  return r.status === 204 ? null : r.json();
}

const GUILD_TEXT = 0;
const GUILD_CATEGORY = 4;
let cache = { at: 0, data: [] };

/** Categorías con sus canales de texto, en el orden del servidor (se cachea 30 s). */
export async function structure() {
  if (Date.now() - cache.at < 30_000) return cache.data;
  const chans = await discord('GET', `/guilds/${process.env.GUILD_ID}/channels`);
  const byPos = (a, b) => a.position - b.position;
  const data = chans.filter((c) => c.type === GUILD_CATEGORY).sort(byPos).map((c) => ({
    id: c.id, name: c.name,
    channels: chans.filter((x) => x.parent_id === c.id && x.type === GUILD_TEXT).sort(byPos)
      .map((x) => ({ id: x.id, name: x.name })),
  }));
  cache = { at: Date.now(), data };
  return data;
}

/** Devuelve el canal si existe y es de texto, o null. */
export async function textChannel(id) {
  try {
    const c = await discord('GET', `/channels/${encodeURIComponent(id)}`);
    return c.type === GUILD_TEXT ? c : null;
  } catch (err) {
    if (err.status === 404 || err.status === 403 || err.status === 400) return null;
    throw err;
  }
}

export const sendEmbed = (channelId, embed) => discord('POST', `/channels/${channelId}/messages`, { embeds: [embed] });
