// Procedural floor generation, the 3D build-out, collision, fog-of-war and wild-Pokemon wander.
//
// IMPORTANT SHAPE NOTE: floors are OPEN ROOMS joined by WIDE (3-cell) CONNECTORS. They are
// deliberately NOT classic Mystery Dungeon single-tile hallways — free continuous movement needs
// room to breathe, and 1-tile corridors force exactly the grid-snapped feel this game avoids.
// Rooms are NOT all rectangles either — see ROOM_KINDS and buildRoomMask.
//
// The grid is an INTERNAL structure only. It exists for four things and nothing else:
//   1. generation, 2. item/Pokemon spawn placement, 3. minimap fog-of-war cells, 4. wall collision.
// Neither the player nor any wild Pokemon is ever snapped to it — positions are plain floats.
import * as THREE from 'three';
import {
  createMonObject, createBallObject, createModelObject, disposeObject,
  GIFT_BOX_MODEL, KECLEON_MODEL, COIN_MODEL_PATHS,
} from './models.js';
import { randomFieldItemId, randomBallId, randomCoinId, COIN_BY_ID } from './data/items.js';
import { CATALOG_BY_DEX, POKEMON_CATALOG, LEGENDARY_DEX } from './data/pokemon-catalog.js';
import { TYPE_COLOR } from './data/type-chart.js';
import { hemiLight, dirLight, scene } from './three-setup.js';
import { makeAura, spinAura } from './aura.js';

export const WALL = 0, FLOOR = 1, PROP = 2;   // collision grid values
const PLAYER_RADIUS = 0.34;

// ---- The two numbers the whole floor shape is built around -------------------------------------
//
// WALL_HEIGHT 0.5 — HALF a cell, where this used to be 2.4.
//
// The camera is an orthographic diagonal overhead at CAM_OFFSET (-11, 13, -11), an elevation of
// atan(13 / hypot(11, 11)) = 39.86 degrees. A wall of height h therefore hides h / tan(39.86) =
// 1.197 * h world units of ground behind it. At 2.4 that was 2.87 units: the player (0.85-1.15
// tall) vanished completely behind any wall within ~1.8 units, and so did items and wild Pokemon.
// At 0.5 it is 0.60 units, less than the height of anything that stands on the floor, so NOTHING
// is ever occluded. Walls now read as low carved rock rather than as slabs, which is why buildFloor
// caps every one of them in the theme's wallTop colour — uncapped, a half-height wall reads as
// floor trim rather than as something you cannot walk through.
export const WALL_HEIGHT = 0.5;

// SIGHT_RADIUS 4.5 — no floor cell may be further than this from something solid.
//
// This constraint is what lets the camera stay where it is while floors get five times bigger.
// FRUSTUM_SIZE is still 10, so on a phone (aspect ~0.46) the visible ground window is +-10*0.46 =
// 4.6 units along its NARROW screen axis and +-10/sin(39.86) = 15.6 along the other. The narrow
// axis is screen-RIGHT, which on the ground is the world direction (-1, 0, +1)/sqrt(2): a solid
// cell at world offset (dx, dz) is inside the window when |(-dx + dz)/sqrt(2)| <= 4.6. The worst
// case is a solid cell lying exactly along that axis, which projects to its full distance — so any
// solid within 4.6 units is on screen whatever direction it lies in, and 4.5 puts it at ~69% of
// the way to the edge rather than on the rim. Allowing for the player standing at a cell corner
// (0.71 off centre) the true worst case is 5.21 units, still inside.
//
// generateFloor enforces it by construction, in scatterOutcrops(). The payoff is that you can
// never be stranded in a field of identical floor tiles with nothing to take a bearing from, which
// is the failure mode a floor this size would otherwise have.
const SIGHT_RADIUS = 4.5;

// Every floor hands out at least this many Poke Balls across its ball pickups (1-5 per pickup).
const BALLS_PER_FLOOR = 15;

// ---- The stair pit ------------------------------------------------------------------------------
// The up-stairs is a stairwell cut DOWN into the floor (see makeStairs), so unlike every other
// fixture it is not something standing on the ground — it is a hole in it. That hole is a
// (2*STAIR_PIT_R+1)-cell square centred on floor.stairsCell, and three passes have to agree on it:
//
//   buildFloor   omits the floor tiles inside it, or they would hang in mid-air across the well.
//   generateFloor carves the square to FLOOR, so no rock outcrop can grow into the stairwell.
//   freeCell     refuses to put a pickup inside it, since there is no floor there to put one on.
//
// 1 (a 3x3 cell square, 3 world units across) is the largest that still fits inside the 3-cell
// keep-clear radius the props and rock already respect around the stairs.
const STAIR_PIT_R = 1;

// Chance that any one wild spawn is a Legendary instead of a draw from the floor's pool. The full
// reasoning is at the spawn loop in generateFloor; the number itself is per SPAWN, not per floor,
// and a run rolls it about 100 times.
const LEGENDARY_WILD_CHANCE = 0.01;

// ---- The eleven floor themes (design brief §10, plus a beach) -----------------------------------
// `types` drives which species can spawn as wild Pokemon on that floor. Colors are all we have to
// build atmosphere with: there are no themed environment assets, so every floor is Three.js
// primitives tinted per theme with light prop dressing.
//
// Between them these lists have to COVER all eighteen types, and that is a hard requirement rather
// than a nicety: the wild pool below is `themed` unless it comes up short, so a type named by no
// theme belongs to no floor, and every species carrying only such types is uncatchable. Four types
// have no theme of their own — there is no sky, dojo, plain or dragon's den in the brief's ten —
// so they are lodged with their nearest neighbour: Fighting in the Rocky Cavern, Dragon in the
// Molten Caldera and the Frozen Grotto (a fire-and-ice pair of dens, and it thickens the thinnest
// pool in the set), Flying and Normal on the Sunlit Shore, whose gulls and ordinary shoreline
// critters are the closest thing to open country the dungeon has. Before that, the Pidgey, Rattata,
// Meowth, Machop and Dratini lines reached a floor ONLY through the `themed.length >= 6` fallback,
// which only ever fired on the Ice floor — so they were catchable in roughly one run in five, by
// accident. Add a type here whenever a species would otherwise have nowhere to stand.
export const THEMES = [
  { id: 'verdant',  name: 'Verdant Forest',  types: ['Grass', 'Bug'],
    floorA: 0x4e7a3a, floorB: 0x456f33, wall: 0x2f4a25, wallTop: 0x3d5f2e,
    fog: 0x16240f, sky: 0xbfe0a0, ground: 0x2d4020, light: 0xfff3d0, prop: 'tree' },
  { id: 'rocky',    name: 'Rocky Cavern',    types: ['Rock', 'Ground', 'Fighting'],
    floorA: 0x6d6152, floorB: 0x625748, wall: 0x413a32, wallTop: 0x554c41,
    fog: 0x1d1a16, sky: 0x9d9384, ground: 0x3a342c, light: 0xffeecc, prop: 'boulder' },
  { id: 'molten',   name: 'Molten Caldera',  types: ['Fire', 'Dragon'],
    floorA: 0x59322a, floorB: 0x4d2a23, wall: 0x331914, wallTop: 0x6b2f1f,
    fog: 0x1c0906, sky: 0xff9a4a, ground: 0x4a1a10, light: 0xffd0a0, prop: 'lava' },
  { id: 'frozen',   name: 'Frozen Grotto',   types: ['Ice', 'Dragon'],
    floorA: 0x9fc4d8, floorB: 0x92b9d0, wall: 0x5f8298, wallTop: 0x7ea6bd,
    fog: 0x2b4453, sky: 0xdff2ff, ground: 0x5a7d92, light: 0xeaf6ff, prop: 'icespike' },
  { id: 'tidepool', name: 'Tidepool Grotto', types: ['Water'],
    floorA: 0x3f6f7d, floorB: 0x386573, wall: 0x24454f, wallTop: 0x2f5b67,
    fog: 0x0e2229, sky: 0x8fd2e0, ground: 0x1f3d46, light: 0xdff6ff, prop: 'tidepool' },
  { id: 'haunted',  name: 'Haunted Ruins',   types: ['Ghost', 'Psychic'],
    floorA: 0x4a4260, floorB: 0x413a55, wall: 0x2b2540, wallTop: 0x3a3252,
    fog: 0x140f1f, sky: 0x6e5b8f, ground: 0x282040, light: 0xd8c8ff, prop: 'pillar' },
  { id: 'warehouse', name: 'Rocket Warehouse', types: ['Electric', 'Steel', 'Poison'],
    floorA: 0x4b4e55, floorB: 0x43464d, wall: 0x2c2f35, wallTop: 0x8a1f1f,
    fog: 0x15171a, sky: 0x7c8290, ground: 0x2a2d33, light: 0xf2f6ff, prop: 'crate' },
  { id: 'desert',   name: 'Scorched Desert', types: ['Ground', 'Dark'],
    floorA: 0x9c8455, floorB: 0x8f784c, wall: 0x6a5735, wallTop: 0x7d6941,
    fog: 0x2e2517, sky: 0xf0d79a, ground: 0x5c4c2e, light: 0xfff0c0, prop: 'cactus' },
  { id: 'swamp',    name: 'Toxic Swamp',     types: ['Poison'],
    floorA: 0x4a5a34, floorB: 0x42512e, wall: 0x2e3a20, wallTop: 0x53357a,
    fog: 0x141a0d, sky: 0x9fbf6a, ground: 0x2b3520, light: 0xe6ffc0, prop: 'sludge' },
  { id: 'crystal',  name: 'Crystal Caverns', types: ['Fairy', 'Rock'],
    floorA: 0x5c4f6b, floorB: 0x53475f, wall: 0x392f47, wallTop: 0x8f6fb0,
    fog: 0x1a1322, sky: 0xd9b8ef, ground: 0x33283f, light: 0xf6e6ff, prop: 'crystal' },
  { id: 'beach',    name: 'Sunlit Shore',    types: ['Water', 'Ground', 'Flying', 'Normal'],
    floorA: 0xe0cb95, floorB: 0xd3bd85, wall: 0x9c7f4f, wallTop: 0x3f9fbf,
    fog: 0x2a4a55, sky: 0xbfe9ff, ground: 0x6b5a34, light: 0xfff4d8, prop: 'palm' },
];

export const THEME_BY_ID = new Map(THEMES.map(t => [t.id, t]));

