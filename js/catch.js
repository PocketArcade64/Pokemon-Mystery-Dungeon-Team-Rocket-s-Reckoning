// The catch minigame: Pokemon GO-style aim-and-throw with the real Quest ball and Pokemon models.
//
// Success is HYBRID (confirmed decision) — both halves matter:
//   base chance   from the ball tier   (Poke 0.42 / Great 0.58 / Ultra 0.74, from items.js)
//   accuracy bonus from the throw      (up to +0.26, scaled by how close the ball arrives to the
//                                       moving target's centre)
// A throw that misses the target entirely, or falls short on power, fails outright without a roll.
//
// This runs in its own scene with a perspective camera (depth cues make the throw readable in a
// way the game's orthographic overhead rig cannot), rendered through the main renderer.
import * as THREE from 'three';
import { createMonObject, createBallObject, disposeObject } from './models.js';
import { registerCamera } from './three-setup.js';
import { ITEM_BY_ID } from './data/items.js';
import { CATALOG_BY_DEX } from './data/pokemon-catalog.js';

const TARGET_Z = -5.2;          // depth plane the target Pokemon lives on
const HIT_RADIUS = 0.95;        // lateral distance within which the ball counts as a hit
const MAX_ACCURACY_BONUS = 0.26;
const GRAVITY = -9.5;

export const catchScene = new THREE.Scene();
catchScene.background = new THREE.Color(0x12182a);
catchScene.fog = new THREE.Fog(0x12182a, 10, 22);

// Framed so the target platform sits in the upper-middle of a tall portrait screen and the ball's
// throw origin stays clear of the overlay controls along the bottom.
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
    new THREE.MeshStandardMaterial({ color: 0x1d2438, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  catchScene.add(ground);

  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.7, 1.8, 0.16, 28),
    new THREE.MeshStandardMaterial({ color: 0x33406b, roughness: 0.7 }),
  );
  disc.position.set(0, 0.08, TARGET_Z);
  disc.receiveShadow = true;
  catchScene.add(disc);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.75, 2.0, 32),
    new THREE.MeshBasicMaterial({ color: 0x6f8fd8, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, 0.17, TARGET_Z);
  catchScene.add(ring);
}

// The aim guide: a thin quad from the throw origin toward where the player is pointing.
const aimLine = new THREE.Mesh(
  new THREE.PlaneGeometry(0.06, 1),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
);
aimLine.rotation.x = -Math.PI / 2;
aimLine.visible = false;
catchScene.add(aimLine);

// A reticle that tracks the target along the ground. Without it there is no way to read HOW FAR
// the target has drifted, which makes "lead the target" guesswork rather than a skill.
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.62, 0.8, 28),
  new THREE.MeshBasicMaterial({
    color: 0xffd95e, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
  }),
);
reticle.rotation.x = -Math.PI / 2;
reticle.position.set(0, 0.18, TARGET_Z);
reticle.visible = false;
catchScene.add(reticle);

const monHolder = new THREE.Group();
catchScene.add(monHolder);
const ballHolder = new THREE.Group();
catchScene.add(ballHolder);

export const catchState = {
  active: false,
  phase: 'idle',      // aim -> flying -> wobble -> success -> fail
  dex: null,
  ballId: 'poke-ball',
  monObj: null,
  ballObj: null,
  monX: 0, monSway: 0, monSpeed: 1.1, monRange: 2.0,
  ball: null,         // {x,y,z,vx,vy,vz}
  wobbles: 0,
  wobbleT: 0,
  willCatch: false,
  resultMsg: '',
  onResult: null,     // (result) => void, result = {caught, msg, ballId}
  onThrow: null,      // () => bool: consume a ball; false means none left
  ballsLeft: 0,
  drag: null,
  t: 0,
  phaseT: 0,
};

function clearMon() {
  if (catchState.monObj) { disposeObject(catchState.monObj); catchState.monObj = null; }
}
function clearBall() {
  if (catchState.ballObj) { disposeObject(catchState.ballObj); catchState.ballObj = null; }
}

