// Free Catch: one dungeon room, seven wild Pokemon wandering it, a fixed bag of balls, and nothing at
// stake. Reached from Settings. Tap a Pokemon to open the catch minigame on it.
//
// This module owns the ROOM and everything that happens in it — building it, the seven wanderers,
// how each of them moves, keeping them from walking through one another, the camera (the dungeon's own
// angle, turned by a drag) that frames the whole room on one screen, and turning a tap into "which
// Pokemon". The catch itself is the same catch.js minigame a run uses; main.js starts it and routes
// its result back here.
//
// It reuses the dungeon's own pieces rather than drawing a room of its own: the room is a real floor
// object handed to buildFloor, so its tiles, walls, props, theme lighting and Pokemon models are the
// dungeon's exactly. What it does NOT reuse is updateWilds — that walks one kind of wanderer at one
// speed and has no wild-vs-wild collision, and both of those are the point here.
import * as THREE from 'three';
import { THEMES, FLOOR, PROP, buildFloor, disposeFloor, cellToWorld, isPointWalkable } from './dungeon.js';
import { POKEMON_CATALOG } from './data/pokemon-catalog.js';
import { hasModelForDex } from './models.js';
import { scene, dirLight, CAM_OFFSET } from './three-setup.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- The room ----------------------------------------------------------------------------------
// A ROUGH CIRCLE, different every time — not a rectangle. Every room is a circle of ROOM_R cells
// pushed out of shape three ways, each rolled fresh per room:
//   - stretched into an ellipse (up to 14% either way) along a random axis;
//   - wobbled at its edge by four low-frequency lobes (2 to 5 bumps round the rim), small enough
//     that it stays a room and large enough that no two come out alike;
//   - then smoothed once and tidied, so the rim has no single-cell spurs or notches and the room is
//     one piece with no holes in it.
// It sits in ROCK_REACH cells of solid rock all round, which is what makes it read as a room carved
// out of the dungeon rather than a tray floating in fog — the dungeon fills every solid cell for exactly
// this reason (see the note in buildFloor).
//
// Round suits it twice over. The view can be TURNED (drag), and a circle looks right from every
// angle where a long room would swing wide; and the framing below can then fit the room's
// circumscribed circle, which bounds it at every angle the view can reach.
const ROOM_R = 4.6;
// How far the solid rock reaches from the room's centre, in every direction. FAR further than the
// room: at the dungeon's angle the camera sees the ground ~21 units out along its view direction on a
// portrait phone, and the view TURNS, so that direction can be any direction. Stopping short of it
// showed the edge of the rock as a hard diamond against the void. Out at 24 the rock runs on into
// the theme's fog (which starts 22 out from the camera) and fades instead of ending. That is ~2400
// solid cells, which buildFloor instances in three draw calls the way it does a 15000-cell floor.
const ROCK_REACH = 24;
const GRID = 2 * ROCK_REACH + 1;                            // square and odd, so it has a centre cell
// Pokemon are drawn bigger than on a dungeon floor (WORLD_MON_BASE, 1.0). The 'world' fit keeps their
// proportions either way; this is a stage you tap on, and at the dungeon's angle a round room on a
// portrait screen is held to the screen's width — so the Pokemon carry the size the room cannot.
const MON_BASE = 1.45;
const CAST_SIZE = 7;
const PROP_COUNT = 5;

