// The catch minigame: a faithful reproduction of the Pokemon GO encounter screen.
//
// EVERYTHING about the framing, the controls and the throw is measured in SCREEN space and
// un-projected into the world, rather than being hand-placed in world units. That is the single
// idea this whole file is built on, and it is what makes the layout match GO's on any phone:
//   * the held ball sits at a fixed NDC point (bottom middle) and is scaled to a fixed fraction
//     of the screen, so it is "the big ball at the bottom" at every aspect ratio;
//   * the Pokemon is scaled to a fixed fraction of the screen HEIGHT, so it frames identically;
//   * the flick that throws it is measured in screen-heights per second and screen degrees.
// World-unit constants would drift out of frame the moment the aspect ratio changed.
//
// The GO throw, and every part of it that is a skill:
//   1. Touch anywhere and the ball FOLLOWS YOUR FINGER in both axes. There is no aim line and no
//      slingshot pull-back. Where the ball is when you let go is where the throw starts from.
//   2. The FLICK is the throw. Its SPEED is the power and its DIRECTION is the aim: a flick 15
//      degrees off vertical sends the ball about one capture-circle off to that side.
//   3. The ball is a plain ballistic projectile from there — launched at a fixed elevation, pulled
//      down by gravity, never back-solved to guarantee arrival. Too slow and it bounces off the
//      floor short; too fast and it sails clean over.
//   4. A white CAPTURE CIRCLE sits on the Pokemon with a coloured TARGET RING shrinking inside it.
//      Landing inside that ring is graded by how small it was: Nice / Great / Excellent.
//   5. Swirl the ball before you flick and it throws a CURVEBALL — it spins, bends about one
//      capture-circle in flight, and pays its own bonus, so it has to be aimed off-side.
//   6. The Pokemon dodges and attacks. An attack swats a ball out of the air.
//   7. A throw that fails re-arms you AUTOMATICALLY after a beat, exactly as GO does. There is no
//      "throw again" button in Pokemon GO and there is none here.
//
// Success is HYBRID (confirmed design decision) — both halves matter:
//   base chance    from the ball tier   (Poke 0.42 / Great 0.58 / Ultra 0.74, from items.js)
//   accuracy bonus from the throw       (up to +0.26, the confirmed ceiling)
// The +0.26 is split so that a curveball Excellent — the best throw in the game — lands exactly
// on the cap: Excellent 0.20 + Curveball 0.06.
//
// This runs in its own scene with a perspective camera, dressed per floor theme, rendered through
// the main renderer.
import * as THREE from 'three';
import { createMonObject, createBallObject, disposeObject } from './models.js';
import { registerCamera } from './three-setup.js';
import { ITEM_BY_ID } from './data/items.js';
import { CATALOG_BY_DEX } from './data/pokemon-catalog.js';
import { makeProp, THEMES } from './dungeon.js';

const rad = THREE.MathUtils.degToRad;

// ---- Framing -----------------------------------------------------------------------------------
// The camera is a person standing on the ground looking slightly down at a Pokemon a few metres
// off. Every number below was solved against this rig; moving the camera means re-solving them.
const FOV = 45;
const CAM_POS = new THREE.Vector3(0, 1.5, 0.8);
const CAM_LOOK = new THREE.Vector3(0, 0.45, -5.6);
const TARGET_Z = -5.6;            // depth plane the Pokemon stands on

// The Pokemon's on-screen HEIGHT as a fraction of the screen, by evolution stage. Vertical FOV is
// fixed, so a height fraction is aspect-independent — which a world-unit height is not.
const MON_SCREEN_FRAC = { Basic: 0.26, Stage1: 0.30, Stage2: 0.34, Legendary: 0.36 };
const CAPTURE_OF_HEIGHT = 0.56;   // white capture circle radius, as a fraction of the Pokemon
const MIN_RING_RATIO = 0.13;      // how far the target ring shrinks before it resets

// The held ball. Distance from the camera is fixed so the throw always starts the same depth out;
// the on-screen size is then whichever of the two caps is smaller, which keeps the ball "large at
// the bottom middle" in portrait without turning it into a beach ball on a wide desktop window.
const BALL_DEPTH = 2.6;
const BALL_HOME_NDC = { x: 0, y: -0.70 };
const BALL_SCREEN_W = 0.22;       // of screen width
const BALL_SCREEN_H = 0.115;      // of screen height
const HOLD_NDC_X = 0.80;          // how far the held ball may be dragged, in NDC
const HOLD_NDC_Y_LO = -0.90;
const HOLD_NDC_Y_HI = 0.05;

// ---- Throw physics -----------------------------------------------------------------------------
// Solved for the rig above with the ball resting at its home point and a Basic-stage target:
//   horizontal distance to the body centre L = 3.96, launch height 0.34, body centre 0.76.
//   y at the target plane = 2.62 - 102.2 / v^2, so the ball clears the floor from v = 6.25 and
//   clears the top of the capture circle past v = 9.7.
// SPEED_MIN/SPEED_SPAN map flick power 0..1 onto v = 5.6..11.0, which puts the CONNECT BAND at
// power 0.12..0.77 — deliberately wide. In GO almost every throw reaches the Pokemon and what
// separates a good one from a bad one is where in the ring it lands, so power is a coarse
// three-way gate (short / connects / over) and the ring plus the aim are the fine skill.
const GRAVITY = -9.8;
const ELEV = rad(30);             // launch elevation off horizontal — fixed, as GO's is
const SPEED_MIN = 5.6;
const SPEED_SPAN = 5.4;

