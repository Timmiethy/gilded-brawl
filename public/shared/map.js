// Shared open-world arena geometry (2400 x 2400) — used by both server physics & client renderer

export const WORLD_SIZE = 2400;
export const WORLD_HALF = WORLD_SIZE / 2;

export const ROUND_DURATION_SEC = 90; // 1 minute 30 seconds
export const INTERMISSION_SEC = 6;

// 4 open-world quadrants + central Gilded Courtyard
export const BIOMES = {
  COURTYARD: { id: 'courtyard', name: 'Gilded Courtyard', x: 1200, y: 1200, radius: 420 },
  RUINS: { id: 'ruins', name: 'Moonlit Ruins', qx: 0, qy: 0 },
  FORGE: { id: 'forge', name: 'Ember Forge', qx: 1, qy: 0 },
  MEADOW: { id: 'meadow', name: 'Whispering Meadow', qx: 0, qy: 1 },
  SANCTUM: { id: 'sanctum', name: 'Frost Sanctum', qx: 1, qy: 1 },
};

export function getBiomeAt(x, y) {
  const dx = x - WORLD_HALF;
  const dy = y - WORLD_HALF;
  if (dx * dx + dy * dy <= 420 * 420) return 'courtyard';
  if (x < WORLD_HALF && y < WORLD_HALF) return 'ruins';
  if (x >= WORLD_HALF && y < WORLD_HALF) return 'forge';
  if (x < WORLD_HALF && y >= WORLD_HALF) return 'meadow';
  return 'sanctum';
}

// Solid 2.5D obstacles (circular colliders for silky-smooth sliding movement)
export const OBSTACLES = [
  // Central courtyard gilded pillars (4 cardinal pillars around center)
  { id: 'c1', x: 1010, y: 1010, r: 30, kind: 'gilded_pillar' },
  { id: 'c2', x: 1390, y: 1010, r: 30, kind: 'gilded_pillar' },
  { id: 'c3', x: 1010, y: 1390, r: 30, kind: 'gilded_pillar' },
  { id: 'c4', x: 1390, y: 1390, r: 30, kind: 'gilded_pillar' },

  // NW — Moonlit Ruins
  { id: 'r1', x: 460, y: 420, r: 36, kind: 'ruin_pillar' },
  { id: 'r2', x: 680, y: 340, r: 28, kind: 'ruin_pillar' },
  { id: 'r3', x: 350, y: 720, r: 34, kind: 'ruin_pillar' },
  { id: 'r4', x: 760, y: 690, r: 38, kind: 'ruin_pillar' },
  { id: 'r5', x: 520, y: 940, r: 30, kind: 'ruin_pillar' },
  { id: 'r6', x: 930, y: 460, r: 32, kind: 'ruin_pillar' },

  // NE — Ember Forge
  { id: 'f1', x: 1660, y: 390, r: 36, kind: 'forge_rock' },
  { id: 'f2', x: 1960, y: 470, r: 40, kind: 'forge_rock' },
  { id: 'f3', x: 1580, y: 740, r: 32, kind: 'forge_rock' },
  { id: 'f4', x: 1920, y: 820, r: 38, kind: 'forge_rock' },
  { id: 'f5', x: 2140, y: 640, r: 34, kind: 'forge_rock' },
  { id: 'f6', x: 1740, y: 980, r: 28, kind: 'forge_rock' },

  // SW — Whispering Meadow
  { id: 'm1', x: 440, y: 1620, r: 36, kind: 'pine_tree' },
  { id: 'm2', x: 740, y: 1540, r: 34, kind: 'pine_tree' },
  { id: 'm3', x: 380, y: 1960, r: 38, kind: 'pine_tree' },
  { id: 'm4', x: 690, y: 1920, r: 36, kind: 'pine_tree' },
  { id: 'm5', x: 960, y: 1780, r: 32, kind: 'pine_tree' },
  { id: 'm6', x: 540, y: 2140, r: 34, kind: 'pine_tree' },

  // SE — Frost Sanctum
  { id: 's1', x: 1640, y: 1640, r: 36, kind: 'ice_crystal' },
  { id: 's2', x: 1980, y: 1580, r: 38, kind: 'ice_crystal' },
  { id: 's3', x: 1580, y: 1980, r: 32, kind: 'ice_crystal' },
  { id: 's4', x: 1920, y: 1940, r: 40, kind: 'ice_crystal' },
  { id: 's5', x: 2120, y: 1780, r: 30, kind: 'ice_crystal' },
  { id: 's6', x: 1780, y: 2140, r: 34, kind: 'ice_crystal' },
];

// Spawn points distributed around the open world
export const SPAWN_POINTS = [
  { x: 1200, y: 960 },
  { x: 1440, y: 1200 },
  { x: 1200, y: 1440 },
  { x: 960, y: 1200 },
  { x: 620, y: 580 },
  { x: 1780, y: 580 },
  { x: 620, y: 1780 },
  { x: 1780, y: 1780 },
  { x: 1200, y: 520 },
  { x: 1200, y: 1880 },
  { x: 520, y: 1200 },
  { x: 1880, y: 1200 },
];

// Contested Healing & Power Shrine pedestals (give strategic reason to roam the open world!)
export const SHRINE_SPOTS = [
  { id: 'shrine_center', x: 1200, y: 1200, heal: 28, respawn: 18 },
  { id: 'shrine_nw', x: 560, y: 560, heal: 24, respawn: 20 },
  { id: 'shrine_ne', x: 1840, y: 560, heal: 24, respawn: 20 },
  { id: 'shrine_sw', x: 560, y: 1840, heal: 24, respawn: 20 },
  { id: 'shrine_se', x: 1840, y: 1840, heal: 24, respawn: 20 },
];

// Destructible practice totems near the courtyard so solo players can test combos immediately
export const PRACTICE_TOTEM_SPOTS = [
  { id: 'totem_1', x: 1080, y: 1200, maxHp: 120 },
  { id: 'totem_2', x: 1320, y: 1200, maxHp: 120 },
];
