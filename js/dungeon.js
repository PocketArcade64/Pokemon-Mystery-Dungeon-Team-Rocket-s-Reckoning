// Procedural floor generation, the 3D build-out, collision, fog-of-war and wild-Pokemon wander.
//
// IMPORTANT SHAPE NOTE: floors are OPEN ROOMS joined by WIDE (3-cell) CONNECTORS. They are
// deliberately NOT classic Mystery Dungeon single-tile hallways — free continuous movement needs
// room to breathe, and 1-tile corridors force exactly the grid-snapped feel this game avoids.
//
// The grid is an INTERNAL structure only. It exists for four things and nothing else:
//   1. generation, 2. item/Pokemon spawn placement, 3. minimap fog-of-war cells, 4. wall collision.
// Neither the player nor any wild Pokemon is ever snapped to it — positions are plain floats.
import * as THREE from 'three';
import { createMonObject, disposeObject } from './models.js';
import { randomItemId } from './data/items.js';
import { CATALOG_BY_DEX, POKEMON_CATALOG } from './data/pokemon-catalog.js';
import { TYPE_COLOR } from './data/type-chart.js';
import { hemiLight, dirLight, scene } from './three-setup.js';

export const WALL = 0, FLOOR = 1, PROP = 2;   // collision grid values
const PLAYER_RADIUS = 0.34;