// A flick is release VELOCITY in screen-heights per second, so it feels identical on any screen.
// Below MIN_FLICK it is a tap or a fumble and the ball just settles back home.
const MIN_FLICK = 0.55;
const FLICK_FULL = 3.4;
const MAX_FLICK_ANGLE = rad(70);  // wider than this is a sideways swipe, not a throw

// Aim. The flick's angle off vertical becomes a horizontal launch angle: at L = 3.96 a 12-degree
// aim throws the ball 0.84 off-centre, which is just outside a Basic target's capture circle.
const AIM_GAIN = 0.8;
const AIM_MAX = rad(34);

// Curveball. 5.2 units/s^2 over a ~0.62 s flight bends the ball about 1.0 — roughly one and a
// quarter capture-circles — so a curveball genuinely has to be aimed off to the other side.
const CURVE_ACCEL = 5.2;
const SPIN_THRESHOLD = 2.6;       // summed signed turn of the drag path
const SPIN_PATH_MIN = 110;        // px of drag before a swirl counts at all

// Ring ratio at the moment of contact -> grade. GO uses 0.7 / 0.3 / 0.1 of the capture circle;
// ours are a shade more forgiving because the circle is physically smaller on this stage.
const GRADE_EXCELLENT = 0.30;
const GRADE_GREAT = 0.55;
const GRADE_NICE = 0.80;

const BONUS = { excellent: 0.20, great: 0.13, nice: 0.06, hit: 0 };
const CURVE_BONUS = 0.06;

const FAIL_HOLD = 1.15;           // seconds a dead ball tumbles before GO hands you a fresh one

// ---- Scene -------------------------------------------------------------------------------------
export const catchScene = new THREE.Scene();

export const catchCamera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 240);
catchCamera.position.copy(CAM_POS);
catchCamera.lookAt(CAM_LOOK);
catchCamera.updateMatrixWorld(true);
registerCamera(catchCamera);

const catchHemi = new THREE.HemisphereLight(0xbcd4ff, 0x2a2438, 1.15);
catchScene.add(catchHemi);
const catchDir = new THREE.DirectionalLight(0xfff2dc, 1.2);
catchDir.position.set(-4, 8, 2);
catchDir.castShadow = true;
catchDir.shadow.mapSize.set(1024, 1024);
catchDir.shadow.normalBias = 0.05;
catchDir.shadow.camera.left = -8; catchDir.shadow.camera.right = 8;
catchDir.shadow.camera.top = 8; catchDir.shadow.camera.bottom = -8;
catchDir.shadow.camera.far = 30;
catchScene.add(catchDir);
catchScene.add(catchDir.target);
catchDir.target.position.set(0, 0, TARGET_Z);

// ---- Screen-space placement helpers ------------------------------------------------------------
// The camera never moves, so its basis is captured once. Everything that has to land at a given
// point on screen is built from it.
const CAM_FWD = new THREE.Vector3(0, 0, -1).applyQuaternion(catchCamera.quaternion);
const CAM_UP = new THREE.Vector3(0, 1, 0).applyQuaternion(catchCamera.quaternion);
const CAM_RIGHT = new THREE.Vector3(1, 0, 0).applyQuaternion(catchCamera.quaternion);
const TAN_HALF_FOV = Math.tan(rad(FOV) / 2);

const halfHeightAt = (depth) => TAN_HALF_FOV * depth;
const halfWidthAt = (depth) => TAN_HALF_FOV * depth * (catchCamera.aspect || 1);

// World point that projects to (ndcX, ndcY) at `depth` in front of the camera.
function pointAtNDC(ndcX, ndcY, depth, out = new THREE.Vector3()) {
  return out.copy(catchCamera.position)
    .addScaledVector(CAM_FWD, depth)
    .addScaledVector(CAM_UP, ndcY * halfHeightAt(depth))
    .addScaledVector(CAM_RIGHT, ndcX * halfWidthAt(depth));
}

// Depth of the target plane along the view axis. Used to convert the Pokemon's on-screen height
// fraction into world units.
function targetDepth() {
  return new THREE.Vector3(0, 0.8, TARGET_Z).sub(catchCamera.position).dot(CAM_FWD);
}

function ballWorldDiameter() {
  return Math.min(BALL_SCREEN_W * 2 * halfWidthAt(BALL_DEPTH),
                  BALL_SCREEN_H * 2 * halfHeightAt(BALL_DEPTH));
}

// ---- Themed backdrop ---------------------------------------------------------------------------
// Each floor theme gets its own sky, ground, haze and scatter of props, built from the same
// palette and the same makeProp() the dungeon floor itself is built from — so the encounter reads
// as happening WHERE you are standing rather than in a void. There are no environment art assets;
// this is the whole of the "different background per area", and reusing makeProp is what makes a
// Frozen Grotto encounter recognisably the floor you were just walking on.
const skyTextures = new Map();

function mixHex(a, b, t) {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}

// Vertical gradient: theme sky darkened at the zenith, brightening to a haze band at the horizon,
// then the theme's fog colour below it. Cached per theme — a catch happens often.
function skyTexture(theme) {
  if (skyTextures.has(theme.id)) return skyTextures.get(theme.id);
  const cv = document.createElement('canvas');
  cv.width = 4; cv.height = 256;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  const hex = (v) => '#' + v.toString(16).padStart(6, '0');
  grad.addColorStop(0.00, hex(mixHex(theme.sky, theme.fog, 0.62)));   // zenith
  grad.addColorStop(0.42, hex(mixHex(theme.sky, theme.fog, 0.18)));
  grad.addColorStop(0.52, hex(mixHex(theme.sky, theme.fog, 0.02)));   // horizon haze
  grad.addColorStop(0.62, hex(mixHex(theme.fog, theme.ground, 0.35)));
  grad.addColorStop(1.00, hex(theme.fog));
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  skyTextures.set(theme.id, tex);
  return tex;
}