// Start a fresh catch attempt sequence for one wild Pokemon.
// `ballsLeft` is how many of `ballId` the player is holding; a throw calls onThrow() to spend one.
export function startCatch({ dex, ballId, ballsLeft, onResult, onThrow, floorNumber = 1 }) {
  clearMon(); clearBall();
  const c = CATALOG_BY_DEX.get(dex);
  const height = c && c.stage === 'Stage2' ? 1.5 : c && c.stage === 'Stage1' ? 1.3 : 1.1;

  Object.assign(catchState, {
    active: true, phase: 'aim', dex, ballId,
    monX: 0, monSway: Math.random() * Math.PI * 2,
    // Deeper floors have jumpier targets, so accuracy gets genuinely harder as the run goes on.
    // The range is capped so the target never sways off its own platform (radius 1.8) — a target
    // that wanders into empty space off the edge of frame just reads as a bug.
    monSpeed: 0.85 + floorNumber * 0.16,
    monRange: 0.95 + Math.min(0.5, floorNumber * 0.1),
    ball: null, wobbles: 0, wobbleT: 0, willCatch: false, resultMsg: '',
    onResult, onThrow, ballsLeft, drag: null, t: 0, phaseT: 0,
  });

  const monObj = createMonObject(dex, { height });
  monObj.position.set(0, 0.16, TARGET_Z);
  monHolder.add(monObj);
  catchState.monObj = monObj;

  spawnBall();
}

function spawnBall() {
  clearBall();
  const obj = createBallObject(catchState.ballId, { size: 0.42 });
  obj.position.set(0, 0.28, -0.9);
  ballHolder.add(obj);
  catchState.ballObj = obj;
  catchState.ball = { x: 0, y: 0.28, z: -0.9, vx: 0, vy: 0, vz: 0 };
}

export function endCatch() {
  catchState.active = false;
  catchState.phase = 'idle';
  clearMon(); clearBall();
  aimLine.visible = false;
  reticle.visible = false;
}

// ---- Throw input -------------------------------------------------------------------------------
// A flick: horizontal drag distance aims left/right, vertical drag distance sets power. Both are
// normalised against the canvas so the feel is identical on any screen size.
export function catchPointerDown(x, y) {
  if (!catchState.active || catchState.phase !== 'aim') return;
  catchState.drag = { x0: x, y0: y, x, y };
  aimLine.visible = true;
}

export function catchPointerMove(x, y) {
  if (!catchState.drag) return;
  catchState.drag.x = x; catchState.drag.y = y;
}

export function catchPointerUp(x, y, canvasW, canvasH) {
  const d = catchState.drag;
  catchState.drag = null;
  aimLine.visible = false;
  if (!catchState.active || catchState.phase !== 'aim' || !d) return;

  const dx = (x - d.x0) / canvasW;         // + right
  const dy = (d.y0 - y) / canvasH;         // + upward flick
  if (dy < 0.06) return;                   // not a throw: a tap or a downward drag

  if (catchState.onThrow && catchState.onThrow() === false) return;   // out of balls
  catchState.ballsLeft = Math.max(0, catchState.ballsLeft - 1);

  // The ball is launched BALLISTICALLY and gravity decides where it lands. Deliberately not
  // solved to guarantee arrival: back-solving the launch for a fixed arrival height made throw
  // power meaningless (every flick, however weak, landed on the target) and left "fell short"
  // unreachable. Now flick length is a real second skill axis alongside leading the target —
  // under-throw and the ball hits the floor, over-throw and it sails over the Pokemon's head.
  // The cap is set ABOVE the overshoot threshold on purpose. If maximum power always connected,
  // "flick as hard as you can" would be strictly optimal — a hard throw also reaches the target
  // sooner, so it needs less lead. Letting the hardest flicks sail over restores the trade-off.
  const power = Math.min(1.6, dy * 2.4);
  const b = catchState.ball;
  const speed = 3.0 + power * 5.0;                   // forward speed toward the target plane
  b.vz = -speed;
  b.vy = speed * 0.55;                               // a fixed ~29-degree launch angle
  b.vx = dx * 9.5;                                   // lateral aim, straight off the flick

  catchState.phase = 'flying';
  catchState.phaseT = 0;
}