// Pick 5 distinct themes for a run (no repeats), in a random order. Classic mode only — Endless
// runs past the end of the theme list and uses pickEndlessCycle below.
export function pickRunThemes(count = 5) {
  const pool = THEMES.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

// ---- Endless mode's theme sequence -------------------------------------------------------------
// Two rules, and the second is the one that needs the work:
//
//   1. EVERY theme is visited once before any of them comes back. So the sequence is built in
//      CYCLES of all eleven, shuffled per cycle — not eleven independent rolls, which would happily
//      give you the Verdant Forest three times in fifteen floors and never show you the beach.
//   2. No theme appears within ENDLESS_MIN_GAP floors of itself. Inside one cycle that is free;
//      rule 1 already spaces repeats eleven floors apart. It is the SEAM between two cycles that
//      can break it — a theme last in cycle N and first in cycle N+1 is one floor apart — so the
//      head of each new cycle is drawn knowing the tail of the one before it.
//
// The gap is stated the way the design does: "if you have the forest on floor 20 you cannot see it
// again until at least floor 25", i.e. floor numbers must differ by 5 or more, i.e. at least four
// other floors in between.
export const ENDLESS_MIN_GAP = 5;

// `recentIds[0]` is the theme on the floor just played, `[1]` the one before that, and so on —
// most recent FIRST, which is what makes the distance arithmetic below read directly.
//
// Slots are filled left to right, each from the themes still unused that are legal at that slot.
// A theme `d` floors back and one placed at slot `i` end up `d + i` floors apart, so slot `i`
// blocks the `ENDLESS_MIN_GAP - 1 - i` most recent themes and nothing else. By slot 4 the blocked
// list is empty and the rest of the cycle is a plain shuffle.
//
// It cannot deadlock: at slot `i` there are `THEMES.length - i` themes left and at most 4 blocked,
// so with eleven themes the pool is non-empty at every slot that has any blocking at all. The
// fallback below is unreachable insurance, kept because a future edit that shortened THEMES to
// four or fewer would otherwise hang the game rather than repeat a floor.
export function pickEndlessCycle(recentIds = []) {
  const remaining = THEMES.slice();
  const cycle = [];
  for (let i = 0; i < THEMES.length; i++) {
    const blockDepth = Math.max(0, ENDLESS_MIN_GAP - 1 - i);
    const blocked = new Set(recentIds.slice(0, blockDepth));
    let pool = remaining.filter(t => !blocked.has(t.id));
    if (!pool.length) pool = remaining;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    cycle.push(chosen);
    remaining.splice(remaining.indexOf(chosen), 1);
  }
  return cycle;
}

const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- Which floors carry Kecleon's stall --------------------------------------------------------
// Floor 4 ALWAYS has one. Every other floor rolls for it, with one rule: two RANDOM stalls can
// never land on consecutive floors, so seeing him on floor 1 means the earliest he can turn up
// again is floor 3. The guaranteed floor-4 stall is exempt from that rule in both directions — it
// neither blocks nor is blocked — so a floor-3 stall does not cancel it and it does not stop him
// appearing again on floor 5.
export function pickShopFloors(total = 5, guaranteed = 4, chance = 0.35) {
  const shops = new Set([guaranteed]);
  let lastRandom = -10;
  for (let f = 1; f <= total; f++) {
    if (f === guaranteed) continue;
    if (f - lastRandom < 2) continue;
    if (Math.random() < chance) { shops.add(f); lastRandom = f; }
  }
  return shops;
}

// Endless cannot precompute that set — there is no `total` to loop to — so it rolls ONE floor at a
// time and the run carries the `lastRandom` the loop above kept in a local. Same two rules, same
// 0.35, and the same exemption: the guaranteed stall neither blocks a later random one nor is
// blocked by an earlier one.
//
// Which floor is guaranteed differs, and follows the design: Kecleon is on every floor BEFORE
// Giovanni, so on floor 4, 9, 14, 19... — the floor whose next one is a boss floor. That is the
// stall that matters most in Endless, since it is the last chance to spend coins and top up balls
// before the hardest fight in the mode, and unlike classic's floor-4 stall it recurs forever.
//
// Returns `{ shop, lastRandom }` rather than mutating, so the caller decides whether the roll
// counts — the run stores `lastRandom` back only when a floor is actually entered.
export function rollEndlessShop(floorNumber, lastRandom = -10, bossEvery = 5, chance = 0.35) {
  if (isEndlessShopGuaranteed(floorNumber, bossEvery)) return { shop: true, lastRandom };
  if (floorNumber - lastRandom < 2) return { shop: false, lastRandom };
  if (Math.random() < chance) return { shop: true, lastRandom: floorNumber };
  return { shop: false, lastRandom };
}

// The floor immediately before a boss floor. Boss floors are the multiples of `bossEvery`, so this
// is every floor one short of one — and floor 0 does not exist, so `bossEvery - 1` is the first.
export function isEndlessShopGuaranteed(floorNumber, bossEvery = 5) {
  return (floorNumber + 1) % bossEvery === 0;
}

// ---- Room shapes -------------------------------------------------------------------------------
// "Not all rectangles or squares": every room is one of these archetypes, drawn as a mask inside
// its own bounding box. All of them are inherently 4-connected except `cavern`, which is reduced
// to its largest component — a room in two halves would be carved as one room and connected as
// one, and half of it would be unreachable.
const ROOM_KINDS = ['rect', 'ell', 'tee', 'cross', 'ellipse', 'diamond', 'cavern', 'hall'];

function buildRoomMask(w, h, kind) {
  const m = new Uint8Array(w * h);
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) m[y * w + x] = 1; };
  const fill = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) set(x, y);
    }
  };
  switch (kind) {
    case 'rect':
      fill(0, 0, w - 1, h - 1);
      break;
    case 'ell': {
      // Two overlapping rectangles sharing one corner. The arm thicknesses are independent so the
      // two legs are different widths.
      const aw = rndInt(Math.ceil(w * 0.45), w - 2), ah = rndInt(Math.ceil(h * 0.45), h - 2);
      fill(0, 0, aw, h - 1);
      fill(0, h - 1 - ah, w - 1, h - 1);
      break;
    }
    case 'tee': {
      const stem = rndInt(Math.ceil(w * 0.35), Math.ceil(w * 0.6));
      const bar = rndInt(Math.ceil(h * 0.3), Math.ceil(h * 0.5));
      const off = Math.floor((w - stem) / 2);
      fill(0, 0, w - 1, bar);                    // the bar across the top
      fill(off, 0, off + stem, h - 1);           // the stem down the middle
      break;
    }
    case 'cross': {
      const armW = rndInt(Math.ceil(w * 0.35), Math.ceil(w * 0.6));
      const armH = rndInt(Math.ceil(h * 0.35), Math.ceil(h * 0.6));
      fill(Math.floor((w - armW) / 2), 0, Math.floor((w - armW) / 2) + armW, h - 1);
      fill(0, Math.floor((h - armH) / 2), w - 1, Math.floor((h - armH) / 2) + armH);
      break;
    }
    case 'ellipse': {
      const a = (w - 1) / 2, b = (h - 1) / 2;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const u = (x - a) / (a + 0.5), v = (y - b) / (b + 0.5);
        if (u * u + v * v <= 1) set(x, y);
      }
      break;
    }
    case 'diamond': {
      const a = (w - 1) / 2, b = (h - 1) / 2;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (Math.abs(x - a) / (a + 0.5) + Math.abs(y - b) / (b + 0.5) <= 1) set(x, y);
      }
      break;
    }
    case 'hall': {
      // A long room with alcoves bitten out of its long sides, so the walls step in and out.
      fill(0, 0, w - 1, h - 1);
      const notches = rndInt(2, 4);
      for (let i = 0; i < notches; i++) {
        const nw = rndInt(2, Math.max(2, Math.floor(w * 0.22)));
        const nh = rndInt(2, Math.max(2, Math.floor(h * 0.3)));
        const nx = rndInt(1, Math.max(1, w - nw - 1));
        const top = Math.random() < 0.5;
        for (let y = 0; y < nh; y++) for (let x = nx; x < nx + nw; x++) {
          const yy = top ? y : h - 1 - y;
          if (x < w && yy >= 0 && yy < h) m[yy * w + x] = 0;
        }
      }
      break;
    }
    default: {   // 'cavern' — an organic blob: noise, smoothed, then largest component only.
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        // Seeded from an ellipse so the blob has a body rather than being pure static, then
        // pushed toward solid near the edges so it never touches its own bounding box.
        const a = (w - 1) / 2, b = (h - 1) / 2;
        const u = (x - a) / (a + 0.5), v = (y - b) / (b + 0.5);
        const r = Math.sqrt(u * u + v * v);
        if (Math.random() < 1.05 - r * 0.95) set(x, y);
      }
      for (let pass = 0; pass < 4; pass++) {
        const next = m.slice();
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;   // outside counts as solid
            n += m[ny * w + nx];
          }
          next[y * w + x] = n >= 5 ? 1 : n <= 2 ? 0 : m[y * w + x];
        }
        m.set(next);
      }
      keepLargestComponent(m, w, h);
      break;
    }
  }
  return m;
}

// Flood-fills every open component of a mask and blanks all but the biggest one.
function keepLargestComponent(m, w, h) {
  const seen = new Uint8Array(w * h);
  let best = null, bestLen = 0;
  const stack = [];
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || seen[i]) continue;
    const comp = [];
    stack.length = 0; stack.push(i); seen[i] = 1;
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      const x = c % w, y = (c - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!m[ni] || seen[ni]) continue;
        seen[ni] = 1; stack.push(ni);
      }
    }
    if (comp.length > bestLen) { bestLen = comp.length; best = comp; }
  }
  m.fill(0);
  if (best) for (const i of best) m[i] = 1;
}