let backdrop = null;
let backdropTheme = null;

function disposeTree(root) {
  root.traverse(o => {
    if (!o.isMesh) return;
    o.geometry?.dispose();
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m?.dispose());
  });
  root.parent?.remove(root);
}

// Prop scatter. A prop must never stand between the camera and the Pokemon, so the corridor in
// front of the target plane is kept clear and everything sits out on the flanks or behind.
function scatterProps(group, theme) {
  let lights = 0;
  const place = (x, z, scale) => {
    const p = makeProp(theme.prop, theme);
    // makeProp gives lava vents their own PointLight. Two dozen of them would blow the light
    // budget and wash the stage out, so only the first two keep theirs.
    p.traverse(o => { if (o.isLight) { if (lights >= 2) o.intensity = 0; else lights++; } });
    p.position.set(x, 0, z);
    p.rotation.y = Math.random() * Math.PI * 2;
    p.scale.setScalar(scale);
    group.add(p);
  };
  // A near band flanking the Pokemon, then a far band the haze eats into the horizon.
  for (let i = 0; i < 9; i++) {
    const side = i % 2 ? 1 : -1;
    place(side * (2.8 + Math.random() * 4.5), TARGET_Z + 3.2 - Math.random() * 9,
      0.85 + Math.random() * 0.7);
  }
  for (let i = 0; i < 12; i++) {
    const a = Math.PI * (0.12 + Math.random() * 0.76);        // behind the target only
    const r = 11 + Math.random() * 15;
    place(Math.cos(a) * r, TARGET_Z - Math.sin(a) * r * 0.55 - 2, 1.2 + Math.random() * 1.1);
  }
}

function buildBackdrop(theme) {
  if (backdrop) { disposeTree(backdrop); backdrop = null; }
  backdropTheme = theme;
  backdrop = new THREE.Group();

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(110, 24, 16),
    new THREE.MeshBasicMaterial({
      map: skyTexture(theme), side: THREE.BackSide, depthWrite: false, fog: false,
    }),
  );
  backdrop.add(sky);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(220, 220),
    new THREE.MeshStandardMaterial({ color: mixHex(theme.floorA, theme.ground, 0.25), roughness: 0.97 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  backdrop.add(ground);

  scatterProps(backdrop, theme);
  catchScene.add(backdrop);

  // Haze: distance melts into the horizon band of the sky, which is what sells the depth.
  catchScene.fog = new THREE.Fog(mixHex(theme.sky, theme.fog, 0.02), 9, 46);
  catchScene.background = null;                 // the sky sphere IS the background

  catchHemi.color.setHex(theme.sky);
  catchHemi.groundColor.setHex(theme.ground);
  catchDir.color.setHex(theme.light);
}

// ---- The two rings on the Pokemon --------------------------------------------------------------
// Both are billboards facing the fixed camera, and both run depthTest OFF. That is load-bearing
// rather than cosmetic: the circle is centred on the Pokemon's BODY, so its lower arc dips below
// the ground — depth-tested, the ground plane eats the bottom third and what is left reads as a
// broken arc. These are a HUD drawn into the 3D scene, exactly as GO's are, so they get HUD rules:
// never occluded, in front of the Pokemon, with RING_ORDER keeping the thrown ball in front again.
const RING_ORDER = 5;
const BALL_ORDER = 6;

function makeRing(inner, outer, color, opacity, segments) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, segments),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide,
      depthWrite: false, depthTest: false, fog: false,
    }),
  );
  m.quaternion.copy(catchCamera.quaternion);
  m.renderOrder = RING_ORDER;
  m.visible = false;
  catchScene.add(m);
  return m;
}

// Both are unit-radius and scaled, so one geometry serves every target size.
const CAPTURE_RING = makeRing(0.968, 1.0, 0xffffff, 0.75, 64);
const TARGET_RING = makeRing(0.90, 1.0, 0x4ade80, 0.95, 48);

// Spin halo: the only tell that the ball in your hand is going to curve.
const SPIN_HALO = makeRing(0.62, 0.86, 0xffd95e, 0.0, 28);
SPIN_HALO.visible = true;

// A short trail so a curveball's bend is legible in flight.
const TRAIL_LEN = 14;
const trail = [];
{
  const geo = new THREE.SphereGeometry(1, 8, 6);
  for (let i = 0; i < TRAIL_LEN; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffe9a8, transparent: true, opacity: 0, depthWrite: false, fog: false,
    }));
    m.visible = false;
    m.renderOrder = BALL_ORDER;
    catchScene.add(m);
    trail.push(m);
  }
}

const monHolder = new THREE.Group();
catchScene.add(monHolder);
const ballHolder = new THREE.Group();
catchScene.add(ballHolder);

