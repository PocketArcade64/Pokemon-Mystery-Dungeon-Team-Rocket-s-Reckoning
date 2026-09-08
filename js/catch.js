// The catch minigame: a faithful reproduction of the Pokemon GO throw.
//
// The five things that make a GO throw a GO throw, all of them here:
//   1. You grab the ball at the bottom of the screen and it FOLLOWS YOUR FINGER sideways. Lining
//      the ball up under the Pokemon is the aim; there is no aim line and no slingshot pull-back.
//   2. A white CAPTURE CIRCLE sits on the Pokemon, and a coloured TARGET RING inside it shrinks
//      and resets on a loop. Its colour is the difficulty of the catch (green easy -> red hard).
//   3. Landing the ball inside the target ring is a graded bonus, by how small the ring was at
//      the instant of contact: Nice / Great / Excellent.
//   4. Swirling the ball before you flick throws a CURVEBALL — it spins, bends in flight, and
//      pays its own bonus. You have to aim off to the side to compensate.
//   5. The Pokemon dodges and attacks. An attack swats a ball out of the air.
//
// Success is HYBRID (confirmed design decision) — both halves matter:
//   base chance    from the ball tier   (Poke 0.42 / Great 0.58 / Ultra 0.74, from items.js)
//   accuracy bonus from the throw       (up to +0.26, the confirmed ceiling)
// The +0.26 is split so that a curveball Excellent — the best throw in the game — lands exactly
// on the cap: Excellent 0.20 + Curveball 0.06. A throw that misses the capture circle, falls
// short, sails over or gets swatted away fails outright without a roll.
//
// This runs in its own scene with a perspective camera (depth cues make the throw readable in a
// way the game's orthographic overhead rig cannot), rendered through the main renderer.
import * as THREE from 'three';
import { createMonObject, createBallObject, disposeObject } from './models.js';
import { registerCamera } from './three-setup.js';
import { ITEM_BY_ID } from './data/items.js';
import { CATALOG_BY_DEX } from './data/pokemon-catalog.js';

const TARGET_Z = -5.2;            // depth plane the target Pokemon lives on
const OUTER_RADIUS = 1.05;        // the white capture circle: outside this, the throw misses
const MIN_RING_RATIO = 0.13;      // how far the target ring shrinks before it resets
const GRAVITY = -9.5;
const BALL_HOME = { x: 0, y: 0.32, z: -0.7 };
const HOLD_X_LIMIT = 1.6;         // how far left/right the held ball can be dragged

// Ring ratio at the moment of contact -> grade. GO uses 0.7 / 0.3 / 0.1 of the capture circle;
// ours are a shade more forgiving because the circle is physically smaller on this stage.
const GRADE_EXCELLENT = 0.30;
const GRADE_GREAT = 0.55;
const GRADE_NICE = 0.80;

const BONUS = { excellent: 0.20, great: 0.13, nice: 0.06, hit: 0 };
const CURVE_BONUS = 0.06;

// Curveball detection. `spinAccum` sums the signed turn of the drag path (radians-ish); a real
// swirl racks it up fast, a straight drag with a wobble in it cannot reach the threshold. The
// path-length floor stops a stationary jittering finger from spinning the ball for free.
const SPIN_THRESHOLD = 2.6;
const SPIN_PATH_MIN = 110;        // px of drag before a swirl counts at all
const CURVE_ACCEL = 5.4;          // sideways acceleration on a spinning ball, units/s^2

// A flick is measured as release VELOCITY in screen-heights per second, so the feel is identical
// on any screen size. Below MIN_FLICK it is a tap or a fumble, not a throw.
const MIN_FLICK = 0.5;
const FLICK_FULL = 3.1;           // velocity that maps to full power

export const catchScene = new THREE.Scene();
catchScene.background = new THREE.Color(0x140d22);
catchScene.fog = new THREE.Fog(0x140d22, 10, 22);