function blobMask() {
  const c = (GRID - 1) / 2;
  const stretch = rnd(0.86, 1.14);
  const tilt = rnd(0, Math.PI);
  const lobes = [[2, 0.11], [3, 0.08], [4, 0.05], [5, 0.04]]
    .map(([k, max]) => ({ k, a: rnd(0.02, max), p: rnd(0, Math.PI * 2) }));
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  let open = new Uint8Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const dx = x - c, dy = y - c;
      // Into the ellipse's own frame: squash one axis and stretch the other, so the area is kept.
      const u = (dx * ct + dy * st) / stretch, v = (-dx * st + dy * ct) * stretch;
      const th = Math.atan2(v, u);
      let r = ROOM_R;
      for (const l of lobes) r += ROOM_R * l.a * Math.sin(l.k * th + l.p);
      if (Math.hypot(u, v) <= r) open[y * GRID + x] = 1;
    }
  }
  // One majority pass over the 8 neighbours: rounds off single-cell spurs and fills single-cell bites.
  const n8 = (m, x, y) => {
    let s = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      if ((i || j) && m[(y + j) * GRID + (x + i)]) s++;
    }
    return s;
  };
  const smooth = new Uint8Array(GRID * GRID);
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      const s = n8(open, x, y), k = y * GRID + x;
      smooth[k] = s >= 5 ? 1 : s <= 3 ? 0 : open[k];
    }
  }
  open = smooth;
  // ONE piece: keep only the largest 4-connected region...
  const comp = new Int32Array(GRID * GRID).fill(-1);
  let bestId = -1, bestSize = 0;
  for (let k = 0, id = 0; k < open.length; k++) {
    if (!open[k] || comp[k] >= 0) continue;
    let size = 0;
    const q = [k];
    comp[k] = id;
    while (q.length) {
      const cur = q.pop(); size++;
      const cx = cur % GRID, cy = (cur - cx) / GRID;
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        const nk = ny * GRID + nx;
        if (open[nk] && comp[nk] < 0) { comp[nk] = id; q.push(nk); }
      }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
    id++;
  }
  for (let k = 0; k < open.length; k++) if (open[k] && comp[k] !== bestId) open[k] = 0;
  // ...with NO holes: rock the border cannot reach is a pocket enclosed by the room, so it is room.
  const reach = new Uint8Array(GRID * GRID);
  const q = [];
  for (let i = 0; i < GRID; i++) q.push(i, (GRID - 1) * GRID + i, i * GRID, i * GRID + GRID - 1);
  for (const k of q) reach[k] = 1;
  while (q.length) {
    const cur = q.pop();
    const cx = cur % GRID, cy = (cur - cx) / GRID;
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      const nk = ny * GRID + nx;
      if (!open[nk] && !reach[nk]) { reach[nk] = 1; q.push(nk); }
    }
  }
  for (let k = 0; k < open.length; k++) if (!open[k] && !reach[k]) open[k] = 1;
  return open;
}

function buildRoomFloor(theme) {
  const open = blobMask();
  const cells = new Uint8Array(GRID * GRID);              // WALL (0) everywhere
  for (let k = 0; k < cells.length; k++) if (open[k]) cells[k] = FLOOR;
  const at = (x, y) => (x < 0 || y < 0 || x >= GRID || y >= GRID) ? 0 : cells[y * GRID + x];
  const floor = {
    number: 1, theme, W: GRID, H: GRID, cells, rooms: [], startCell: null,
    stairsCell: null,                                       // no stairwell: see buildFloor
    visited: new Uint8Array(GRID * GRID),
    items: [], wilds: [], props: [], outcrops: [],
    shop: null, chansey: null, boss: null, group: null, cleared: false,
    mapDirty: [], mapCache: null,
    monBase: MON_BASE,
  };

  // A few of the theme's props on the rim — the tree, the boulder, the crate — so the room is
  // recognisably THAT dungeon. Rim cells only (open, with rock beside them) and at least three cells
  // apart, so they dress the edge in ones rather than walling off a stretch of it.
  const rim = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (at(x, y) === FLOOR && (!at(x + 1, y) || !at(x - 1, y) || !at(x, y + 1) || !at(x, y - 1))) rim.push([x, y]);
    }
  }
  const props = [];
  for (const s of shuffled(rim)) {
    if (props.length >= PROP_COUNT) break;
    if (props.every(p => Math.hypot(p[0] - s[0], p[1] - s[1]) >= 3)) props.push(s);
  }
  for (const [x, y] of props) {
    cells[y * GRID + x] = PROP;
    floor.props.push({ x, y, rot: rnd(0, Math.PI * 2), scale: rnd(0.8, 1.05) });
  }

  // Where a Pokemon may START: cells whose whole 3x3 block is open floor (no rock, no prop), so even
  // the widest body — radius ~1 — starts clear of everything.
  const spots = [];
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      let clear = true;
      for (let j = -1; j <= 1 && clear; j++) for (let i = -1; i <= 1; i++) if (at(x + i, y + j) !== FLOOR) { clear = false; break; }
      if (clear) spots.push([x, y]);
    }
  }

  // How far the room reaches from its centre, wall included — the circle that bounds it at every
  // angle the view can turn to, and what the camera frames.
  const c = (GRID - 1) / 2;
  let reach = 0;
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    if (at(x, y)) reach = Math.max(reach, Math.hypot(x - c, y - c));
  }
  // +0.7: the floor's own edge is half a cell past the outermost cell centre, plus a little air. The
  // wall ring beyond it is not framed — it is rock, and the rock is everywhere.
  return { floor, spots, frameR: reach + 0.7 };
}