// ---- Generation --------------------------------------------------------------------------------
// Floors grow with depth (design brief §4: "bigger layouts") and are FIVE TIMES the area they used
// to be. The old side lengths were 30 + 5 * floor (35 to 55); multiplying by sqrt(5) gives 78, 89,
// 101, 112, 123, each within 1% of exactly 5x the old cell count.
//
// Nothing about the old generator survived that scale-up unchanged:
//   - room COUNT and SIZE both went up, and rooms stopped being rectangles (buildRoomMask)
//   - rooms are chained along a minimum spanning tree instead of in generation order, because a
//     random order on a 123-cell floor means corridors that cross the whole map to reach a
//     neighbour two rooms away
//   - a flood fill VERIFIES connectivity rather than trusting the chain, which a non-convex room
//     shape can break
//   - the landmark pass (scatterOutcrops) enforces SIGHT_RADIUS, which is what keeps the camera
//     where it is
export function generateFloor(floorNumber, theme, { shop = false, chansey = false } = {}) {
  // sqrt(5) per side is exactly 5x the area: 78, 89, 101, 112, 123 against the old 35..55.
  const W = Math.round((30 + floorNumber * 5) * Math.sqrt(5));
  const H = W;
  const cells = new Uint8Array(W * H);            // WALL by default
  const at = (x, y) => y * W + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const cellAt = (x, y) => (inBounds(x, y) ? cells[at(x, y)] : WALL);

  // 1. Rooms: rejection-sample non-overlapping bounding boxes with a 2-cell gap so walls stay
  //    solid, then stamp a shape mask into each one.
  const rooms = [];
  const targetRooms = 7 + floorNumber;
  const loSize = 11 + floorNumber, hiSize = Math.round(18 + floorNumber * 1.6);
  for (let tries = 0; tries < 1200 && rooms.length < targetRooms; tries++) {
    const w = rndInt(loSize, hiSize), h = rndInt(loSize, hiSize);
    const x = rndInt(2, W - w - 3), y = rndInt(2, H - h - 3);
    if (x < 2 || y < 2) continue;
    const clash = rooms.some(o =>
      x - 2 < o.x + o.w && x + w + 2 > o.x && y - 2 < o.y + o.h && y + h + 2 > o.y);
    if (clash) continue;
    const kind = pick(ROOM_KINDS);
    const mask = buildRoomMask(w, h, kind);
    const roomCells = [];
    let sx = 0, sy = 0;
    for (let my = 0; my < h; my++) for (let mx = 0; mx < w; mx++) {
      if (!mask[my * w + mx]) continue;
      roomCells.push(at(x + mx, y + my));
      sx += x + mx; sy += y + my;
    }
    // A mask can come out too thin to be a room (a badly-notched hall, a small cavern).
    if (roomCells.length < 40) continue;
    for (const i of roomCells) cells[i] = FLOOR;
    // The ANCHOR is a real floor cell near the centroid, never the bounding box's middle: for an
    // L, a cross or a cavern the box centre is often solid, and every consumer (connectors, the
    // start and stairs tiles, the shop) needs a cell it can actually stand on.
    const gx = Math.round(sx / roomCells.length), gy = Math.round(sy / roomCells.length);
    let anchor = roomCells[0], bestD = Infinity;
    for (const i of roomCells) {
      const ix = i % W, iy = (i - ix) / W;
      const d = (ix - gx) ** 2 + (iy - gy) ** 2;
      if (d < bestD) { bestD = d; anchor = i; }
    }
    rooms.push({
      x, y, w, h, kind, cells: roomCells,
      cx: anchor % W, cy: (anchor - (anchor % W)) / W,
    });
  }

  // 2. Connectors, 3 cells wide, along a minimum spanning tree over the room anchors plus a few
  //    extra short links so a layout is a graph rather than a pure tree.
  const carveWide = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx > 0 && ny > 0 && nx < W - 1 && ny < H - 1) cells[at(nx, ny)] = FLOOR;
    }
  };
  const connect = (a, b) => {
    // L-shaped, with the corner order randomised so the floor doesn't read as a grid of Ls.
    const horizFirst = Math.random() < 0.5;
    const [x0, y0, x1, y1] = [a.cx, a.cy, b.cx, b.cy];
    if (horizFirst) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) carveWide(x, y0);
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) carveWide(x1, y);
    } else {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) carveWide(x0, y);
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) carveWide(x, y1);
    }
  };
  const dist2 = (a, b) => (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2;
  if (rooms.length > 1) {
    // Prim's, O(n^2) over at most twelve rooms.
    const inTree = [rooms[0]], rest = rooms.slice(1);
    while (rest.length) {
      let bi = 0, ba = inTree[0], bd = Infinity;
      rest.forEach((r, i) => {
        for (const t of inTree) {
          const d = dist2(r, t);
          if (d < bd) { bd = d; bi = i; ba = t; }
        }
      });
      const [next] = rest.splice(bi, 1);
      connect(ba, next);
      inTree.push(next);
    }
    // Extra links: the shortest pairs that the tree did not already use, which reliably produces
    // a loop or two rather than the dead-end-heavy layouts a random pair draw gave.
    const pairs = [];
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) pairs.push([dist2(rooms[i], rooms[j]), i, j]);
    }
    pairs.sort((p, q) => p[0] - q[0]);
    let extra = Math.min(3, Math.max(1, Math.floor(rooms.length / 4)));
    for (const [, i, j] of pairs) {
      if (extra <= 0) break;
      if (Math.random() < 0.5) continue;          // so it is not always the same shortest pairs
      connect(rooms[i], rooms[j]);
      extra--;
    }
  }

  // 3. Start and stairs go in the two furthest-apart rooms, so no floor is a two-step walk.
  let startRoom = rooms[0], stairsRoom = rooms[rooms.length - 1], best = -1;
  for (const a of rooms) for (const b of rooms) {
    const d = dist2(a, b);
    if (d > best) { best = d; startRoom = a; stairsRoom = b; }
  }
  const startCell = { x: startRoom.cx, y: startRoom.cy };
  const stairsCell = { x: stairsRoom.cx, y: stairsRoom.cy };

  // The stairwell's pit is carved open before anything else can claim those cells. The stairs sit
  // at a room's CENTRE so in practice the square is already clear floor, but the stairwell is a
  // solid 3x3 object and one outcrop or notch growing into it would have rock standing in the well
  // — so the invariant is asserted here rather than hoped for. See STAIR_PIT_R.
  for (let dy = -STAIR_PIT_R; dy <= STAIR_PIT_R; dy++) {
    for (let dx = -STAIR_PIT_R; dx <= STAIR_PIT_R; dx++) {
      const x = stairsCell.x + dx, y = stairsCell.y + dy;
      if (inBounds(x, y)) cells[at(x, y)] = FLOOR;
    }
  }

  // 4. VERIFY connectivity rather than assuming it. The spanning tree connects room ANCHORS, and
  //    a 3-wide corridor from an anchor always reaches the rest of its own room for the convex
  //    shapes — but a cavern or a heavily notched hall can have a lobe the corridor never touches,
  //    and anything unreachable is an item or a Pokemon the player can never get to. Whatever is
  //    not reachable from the start tile is filled back in as solid rock.
  {
    const reach = new Uint8Array(W * H);
    const stack = [at(startCell.x, startCell.y)];
    reach[stack[0]] = 1;
    while (stack.length) {
      const c = stack.pop();
      const x = c % W, y = (c - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const ni = at(nx, ny);
        if (reach[ni] || cells[ni] !== FLOOR) continue;
        reach[ni] = 1; stack.push(ni);
      }
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === FLOOR && !reach[i]) cells[i] = WALL;
    for (const r of rooms) r.cells = r.cells.filter(i => cells[i] === FLOOR);
  }

  const floor = {
    number: floorNumber, theme, W, H, cells, rooms, startCell, stairsCell,
    visited: new Uint8Array(W * H),
    mapRevealed: false,          // Town Map
    entitiesRevealed: false,     // Dowsing Machine
    items: [], wilds: [], props: [], outcrops: [],
    shop: null,
    boss: null,
    group: null,
    cleared: false,
    // Cells newly revealed since the map last repainted. drawMap keeps a 1px-per-cell terrain
    // canvas and only touches what is in here, because repainting 15129 cells every frame is not
    // something a phone will do at 60 fps.
    mapDirty: [],
    mapCache: null,
  };

  // 5. Kecleon's stall, BEFORE props and pickups so it can claim its patch of floor first.
  if (shop) floor.shop = placeShop(floor, startRoom, stairsRoom);
  // Chansey goes down AFTER the stall, because placeChansey reads floor.shop to keep clear of it.
  if (chansey) floor.chansey = placeChansey(floor, startRoom, stairsRoom);

  // 6. The landmark pass. This is what enforces SIGHT_RADIUS.
  scatterOutcrops(floor);

  // 7. Props. Only interior cells (every 8-neighbour is floor) are eligible, which guarantees
  //    blocking one can never split the floor in two — it is always a pillar inside open space.
  const isInterior = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (cellAt(x + dx, y + dy) !== FLOOR) return false;
    }
    return true;
  };
  const farFrom = (c, x, y, d) => !c || Math.abs(c.x - x) > d || Math.abs(c.y - y) > d;
  const clearOfFixtures = (x, y) =>
    farFrom(startCell, x, y, 3) && farFrom(stairsCell, x, y, 3)
    && (!floor.shop || Math.abs(floor.shop.cx - x) > 4 || Math.abs(floor.shop.cy - y) > 4)
    && (!floor.chansey || Math.abs(floor.chansey.cx - x) > CHANSEY_HALF + 1
        || Math.abs(floor.chansey.cy - y) > CHANSEY_HALF + 1);
  const propTarget = 18 + floorNumber * 8;
  // Props are biased to stand NEXT TO an outcrop. An outcrop is only half a cell tall, so on its
  // own it is a landmark you can see over rather than one you can see; a tree or a crystal on its
  // shoulder is the part that actually catches the eye from across a room.
  const outcropEdges = [];
  for (const o of floor.outcrops) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = o.x + dx, ny = o.y + dy;
      if (isInterior(nx, ny) && clearOfFixtures(nx, ny)) outcropEdges.push({ x: nx, y: ny });
    }
  }
  for (let tries = 0; tries < propTarget * 40 && floor.props.length < propTarget; tries++) {
    let x, y;
    if (outcropEdges.length && Math.random() < 0.6) {
      const e = outcropEdges.splice(Math.floor(Math.random() * outcropEdges.length), 1)[0];
      x = e.x; y = e.y;
    } else {
      x = rndInt(2, W - 3); y = rndInt(2, H - 3);
    }
    if (!isInterior(x, y) || !clearOfFixtures(x, y)) continue;
    cells[at(x, y)] = PROP;
    floor.props.push({ x, y, rot: rnd(0, Math.PI * 2), scale: rnd(0.85, 1.25) });
  }

  // 8. Pickup and wild-Pokemon spawn points, on free floor cells away from the start.
  //    Drawn from a room's own CELL LIST, not from its bounding box: an L-shaped or cavern room's
  //    box is mostly solid, so a box draw would reject far more often than it succeeds and the
  //    floor would come out with a fraction of the pickups it asked for.
  const taken = new Set();
  const freeCell = (minDistFromStart = 5) => {
    for (let tries = 0; tries < 400; tries++) {
      const r = pick(rooms);
      if (!r.cells.length) continue;
      const i = pick(r.cells);
      if (cells[i] !== FLOOR || taken.has(i)) continue;
      const x = i % W, y = (i - x) / W;
      if (Math.hypot(x - startCell.x, y - startCell.y) < minDistFromStart) continue;
      // The whole STAIR_PIT_R footprint, not just the stairs tile. The up-stairs is a recessed
      // stairwell now and buildFloor leaves a hole in the floor for it, so a pickup one cell off
      // the stairs would be hovering over open air (and be unreachable, since walking that close
      // triggers the ascent).
      if (Math.abs(x - stairsCell.x) <= STAIR_PIT_R && Math.abs(y - stairsCell.y) <= STAIR_PIT_R) continue;
      if (floor.shop && Math.abs(floor.shop.cx - x) <= 3 && Math.abs(floor.shop.cy - y) <= 3) continue;
      if (floor.chansey && Math.abs(floor.chansey.cx - x) <= CHANSEY_HALF
        && Math.abs(floor.chansey.cy - y) <= CHANSEY_HALF) continue;
      taken.add(i);
      return { x, y };
    }
    return null;
  };

  const addPickup = (entry) => {
    const c = freeCell(4);
    if (c) floor.items.push({ x: c.x, y: c.y, taken: false, obj: null, bob: rnd(0, 6.28), ...entry });
  };

  // Field items, as wrapped presents. Balls are deliberately NOT in this draw — see below.
  const itemCount = 10 + floorNumber * 3;
  for (let i = 0; i < itemCount; i++) addPickup({ kind: 'item', itemId: randomFieldItemId(), qty: 1 });

  // Poke Balls, GUARANTEED to total at least BALLS_PER_FLOOR across the floor. Each pickup holds
  // 1-5 balls of one type, so the pass keeps placing until the running total clears the floor's
  // quota — which is why randomFieldItemId() above excludes balls entirely. Placement can run out
  // of free cells on a cramped layout, so the loop is also bounded.
  //
  // randomBallId() can also come back with a Master Ball (MASTER_BALL_CHANCE, see items.js). That
  // one is pinned to a single ball rather than the usual 1-5: a marker holding five guaranteed
  // catches is not a rare find, it is the rest of the run. It still counts toward the quota, so
  // finding one costs the floor an ordinary ball and nothing more.
  let ballTotal = 0;
  for (let guard = 0; ballTotal < BALLS_PER_FLOOR && guard < 40; guard++) {
    const itemId = randomBallId();
    const qty = itemId === 'master-ball'
      ? 1
      : Math.min(rndInt(1, 5), BALLS_PER_FLOOR * 2 - ballTotal);
    const before = floor.items.length;
    addPickup({ kind: 'ball', itemId, qty });
    if (floor.items.length === before) break;      // nowhere left to put one
    ballTotal += qty;
  }
  floor.ballTotal = ballTotal;

  // Coins. The economy these feed is documented next to COINS in js/data/items.js.
  const coinCount = 7 + floorNumber * 2;
  for (let i = 0; i < coinCount; i++) {
    const coinId = randomCoinId();
    addPickup({ kind: 'coin', coinId, qty: 1 });
  }

  // Wild pool: species whose typing matches the theme, so a Frozen Grotto reads as an ice floor.
  //
  // Gated by evolution stage on top of that, and this gate is load-bearing rather than flavour:
  // damage is stage-only, so a Stage 1 wild (50 HP, 10 dmg) against a lone Basic starter (30 HP,
  // 5 dmg) is not a hard fight, it is an arithmetically impossible one — and aggressive wilds
  // chase, so it cannot even be walked away from. Floors 1-2 are therefore Basic-only, which is
  // what "stays forgiving early on" (design brief §4) has to mean in practice.
  //
  // Legendaries sit OUTSIDE both gates — see LEGENDARY_WILD_CHANCE below.
  const allowedStages = floorNumber <= 2 ? ['Basic']
    : floorNumber === 3 ? ['Basic', 'Stage1']
    : ['Stage1', 'Stage2'];
  const inStage = POKEMON_CATALOG.filter(p => allowedStages.includes(p.stage));
  const themed = inStage.filter(p => p.types.some(t => theme.types.includes(t)));
  const wildPool = themed.length >= 6 ? themed : inStage;
  // Doubled from 4 + floor * 2 for the five-times-bigger floors, and deliberately NOT scaled by
  // the full factor. Matching the old DENSITY would mean about ninety wild Pokemon on floor 5, and
  // each one is a loaded Quest model with its own meshes — that is a draw-call budget spent on
  // Pokemon standing in rooms the player will never visit. At 12-28 a floor the encounter rate is
  // about a third of what it was, which is what makes a floor this size read as somewhere to
  // explore rather than somewhere to fight your way across; aggressive wilds still chase, so the
  // ones that matter come to you.
  const wildCount = 8 + floorNumber * 4;
  const aggroChance = 0.2 + floorNumber * 0.08;   // ramps with depth, forgiving on floors 1-2
  for (let i = 0; i < wildCount; i++) {
    const c = freeCell(6);
    if (!c) continue;
    // Every spawn rolls for a Legendary first, and one in a hundred becomes one instead of drawing
    // from the pool. This is the ONLY way a Legendary can be caught: they are otherwise Giovanni's
    // alone, which left 46 of the catalog's 386 species permanently unobtainable and a hole in the
    // Questdex that nothing could fill. The roll ignores the theme and the stage gate both — a
    // Legendary belongs to no floor's typing, and gating it by depth would mean the rarest thing in
    // the game could only appear where the player is already strong.
    //
    // A floor scatters 12-28 wilds, so a full five-floor run rolls 100 times: one Legendary per run
    // in expectation, and about a 63% chance of meeting at least one. Rare enough to be an event,
    // common enough that a player who finishes runs will see them.
    const legendary = Math.random() < LEGENDARY_WILD_CHANCE;
    const species = legendary ? CATALOG_BY_DEX.get(pick(LEGENDARY_DEX)) : pick(wildPool);
    floor.wilds.push({
      dex: species.dex,
      // A Legendary is NEVER aggressive, and this is the same arithmetic that gates the stage pool
      // above rather than a separate decision. An aggressive wild forces a battle before the catch
      // minigame opens and re-homes onto the player every frame, so it cannot be walked away from;
      // a Legendary brings 90 HP and 20 damage, which even at the floor-1 wild scale of 0.6 is 54
      // HP against a lone 30 HP starter dealing 5. That is not a hard fight, it is a run ended by
      // a 1-in-100 coin flip. Peaceful, it is what it should be: something you walk up to, with
      // the whole encounter riding on the balls in your bag and the throw.
      aggressive: legendary ? false : Math.random() < aggroChance,
      legendary,
      homeX: c.x, homeY: c.y,
      x: c.x - W / 2 + 0.5, z: c.y - H / 2 + 0.5,
      dirX: 0, dirZ: 0, retarget: 0,
      obj: null, aura: null, defeated: false, gone: false,
    });
  }

  return floor;
}

// ---- The landmark pass -------------------------------------------------------------------------
// Guarantees the SIGHT_RADIUS invariant: after this runs, every open cell on the floor has
// something solid within SIGHT_RADIUS of it, so whatever the player is standing on there is always
// a wall or an outcrop inside the camera's narrow screen axis. That is the whole reason floors can
// be five times bigger without the camera zooming out.
//
// It works as a COVERING problem rather than an iterative one. A naive "place a rock at the worst
// point, recompute distances, repeat" needs a full distance transform per placement, which on
// floor 5 is 15129 cells times ~100 placements. Instead:
//   1. compute the exact-ish distance to the nearest solid cell once (Danielsson, two raster
//      passes propagating the nearest SEED COORDINATES rather than a chamfer approximation, so
//      diagonal distances do not accumulate error),
//   2. take every cell further than SIGHT_RADIUS, worst first,
//   3. for each one still uncovered, drop an outcrop there and mark everything within
//      SIGHT_RADIUS of it covered.
// Any cell that started inside the radius already had a wall; any cell that did not is now within
// SIGHT_RADIUS of an outcrop. Both halves of the invariant hold, in one pass.
//
// Outcrops are WALL cells, not props: they join the single wall InstancedMesh, so a hundred of
// them cost zero extra draw calls. Since every candidate is by definition more than 4.5 units from
// anything solid, a 1x1 to 2x3 block dropped on it is entirely surrounded by open floor and can
// always be walked around — but generateFloor's flood fill has already run by then, so
// connectivity is re-checked here and any outcrop that would strand floor is taken back out.
function scatterOutcrops(floor) {
  const { W, H, cells } = floor;
  const n = W * H;
  const sx = new Int32Array(n).fill(-1);   // nearest landmark cell's x, per cell
  const sy = new Int32Array(n).fill(-1);
  const d2 = new Float64Array(n).fill(Infinity);
  const seed = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    d2[i] = 0; sx[i] = x; sy[i] = y;
  };
  for (let i = 0; i < n; i++) {
    if (cells[i] === FLOOR) continue;
    seed(i % W, (i - (i % W)) / W);
  }
  // The stairs and the shop are SEEDED AS LANDMARKS even though their tiles are walkable floor.
  //
  // The invariant is about having something to take a bearing from, and both of these are better
  // at that than any rock: the up-stairs is a 2.2-unit stepped plinth with a glowing lip, a point
  // light and a Team Rocket grunt standing on top of it, and the stall is a 5-unit patterned
  // blanket with Kecleon and six presents on it under its own warm light. Without them seeded, the
  // area around each read as unlit open floor, the covering pass tried to drop rock there, and the
  // no-build zone that protects the fixture geometry (below) refused — which left a ring of cells
  // up to 6.1 units from anything, the one place the invariant actually failed in testing.
  // Footprints match the real geometry rather than being single points.
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    seed(floor.stairsCell.x + dx, floor.stairsCell.y + dy);
  }
  if (floor.shop) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      seed(floor.shop.cx + dx, floor.shop.cy + dy);
    }
  }
  // The two raster passes. Anything outside the grid is solid, so the border seeds itself.
  const relax = (i, x, y, ni) => {
    if (sx[ni] < 0) return;
    const dx = x - sx[ni], dy = y - sy[ni], dd = dx * dx + dy * dy;
    if (dd < d2[i]) { d2[i] = dd; sx[i] = sx[ni]; sy[i] = sy[ni]; }
  };
  const FWD = [[-1, 0], [0, -1], [-1, -1], [1, -1]];
  const BWD = [[1, 0], [0, 1], [1, 1], [-1, 1]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    for (const [dx, dy] of FWD) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) relax(i, x, y, ny * W + nx);
    }
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    for (const [dx, dy] of BWD) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) relax(i, x, y, ny * W + nx);
    }
  }

  const R2 = SIGHT_RADIUS * SIGHT_RADIUS;
  const exposed = [];
  for (let i = 0; i < n; i++) if (cells[i] === FLOOR && d2[i] > R2) exposed.push(i);
  exposed.sort((a, b) => d2[b] - d2[a]);        // worst-lit first

  const covered = new Uint8Array(n);
  // Where rock may NOT be built. The stairwell is a 3-unit pit, the shop blanket a 5-unit patch
  // and Chansey's mat a 3-unit one, so an outcrop inside any of them reads as level geometry gone
  // wrong; the start tile has no geometry at all but the player spawns standing on it, so it needs
  // just enough room not to spawn them inside a wall — 2 cells, where this was 3 for no reason.
  const canBuild = (x, y) => {
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
    if (cells[y * W + x] !== FLOOR) return false;
    if (Math.abs(floor.startCell.x - x) <= 2 && Math.abs(floor.startCell.y - y) <= 2) return false;
    if (Math.abs(floor.stairsCell.x - x) <= 3 && Math.abs(floor.stairsCell.y - y) <= 3) return false;
    if (floor.shop && Math.abs(floor.shop.cx - x) <= 4 && Math.abs(floor.shop.cy - y) <= 4) return false;
    if (floor.chansey && Math.abs(floor.chansey.cx - x) <= CHANSEY_HALF + 1
      && Math.abs(floor.chansey.cy - y) <= CHANSEY_HALF + 1) return false;
    return true;
  };

  const placed = [];
  for (const i of exposed) {
    if (covered[i]) continue;
    let x = i % W, y = (i - x) / W;
    // An exposed cell inside a no-build zone does NOT get written off: the pass walks outward for
    // the nearest cell it CAN build on and puts the rock there instead. Marking the cell covered
    // and moving on was the original bug — it silently abandoned the invariant for the one ring of
    // cells the zones cover, and since the zones sit in the middle of rooms that is exactly where
    // being stranded with no landmark hurts. Anything found within SIGHT_RADIUS still covers the
    // cell that sent us looking.
    if (!canBuild(x, y)) {
      let found = null;
      for (let r = 1; r <= Math.ceil(SIGHT_RADIUS) && !found; r++) {
        for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (dx * dx + dy * dy > R2) continue;
          if (canBuild(x + dx, y + dy)) { found = [x + dx, y + dy]; break; }
        }
      }
      if (!found) { covered[i] = 1; continue; }   // walled in by fixtures: they are the landmark
      x = found[0]; y = found[1];
    }
    // Shape variety, all small: a lone pillar, a squat 2x2, or a short bar either way on.
    const shape = pick([[1, 1], [1, 1], [2, 2], [3, 1], [1, 3], [2, 3], [3, 2]]);
    const block = [];
    for (let by = 0; by < shape[1]; by++) for (let bx = 0; bx < shape[0]; bx++) {
      if (canBuild(x + bx, y + by)) block.push((y + by) * W + (x + bx));
    }
    if (!block.length) { covered[i] = 1; continue; }
    for (const ni of block) {
      cells[ni] = WALL;
      placed.push(ni);
      const nx = ni % W, ny = (ni - nx) / W;
      floor.outcrops.push({ x: nx, y: ny });
    }
    // Mark the neighbourhood covered off the block's own footprint, so a wide outcrop covers the
    // area it actually shades rather than only a disc around its first cell.
    const r = Math.ceil(SIGHT_RADIUS);
    for (const ni of block) {
      const nx = ni % W, ny = (ni - nx) / W;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > R2) continue;
        const cx2 = nx + dx, cy2 = ny + dy;
        if (cx2 < 0 || cy2 < 0 || cx2 >= W || cy2 >= H) continue;
        covered[cy2 * W + cx2] = 1;
      }
    }
  }

  // Safety net: if any outcrop stranded part of the floor, drop them all rather than ship a floor
  // with an unreachable room. Losing the invariant is a legibility problem; losing reachability is
  // a run-ending one, so the trade only ever goes this way. In practice this does not fire — a
  // block with 4.5 units of clearance on every side has nothing to cut off — and it is here
  // because "in practice" is not the same as "by construction".
  if (placed.length && !isFullyConnected(floor)) {
    for (const i of placed) floor.cells[i] = FLOOR;
    floor.outcrops.length = 0;
    console.warn('[dungeon] landmark outcrops split floor ' + floor.number + '; rolled them back');
  }
}