// Framed so the target platform sits in the upper-middle of a tall portrait screen and the ball's
// resting spot stays clear of the overlay controls along the bottom.
export const catchCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
catchCamera.position.set(0, 3.5, 4.6);
catchCamera.lookAt(0, 1.45, -2.6);
registerCamera(catchCamera);

catchScene.add(new THREE.HemisphereLight(0xbcd4ff, 0x2a2438, 1.1));
const catchDir = new THREE.DirectionalLight(0xfff2dc, 1.15);
catchDir.position.set(-3, 8, 4);
catchDir.castShadow = true;
catchDir.shadow.mapSize.set(1024, 1024);
catchDir.shadow.normalBias = 0.05;
catchScene.add(catchDir);

// Stage: a dark ground plane plus a lit disc under the target, so the throw has a depth reference.
{
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x1c1430, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  catchScene.add(ground);

  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.8, 0.16, 28),
    new THREE.MeshStandardMaterial({ color: 0x3a2b60, roughness: 0.7 }),
  );
  disc.position.set(0, 0.08, TARGET_Z);
  disc.receiveShadow = true;
  catchScene.add(disc);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.75, 2.0, 32),
    new THREE.MeshBasicMaterial({ color: 0x8b6fd8, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, 0.17, TARGET_Z);
  catchScene.add(ring);
}

// ---- The two rings on the Pokemon --------------------------------------------------------------
// Both are billboards. The camera never moves, so the facing quaternion is copied once at build
// time rather than refreshed per frame.
//
// depthTest is OFF on both, and this is load-bearing rather than cosmetic. The circle is centred
// on the Pokemon's BODY, so its lower arc dips below the stage floor — depth-tested, the ground
// plane eats the bottom third of it and what is left reads as a broken arc rather than a circle.
// These rings are a HUD drawn into the 3D scene, exactly as GO's are, so they get HUD rules:
// never occluded, drawn in front of the Pokemon, and RING_ORDER keeps the thrown ball in front
// of them in turn.
const RING_ORDER = 5;
const BALL_ORDER = 6;

const CAPTURE_RING = new THREE.Mesh(
  new THREE.RingGeometry(OUTER_RADIUS - 0.045, OUTER_RADIUS, 56),
  new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
    depthWrite: false, depthTest: false,
  }),
);
CAPTURE_RING.quaternion.copy(catchCamera.quaternion);
CAPTURE_RING.renderOrder = RING_ORDER;
CAPTURE_RING.visible = false;
catchScene.add(CAPTURE_RING);

// Unit-radius ring, scaled every frame. The stroke scales with it, which is what GO's does — the
// ring genuinely reads as a thin hoop closing in on the target.
const TARGET_RING = new THREE.Mesh(
  new THREE.RingGeometry(0.80, 1.0, 44),
  new THREE.MeshBasicMaterial({
    color: 0x4ade80, transparent: true, opacity: 0.92, side: THREE.DoubleSide,
    depthWrite: false, depthTest: false,
  }),
);
TARGET_RING.quaternion.copy(catchCamera.quaternion);
TARGET_RING.renderOrder = RING_ORDER;
TARGET_RING.visible = false;
catchScene.add(TARGET_RING);

// Spin halo: the only tell that the ball in your hand is going to curve.
const SPIN_HALO = new THREE.Mesh(
  new THREE.RingGeometry(0.30, 0.40, 24),
  new THREE.MeshBasicMaterial({
    color: 0xffd95e, transparent: true, opacity: 0.0, side: THREE.DoubleSide,
    depthWrite: false, depthTest: false,
  }),
);
SPIN_HALO.quaternion.copy(catchCamera.quaternion);
SPIN_HALO.renderOrder = RING_ORDER;
catchScene.add(SPIN_HALO);