// ---- The cast ------------------------------------------------------------------------------------
// Seven different species from the WHOLE catalog — no theme typing, so any Pokemon can turn up in any
// room — and exactly one of them a Legendary or Mythical. The other six are drawn from everything
// else, so the special one is guaranteed AND unambiguous. Only species with a model are eligible
// (every catalog species has one today; the filter is what keeps that true).
function pickCast() {
  const pool = POKEMON_CATALOG.filter(c => hasModelForDex(c.dex));
  const legend = pick(pool.filter(c => c.stage === 'Legendary'));
  const others = shuffled(pool.filter(c => c.stage !== 'Legendary')).slice(0, CAST_SIZE - 1);
  // The Legendary goes FIRST, and it is not shuffled in. Where each one stands is already random
  // (the spawn spots are), so the order only ever mattered for one thing: who gets left out if the
  // room runs short of spots. That must never be the Legendary — a shuffled cast once dropped it.
  return [legend, ...others];
}

// ---- How each one moves --------------------------------------------------------------------------
// Different paces AND different kinds of movement, so the room reads as seven animals rather than
// seven copies of one wander loop. Each Pokemon gets one style and its own speed within it:
//
//   wander  the dungeon's walk — a new heading every second or two, with idle beats
//   dash    mostly standing still, then a short sprint somewhere
//   circle  never stops; turns steadily, and now and then reverses the turn
//   hop     a bouncing walk
//   glide   THE LEGENDARY'S, and only its: slow, unhurried curves and a gentle hover off the floor,
//           so the one that matters is visibly not like the others
const STYLES = ['wander', 'dash', 'circle', 'hop'];

function assignMotion(w, legendary) {
  w.style = legendary ? 'glide' : pick(STYLES);
  const pace = rnd(0.8, 1.25);                 // per-Pokemon on top of the style's own speed
  w.speed = pace * ({ wander: 1.3, dash: 3.4, circle: 1.2, hop: 1.5, glide: 0.75 })[w.style];
  w.heading = rnd(0, Math.PI * 2);
  w.yaw = w.heading;
  w.turn = (Math.random() < 0.5 ? -1 : 1) * rnd(0.7, 1.4);   // circle / glide turn rate, rad/s
  w.moving = w.style !== 'dash';
  w.timer = rnd(0.3, 1.5);
  w.t = rnd(0, 10);                            // phase for hop / hover, so no two bob in step
  w.r = 0;                                     // body radius, set once the model has loaded
}

// The collision radius, from the body that was actually drawn. Half the AVERAGE of width and depth
// rather than half the longest side: a long species (Vibrava, Gyarados) is a circle that fits its
// middle, not one that fits its tail, otherwise it would bump things a body-length away from it.
function radiusFromFit(fit) {
  return THREE.MathUtils.clamp(0.27 * (fit.width + fit.depth), 0.3, 0.95);
}