function isFullyConnected(floor) {
  const { W, H, cells } = floor;
  const seen = new Uint8Array(W * H);
  let open = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] === FLOOR) open++;
  const start = floor.startCell.y * W + floor.startCell.x;
  if (cells[start] !== FLOOR) return false;
  const stack = [start];
  seen[start] = 1;
  let reached = 1;
  while (stack.length) {
    const c = stack.pop();
    const x = c % W, y = (c - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (seen[ni] || cells[ni] !== FLOOR) continue;
      seen[ni] = 1; reached++; stack.push(ni);
    }
  }
  return reached === open;
}

// ---- Kecleon's stall ---------------------------------------------------------------------------
// Finds a room that is neither the start nor the stairs room and claims a 7x7 patch of clear floor
// in it. The blanket itself is 5x5 and stays WALKABLE — Kecleon and his presents are decoration
// with a proximity trigger, not collision. Making the shopkeeper solid would be more faithful but
// it is also a way to wedge the player against a wall, and the shop opens before you reach him.
const SHOP_HALF = 3;                 // the clear patch is (2 * SHOP_HALF + 1) square
export const SHOP_BLANKET_HALF = 2.5;   // world half-extent of the blanket, for the trigger radius

function placeShop(floor, startRoom, stairsRoom) {
  const { W, cells } = floor;
  const clearAround = (x, y) => {
    for (let dy = -SHOP_HALF; dy <= SHOP_HALF; dy++) {
      for (let dx = -SHOP_HALF; dx <= SHOP_HALF; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 1 || ny < 1 || nx >= floor.W - 1 || ny >= floor.H - 1) return false;
        if (cells[ny * W + nx] !== FLOOR) return false;
      }
    }
    return true;
  };
  // Biggest rooms first: a 7x7 clear patch only fits in a room with some body to it, and the
  // stall wants space around it so the presents are not jammed against a wall.
  const candidates = floor.rooms
    .filter(r => r !== startRoom && r !== stairsRoom && r.cells.length >= 90)
    .sort((a, b) => b.cells.length - a.cells.length);
  const pools = candidates.length ? candidates : floor.rooms.filter(r => r !== startRoom);
  for (const r of pools) {
    // Try the anchor first, then anywhere in the room.
    const order = [r.cy * W + r.cx, ...shuffled(r.cells)];
    for (const i of order) {
      const x = i % W, y = (i - x) / W;
      if (!clearAround(x, y)) continue;
      return { cx: x, cy: y, room: r, stock: null, obj: null, playerInside: false };
    }
  }
  return null;
}

// ---- Chansey's rest stop ------------------------------------------------------------------------
// The other friendly NPC on a floor, and the counterweight to Kecleon: he takes coins for things,
// she takes nothing and heals the party. Straight out of Mystery Dungeon, and it earns its place
// here for the same reason the stall does — a floor this size needs landmarks, and something worth
// walking to is the best kind (see the SIGHT_RADIUS note at the top of this file).
//
// ONE USE PER FLOOR, and that is the whole of the balance. Unbounded healing would be strictly
// stronger than a full heal after every Grunt: it would delete the attrition that makes a run a
// run, and make every medicine in the bag dead weight. Bounded, it is a reward for exploring.
//
// CHANSEY IS STILL A CATCHABLE WILD, deliberately, and this is the opposite call from the one made
// for Kecleon. He is kept out of POKEMON_CATALOG precisely so he cannot turn up in a wild pool —
// but he is a shopkeeper, a one-of-a-kind character. Chansey is an ordinary species that happens
// to be running a rest stop, so meeting a wild one elsewhere on the floor reads as fine rather
// than as a bug, and there is no reason to cost the player a catchable species for it. Nothing
// here touches the wild pools.
const CHANSEY_HALF = 2;                   // the clear patch is (2 * CHANSEY_HALF + 1) square
export const CHANSEY_PAD_HALF = 1.5;      // world half-extent of the mat, for the trigger radius
const CHANSEY_DEX = 113;

// Which floors carry one. Unlike the shop there is no guaranteed floor: the stall is load-bearing
// for the economy (it is where a run's coins are meant to go), while a rest stop is a piece of
// luck. A flat chance per floor comes out at two or three across a five-floor run.
export function pickChanseyFloors(total = 5, chance = 0.5) {
  const floors = new Set();
  for (let f = 1; f <= total; f++) if (Math.random() < chance) floors.add(f);
  return floors;
}

// Same search as placeShop, with a smaller patch and one more thing to avoid: the stall. Two
// friendly NPCs on one floor must not land on top of each other.
function placeChansey(floor, startRoom, stairsRoom) {
  const { W, cells } = floor;
  const clearAround = (x, y) => {
    for (let dy = -CHANSEY_HALF; dy <= CHANSEY_HALF; dy++) {
      for (let dx = -CHANSEY_HALF; dx <= CHANSEY_HALF; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 1 || ny < 1 || nx >= floor.W - 1 || ny >= floor.H - 1) return false;
        if (cells[ny * W + nx] !== FLOOR) return false;
      }
    }
    return true;
  };
  // Far enough from the stall that their trigger radii cannot overlap, and off the stairs pit.
  const clearOfFixtures = (x, y) =>
    (!floor.shop || Math.abs(floor.shop.cx - x) > 7 || Math.abs(floor.shop.cy - y) > 7)
    && (Math.abs(floor.stairsCell.x - x) > 4 || Math.abs(floor.stairsCell.y - y) > 4);

  const candidates = floor.rooms
    .filter(r => r !== startRoom && r !== stairsRoom && r.cells.length >= 50)
    .sort((a, b) => b.cells.length - a.cells.length);
  const pools = candidates.length ? candidates : floor.rooms.filter(r => r !== startRoom);
  for (const r of pools) {
    for (const i of [r.cy * W + r.cx, ...shuffled(r.cells)]) {
      const x = i % W, y = (i - x) / W;
      if (!clearAround(x, y) || !clearOfFixtures(x, y)) continue;
      return { cx: x, cy: y, room: r, used: false, obj: null, playerInside: false };
    }
  }
  return null;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Coordinate helpers ------------------------------------------------------------------------
export function cellToWorld(floor, cx, cy) {
  return { x: cx - floor.W / 2 + 0.5, z: cy - floor.H / 2 + 0.5 };
}
export function worldToCell(floor, x, z) {
  return { x: Math.floor(x + floor.W / 2), y: Math.floor(z + floor.H / 2) };
}
export function cellValue(floor, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= floor.W || cy >= floor.H) return WALL;
  return floor.cells[cy * floor.W + cx];
}

// A world point is walkable when the cell under it is open floor. Props are solid.
export function isPointWalkable(floor, x, z) {
  const c = worldToCell(floor, x, z);
  return cellValue(floor, c.x, c.y) === FLOOR;
}

// Circle-vs-grid test: sample the four corners of the mover's bounding circle. Cheap, and enough
// for 1-unit cells with a 0.34 radius — a mover can never straddle three cells on an axis.
export function canOccupy(floor, x, z, radius = PLAYER_RADIUS) {
  return isPointWalkable(floor, x - radius, z - radius)
      && isPointWalkable(floor, x + radius, z - radius)
      && isPointWalkable(floor, x - radius, z + radius)
      && isPointWalkable(floor, x + radius, z + radius);
}

// Axis-separated movement, so sliding along a wall works instead of sticking to it.
export function moveWithCollision(floor, pos, dx, dz, radius = PLAYER_RADIUS) {
  if (dx !== 0 && canOccupy(floor, pos.x + dx, pos.z, radius)) pos.x += dx;
  if (dz !== 0 && canOccupy(floor, pos.x, pos.z + dz, radius)) pos.z += dz;
  return pos;
}

// ---- Fog of war --------------------------------------------------------------------------------
// Marks every cell within `radius` of the player as seen. Only the minimap and pause map read
// this; the 3D view is limited by camera framing and fog instead.
// Every cell this newly marks is pushed onto floor.mapDirty. drawMap keeps a cached 1px-per-cell
// terrain canvas and repaints only what is in that list — on floor 5 the grid is 15129 cells and
// painting all of them every frame is not something a phone does at 60 fps, while the handful that
// change as you walk costs nothing.
export function revealAround(floor, x, z, radius = 6) {
  const c = worldToCell(floor, x, z);
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= floor.W || ny >= floor.H) continue;
      const i = ny * floor.W + nx;
      if (floor.visited[i]) continue;
      floor.visited[i] = 1;
      floor.mapDirty.push(i);
    }
  }
}

// The Town Map uncovers everything at once, so the terrain cache has to be thrown away rather than
// patched — there is no useful dirty list for "all of it".
export function revealWholeFloor(floor) {
  floor.mapRevealed = true;
  floor.mapCache = null;
  floor.mapDirty.length = 0;
}

export function isSeen(floor, cx, cy) {
  if (floor.mapRevealed) return true;
  if (cx < 0 || cy < 0 || cx >= floor.W || cy >= floor.H) return false;
  return floor.visited[cy * floor.W + cx] === 1;
}

// ---- A* on the grid, for tap-to-move ----------------------------------------------------------
// Only used to produce a coarse waypoint list; movement.js then steers the player smoothly along
// it with float positions. 4-directional, since diagonal steps could clip a wall corner.
//
// The open set is a BINARY MIN-HEAP. It used to be an array scanned linearly for the lowest f,
// with a comment saying "grids here top out near 55x55, so a heap is not worth it" — which was
// true then and is not now. Floors are five times the area (up to 123x123 = 15129 cells), the
// frontier of a 4-directional search across one grows to a few thousand entries, and a linear
// scan makes the whole search quadratic in that: a single cross-floor tap measured in the tens of
// millions of comparisons, on the main thread, in the middle of a frame.
class MinHeap {
  constructor(key) { this.a = []; this.key = key; }
  get size() { return this.a.length; }
  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key(a[p]) <= this.key(a[i])) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < a.length && this.key(a[l]) < this.key(a[s])) s = l;
        if (r < a.length && this.key(a[r]) < this.key(a[s])) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

// Scratch buffers, reused across calls and grown as needed. At 15129 cells a fresh set of these is
// ~200 KB per call; tap-to-move re-routes on every tap and again whenever movement.js decides the
// player is stuck, and handing the GC 200 KB each time for no reason is avoidable.
const pathScratch = { n: 0, g: null, f: null, from: null, closed: null };
function pathBuffers(n) {
  if (pathScratch.n < n) {
    pathScratch.n = n;
    pathScratch.g = new Float32Array(n);
    pathScratch.f = new Float32Array(n);
    pathScratch.from = new Int32Array(n);
    pathScratch.closed = new Uint8Array(n);
  }
  pathScratch.g.fill(Infinity, 0, n);
  pathScratch.f.fill(Infinity, 0, n);
  pathScratch.from.fill(-1, 0, n);
  pathScratch.closed.fill(0, 0, n);
  return pathScratch;
}

export function findPath(floor, from, to) {
  const { W, H } = floor;
  const idx = (c) => c.y * W + c.x;
  if (cellValue(floor, to.x, to.y) !== FLOOR) return null;
  const startI = idx(from), goalI = idx(to);
  if (startI === goalI) return [];

  const { g: gScore, f: fScore, from: cameFrom, closed } = pathBuffers(W * H);
  const h = (i) => Math.abs((i % W) - to.x) + Math.abs(Math.floor(i / W) - to.y);
  gScore[startI] = 0;
  fScore[startI] = h(startI);
  const open = new MinHeap(i => fScore[i]);
  open.push(startI);

  while (open.size) {
    const cur = open.pop();
    // Lazy deletion: a cell can be pushed more than once as its g improves, so the stale copies
    // are skipped here rather than being found and updated in the heap.
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goalI) {
      const path = [];
      for (let i = cur; i !== startI; i = cameFrom[i]) path.push({ x: i % W, y: Math.floor(i / W) });
      return path.reverse();
    }
    const cx = cur % W, cy = Math.floor(cur / W);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (floor.cells[ny * W + nx] !== FLOOR) continue;
      const ni = ny * W + nx, tentative = gScore[cur] + 1;
      if (tentative >= gScore[ni]) continue;
      cameFrom[ni] = cur;
      gScore[ni] = tentative;
      fScore[ni] = tentative + h(ni);
      open.push(ni);
    }
  }
  return null;
}