// A short trail so a curveball's bend is legible in flight.
const TRAIL_LEN = 12;
const trail = [];
{
  const geo = new THREE.SphereGeometry(0.055, 8, 6);
  for (let i = 0; i < TRAIL_LEN; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffe9a8, transparent: true, opacity: 0, depthWrite: false,
    }));
    m.visible = false;
    catchScene.add(m);
    trail.push(m);
  }
}

const monHolder = new THREE.Group();
catchScene.add(monHolder);
const ballHolder = new THREE.Group();
catchScene.add(ballHolder);

export const catchState = {
  active: false,
  phase: 'idle',      // aim -> flying -> wobble -> success / fail
  dex: null,
  ballId: 'poke-ball',
  monObj: null,
  ballObj: null,
  monX: 0, monDrift: 0, monBodyY: 0.8, monHeight: 1.1,
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
  wobbleT: 0,
  willCatch: false,
  resultMsg: '',
  accuracyPct: 0,
  onResult: null,     // (result) => void
  onThrow: null,      // () => bool: consume a ball; false means none left
  onGrade: null,      // (label) => void: pop "EXCELLENT!" etc. in the overlay
  ballsLeft: 0,
  canvasW: 1, canvasH: 1,
  t: 0,
  phaseT: 0,
};

function clearMon() {
  if (catchState.monObj) { disposeObject(catchState.monObj); catchState.monObj = null; }
}
function clearBall() {
  if (catchState.ballObj) { disposeObject(catchState.ballObj); catchState.ballObj = null; }
}
function hideTrail() {
  for (const m of trail) { m.visible = false; m.material.opacity = 0; }
}

// The target ring's colour is the difficulty of THIS catch, exactly as GO uses it: it folds in
// the ball you have selected, so switching to an Ultra Ball visibly turns the ring greener.
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

// Start a fresh catch attempt sequence for one wild Pokemon.
// `ballsLeft` is how many of `ballId` the player is holding; a throw calls onThrow() to spend one.
export function startCatch({ dex, ballId, ballsLeft, onResult, onThrow, onGrade, floorNumber = 1 }) {
  clearMon(); clearBall(); hideTrail();
  const c = CATALOG_BY_DEX.get(dex);
  const height = c && c.stage === 'Stage2' ? 1.5 : c && c.stage === 'Stage1' ? 1.3 : 1.1;

  Object.assign(catchState, {
    active: true, phase: 'aim', dex, ballId,
    monX: 0, monDrift: Math.random() * Math.PI * 2,
    monHeight: height,
    // The capture circle and the ring sit on the middle of the body, not on the feet — the throw
    // is aimed in two dimensions and the vertical half has to have something to aim at.
    monBodyY: 0.16 + height * 0.55,
    action: null,
    // Deeper floors dodge and attack more often. This replaced the old constant side-to-side
    // sway: a target that slides back and forth forever is not what GO does, and it made the
    // horizontal half of the aim the whole game.
    nextActionAt: 2.4 + Math.random() * 1.6,
    // The one difficulty knob that scales with depth: a faster loop gives a narrower window on
    // the small end of the ring, so Excellent throws get genuinely harder as the run goes on.
    ringPeriod: 1.45 - Math.min(0.45, floorNumber * 0.09),
    ringPhase: 0, ringRatio: 1,
    ball: null, held: null, spin: 0, curve: false, grade: null,
    wobbles: 0, wobbleT: 0, willCatch: false, resultMsg: '', accuracyPct: 0,
    onResult, onThrow, onGrade, ballsLeft, t: 0, phaseT: 0,
  });
  refreshRingColor();

  const monObj = createMonObject(dex, { height });
  monObj.position.set(0, 0.16, TARGET_Z);
  monHolder.add(monObj);
  catchState.monObj = monObj;

  CAPTURE_RING.position.set(0, catchState.monBodyY, TARGET_Z + 0.02);
  TARGET_RING.position.set(0, catchState.monBodyY, TARGET_Z + 0.03);
  CAPTURE_RING.visible = true;
  TARGET_RING.visible = true;

  spawnBall();
}