// ---- Collision with the room -----------------------------------------------------------------------
// The dungeon's canOccupy tests the four CORNERS of a body's box, which is exact for what it was
// written for — the player, radius 0.34, in a grid of 1-unit cells — and not for anything much
// bigger. Once a radius passes 0.5 the corners are more than a cell apart, so a lone 1-cell prop can
// sit BETWEEN them and the body is passed as clear while standing in it. That was measured here, not
// guessed: Latios (radius 0.93) spent 34 frames in a minute overlapping a tree. Every body in this
// room is 0.3-0.95, so the room tests its own way: a grid of points across the box no more than half
// a cell apart, which no cell can slip through. Seven bodies at up to 25 points each is nothing.
function fits(floor, x, z, r) {
  const n = Math.max(1, Math.ceil((2 * r) / 0.5));
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (!isPointWalkable(floor, x - r + (2 * r * i) / n, z - r + (2 * r * j) / n)) return false;
    }
  }
  return true;
}

// Axis-separated, like the dungeon's moveWithCollision, so a body slides along a wall it meets at an
// angle instead of stopping dead against it.
function slide(floor, pos, dx, dz, r) {
  if (dx !== 0 && fits(floor, pos.x + dx, pos.z, r)) pos.x += dx;
  if (dz !== 0 && fits(floor, pos.x, pos.z + dz, r)) pos.z += dz;
  return pos;
}

// ---- Where they start ------------------------------------------------------------------------------
// `n` spots at least `minD` cells apart, so nobody starts inside anybody else. One greedy pass over a
// shuffled list is NOT enough on its own: an unlucky early pick can box the rest in, and measured
// over 150 rooms a single pass came up one spot short 11% of the time — a room of six. So it retries
// with a fresh shuffle, and only if forty tries at a spacing all fail does it relax the spacing a
// step. In practice the first spacing always succeeds within a few tries; the rest is insurance.
function chooseSpawns(spots, n) {
  let best = [];
  for (const minD of [2.4, 2.0, 1.6]) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const chosen = [];
      for (const s of shuffled(spots)) {
        if (chosen.length >= n) break;
        if (chosen.every(c => Math.hypot(c[0] - s[0], c[1] - s[1]) >= minD)) chosen.push(s);
      }
      if (chosen.length >= n) return chosen;
      if (chosen.length > best.length) best = chosen;
    }
  }
  return best;
}

// ---- Session state -------------------------------------------------------------------------------
let room = null;   // { floor, theme, frameR }

// Build a fresh room: a random theme out of all eleven, its seven Pokemon spread across the floor.
export function startFreeCatchRoom() {
  disposeFreeCatchRoom();
  const theme = pick(THEMES);
  // Spots at least 2.4 apart, out of the cells whose whole 3x3 block is clear (see buildRoomFloor).
  // A room that cannot seat all seven is REROLLED rather than accepted: the shapes are random, and the
  // smallest of them, with props along the rim, came up one seat short about one room in 130. A new
  // shape costs nothing — nothing has been added to the scene yet — and the next one fits.
  let built = null, chosen = [];
  for (let tries = 0; tries < 30 && chosen.length < CAST_SIZE; tries++) {
    built = buildRoomFloor(theme);
    chosen = chooseSpawns(built.spots, CAST_SIZE);
  }
  const { floor, frameR } = built;
  const cast = pickCast();
  cast.slice(0, chosen.length).forEach((c, i) => {
    const [cx, cy] = chosen[i];
    const w = cellToWorld(floor, cx, cy);
    const wild = {
      dex: c.dex, aggressive: false, legendary: c.stage === 'Legendary',
      homeX: cx, homeY: cy, x: w.x + rnd(-0.2, 0.2), z: w.z + rnd(-0.2, 0.2),
      dirX: 0, dirZ: 0, retarget: 0,
    };
    assignMotion(wild, wild.legendary);
    floor.wilds.push(wild);
  });

  scene.add(buildFloor(floor));
  // The dungeon's light follows the player; there is no player here, so it is parked over the
  // room's centre. The shadow camera covers +/-20, which is the whole room with room to spare.
  dirLight.position.set(-6, 16, -6);
  dirLight.target.position.set(0, 0, 0);
  dirLight.target.updateMatrixWorld();
  room = { floor, theme, frameR };
  // Every room opens on the dungeon's own view; a turn from the last room does not carry over.
  viewYaw = 0;
  placeCamera();
  frameCamera();
  return room;
}