// ---- The eleven floor themes (design brief §10, plus a beach) -----------------------------------
// `types` drives which species can spawn as wild Pokemon on that floor. Colors are all we have to
// build atmosphere with: there are no themed environment assets, so every floor is Three.js
// primitives tinted per theme with light prop dressing.
export const THEMES = [
  { id: 'verdant',  name: 'Verdant Forest',  types: ['Grass', 'Bug'],
    floorA: 0x4e7a3a, floorB: 0x456f33, wall: 0x2f4a25, wallTop: 0x3d5f2e,
    fog: 0x16240f, sky: 0xbfe0a0, ground: 0x2d4020, light: 0xfff3d0, prop: 'tree' },
  { id: 'rocky',    name: 'Rocky Cavern',    types: ['Rock', 'Ground'],
    floorA: 0x6d6152, floorB: 0x625748, wall: 0x413a32, wallTop: 0x554c41,
    fog: 0x1d1a16, sky: 0x9d9384, ground: 0x3a342c, light: 0xffeecc, prop: 'boulder' },
  { id: 'molten',   name: 'Molten Caldera',  types: ['Fire'],
    floorA: 0x59322a, floorB: 0x4d2a23, wall: 0x331914, wallTop: 0x6b2f1f,
    fog: 0x1c0906, sky: 0xff9a4a, ground: 0x4a1a10, light: 0xffd0a0, prop: 'lava' },
  { id: 'frozen',   name: 'Frozen Grotto',   types: ['Ice'],
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
  { id: 'beach',    name: 'Sunlit Shore',    types: ['Water', 'Ground'],
    floorA: 0xe0cb95, floorB: 0xd3bd85, wall: 0x9c7f4f, wallTop: 0x3f9fbf,
    fog: 0x2a4a55, sky: 0xbfe9ff, ground: 0x6b5a34, light: 0xfff4d8, prop: 'palm' },
];

// Pick 5 distinct themes for a run (no repeats), in a random order.
export function pickRunThemes(count = 5) {
  const pool = THEMES.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

const rnd = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- Generation --------------------------------------------------------------------------------
// Floors grow with depth (design brief §4: "bigger layouts"), staying small and legible on floor 1.
export function generateFloor(floorNumber, theme) {
  const W = 30 + floorNumber * 5;
  const H = 30 + floorNumber * 5;
  const cells = new Uint8Array(W * H);            // WALL by default
  const at = (x, y) => y * W + x;

  // 1. Rooms: rejection-sample non-overlapping rectangles with a 2-cell gap so walls stay solid.
  const rooms = [];
  const targetRooms = 5 + floorNumber;
  for (let tries = 0; tries < 400 && rooms.length < targetRooms; tries++) {
    const w = rndInt(7, 12), h = rndInt(7, 12);
    const x = rndInt(2, W - w - 3), y = rndInt(2, H - h - 3);
    const r = { x, y, w, h, cx: Math.floor(x + w / 2), cy: Math.floor(y + h / 2) };
    const clash = rooms.some(o =>
      x - 2 < o.x + o.w && x + w + 2 > o.x && y - 2 < o.y + o.h && y + h + 2 > o.y);
    if (!clash) rooms.push(r);
  }
  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cells[at(x, y)] = FLOOR;
  }

  // 2. Connectors, 3 cells wide. Chain every room to the previous one so the floor is always
  //    fully connected, then add a couple of random extra links so layouts aren't pure trees.
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
  for (let i = 1; i < rooms.length; i++) connect(rooms[i - 1], rooms[i]);
  for (let i = 0; i < Math.min(2, rooms.length - 2); i++) {
    const a = pick(rooms), b = pick(rooms);
    if (a !== b) connect(a, b);
  }

  // 3. Start and stairs go in the two furthest-apart rooms, so no floor is a two-step walk.
  let startRoom = rooms[0], stairsRoom = rooms[rooms.length - 1], best = -1;
  for (const a of rooms) for (const b of rooms) {
    const d = (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2;
    if (d > best) { best = d; startRoom = a; stairsRoom = b; }
  }
  const startCell = { x: startRoom.cx, y: startRoom.cy };
  const stairsCell = { x: stairsRoom.cx, y: stairsRoom.cy };

  const floor = {
    number: floorNumber, theme, W, H, cells, rooms, startCell, stairsCell,
    visited: new Uint8Array(W * H),
    mapRevealed: false,          // Town Map
    entitiesRevealed: false,     // Dowsing Machine
    items: [], wilds: [], props: [],
    boss: null,
    group: null,
    cleared: false,
  };

  // 4. Props. Only interior cells (every 8-neighbour is floor) are eligible, which guarantees
  //    blocking one can never split the floor in two — it is always a pillar inside open space.
  const isInterior = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (cells[at(x + dx, y + dy)] !== FLOOR) return false;
    }
    return true;
  };
  const farFrom = (c, x, y, d) => Math.abs(c.x - x) > d || Math.abs(c.y - y) > d;
  const propTarget = 12 + floorNumber * 4;
  for (let tries = 0; tries < propTarget * 30 && floor.props.length < propTarget; tries++) {
    const x = rndInt(2, W - 3), y = rndInt(2, H - 3);
    if (!isInterior(x, y)) continue;
    if (!farFrom(startCell, x, y, 3) || !farFrom(stairsCell, x, y, 3)) continue;
    cells[at(x, y)] = PROP;
    floor.props.push({ x, y, rot: rnd(0, Math.PI * 2), scale: rnd(0.85, 1.25) });
  }

  // 5. Item and wild-Pokemon spawn points, on free floor cells away from the start.
  const freeCell = (minDistFromStart = 5) => {
    for (let tries = 0; tries < 300; tries++) {
      const r = pick(rooms);
      const x = rndInt(r.x, r.x + r.w - 1), y = rndInt(r.y, r.y + r.h - 1);
      if (cells[at(x, y)] !== FLOOR) continue;
      if (Math.hypot(x - startCell.x, y - startCell.y) < minDistFromStart) continue;
      if (x === stairsCell.x && y === stairsCell.y) continue;
      return { x, y };
    }
    return null;
  };

  const itemCount = 4 + floorNumber;
  for (let i = 0; i < itemCount; i++) {
    const c = freeCell(4);
    if (c) floor.items.push({ x: c.x, y: c.y, itemId: randomItemId(), taken: false, obj: null, bob: rnd(0, 6.28) });
  }

  // Wild pool: species whose typing matches the theme, so a Frozen Grotto reads as an ice floor.
  //
  // Gated by evolution stage on top of that, and this gate is load-bearing rather than flavour:
  // damage is stage-only, so a Stage 1 wild (50 HP, 10 dmg) against a lone Basic starter (30 HP,
  // 5 dmg) is not a hard fight, it is an arithmetically impossible one — and aggressive wilds
  // chase, so it cannot even be walked away from. Floors 1-2 are therefore Basic-only, which is
  // what "stays forgiving early on" (design brief §4) has to mean in practice.
  // Legendaries never wander at all; they are Giovanni's, not the floor's.
  const allowedStages = floorNumber <= 2 ? ['Basic']
    : floorNumber === 3 ? ['Basic', 'Stage1']
    : ['Stage1', 'Stage2'];
  const inStage = POKEMON_CATALOG.filter(p => allowedStages.includes(p.stage));
  const themed = inStage.filter(p => p.types.some(t => theme.types.includes(t)));
  const wildPool = themed.length >= 6 ? themed : inStage;
  const wildCount = 4 + floorNumber * 2;
  const aggroChance = 0.2 + floorNumber * 0.08;   // ramps with depth, forgiving on floors 1-2
  for (let i = 0; i < wildCount; i++) {
    const c = freeCell(6);
    if (!c) continue;
    const species = pick(wildPool);
    floor.wilds.push({
      dex: species.dex,
      aggressive: Math.random() < aggroChance,
      homeX: c.x, homeY: c.y,
      x: c.x - W / 2 + 0.5, z: c.y - H / 2 + 0.5,
      dirX: 0, dirZ: 0, retarget: 0,
      obj: null, aura: null, defeated: false, gone: false,
    });
  }

  return floor;
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
export function revealAround(floor, x, z, radius = 6) {
  const c = worldToCell(floor, x, z);
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= floor.W || ny >= floor.H) continue;
      floor.visited[ny * floor.W + nx] = 1;
    }
  }
}