// ---- State -------------------------------------------------------------------------------------
const BALL_HOME = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export const catchState = {
  active: false,
  phase: 'idle',      // aim -> flying -> wobble -> success | fail -> aim (auto) | empty
  dex: null,
  ballId: 'poke-ball',
  monObj: null,
  ballObj: null,
  monX: 0, monDrift: 0, monBodyY: 0.8, monHeight: 1.4,
  captureRadius: 0.78,
  ballRadius: 0.1,
  action: null,       // {type:'dodge'|'attack', t, dur} — the Pokemon's current move
  nextActionAt: 3,
  ball: null,         // {x,y,z,vx,vy,vz}
  ringPhase: 0,
  ringPeriod: 1.4,
  ringRatio: 1,
  ringColor: 0x4ade80,
  held: null,         // the finger currently holding the ball
  spin: 0,            // -1 / 0 / +1 — curveball direction, set while holding
  curve: false,       // whether the throw in flight is a curveball
  grade: null,        // 'excellent' | 'great' | 'nice' | 'hit'
  wobbles: 0,
  willCatch: false,
  resultMsg: '',
  accuracyPct: 0,
  onResult: null,     // (result) => void
  onThrow: null,      // () => bool: consume a ball; false means none left
  onGrade: null,      // (label) => void: pop "EXCELLENT!" etc. in the overlay
  onRearm: null,      // () => {ballId, ballsLeft} | null: GO hands you a fresh ball by itself
  ballsLeft: 0,
  canvasW: 1, canvasH: 1,
  t: 0,
  phaseT: 0,
};

function clearMon() {
  if (catchState.monObj) { disposeObject(catchState.monObj); catchState.monObj = null; }
}
function clearBall() {
  const b = catchState.ballObj;
  if (!b) return;
  disposeObject(b.userData.inner);
  b.parent?.remove(b);
  catchState.ballObj = null;
}
function hideTrail() {
  for (const m of trail) { m.visible = false; m.material.opacity = 0; }
}

// The target ring's colour is the difficulty of THIS catch, exactly as GO uses it: it folds in the
// ball you have selected, so switching to an Ultra Ball visibly turns the ring greener.
function ringColorFor(base) {
  if (base >= 0.68) return 0x4ade80;   // green  — comfortable
  if (base >= 0.54) return 0xfacc15;   // yellow — even odds
  if (base >= 0.40) return 0xfb923c;   // orange — long shot
  return 0xef4444;                     // red    — you will need a bonus
}

function refreshRingColor() {
  const item = ITEM_BY_ID.get(catchState.ballId);
  let base = item?.catchBase ?? 0.42;
  // Later-stage species make the same ball a worse bet, and the ring colour says so up front.
  const c = CATALOG_BY_DEX.get(catchState.dex);
  if (c?.stage === 'Stage2') base -= 0.10;
  else if (c?.stage === 'Stage1') base -= 0.05;
  catchState.ringColor = ringColorFor(base);
  TARGET_RING.material.color.setHex(catchState.ringColor);
}

// ---- Lifecycle ---------------------------------------------------------------------------------
// Start a fresh catch attempt sequence for one wild Pokemon. `theme` is the floor theme and it
// dresses the whole stage.
export function startCatch({ dex, ballId, ballsLeft, onResult, onThrow, onGrade, onRearm,
                             floorNumber = 1, theme = null }) {
  clearMon(); clearBall(); hideTrail();

  const th = theme || THEMES[0];
  if (!backdrop || backdropTheme?.id !== th.id) buildBackdrop(th);

  const c = CATALOG_BY_DEX.get(dex);
  const frac = MON_SCREEN_FRAC[c?.stage] ?? 0.28;
  const height = frac * 2 * halfHeightAt(targetDepth());

  Object.assign(catchState, {
    active: true, phase: 'aim', dex, ballId,
    monX: 0, monDrift: Math.random() * Math.PI * 2,
    monHeight: height,
    // The capture circle and the ring sit on the middle of the body, not on the feet — the throw
    // is aimed in two dimensions and the vertical half has to have something to aim at.
    monBodyY: height * 0.55,
    captureRadius: height * CAPTURE_OF_HEIGHT,
    action: null,
    // Deeper floors dodge and attack more often.
    nextActionAt: 2.4 + Math.random() * 1.6,
    // The one difficulty knob that scales with depth: a faster loop gives a narrower window on the
    // small end of the ring, so Excellent throws get genuinely harder as the run goes on.
    ringPeriod: 1.45 - Math.min(0.45, floorNumber * 0.09),
    ringPhase: 0, ringRatio: 1,
    ball: null, held: null, spin: 0, curve: false, grade: null,
    wobbles: 0, willCatch: false, resultMsg: '', accuracyPct: 0,
    onResult, onThrow, onGrade, onRearm, ballsLeft, t: 0, phaseT: 0,
  });
  refreshRingColor();

  const monObj = createMonObject(dex, { height });
  monObj.position.set(0, 0, TARGET_Z);
  monHolder.add(monObj);
  catchState.monObj = monObj;

  // Both rings are sized here, not just the capture circle. main.js starts the encounter from
  // INSIDE the playing branch of the frame loop, so that frame renders the catch scene without
  // ever calling updateCatch — and a target ring left at its unit scale is drawn a third again
  // too big for one frame, which pops.
  const r = catchState.captureRadius;
  CAPTURE_RING.scale.set(r, r, 1);
  TARGET_RING.scale.set(r, r, 1);
  CAPTURE_RING.position.set(0, catchState.monBodyY, TARGET_Z + 0.02);
  TARGET_RING.position.set(0, catchState.monBodyY, TARGET_Z + 0.03);
  CAPTURE_RING.visible = true;
  TARGET_RING.visible = true;

  spawnBall();
}

// One ball, centred on its OWN origin (createBallObject sits a model's feet at y=0, which is wrong
// for something that spins and tumbles) and scaled to its on-screen size for this aspect ratio.
// renderOrder is per-object and NOT inherited, so it has to go on every mesh in the ball group —
// and it has to be re-applied when the real model swaps in for the placeholder a load later, or
// the ball arrives at the Pokemon rendered BEHIND the depthTest-off capture rings. The ball is in
// your hand rather than on the floor, so it casts no shadow either.
function dressBall(pivot) {
  pivot.traverse(o => { o.renderOrder = BALL_ORDER; if (o.isMesh) o.castShadow = false; });
}

