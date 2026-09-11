// The title screen's diorama: the three starters standing in a cave at the camera's eye level,
// with Team Rocket's three Pokemon peeking around corners behind them.
//
// WHY IT IS ITS OWN SCENE, RENDERED THROUGH THE MAIN RENDERER. This is the same arrangement the
// catch minigame uses (see catch.js): a private THREE.Scene and camera handed to the ONE dungeon
// renderer, chosen by mode in main.js's tick(). It costs no new WebGL context — the page is held
// to exactly two, the dungeon's and modelstage's, and a third gets the dungeon's killed (see
// js/modelstage.js). Going through modelstage instead was the other option and was rejected: the
// stage renders at a fixed 512px square and blits, which is right for a small panel and wrong for
// a full-screen backdrop, where a 512px source upscaled under `image-rendering: pixelated` would
// come out in visible blocks. A private scene also gets its own fog and its own dim cave lighting
// rig, neither of which can be set on the shared stage without changing every other model view.
//
// THE CAVE IS LAID OUT IN SCREEN SPACE, NOT WORLD SPACE. This is the whole reason the file has a
// rebuild pass instead of a table of world coordinates, and it comes out of the UI, which does not
// move: the logo owns the top of the screen and the button column the bottom, so the six of them
// have to fit the clear band in the MIDDLE. That makes them small, which puts the camera several
// units back, and at that distance the frame is around nine world units wide where the trio stands
// on a desktop screen but under three on a portrait phone — so one set of world coordinates cannot
// possibly place a villain clear of a starter at both. Instead every corner, wall and pose in here
// is declared as a point on the SCREEN (an NDC x, sometimes an NDC y) at a given depth, and
// rebuild() un-projects those into world space for the current viewport. Two things fall out of
// that for free: the cave walls always close the edges of the frame, and a villain tucked behind a
// corner is hidden at every aspect, because "behind the corner" was specified as a screen
// relationship in the first place.
//
// layout() MEASURES the logo and the button column to find that band (and to size and pitch the
// camera into it). The coupling runs one way only: this module reads the UI's boxes and never
// moves, resizes or restyles anything in the DOM.
//
// THE LOOP. The starters take turns looking into the cave — Piplup, then Turtwig, then Chimchar —
// and whichever one turns sends ALL THREE villains out of sight until it is facing front again.
// The wait between turns is redrawn at random between 8 and 14 seconds each time, so the screen
// never settles into a countable rhythm. It is driven by an explicit dt from tick(), so it
// advances at the same rate however the frame rate moves, and it holds no timers of its own.
import * as THREE from 'three';
import { canvas } from './three-setup.js';
import { createMonObject } from './models.js';

// Rocky Cavern's palette, copied from THEMES in dungeon.js rather than imported: the title is not
// a floor and must not start depending on the floor generator. Darker than the floor's own values
// because this cave is lit by one torch rather than by a full daylight rig.
const PAL = {
  floorA: 0x5b5145, floorB: 0x514840,
  rock: 0x3b342c, rockTop: 0x4c4338,
  fog: 0x120d0a,
  torch: 0xffb066,
  deep: 0x5f7cff,
};

const DEX = { PIPLUP: 393, TURTWIG: 387, CHIMCHAR: 390, WEEZING: 110, ARBOK: 24, MEOWTH: 52 };

const MON_H = 0.80;        // starter display height, matching a Basic in the dungeon (0.85)
const TRIO_Z = 0.55;       // the row the three of them stand on
const EYE = 0.55;          // camera height: a starter's eye line, which is what "POV" means here
const FOV = 55;
// How far the floating villain rides above and below its pinned height. rebuild() leaves room for
// it under the logo, so the two have to agree.
const FLOAT_BOB = 0.05;

// The world half-width that must stay on screen at the trio's depth. Their outermost shoulder is
// at 0.8, and the generous margin on top of that is deliberate: on a portrait phone this is what
// decides the framing, and a value that only just fits the trio leaves no frame either side of
// them for a villain to lean into. How TALL they come out is not a constant — see layout().
const FIT_HALF_W = 1.55;

// `wide` is 0 on a portrait phone and 1 from this aspect up, and every screen-space number below
// is interpolated across it. A tall screen has room above the trio's heads but almost none beside
// them; a wide screen is the other way round, and the two arrangements are genuinely different.
const WIDE_ASPECT = 1.5;
const NARROW_ASPECT = 0.62;

// ---- Scene ------------------------------------------------------------------------------------
export const titleScene = new THREE.Scene();
titleScene.background = new THREE.Color(0x0b0809);
titleScene.fog = new THREE.Fog(PAL.fog, 8, 22);

// Deliberately NOT registerCamera()'d. Every other extra camera takes only its aspect from
// onViewportChange, but this one's DISTANCE — and the whole cave hanging off it — is a function of
// the aspect too, so the rig is recomputed from the canvas box each frame instead. That also
// covers the iOS case where the viewport settles without ever firing a resize event.
export const titleCamera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);