// ---- 3D build-out -----------------------------------------------------------------------------
// Exported because the catch minigame dresses its own stage with the same props as the floor you
// are standing on — that is what makes each area's catch background read as that area.
export function makeProp(kind, theme) {
  const g = new THREE.Group();
  const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, ...opts });
  const add = (geo, m, x, y, z) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  switch (kind) {
    case 'tree':
      add(new THREE.CylinderGeometry(0.13, 0.18, 0.7, 6), mat(0x5b3f24), 0, 0.35, 0);
      add(new THREE.ConeGeometry(0.48, 1.0, 7), mat(0x3f7a2e), 0, 1.2, 0);
      add(new THREE.ConeGeometry(0.36, 0.8, 7), mat(0x4b8c36), 0, 1.7, 0);
      break;
    case 'boulder':
      add(new THREE.IcosahedronGeometry(0.46, 0), mat(theme.wallTop, { flatShading: true }), 0, 0.4, 0);
      add(new THREE.IcosahedronGeometry(0.22, 0), mat(theme.wall, { flatShading: true }), 0.38, 0.18, 0.18);
      break;
    case 'lava': {
      add(new THREE.CylinderGeometry(0.5, 0.58, 0.42, 7), mat(0x3a1b14, { flatShading: true }), 0, 0.21, 0);
      const glow = add(new THREE.CylinderGeometry(0.34, 0.34, 0.06, 10),
        new THREE.MeshBasicMaterial({ color: 0xff7a2a }), 0, 0.44, 0);
      glow.castShadow = false;
      g.add(new THREE.PointLight(0xff6a20, 1.1, 5));
      g.children[g.children.length - 1].position.set(0, 0.7, 0);
      break;
    }
    case 'icespike':
      add(new THREE.ConeGeometry(0.3, 1.5, 5), mat(0xbfe6f7, {
        flatShading: true, transparent: true, opacity: 0.85, roughness: 0.15,
      }), 0, 0.75, 0);
      add(new THREE.ConeGeometry(0.18, 0.8, 5), mat(0xd8f2ff, { flatShading: true }), 0.3, 0.4, 0.2);
      break;
    case 'tidepool': {
      add(new THREE.CylinderGeometry(0.55, 0.6, 0.3, 9), mat(theme.wallTop, { flatShading: true }), 0, 0.15, 0);
      const water = add(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 12),
        mat(0x4fc4e0, { transparent: true, opacity: 0.8, roughness: 0.1 }), 0, 0.32, 0);
      water.castShadow = false;
      break;
    }
    case 'pillar':
      add(new THREE.CylinderGeometry(0.3, 0.34, 1.6, 8), mat(0x8d86a3, { flatShading: true }), 0, 0.8, 0);
      add(new THREE.BoxGeometry(0.8, 0.16, 0.8), mat(0x9d96b3), 0, 0.08, 0);
      add(new THREE.BoxGeometry(0.6, 0.2, 0.6), mat(0x7a7391), 0.1, 1.7, -0.05);
      break;
    case 'crate':
      add(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat(0x8a6134), 0, 0.4, 0);
      add(new THREE.BoxGeometry(0.84, 0.1, 0.84), mat(0x5f4223), 0, 0.4, 0);
      add(new THREE.BoxGeometry(0.6, 0.5, 0.6), mat(0x9c1f1f), 0.05, 1.05, 0.05);
      break;
    case 'cactus':
      add(new THREE.CylinderGeometry(0.2, 0.24, 1.3, 7), mat(0x4d7a3e), 0, 0.65, 0);
      add(new THREE.CylinderGeometry(0.11, 0.11, 0.55, 6), mat(0x568a45), 0.3, 0.9, 0)
        .rotation.set(0, 0, Math.PI / 2.4);
      add(new THREE.SphereGeometry(0.09, 6, 5), mat(0xe0d0a0), 0, 1.35, 0);
      break;
    case 'sludge': {
      add(new THREE.SphereGeometry(0.45, 8, 6), mat(0x5c7a2e, { flatShading: true }), 0, 0.28, 0);
      const bub = add(new THREE.SphereGeometry(0.16, 7, 6), mat(0x7fa843), 0.25, 0.5, 0.15);
      bub.castShadow = false;
      break;
    }
    case 'crystal':
      add(new THREE.OctahedronGeometry(0.55, 0), mat(0xc79ae8, {
        flatShading: true, transparent: true, opacity: 0.9, roughness: 0.1,
      }), 0, 0.6, 0);
      add(new THREE.OctahedronGeometry(0.3, 0), mat(0xe6c8ff, { flatShading: true }), 0.36, 0.3, 0.2);
      break;
    case 'palm': {
      // A shore palm: leaning trunk, a fanned crown of frond cones, one coconut.
      add(new THREE.CylinderGeometry(0.1, 0.16, 1.5, 6), mat(0x8a6a43), 0, 0.75, 0)
        .rotation.set(0, 0, 0.12);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        add(new THREE.ConeGeometry(0.14, 0.8, 4), mat(0x4f9a45, { flatShading: true }),
          Math.sin(a) * 0.3, 1.52, Math.cos(a) * 0.3)
          .rotation.set(Math.cos(a) * 0.9, 0, -Math.sin(a) * 0.9);
      }
      add(new THREE.SphereGeometry(0.1, 6, 5), mat(0x6b4a2a), 0.14, 1.42, 0.1);
      break;
    }
    default:
      add(new THREE.BoxGeometry(0.7, 0.7, 0.7), mat(theme.wallTop), 0, 0.35, 0);
  }
  return g;
}

// The Team Rocket figures. There are no humanoid assets in the model set, so grunts and Giovanni
// are built from primitives — a blocky uniformed trainer that reads clearly from the overhead
// camera and matches the voxel look of the Pokemon standing next to them.
export function makeTrainerFigure({ suit = 0x1d1d24, accent = 0xd8202a, skin = 0xe8b98f, hair = 0x2a2a33, scale = 1 } = {}) {
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c });
  const add = (geo, m, x, y, z) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(0.2, 0.5, 0.2), mat(suit), -0.13, 0.25, 0);   // legs
  add(new THREE.BoxGeometry(0.2, 0.5, 0.2), mat(suit), 0.13, 0.25, 0);
  add(new THREE.BoxGeometry(0.56, 0.6, 0.32), mat(suit), 0, 0.8, 0);      // torso
  add(new THREE.BoxGeometry(0.3, 0.34, 0.02), mat(accent), 0, 0.86, 0.17); // the big R
  add(new THREE.BoxGeometry(0.14, 0.5, 0.16), mat(suit), -0.35, 0.8, 0);  // arms
  add(new THREE.BoxGeometry(0.14, 0.5, 0.16), mat(suit), 0.35, 0.8, 0);
  add(new THREE.BoxGeometry(0.36, 0.34, 0.32), mat(skin), 0, 1.27, 0);    // head
  add(new THREE.BoxGeometry(0.4, 0.16, 0.36), mat(hair), 0, 1.46, 0);     // hair
  g.scale.setScalar(scale);
  return g;
}

// ---- The up-stairs: a cobblestone stairwell cut down into the floor -----------------------------
//
// Modelled on Minecraft's cobblestone stairs, and DESCENDING: the flight drops away from the
// floor you are standing on and runs out into darkness at the bottom, because that is where it
// goes — the next floor down. (The game calls it the "up-stairs" throughout because it is what
// you ascend the run's difficulty by taking; the geometry is a way down into the dungeon.)
//
// This replaced a three-tier plinth that RAISED the exit 0.54 above the floor, which read as an
// altar the Grunt was standing on rather than as a way out of the room.
//
// Built as a voxel grid, which is both what makes it read as Minecraft and what makes it cheap:
// every cobble is one instance of a single unit-cube geometry in ONE InstancedMesh, so the whole
// stairwell — walls, treads and apron, a few hundred blocks — is a single draw call. Cobbles with
// all six neighbours filled are skipped, since nothing can ever see them.
//
// GEOMETRY, in the group's local space, origin at the centre of floor.stairsCell and y = 0 at the
// floor surface. COBBLE is the block size and doubles as the step rise AND run, so the flight is a
// true 45 degrees, exactly as a Minecraft staircase is:
//
//        -Z (camera side)                  +Z
//     apron | flight descending ->      | back wall
//     y= 0  |___                        |
//           |   |___                    |     <- 8 steps, COBBLE rise and run each
//           |       |___                |
//           |           |___ ... -2.4   |
//
// The camera looks down the +X/+Z diagonal from 39.9 degrees above the horizon (see CAM_OFFSET),
// so a flight running +Z is seen from its front-left with every tread and riser facing the camera,
// and the sight line from the near lip clears the bottom step with room to spare. The near row of
// apron is where the Grunt stands — see enterFloor in main.js.
const COBBLE = 0.3;                        // one "block": also the step rise and the step run
const STAIR_GRID = 10;                     // 10 blocks square = 3.0 units = the 3x3 cell pit
const STAIR_DEPTH = 8;                     // blocks of wall below the floor, so the well is 2.4 deep

// Minecraft cobblestone is not one grey, it is a mottle of several, and that mottle is the whole
// of what makes it read as cobblestone rather than as stone. Picked per block off the position
// hash below so a given cobble keeps its shade (no flicker) and no two neighbours agree.
const COBBLE_GREYS = [0x7c7c7c, 0x949494, 0x656565, 0xa2a2a2, 0x848484, 0x717171, 0x9b9b9b];

function makeStairs() {
  const g = new THREE.Group();

  // Grid coordinates run 0..STAIR_GRID-1 across and 0..-STAIR_DEPTH down; gy 0 is the layer whose
  // TOP is the floor surface. The apron is lifted 0.02 proud of the floor so its top face is not
  // coplanar with the floor tiles it overlaps — coplanar faces z-fight.
  const APRON_LIFT = 0.02;
  const half = (STAIR_GRID * COBBLE) / 2;
  const wx = (gx) => -half + (gx + 0.5) * COBBLE;
  const wz = (gz) => -half + (gz + 0.5) * COBBLE;
  const wy = (gy) => (gy + 0.5) * COBBLE - COBBLE + APRON_LIFT;

  // Is there a cobble at this grid position? One predicate, asked twice: once to emit the blocks
  // and once per face to decide whether a block is buried. Keeping it as a pure function of
  // position is what makes the neighbour test trivial.
  const last = STAIR_GRID - 1;
  const filled = (gx, gy, gz) => {
    if (gx < 0 || gz < 0 || gx > last || gz > last) return false;
    if (gy > 0 || gy < -STAIR_DEPTH) return false;
    // The outer ring is solid wall from the floor surface all the way down: it is what holds the
    // neighbouring floor tiles' cut edges out of sight from inside the well.
    if (gx === 0 || gx === last || gz === 0 || gz === last) return true;
    // Interior: the flight. Step i occupies interior column gz = i + 1 and is solid from its tread
    // down to the bottom of the well — a staircase is not hollow, and the camera can see under the
    // lip of a flight this steep.
    const step = gz - 1;                        // 0 .. STAIR_GRID-3, front to back
    return gy <= -(step + 1);
  };

  // Top face of step i, which is where the glow and the light hang. gy = -(i+1) is the step's
  // topmost block, and wy() puts a block's top COBBLE/2 above its centre.
  const treadTopY = (step) => -(step + 1) * COBBLE + APRON_LIFT;
  const lastStep = STAIR_GRID - 3;

  const blocks = [];
  for (let gz = 0; gz <= last; gz++) {
    for (let gx = 0; gx <= last; gx++) {
      for (let gy = 0; gy >= -STAIR_DEPTH; gy--) {
        if (!filled(gx, gy, gz)) continue;
        // Buried on all six sides: nothing can see it, so it is not worth an instance. This halves
        // the count on a solid staircase.
        if (filled(gx - 1, gy, gz) && filled(gx + 1, gy, gz)
          && filled(gx, gy - 1, gz) && filled(gx, gy + 1, gz)
          && filled(gx, gy, gz - 1) && filled(gx, gy, gz + 1)) continue;
        blocks.push([gx, gy, gz]);
      }
    }
  }

  const cobbles = new THREE.InstancedMesh(
    // A hair over COBBLE so neighbours interpenetrate instead of meeting on a shared plane, which
    // would z-fight along every seam in the wall.
    new THREE.BoxGeometry(COBBLE * 1.04, COBBLE * 1.04, COBBLE * 1.04),
    new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }),
    blocks.length,
  );
  cobbles.castShadow = true;
  cobbles.receiveShadow = true;
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  blocks.forEach(([gx, gy, gz], i) => {
    m4.makeTranslation(wx(gx), wy(gy), wz(gz));
    cobbles.setMatrixAt(i, m4);
    const hash = (gx * 73 + gz * 151 + gy * 31) % COBBLE_GREYS.length;
    // Darkened with depth on top of the mottle, so the well reads as going somewhere rather than
    // as a lit box with a floor in it, and honest to the lighting — the dirLight barely reaches
    // past the lip. Capped at 0.52 rather than taken further: past about half, the mottle that is
    // doing the work of making this read as COBBLESTONE goes with it, and the flight turns into
    // one black shape with a glow at the bottom. The teal point light on the last tread is what
    // carries the rest of the depth.
    const sink = 1 - Math.min(0.52, (-gy) * 0.075);
    cobbles.setColorAt(i, col.setHex(COBBLE_GREYS[(hash + COBBLE_GREYS.length) % COBBLE_GREYS.length]).multiplyScalar(sink));
  });
  cobbles.instanceMatrix.needsUpdate = true;
  if (cobbles.instanceColor) cobbles.instanceColor.needsUpdate = true;
  g.add(cobbles);

  // The teal glow and its point light, kept from the plinth this replaced — it is the game's
  // established "this is the way on" marker and the only thing that picks the stairs out from
  // across a dark floor, on the minimap as well as here. Moved down onto the BOTTOM tread, where
  // it lights the well from below, throws every riser above it into relief, and reads as something
  // shining up out of the dark. The pulse in animateFloor replaced the plinth's slow spin: a
  // rotating flight of stairs was never going to work.
  const inner = (STAIR_GRID - 2) * COBBLE;
  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(inner, 0.04, COBBLE * 2),
    new THREE.MeshBasicMaterial({ color: 0x9ff2d0, transparent: true, opacity: 0.7 }),
  );
  glow.position.set(0, treadTopY(lastStep) + 0.03, wz(lastStep + 1));
  g.add(glow);
  g.userData.glow = glow;

  const light = new THREE.PointLight(0x7fe8c0, 1.6, 7);
  light.position.set(0, treadTopY(lastStep) + 0.9, wz(lastStep + 1));
  g.add(light);

  return g;
}

