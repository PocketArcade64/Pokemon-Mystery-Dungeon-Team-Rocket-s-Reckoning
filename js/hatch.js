// The hatch screen's 3D: an egg you tap three times. Every tap rocks it on its base and splits a
// little more of the shell; the third one sets it shuddering, and then it bursts into pieces with the
// Pokemon standing in the middle of them.
//
// Drawn through ONE createModelView (js/modelstage.js) — a plain 2D canvas blitted from the shared
// offscreen stage — so this screen costs no WebGL context of its own. The page is allowed two, and a
// third gets the dungeon's killed by the browser.
//
// The DOM side (the name and types over the stage, the buttons, the sounds) is ui-screens.js's. This
// module only knows the scene — and turning the hatched Pokemon under a finger — and talks back
// through the two callbacks handed to beginHatch.
import * as THREE from 'three';
import { createModelView, DRAG_RADIANS_PER_PX } from './modelstage.js';
import { setPreviewModel, EGG_MODEL } from './models.js';

export const HATCH_TAPS = 3;

const EGG_H = 1.3;         // the egg's height in view units
const MON_H = 1.4;         // the Pokemon's, fitted 'contain' so a wide one still fits the frame
const MON_ASPECT = 1.3;    // how wide (x MON_H) the Pokemon may sweep as it turns — see containScale
// The frame: at least FRAME_HALF_H units above and below the look point, and at least FRAME_W units
// across. A phone's stage is much taller than it is wide, so it is the WIDTH that binds there — a
// frame sized by height alone showed only ~1.9 units across on a 390x844 screen, and a wide Pokemon
// turning in it (Beldum) ran off both sides. The spare height lands above the Pokemon, which is where
// the name and types are drawn over the stage.
const FRAME_HALF_H = 1.6;
const FRAME_W = 2.5;
// The egg's cream comes out a muddy beige under the shared stage's rig at 1.0 — the same lift the
// cached egg icon gets (see requestPathPortrait in ui-screens.js), so the two match.
const EGG_BRIGHTEN = 1.35;

// The rip's own measurements, in OBJ units, read off Egg.obj. The body is a voxel block: four flat
// sides (each spanning +-0.75 across and +-0.847 up, set 0.917 out from the centre) with chamfered
// corners, a lip at the bottom at -0.935, and a narrower block on top that peaks at 1.465. The cracks
// are decals laid on the body's flat sides, so they need the numbers.
const RAW = { minY: -0.93538, maxY: 1.4653, face: 0.91694, faceHalfW: 0.75, faceHalfH: 0.84663 };
const S = EGG_H / (RAW.maxY - RAW.minY);
const toY = (rawY) => (rawY - RAW.minY) * S;
const HALF_W = RAW.face * S;

// The shell's colours, sampled from Egg.png: the egg is a cream block with mint spots, so most of the
// burst is cream and about one shard in four is a piece of spot.
const SHELL_CREAM = [0xfff2d3, 0xfff6df, 0xf3e2bd];
const SHELL_SPOT = [0xc1efc1, 0xc1dcb1, 0xa9e3ad];
const SPOT_SHARE = 0.26;

// How hard each tap rocks it, in radians of roll. Rising, so the egg is visibly more restless with
// every crack — the third is the one it does not recover from.
const TAP_ROCK = [0.2, 0.28, 0.36];
const SHUDDER_S = 0.6;     // the third tap's shudder before it gives way
const EMERGE_S = 0.6;      // the Pokemon's pop out of the burst

let view = null;
let root = null;           // everything below hangs off view.holder through this
let pivot = null;          // the egg and its cracks; rocks about the egg's base
let squash = null;         // inside the pivot: squashed on each tap, the cracks WITH the shell
let eggHolder = null;      // setPreviewModel clears its target, so the egg gets a holder of its own
let monHolder = null;
let shadow = null;
let decals = [];           // { mesh, ctx, tex, cracks }
let shards = [];
let s = null;              // per-hatch state, rebuilt by beginHatch
let hatchCanvas = null;
let drag = null;           // { lastX } while a finger is turning the hatched Pokemon