const hemi = new THREE.HemisphereLight(0x7c7f9c, 0x2b2118, 0.62);
titleScene.add(hemi);

// The one shadow caster. High and a little to the camera's right, so the trio throw their shadows
// back into the cave rather than toward the viewer.
const key = new THREE.DirectionalLight(0xffd9ac, 0.8);
key.position.set(2.2, 4.4, 3.4);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.normalBias = 0.05;         // kills the self-shadow leak lines on hard voxel corners
key.shadow.camera.left = -5; key.shadow.camera.right = 5;
key.shadow.camera.top = 5; key.shadow.camera.bottom = -5;
key.shadow.camera.far = 18;
titleScene.add(key);
titleScene.add(key.target);
key.target.position.set(0, 0.4, TRIO_Z);

// The torch: what actually lights the three faces, and the only thing in here that moves the
// lighting. It sits between the camera and the trio, so it has fallen off by the time it reaches
// the villains — which is what keeps them reading as shapes in the dark.
const torch = new THREE.PointLight(PAL.torch, 3.6, 10, 1.7);
torch.position.set(-0.2, 1.25, TRIO_Z + 2.1);
titleScene.add(torch);

// Cold light from deeper in, rimming the back of the cave so the villains separate from the rock
// behind them.
const deep = new THREE.PointLight(PAL.deep, 3.4, 18, 1.5);
deep.position.set(0, 1.8, -7.6);
titleScene.add(deep);

// One small fill per corner, parked just in front of where that villain leans out. The torch is
// too far forward to reach them and a single mid-cave light was too far from all three at once —
// these are what make a peeking villain identifiable instead of a dark lump, without lifting the
// cave around them. rebuild() moves each one, since the corners move with the viewport.
const fills = [0, 1, 2].map(() => {
  const l = new THREE.PointLight(0xc9b6ff, 1.55, 5.5, 1.5);
  titleScene.add(l);
  return l;
});

// ---- Screen-space helpers ---------------------------------------------------------------------
// The world point that projects to (ndcX, ndcY) on the plane z = `z`. The camera has pitch only —
// no yaw, no roll — so this is well defined for any depth in front of it.
const _v = new THREE.Vector3(), _dir = new THREE.Vector3(), _tmp = new THREE.Vector3();
function atNDC(ndcX, ndcY, z, out = new THREE.Vector3()) {
  _v.set(ndcX, ndcY, 0.5).unproject(titleCamera);
  _dir.copy(_v).sub(titleCamera.position).normalize();
  const t = (z - titleCamera.position.z) / _dir.z;
  return out.copy(titleCamera.position).addScaledVector(_dir, t);
}
const xAt = (ndcX, z) => atNDC(ndcX, 0, z, _tmp).x;

// ---- The cave ---------------------------------------------------------------------------------
// Slabs of rock, each declared by the NDC x of its INNER edge — the edge the camera can see past —
// and the depth band it spans. `side` is the direction the rock extends from that edge; it runs
// out to OUTER_NDC, past the edge of the frame, unless a `width` caps it. So a slab always closes
// its side of the shot at any aspect, and a slab with a width is a free-standing pillar.
//
// OUTER_NDC is well off-frame rather than just past the edge: a slab's outer end has to clear the
// widest `inner` below it by enough to leave the slab some real thickness at a portrait aspect.
const OUTER_NDC = 2.20;

// The three corners the villains peek around, left to right, index for index against VILLAINS.
// (They all duck together, whichever starter turns, so the order is placement and spawn order —
// it no longer pairs anyone with anyone.)
//
// `inner` and `z0` interpolate between the portrait arrangement and the wide one: on a phone the
// corners crowd in toward the centre and sit deeper (there is no room beside the trio, but there
// is room above them), and on a desktop screen they spread out to the sides.
const CORNERS = [
  // Meowth: the near corner on the left.
  { side: -1, inner: [-0.80, -0.46], z0: [-3.30, -2.40], depth: 1.45, h: 1.85, hideOut: 1.00 },
  // Weezing: a pillar standing free in the deep middle of the cave, peeked around
  // on its LEFT (hence side +1: the rock extends right, the villain leans out left). It has to be
  // a pillar rather than a third wall corner, and it has to be near the middle: the two wall
  // corners cut across the whole left and right of the frame from their depth back, so ANY deep
  // pose out at the sides is behind one of them however it is posed — only the centre of the cave
  // is still open that far in. Weezing floats, which is what lets it sit ABOVE the trio's heads
  // there instead of behind them, and on a phone that vertical gap is the only one left.
  { side: 1, inner: [-0.22, 0.02], z0: [-6.20, -5.60], depth: 1.60, h: 2.60, hideOut: 1.40,
    width: 2.20, float: true, peekIn: 0.25 },
  // Arbok: the middle corner on the right, reared up out of a taller spur.
  { side: 1, inner: [0.82, 0.50], z0: [-3.90, -3.00], depth: 1.55, h: 2.25, hideOut: 1.25 },
];