// Where the Grunt guarding a floor's stairs stands: on the apron at the near lip of the well,
// facing the camera, with the flight dropping away behind them. Exported because main.js owns the
// figure (it picks Grunt vs Giovanni) while this file owns the stairwell's dimensions.
export const STAIR_TOP = {
  // Centre of the near apron row. At 1.35 from the stairs tile it sits just outside atStairs()'s
  // 1.3 trigger radius, so you are stopped by the encounter a step BEFORE you walk through them.
  z: -((STAIR_GRID * COBBLE) / 2 - COBBLE / 2),
  y: 0.02,                                  // the apron's top face — see APRON_LIFT
  // Front is +Z on makeTrainerFigure (the R is on its +Z face), and the camera sits off the
  // -X/-Z diagonal, so this is the rotation that turns the R to face it.
  facing: Math.PI * 1.25,
};

// Floor pickups. Every one of them is a real model now rather than the generic spinning gem this
// used to draw, and every one of them ROTATES IN PLACE:
//
//   kind 'ball' — the ball's OWN Quest model, so a Great Ball on the floor looks like a Great Ball
//                 before you pick it up. A ball pickup holds `qty` of them (1-5).
//   kind 'item' — the wrapped present, exactly as in Mystery Dungeon, where what is inside a
//                 present is not knowable until you open it. WHICH item it was is revealed on
//                 pickup, by its own pixel sprite (see the pickup popup in ui-screens.js).
//   kind 'coin' — the matching coin denomination, silver / gold / big gold.
//
// The model hangs off a `spin` child so the rotation and bob are applied to the model alone and
// the ground ring underneath stays put; a ring that bobbed with the model would read as the floor
// moving. The ring's colour is the one hint the pickup's KIND gives away at a distance.
const PICKUP_RING = {
  item: 0xffe58a,          // gold, as the old gem markers were
  ball: 0xff9aa2,          // pale red
  coin: 0xfff0b0,          // pale gold
};

function makeFloorPickup(entry) {
  const g = new THREE.Group();
  const spin = new THREE.Group();
  spin.position.y = 0.34;             // floats clear of the floor so the ring reads as a shadow
  g.add(spin);

  let model;
  if (entry.kind === 'ball') {
    model = createBallObject(entry.itemId, { size: 0.42 });
  } else if (entry.kind === 'coin') {
    const coin = COIN_BY_ID.get(entry.coinId);
    model = createModelObject(COIN_MODEL_PATHS[entry.coinId], {
      height: (coin?.height || 0.5) * 0.8, tint: 0xd8c070,
    });
  } else {
    model = createModelObject(GIFT_BOX_MODEL, { height: 0.46, tint: 0xe8e0d8 });
  }
  // fitModel sits a model with its feet at y=0; centre it on the spin pivot instead, or it
  // rotates about its own base corner and wobbles rather than turning.
  model.position.y = entry.kind === 'coin' ? -((COIN_BY_ID.get(entry.coinId)?.height || 0.5) * 0.4) : -0.23;
  spin.add(model);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.42, 16),
    new THREE.MeshBasicMaterial({
      color: PICKUP_RING[entry.kind] || PICKUP_RING.item,
      transparent: true, opacity: 0.5, side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  g.add(ring);
  g.userData.spin = spin;
  return g;
}

// ---- Kecleon's stall ---------------------------------------------------------------------------
// A blanket laid on the floor with presents on it and Kecleon standing at the back of it, which is
// how the shop reads in Mystery Dungeon. The blanket's weave is a CanvasTexture rather than nested
// primitives: the pattern is what makes it read as cloth on the floor instead of as a painted
// slab, and at NearestFilter with no mipmaps it stays as crisp as the rest of the game's pixel art.
let blanketTexture = null;
function getBlanketTexture() {
  if (blanketTexture) return blanketTexture;
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#6b4a86'; x.fillRect(0, 0, S, S);                   // purple ground
  x.fillStyle = '#f2e3c0';                                           // cream stripes
  for (let i = 4; i < S; i += 16) x.fillRect(0, i, S, 6);
  x.fillStyle = '#8f63ad';
  for (let i = 4; i < S; i += 16) x.fillRect(i, 0, 6, S);            // a woven cross-hatch
  x.strokeStyle = '#3d2650'; x.lineWidth = 6;
  x.strokeRect(3, 3, S - 6, S - 6);                                  // a hemmed border
  blanketTexture = new THREE.CanvasTexture(c);
  blanketTexture.magFilter = THREE.NearestFilter;
  blanketTexture.minFilter = THREE.NearestFilter;
  blanketTexture.generateMipmaps = false;
  blanketTexture.colorSpace = THREE.SRGBColorSpace;
  return blanketTexture;
}

function makeShopStall() {
  const g = new THREE.Group();
  const side = SHOP_BLANKET_HALF * 2;

  const blanket = new THREE.Mesh(
    new THREE.BoxGeometry(side, 0.06, side),
    new THREE.MeshStandardMaterial({ map: getBlanketTexture(), roughness: 0.9 }),
  );
  blanket.position.y = 0.03;
  blanket.receiveShadow = true;
  g.add(blanket);

  // Kecleon stands at the BACK of the blanket, on the far side from the camera. The camera looks
  // along (+x, +z), so "far" is +x/+z and the player always approaches across the near half — the
  // presents stay between you and him, the way a stall is laid out.
  // 1.35 tall, against 0.85-1.15 for a wild Pokemon: he is the tallest thing on the blanket and
  // has to read as the shopkeeper rather than as one more object laid out on it.
  const kec = createModelObject(KECLEON_MODEL, { height: 1.35, tint: 0x5fbf52 });
  kec.position.set(SHOP_BLANKET_HALF * 0.44, 0.06, SHOP_BLANKET_HALF * 0.44);
  kec.rotation.y = Math.PI * 1.25;      // face back down the diagonal, toward the camera
  g.add(kec);
  g.userData.kecleon = kec;

  // The presents laid out on the blanket, on the near half so they never hide him.
  const spots = [
    [-0.58, -0.52], [0.04, -0.66], [0.62, -0.40],
    [-0.66, 0.10], [0.58, 0.22], [-0.16, 0.46],
  ];
  const presents = [];
  for (let i = 0; i < spots.length; i++) {
    const box = createModelObject(GIFT_BOX_MODEL, { height: rnd(0.30, 0.42), tint: 0xe8e0d8 });
    box.position.set(spots[i][0] * SHOP_BLANKET_HALF, 0.06, spots[i][1] * SHOP_BLANKET_HALF);
    box.rotation.y = rnd(0, Math.PI * 2);
    g.add(box);
    presents.push(box);
  }
  g.userData.presents = presents;

  // A warm pool of light over the stall, so it reads as somewhere to go from across a dark room.
  const light = new THREE.PointLight(0xffd98a, 1.0, 9);
  light.position.set(0, 2.2, 0);
  g.add(light);
  return g;
}

// Chansey's rest stop: a soft round mat, Chansey standing on it, and a warm pink pool of light.
// Deliberately built to read as the stall's opposite number from across a room — the stall is a
// square blanket under gold light, this is a circle under pink — so at a glance you know which one
// you are walking toward and whether you need coins for it.
function makeChanseyStation() {
  const g = new THREE.Group();

  // A disc rather than the stall's square: round says "stop and rest", square says "goods laid
  // out". CircleGeometry is flat, so it is laid down and lifted clear of the floor tiles.
  const mat = new THREE.Mesh(
    new THREE.CircleGeometry(CHANSEY_PAD_HALF, 28),
    new THREE.MeshStandardMaterial({ color: 0xf7c9d8, roughness: 0.85 }),
  );
  mat.rotation.x = -Math.PI / 2;
  mat.position.y = 0.03;
  mat.receiveShadow = true;
  g.add(mat);

  // A ring just inside the rim, the same trick the pickups use: it reads as the edge of somewhere
  // you can stand rather than as a decal on the floor.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(CHANSEY_PAD_HALF * 0.82, CHANSEY_PAD_HALF * 0.94, 28),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  g.add(ring);

  // 1.05 tall — shorter than Kecleon's 1.35, because she is not presiding over anything, and about
  // the height of a wild Pokemon so she reads as one of them rather than as a fixture.
  const mon = createMonObject(CHANSEY_DEX, { height: 1.05 });
  mon.position.y = 0.05;
  mon.rotation.y = Math.PI * 1.25;        // facing back down the diagonal, toward the camera
  g.add(mon);
  g.userData.mon = mon;

  const light = new THREE.PointLight(0xffb7cd, 1.1, 8);
  light.position.set(0, 2.0, 0);
  g.add(light);
  g.userData.light = light;

  return g;
}

// Walking onto Chansey's mat. Same enter-latched shape as atShop and for the same reason: the
// prompt is a screen, so a plain "am I close" test would reopen it the instant it was closed.
// Returns false once she is spent, so a used station is simply inert to walk over.
export function atChansey(floor, player) {
  const c = floor.chansey;
  if (!c) return false;
  const w = cellToWorld(floor, c.cx, c.cy);
  const inside = Math.hypot(w.x - player.x, w.z - player.z) < CHANSEY_PAD_HALF + 0.4;
  const entered = inside && !c.playerInside;
  c.playerInside = inside;
  return entered && !c.used;
}

// True on the frame the player steps back onto a station they have already used, which main.js
// turns into a one-line toast rather than a screen with nothing on it to press.
export function atUsedChansey(floor, player) {
  const c = floor.chansey;
  if (!c || !c.used) return false;
  const w = cellToWorld(floor, c.cx, c.cy);
  const inside = Math.hypot(w.x - player.x, w.z - player.z) < CHANSEY_PAD_HALF + 0.4;
  const entered = inside && !c.playerInside;
  c.playerInside = inside;
  return entered;
}

// Spend the station. The light drops and the ring goes out, so a spent stop reads as spent from
// across the room instead of luring you back to a prompt that will not open.
export function spendChansey(floor) {
  const c = floor.chansey;
  if (!c) return;
  c.used = true;
  const obj = c.obj;
  if (!obj) return;
  if (obj.userData.light) obj.userData.light.intensity = 0.3;
  obj.traverse(o => {
    if (o.isMesh && o.material?.transparent) o.material.opacity = 0.12;
  });
}

export function applyThemeLighting(theme) {
  scene.background = new THREE.Color(theme.fog);
  // Fog starts well past the camera's own framing: pulled in any tighter and the far half of a
  // room is swallowed, which reads as "the renderer is broken" rather than as atmosphere.
  scene.fog = new THREE.Fog(theme.fog, 22, 46);
  hemiLight.color.setHex(theme.sky);
  hemiLight.groundColor.setHex(theme.ground);
  hemiLight.intensity = 1.3;
  dirLight.color.setHex(theme.light);
  dirLight.intensity = 1.25;
}

// Instances everything static, creates the entity objects, and returns the Group to add to the
// scene. Floor tiles and walls are single InstancedMeshes — a 123x123 floor is ~15000 cells, which
// would be a disaster as individual meshes and is three draw calls this way (floor, wall, wall cap).
export function buildFloor(floor) {
  const { W, H, theme } = floor;
  const group = new THREE.Group();

  const floorCells = [];
  const wallCells = [];
  // The stairwell's footprint gets NO floor tile. It is a hole in the floor that the stairs
  // descend into (see makeStairs), and a floor tile inside it would hang across the well in
  // mid-air — the tiles are 0.4 thick and their tops are the walking surface, so one sitting over
  // the flight is a slab wedged between the treads. The cells stay FLOOR in floor.cells, which is
  // what collision and the tap-to-move pathfinder read; nothing ever stands there because
  // atStairs() takes the ascent at 1.3 units out, half a cell short of the lip.
  const inStairPit = (x, y) =>
    Math.abs(x - floor.stairsCell.x) <= STAIR_PIT_R && Math.abs(y - floor.stairsCell.y) <= STAIR_PIT_R;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = floor.cells[y * W + x];
      if (v === FLOOR || v === PROP) {
        if (!inStairPit(x, y)) floorCells.push([x, y]);
        continue;
      }
      // EVERY solid cell is instanced, not just the ones touching open space.
      //
      // This used to draw only the border ring "because the rock behind it is never visible from
      // an overhead camera". It is: the camera is a DIAGONAL overhead, so past the one-cell skin
      // you see straight out into the scene background, and the whole floor reads as an island
      // floating in a black void with wall-shaped edges you would expect to be able to walk past.
      // Filling the rock is what makes a floor read as rooms carved out of solid ground.
      // It is still one draw call — instance count is the only thing that goes up, and even the
      // biggest floor (123x123) lands around 11k boxes, which is nothing for instanced rendering.
      wallCells.push([x, y]);
    }
  }

  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();

  const floorMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 0.4, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.85 }),
    floorCells.length,
  );
  floorMesh.receiveShadow = true;
  floorCells.forEach(([x, y], i) => {
    const w = cellToWorld(floor, x, y);
    m4.makeTranslation(w.x, -0.2, w.z);
    floorMesh.setMatrixAt(i, m4);
    // Checkerboard the two floor tints so scale and movement read clearly on an open floor.
    floorMesh.setColorAt(i, col.setHex((x + y) % 2 ? theme.floorA : theme.floorB));
  });
  floorMesh.instanceMatrix.needsUpdate = true;
  if (floorMesh.instanceColor) floorMesh.instanceColor.needsUpdate = true;
  group.add(floorMesh);

  // Walls are WALL_HEIGHT (0.5) tall — see the note at the top of this file for the occlusion
  // arithmetic that picked that number.
  const wallMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, WALL_HEIGHT, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }),
    wallCells.length,
  );
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  wallCells.forEach(([x, y], i) => {
    const w = cellToWorld(floor, x, y);
    m4.makeTranslation(w.x, WALL_HEIGHT / 2, w.z);
    wallMesh.setMatrixAt(i, m4);
    // Slight per-instance value jitter so a long wall isn't one flat slab of color.
    const jitter = 0.88 + ((x * 7 + y * 13) % 5) * 0.05;
    wallMesh.setColorAt(i, col.setHex(theme.wall).multiplyScalar(jitter));
  });
  wallMesh.instanceMatrix.needsUpdate = true;
  if (wallMesh.instanceColor) wallMesh.instanceColor.needsUpdate = true;
  group.add(wallMesh);

  // The wall CAP: a thin slab of theme.wallTop across every wall's top face.
  //
  // This is not decoration, it is what makes a half-height wall legible. At 2.4 units a wall was
  // read as a wall by its height alone; at 0.5 the only thing distinguishing "solid rock you
  // cannot cross" from "floor" is the colour of its top surface, and a single-material
  // InstancedMesh cannot paint one face differently from the others — setColorAt is per instance,
  // not per geometry group. So the cap is its own instanced mesh, which costs one draw call.
  // It is deliberately 0.04 SHORT of the wall top and 0.08 thick, giving 0.44-0.52 against the
  // wall's 0-0.5: overlapping rather than coplanar, because coplanar faces z-fight.
  const capMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 0.08, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }),
    wallCells.length,
  );
  capMesh.castShadow = true;
  capMesh.receiveShadow = true;
  wallCells.forEach(([x, y], i) => {
    const w = cellToWorld(floor, x, y);
    m4.makeTranslation(w.x, WALL_HEIGHT - 0.02, w.z);
    capMesh.setMatrixAt(i, m4);
    const jitter = 0.9 + ((x * 11 + y * 5) % 4) * 0.05;
    capMesh.setColorAt(i, col.setHex(theme.wallTop).multiplyScalar(jitter));
  });
  capMesh.instanceMatrix.needsUpdate = true;
  if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;
  group.add(capMesh);

  // Props, INSTANCED. A floor now carries 26-58 of them (it was 16-32) and each makeProp() group
  // holds two or three meshes, so as individual objects that is up to ~174 draw calls for scenery
  // alone. Instancing collapses it to one per sub-mesh of the prototype — three at most.
  if (floor.props.length) {
    const proto = makeProp(theme.prop, theme);
    proto.updateMatrixWorld(true);
    const parts = [];
    proto.traverse(o => { if (o.isMesh) parts.push(o); });
    const local = new THREE.Matrix4();
    const parent = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const pos = new THREE.Vector3();
    for (const part of parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, floor.props.length);
      im.castShadow = true;
      im.receiveShadow = true;
      floor.props.forEach((p, i) => {
        const w = cellToWorld(floor, p.x, p.y);
        pos.set(w.x, 0, w.z);
        quat.setFromEuler(new THREE.Euler(0, p.rot, 0));
        scl.setScalar(p.scale);
        parent.compose(pos, quat, scl);
        // part.matrix is the mesh's own offset inside the prototype group (a tree's foliage cone
        // sits 1.2 up from its trunk), so the instance transform is parent * that local matrix.
        local.multiplyMatrices(parent, part.matrix);
        im.setMatrixAt(i, local);
      });
      im.instanceMatrix.needsUpdate = true;
      group.add(im);
    }
    // Only the first two prop PointLights survive, the same rule the catch stage uses: the lava
    // vent ships one each and 58 of them blows the light budget and washes the floor out.
    const protoLights = [];
    proto.traverse(o => { if (o.isLight) protoLights.push(o); });
    if (protoLights.length) {
      for (const p of floor.props.slice(0, 2)) {
        for (const src of protoLights) {
          const lamp = src.clone();
          const w = cellToWorld(floor, p.x, p.y);
          lamp.position.set(w.x + src.position.x, src.position.y, w.z + src.position.z);
          group.add(lamp);
        }
      }
    }
  }

  const stairs = makeStairs();
  const sw = cellToWorld(floor, floor.stairsCell.x, floor.stairsCell.y);
  stairs.position.set(sw.x, 0, sw.z);
  group.add(stairs);
  floor.stairsObj = stairs;

  if (floor.shop) {
    const stall = makeShopStall();
    const w = cellToWorld(floor, floor.shop.cx, floor.shop.cy);
    stall.position.set(w.x, 0, w.z);
    group.add(stall);
    floor.shop.obj = stall;
  }

  if (floor.chansey) {
    const station = makeChanseyStation();
    const w = cellToWorld(floor, floor.chansey.cx, floor.chansey.cy);
    station.position.set(w.x, 0, w.z);
    group.add(station);
    floor.chansey.obj = station;
    // A floor re-entered after its station was used (there is no such path today, but disposeFloor
    // and buildFloor are not the only callers this could ever have) must come back spent.
    if (floor.chansey.used) spendChansey(floor);
  }

  for (const it of floor.items) {
    const marker = makeFloorPickup(it);
    const w = cellToWorld(floor, it.x, it.y);
    marker.position.set(w.x, 0, w.z);
    group.add(marker);
    it.obj = marker;
  }

  for (const wild of floor.wilds) {
    const c = CATALOG_BY_DEX.get(wild.dex);
    // Legendary is FIRST, not last. The chain used to end in a bare 0.85 default, which caught
    // 'Basic' and 'Legendary' alike — harmless while Legendaries never wandered, and wrong the
    // moment they could: the rarest thing on the floor would have stood there as the smallest.
    const height = !c ? 0.85
      : c.stage === 'Legendary' ? 1.45
      : c.stage === 'Stage2' ? 1.15
      : c.stage === 'Stage1' ? 1.0 : 0.85;
    const obj = createMonObject(wild.dex, { height, tint: TYPE_COLOR[c?.types?.[0]] || 0x888888 });
    obj.position.set(wild.x, 0, wild.z);
    group.add(obj);
    wild.obj = obj;
    wild.height = height;
    if (wild.aggressive) {
      const aura = makeAura(height);
      obj.add(aura);
      wild.aura = aura;
    }
  }

  floor.group = group;
  applyThemeLighting(theme);
  return group;
}