export function isSeen(floor, cx, cy) {
  if (floor.mapRevealed) return true;
  if (cx < 0 || cy < 0 || cx >= floor.W || cy >= floor.H) return false;
  return floor.visited[cy * floor.W + cx] === 1;
}

// ---- A* on the grid, for tap-to-move ----------------------------------------------------------
// Only used to produce a coarse waypoint list; movement.js then steers the player smoothly along
// it with float positions. 4-directional, since diagonal steps could clip a wall corner.
export function findPath(floor, from, to) {
  const { W, H } = floor;
  const idx = (c) => c.y * W + c.x;
  if (cellValue(floor, to.x, to.y) !== FLOOR) return null;
  const startI = idx(from), goalI = idx(to);
  if (startI === goalI) return [];

  const gScore = new Float32Array(W * H).fill(Infinity);
  const cameFrom = new Int32Array(W * H).fill(-1);
  gScore[startI] = 0;
  const h = (i) => Math.abs((i % W) - to.x) + Math.abs(Math.floor(i / W) - to.y);
  const open = [startI];
  const fScore = new Float32Array(W * H).fill(Infinity);
  fScore[startI] = h(startI);
  const inOpen = new Uint8Array(W * H);
  inOpen[startI] = 1;

  while (open.length) {
    // Linear scan for the lowest f. Grids here top out near 55x55, so a heap is not worth it.
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (fScore[open[i]] < fScore[open[bi]]) bi = i;
    const cur = open.splice(bi, 1)[0];
    inOpen[cur] = 0;
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
      if (!inOpen[ni]) { open.push(ni); inOpen[ni] = 1; }
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

// The up-stairs: a stepped plinth with a glowing lip, sized so a trainer stands on top of it.
function makeStairs(theme) {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: theme.wallTop });
  for (let i = 0; i < 3; i++) {
    const s = 2.2 - i * 0.5;
    const m = new THREE.Mesh(new THREE.BoxGeometry(s, 0.18, s), stone);
    m.position.y = 0.09 + i * 0.18;
    m.receiveShadow = true; m.castShadow = true;
    g.add(m);
  }
  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 0.04, 1.3),
    new THREE.MeshBasicMaterial({ color: 0x9ff2d0, transparent: true, opacity: 0.75 }),
  );
  glow.position.y = 0.56;
  g.add(glow);
  const light = new THREE.PointLight(0x7fe8c0, 1.2, 8);
  light.position.y = 1.2;
  g.add(light);
  return g;
}

// Item pickups render as a floating, slowly spinning gem in the item's own accent color. The bag
// and glossary use the SVG art from items.js; in-world we just need a readable "something's here".
function makeItemMarker() {
  const g = new THREE.Group();
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.26, 0),
    new THREE.MeshStandardMaterial({ color: 0xffd95e, flatShading: true, emissive: 0x6a4c00 }),
  );
  gem.position.y = 0.5;
  gem.castShadow = true;
  g.add(gem);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.42, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe58a, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  g.add(ring);
  g.userData.gem = gem;
  return g;
}