// Plain wall, in three depth bands. The near band is what closes the frame beside the camera; the
// two behind it are the chamber the corners cut into.
//
// A wall block's inner edge is placed by the NDC at its NEAR end, but the frame keeps widening
// behind that, so by the block's far end the same face has slid inboard — which is why these are
// just outside the frame rather than on its edge, and why they interpolate. On a portrait screen
// the trio alone fills three quarters of the frame's width, so a band at 1.02 ends up shaving the
// outer two starters and burying the villains beside them; pulling the bands outboard as the
// screen narrows is what keeps the passage clear. Raising one of these numbers is safe; lowering
// one needs the trio and the villains re-checked at a phone aspect.
const WALLS = [
  { inner: [1.32, 1.02], z0: 2.9, z1: 0.6, h: 3.20, step: 1.8 },
  { inner: [1.16, 0.97], z0: 0.6, z1: -5.0, h: 3.40, step: 1.9 },
  { inner: [1.02, 0.94], z0: -5.0, z1: -9.0, h: 3.60, step: 2.0 },
];

const BACK_Z = -8.9;
const GAP_NDC = 0.15;       // half-width of the tunnel mouth in the back wall

// Loose rubble, also placed in screen space so it stays in frame: [ndcX (portrait, wide), z,
// width, height]. The four pieces in FRONT of the trio carry a portrait value of their own and are
// pushed right out to the frame's edge there — a boulder that reads as foreground dressing on a
// desktop screen stands squarely in front of Piplup's feet on a phone.
const RUBBLE = [
  [[-1.02, -0.62], 1.40, 0.52, 0.34], [[1.04, 0.66], 0.90, 0.60, 0.40],
  [[-1.06, -0.78], -0.60, 0.66, 0.44], [[1.06, 0.74], -1.30, 0.54, 0.36],
  [[-0.34, -0.34], -1.80, 0.34, 0.22], [[0.36, 0.36], -2.20, 0.40, 0.26],
  [[-0.52, -0.52], -4.60, 0.62, 0.42], [[0.56, 0.56], -5.40, 0.70, 0.48],
  [[0.22, 0.22], -6.90, 0.46, 0.30], [[-0.26, -0.26], -7.60, 0.52, 0.34],
];

// Stalactites: [ndcX, z, radius, length].
const SPIKES = [
  [-0.70, -1.10, 0.34, 0.95], [-0.22, -0.30, 0.26, 0.62], [0.30, -0.90, 0.30, 0.80],
  [0.76, -2.40, 0.36, 1.05], [-0.50, -4.30, 0.30, 0.72], [0.16, -5.70, 0.28, 0.66],
  [0.62, -6.90, 0.32, 0.86], [-0.76, -7.50, 0.30, 0.74],
];

const ROCK_MAX = 96;        // instance budget for every slab, wall block and boulder
const FLOOR_MAX = 1500;     // and for the floor's 1x1 tiles, at the widest frustum going
let rockMesh = null, spikeMesh = null, glow = null, floorMesh = null;

function buildStatic() {
  const col = new THREE.Color();

  // Floor: the dungeon's own checkerboard, which is what ties the title to the game it opens.
  floorMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 0.3, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    FLOOR_MAX,
  );
  floorMesh.receiveShadow = true;
  floorMesh.count = 0;                 // rebuild() lays the tiles out for the current frustum
  titleScene.add(floorMesh);

  rockMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }),
    ROCK_MAX,
  );
  rockMesh.castShadow = true;
  rockMesh.receiveShadow = true;
  rockMesh.count = 0;
  titleScene.add(rockMesh);

  spikeMesh = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.5, 1, 6),
    new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }),
    SPIKES.length,
  );
  SPIKES.forEach((_s, i) => {
    spikeMesh.setColorAt(i, col.setHex(PAL.rockTop).multiplyScalar(0.78 + (i % 4) * 0.06));
  });
  if (spikeMesh.instanceColor) spikeMesh.instanceColor.needsUpdate = true;
  titleScene.add(spikeMesh);

  // The tunnel mouth behind the gap in the back wall: unlit and unfogged, so it holds its value as
  // the one bit of cold daylight in the frame and gives the trio a rim to stand against. Kept dim
  // on purpose — bright, it reads as a door rather than as distance.
  glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 2.6),
    new THREE.MeshBasicMaterial({ color: 0x26325e, fog: false }),
  );
  titleScene.add(glow);

  buildMotes();
}