export function disposeFreeCatchRoom() {
  if (!room) return;
  disposeFloor(room.floor);
  room = null;
}

export function freeCatchRoom() { return room; }

// A caught Pokemon leaves the room, body and all.
export function removeFromRoom(wild) {
  if (!wild || wild.gone) return;
  wild.gone = true;
  wild.obj?.parent?.remove(wild.obj);
}

export function wildsLeft() {
  return room ? room.floor.wilds.filter(w => !w.gone).length : 0;
}

// ---- The camera ----------------------------------------------------------------------------------
// THE DUNGEON'S ANGLE. Built from CAM_OFFSET in three-setup.js — the same diagonal, the same pitch
// (atan(13 / 15.56), ~40 degrees), the same ~20.3 distance, orthographic like the dungeon's — so a
// room in here looks exactly like a room on a floor. The only differences are that it orbits the
// room's centre rather than following a player, and that a horizontal DRAG turns it (main.js routes
// the drag to turnFreeCatchView). Same distance means the theme's fog sits where it was tuned.
//
// The frustum is solved every frame from the canvas's aspect. It frames the room's CIRCUMSCRIBED
// circle, not its outline at the current angle: the circle bounds the room at every angle the view
// can turn to, so turning never slides the room off the edge of the screen and the zoom never
// changes while you turn. On a portrait phone the width is what binds; on a landscape window, the
// height.
export const freeCatchCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
const CAM_RADIUS = Math.hypot(CAM_OFFSET.x, CAM_OFFSET.z);
const CAM_HEIGHT = CAM_OFFSET.y;
const CAM_BASE_YAW = Math.atan2(CAM_OFFSET.x, CAM_OFFSET.z);
const CAM_PITCH = Math.atan2(CAM_HEIGHT, CAM_RADIUS);
// Radians of turn per pixel dragged: a drag across the full width of a phone is a little over one
// full turn, so the whole room can be walked round in one sweep without being twitchy.
const TURN_PER_PX = 0.018;
// The top HUD (title, tally, balls) takes about the top eighth of a phone and there is nothing along
// the bottom, so the room sits a little below the screen's middle — in the middle of what is left.
const FRAME_SHIFT = 0.12;
let viewYaw = 0;
let framedAspect = 0;

function placeCamera() {
  const a = CAM_BASE_YAW + viewYaw;
  freeCatchCamera.position.set(CAM_RADIUS * Math.sin(a), CAM_HEIGHT, CAM_RADIUS * Math.cos(a));
  freeCatchCamera.lookAt(0, 0, 0);
  freeCatchCamera.updateMatrixWorld(true);
}
placeCamera();

// Turn the view by a horizontal drag of `dxPx` pixels. The sign is chosen so the floor under the
// finger travels WITH the finger, which is what makes it feel like turning the room rather than
// steering a camera.
export function turnFreeCatchView(dxPx) {
  viewYaw -= dxPx * TURN_PER_PX;
  placeCamera();
}