// ---- Frame update ------------------------------------------------------------------------------
export function updateCatch(dt) {
  if (!catchState.active) return;
  catchState.t += dt;
  catchState.phaseT += dt;
  const s = catchState;

  // The target keeps moving in every phase except once it is caught — that is the skill test.
  if (s.monObj && s.phase !== 'success') {
    s.monSway += dt * s.monSpeed;
    s.monX = Math.sin(s.monSway) * s.monRange + Math.sin(s.monSway * 2.3) * 0.2;
    s.monObj.position.x = s.monX;
    s.monObj.position.y = 0.16 + Math.abs(Math.sin(s.monSway * 3)) * 0.1;   // little hop
    s.monObj.rotation.y = Math.sin(s.monSway) * 0.5;
    reticle.visible = s.phase === 'aim' || s.phase === 'flying';
    reticle.position.x = s.monX;
    reticle.rotation.z += dt * 0.8;
  } else {
    reticle.visible = false;
  }

  if (s.phase === 'aim' && s.drag && s.ballObj) {
    // Aim guide: rotate/extend the strip toward the flick direction.
    const dx = s.drag.x - s.drag.x0, dy = s.drag.y0 - s.drag.y;
    const len = Math.min(6, Math.max(0.5, dy / 40));
    aimLine.scale.set(1, len, 1);
    aimLine.position.set(s.ball.x, 0.06, s.ball.z - len / 2);
    aimLine.rotation.z = -Math.atan2(dx, Math.max(1, dy)) * 0.5;
  }

  if (s.phase === 'flying' && s.ball && s.ballObj) {
    const b = s.ball;
    const prevZ = b.z;
    b.vy += GRAVITY * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    s.ballObj.position.set(b.x, b.y, b.z);
    s.ballObj.rotation.x -= dt * 12;

    // Fell short: hit the ground before reaching the target plane. The `vy < 0` guard matters —
    // the ball launches from roughly this height, so without it every throw would register as
    // falling short on its first frame.
    if (b.y <= 0.15 && b.vy < 0 && b.z > TARGET_Z) {
      b.y = 0.16;
      finishThrow(false, 'The ball fell short!');
      return;
    }
    // Crossed the target plane: this is the moment accuracy is measured.
    if (prevZ > TARGET_Z && b.z <= TARGET_Z) {
      const offset = Math.abs(b.x - s.monX);
      if (b.y > 1.9) { finishThrow(false, 'The ball sailed clean over it!'); return; }
      if (offset > HIT_RADIUS) { finishThrow(false, 'The ball missed!'); return; }
      const item = ITEM_BY_ID.get(s.ballId);
      const base = item?.catchBase ?? 0.42;
      const accuracy = 1 - offset / HIT_RADIUS;          // 1 = dead centre
      const chance = Math.min(0.97, base + accuracy * MAX_ACCURACY_BONUS);
      s.willCatch = Math.random() < chance;
      s.accuracyPct = Math.round(accuracy * 100);
      s.phase = 'wobble';
      s.phaseT = 0;
      s.wobbles = 0;
      // Snap the ball onto the target and hide the Pokemon inside it.
      s.ballObj.position.set(s.monX, 0.4, TARGET_Z);
      if (s.monObj) s.monObj.visible = false;
      return;
    }
    // Sailed past everything.
    if (b.z < TARGET_Z - 4 || b.y < -2) { finishThrow(false, 'The ball missed!'); return; }
  }

  if (s.phase === 'wobble' && s.ballObj) {
    // Three wobbles, then the roll resolves. Purely presentational — the outcome was decided the
    // instant the ball crossed the plane, same as the real games.
    const per = 0.55;
    s.ballObj.rotation.z = Math.sin(s.phaseT * 9) * 0.4 * (1 - (s.phaseT % per) / per);
    s.ballObj.position.y = 0.28 + Math.abs(Math.sin(s.phaseT * 9)) * 0.06;
    if (s.phaseT > per * 3) {
      if (s.willCatch) {
        s.phase = 'success';
        s.phaseT = 0;
        s.resultMsg = `Gotcha! ${CATALOG_BY_DEX.get(s.dex)?.name || 'It'} was caught!`;
        s.onResult?.({ caught: true, msg: s.resultMsg, ballId: s.ballId, dex: s.dex, accuracy: s.accuracyPct });
      } else {
        if (s.monObj) s.monObj.visible = true;
        finishThrow(false, 'Argh! It broke free!');
      }
    }
  }

  if (s.phase === 'success' && s.ballObj) {
    s.ballObj.rotation.y += dt * 3;
    s.ballObj.position.y = 0.28 + Math.sin(s.phaseT * 3) * 0.08;
  }
}

// A failed throw: report it, then either re-arm with another ball or end the attempt.
function finishThrow(caught, msg) {
  const s = catchState;
  s.resultMsg = msg;
  s.phase = 'fail';
  s.onResult?.({ caught, msg, ballId: s.ballId, dex: s.dex, outOfBalls: s.ballsLeft <= 0 });
}

// Called by the overlay's "Throw again" affordance once the player has a ball to spend.
export function rearm(ballId, ballsLeft) {
  if (!catchState.active) return;
  catchState.ballId = ballId;
  catchState.ballsLeft = ballsLeft;
  catchState.phase = 'aim';
  catchState.phaseT = 0;
  catchState.willCatch = false;
  if (catchState.monObj) catchState.monObj.visible = true;
  spawnBall();
}