function spawnBall() {
  clearBall();
  hideTrail();
  const pivot = new THREE.Group();
  const inner = createBallObject(catchState.ballId, { size: 1, onReady: () => dressBall(pivot) });
  inner.position.y = -0.5;
  pivot.add(inner);
  pivot.userData.inner = inner;

  const d = ballWorldDiameter();
  catchState.ballRadius = d / 2;
  pivot.scale.setScalar(d);
  dressBall(pivot);

  pointAtNDC(BALL_HOME_NDC.x, BALL_HOME_NDC.y, BALL_DEPTH, BALL_HOME);
  pivot.position.copy(BALL_HOME);
  ballHolder.add(pivot);
  catchState.ballObj = pivot;
  catchState.ball = { x: BALL_HOME.x, y: BALL_HOME.y, z: BALL_HOME.z, vx: 0, vy: 0, vz: 0 };
  catchState.spin = 0;
  catchState.curve = false;
  SPIN_HALO.material.opacity = 0;
}

export function endCatch() {
  catchState.active = false;
  catchState.phase = 'idle';
  catchState.held = null;
  clearMon(); clearBall(); hideTrail();
  CAPTURE_RING.visible = false;
  TARGET_RING.visible = false;
  SPIN_HALO.material.opacity = 0;
}

// Swap the ball in hand for a different tier. Only legal while aiming — GO will not let you swap
// a ball that is already in the air either.
export function setCatchBall(ballId, ballsLeft) {
  if (!catchState.active) return;
  catchState.ballId = ballId;
  catchState.ballsLeft = ballsLeft;
  refreshRingColor();
  if (catchState.phase === 'aim') { catchState.held = null; spawnBall(); }
}

// ---- Throw input -------------------------------------------------------------------------------
// Touch anywhere: you have the ball. Drag: it tracks your finger in both axes, and swirling it
// winds up a curveball. Release with speed: that speed is the power and its direction is the aim.
//
// Tracking is RELATIVE to where the finger went down, never absolute — a ball that teleports to
// your thumb the instant you touch the screen looks broken, and it would also mean a touch that
// started near the edge of the screen flung the ball across the stage before you had aimed.
export function catchPointerDown(x, y, canvasW, canvasH) {
  if (!catchState.active || catchState.phase !== 'aim' || !catchState.ball) return;
  if (canvasW) { catchState.canvasW = canvasW; catchState.canvasH = canvasH; }
  catchState.held = {
    x0: x, y0: y, x, y,
    lastX: x, lastY: y, prevDx: 0, prevDy: 0,
    pathLen: 0, spinAccum: 0,
    samples: [{ x, y, t: performance.now() }],
  };
}

export function catchPointerMove(x, y, canvasW, canvasH) {
  const h = catchState.held;
  if (!h) return;
  if (canvasW) { catchState.canvasW = canvasW; catchState.canvasH = canvasH; }

  const dx = x - h.lastX, dy = y - h.lastY;
  const step = Math.hypot(dx, dy);
  if (step > 0.5) {
    h.pathLen += step;
    // Signed turn of the path: the cross product of consecutive deltas, normalised, is sin(angle).
    // Summing it over a swirl racks up fast; over a straight drag it cancels out to nothing.
    const prevMag = Math.hypot(h.prevDx, h.prevDy);
    if (prevMag > 0.5) {
      h.spinAccum += (h.prevDx * dy - h.prevDy * dx) / (prevMag * step);
    }
    h.prevDx = dx; h.prevDy = dy;
    h.lastX = x; h.lastY = y;
  }

  h.x = x; h.y = y;
  h.samples.push({ x, y, t: performance.now() });
  if (h.samples.length > 10) h.samples.shift();

  // Screen y grows downward, so a clockwise on-screen swirl is a negative cross product. Negate
  // once here so `spin` is +1 for a right-curving ball in world space.
  if (h.pathLen > SPIN_PATH_MIN && Math.abs(h.spinAccum) > SPIN_THRESHOLD) {
    catchState.spin = h.spinAccum > 0 ? -1 : 1;
  }
}

export function catchPointerUp(x, y, canvasW, canvasH) {
  const h = catchState.held;
  catchState.held = null;
  if (!catchState.active || catchState.phase !== 'aim' || !h) return;
  if (canvasW) { catchState.canvasW = canvasW; catchState.canvasH = canvasH; }
  const ch = catchState.canvasH;

  // Release velocity off the oldest sample still inside the flick window. Velocity rather than
  // total drag distance is what makes this a flick: you can drag the ball slowly across the screen
  // to line up your aim and it costs you no power, exactly as in GO.
  //
  // BOTH axes are normalised by screen HEIGHT, not one by each. Normalising x by width and y by
  // height would stretch the flick ANGLE by the aspect ratio, and the angle is the aim — the same
  // physical gesture would throw somewhere different on a tablet than on a phone.
  const now = performance.now();
  const recent = h.samples.filter(s => now - s.t < 140);
  const s0 = recent.length > 1 ? recent[0] : h.samples[0];
  const dt = Math.max(0.016, (now - s0.t) / 1000);
  const up = ((s0.y - y) / ch) / dt;
  const side = ((x - s0.x) / ch) / dt;
  const flick = Math.hypot(up, side);
  const angle = Math.atan2(side, up);          // 0 = straight up the screen, + = to the right

  if (up <= 0 || flick < MIN_FLICK || Math.abs(angle) > MAX_FLICK_ANGLE) {
    // Not a throw. Let the ball settle back home so it never reads as stuck mid-drag.
    catchState.spin = 0;
    SPIN_HALO.material.opacity = 0;
    return;
  }

  if (catchState.onThrow && catchState.onThrow() === false) return;   // out of balls
  catchState.ballsLeft = Math.max(0, catchState.ballsLeft - 1);

  const power = Math.min(1, (flick - MIN_FLICK) / (FLICK_FULL - MIN_FLICK));
  const speed = SPEED_MIN + power * SPEED_SPAN;
  const aim = THREE.MathUtils.clamp(angle * AIM_GAIN, -AIM_MAX, AIM_MAX);
  const horiz = speed * Math.cos(ELEV);

  const b = catchState.ball;
  b.vx = horiz * Math.sin(aim);
  b.vz = -horiz * Math.cos(aim);
  b.vy = speed * Math.sin(ELEV);

  catchState.curve = catchState.spin !== 0;
  catchState.phase = 'flying';
  catchState.phaseT = 0;
  hideTrail();
}

