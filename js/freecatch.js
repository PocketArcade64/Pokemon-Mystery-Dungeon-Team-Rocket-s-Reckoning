// Free Catch: one dungeon room, seven wild Pokemon wandering it, a fixed bag of balls, and nothing at
// stake. Reached from Settings. Tap a Pokemon to open the catch minigame on it.
//
// This module owns the ROOM and everything that happens in it — building it, the seven wanderers,
// how each of them moves, keeping them from walking through one another, the fixed camera that frames
// the whole room on one screen, and turning a tap into "which Pokemon". The catch itself is the same
// catch.js minigame a run uses; main.js starts it and routes its result back here.
//
// It reuses the dungeon's own pieces rather than drawing a room of its own: the room is a real floor
// object handed to buildFloor, so its tiles, walls, props, theme lighting and Pokemon models are the
// dungeon's exactly. What it does NOT reuse is updateWilds — that walks one kind of wanderer at one
// speed and has no wild-vs-wild collision, and both of those are the point here.
import * as THREE from 'three';
import { THEMES, FLOOR, PROP, buildFloor, disposeFloor, cellToWorld, isPointWalkable } from './dungeon.js';
import { POKEMON_CATALOG } from './data/pokemon-catalog.js';
import { hasModelForDex } from './models.js';
import { scene, dirLight } from './three-setup.js';

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
// 7 x 14 open cells inside a one-cell wall, sitting in PAD cells of solid rock on every side. The rock
// is what makes it read as a room carved out of the dungeon rather than a tray floating in fog — the
// camera sees past the walls, and the dungeon fills every solid cell for exactly this reason (see the
// note in buildFloor). Long and narrow because a phone is: the room is framed to fill the screen's
// WIDTH, and at 7 across that still leaves each Pokemon a usable size to tap.
const ROOM_W = 7, ROOM_D = 14, PAD = 5;
const GRID_W = ROOM_W + 2 + PAD * 2, GRID_H = ROOM_D + 2 + PAD * 2;
// Pokemon are drawn a little bigger than on a dungeon floor (WORLD_MON_BASE, 1.0). The 'world' fit
// keeps their proportions either way; this is a stage you tap on, not a map you cross.
const MON_BASE = 1.2;
const CAST_SIZE = 7;
const PROP_COUNT = 5;

function buildRoomFloor(theme) {
  const cells = new Uint8Array(GRID_W * GRID_H);          // WALL (0) everywhere
  const x0 = PAD + 1, y0 = PAD + 1;                        // first open cell, inside the wall ring
  for (let y = y0; y < y0 + ROOM_D; y++) {
    for (let x = x0; x < x0 + ROOM_W; x++) cells[y * GRID_W + x] = FLOOR;
  }
  const floor = {
    number: 1, theme, W: GRID_W, H: GRID_H, cells, rooms: [], startCell: null,
    stairsCell: null,                                       // no stairwell: see buildFloor
    visited: new Uint8Array(GRID_W * GRID_H),
    items: [], wilds: [], props: [], outcrops: [],
    shop: null, chansey: null, boss: null, group: null, cleared: false,
    mapDirty: [], mapCache: null,
    monBase: MON_BASE,
  };

  // A few of the theme's props along the walls — the tree, the boulder, the crate — so the room is
  // recognisably THAT dungeon. Only on edge cells and never in a corner, so they dress the room
  // without walling off any of the floor the Pokemon move on.
  const edge = [];
  for (let y = y0 + 1; y < y0 + ROOM_D - 1; y++) { edge.push([x0, y], [x0 + ROOM_W - 1, y]); }
  for (let x = x0 + 1; x < x0 + ROOM_W - 1; x++) { edge.push([x, y0], [x, y0 + ROOM_D - 1]); }
  for (const [x, y] of shuffled(edge).slice(0, PROP_COUNT)) {
    cells[y * GRID_W + x] = PROP;
    floor.props.push({ x, y, rot: rnd(0, Math.PI * 2), scale: rnd(0.8, 1.05) });
  }
  return { floor, x0, y0 };
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
let room = null;   // { floor, theme, x0, y0 }

// Build a fresh room: a random theme out of all eleven, its seven Pokemon spread across the floor.
export function startFreeCatchRoom() {
  disposeFreeCatchRoom();
  const theme = pick(THEMES);
  const { floor, x0, y0 } = buildRoomFloor(theme);

  // Spawn cells: one cell in from the wall all round, so even the widest body (radius 0.95) starts
  // clear of it, and at least 2.4 apart so nobody starts inside anybody else.
  const spots = [];
  for (let y = y0 + 1; y < y0 + ROOM_D - 1; y++) {
    for (let x = x0 + 1; x < x0 + ROOM_W - 1; x++) if (floor.cells[y * GRID_W + x] === FLOOR) spots.push([x, y]);
  }
  const chosen = chooseSpawns(spots, CAST_SIZE);
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
  room = { floor, theme, x0, y0 };
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
// Its own camera, not the dungeon's. The dungeon looks down a DIAGONAL, which turns every room into a
// diamond — fine for a map you walk across, wasteful for one room that has to fill a portrait screen.
// This one looks straight down the room's long axis from behind and above (55 degrees), so the room
// is a rectangle that runs up the screen. Same distance from its target as the dungeon camera (~20.3),
// so the theme's fog sits where it was tuned to.
//
// The frustum is solved every frame from the canvas's aspect, so the room fills the screen on a phone
// and on a desktop window alike: wide enough for the room's width, tall enough for its depth, each
// with a margin for the HUD bars over the top and bottom.
export const freeCatchCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
const CAM_PITCH = THREE.MathUtils.degToRad(55);
const CAM_DIST = 20.3;
freeCatchCamera.position.set(0, CAM_DIST * Math.sin(CAM_PITCH), -CAM_DIST * Math.cos(CAM_PITCH));
freeCatchCamera.lookAt(0, 0, 0);
// Room centre sits a touch low on screen: the top HUD (title, tally, balls) is taller than the hint
// along the bottom, and an exactly centred room tucks its far wall under the ball strip.
const FRAME_SHIFT = 0.06;
let framedAspect = 0;

function frameCamera(force = true) {
  const el = document.getElementById('game-canvas');
  const aspect = (el?.clientWidth || window.innerWidth) / (el?.clientHeight || window.innerHeight);
  if (!force && Math.abs(aspect - framedAspect) < 1e-3) return;
  framedAspect = aspect;
  const roomW = ROOM_W + 2, roomD = ROOM_D + 2;
  const needW = roomW / (2 * aspect * 0.96);
  const needH = (roomD * Math.sin(CAM_PITCH) + 1.6 * Math.cos(CAM_PITCH)) / (2 * 0.74);
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
