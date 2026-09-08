// Player input and free continuous movement.
//
// Movement is never grid-snapped. Both control schemes end up producing a plain unit direction
// vector each frame, which main.js feeds through dungeon.moveWithCollision at a float speed — the
// grid is only ever consulted for "is this point inside a wall".
//
// Two user-selectable schemes (Settings): a hand-rolled bottom-left virtual joystick (no external
// dependency), or tap-to-move, which A*s a coarse cell path and then steers along it smoothly.
// Keyboard WASD/arrows always work too, which is what makes desktop testing possible.
import * as THREE from 'three';
import { findPath, worldToCell, cellToWorld, canOccupy, cellValue, FLOOR } from './dungeon.js';

const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export function createInput({ canvas, joystickRoot, joystickKnob, camera }) {
  const stick = { active: false, id: null, cx: 0, cy: 0, x: 0, y: 0 };
  const keys = new Set();
  let mode = 'joystick';
  let enabled = false;
  let path = null;          // array of cells still to visit (tap-to-move)
  let stuckFor = 0;
  const raycaster = new THREE.Raycaster();
  const hit = new THREE.Vector3();

  const maxRadius = () => Math.max(28, joystickRoot.clientWidth / 2 - 6);

  function setKnob(dx, dy) {
    joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  // ---- Virtual joystick ----
  function stickDown(e) {
    if (!enabled || mode !== 'joystick') return;
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const r = joystickRoot.getBoundingClientRect();
    stick.active = true;
    stick.id = t.identifier ?? 'mouse';
    stick.cx = r.left + r.width / 2;
    stick.cy = r.top + r.height / 2;
    joystickRoot.classList.add('active');
    stickMove(e);
  }

  function stickMove(e) {
    if (!stick.active) return;
    const touches = e.changedTouches || e.touches;
    let t = e;
    if (touches) {
      t = Array.from(touches).find(tt => tt.identifier === stick.id);
      if (!t) return;
    }
    const dx = t.clientX - stick.cx, dy = t.clientY - stick.cy;
    const dist = Math.hypot(dx, dy);
    const max = maxRadius();
    const clamped = Math.min(dist, max);
    const nx = dist ? (dx / dist) : 0, ny = dist ? (dy / dist) : 0;
    setKnob(nx * clamped, ny * clamped);
    // Dead zone keeps a resting thumb from drifting the player.
    const mag = dist < 8 ? 0 : Math.min(1, clamped / max);
    stick.x = nx * mag;
    stick.y = ny * mag;
    if (e.cancelable) e.preventDefault();
  }

  function stickUp(e) {
    const touches = e.changedTouches;
    if (touches && stick.id !== 'mouse' && !Array.from(touches).some(t => t.identifier === stick.id)) return;
    stick.active = false;
    stick.x = stick.y = 0;
    setKnob(0, 0);
    joystickRoot.classList.remove('active');
  }

  joystickRoot.addEventListener('touchstart', stickDown, { passive: false });
  joystickRoot.addEventListener('touchmove', stickMove, { passive: false });
  joystickRoot.addEventListener('touchend', stickUp);
  joystickRoot.addEventListener('touchcancel', stickUp);
  joystickRoot.addEventListener('mousedown', stickDown);
  window.addEventListener('mousemove', (e) => { if (stick.id === 'mouse') stickMove(e); });
  window.addEventListener('mouseup', (e) => { if (stick.id === 'mouse') stickUp(e); });

  // ---- Tap-to-move ----
  // Un-projects the tap onto the y=0 ground plane, snaps to the nearest walkable cell, and A*s
  // a route there. The route is only a hint: the steering below cuts corners off it.
  function onCanvasTap(clientX, clientY, floor) {
    if (!enabled || mode !== 'tap' || !floor || !currentPos) return;
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(GROUND_PLANE, hit)) return;
    let target = worldToCell(floor, hit.x, hit.z);
    if (cellValue(floor, target.x, target.y) !== FLOOR) {
      target = nearestWalkable(floor, target);
      if (!target) return;
    }
    const from = worldToCell(floor, currentPos.x, currentPos.z);
    const p = findPath(floor, from, target);
    path = p && p.length ? p : null;
    goalCell = path ? target : null;
    repathed = false;
    stuckFor = 0;
    if (onTapMarker) onTapMarker(cellToWorld(floor, target.x, target.y), !!path);
  }

  function nearestWalkable(floor, c) {
    for (let r = 1; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = c.x + dx, ny = c.y + dy;
          if (cellValue(floor, nx, ny) === FLOOR) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  let tapStart = null;
  canvas.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    tapStart = { x: t.clientX, y: t.clientY, time: performance.now() };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    const s = tapStart; tapStart = null;
    if (!s) return;
    const t = e.changedTouches[0];
    // Only a genuine tap moves you — a drag is a stray thumb, not a destination.
    if (Math.hypot(t.clientX - s.x, t.clientY - s.y) > 18) return;
    if (performance.now() - s.time > 400) return;
    onCanvasTap(t.clientX, t.clientY, currentFloor);
  }, { passive: true });
  canvas.addEventListener('click', (e) => onCanvasTap(e.clientX, e.clientY, currentFloor));

  // ---- Keyboard ----
  window.addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  // Straight-line walkability check, used to cut corners off the A* route so the player moves in
  // smooth diagonals through open rooms instead of tracing an L around every cell boundary.
  function hasClearLine(floor, ax, az, bx, bz, radius) {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(dist / 0.25);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (!canOccupy(floor, ax + (bx - ax) * t, az + (bz - az) * t, radius)) return false;
    }
    return true;
  }

  // Set by setContext() the moment a floor is built, and refreshed every frame by update().
  // Both must be live before a tap can be routed — pathfinding from a stale origin silently
  // fails, because the A* start cell would be somewhere inside solid rock.
  let currentFloor = null;
  let currentPos = null;
  let onTapMarker = null;
  let goalCell = null;                       // where the current tap route is headed
  let repathed = false;                      // one re-route allowed per tap before giving up
  const lastSeen = { x: 0, z: 0 };

  return {
    get mode() { return mode; },
    setMode(next) {
      mode = next === 'tap' ? 'tap' : 'joystick';
      path = null;
      stick.active = false; stick.x = stick.y = 0; setKnob(0, 0);
      joystickRoot.classList.toggle('hidden', mode !== 'joystick');
    },
    setEnabled(v) {
      enabled = v;
      if (!v) { path = null; stick.active = false; stick.x = stick.y = 0; setKnob(0, 0); }
    },
    onTapMarker(fn) { onTapMarker = fn; },
    // Called when a floor is built, so the very first tap on a new floor routes correctly instead
    // of waiting for update() to seed the position.
    setContext(floor, playerRef) {
      currentFloor = floor;
      currentPos = playerRef;
      lastSeen.x = playerRef.x; lastSeen.z = playerRef.z;
      path = null; goalCell = null; stuckFor = 0; repathed = false;
    },
    clearPath() { path = null; },
    hasPath() { return !!(path && path.length); },

    // Returns the desired unit direction for this frame in world space.
    // Screen-space note: the camera sits at target+(-11, 13, -11) looking back at the player, so
    // screen "up" along the ground is (+x,+z) and screen "right" is (-x,+z). The basis below
    // converts a joystick/keyboard vector into world space, so pushing up on the stick moves the
    // Pokemon up the screen — the only mapping that feels right on a diagonal camera.
    update(floor, player, dt, radius = 0.34) {
      currentFloor = floor;
      currentPos = player;
      let ix = 0, iy = 0;   // screen-space input: +x right, +y down

      if (keys.has('w') || keys.has('arrowup')) iy -= 1;
      if (keys.has('s') || keys.has('arrowdown')) iy += 1;
      if (keys.has('a') || keys.has('arrowleft')) ix -= 1;
      if (keys.has('d') || keys.has('arrowright')) ix += 1;
      const keyed = ix !== 0 || iy !== 0;
      if (keyed) path = null;

      if (!keyed && mode === 'joystick') { ix = stick.x; iy = stick.y; }

      if (ix !== 0 || iy !== 0) {
        const mag = Math.min(1, Math.hypot(ix, iy));
        const nx = ix / (Math.hypot(ix, iy) || 1), ny = iy / (Math.hypot(ix, iy) || 1);
        // With the camera at target+(-11,13,-11) looking back at the target, the ground-plane
        // basis is screen-right = (-1,0,+1)/√2 and screen-up = (+1,0,+1)/√2.
        const k = Math.SQRT1_2;
        const wx = (-nx * k) + (-ny * k);
        const wz = (nx * k) + (-ny * k);
        return { x: wx * mag, z: wz * mag, magnitude: mag };
      }

      // Tap-to-move: steer toward the furthest waypoint we can still reach in a straight line.
      if (path && path.length) {
        // Wedge detection has to measure ACTUAL PROGRESS, not distance to the waypoint. If the
        // player ends up in a corner where even the next waypoint's centre is not reachable in a
        // straight line, they grind into the wall at a constant distance from it forever — the
        // distance-based check never fires because the distance never changes.
        const moved = Math.hypot(player.x - lastSeen.x, player.z - lastSeen.z);
        lastSeen.x = player.x; lastSeen.z = player.z;
        if (moved < 0.004) stuckFor += dt; else { stuckFor = 0; repathed = false; }
        if (stuckFor > 0.3) {
          stuckFor = 0;
          // One re-route from wherever we actually ended up, then give up rather than shove.
          if (!repathed && goalCell) {
            repathed = true;
            const from = worldToCell(floor, player.x, player.z);
            const p = findPath(floor, from, goalCell);
            path = p && p.length ? p : null;
          } else {
            path = null;
            goalCell = null;
          }
          if (!path) return { x: 0, z: 0, magnitude: 0 };
        }

        let bestIdx = 0;
        for (let i = Math.min(path.length - 1, 8); i >= 0; i--) {
          const w = cellToWorld(floor, path[i].x, path[i].y);
          if (hasClearLine(floor, player.x, player.z, w.x, w.z, radius)) { bestIdx = i; break; }
        }
        const w = cellToWorld(floor, path[bestIdx].x, path[bestIdx].y);
        const dx = w.x - player.x, dz = w.z - player.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.3) {
          path.splice(0, bestIdx + 1);
          if (!path.length) { path = null; goalCell = null; return { x: 0, z: 0, magnitude: 0 }; }
        }
        return { x: dx / (dist || 1), z: dz / (dist || 1), magnitude: 1 };
      }

      return { x: 0, z: 0, magnitude: 0 };
    },
  };
}