// ---- Rebuild ----------------------------------------------------------------------------------
// Re-derives every world position from the current camera. Runs on the first frame and then only
// when the framing actually moves — a resize, a rotation, a change in the UI's own boxes.
const pose = { peek: [], hide: [], stand: [] };   // villain poses and the starters' marks
const lerp = THREE.MathUtils.lerp;

function rebuild(wide) {
  STARTERS.forEach((s, i) => {
    pose.stand[i] = { x: lerp(s.x[0], s.x[1], wide), z: TRIO_Z + lerp(s.dz[0], s.dz[1], wide) };
  });

  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  const p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion();
  let n = 0;

  // The floor is tiled to cover the FRUSTUM, not to a fixed extent, and that is what stops the
  // scene ending in mid-air. The camera sits several units back from the trio — up to nine — so a
  // grid that stopped at z = +5 ran out IN FRONT of the camera on a tall screen, and the bottom
  // band of the frame showed bare background past the edge of the world. It now runs from behind
  // the back wall to past the camera, and out to the frame's own edge at the deepest point it can
  // be seen. `1.06` is that edge with a tile of margin; anything beyond it is off-screen anyway.
  const camZ = titleCamera.position.z;
  const zFront = Math.ceil(camZ + 1.5);
  const zBack = Math.floor(BACK_Z - 1);
  const xHalf = Math.min(34, Math.ceil(Math.abs(xAt(1.06, BACK_Z))) + 1);
  let f = 0;
  for (let gx = -xHalf; gx <= xHalf && f < FLOOR_MAX; gx++) {
    for (let gz = zBack; gz <= zFront && f < FLOOR_MAX; gz++) {
      m4.makeTranslation(gx, -0.15, gz);
      floorMesh.setMatrixAt(f, m4);
      const jitter = 0.9 + (Math.abs(gx * 5 + gz * 11) % 4) * 0.05;
      floorMesh.setColorAt(f, col.setHex((gx + gz) % 2 ? PAL.floorA : PAL.floorB).multiplyScalar(jitter));
      f++;
    }
  }
  floorMesh.count = f;
  floorMesh.instanceMatrix.needsUpdate = true;
  if (floorMesh.instanceColor) floorMesh.instanceColor.needsUpdate = true;
  floorMesh.computeBoundingSphere();

  // One box, from its inner NDC edge (signed) out past the frame in the `side` direction — or only
  // `width` world units, for a free-standing pillar. `y` is the centre height, floor by default.
  const slab = (side, innerNdc, z0, z1, h,
                { tint = PAL.rock, grow = 0, y = h / 2, width = 0 } = {}) => {
    if (n >= ROCK_MAX) return;
    const xi = xAt(innerNdc, z0);                        // inner edge, in world x
    const xo = width ? xi + side * width : xAt(side * OUTER_NDC, z0);
    const x0 = Math.min(xi, xo), x1 = Math.max(xi, xo);
    p.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    s.set(Math.abs(x1 - x0) + grow, h, Math.abs(z1 - z0) + grow);
    m4.compose(p, q, s);
    rockMesh.setMatrixAt(n, m4);
    const jitter = 0.86 + (n % 6) * 0.05;
    rockMesh.setColorAt(n, col.setHex(tint).multiplyScalar(jitter));
    n++;
  };

  // Wall bands, broken into blocks so a run of rock is not one extruded rectangle. The jitter is a
  // function of the block index, so the cave keeps its shape across a rebuild.
  for (const w of WALLS) {
    const span = Math.abs(w.z1 - w.z0);
    const blocks = Math.max(2, Math.round(span / (w.step || 1.4)));
    const step = span / blocks;
    const inner = lerp(w.inner[0], w.inner[1], wide);
    for (const side of [-1, 1]) {
      for (let b = 0; b < blocks; b++) {
        const z0 = w.z0 - b * step;
        const wob = ((b * 7 + (side > 0 ? 3 : 0)) % 4) * 0.02;
        const hh = w.h + ((b * 5) % 4) * 0.14;
        slab(side, side * (inner + wob), z0, z0 - step, hh, { grow: 0.04 });
      }
    }
  }

  // The three corners, each with a cap band in the lighter top tint — the trick the dungeon's own
  // walls use to read as solid rock rather than as a painted plane.
  CORNERS.forEach((c, i) => {
    const inner = lerp(c.inner[0], c.inner[1], wide);
    const z0 = lerp(c.z0[0], c.z0[1], wide);
    const z1 = z0 - c.depth;
    const width = c.width || 0;
    slab(c.side, inner, z0, z1, c.h, { width });
    slab(c.side, inner, z0, z1, 0.16,
         { tint: PAL.rockTop, grow: 0.12, y: c.h + 0.04, width: width ? width + 0.12 : 0 });

    // The two poses, both measured against the slab's INNER FACE in world x rather than in NDC.
    // That distinction is load-bearing: the camera's rays diverge, so a pose specified as "just
    // inboard of the corner in NDC" is inboard at the slab's front face and OUTBOARD a metre
    // deeper — which buries it inside its own rock. The face is a plane of constant x, and both
    // poses sit inside the slab's depth band, so comparing x against that plane is exact.
    //
    // Peeking straddles the face: the outboard half or so of the body is inside the rock and the
    // rest, including the head it is looking with, shows past the corner. `peekIn` is how far
    // inboard of the face it leans — Weezing is a wide, two-headed shape and needs more of itself
    // in the clear to be recognisable at the pillar's distance. Hiding puts the whole body
    // outboard by more than its own half-width, with margin for the ray divergence over the slab's
    // depth (`hideOut` is per villain, since Arbok is a good deal bulkier than Meowth).
    const xInner = xAt(inner, z0);
    const zPeek = z0 - 0.40, zHide = z0 - 0.55;
    pose.peek[i] = { x: xInner - c.side * (c.peekIn ?? 0.05), z: zPeek };
    pose.hide[i] = { x: xInner + c.side * c.hideOut, z: zHide };
    // This corner's fill: in front of the peek pose, so it lights the face and not the rock.
    fills[i].position.set(pose.peek[i].x - c.side * 0.5, 1.15, zPeek + 1.0);
  });

  // Back wall, split around the tunnel mouth, plus the lintel over it.
  slab(-1, -GAP_NDC, BACK_Z, BACK_Z - 1.1, 2.9);
  slab(1, GAP_NDC, BACK_Z, BACK_Z - 1.1, 2.9);
  const gapW = xAt(GAP_NDC, BACK_Z) * 2;
  p.set(0, 2.55, BACK_Z); s.set(gapW * 1.2, 0.9, 1.1);
  m4.compose(p, q, s);
  if (n < ROCK_MAX) {
    rockMesh.setMatrixAt(n, m4);
    rockMesh.setColorAt(n, col.setHex(PAL.rockTop).multiplyScalar(0.9));
    n++;
  }

  // Ceiling: one slab, wide enough to reach the walls at the back of the chamber and — for the
  // same reason as the floor — running from the back wall to past the camera, so the top of the
  // frame is rock rather than the end of the world. Its front edge is above the top of the frame,
  // so it only comes into view with distance.
  const ceilW = Math.abs(xAt(OUTER_NDC, BACK_Z)) * 2.2;
  const ceilFront = camZ + 2, ceilBack = BACK_Z - 1;
  p.set(0, 3.0, (ceilFront + ceilBack) / 2); s.set(ceilW, 0.7, ceilFront - ceilBack);
  m4.compose(p, q, s);
  if (n < ROCK_MAX) {
    rockMesh.setMatrixAt(n, m4);
    rockMesh.setColorAt(n, col.setHex(PAL.rockTop).multiplyScalar(0.82));
    n++;
  }

  for (const [ndc, z, w, h] of RUBBLE) {
    if (n >= ROCK_MAX) break;
    p.set(xAt(lerp(ndc[0], ndc[1], wide), z), h / 2, z); s.set(w, h, w * 0.9);
    m4.compose(p, q, s);
    rockMesh.setMatrixAt(n, m4);
    rockMesh.setColorAt(n, col.setHex(PAL.rock).multiplyScalar(0.9 + (n % 4) * 0.06));
    n++;
  }

  rockMesh.count = n;
  rockMesh.instanceMatrix.needsUpdate = true;
  if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
  rockMesh.computeBoundingSphere();

  const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  SPIKES.forEach(([ndc, z, r, h], i) => {
    m4.compose(new THREE.Vector3(xAt(ndc, z), 2.72 - h / 2, z), flip,
               new THREE.Vector3(r * 2, h, r * 2));
    spikeMesh.setMatrixAt(i, m4);
  });
  spikeMesh.instanceMatrix.needsUpdate = true;
  spikeMesh.computeBoundingSphere();

  glow.position.set(0, 1.15, BACK_Z - 0.45);
  glow.scale.set(Math.abs(gapW) * 1.05, 1, 1);

  // The floating villain hangs from the TOP OF THE CLEAR BAND: its head just under the logo, with
  // its body below that, which is the one gap in the middle of the frame a third villain can have
  // on a narrow screen. Hung off the measured band rather than a guessed fraction, because the
  // logo's own height moves with the viewport (it is capped in both vw and vh) — and its art runs
  // to the very bottom edge of its PNG, so there is no padding to borrow.
  // The clearance has to cover three things, or its head clips the logo: the band edge itself, the
  // idle bob it rides on top of this height (FLOAT_BOB), and the fact that the near-top corner of
  // a body with depth projects a little higher than its centre line does.
  const fi = CORNERS.findIndex(c => c.float);
  const headY = atNDC(0, band.top - 0.05, pose.peek[fi].z, _tmp).y;
  pose.peek[fi].y = headY - VILLAINS[fi].h - FLOAT_BOB;   // origin is at its feet
  pose.hide[fi].y = 0.12;                                 // sinks behind the pillar as it ducks
}