// The purple aura/cloud that marks an aggressive wild Pokemon (design brief §7).
// Sized off the creature's own height: a fixed-size aura disappears INSIDE a big model like
// Venusaur, which defeats the entire point of the marker. The ground ring does most of the work,
// since it is the one part an overhead camera can always see.
function makeAura(height = 0.85) {
  const g = new THREE.Group();
  const s = height / 0.85;
  const puffMat = new THREE.MeshBasicMaterial({
    color: 0xc264f5, transparent: true, opacity: 0.34, depthWrite: false,
  });
  const orbit = 0.62 * s;
  for (let i = 0; i < 6; i++) {
    const r = (0.2 + Math.random() * 0.13) * s;
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 6), puffMat);
    const a = (i / 6) * Math.PI * 2;
    puff.position.set(Math.cos(a) * orbit, height * (0.5 + Math.sin(a * 2) * 0.22), Math.sin(a) * orbit);
    g.add(puff);
  }
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55 * s, 0.88 * s, 24),
    new THREE.MeshBasicMaterial({
      color: 0xc264f5, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  g.add(ring);
  return g;
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
// scene. Floor tiles and walls are single InstancedMeshes — a 55x55 floor is ~2500 tiles, which
// would be a disaster as individual meshes and is two draw calls this way.
export function buildFloor(floor) {
  const { W, H, theme } = floor;
  const group = new THREE.Group();

  const floorCells = [];
  const wallCells = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = floor.cells[y * W + x];
      if (v === FLOOR || v === PROP) { floorCells.push([x, y]); continue; }
      // Only walls that actually touch open space are drawn — the solid rock behind them is
      // never visible from an overhead camera, and skipping it roughly halves the instance count.
      let borders = false;
      for (let dy = -1; dy <= 1 && !borders; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = cellValue(floor, x + dx, y + dy);
          if (n === FLOOR || n === PROP) { borders = true; break; }
        }
      }
      if (borders) wallCells.push([x, y]);
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

  const wallMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 2.4, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }),
    wallCells.length,
  );
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  wallCells.forEach(([x, y], i) => {
    const w = cellToWorld(floor, x, y);
    m4.makeTranslation(w.x, 1.0, w.z);
    wallMesh.setMatrixAt(i, m4);
    // Slight per-instance value jitter so a long wall isn't one flat slab of color.
    const jitter = 0.88 + ((x * 7 + y * 13) % 5) * 0.05;
    wallMesh.setColorAt(i, col.setHex(theme.wall).multiplyScalar(jitter));
  });
  wallMesh.instanceMatrix.needsUpdate = true;
  if (wallMesh.instanceColor) wallMesh.instanceColor.needsUpdate = true;
  group.add(wallMesh);

  for (const p of floor.props) {
    const obj = makeProp(theme.prop, theme);
    const w = cellToWorld(floor, p.x, p.y);
    obj.position.set(w.x, 0, w.z);
    obj.rotation.y = p.rot;
    obj.scale.setScalar(p.scale);
    group.add(obj);
  }

  const stairs = makeStairs(theme);
  const sw = cellToWorld(floor, floor.stairsCell.x, floor.stairsCell.y);
  stairs.position.set(sw.x, 0, sw.z);
  group.add(stairs);
  floor.stairsObj = stairs;

  for (const it of floor.items) {
    const marker = makeItemMarker();
    const w = cellToWorld(floor, it.x, it.y);
    marker.position.set(w.x, 0, w.z);
    group.add(marker);
    it.obj = marker;
  }

  for (const wild of floor.wilds) {
    const c = CATALOG_BY_DEX.get(wild.dex);
    const height = c && c.stage === 'Stage2' ? 1.15 : c && c.stage === 'Stage1' ? 1.0 : 0.85;
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
  floor.group.traverse(o => {
    if (o.isInstancedMesh || o.isMesh) {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      // Quest model materials are shared through the loader cache; only dispose the primitives we
      // built ourselves here (they are never in that cache).
      mats.forEach(m => { if (m && !m.map) m.dispose?.(); });
    }
  });
  floor.group.parent?.remove(floor.group);
  floor.group = null;
}

