// Config maps + scoring helpers for matching inspiration decorations to library elements.
// These are the knobs — tune the lists/weights as real match results come in.

// decoration.type → candidate element_type names (the right category for this decoration).
// Used as a ranking BONUS (not a hard filter) so an imperfect map never drops a good match.
export const TYPE_MAP = {
  piping_border: ['Cream Piping'],
  rosette:       ['Cream Piping'],
  flower:        ['Cream Piping', 'Scattered Decor', 'Palette knife art'],
  topper:        ['Cake Topper', 'Image topper', 'Top&Side Decors'],
  figurine:      ['Cake Topper', 'Image topper'],
  ribbon_bow:    ['Cake Topper', 'Cream Piping'],
  sprinkles:     ['Scattered Decor', 'Faux Ball', 'Grouped elements'],
  pearls:        ['Scattered Decor', 'Faux Ball', 'Grouped elements'],
  macaron:       ['Picks', 'Scattered Decor'],
  fruit:         ['Picks', 'Scattered Decor'],
};

// Decoration types that are NOT library elements — cake-level properties or special features.
// (frosting base colour / board come from the cake summary, not the decorations list.)
export const NON_MATCHED_TYPES = new Set(['drip', 'lettering']);
export const isMatchable = (type) => !NON_MATCHED_TYPES.has(type);

// decoration.type → the placement mode it wants (compared to the element's placement_config[zone]).
export const MODE_MAP = {
  piping_border: 'hug', rosette: 'stand', flower: 'stand', topper: 'stand',
  figurine: 'stand', ribbon_bow: 'stand', sprinkles: 'faux_balls', pearls: 'faux_balls',
  macaron: 'stand', fruit: 'stand',
};

// Zone compatibility: decoration zone × an element's allowed zone → 0..1.
// Opposites (a top/rim decoration vs a board-only element) score ~0 ⇒ dropped by the floor.
export const ZONE_ADJACENCY = {
  top_surface: { top_surface: 1.0, rim: 0.7, side: 0.3, middle_tier: 0.2, board: 0.05 },
  rim:         { rim: 1.0, top_surface: 0.7, side: 0.6, middle_tier: 0.5, board: 0.4 },
  side:        { side: 1.0, middle_tier: 0.8, rim: 0.6, top_surface: 0.3, board: 0.3 },
  middle_tier: { middle_tier: 1.0, side: 0.8, rim: 0.5, board: 0.3, top_surface: 0.2 },
  board:       { board: 1.0, rim: 0.4, side: 0.3, middle_tier: 0.3, top_surface: 0.05 },
};

// allowed_zones may come back as an array (text[]) or a jsonb string — normalize to string[].
export function normalizeZones(z) {
  if (Array.isArray(z)) return z;
  if (typeof z === 'string') { try { const p = JSON.parse(z); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

// Best compat across an element's allowed zones (max), and which zone wins (where to place it).
export function zoneCompat(decoZone, allowedZones) {
  if (!decoZone) return 0.6;                  // unknown decoration zone → neutral
  if (!allowedZones.length) return 0.5;       // element with no zones → neutral, don't drop
  const row = ZONE_ADJACENCY[decoZone] || {};
  return Math.max(0, ...allowedZones.map(z => row[z] ?? (z === decoZone ? 1 : 0)));
}
export function bestZone(decoZone, allowedZones) {
  if (!allowedZones.length) return decoZone;
  const row = ZONE_ADJACENCY[decoZone] || {};
  let best = allowedZones[0], bv = -Infinity;
  for (const z of allowedZones) { const v = row[z] ?? (z === decoZone ? 1 : 0); if (v > bv) { bv = v; best = z; } }
  return best;
}

// How well the element's mode (at the chosen zone) fits the decoration kind.
export function modeCompat(decoType, placementConfig, zone) {
  const want = MODE_MAP[decoType];
  if (!want) return 0.7;
  const has = placementConfig?.[zone];
  if (!has || typeof has !== 'string') return 0.7;     // no mode info → neutral
  if (has === want) return 1.0;
  if (want === 'faux_balls' && /faux_ball/.test(has)) return 0.9;
  return 0.5;
}

// Colour proximity (0..1) via normalized RGB distance — a tiebreaker, not a gate.
function hexToRgb(h) {
  if (!h) return null;
  const m = String(h).replace('#', '').match(/^([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function colourProximity(a, b) {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  if (!ra || !rb) return 0.5;
  const d = Math.sqrt((ra[0] - rb[0]) ** 2 + (ra[1] - rb[1]) ** 2 + (ra[2] - rb[2]) ** 2);
  return 1 - Math.min(d / 441, 1);
}

// The semantic search query for a decoration (shape/technique keywords; colour scored separately).
export function decorationQueryText(d) {
  return [d.type, d.subtype, d.technique, d.material]
    .filter(Boolean).map(s => String(s).replace(/_/g, ' ')).join(', ');
}
