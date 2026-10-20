import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run, batch } from '../db.js';
import { RARITIES } from '../config.js';
import {
  scheduleNext, activeSpawnIn, spawnPayload, registerSpawn,
} from '../spawnCore.js';
import { structure, textChannel, textChannelGroups, sendEmbed } from './discord.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const EVO_TYPES = ['exp', 'amistad', 'item'];
const IMG_MAX = 1_000_000; // 1 MB por imagen

/** Crea la tabla donde se guardan las imágenes subidas (solo la usa el dashboard). Se llama al arrancar. */
export const initImages = () => run(`CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL)`);

/** Detecta el formato por los primeros bytes (no se fía del tipo que declare el navegador). SVG queda fuera a propósito. */
function sniffImage(b) {
  const at = (i, str) => b.subarray(i, i + str.length).toString('latin1') === str;
  if (b.length > 12) {
    if (b[0] === 0x89 && at(1, 'PNG')) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif';
    if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  }
  return null;
}
const LOCAL = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i;

const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
  .map((s) => String(s).trim()).filter(Boolean);
const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const num = (v) => (v == null || String(v).trim() === '' ? null : Math.round(Number(v)));
const safeJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

function serializePokemon(r, variants, byId) {
  const target = r.evo_to ? byId.get(r.evo_to) : null;
  return {
    evolution: target && r.evo_type ? { to: target.id, to_name: target.name, type: r.evo_type, qty: r.evo_qty, item: r.evo_item } : null,
    id: r.id, name: r.name, rarity: r.rarity, sprite: r.sprite_url, shiny_sprite: r.shiny_sprite_url,
    types: safeJson(r.types, []), stats: safeJson(r.stats, {}), abilities: safeJson(r.abilities, []),
    moves: safeJson(r.moves, []), dex_text: r.dex_text,
    shiny_odds: r.shiny_odds, shiny_canon_weight: r.shiny_canon_weight,
    variants: variants.filter((v) => v.pokemon_id === r.id).map(({ id, name, sprite, weight }) => ({ id, name, sprite, weight })),
  };
}

/** Sentencia que crea/actualiza una variante shiny. `pokemonRef` es un id numérico o un nombre de especie. */
function variantStatement(pokemonRef, v) {
  const name = text(v?.name), sprite = text(v?.sprite);
  if (!name || !sprite) throw new Error('La variante necesita nombre e imagen');
  const weight = Math.max(1, Math.round(Number(v.weight)) || 1);
  const idSql = typeof pokemonRef === 'number' ? '?' : '(SELECT id FROM pokemon WHERE name = ?)';
  return [`INSERT INTO shiny_variants (pokemon_id, name, sprite_url, weight) VALUES (${idSql}, ?, ?, ?)
    ON CONFLICT(pokemon_id, name) DO UPDATE SET sprite_url = excluded.sprite_url, weight = excluded.weight`,
  [pokemonRef, name, sprite, weight]];
}

/**
 * Sentencias que fijan (o quitan, con evo = null) la evolución de un Pokémon. `evo.to` es un id o un nombre de especie.
 * Va siempre DESPUÉS de guardar el Pokémon (y, en lotes, de guardar todos), para que el destino ya exista.
 */
function evolutionStatements(name, evo) {
  if (evo === null) return [['UPDATE pokemon SET evo_to = NULL, evo_type = NULL, evo_qty = NULL, evo_item = NULL WHERE name = ?', [name]]];
  const type = String(evo?.type ?? '').toLowerCase();
  const qty = Math.round(Number(evo?.qty));
  const to = text(evo?.to);
  if (!to) throw new Error(`${name}: falta el Pokémon al que evoluciona`);
  if (!EVO_TYPES.includes(type)) throw new Error(`${name}: tipo de evolución inválido (${EVO_TYPES.join(', ')})`);
  if (!(qty >= 1) || (type === 'amistad' && qty > 255)) throw new Error(`${name}: cantidad de evolución inválida${type === 'amistad' ? ' (1-255)' : ''}`);
  const item = type === 'item' ? text(evo.item) : null;
  if (type === 'item' && !item) throw new Error(`${name}: falta el objeto que pide su evolución`);
  const stmts = [];
  if (item) stmts.push(['INSERT OR IGNORE INTO items (name) VALUES (?)', [item]]); // si no existía, se crea para completarlo después
  const byId = /^\d+$/.test(to);
  stmts.push([`UPDATE pokemon SET evo_type = ?, evo_qty = ?, evo_item = ?,
      evo_to = (SELECT id FROM pokemon WHERE ${byId ? 'id' : 'name'} = ? AND name != ?) WHERE name = ?`,
  [type, qty, item, byId ? Number(to) : to, name, name]]);
  return stmts;
}