// DRAG TO TURN, once the Pokemon is out — the starter preview's feel exactly: the yaw follows the
// finger at the same rate, the idle spin pauses while it is down and picks up from wherever it was
// left, and there is no snap-back or inertia. It is NOT createModelView's `draggable`, because that
// turns the whole view; here only the Pokemon turns, and only after the egg has gone — before that a
// press on the canvas is a tap on the egg (ui-screens.js onHatchTap), and must not twist it.
// Tracked from clientX rather than movementX for the reason modelstage.js gives: iOS Safari leaves
// movementX at 0 on touch-derived pointer events.
function bindMonDrag(canvas) {
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    if (s?.phase !== 'done') return;
    drag = { lastX: e.clientX };
    canvas.style.cursor = 'grabbing';
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable: no matter */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    monHolder.rotation.y += (e.clientX - drag.lastX) * DRAG_RADIANS_PER_PX;
    drag.lastX = e.clientX;
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    canvas.style.cursor = s?.phase === 'done' ? 'grab' : '';
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);
}

export function initHatchView(canvas) {
  if (view) return view;
  hatchCanvas = canvas;
  bindMonDrag(canvas);
  // The frustum here is only the starting value: updateHatch widens it to FRAME_W every frame.
  view = createModelView(canvas, { frustum: FRAME_HALF_H, camY: 1.35, camZ: 5, lookY: 0.95 });
  root = new THREE.Group();
  view.holder.add(root);

  pivot = new THREE.Group();
  root.add(pivot);
  squash = new THREE.Group();
  pivot.add(squash);
  eggHolder = new THREE.Group();
  squash.add(eggHolder);
  // A slight turn, so the egg reads as a solid block rather than a flat front elevation — and so
  // one side face, which carries cracks of its own, is in view.
  root.rotation.y = -0.38;

  monHolder = new THREE.Group();
  root.add(monHolder);

  shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.66, 28),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.003;
  shadow.scale.set(1, 0.62, 1);
  root.add(shadow);

  // The crack decals: one per flat face that can be seen — the front, and both sides as the egg
  // rocks. Each is a transparent canvas texture, redrawn as the cracks grow.
  const faceW = RAW.faceHalfW * 2 * S * 0.96, faceH = RAW.faceHalfH * 2 * S * 0.96;
  const out = HALF_W + 0.006;
  const cy = toY(0);
  for (const [x, z, yaw] of [[0, out, 0], [out, 0, Math.PI / 2], [-out, 0, -Math.PI / 2]]) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 288;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(faceW, faceH),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    mesh.position.set(x, cy, z);
    mesh.rotation.y = yaw;
    squash.add(mesh);
    decals.push({ mesh, ctx: c.getContext('2d'), tex, cracks: [] });
  }
  return view;
}

// ---- Cracks --------------------------------------------------------------------------------------
// A crack is a jagged polyline in a decal's canvas (256 x 288, y down), and every SEGMENT of it is
// tagged with the tap that opens it. Drawing a stage is drawing every segment tagged at or below it,
// so a crack visibly runs further across the shell with each tap instead of new ones simply appearing.
const rnd = (a, b) => a + Math.random() * (b - a);

function jagged(x, y, heading, segs, len) {
  const pts = [[x, y]];
  let flip = Math.random() < 0.5 ? 1 : -1;
  for (let i = 0; i < segs; i++) {
    const a = heading + flip * rnd(0.45, 0.95);
    flip = -flip;
    const l = len * rnd(0.75, 1.2);
    x += Math.sin(a) * l;
    y += Math.cos(a) * l;
    pts.push([x, y]);
  }
  return pts;
}

// `stages[i]` is the tap that opens segment i (1-based, so 1 = the first tap).
function crack(pts, stages) { return { pts, stages }; }
const spread = (n, ...cuts) => Array.from({ length: n }, (_, i) => 1 + cuts.filter(c => i >= c).length);