// ---- Dust motes -------------------------------------------------------------------------------
// One Points cloud drifting up through the torchlight. Besides the six of them it is the only
// thing in the cave that moves, and it is what keeps a held pose from reading as a still image.
const MOTES = 90;
let motes = null;
const moteSpeed = new Float32Array(MOTES);

function moteTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,236,200,1)');
  grad.addColorStop(0.4, 'rgba(255,210,150,0.5)');
  grad.addColorStop(1, 'rgba(255,200,140,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(cv);
}

function buildMotes() {
  const pos = new Float32Array(MOTES * 3);
  for (let i = 0; i < MOTES; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 12;
    pos[i * 3 + 1] = Math.random() * 2.5;
    pos[i * 3 + 2] = 3 - Math.random() * 11;
    moteSpeed[i] = 0.05 + Math.random() * 0.11;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  motes = new THREE.Points(geo, new THREE.PointsMaterial({
    map: moteTexture(), size: 0.08, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0.7, sizeAttenuation: true, fog: false,
  }));
  titleScene.add(motes);
}

function updateMotes(dt, t) {
  const p = motes.geometry.attributes.position;
  for (let i = 0; i < MOTES; i++) {
    let y = p.getY(i) + moteSpeed[i] * dt;
    if (y > 2.6) y = 0.02;                           // recycle at the floor
    p.setY(i, y);
    p.setX(i, p.getX(i) + Math.sin(t * 0.6 + i) * dt * 0.06);
  }
  p.needsUpdate = true;
}

// ---- The cast ---------------------------------------------------------------------------------
// A starter faces the camera at yaw 0 — the Quest models' front is +Z, the same convention the
// dungeon's heading maths uses — and turns to look into the cave at yaw ±PI. `dir` picks which
// shoulder leads, so the three do not pivot in lockstep.
// `x` and `dz` interpolate portrait -> wide like everything else: on a phone the three of them
// close up into a tighter clump, standing a little deeper in a stagger. That is not a cosmetic
// choice — at a phone aspect the row has to give back enough of the frame's width for a villain to
// be able to lean out beside it at all.
const STARTERS = [
  { dex: DEX.PIPLUP, x: [-0.50, -0.66], dz: [-0.10, -0.04], rest: 0.10, dir: 1, phase: 0.0 },
  { dex: DEX.TURTWIG, x: [0.02, 0.02], dz: [0.26, 0.16], rest: -0.04, dir: 1, phase: 1.9 },
  { dex: DEX.CHIMCHAR, x: [0.53, 0.70], dz: [-0.06, -0.02], rest: -0.12, dir: -1, phase: 3.4 },
];

// One villain per corner, in CORNERS order — left, centre, right. `lean` is the roll it leans
// around the corner with, and `yaw` is where it is looking in each pose: back into the rock when it
// ducks, out at the trio when it peeks. Weezing
// floats, so its hide pose also SINKS (see rebuild), which reads better at that distance than a
// sideways slide and is how a levitating Pokemon would actually duck.
const VILLAINS = [
  { dex: DEX.MEOWTH, h: 0.80, phase: 0.7, yaw: [1.65, 0.55], lean: 0.15 },
  { dex: DEX.WEEZING, h: 1.05, phase: 2.2, yaw: [-0.25, 0.35], lean: 0.12 },
  { dex: DEX.ARBOK, h: 1.26, phase: 1.4, yaw: [-1.65, -0.50], lean: -0.16 },
];

const cast = { starters: [], villains: [] };

// Nothing is shown until its real model has swapped in: the placeholder block every
// createMonObject hands back would read as a grey crate standing in a cave. Polling
// `userData.ready` once a frame is simpler than threading six onReady callbacks through here, and
// costs nothing.
function spawnCast() {
  for (const s of STARTERS) {
    const obj = createMonObject(s.dex, { height: MON_H });
    obj.visible = false;              // rebuild() puts it on its mark
    titleScene.add(obj);
    cast.starters.push({ ...s, obj });
  }
  for (const v of VILLAINS) {
    const obj = createMonObject(v.dex, { height: v.h });
    obj.visible = false;
    titleScene.add(obj);
    cast.villains.push({ ...v, obj });
  }
}

// ---- Choreography -----------------------------------------------------------------------------
// ONE starter turns at a time, and its turn alarms ALL THREE villains.
//
// A turn is a 0.5 s pivot, a 1.0 s look into the dark, and a 0.5 s pivot back. Every villain ducks
// 0.15 s INTO that pivot — gone before the starter has come round, which is the joke — and leans
// back out 0.08 s after it is square to the camera again. They are not in lockstep: each one is
// offset by `DUCK_STAGGER`, so the ducking and the re-emerging both ripple across the cave instead
// of snapping.
//
// The turns are NOT on a fixed cycle. Whose turn it is rotates Piplup -> Turtwig -> Chimchar, and
// the wait between one turn and the next is drawn fresh from GAP_MIN..GAP_MAX every time, so the
// screen never falls into a visible rhythm and a full round takes anywhere from 24 to 42 seconds.
// `clock` therefore runs forward and is never wrapped — there is no cycle length to wrap it to.
const TURN = 0.50;
const LOOK = 1.00;
const BACK_AT = TURN + LOOK;             // when the pivot back starts
const DONE_AT = BACK_AT + TURN;          // when it is square to the camera again
const HIDE_LEAD = 0.15, HIDE_DUR = 0.30;
const SHOW_LAG = 0.08, SHOW_DUR = 0.44;
const DUCK_STAGGER = 0.07;               // per villain, so the three do not move as one
const GAP_MIN = 8, GAP_MAX = 14;         // seconds between one starter's turn and the next
const FIRST_GAP = 3.2;                   // the opening pose gets held this long before anyone turns

const nextGap = () => GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);