export function disposeFloor(floor) {
  if (!floor || !floor.group) return;
  for (const w of floor.wilds) disposeObject(w.obj);

  // DETACH every subtree that shares its geometry with the loader cache before the sweep below,
  // which disposes geometry unconditionally. This used to be satisfied by the wild loop alone,
  // because a wild Pokemon was the only cached model on a floor and floor pickups were primitive
  // gems. They are not any more: every pickup is a ball, present or coin model, and the shop adds
  // Kecleon and six more presents. Disposing one of those clones' geometry blanks out every future
  // instance of that model for the life of the page, because .clone() SHARES it with the cache —
  // which is the same reason disposeObject() has never disposed anything itself.
  //
  // Collected first and removed after: mutating the tree during traverse() skips siblings.
  const shared = [];
  floor.group.traverse(o => { if (o.userData && o.userData.shared) shared.push(o); });
  for (const o of shared) disposeObject(o);

  floor.group.traverse(o => {
    if (o.isInstancedMesh || o.isMesh) {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      // Only dispose the primitives we built ourselves (they are never in the loader cache). The
      // one remaining textured material is the shop blanket's, whose CanvasTexture is module-level
      // and deliberately outlives the floor.
      mats.forEach(m => { if (m && !m.map) m.dispose?.(); });
    }
  });
  floor.group.parent?.remove(floor.group);
  floor.group = null;
  // The map's terrain cache is a canvas the size of this floor's grid; a run walks through five of
  // them and they are not small (123x123 each).
  floor.mapCache = null;
  floor.mapDirty.length = 0;
}

// ---- Wild Pokemon wander ----------------------------------------------------------------------
// Free continuous movement, exactly like the player: they pick a heading, walk it until they hit
// something or the timer runs out, and never snap to a cell. Aggressive ones home in on the
// player when close, unless Max Repel is active.
export function updateWilds(floor, dt, player, { repelled = false } = {}) {
  const WANDER_SPEED = 1.5, CHASE_SPEED = 2.5, RADIUS = 0.32;
  const now = performance.now();
  for (const w of floor.wilds) {
    if (w.gone || !w.obj) continue;
    const toPlayer = Math.hypot(player.x - w.x, player.z - w.z);
    // A cooldown means "this one's encounter is suppressed" — so it must stop CHASING as well.
    // Left chasing, an aggressive wild homed onto the player every frame and, with no
    // wild-vs-player collision, walked straight through them for the whole cooldown.
    const onCooldown = w.cooldownUntil && now < w.cooldownUntil;
    const chasing = w.aggressive && !repelled && !onCooldown && toPlayer < 7;

    if (chasing) {
      w.dirX = (player.x - w.x) / (toPlayer || 1);
      w.dirZ = (player.z - w.z) / (toPlayer || 1);
    } else {
      w.retarget -= dt;
      if (w.retarget <= 0) {
        // Bias the new heading back toward home so wanderers don't drift off across the floor.
        const home = cellToWorld(floor, w.homeX, w.homeY);
        const dHome = Math.hypot(home.x - w.x, home.z - w.z);
        if (dHome > 5) {
          w.dirX = (home.x - w.x) / dHome; w.dirZ = (home.z - w.z) / dHome;
        } else if (Math.random() < 0.25) {
          w.dirX = 0; w.dirZ = 0;                      // idle beat
        } else {
          const a = Math.random() * Math.PI * 2;
          w.dirX = Math.cos(a); w.dirZ = Math.sin(a);
        }
        w.retarget = rnd(0.6, 2.2);
      }
    }

    const speed = (chasing ? CHASE_SPEED : WANDER_SPEED) * dt;
    const before = { x: w.x, z: w.z };
    const p = moveWithCollision(floor, { x: w.x, z: w.z }, w.dirX * speed, w.dirZ * speed, RADIUS);
    w.x = p.x; w.z = p.z;
    // Blocked: turn around next frame rather than grinding into the wall.
    if (!chasing && Math.abs(p.x - before.x) < 1e-6 && Math.abs(p.z - before.z) < 1e-6) w.retarget = 0;

    w.obj.position.set(w.x, 0, w.z);
    if (w.dirX || w.dirZ) w.obj.rotation.y = Math.atan2(w.dirX, w.dirZ);
    spinAura(w.aura, dt);
  }
}

// Item pickup / stairs / wild contact tests, all radius-based against the player's float position.
export function itemAtPlayer(floor, player, radius = 0.6) {
  for (const it of floor.items) {
    if (it.taken) continue;
    const w = cellToWorld(floor, it.x, it.y);
    if (Math.hypot(w.x - player.x, w.z - player.z) < radius) return it;
  }
  return null;
}

export function wildAtPlayer(floor, player, radius = 0.75) {
  for (const w of floor.wilds) {
    if (w.gone) continue;
    if (Math.hypot(w.x - player.x, w.z - player.z) < radius) return w;
  }
  return null;
}

export function atStairs(floor, player, radius = 1.3) {
  const w = cellToWorld(floor, floor.stairsCell.x, floor.stairsCell.y);
  return Math.hypot(w.x - player.x, w.z - player.z) < radius;
}

// Walking up to Kecleon. Returns true only on the frame the player ENTERS the stall's radius, not
// for every frame they stand in it: the shop is a screen, and a plain "am I close" test would
// reopen it the instant it was closed, which reads as a screen you cannot get out of. `playerInside`
// is the latch, and it is cleared by stepping back off the blanket.
export function atShop(floor, player) {
  const shop = floor.shop;
  if (!shop) return false;
  const w = cellToWorld(floor, shop.cx, shop.cy);
  const d = Math.hypot(w.x - player.x, w.z - player.z);
  const inside = d < SHOP_BLANKET_HALF + 0.4;
  const entered = inside && !shop.playerInside;
  shop.playerInside = inside;
  return entered;
}

// Animate the decorative bits: the spinning pickups and the spinning stairs glow.
//
// EVERY pickup rotates in place — balls, presents and coins alike — which is what makes an
// otherwise static model read as something to walk over and collect. Speeds differ per kind on
// purpose: a coin is a flat disc and spins fast (it is the same read as a coin spinning in any
// Pokemon game), a present turns slowly like a display piece, a ball sits between them.
const SPIN_SPEED = { coin: 2.6, item: 1.0, ball: 1.5 };
const BOB_HEIGHT = { coin: 0.10, item: 0.07, ball: 0.09 };

export function updateFloorDecor(floor, dt, elapsed) {
  for (const it of floor.items) {
    if (it.taken || !it.obj) continue;
    const spin = it.obj.userData.spin;
    if (!spin) continue;
    spin.rotation.y += dt * (SPIN_SPEED[it.kind] || 1.2);
    spin.position.y = 0.34 + Math.sin(elapsed * 2 + it.bob) * (BOB_HEIGHT[it.kind] || 0.08);
  }
  // The stairwell itself does not move — it is a hole in the floor, and the plinth that used to
  // stand here span slowly because it was a free-standing object. What is left of that is the teal
  // glow on the bottom tread, which breathes instead: a light coming up out of the dark.
  const stairGlow = floor.stairsObj?.userData?.glow;
  if (stairGlow) stairGlow.material.opacity = 0.45 + Math.sin(elapsed * 2.2) * 0.25;
  // Kecleon's presents turn too, so the stall is not a still life next to a floor full of
  // spinning pickups.
  const presents = floor.shop?.obj?.userData?.presents;
  if (presents) for (const p of presents) p.rotation.y += dt * 0.5;

  // Chansey BOBS rather than spins, for the same reason Kecleon does neither: she is somebody you
  // walk up to, not merchandise. A slow breath is enough to stop her reading as scenery — and it
  // stops when she is spent, which is half of how a used station announces itself.
  const chansey = floor.chansey;
  if (chansey?.obj?.userData?.mon && !chansey.used) {
    chansey.obj.userData.mon.position.y = 0.05 + Math.sin(elapsed * 2.1) * 0.045;
  }
}