function planCracks() {
  for (const d of decals) d.cracks = [];
  const [front, right, left] = decals;
  // The front: one main split from the dome's edge down the face, opening in thirds, with branches
  // forking off it on the second and third taps, and a second split on the last.
  const main = jagged(rnd(108, 148), 0, 0, 10, 31);
  front.cracks.push(crack(main, spread(10, 4, 7)));
  const side = Math.random() < 0.5 ? 1 : -1;
  front.cracks.push(crack(jagged(...main[2], side * 1.0, 3, 24), [1, 2, 2]));
  front.cracks.push(crack(jagged(...main[5], -side * 1.05, 4, 26), [2, 2, 3, 3]));
  front.cracks.push(crack(jagged(...main[7], side * 1.0, 4, 24), [3, 3, 3, 3]));
  front.cracks.push(crack(jagged(side > 0 ? rnd(28, 60) : rnd(196, 228), 0, side * 0.3, 6, 26), [3, 3, 3, 3, 3, 3]));
  // The sides split from the second tap on, so the egg is visibly coming apart all round by the end.
  right.cracks.push(crack(jagged(rnd(90, 160), 0, 0, 8, 31), spread(8, 4).map(v => v + 1)));
  left.cracks.push(crack(jagged(rnd(90, 160), 0, 0, 7, 31), [3, 3, 3, 3, 3, 3, 3]));
}

function drawCracks(stage) {
  for (const d of decals) {
    const { ctx } = d;
    ctx.clearRect(0, 0, 256, 288);
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'square';
    // Two passes: a thin lit edge offset below the split, then the dark split over it — the same
    // chiselled read as the voxel faces' own shading.
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass ? 'rgba(34,40,26,0.95)' : 'rgba(255,255,255,0.6)';
      ctx.lineWidth = pass ? 8 : 5;
      for (const c of d.cracks) {
        ctx.beginPath();
        let open = false;
        c.pts.forEach(([x, y], i) => {
          if (i === 0) { ctx.moveTo(x + (pass ? 0 : 2), y + (pass ? 0 : 3)); return; }
          if (c.stages[i - 1] > stage) return;
          ctx.lineTo(x + (pass ? 0 : 2), y + (pass ? 0 : 3));
          open = true;
        });
        if (open) ctx.stroke();
      }
    }
    d.tex.needsUpdate = true;
  }
}

// ---- The burst ----------------------------------------------------------------------------------
// The shell does not come apart along its real geometry — the rip is one closed mesh — so it is
// replaced in the same frame by a spray of shell-coloured voxel shards thrown out from where it
// stood. At the speed they leave, that reads as the egg itself flying apart. Pieces from the upper
// half are thrown higher and faster, the way a shell bursts open from the top.
const SHARD_COUNT = 30;
const GRAVITY = -8.5;

function spawnShards() {
  for (let i = 0; i < SHARD_COUNT; i++) {
    const y = rnd(0.05, EGG_H * 0.95);
    const top = y > toY(0.05);
    const palette = Math.random() < SPOT_SHARE ? SHELL_SPOT : SHELL_CREAM;
    const size = rnd(0.07, 0.17);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size * rnd(0.7, 1.3), size * rnd(0.5, 1.0), size * rnd(0.7, 1.3)),
      new THREE.MeshLambertMaterial({ color: palette[Math.floor(Math.random() * palette.length)] }),
    );
    // Thrown out round the whole egg, but weighted to the front half so most of the burst comes at
    // the camera rather than disappearing behind the Pokemon.
    const ang = Math.random() < 0.7 ? rnd(-1.4, 1.4) : rnd(-Math.PI, Math.PI);
    const dx = Math.sin(ang), dz = Math.cos(ang);
    mesh.position.set(dx * HALF_W * 0.9, y, dz * HALF_W * 0.9);
    mesh.rotation.set(rnd(0, 6), rnd(0, 6), rnd(0, 6));
    const speed = rnd(1.3, 2.9) * (top ? 1.15 : 0.8);
    root.add(mesh);
    shards.push({
      mesh, size,
      vx: dx * speed, vz: dz * speed, vy: top ? rnd(2.2, 4.2) : rnd(0.8, 2.2),
      sx: rnd(-9, 9), sy: rnd(-9, 9), sz: rnd(-9, 9),
      age: 0, life: rnd(1.5, 2.1),
    });
  }
}