const smooth = (u) => u * u * (3 - 2 * u);
// Coming back out overshoots a little and settles — the difference between a Pokemon leaning
// around a corner and a Pokemon being slid into place.
const outBack = (u) => 1 + 2.2 * Math.pow(u - 1, 3) + 1.2 * Math.pow(u - 1, 2);

// How far round the starter that is mid-turn has got, 0 (facing the camera) to 1 (facing the cave).
function turnPhase(local) {
  if (local <= 0 || local >= DONE_AT) return 0;
  if (local < TURN) return smooth(local / TURN);
  if (local < BACK_AT) return 1;                                     // looking into the cave
  return 1 - smooth((local - BACK_AT) / TURN);
}

// How hidden the villains should be, 0 (leaning out) to 1 (tucked away), for a turn that started
// `local` seconds ago. One curve, shared by all three — whichever starter turned.
function alarmPhase(local) {
  const out = DONE_AT + SHOW_LAG;
  if (local <= HIDE_LEAD) return 0;
  if (local < HIDE_LEAD + HIDE_DUR) return smooth((local - HIDE_LEAD) / HIDE_DUR);
  if (local <= out) return 1;
  if (local < out + SHOW_DUR) return 1 - outBack((local - out) / SHOW_DUR);
  return 0;
}

// ---- Framing ----------------------------------------------------------------------------------
// The camera is MEASURED OFF THE UI. It reads the two things that bracket the clear band — the
// bottom of the logo and the top of the button column — and frames the trio inside what is left:
//
//   * size: one starter fills a fixed share of the BAND's height, not of the viewport's, so the row
//     never grows into the buttons. On a landscape phone, where the band is a fifth of the screen,
//     that is the difference between a readable shot and a row of Pokemon behind Start Run.
//   * height: the camera stays at a starter's eye line — that is what "eye level" means and it does
//     not move — and pitches until the middle of the trio lands at the middle of the band. On a
//     short screen the band's centre is well above the screen's, and a level camera would put them
//     squarely behind the buttons.
//   * width: it is pushed back far enough that the three of them still fit across a narrow screen.
//
// Reading the UI's boxes is deliberate, and it is the only direction the coupling runs: this module
// never moves, resizes or restyles anything in the DOM. Everything is measured off the canvas's CSS
// box rather than window.innerHeight, for the same reason three-setup.js does — innerHeight
// under-reports by the home-indicator zone on iOS.
const BAND_FRAC = 0.58;       // share of the clear band's height one starter fills
const TRIO_MID_Y = 0.42;      // the middle of a starter's body, which is what gets centred