// ---- Frame update ------------------------------------------------------------------------------
export function updateCatch(dt) {
  if (!catchState.active) return;
  const s = catchState;
  s.t += dt;
  s.phaseT += dt;

  if (s.phase === 'aim' || s.phase === 'flying') {
    updateRing(dt);
    updateMon(dt);
  } else {
    TARGET_RING.visible = false;
  }

  if (s.phase === 'aim') updateHeldBall(dt);
  else if (s.phase === 'flying') updateFlight(dt);
  else if (s.phase === 'fail' || s.phase === 'empty') updateDeadBall(dt);
  else if (s.phase === 'wobble') updateWobble();
  else if (s.phase === 'success' && s.ballObj) {
    s.ballObj.rotation.z = 0;
    s.ballObj.position.y = s.ballRadius + Math.abs(Math.sin(s.phaseT * 2.4)) * s.ballRadius * 0.5;
  }
  fadeTrail(dt);
}

// The shrinking target ring, on a loop. Snaps back to full the instant it bottoms out.
function updateRing(dt) {
  const s = catchState;
  s.ringPhase += dt / s.ringPeriod;
  while (s.ringPhase >= 1) s.ringPhase -= 1;
  s.ringRatio = 1 - s.ringPhase * (1 - MIN_RING_RATIO);
  const r = s.ringRatio * s.captureRadius;
  TARGET_RING.visible = true;
  TARGET_RING.scale.set(r, r, 1);
  TARGET_RING.position.x = s.monX;
  CAPTURE_RING.position.x = s.monX;
}

// Idle bob, a slow drift, and — the GO part — periodic dodges and attacks.
function updateMon(dt) {
  const s = catchState;
  if (!s.monObj) return;

  if (s.action) {
    s.action.t += dt;
    if (s.action.t >= s.action.dur) {
      s.action = null;
      s.nextActionAt = s.t + 2.0 + Math.random() * 1.8;
    }
  } else if (s.t >= s.nextActionAt) {
    // A dodge is a hard sidestep; an attack lunges at the camera and swats a ball out of the air.
    // The windup half of an attack is deliberately readable so it can be waited out.
    const attack = Math.random() < 0.4;
    s.action = attack
      ? { type: 'attack', t: 0, dur: 0.95, dir: Math.random() < 0.5 ? -1 : 1 }
      : { type: 'dodge', t: 0, dur: 0.7, dir: Math.random() < 0.5 ? -1 : 1 };
  }

  // Base position: a slow wander. Capped at ±0.95 against an aim that reaches ±2.3 — a target that
  // wanders further than the throw can follow reads as a bug, not as difficulty.
  s.monDrift += dt * 0.55;
  let x = Math.sin(s.monDrift) * 0.35;
  let z = TARGET_Z;
  let lean = Math.sin(s.monDrift) * 0.3;
  let scale = 1;

  if (s.action) {
    const p = s.action.t / s.action.dur;
    if (s.action.type === 'dodge') {
      // Out and back on a sine, so the return trip is as much of a threat as the step out.
      x += s.action.dir * Math.sin(p * Math.PI) * 0.62;
      lean += s.action.dir * Math.sin(p * Math.PI) * 0.5;
    } else {
      // Windup (crouch) -> lunge toward the camera -> settle.
      const lunge = p < 0.45 ? -(p / 0.45) * 0.12 : Math.sin(((p - 0.45) / 0.55) * Math.PI) * 0.8;
      z += lunge;
      scale = 1 + Math.max(0, lunge) * 0.12;
    }
  }

  s.monX = THREE.MathUtils.clamp(x, -0.95, 0.95);
  s.monObj.position.set(s.monX, Math.abs(Math.sin(s.t * 3.2)) * s.monHeight * 0.05, z);
  s.monObj.rotation.y = lean;
  s.monObj.scale.setScalar(scale);
}

// True while an attack is actually swinging — a ball arriving in this window gets swatted.
function isSwatting() {
  const a = catchState.action;
  return !!a && a.type === 'attack' && a.t > a.dur * 0.45 && a.t < a.dur * 0.85;
}