/**
 * Valida un Pokémon y devuelve las sentencias SQL que lo guardan (se ejecutan todas juntas en un solo viaje).
 * merge=true (lotes): los campos ausentes conservan su valor previo (`prev` = fila actual o undefined).
 */
function pokemonStatements(input, merge, prev) {
  const name = text(input.name);
  if (!name) throw new Error('Falta el nombre');
  if (!RARITIES[input.rarity]) throw new Error(`${name}: rareza inválida (${Object.keys(RARITIES).join(', ')})`);
  const keep = (key, val) => (merge && val === undefined && prev ? prev[key] : val ?? null);

  const stats = input.stats === undefined ? undefined : Object.fromEntries(
    STAT_KEYS.filter((k) => Number.isFinite(Number(input.stats?.[k]))).map((k) => [k, Number(input.stats[k])]));
  const abilities = input.abilities === undefined ? undefined : list(input.abilities);
  const moves = input.moves === undefined ? undefined : list(input.moves);
  const types = input.types === undefined ? undefined : list(input.types);

  const odds = input.shiny_odds === undefined ? undefined : num(input.shiny_odds);
  const canonW = input.shiny_canon_weight === undefined ? undefined : num(input.shiny_canon_weight);
  if ((odds != null && !(odds >= 0)) || (canonW != null && !(canonW >= 0))) throw new Error(`${name}: valores de shiny inválidos`);

  const json = (v) => (v === undefined ? undefined : JSON.stringify(v));
  const stmts = [];
  for (const n of abilities ?? []) stmts.push(['INSERT OR IGNORE INTO abilities (name) VALUES (?)', [n]]);
  for (const n of moves ?? []) stmts.push(['INSERT OR IGNORE INTO moves (name) VALUES (?)', [n]]);
  stmts.push([`
    INSERT INTO pokemon (name, rarity, sprite_url, shiny_sprite_url, types, stats, abilities, moves, dex_text, shiny_odds, shiny_canon_weight)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET rarity = excluded.rarity, sprite_url = excluded.sprite_url,
      shiny_sprite_url = excluded.shiny_sprite_url, types = excluded.types, stats = excluded.stats,
      abilities = excluded.abilities, moves = excluded.moves, dex_text = excluded.dex_text,
      shiny_odds = excluded.shiny_odds, shiny_canon_weight = excluded.shiny_canon_weight`, [
    name, input.rarity,
    keep('sprite_url', input.sprite === undefined ? undefined : text(input.sprite)),
    keep('shiny_sprite_url', input.shiny_sprite === undefined ? undefined : text(input.shiny_sprite)),
    keep('types', json(types)),
    keep('stats', json(stats)),
    keep('abilities', json(abilities)),
    keep('moves', json(moves)),
    keep('dex_text', input.dex_text === undefined ? undefined : text(input.dex_text)),
    keep('shiny_odds', odds),
    keep('shiny_canon_weight', canonW) ?? 1,
  ]]);
  if (Array.isArray(input.shiny_variants)) input.shiny_variants.forEach((v) => stmts.push(variantStatement(name, v)));
  // evolution: undefined = no tocar · null = quitar · objeto = fijar
  const evo = input.evolution === undefined ? undefined : input.evolution;
  const evoStmts = evo === undefined ? [] : evolutionStatements(name, evo);
  return { name, stmts, evoStmts, evo };
}