let lastKey = '';
let band = { top: 0.35, bottom: -0.35 };     // the clear band, in NDC y

function uiBand(h) {
  const logo = document.getElementById('title-logo');
  const btn = document.getElementById('btn-start');
  const top = logo ? logo.getBoundingClientRect().bottom : h * 0.32;
  const bottom = btn ? btn.getBoundingClientRect().top : h * 0.70;
  // A collapsed or not-yet-laid-out screen can hand back nonsense; fall back to the middle third.
  if (!(bottom > top) || !(h > 0)) return { top: 0.35, bottom: -0.35 };
  return { top: 1 - 2 * (top / h), bottom: 1 - 2 * (bottom / h) };
}

function layout() {
  const w = canvas.clientWidth || window.innerWidth || 1;
  const h = canvas.clientHeight || window.innerHeight || 1;
  const aspect = w / h;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);

  band = uiBand(h);
  const bandH = (band.top - band.bottom) / 2;               // as a fraction of the viewport height
  const frac = THREE.MathUtils.clamp(bandH * BAND_FRAC, 0.10, 0.24);
  const dTall = (MON_H / frac) / (2 * tanHalf);
  const dWide = FIT_HALF_W / (tanHalf * aspect);
  const d = THREE.MathUtils.clamp(Math.max(dTall, dWide), 3.0, 9.0);

  // Pitch: drop the view axis below the trio by exactly as much as puts them at the band's centre.
  const mid = (band.top + band.bottom) / 2;
  const pitch = Math.atan2(EYE - TRIO_MID_Y, d) + Math.atan(mid * tanHalf);
  const reach = d + 3;

  titleCamera.aspect = aspect;
  titleCamera.position.set(0, EYE, TRIO_Z + d);
  titleCamera.lookAt(0, EYE - Math.tan(pitch) * reach, TRIO_Z + d - reach);
  titleCamera.updateProjectionMatrix();
  titleCamera.updateMatrixWorld(true);

  // The cave is rebuilt when the framing actually moves — a resize or an orientation change — and
  // never per frame. The key carries the band as well as the aspect, because two screens of the
  // same shape can still put the logo and the buttons in different places.
  const kk = aspect.toFixed(3) + ':' + band.top.toFixed(3) + ':' + band.bottom.toFixed(3);
  if (kk !== lastKey) {
    lastKey = kk;
    rebuild(THREE.MathUtils.clamp((aspect - NARROW_ASPECT) / (WIDE_ASPECT - NARROW_ASPECT), 0, 1));
  }
}