function frameCamera(force = true) {
  const el = document.getElementById('game-canvas');
  const aspect = (el?.clientWidth || window.innerWidth) / (el?.clientHeight || window.innerHeight);
  if (!force && Math.abs(aspect - framedAspect) < 1e-3) return;
  framedAspect = aspect;
  const R = room?.frameR || 7;
  const needW = (2 * R) / (2 * aspect * 0.94);
  // A circle of radius R on the ground is 2R across and 2R x sin(pitch) tall on screen; the 2.2 is
  // headroom for the tallest Pokemon standing on the far rim.
  const needH = (2 * R * Math.sin(CAM_PITCH) + 2.2 * Math.cos(CAM_PITCH)) / (2 * 0.70);
  const f = Math.max(needW, needH);
  freeCatchCamera.left = -f * aspect; freeCatchCamera.right = f * aspect;
  freeCatchCamera.top = f * (1 + FRAME_SHIFT); freeCatchCamera.bottom = -f * (1 - FRAME_SHIFT);
  freeCatchCamera.updateProjectionMatrix();
  freeCatchCamera.updateMatrixWorld(true);
}

// ---- Tapping a Pokemon -----------------------------------------------------------------------------
// By SCREEN DISTANCE to each body's middle, not by raycasting the meshes. A thumb is not a pixel, and
// some of these are small — a Kabuto is a couple of dozen pixels — so a ray through its exact voxels
// would miss more often than it hit. The nearest body whose middle is within its own on-screen size
// (or 40px, whichever is more) wins.
const _v = new THREE.Vector3();
export function pickWildAt(clientX, clientY) {
  if (!room) return null;
  const el = document.getElementById('game-canvas');
  const rect = el.getBoundingClientRect();
  const pxPerUnit = rect.height / (freeCatchCamera.top - freeCatchCamera.bottom);
  let best = null, bestD = Infinity;
  for (const w of room.floor.wilds) {
    if (w.gone || !w.obj) continue;
    const h = w.obj.userData.fit?.height || 0.8;
    _v.set(w.x, (w.obj.position.y || 0) + h * 0.5, w.z).project(freeCatchCamera);
    const sx = rect.left + (_v.x + 1) / 2 * rect.width;
    const sy = rect.top + (1 - _v.y) / 2 * rect.height;
    const d = Math.hypot(sx - clientX, sy - clientY);
    const reach = Math.max(40, (Math.max(h, (w.r || 0.4) * 2) * pxPerUnit) * 0.65);
    if (d <= reach && d < bestD) { best = w; bestD = d; }
  }
  return best;
}

