import { createClient } from '@libsql/client/web';

const url = process.env.TURSO_DATABASE_URL;
if (!url) throw new Error('Falta TURSO_DATABASE_URL en .env (la URL libsql://… de tu base de Turso).');

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const plain = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));

/** Ejecutor sobre el cliente o sobre una transacción. Los parámetros van en un arreglo ([a, b]). */
const wrap = (x) => ({
  all: async (sql, args = []) => plain(await x.execute({ sql, args })),
  get: async (sql, args = []) => plain(await x.execute({ sql, args }))[0],
  run: async (sql, args = []) => {
    const r = await x.execute({ sql, args });
    return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
  },
});

export const { all, get, run } = wrap(client);

/** Varias sentencias en UNA sola ida y vuelta, atómicas. Devuelve la lista de filas de cada una. */
export async function batch(statements) {
  const out = await client.batch(statements.map(([sql, args = []]) => ({ sql, args })), 'write');
  return out.map(plain);
}

/** Transacción interactiva: fn recibe { all, get, run } ligados a la transacción. */
export async function tx(fn) {
  const t = await client.transaction('write');
  try {
    const r = await fn(wrap(t));
    await t.commit();
    return r;
  } catch (err) {
    await t.rollback().catch(() => {});
    throw err;
  } finally {
    t.close();
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pokemon (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sprite_url TEXT,
    rarity TEXT NOT NULL CHECK (rarity IN ('comun','raro','epico','legendario')),
    shiny_sprite_url TEXT, types TEXT, stats TEXT, abilities TEXT, moves TEXT, dex_text TEXT,
    shiny_odds INTEGER,
    shiny_canon_weight INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS spawn_categories (
    category_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, next_spawn_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS spawn_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id TEXT NOT NULL REFERENCES spawn_categories(category_id) ON DELETE CASCADE,
    channel_id TEXT,
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    weight INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS spawn_entries_unique ON spawn_entries (category_id, IFNULL(channel_id, ''), pokemon_id)`,
  `CREATE TABLE IF NOT EXISTS active_spawns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
    forced INTEGER NOT NULL DEFAULT 0, despawn_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','captured','despawned'))
  )`,
  `CREATE INDEX IF NOT EXISTS active_spawns_channel ON active_spawns (channel_id, status)`,
  `CREATE TABLE IF NOT EXISTS shiny_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE, sprite_url TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 1, UNIQUE (pokemon_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    pokeball INTEGER NOT NULL DEFAULT 0, superball INTEGER NOT NULL DEFAULT 0, ultraball INTEGER NOT NULL DEFAULT 0,
    name TEXT, icon_url TEXT,
    money INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0,
    zone_id TEXT, travel_to TEXT, arrive_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS user_pokemon (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(user_id),
    pokemon_id INTEGER NOT NULL REFERENCES pokemon(id),
    level INTEGER NOT NULL DEFAULT 5, exp INTEGER NOT NULL DEFAULT 0, friendship INTEGER NOT NULL DEFAULT 70,
    nature TEXT, shiny INTEGER NOT NULL DEFAULT 0, caught_at INTEGER NOT NULL,
    ability TEXT, moves TEXT NOT NULL DEFAULT '[]',
    shiny_variant_id INTEGER REFERENCES shiny_variants(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS user_pokemon_user ON user_pokemon (user_id)`,
  // El bot consulta estas dos cosas cada 15 s: con índice solo lee las filas pendientes (la BD online cobra por filas leídas)
  `CREATE INDEX IF NOT EXISTS active_spawns_due ON active_spawns (status, despawn_at)`,
  `CREATE INDEX IF NOT EXISTS users_arrivals ON users (arrive_at) WHERE travel_to IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS moves (name TEXT PRIMARY KEY COLLATE NOCASE, type TEXT, description TEXT)`,
  `CREATE TABLE IF NOT EXISTS abilities (name TEXT PRIMARY KEY COLLATE NOCASE, type TEXT, description TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS zone_travel (
    category_id TEXT PRIMARY KEY, hours REAL, cost INTEGER, is_zone INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS inventory (
    user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('item','mt')),
    item TEXT NOT NULL COLLATE NOCASE, qty INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kind, item)
  )`,
  `CREATE TABLE IF NOT EXISTS centers (channel_id TEXT PRIMARY KEY)`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES
    ('travel_hours','4'), ('travel_cost','1000'), ('move_cost','50'), ('trade_cost','500'), ('shiny_odds','4096')`,
];

/** Crea las tablas si faltan. Se llama una vez al arrancar (bot y dashboard). */
export async function initDb() {
  await client.batch(SCHEMA.map((sql) => ({ sql, args: [] })), 'write');
}