export function createApp() {
  const password = process.env.DASHBOARD_PASSWORD;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // detrás del proxy del hosting (para IP real y cookie Secure)
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (req, res) => res.json({ ok: true })); // para que el hosting compruebe que está vivo

  // ── Auth: clave única + cookie firmada. Sin estado en memoria, así sobrevive a reinicios/suspensión del hosting ──
  const fails = new Map(); // ip -> { n, until }  (mejor esfuerzo)
  const sha = (s) => crypto.createHash('sha256').update(s).digest();
  const secret = sha(`rivals-dashboard:${password}`);
  const sign = (exp) => crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
  const makeToken = (ttlMs) => { const exp = Date.now() + ttlMs; return `${exp}.${sign(exp)}`; };
  const cookieOf = (req) => /(?:^|;\s*)sid=([0-9]+\.[a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
  const authed = (req) => {
    const t = cookieOf(req);
    if (!t) return false;
    const [exp, sig] = t.split('.');
    if (Number(exp) < Date.now()) return false;
    const a = Buffer.from(sig), b = Buffer.from(sign(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  app.post('/api/login', (req, res) => {
    const f = fails.get(req.ip) ?? { n: 0, until: 0 };
    if (f.until > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    const ok = crypto.timingSafeEqual(sha(String(req.body?.password ?? '')), sha(password));
    if (!ok) {
      f.n += 1;
      if (f.n >= 5) { f.until = Date.now() + 10 * 60_000; f.n = 0; }
      fails.set(req.ip, f);
      return res.status(401).json({ error: 'Clave incorrecta' });
    }
    fails.delete(req.ip);
    const week = 7 * 24 * 3600_000;
    res.setHeader('Set-Cookie', `sid=${makeToken(week)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${week / 1000}${req.secure ? '; Secure' : ''}`);
    return res.json({ ok: true });
  });

  app.use(express.static(PUBLIC));
  app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'No autenticado' })));
  app.get('/api/me', (req, res) => res.json({ ok: true }));

  // Envuelve los handlers async para que un fallo de la BD llegue al manejador de errores
  const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ── Imágenes: se suben desde el panel y se sirven públicamente (Discord necesita una URL para mostrarlas) ──
  // El id es el hash del contenido: la misma imagen no se guarda dos veces y la URL nunca cambia de contenido.
  app.get('/img/:id', h(async (req, res) => {
    const row = /^[a-f0-9]{32}$/.test(req.params.id) ? await get('SELECT mime, data FROM images WHERE id = ?', [req.params.id]) : null;
    if (!row) return res.sendStatus(404);
    res.set({ 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    return res.send(Buffer.from(row.data));
  }));
  app.post('/api/upload', express.raw({ type: () => true, limit: IMG_MAX }), h(async (req, res) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = sniffImage(buf);
    if (!mime) return res.status(400).json({ error: 'Formato no válido. Sube un PNG, JPG, GIF o WebP.' });
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    if (!process.env.PUBLIC_URL && LOCAL.test(req.get('host') ?? '')) {
      return res.status(400).json({ error: 'Estás en una dirección local: Discord no podría ver la imagen. Define PUBLIC_URL (la dirección pública del dashboard).' });
    }
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
    await run('INSERT OR IGNORE INTO images (id, mime, data, created_at) VALUES (?, ?, ?, ?)', [id, mime, buf, Date.now()]);
    return res.json({ ok: true, url: `${base}/img/${id}` });
  }));

  // ── Estructura del servidor (vía API de Discord) ──
  app.get('/api/structure', h(async (req, res) => res.json(await structure())));

  // ── Pokémon ──
  app.get('/api/pokemon', h(async (req, res) => {
    const [rows, variants] = await Promise.all([
      all('SELECT * FROM pokemon ORDER BY name'),
      all('SELECT id, pokemon_id, name, sprite_url AS sprite, weight FROM shiny_variants ORDER BY name'),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    res.json(rows.map((r) => serializePokemon(r, variants, byId)));
  }));
  app.post('/api/pokemon', h(async (req, res) => {
    try {
      const { name, stmts, evoStmts, evo } = pokemonStatements(req.body ?? {}, false, undefined);
      if (evo) {
        const to = text(evo.to);
        const target = to && await get(`SELECT id FROM pokemon WHERE ${/^\d+$/.test(to) ? 'id' : 'name'} = ? AND name != ?`, [to, name]);
        if (!target) return res.status(400).json({ error: 'El Pokémon al que evoluciona no existe (o es él mismo).' });
      }
      await batch([...stmts, ...evoStmts]);
      res.json({ ok: true, name });
    } catch (e) { res.status(400).json({ error: e.message }); }
  }));
  app.post('/api/pokemon/batch', h(async (req, res) => {
    const items = Array.isArray(req.body) ? req.body : req.body?.pokemon;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Se esperaba una lista JSON de Pokémon' });
    const prevRows = await all('SELECT * FROM pokemon');
    const prev = new Map(prevRows.map((r) => [r.name.toLowerCase(), r]));
    let saved = 0; const errors = []; const stmts = []; const evoStmts = [];
    const known = new Set([...prev.keys(), ...items.map((it) => String(it?.name ?? '').trim().toLowerCase())]);
    items.forEach((it, i) => {
      try {
        const r = pokemonStatements(it ?? {}, true, prev.get(String(it?.name ?? '').trim().toLowerCase()));
        stmts.push(...r.stmts); saved += 1;
        if (r.evo) {
          const to = String(r.evo.to ?? '').trim().toLowerCase();
          const ok = /^\d+$/.test(to) ? prevRows.some((x) => x.id === Number(to) && x.name.toLowerCase() !== r.name.toLowerCase()) : known.has(to) && to !== r.name.toLowerCase();
          if (ok) evoStmts.push(...r.evoStmts); else errors.push(`#${i + 1}: ${r.name}: evolución a «${r.evo.to}» (no existe; se guardó sin evolución)`);
        } else evoStmts.push(...r.evoStmts); // evolution: null → quitarla
      } catch (e) { errors.push(`#${i + 1}: ${e.message}`); }
    });
    stmts.push(...evoStmts); // las evoluciones van al final, cuando ya existen todos los destinos
    // Todo el lote se guarda junto, en trozos para no saturar una sola petición
    for (let i = 0; i < stmts.length; i += 200) await batch(stmts.slice(i, i + 200));
    res.json({ ok: true, saved, errors });
  }));
  app.delete('/api/pokemon/:id', h(async (req, res) => {
    const id = Number(req.params.id);
    const used = await get(`SELECT (SELECT COUNT(*) FROM user_pokemon WHERE pokemon_id = ?)
      + (SELECT COUNT(*) FROM active_spawns WHERE pokemon_id = ?) AS n`, [id, id]);
    if (used.n > 0) return res.status(409).json({ error: 'No se puede borrar: tiene spawns o capturas de usuarios asociados.' });
    await batch([
      ['DELETE FROM spawn_entries WHERE pokemon_id = ?', [id]],
      ['DELETE FROM shiny_variants WHERE pokemon_id = ?', [id]],
      ['UPDATE pokemon SET evo_to = NULL, evo_type = NULL, evo_qty = NULL, evo_item = NULL WHERE evo_to = ?', [id]],
      ['DELETE FROM pokemon WHERE id = ?', [id]],
    ]);
    return res.json({ ok: true });
  }));

  // ── Variantes shiny propias (solo shinys nuevos de Pokémon existentes; no hay Pokémon custom) ──
  app.post('/api/pokemon/:id/variants', h(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await get('SELECT 1 AS ok FROM pokemon WHERE id = ?', [id]))) return res.status(404).json({ error: 'Pokémon inexistente' });
    try {
      const [sql, args] = variantStatement(id, req.body);
      await run(sql, args);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  }));
  app.delete('/api/variants/:id', h(async (req, res) => {
    const id = Number(req.params.id);
    await batch([
      ['UPDATE user_pokemon SET shiny_variant_id = NULL WHERE shiny_variant_id = ?', [id]],
      ['DELETE FROM shiny_variants WHERE id = ?', [id]],
    ]);
    res.json({ ok: true });
  }));

  // ── Catálogo de movimientos / habilidades ──
  const kinds = { moves: 'moves', abilities: 'abilities' };
  app.get('/api/catalog/:kind', h(async (req, res) => {
    const t = kinds[req.params.kind];
    if (!t) return res.sendStatus(404);
    return res.json(await all(`SELECT * FROM ${t} ORDER BY name`));
  }));
  app.post('/api/catalog/:kind', h(async (req, res) => {
    const t = kinds[req.params.kind];
    const name = text(req.body?.name);
    if (!t || !name) return res.status(400).json({ error: 'Falta el nombre' });
    await run(`INSERT INTO ${t} (name, type, description) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET type = excluded.type, description = excluded.description`,
    [name, text(req.body.type), text(req.body.description)]);
    return res.json({ ok: true });
  }));
  app.delete('/api/catalog/:kind/:name', h(async (req, res) => {
    const t = kinds[req.params.kind];
    if (!t) return res.sendStatus(404);
    await run(`DELETE FROM ${t} WHERE name = ?`, [req.params.name]);
    return res.json({ ok: true });
  }));

  // ── Objetos (no se "usan": son requisito de evolución y aparecen en el inventario) ──
  app.get('/api/items', h(async (req, res) => {
    res.json(await all('SELECT name, description, icon_url AS icon FROM items ORDER BY name'));
  }));
  app.post('/api/items', h(async (req, res) => {
    const name = text(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Falta el nombre' });
    await run(`INSERT INTO items (name, description, icon_url) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET description = excluded.description, icon_url = excluded.icon_url`,
    [name, text(req.body.description), text(req.body.icon)]);
    return res.json({ ok: true });
  }));
  app.delete('/api/items/:name', h(async (req, res) => {
    const users = await all('SELECT name FROM pokemon WHERE evo_item = ? AND evo_type = ?', [req.params.name, 'item']);
    if (users.length) return res.status(409).json({ error: `No se puede borrar: lo pide la evolución de ${users.map((u) => u.name).join(', ')}.` });
    await run('DELETE FROM items WHERE name = ?', [req.params.name]);
    return res.json({ ok: true });
  }));

  // ── Centros Pokémon (canales donde se puede intercambiar) ──
  app.get('/api/centers', h(async (req, res) => {
    const [groups, rows] = await Promise.all([textChannelGroups(), all('SELECT channel_id FROM centers')]);
    const ids = new Set(rows.map((r) => r.channel_id));
    const seen = new Set(groups.flatMap((g) => g.channels.map((c) => c.id)));
    res.json({
      groups: groups.map((g) => ({ name: g.name, channels: g.channels.map((c) => ({ ...c, center: ids.has(c.id) })) })),
      missing: [...ids].filter((id) => !seen.has(id)), // canales borrados que seguían marcados
    });
  }));
  app.post('/api/centers/:id', h(async (req, res) => {
    const id = req.params.id;
    if (req.body?.enabled) {
      if (!(await textChannel(id))) return res.status(400).json({ error: 'Canal inválido (debe ser un canal de texto del servidor).' });
      await run('INSERT OR IGNORE INTO centers (channel_id) VALUES (?)', [id]);
    } else await run('DELETE FROM centers WHERE channel_id = ?', [id]);
    return res.json({ ok: true });
  }));

  // ── Spawn ──
  app.get('/api/spawn/categories', h(async (req, res) => {
    const [rows, active] = await Promise.all([
      all('SELECT * FROM spawn_categories'),
      all(`SELECT DISTINCT category_id FROM active_spawns WHERE status = 'active'`),
    ]);
    const busy = new Set(active.map((r) => r.category_id));
    res.json(rows.map((r) => ({
      category_id: r.category_id, enabled: !!r.enabled, next_spawn_at: r.next_spawn_at, active: busy.has(r.category_id),
    })));
  }));
  app.post('/api/spawn/categories/:id', h(async (req, res) => {
    const id = req.params.id;
    if (req.body?.enabled) {
      await run(`INSERT INTO spawn_categories (category_id, guild_id, enabled) VALUES (?, ?, 1)
        ON CONFLICT(category_id) DO UPDATE SET enabled = 1`, [id, process.env.GUILD_ID]);
      const busy = await get(`SELECT 1 AS ok FROM active_spawns WHERE category_id = ? AND forced = 0 AND status = 'active'`, [id]);
      if (!busy) await scheduleNext(id);
    } else {
      await run('UPDATE spawn_categories SET enabled = 0, next_spawn_at = NULL WHERE category_id = ?', [id]);
    }
    res.json({ ok: true });
  }));
  app.get('/api/spawn/:categoryId/entries', h(async (req, res) => {
    res.json(await all(`
      SELECT e.id, e.channel_id, e.weight, p.name, p.rarity FROM spawn_entries e
      JOIN pokemon p ON p.id = e.pokemon_id WHERE e.category_id = ? ORDER BY e.channel_id IS NOT NULL, p.name`,
    [req.params.categoryId]));
  }));
  app.post('/api/spawn/:categoryId/entries', h(async (req, res) => {
    const { pokemon_id: pokemonId, channel_id: channelId } = req.body ?? {};
    const weight = Math.max(1, parseInt(req.body?.weight, 10) || 1);
    if (!(await get('SELECT 1 AS ok FROM spawn_categories WHERE category_id = ?', [req.params.categoryId]))) {
      return res.status(400).json({ error: 'Activa el spawn de la categoría primero.' });
    }
    if (!(await get('SELECT 1 AS ok FROM pokemon WHERE id = ?', [pokemonId]))) {
      return res.status(400).json({ error: 'Pokémon inválido.' });
    }
    await run(`INSERT INTO spawn_entries (category_id, channel_id, pokemon_id, weight) VALUES (?, ?, ?, ?)
      ON CONFLICT(category_id, IFNULL(channel_id, ''), pokemon_id) DO UPDATE SET weight = excluded.weight`,
    [req.params.categoryId, channelId || null, pokemonId, weight]);
    return res.json({ ok: true });
  }));
  app.delete('/api/spawn/entries/:id', h(async (req, res) => {
    await run('DELETE FROM spawn_entries WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  }));

  // ForceSpawn: anuncia el Pokémon por la API de Discord y lo registra; el bot (en Discloud) se encarga de que huya a su hora
  app.post('/api/forcespawn', h(async (req, res) => {
    const { pokemon_id: pokemonId, channel_id: channelId } = req.body ?? {};
    const channel = await textChannel(String(channelId));
    if (!channel) return res.status(400).json({ error: 'Canal inválido.' });
    const p = await get('SELECT * FROM pokemon WHERE id = ?', [pokemonId]);
    if (!p) return res.status(400).json({ error: 'Pokémon inválido.' });
    if (await activeSpawnIn(channel.id)) return res.status(409).json({ error: 'Ya hay un Pokémon activo en ese canal.' });
    const { embed, despawnAt } = spawnPayload(p);
    let msg;
    try { msg = await sendEmbed(channel.id, embed); } catch {
      return res.status(500).json({ error: 'No pude enviar el mensaje (¿permisos del bot?).' });
    }
    await registerSpawn({
      categoryId: channel.parent_id ?? '', channelId: channel.id, messageId: msg.id,
      pokemonId: p.id, forced: true, despawnAt,
    });
    return res.json({ ok: true });
  }));

  // ── Ajustes / viaje ──
  app.get('/api/settings', h(async (req, res) => {
    const [rows, zones] = await Promise.all([all('SELECT key, value FROM settings'), all('SELECT * FROM zone_travel')]);
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    res.json({
      travel_hours: Number(s.travel_hours), travel_cost: Number(s.travel_cost),
      move_cost: Number(s.move_cost), trade_cost: Number(s.trade_cost), shiny_odds: Number(s.shiny_odds ?? 4096),
      zones,
    });
  }));
  app.post('/api/settings', h(async (req, res) => {
    const b = req.body ?? {};
    const hours = Number(b.travel_hours), cost = Number(b.travel_cost);
    const moveCost = Number(b.move_cost), tradeCost = Number(b.trade_cost);
    const shinyOdds = b.shiny_odds === undefined ? null : Number(b.shiny_odds);
    if (!(hours > 0) || !(cost >= 0) || !(moveCost >= 0) || !(tradeCost >= 0) || (shinyOdds != null && !(shinyOdds >= 0))) {
      return res.status(400).json({ error: 'Valores inválidos.' });
    }
    const up = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
    const stmts = [
      [up, ['travel_hours', String(hours)]], [up, ['travel_cost', String(Math.round(cost))]],
      [up, ['move_cost', String(Math.round(moveCost))]], [up, ['trade_cost', String(Math.round(tradeCost))]],
    ];
    if (shinyOdds != null) stmts.push([up, ['shiny_odds', String(Math.round(shinyOdds))]]);
    await batch(stmts);
    return res.json({ ok: true });
  }));
  app.post('/api/settings/zone/:id', h(async (req, res) => {
    const hrs = req.body?.hours === '' || req.body?.hours == null ? null : Number(req.body.hours);
    const cst = req.body?.cost === '' || req.body?.cost == null ? null : Math.round(Number(req.body.cost));
    const isZone = req.body?.is_zone ? 1 : 0;
    if ((hrs != null && !(hrs > 0)) || (cst != null && !(cst >= 0))) return res.status(400).json({ error: 'Valores inválidos.' });
    if (hrs == null && cst == null && !isZone) await run('DELETE FROM zone_travel WHERE category_id = ?', [req.params.id]);
    else {
      await run(`INSERT INTO zone_travel (category_id, hours, cost, is_zone) VALUES (?, ?, ?, ?)
        ON CONFLICT(category_id) DO UPDATE SET hours = excluded.hours, cost = excluded.cost, is_zone = excluded.is_zone`,
      [req.params.id, hrs, cst, isZone]);
    }
    return res.json({ ok: true });
  }));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'La imagen pesa más de 1 MB. Redúcela y vuelve a subirla.' });
    console.error('dashboard:', err);
    res.status(500).json({ error: 'Error interno' });
  });

  return app;
}