function clearShards() {
  for (const sh of shards) {
    root.remove(sh.mesh);
    sh.mesh.geometry.dispose();
    sh.mesh.material.dispose();
  }
  shards = [];
}

function stepShards(dt) {
  for (const sh of shards) {
    sh.age += dt;
    sh.vy += GRAVITY * dt;
    const p = sh.mesh.position;
    p.x += sh.vx * dt; p.y += sh.vy * dt; p.z += sh.vz * dt;
    // A bounce or two on the ground they fell on, losing most of their speed each time, then rest.
    const floorY = sh.size * 0.35;
    if (p.y < floorY) {
      p.y = floorY;
      if (sh.vy < -0.6) { sh.vy *= -0.32; sh.vx *= 0.55; sh.vz *= 0.55; sh.sx *= 0.5; sh.sy *= 0.5; sh.sz *= 0.5; }
      else { sh.vy = 0; sh.vx *= 0.82; sh.vz *= 0.82; sh.sx = sh.sy = sh.sz = 0; }
    }
    sh.mesh.rotation.x += sh.sx * dt; sh.mesh.rotation.y += sh.sy * dt; sh.mesh.rotation.z += sh.sz * dt;
    // The last half second shrinks them away rather than leaving a floor of litter under the Pokemon.
    const fade = THREE.MathUtils.clamp((sh.life - sh.age) / 0.5, 0, 1);
    sh.mesh.scale.setScalar(fade);
  }
  const done = shards.filter(sh => sh.age >= sh.life);
  if (done.length) {
    for (const sh of done) { root.remove(sh.mesh); sh.mesh.geometry.dispose(); sh.mesh.material.dispose(); }
    shards = shards.filter(sh => sh.age < sh.life);
  }
}

// ---- The session ----------------------------------------------------------------------------------
// `dex` is what the egg holds (js/eggs.js rollHatch). Its model is loaded NOW, hidden, so it is there
// the instant the shell gives way. `onBreak` fires on the frame it does — the caller commits the egg
// and flashes the screen there — and `onEmerged` once the Pokemon has finished popping out.
export function beginHatch(dex, { onBreak = null, onEmerged = null } = {}) {
  if (!view) return;
  clearShards();
  drag = null;
  hatchCanvas.style.cursor = '';       // back to the stylesheet's pointer: the egg is for tapping
  s = { dex, taps: 0, phase: 'loading', rock: 0, rockT: 9, rockDir: 1, squashT: 9, idleT: 0,
        shudderT: 0, emergeT: 0, onBreak, onEmerged };
  pivot.visible = true;
  pivot.rotation.set(0, 0, 0);
  pivot.position.set(0, 0, 0);
  root.rotation.y = -0.38;
  monHolder.visible = false;
  monHolder.scale.setScalar(0.001);
  monHolder.rotation.set(0, 0.38, 0);    // undoes root's turn, so the Pokemon comes out facing you
  monHolder.position.set(0, 0, 0);
  shadow.scale.set(1, 0.62, 1);
  for (const d of decals) d.mesh.visible = false;
  planCracks();
  drawCracks(0);

  const token = s;
  setPreviewModel(eggHolder, null, EGG_H, EGG_MODEL, { brighten: EGG_BRIGHTEN }).then(fitted => {
    if (s !== token) return;
    // A missing egg model still has to be hatchable: the taps work on the empty pivot, the cracks
    // simply have no shell to sit on.
    s.phase = 'egg';
    for (const d of decals) d.mesh.visible = !!fitted;
  });
  setPreviewModel(monHolder, dex, MON_H, null, { fit: 'contain', aspect: MON_ASPECT });
}