// ---- Wild Pokemon wander ----------------------------------------------------------------------
// Free continuous movement, exactly like the player: they pick a heading, walk it until they hit
// something or the timer runs out, and never snap to a cell. Aggressive ones home in on the
// player when close, unless Max Repel is active.
export function updateWilds(floor, dt, player, { repelled = false } = {}) {
  const WANDER_SPEED = 1.5, CHASE_SPEED = 2.5, RADIUS = 0.32;
  for (const w of floor.wilds) {
    if (w.gone || !w.obj) continue;
    const toPlayer = Math.hypot(player.x - w.x, player.z - w.z);
    const chasing = w.aggressive && !repelled && toPlayer < 7;

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
    if (w.aura) w.aura.rotation.y += dt * 1.6;
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

// Animate the decorative bits: bobbing item gems and the spinning stairs glow.
export function updateFloorDecor(floor, dt, elapsed) {
  for (const it of floor.items) {
    if (it.taken || !it.obj) continue;
    it.obj.userData.gem.position.y = 0.5 + Math.sin(elapsed * 2 + it.bob) * 0.12;
    it.obj.userData.gem.rotation.y += dt * 1.4;
  }
  if (floor.stairsObj) floor.stairsObj.rotation.y += dt * 0.25;
}

// ---- Minimap / pause map rendering -------------------------------------------------------------
// Both the little always-on minimap and the full pause map come through here; `detail` switches on
// the extras that only make sense at the bigger size.
export function drawMap(ctx, floor, player, { detail = false } = {}) {
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  ctx.clearRect(0, 0, cw, ch);
  const cell = Math.min(cw / floor.W, ch / floor.H);
  const ox = (cw - cell * floor.W) / 2, oy = (ch - cell * floor.H) / 2;

  ctx.fillStyle = 'rgba(8,10,16,0.72)';
  ctx.fillRect(0, 0, cw, ch);

  for (let y = 0; y < floor.H; y++) {
    for (let x = 0; x < floor.W; x++) {
      if (!isSeen(floor, x, y)) continue;
      const v = floor.cells[y * floor.W + x];
      if (v === WALL) {
        // Only draw walls that border seen open space, so the map reads as carved rooms.
        if (cellValue(floor, x + 1, y) === WALL && cellValue(floor, x - 1, y) === WALL
          && cellValue(floor, x, y + 1) === WALL && cellValue(floor, x, y - 1) === WALL) continue;
        ctx.fillStyle = '#39405a';
      } else if (v === PROP) {
        ctx.fillStyle = '#5a6480';
      } else {
        ctx.fillStyle = '#c8d4ee';
      }
      ctx.fillRect(ox + x * cell, oy + y * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }

  const dot = (cx, cy, color, r) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ox + (cx + 0.5) * cell, oy + (cy + 0.5) * cell, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // Stairs marker, once the tile has been seen.
  if (isSeen(floor, floor.stairsCell.x, floor.stairsCell.y)) {
    ctx.fillStyle = '#4ee0a8';
    const sx = ox + floor.stairsCell.x * cell, sy = oy + floor.stairsCell.y * cell;
    ctx.fillRect(sx - cell, sy - cell, cell * 3, cell * 3);
  }

  const showEntity = (x, y) => floor.entitiesRevealed || isSeen(floor, x, y);
  for (const it of floor.items) {
    if (it.taken || !showEntity(it.x, it.y)) continue;
    dot(it.x, it.y, '#ffd95e', Math.max(1.6, cell * 0.7));
  }
  for (const w of floor.wilds) {
    if (w.gone) continue;
    const c = worldToCell(floor, w.x, w.z);
    if (!showEntity(c.x, c.y)) continue;
    dot(c.x, c.y, w.aggressive ? '#c060f0' : '#7fd0ff', Math.max(1.6, cell * 0.7));
  }
  if (!floor.cleared) {
    dot(floor.stairsCell.x, floor.stairsCell.y, '#e5453b', Math.max(2, cell * 0.9));
  }

  // Player last, always on top.
  const pc = worldToCell(floor, player.x, player.z);
  dot(pc.x, pc.y, '#ffffff', Math.max(2.2, cell * 1.0));

  if (detail) {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, cell * floor.W, cell * floor.H);
  }
}