function spawnBall() {
  clearBall();
  hideTrail();
  const obj = createBallObject(catchState.ballId, { size: 0.42 });
  obj.position.set(BALL_HOME.x, BALL_HOME.y, BALL_HOME.z);
  // renderOrder is per-object, not inherited, so it has to go on every mesh in the ball group.
  obj.traverse(o => { o.renderOrder = BALL_ORDER; });
  ballHolder.add(obj);
  catchState.ballObj = obj;
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

// ---- Throw input -------------------------------------------------------------------------------
// Touch down anywhere: you have the ball. Drag: it slides with your finger, and swirling it winds
// up a curveball. Release with upward speed: that speed is the power and its direction is the aim.
export function catchPointerDown(x, y, canvasW, canvasH) {
  if (!catchState.active || catchState.phase !== 'aim' || !catchState.ball) return;
  if (canvasW) { catchState.canvasW = canvasW; catchState.canvasH = canvasH; }
  catchState.held = {
    x0: x, y0: y, x, y,
    ballX0: catchState.ball.x,
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
  if (h.samples.length > 8) h.samples.shift();

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
  const cw = catchState.canvasW, ch = catchState.canvasH;

  // Release velocity from the oldest sample still inside the flick window. Using velocity rather
  // than total drag distance is what makes this a flick: you can drag the ball slowly across the
  // screen to line up your aim and it costs you no power, exactly as in GO.
  const now = performance.now();
  const recent = h.samples.filter(s => now - s.t < 130);
  const s0 = recent.length > 1 ? recent[0] : h.samples[0];
  const dt = Math.max(0.016, (now - s0.t) / 1000);
  const vUp = ((s0.y - y) / ch) / dt;         // screen-heights per second, upward
  const vSide = ((x - s0.x) / cw) / dt;       // screen-widths per second, rightward

  if (vUp < MIN_FLICK) {
    // Not a throw. Let the ball settle back home so it never reads as stuck mid-drag.
    const b = catchState.ball;
    if (b) { b.x = BALL_HOME.x; b.y = BALL_HOME.y; }
    catchState.spin = 0;
    SPIN_HALO.material.opacity = 0;
    return;
  }

  if (catchState.onThrow && catchState.onThrow() === false) return;   // out of balls
  catchState.ballsLeft = Math.max(0, catchState.ballsLeft - 1);

  // Ballistic, gravity-decided, NOT back-solved to guarantee arrival — that part of the old throw
  // was right and is kept. Power is a coarse three-way gate (falls short / connects / sails over)
  // and the ring plus the aim are the fine skill, which is the balance GO strikes: most throws
  // reach the Pokemon, and what separates them is where in the ring they land.
  // With the numbers below, on a Basic-stage target: power under ~0.21 hits the floor first,
  // ~0.21-0.84 connects, and over ~0.84 clears the capture circle entirely.
  const power = Math.min(1, (vUp - MIN_FLICK) / (FLICK_FULL - MIN_FLICK));
  const speed = 5.0 + power * 9.0;
  const b = catchState.ball;
  b.vz = -speed * 0.90;
  b.vy = speed * 0.44;
  b.vx = vSide * 3.0;

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
  if (s.phase === 'flying') updateFlight(dt);
  if (s.phase === 'wobble') updateWobble();
  if (s.phase === 'success' && s.ballObj) {
    s.ballObj.rotation.y += dt * 3;
    s.ballObj.position.y = (s.monBodyY - 0.25) + Math.sin(s.phaseT * 3) * 0.08;
  }
  fadeTrail(dt);
}

// The shrinking target ring, on a loop. Snaps back to full the instant it bottoms out.
function updateRing(dt) {
  const s = catchState;
  s.ringPhase += dt / s.ringPeriod;
  while (s.ringPhase >= 1) s.ringPhase -= 1;
  s.ringRatio = 1 - s.ringPhase * (1 - MIN_RING_RATIO);
  const r = s.ringRatio * OUTER_RADIUS;
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

  // Base position: a slow wander, capped well inside the 1.8-radius platform. A target that
  // wanders off the edge of frame reads as a bug, not as difficulty.
  s.monDrift += dt * 0.55;
  let x = Math.sin(s.monDrift) * 0.5;
  let z = TARGET_Z;
  let lean = Math.sin(s.monDrift) * 0.35;
  let scale = 1;

  if (s.action) {
    const p = s.action.t / s.action.dur;
    if (s.action.type === 'dodge') {
      // Out and back on a sine, so the return trip is as much of a threat as the step out.
      x += s.action.dir * Math.sin(p * Math.PI) * 0.85;
      lean += s.action.dir * Math.sin(p * Math.PI) * 0.5;
    } else {
      // Windup (crouch) -> lunge toward the camera -> settle.
      const lunge = p < 0.45 ? -(p / 0.45) * 0.12 : Math.sin(((p - 0.45) / 0.55) * Math.PI) * 0.9;
      z += lunge;
      scale = 1 + Math.max(0, lunge) * 0.12;
    }
  }

  s.monX = Math.max(-1.2, Math.min(1.2, x));
  s.monObj.position.set(s.monX, 0.16 + Math.abs(Math.sin(s.t * 3.2)) * 0.08, z);
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
    // Sideways only, relative to where the ball was when you grabbed it: this is the aim.
    const dxScreen = (s.held.x - s.held.x0) / s.canvasW;
    b.x = Math.max(-HOLD_X_LIMIT, Math.min(HOLD_X_LIMIT, s.held.ballX0 + dxScreen * 2 * HOLD_X_LIMIT));
    // A touch of lift so the ball visibly answers a vertical drag before it is released.
    const upScreen = Math.max(0, (s.held.y0 - s.held.y) / s.canvasH);
    b.y = BALL_HOME.y + Math.min(0.3, upScreen * 0.9);
  } else {
    b.x += (BALL_HOME.x - b.x) * Math.min(1, dt * 8);
    b.y += (BALL_HOME.y - b.y) * Math.min(1, dt * 8);
  }
  obj.position.set(b.x, b.y, b.z);

  if (s.spin !== 0) {
    obj.rotation.y += dt * 22 * s.spin;
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
  const prevZ = b.z;

  // Magnus bend on a curveball. This is why a curveball has to be aimed off to the side.
  if (s.curve) b.vx += s.spin * CURVE_ACCEL * dt;
  b.vy += GRAVITY * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  obj.position.set(b.x, b.y, b.z);
  obj.rotation.x -= dt * 12;
  if (s.curve) obj.rotation.y += dt * 26 * s.spin;
  SPIN_HALO.material.opacity = Math.max(0, SPIN_HALO.material.opacity - dt * 6);
  pushTrail(b.x, b.y, b.z);

  // Fell short: hit the ground before reaching the target plane. The `vy < 0` guard matters — the
  // ball launches from roughly this height, so without it every throw would register as falling
  // short on its first frame.
  if (b.y <= 0.15 && b.vy < 0 && b.z > TARGET_Z) {
    b.y = 0.16;
    finishThrow('short', 'The ball fell short!');
    return;
  }

  // Crossed the target plane: this is the moment accuracy and the ring size are measured.
  if (prevZ > TARGET_Z && b.z <= TARGET_Z) {
    resolveContact(b);
    return;
  }

  if (b.z < TARGET_Z - 4 || b.y < -2) { finishThrow('miss', 'The ball missed!'); return; }
}

// Everything the throw earns is decided here, in one place, at the instant of contact.
function resolveContact(b) {
  const s = catchState;

  if (isSwatting()) {
    const name = CATALOG_BY_DEX.get(s.dex)?.name || 'It';
    finishThrow('deflect', `${name} knocked the ball away!`);
    return;
  }

  // Two-dimensional hit test against the capture circle, centred on the body. The old version
  // only compared x and used a flat height cutoff, which meant the vertical half of the aim was
  // not really being tested.
  const dx = b.x - s.monX;
  const dy = b.y - s.monBodyY;
  const dist = Math.hypot(dx, dy);

  if (dist > OUTER_RADIUS) {
    if (dy > OUTER_RADIUS * 0.6) finishThrow('over', 'The ball sailed clean over it!');
    else finishThrow('miss', 'The ball missed!');
    return;
  }

  // Inside the capture circle. The grade is the size of the target ring right now, GO-style —
  // and the ball has to be inside that ring, not merely inside the white circle.
  const ringR = s.ringRatio * OUTER_RADIUS;
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
  s.accuracyPct = Math.round((1 - dist / OUTER_RADIUS) * 100);

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
  s.ballObj.position.set(s.monX, s.monBodyY - 0.25, TARGET_Z);
  s.ballObj.rotation.set(0, 0, 0);
  if (s.monObj) s.monObj.visible = false;
}

function updateWobble() {
  const s = catchState;
  if (!s.ballObj) return;
  const per = 0.55;
  const total = per * s.wobbles;
  s.ballObj.rotation.z = Math.sin(s.phaseT * 9) * 0.4 * (1 - (s.phaseT % per) / per);
  s.ballObj.position.y = (s.monBodyY - 0.25) + Math.abs(Math.sin(s.phaseT * 9)) * 0.06;
  if (s.phaseT <= total) return;

  if (s.willCatch) {
    s.phase = 'success';
    s.phaseT = 0;
    s.resultMsg = `Gotcha! ${CATALOG_BY_DEX.get(s.dex)?.name || 'It'} was caught!`;
    s.onResult?.({
      caught: true, msg: s.resultMsg, ballId: s.ballId, dex: s.dex,
      accuracy: s.accuracyPct, grade: s.grade, curve: s.curve,
    });
  } else {
    if (s.monObj) s.monObj.visible = true;
    CAPTURE_RING.visible = true;
    finishThrow('broke', 'Argh! It broke free!');
  }
}

// ---- Trail -------------------------------------------------------------------------------------
let trailNext = 0, trailClock = 0;
function pushTrail(x, y, z) {
  trailClock += 1;
  if (trailClock % 2) return;                 // every other frame is plenty
  const m = trail[trailNext];
  trailNext = (trailNext + 1) % TRAIL_LEN;
  m.position.set(x, y, z);
  m.visible = true;
  m.material.opacity = 0.55;
}
function fadeTrail(dt) {
  for (const m of trail) {
    if (!m.visible) continue;
    m.material.opacity -= dt * 1.8;
    if (m.material.opacity <= 0) { m.visible = false; m.material.opacity = 0; }
  }
}

// A failed throw: report it, then either re-arm with another ball or end the attempt.
// `reason` is what main.js branches on — string-matching the message was fragile.
function finishThrow(reason, msg) {
  const s = catchState;
  s.resultMsg = msg;
  s.grade = null;
  s.phase = 'fail';
  s.spin = 0;
  s.curve = false;
  SPIN_HALO.material.opacity = 0;
  s.onResult?.({ caught: false, reason, msg, ballId: s.ballId, dex: s.dex, outOfBalls: s.ballsLeft <= 0 });
}

// Called by the overlay's "Throw again" affordance once the player has a ball to spend.
export function rearm(ballId, ballsLeft) {
  if (!catchState.active) return;
  catchState.ballId = ballId;
  catchState.ballsLeft = ballsLeft;
  catchState.phase = 'aim';
  catchState.phaseT = 0;
  catchState.willCatch = false;
  catchState.grade = null;
  catchState.held = null;
  if (catchState.monObj) catchState.monObj.visible = true;
  CAPTURE_RING.visible = true;
  TARGET_RING.visible = true;
  refreshRingColor();
  spawnBall();
}