// ---- The frame -----------------------------------------------------------------------------------
const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export function updateFreeCatch(dt) {
  if (!room) return;
  frameCamera(false);
  const floor = room.floor;
  const live = floor.wilds.filter(w => !w.gone && w.obj);

  for (const w of live) {
    // The real body is only known once the model has loaded. When it lands, take its radius — and
    // if the bigger radius no longer fits where it is standing (too near a wall), walk it toward the
    // middle of the room until it does, rather than leaving it wedged.
    if (!w.r && w.obj.userData.fit) {
      w.r = radiusFromFit(w.obj.userData.fit);
      for (let i = 0; i < 20 && !fits(floor, w.x, w.z, w.r); i++) { w.x *= 0.9; w.z *= 0.9; }
    }
    const r = w.r || 0.35;
    w.t += dt;
    w.timer -= dt;

    let speed = w.speed;
    switch (w.style) {
      case 'wander':
      case 'hop':
        if (w.timer <= 0) {
          w.moving = w.style === 'hop' || Math.random() > 0.3;
          w.heading = rnd(0, Math.PI * 2);
          w.timer = rnd(0.8, 2.4);
        }
        break;
      case 'dash':
        if (w.timer <= 0) {
          w.moving = !w.moving;
          if (w.moving) w.heading = rnd(0, Math.PI * 2);
          w.timer = w.moving ? rnd(0.35, 0.7) : rnd(0.9, 2.2);
        }
        break;
      case 'circle':
        w.heading += w.turn * dt;
        if (w.timer <= 0) { w.turn = -w.turn * rnd(0.7, 1.3); w.timer = rnd(2, 4.5); }
        break;
      case 'glide':
        w.heading += w.turn * 0.45 * Math.sin(w.t * 0.5) * dt;
        break;
    }
    if (!w.moving) speed = 0;

    if (speed > 0) {
      const dx = Math.sin(w.heading) * speed * dt, dz = Math.cos(w.heading) * speed * dt;
      const bx = w.x, bz = w.z;
      const p = slide(floor, { x: w.x, z: w.z }, dx, dz, r);
      w.x = p.x; w.z = p.z;
      // Ran into a wall or a prop: turn away, roughly back the way it came, rather than grinding.
      const blockedX = dx !== 0 && Math.abs(p.x - bx) < 1e-6;
      const blockedZ = dz !== 0 && Math.abs(p.z - bz) < 1e-6;
      if (blockedX || blockedZ) {
        w.heading += Math.PI * rnd(0.6, 1.4);
        if (w.style === 'wander' || w.style === 'hop') w.timer = Math.min(w.timer, rnd(0.6, 1.4));
      }
    }
  }

  // POKEMON DO NOT WALK THROUGH EACH OTHER. Every pair that overlaps is pushed apart along the line
  // between them, through slide() so a push can never shove one into a wall or a prop.
  //
  // Split so the WHOLE overlap is resolved even when one of the pair cannot move. Each takes half,
  // and whatever share one of them could not take — because it is backed against a wall — is handed
  // to the other. A plain half-each left a body pinned to a wall overlapping its neighbour by half
  // the gap every frame, which was measured: 27 overlapping pair-frames across six rooms.
  // Three passes, because separating one pair can push into a third body; by the third pass a room
  // of seven is settled. Headings are only turned on the first pass, so the extra passes cannot
  // add jitter: the one being pushed turns away from the other, otherwise two wanderers on
  // converging headings stay pressed together for the rest of their walk.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        const ra = a.r || 0.35, rb = b.r || 0.35;
        let nx = b.x - a.x, nz = b.z - a.z;
        let d = Math.hypot(nx, nz);
        const min = ra + rb;
        if (d >= min) continue;
        if (d < 1e-4) { const ang = rnd(0, Math.PI * 2); nx = Math.cos(ang); nz = Math.sin(ang); d = 1e-4; }
        else { nx /= d; nz /= d; }
        const gap = min - d;
        const pa = slide(floor, { x: a.x, z: a.z }, -nx * gap / 2, -nz * gap / 2, ra);
        const movedA = (a.x - pa.x) * nx + (a.z - pa.z) * nz;      // how far a actually got
        a.x = pa.x; a.z = pa.z;
        const pb = slide(floor, { x: b.x, z: b.z }, nx * (gap - movedA), nz * (gap - movedA), rb);
        const movedB = (pb.x - b.x) * nx + (pb.z - b.z) * nz;
        b.x = pb.x; b.z = pb.z;
        // b was pinned too: give a another try at what is left.
        const left = gap - movedA - movedB;
        if (left > 1e-4) {
          const pa2 = slide(floor, { x: a.x, z: a.z }, -nx * left, -nz * left, ra);
          a.x = pa2.x; a.z = pa2.z;
        }
        if (pass === 0) {
          if (a.style !== 'circle') a.heading = Math.atan2(-nx, -nz) + rnd(-0.6, 0.6);
          if (b.style !== 'circle') b.heading = Math.atan2(nx, nz) + rnd(-0.6, 0.6);
        }
      }
    }
  }

  for (const w of live) {
    const h = w.obj.userData.fit?.height || 0.8;
    // Hop: a bounce while it moves. Glide: a hover that never touches down.
    const y = w.style === 'hop' && w.moving ? Math.abs(Math.sin(w.t * 7)) * 0.2 * h
      : w.style === 'glide' ? 0.14 + Math.sin(w.t * 1.6) * 0.06
      : 0;
    w.obj.position.set(w.x, y, w.z);
    // Turn toward the heading rather than snapping to it — a snap reads as a twitch at these sizes.
    if (w.moving) w.yaw += angleDiff(w.yaw, w.heading) * Math.min(1, dt * 7);
    w.obj.rotation.y = w.yaw;
  }
}