function updateHeldBall(dt) {
  const s = catchState;
  const b = s.ball, obj = s.ballObj;
  if (!b || !obj) return;

  if (s.held) {
    // NDC offset from where the finger went down, added to the ball's home point. A drag of one
    // full screen width is 2 NDC, which is why the ratios are doubled.
    const ndcX = THREE.MathUtils.clamp(
      BALL_HOME_NDC.x + ((s.held.x - s.held.x0) / s.canvasW) * 2, -HOLD_NDC_X, HOLD_NDC_X);
    const ndcY = THREE.MathUtils.clamp(
      BALL_HOME_NDC.y - ((s.held.y - s.held.y0) / s.canvasH) * 2, HOLD_NDC_Y_LO, HOLD_NDC_Y_HI);
    pointAtNDC(ndcX, ndcY, BALL_DEPTH, _tmp);
    b.x = _tmp.x; b.y = _tmp.y; b.z = _tmp.z;
  } else {
    const k = Math.min(1, dt * 9);
    b.x += (BALL_HOME.x - b.x) * k;
    b.y += (BALL_HOME.y - b.y) * k;
    b.z += (BALL_HOME.z - b.z) * k;
  }
  obj.position.set(b.x, b.y, b.z);

  if (s.spin !== 0) {
    obj.rotation.y += dt * 22 * s.spin;
    SPIN_HALO.scale.setScalar(s.ballRadius * 1.9);
    SPIN_HALO.position.set(b.x, b.y, b.z + 0.02);
    SPIN_HALO.rotation.z += dt * 6 * s.spin;
    SPIN_HALO.material.opacity = Math.min(0.85, SPIN_HALO.material.opacity + dt * 4);
  } else {
    obj.rotation.y = 0;
    SPIN_HALO.material.opacity = Math.max(0, SPIN_HALO.material.opacity - dt * 4);
  }
}

function updateFlight(dt) {
  const s = catchState;
  const b = s.ball, obj = s.ballObj;
  if (!b || !obj) return;
  const p0 = { x: b.x, y: b.y, z: b.z };

  // Magnus bend on a curveball. This is why a curveball has to be aimed off to the side.
  if (s.curve) b.vx += s.spin * CURVE_ACCEL * dt;
  b.vy += GRAVITY * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  obj.position.set(b.x, b.y, b.z);
  obj.rotation.x -= dt * 12;
  if (s.curve) obj.rotation.y += dt * 26 * s.spin;
  SPIN_HALO.material.opacity = Math.max(0, SPIN_HALO.material.opacity - dt * 6);
  pushTrail(b.x, b.y, b.z);

  // Crossed the target plane: this is the moment accuracy and the ring size are measured. Checked
  // BEFORE the floor, and against the INTERPOLATED crossing point rather than the frame's end
  // position — at 0.6 s of flight a frame is a tenth of a capture circle of travel, which is the
  // difference between an Excellent and a miss.
  if (p0.z > TARGET_Z && b.z <= TARGET_Z) {
    const f = (p0.z - TARGET_Z) / (p0.z - b.z);
    resolveContact(p0.x + (b.x - p0.x) * f, p0.y + (b.y - p0.y) * f);
    return;
  }

  // Fell short: hit the ground before reaching the target plane. The `vy < 0` guard matters — the
  // ball launches from roughly this height, so without it a flat throw would register as falling
  // short on its first frame.
  if (b.y <= s.ballRadius && b.vy < 0) {
    b.y = s.ballRadius;
    b.vy = -b.vy * 0.45; b.vx *= 0.7; b.vz *= 0.6;
    finishThrow('short', 'The ball fell short!');
    return;
  }

  if (b.z < TARGET_Z - 6 || b.y < -3) finishThrow('miss', 'The ball missed!');
}

// Everything the throw earns is decided here, in one place, at the instant of contact.
function resolveContact(hx, hy) {
  const s = catchState;
  const b = s.ball;

  if (isSwatting()) {
    const name = CATALOG_BY_DEX.get(s.dex)?.name || 'It';
    // Swatted: the ball is knocked back toward the camera and off to one side.
    b.vx = (hx < s.monX ? -1 : 1) * 4.5;
    b.vy = 3.2; b.vz = 6.5;
    finishThrow('deflect', `${name} knocked the ball away!`);
    return;
  }

  // Two-dimensional hit test against the capture circle, centred on the body.
  const dx = hx - s.monX;
  const dy = hy - s.monBodyY;
  const dist = Math.hypot(dx, dy);
  const R = s.captureRadius;

  if (dist > R) {
    // Past it. The ball is left with its velocity so it carries on and lands behind, which is what
    // tells you which way you were off — a ball that vanishes on contact teaches nothing.
    if (dy > R * 0.6) finishThrow('over', 'The ball sailed clean over it!');
    else finishThrow('miss', 'The ball missed!');
    return;
  }

  // Inside the capture circle. The grade is the size of the target ring right now, GO-style — and
  // the ball has to be inside that ring, not merely inside the white circle.
  const ringR = s.ringRatio * R;
  let grade = 'hit';
  if (dist <= ringR) {
    if (s.ringRatio <= GRADE_EXCELLENT) grade = 'excellent';
    else if (s.ringRatio <= GRADE_GREAT) grade = 'great';
    else if (s.ringRatio <= GRADE_NICE) grade = 'nice';
  }

  const item = ITEM_BY_ID.get(s.ballId);
  const base = item?.catchBase ?? 0.42;
  const bonus = BONUS[grade] + (s.curve ? CURVE_BONUS : 0);
  const chance = Math.min(0.97, base + bonus);

  s.grade = grade;
  s.willCatch = Math.random() < chance;
  s.accuracyPct = Math.round((1 - dist / R) * 100);

  const label = grade === 'hit' ? null
    : grade === 'excellent' ? 'EXCELLENT!'
    : grade === 'great' ? 'GREAT!' : 'NICE!';
  if (label || s.curve) s.onGrade?.([s.curve ? 'CURVEBALL!' : null, label].filter(Boolean).join(' '));

  // The number of wobbles telegraphs how close the roll was, same as the real games.
  s.wobbles = s.willCatch ? 3 : chance > 0.6 ? 3 : chance > 0.42 ? 2 : 1;
  s.phase = 'wobble';
  s.phaseT = 0;
  hideTrail();
  TARGET_RING.visible = false;
  CAPTURE_RING.visible = false;
  // The Pokemon is drawn into the ball, which then drops to the ground where it was standing.
  s.ballObj.position.set(s.monX, s.monBodyY, TARGET_Z);
  s.ballObj.rotation.set(0, 0, 0);
  if (s.monObj) s.monObj.visible = false;
}