// One tap on the egg. Returns the tap's number (1..HATCH_TAPS), or 0 when the egg is not taking taps
// — still loading, already shuddering, or already open.
export function tapHatchEgg() {
  if (!s || s.phase !== 'egg') return 0;
  s.taps += 1;
  s.rock = TAP_ROCK[Math.min(s.taps, TAP_ROCK.length) - 1];
  s.rockT = 0;
  s.rockDir = -s.rockDir;
  s.squashT = 0;
  drawCracks(s.taps);
  if (s.taps >= HATCH_TAPS) { s.phase = 'shudder'; s.shudderT = 0; }
  return s.taps;
}

export function hatchPhase() { return s?.phase || null; }

function breakOpen() {
  s.phase = 'emerge';
  s.emergeT = 0;
  pivot.visible = false;
  spawnShards();
  monHolder.visible = true;
  s.onBreak?.(s.dex);
}

const easeOutBack = (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

export function updateHatch(dt) {
  if (!view || !s) return;
  if (s.phase === 'egg' || s.phase === 'loading') {
    // Before the first tap it fidgets now and then — a small shimmy every couple of seconds, which
    // is the whole of the screen's "tap me" before anyone has.
    if (s.taps === 0) {
      s.idleT += dt;
      if (s.idleT > 2.1) { s.idleT = 0; s.rock = 0.07; s.rockT = 0; s.rockDir = -s.rockDir; }
    }
  }
  // The rock: a damped swing about the base, and a lift of the low side so the corner it tips onto
  // stays on the ground instead of sinking through it.
  s.rockT += dt;
  let roll = s.rock * Math.exp(-4.2 * s.rockT) * Math.sin(17 * s.rockT) * s.rockDir;
  if (s.phase === 'shudder') {
    s.shudderT += dt;
    const k = s.shudderT / SHUDDER_S;
    roll += Math.sin(s.shudderT * 62) * (0.05 + 0.09 * k);
    if (s.shudderT >= SHUDDER_S) breakOpen();
  }
  pivot.rotation.z = roll;
  pivot.rotation.x = roll * 0.22;
  pivot.position.y = Math.abs(Math.sin(roll)) * HALF_W * 0.55;
  // Each tap squashes it a touch and lets it spring back, so the hit lands in the body of the egg.
  s.squashT += dt;
  const sq = 0.09 * Math.exp(-16 * s.squashT) * Math.cos(26 * s.squashT);
  squash.scale.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);

  if (s.phase === 'emerge' || s.phase === 'done') {
    s.emergeT += dt;
    const t = Math.min(1, s.emergeT / EMERGE_S);
    monHolder.scale.setScalar(Math.max(0.001, easeOutBack(t)));
    monHolder.position.y = Math.sin(t * Math.PI) * 0.28;
    if (s.phase === 'emerge' && t >= 1) {
      s.phase = 'done';
      hatchCanvas.style.cursor = 'grab';
      s.onEmerged?.(s.dex);
    }
    // Then it turns slowly on the spot at the starter preview's rate, and yields to a finger.
    if (s.phase === 'done' && !drag) monHolder.rotation.y += dt * 0.7;
  }
  stepShards(dt);
  // renderToStage reads the half-height off userData on every render, so the frame follows the
  // stage's own shape — a rotation or a resize included.
  const aspect = hatchCanvas.clientWidth / Math.max(1, hatchCanvas.clientHeight);
  view.camera.userData.frustum = Math.max(FRAME_HALF_H, FRAME_W / (2 * Math.max(aspect, 0.1)));
  view.render();
}

// Leaving the screen. The egg and the Pokemon stay loaded in their holders — the next hatch replaces
// both — but the burst is cleared, so a half-finished spray of shards cannot greet the next egg.
export function endHatch() {
  clearShards();
  s = null;
  drag = null;
}