// ---- Minimap / pause map rendering -------------------------------------------------------------
//
// BOTH MAPS ARE DRAWN IN THE ORIENTATION YOU ARE LOOKING FROM, not in grid order.
//
// The camera is a fixed diagonal overhead, so screen-up on the ground plane is the world direction
// (+x, +z)/sqrt(2) and screen-right is (-x, +z)/sqrt(2) (the same basis movement.js steers by).
// Deriving the canvas rotation that reproduces that: we need world (1,1) to come out as canvas
// (0,-1) (canvas y grows DOWNWARD, so up is -y) and world (-1,1) to come out as canvas (1,0).
// Solving for M in canvas = M * world gives
//
//     M = (1/sqrt2) * [ -1   1 ]      which is a canvas rotate() of -135 degrees
//                     [ -1  -1 ]
//
// so VIEW_ROT below is -3*PI/4 and everything else follows from it. Without this the map was in
// grid order and reading it meant mentally rotating the floor 45 degrees every time you glanced at
// it, which is exactly the thing a minimap exists to save you from.
//
// A ROTATION IS NOT THE EXACT PROJECTION, DELIBERATELY. The 3D view also FORESHORTENS the ground
// plane: at the camera's 39.88 degree elevation the screen-up axis is compressed by sin(39.88) =
// 0.641, while the map applies a plain rotation and no squash. Measured against the real camera
// (projecting world offsets through it and comparing angles): the four principal screen directions
// — screen-up, screen-right and both diagonals — agree EXACTLY, and the worst case anywhere is
// 12.6 degrees, against an octant boundary of 22.5. So every direction still reads as the same
// up / down-left / right that it does on screen.
// Squashing the map by 0.641 as well would make it pixel-exact, and it is not worth it: cells stop
// being square, distances on the map stop being comparable, a room renders as a lozenge, and the
// pause map's whole-floor view wastes most of its canvas. Top-down-but-rotated is what the map is.
const VIEW_ROT = -3 * Math.PI / 4;

// The HUD minimap shows a WINDOW this many cells across, centred on the player, rather than the
// whole floor. Floors are now up to 123 cells across, and a whole floor squeezed into the 108px
// HUD map — 1.41x wider again once rotated — lands under 0.6px per cell: corridors, item dots and
// walls all collapse into mush. A 34-cell window keeps a cell at ~3.2 CSS px, which is legible,
// and the whole floor is one tap away on the pause map. Tapping the minimap opens exactly that.
export const MINIMAP_CELLS = 34;

const MAP_COLOR = { wall: '#39405a', prop: '#5a6480', floor: '#c8d4ee' };
// The same three colours as packed RGBA, for the bulk repaint path below.
const MAP_RGBA = {
  wall: [0x39, 0x40, 0x5a, 255],
  prop: [0x5a, 0x64, 0x80, 255],
  floor: [0xc8, 0xd4, 0xee, 255],
};

// The 1px-per-cell terrain layer, cached on the floor and patched from floor.mapDirty.
//
// Repainting every seen cell each frame was fine at 55x55 (3025 fillRects). At 123x123 it is
// 15129, sixty times a second, on top of a rotated blit — so the terrain is painted ONCE per cell,
// into an offscreen canvas the size of the grid, and each frame is a single drawImage of that
// canvas through the view transform. Fog of war only ever adds cells, so the patch list is all
// that is needed; the Town Map's reveal-everything case throws the cache away instead
// (revealWholeFloor), because there is no useful dirty list for "all of it".
function terrainCanvas(floor) {
  let cache = floor.mapCache;
  if (!cache) {
    const c = document.createElement('canvas');
    c.width = floor.W; c.height = floor.H;
    cache = floor.mapCache = { canvas: c, ctx: c.getContext('2d') };
    // A FRESH cache repaints every cell already seen, and does it through one ImageData rather
    // than a fillRect per cell. This path is taken on the first frame of a floor (cheap, almost
    // nothing is revealed) and again whenever a Town Map uncovers the lot — and on a 123x123 floor
    // that second case is all 15129 cells at once. Measured: 13.3 ms as individual fillRects,
    // which is most of a 60 fps frame, against 1.2 ms this way.
    floor.mapDirty.length = 0;
    const img = cache.ctx.createImageData(floor.W, floor.H);
    const px = img.data;
    for (let i = 0; i < floor.cells.length; i++) {
      const x = i % floor.W, y = (i - x) / floor.W;
      if (!isSeen(floor, x, y)) continue;          // leave it transparent: black means unexplored
      const v = floor.cells[i];
      const rgba = v === WALL ? MAP_RGBA.wall : v === PROP ? MAP_RGBA.prop : MAP_RGBA.floor;
      const o = i * 4;
      px[o] = rgba[0]; px[o + 1] = rgba[1]; px[o + 2] = rgba[2]; px[o + 3] = rgba[3];
    }
    cache.ctx.putImageData(img, 0, 0);
  }
  if (floor.mapDirty.length) {
    const g = cache.ctx;
    for (const i of floor.mapDirty) {
      const x = i % floor.W, y = (i - x) / floor.W;
      const v = floor.cells[i];
      // EVERY seen solid cell is painted, not just the ones fringing a room. Leaving the deep
      // rock unpainted left it the same black as UNEXPLORED, so explored solid ground and unknown
      // ground were indistinguishable — the map read as broken, and the black looked like
      // somewhere you could walk. Black means "not been there" and nothing else.
      g.fillStyle = v === WALL ? MAP_COLOR.wall : v === PROP ? MAP_COLOR.prop : MAP_COLOR.floor;
      g.fillRect(x, y, 1, 1);
    }
    floor.mapDirty.length = 0;
  }
  return cache.canvas;
}

// The Team Rocket marker: a pixel-art capital R, authored as ASCII here the same way the item
// icons are in js/data/items.js. It replaced a plain red dot, which said "something is here" but
// not "that is the Grunt standing on the stairs" — and the stairs already have a marker of their
// own underneath it.
const ROCKET_R = [
  'RRRR.',
  'R...R',
  'R...R',
  'RRRR.',
  'R.R..',
  'R..R.',
  'R...R',
];

function drawPixelGlyph(ctx, rows, px, py, scale, fill, outline) {
  const w = rows[0].length, h = rows.length;
  const x0 = px - (w * scale) / 2, y0 = py - (h * scale) / 2;
  // The outline is drawn as the same glyph one pixel out in eight directions, so the R stays
  // readable over both pale floor and dark rock without a backing box behind it.
  for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.fillStyle = outline;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (rows[y][x] === '.') continue;
      ctx.fillRect(Math.round(x0 + x * scale + ox), Math.round(y0 + y * scale + oy),
                   Math.ceil(scale), Math.ceil(scale));
    }
  }
  ctx.fillStyle = fill;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rows[y][x] === '.') continue;
    ctx.fillRect(Math.round(x0 + x * scale), Math.round(y0 + y * scale),
                 Math.ceil(scale), Math.ceil(scale));
  }
}

// `cellsAcross > 0` gives a player-centred window that many cells wide; 0 fits the whole floor.
// `rot` / `zoom` / `panX` / `panY` are the pause map's own controls and are all zero/one for the
// HUD minimap, which is always locked to the view orientation.
export function drawMap(ctx, floor, player, {
  detail = false,
  heading = 0,
  cellsAcross = 0,
  rot = 0, zoom = 1, panX = 0, panY = 0,
} = {}) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = 'rgba(8,10,16,0.72)';
  ctx.fillRect(0, 0, cw, ch);

  const size = Math.min(cw, ch);
  // Fitting the WHOLE floor has to allow for the rotation: a WxH grid turned 45 degrees needs
  // (W+H)/sqrt(2) of room, which for a square floor is W * sqrt(2).
  const baseScale = cellsAcross > 0 ? size / cellsAcross : size / (floor.W * Math.SQRT2);
  const scale = baseScale * zoom;
  // The player's position in FRACTIONAL cell coordinates — the inverse of cellToWorld without the
  // floor(). Centring the window on this rather than on worldToCell()'s integer cell is what makes
  // the minimap slide smoothly under a stationary arrow instead of jumping a whole cell at a time.
  const playerCell = { x: player.x + floor.W / 2 - 0.5, y: player.z + floor.H / 2 - 0.5 };
  const centre = cellsAcross > 0 ? playerCell : { x: floor.W / 2 - 0.5, y: floor.H / 2 - 0.5 };
  const theta = VIEW_ROT + rot;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const originX = cw / 2 + panX, originY = ch / 2 + panY;

  // Cell centre -> canvas pixel. Markers are drawn through this rather than inside a canvas
  // transform, so an arrow or a glyph keeps its pixel size at any zoom instead of scaling with
  // the map.
  const project = (cellX, cellY) => {
    const dx = cellX + 0.5 - (centre.x + 0.5), dy = cellY + 0.5 - (centre.y + 0.5);
    return [originX + (dx * cos - dy * sin) * scale, originY + (dx * sin + dy * cos) * scale];
  };
  // The same rotation applied to a direction, for the player arrow's heading.
  const rotateDir = (dx, dy) => [dx * cos - dy * sin, dx * sin + dy * cos];

  // The cached terrain, blitted once through the view transform. Smoothing stays OFF to match the
  // `image-rendering: pixelated` the minimap and floor map canvases already carry in CSS.
  const terrain = terrainCanvas(floor);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(originX, originY);
  ctx.rotate(theta);
  ctx.scale(scale, scale);
  ctx.translate(-(centre.x + 0.5), -(centre.y + 0.5));
  ctx.drawImage(terrain, 0, 0);
  ctx.restore();

  const dot = (cellX, cellY, color, r, ring = null) => {
    const [px, py] = project(cellX, cellY);
    if (ring) {
      ctx.fillStyle = ring;
      ctx.beginPath(); ctx.arc(px, py, r + 1.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
  };

  // Stairs plate, once the tile has been seen.
  if (isSeen(floor, floor.stairsCell.x, floor.stairsCell.y)) {
    const [px, py] = project(floor.stairsCell.x, floor.stairsCell.y);
    const s = Math.max(5, scale * 3);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(theta);
    ctx.fillStyle = '#4ee0a8';
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.restore();
  }

  // Kecleon's stall. A bordered gold plate rather than a dot, because it is a PLACE and has to
  // read differently from the loot lying on the floor.
  if (floor.shop && (floor.entitiesRevealed || isSeen(floor, floor.shop.cx, floor.shop.cy))) {
    const [px, py] = project(floor.shop.cx, floor.shop.cy);
    const s = Math.max(6, scale * 3);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(theta);
    ctx.fillStyle = '#4a3208';
    ctx.fillRect(-s / 2 - 1, -s / 2 - 1, s + 2, s + 2);
    ctx.fillStyle = '#ffd54f';
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.fillStyle = '#4a3208';
    ctx.fillRect(-s / 6, -s / 6, s / 3, s / 3);
    ctx.restore();
  }

  // Chansey's rest stop. A PLATE like the stall's, because it is the other place worth walking to,
  // but pink and round against the stall's gold square so the two never have to be told apart by
  // position. A spent one goes hollow — the ring stays so you remember it was there and do not
  // walk back, which is the same job the dimmed light does in 3D.
  if (floor.chansey && (floor.entitiesRevealed || isSeen(floor, floor.chansey.cx, floor.chansey.cy))) {
    const [px, py] = project(floor.chansey.cx, floor.chansey.cy);
    const rr = Math.max(3.5, scale * 1.6);
    ctx.save();
    ctx.translate(px, py);
    ctx.beginPath();
    ctx.arc(0, 0, rr + 1, 0, Math.PI * 2);
    ctx.fillStyle = '#5c2036';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, Math.PI * 2);
    if (floor.chansey.used) {
      ctx.strokeStyle = '#a86a80';
      ctx.lineWidth = Math.max(1, rr * 0.34);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#ff9ec0';
      ctx.fill();
    }
    ctx.restore();
  }

  const showEntity = (x, y) => floor.entitiesRevealed || isSeen(floor, x, y);
  const r = Math.max(1.8, scale * 0.62);

  // Pickups. On the MINIMAP all three kinds share one gold loot dot: at 3px there is no room for
  // a distinction, and what the minimap is for is "there is something over there". The pause map
  // (`detail`) is where knowing WHICH matters, and there each kind gets its own colour and shape.
  for (const it of floor.items) {
    if (it.taken || !showEntity(it.x, it.y)) continue;
    if (!detail) { dot(it.x, it.y, '#ffd95e', r); continue; }
    const [px, py] = project(it.x, it.y);
    if (it.kind === 'ball') {
      ctx.fillStyle = '#17101f';
      ctx.beginPath(); ctx.arc(px, py, r + 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e5453b';
      ctx.beginPath(); ctx.arc(px, py, r, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#f2f4ff';
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI); ctx.fill();
    } else if (it.kind === 'coin') {
      dot(it.x, it.y, '#ffd54f', r, '#4a3208');
      ctx.fillStyle = '#4a3208';
      ctx.beginPath(); ctx.arc(px, py, Math.max(0.8, r * 0.36), 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#17101f';
      ctx.fillRect(-r - 1, -r - 1, (r + 1) * 2, (r + 1) * 2);
      ctx.fillStyle = '#ffd95e';
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }
  }

  for (const w of floor.wilds) {
    if (w.gone) continue;
    const c = worldToCell(floor, w.x, w.z);
    if (!showEntity(c.x, c.y)) continue;
    dot(c.x, c.y, w.aggressive ? '#c060f0' : '#7fd0ff', r);
  }

  // The Team Rocket R, on the stairs, for as long as their boss is still standing on them.
  if (!floor.cleared && isSeen(floor, floor.stairsCell.x, floor.stairsCell.y)) {
    const [px, py] = project(floor.stairsCell.x, floor.stairsCell.y);
    drawPixelGlyph(ctx, ROCKET_R, px, py, Math.max(1, Math.round(scale * 0.62)), '#e5453b', '#2a0a0c');
  }

  // The player, last and always on top: a GREEN ARROW pointing where they are facing.
  //
  // `heading` is the same angle main.js writes to the player model's rotation.y, i.e. atan2 of the
  // movement direction's (x, z) — so the world direction is (sin, cos). Pushing that through the
  // same rotation the map uses means the arrow on the map points the same way as the Pokemon does
  // on screen, which is the entire point of orienting the map to the view.
  {
    const [px, py] = project(playerCell.x, playerCell.y);
    const [ax, ay] = rotateDir(Math.sin(heading), Math.cos(heading));
    const a = Math.atan2(ay, ax);
    const s = Math.max(5.5, Math.min(11, scale * 1.5));
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(s, 0);
    ctx.lineTo(-s * 0.72, s * 0.78);
    ctx.lineTo(-s * 0.34, 0);
    ctx.lineTo(-s * 0.72, -s * 0.78);
    ctx.closePath();
    ctx.fillStyle = '#3ddc6b';
    ctx.strokeStyle = '#08260f';
    ctx.lineWidth = Math.max(1, s * 0.22);
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  if (detail) {
    // The floor's outline, so a zoomed-out map shows where the rock ends.
    ctx.save();
    ctx.translate(originX, originY);
    ctx.rotate(theta);
    ctx.scale(scale, scale);
    ctx.translate(-(centre.x + 0.5), -(centre.y + 0.5));
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, floor.W, floor.H);
    ctx.restore();
  }
}