// GO's wobble: the ball falls to the ground first, settles, then rocks side to side once per
// wobble. The fall is what makes the wobble read as happening on the floor rather than in mid-air.
const DROP_TIME = 0.32;
const WOBBLE_PER = 0.62;

function updateWobble() {
  const s = catchState;
  if (!s.ballObj) return;
  const groundY = s.ballRadius;

  if (s.phaseT < DROP_TIME) {
    const p = s.phaseT / DROP_TIME;
    s.ballObj.position.y = s.monBodyY + (groundY - s.monBodyY) * (p * p);
    s.ballObj.rotation.x -= 0.08;
    return;
  }

  const wt = s.phaseT - DROP_TIME;
  const total = WOBBLE_PER * s.wobbles;
  const inWobble = (wt % WOBBLE_PER) / WOBBLE_PER;
  s.ballObj.rotation.x = 0;
  s.ballObj.rotation.z = Math.sin(inWobble * Math.PI * 2) * 0.45 * (1 - inWobble * 0.4);
  s.ballObj.position.y = groundY + Math.abs(Math.sin(inWobble * Math.PI * 2)) * groundY * 0.35;
  if (wt <= total) return;

  s.ballObj.rotation.z = 0;
  if (s.willCatch) {
    s.phase = 'success';
    s.phaseT = 0;
    s.resultMsg = `Gotcha! ${CATALOG_BY_DEX.get(s.dex)?.name || 'It'} was caught!`;
    s.onResult?.({
      caught: true, msg: s.resultMsg, ballId: s.ballId, dex: s.dex,
      accuracy: s.accuracyPct, grade: s.grade, curve: s.curve,
    });
  } else {
    // Burst open: the Pokemon is back out and the ball is flung aside.
    if (s.monObj) s.monObj.visible = true;
    CAPTURE_RING.visible = true;
    const b = s.ball;
    b.x = s.monX; b.y = groundY; b.z = TARGET_Z;
    b.vx = (Math.random() < 0.5 ? -1 : 1) * 2.2; b.vy = 3.4; b.vz = 2.6;
    finishThrow('broke', 'Argh! It broke free!');
  }
}

// A dead ball keeps tumbling and bouncing for a beat, and then a fresh one appears in your hand.
// That automatic re-arm is why there is no "throw again" button: GO does not have one, and having
// to press one between every throw is the single biggest thing that stopped this feeling like GO.
function updateDeadBall(dt) {
  const s = catchState;
  const b = s.ball, obj = s.ballObj;
  if (b && obj) {
    b.vy += GRAVITY * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    if (b.y < s.ballRadius) {
      b.y = s.ballRadius;
      b.vy = Math.abs(b.vy) * 0.42;
      b.vx *= 0.68; b.vz *= 0.68;
      if (b.vy < 0.35) { b.vy = 0; b.vx *= 0.4; b.vz *= 0.4; }
    }
    obj.position.set(b.x, b.y, b.z);
    obj.rotation.x -= dt * 7;
    obj.rotation.z += dt * 3;
  }
  if (s.phase === 'empty' || s.phaseT < FAIL_HOLD) return;

  const next = s.onRearm?.();
  if (!next) { s.phase = 'empty'; s.phaseT = 0; return; }
  s.ballId = next.ballId;
  s.ballsLeft = next.ballsLeft;
  s.phase = 'aim';
  s.phaseT = 0;
  s.grade = null;
  s.willCatch = false;
  s.held = null;
  if (s.monObj) s.monObj.visible = true;
  CAPTURE_RING.visible = true;
  TARGET_RING.visible = true;
  refreshRingColor();
  spawnBall();
}

// ---- Trail -------------------------------------------------------------------------------------
let trailNext = 0, trailClock = 0;
function pushTrail(x, y, z) {
  trailClock += 1;
  if (trailClock % 2) return;                 // every other frame is plenty
  const m = trail[trailNext];
  trailNext = (trailNext + 1) % TRAIL_LEN;
  m.position.set(x, y, z);
  m.scale.setScalar(catchState.ballRadius * 0.55);
  m.visible = true;
  m.material.opacity = 0.5;
}
function fadeTrail(dt) {
  for (const m of trail) {
    if (!m.visible) continue;
    m.material.opacity -= dt * 1.8;
    if (m.material.opacity <= 0) { m.visible = false; m.material.opacity = 0; }
  }
}

// A failed throw: report it, then let updateDeadBall re-arm when the beat is up.
// `reason` is what main.js branches on — string-matching the message was fragile.
function finishThrow(reason, msg) {
  const s = catchState;
  s.resultMsg = msg;
  s.grade = null;
  s.phase = 'fail';
  s.phaseT = 0;
  s.spin = 0;
  s.curve = false;
  SPIN_HALO.material.opacity = 0;
  s.onResult?.({ caught: false, reason, msg, ballId: s.ballId, dex: s.dex, outOfBalls: s.ballsLeft <= 0 });
}
