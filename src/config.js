export const SPAWN_INTERVALS_MIN = [30, 45, 60, 90];
export const DESPAWN_MINUTES = Number(process.env.DESPAWN_MINUTES) || 15;
export const TICK_MS = 15_000;
export const MAX_TEAM = 6;

// Tasa de captura fija por Ball
export const BALLS = {
  pokeball:  { label: 'Poké Ball',  rate: 0.5 },
  superball: { label: 'Super Ball', rate: 0.7 },
  ultraball: { label: 'Ultra Ball', rate: 0.9 },
};

// Modificador de captura por rareza (chance final = rate * mod)
export const RARITIES = {
  comun:      { label: 'Común',      mod: 1.0,  color: 0x9aa0a6 },
  raro:       { label: 'Raro',       mod: 0.6,  color: 0x3b82f6 },
  epico:      { label: 'Épico',      mod: 0.35, color: 0xa855f7 },
  legendario: { label: 'Legendario', mod: 0.15, color: 0xf59e0b },
};

export const FLAVOR = [
  'El Pokémon se encuentra en peligro.',
  'El Pokémon se encuentra herido.',
  'El Pokémon se encuentra fuera de control.',
  'El Pokémon parece asustado y desconfiado.',
  'El Pokémon observa a su alrededor con curiosidad.',
  'El Pokémon se muestra agresivo y territorial.',
];

export const NATURES = [
  'Fuerte', 'Audaz', 'Modesta', 'Serena', 'Alegre', 'Tímida', 'Osada', 'Dócil',
  'Firme', 'Pícara', 'Mansa', 'Cauta', 'Rara', 'Activa', 'Agitada', 'Floja',
  'Miedosa', 'Amable', 'Huraña', 'Plácida', 'Afable', 'Grosera', 'Ingenua', 'Alocada', 'Seria',
];
