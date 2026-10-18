// Parte del spawn que solo usa la BD (sin discord.js): la comparten el bot y el dashboard.
import { all, get, run } from './db.js';
import { SPAWN_INTERVALS_MIN, DESPAWN_MINUTES, RARITIES, FLAVOR } from './config.js';

export const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Programa el próximo spawn de la categoría con un intervalo aleatorio (30/45/60/90 min). */
export async function scheduleNext(categoryId) {
  const mins = rand(SPAWN_INTERVALS_MIN);
  await run('UPDATE spawn_categories SET next_spawn_at = ? WHERE category_id = ? AND enabled = 1',
    [Date.now() + mins * 60_000, categoryId]);
}

export const activeSpawnIn = (channelId) => get(`
  SELECT s.*, p.name, p.rarity, p.sprite_url
  FROM active_spawns s JOIN pokemon p ON p.id = s.pokemon_id
  WHERE s.channel_id = ? AND s.status = 'active'`, [channelId]);

export async function pickPokemon(categoryId, channelId) {
  const pool = await all(`
    SELECT pokemon_id, weight FROM spawn_entries
    WHERE category_id = ? AND (channel_id IS NULL OR channel_id = ?)`, [categoryId, channelId]);
  const total = pool.reduce((sum, r) => sum + r.weight, 0);
  if (!total) return null;
  let roll = Math.random() * total;
  for (const r of pool) {
    roll -= r.weight;
    if (roll < 0) return r.pokemon_id;
  }
  return pool.at(-1).pokemon_id;
}

/** Embed del anuncio, como objeto plano de la API de Discord (sirve para discord.js y para REST). */
export function spawnPayload(p) {
  const rar = RARITIES[p.rarity];
  const despawnAt = Date.now() + DESPAWN_MINUTES * 60_000;
  const embed = {
    color: rar.color,
    title: `¡Un ${p.name} salvaje ha aparecido!`,
    description: `*${rand(FLAVOR)}*`,
    fields: [
      { name: 'Rareza', value: rar.label, inline: true },
      { name: 'Huye', value: `<t:${Math.floor(despawnAt / 1000)}:R>`, inline: true },
    ],
  };
  if (p.sprite_url) embed.image = { url: p.sprite_url };
  return { embed, despawnAt };
}

/** Registra en la BD un spawn ya anunciado. */
export async function registerSpawn({ categoryId, channelId, messageId, pokemonId, forced, despawnAt }) {
  const r = await run(`
    INSERT INTO active_spawns (category_id, channel_id, message_id, pokemon_id, forced, despawn_at)
    VALUES (?, ?, ?, ?, ?, ?)`, [categoryId, channelId, messageId, pokemonId, forced ? 1 : 0, despawnAt]);
  return r.lastInsertRowid;
}
