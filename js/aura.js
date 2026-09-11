// The purple shadow aura that marks an aggressive ("shadow") wild Pokemon.
//
// This used to be a private helper in dungeon.js, used only by the wanderers on the floor. It now
// has three callers — the dungeon body, the battle field's foe fighter, and the catch scene's
// encounter model — because an aggressive wild that is unmistakably marked out on the floor and
// then indistinguishable from any other Pokemon the moment you fight or throw at it loses the one
// thing the marker was for. It follows the same Pokemon through all three screens and stops at
// exactly one point: the team. A caught Pokemon is made by makeMon(dex) with no `aggressive`
// flag (see inventory.addCaught), so nothing downstream of the catch has an aura to draw — the
// purple going out IS the "it is yours now" beat, and it needs no code of its own.
import * as THREE from 'three';

export const AURA_COLOR = 0xc264f5;

// Sized off the creature's own height: a fixed-size aura disappears INSIDE a big model like
// Venusaur, which defeats the entire point of the marker.
//
// `spread` squeezes the HORIZONTAL radii only — the puff orbit, the puff sizes and the ground
// ring — leaving the vertical spread alone. The dungeon looks down at an aura standing on an open
// floor with nothing to crowd, so it takes the full width (spread 1). The battle fighter frames
// and the catch scene's target plane are both barely wider than the Pokemon standing in them, and
// at full width the ring runs off both sides and gets clipped mid-arc, which reads as a rendering
// fault rather than as an aura. Squeezing width rather than scaling the whole group keeps the
// puffs rising past the creature's shoulders, which is the part that reads as smoke.
export function makeAura(height = 0.85, { spread = 1 } = {}) {
  const g = new THREE.Group();
  const s = height / 0.85;
  const w = s * spread;
  const puffMat = new THREE.MeshBasicMaterial({
    color: AURA_COLOR, transparent: true, opacity: 0.34, depthWrite: false,
  });
  const orbit = 0.62 * w;
  for (let i = 0; i < 6; i++) {
    const r = (0.2 + Math.random() * 0.13) * w;
    const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 6), puffMat);
    const a = (i / 6) * Math.PI * 2;
    puff.position.set(Math.cos(a) * orbit, height * (0.5 + Math.sin(a * 2) * 0.22), Math.sin(a) * orbit);
    g.add(puff);
  }
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55 * w, 0.88 * w, 24),
    new THREE.MeshBasicMaterial({
      color: AURA_COLOR, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  g.add(ring);
  return g;
}

// The aura's only animation: the whole cloud turns, so the puffs orbit the body and the ring
// sweeps under it. Null-safe, because every caller holds an aura that may not exist.
export function spinAura(aura, dt) {
  if (aura) aura.rotation.y += dt * 1.6;
}

// Detach an aura and give its geometry back. Unlike a loaded model, an aura's geometry and
// materials are built fresh per aura and shared with nothing, so disposing is both safe and
// necessary — the battle screen and the catch scene each build a new one per encounter, and
// neither goes through dungeon.js's disposeFloor sweep.
export function disposeAura(aura) {
  if (!aura) return;
  aura.parent?.remove(aura);
  aura.traverse(o => {
    if (!o.isMesh) return;
    o.geometry?.dispose();
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m?.dispose());
  });
}