// ---- Frame ------------------------------------------------------------------------------------
let built = false;
let t = 0;                 // the idle clock: bobs, flicker, motes
let turner = -1;           // which starter is mid-turn, -1 for none
let turnStart = 0;         // when that turn began, on the `t` clock
let nextTurn = FIRST_GAP;  // when the next one begins
let turnQueue = 0;         // whose turn it is next: 0 Piplup, 1 Turtwig, 2 Chimchar

export function updateTitle(dt) {
  if (!built) { buildStatic(); spawnCast(); built = true; }
  t += dt;
  layout();

  // Start the next turn when its time comes round, and retire the one that has finished.
  if (t >= nextTurn) {
    turner = turnQueue;
    turnStart = t;
    turnQueue = (turnQueue + 1) % cast.starters.length;
    nextTurn = t + nextGap();
  }
  const local = turner >= 0 ? t - turnStart : -1;
  // Retire only once the LAST-staggered villain has finished leaning back out, or its final few
  // percent would snap when the turn is dropped.
  const alarmEnds = DONE_AT + SHOW_LAG + SHOW_DUR + (cast.villains.length - 1) * DUCK_STAGGER;
  if (turner >= 0 && local > alarmEnds) turner = -1;

  cast.starters.forEach((s, i) => {
    if (!s.obj.visible && s.obj.userData.ready) s.obj.visible = true;
    const p = i === turner ? turnPhase(local) : 0;
    const st = pose.stand[i];
    s.obj.rotation.y = s.rest + s.dir * Math.PI * p;
    // A small hop out of the pivot, and an idle breath the rest of the time.
    const hop = p > 0 && p < 1 ? Math.sin(Math.PI * p) * 0.035 : 0;
    s.obj.position.set(st.x, hop + Math.abs(Math.sin(t * 2.4 + s.phase)) * 0.014, st.z);
    s.obj.rotation.z = Math.sin(t * 1.7 + s.phase) * 0.012;
  });

  cast.villains.forEach((v, i) => {
    if (!v.obj.visible && v.obj.userData.ready) v.obj.visible = true;
    // Every villain answers the SAME alarm, whichever starter turned — one of them looking round
    // is enough to send all three out of sight. The stagger is what keeps it from reading as a
    // single object in three pieces.
    const p = turner < 0 ? 1 : 1 - alarmPhase(local - i * DUCK_STAGGER);
    const a = pose.hide[i], b = pose.peek[i];
    v.obj.position.set(
      lerp(a.x, b.x, p),
      lerp(a.y ?? 0, b.y ?? 0, p),
      lerp(a.z, b.z, p),
    );
    v.obj.rotation.y = lerp(v.yaw[0], v.yaw[1], p);
    v.obj.rotation.z = v.lean * p;                   // the lean around the corner
    if (v.dex === DEX.WEEZING) {
      v.obj.position.y += Math.sin(t * 1.5 + v.phase) * FLOAT_BOB * p;
      v.obj.rotation.y += Math.sin(t * 0.9 + v.phase) * 0.06;
    } else {
      v.obj.position.y += Math.abs(Math.sin(t * 2.1 + v.phase)) * 0.012 * p;
    }
  });

  // Torch flicker: two out-of-step sines, so it breathes rather than strobes.
  torch.intensity = 3.6 + Math.sin(t * 7.3) * 0.22 + Math.sin(t * 3.1) * 0.16;
  torch.position.x = -0.2 + Math.sin(t * 1.3) * 0.06;
  updateMotes(dt, t);
}
