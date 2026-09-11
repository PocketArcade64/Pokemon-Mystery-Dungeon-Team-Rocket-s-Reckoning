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
//   4. WHILE YOUR FINGER IS ON THE BALL, a white CAPTURE CIRCLE appears on the Pokemon with a
//      coloured TARGET RING shrinking inside it. Let go and the ring FREEZES at the size it had
//      at that instant and holds through the flight; landing inside that frozen ring is graded by
//      how small it was — Nice / Great / Excellent — and each grade is worth catch chance.
//      Nothing is drawn on the Pokemon when you are not touching the ball, as in GO.
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
import { makeAura, spinAura, disposeAura } from './aura.js';
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
// ...and a cap on its on-screen WIDTH. Models are fitted by height, so a wide flat species comes
// out wider than it is tall: Kabuto and Wailmer filled the screen edge to edge and buried the
// whole stage. Anything over this gets scaled down to fit.
const MON_SCREEN_W = 0.52;
const CAPTURE_OF_HEIGHT = 0.56;   // white capture circle radius, as a fraction of the Pokemon
const MIN_RING_RATIO = 0.13;      // how far the target ring shrinks before it resets

// The held ball. Distance from the camera is fixed so the throw always starts the same depth out;
// the on-screen size is then whichever of the two caps is smaller, which keeps the ball "large at
// the bottom middle" in portrait without turning it into a beach ball on a wide desktop window.
const BALL_DEPTH = 2.6;
const BALL_HOME_NDC = { x: 0, y: -0.70 };
const BALL_SCREEN_W = 0.22;       // of screen width
const BALL_SCREEN_H = 0.115;      // of screen height
// The Quest ball models are voxel spheres with the release BUTTON on one side, and the side they
// happen to face when loaded is not the camera. This is the yaw that turns the button toward the
// player, and the ball holds it for its whole life — held, in flight, on the floor, shaking.
// A ball that tumbles hides the one detail that says "Poke Ball" at a glance. The only exception
// is the deliberate spin of a charged curveball.
const BALL_FACE_Y = Math.PI;
const HOLD_NDC_X = 0.80;          // how far the held ball may be dragged, in NDC
const HOLD_NDC_Y_LO = -0.90;
const HOLD_NDC_Y_HI = 0.05;

// ---- Throw physics -----------------------------------------------------------------------------
// Solved for the rig above with the ball resting at its home point and a Basic-stage target:
//   horizontal distance to the body centre L = 3.96, launch height 0.34, body centre 0.76.
//   y at the target plane = 2.62 - 102.2 / v^2, so the ball clears the floor from v = 6.25 and
//   clears the top of the capture circle past v = 9.7.
// SPEED_MIN/SPEED_SPAN map flick power 0..1 onto v = 5.9..10.9, which puts the CONNECT BAND at
// power 0.10..0.78 — deliberately wide. In GO almost every throw reaches the Pokemon and what
// separates a good one from a bad one is where in the ring it lands, so power is a coarse
// three-way gate (short / connects / over) and the ring plus the aim are the fine skill.
const GRAVITY = -9.8;
const ELEV = rad(30);             // launch elevation off horizontal — fixed, as GO's is
const SPEED_MIN = 5.9;
const SPEED_SPAN = 5.0;

// A flick is release VELOCITY in screen-heights per second, so it feels identical on any screen.
// Below MIN_FLICK it is a tap or a fumble and the ball just settles back home.
//
// FLICK_FULL 5.2 is high on purpose. It was 3.4, calibrated against a mouse drag, and a real
// thumb flick clears that easily — so an ordinary throw came out at full power and sailed over
// the Pokemon every time. Full power now takes a deliberate fling: a comfortable flick measures
// around 1.7 and lands mid-band, and the whole connect band spans roughly 1.0 to 4.1.
const MIN_FLICK = 0.5;
const FLICK_FULL = 5.2;
const MAX_FLICK_ANGLE = rad(70);  // wider than this is a sideways swipe, not a throw

// How the release velocity is measured. FLICK_WINDOW caps how far back in time the sample search
// may reach; FLICK_STRAIGHT is the cosine each older leg of the drag must hold against the final
// leg to still count as part of the same flick (0.6 ≈ 53°). See flickOrigin().
const FLICK_WINDOW = 130;         // ms
const FLICK_STRAIGHT = 0.6;

// Aim. The flick's angle off vertical becomes a horizontal launch angle: at L = 3.96 a 12-degree
// aim throws the ball 0.84 off-centre, which is just outside a Basic target's capture circle.
const AIM_GAIN = 0.8;
const AIM_MAX = rad(30);          // ±2.3 units at the target plane — off-screen is not reachable

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

// ---- The capture sequence ----------------------------------------------------------------------
// Contact is not instant any more. The ball is SEEN to hit, the Pokemon is SEEN to be pulled into
// it as red light, and only then does the ball drop and shake. The three stages run back to back
// off `phaseT` in the 'absorb' phase.
const ABSORB_IMPACT = 0.18;       // ball stops dead on the Pokemon and recoils; red flash
const ABSORB_PULL = 0.52;         // the beam, and the Pokemon shrinking into the ball
const ABSORB_SETTLE = 0.16;       // beam fades, Pokemon gone
const ABSORB_TOTAL = ABSORB_IMPACT + ABSORB_PULL + ABSORB_SETTLE;

// GO's shake count says the answer before the answer: three shakes and a click is a catch, and
// anything short of three is a break-out.
const WOBBLES_CAUGHT = 3;
const BOUNCE_TIME = 0.22;         // the little hop after the ball lands
const SETTLE_PAUSE = 0.34;        // dead still on the floor before the first shake
// One shake per period, but the rock itself only occupies the first WOBBLE_ROCK of it. The rest is
// silence, and the silence IS the suspense — a ball that sways continuously has no beats to count.
const WOBBLE_PER = 0.95;
const WOBBLE_ROCK = 0.42;

// The camera pushes in on the ball for the shake, so the wobble is the whole screen.
//
// It pushes in on the WOBBLE, not on the absorb. Starting the move at contact put the camera
// inside the Pokemon — the ball is at the Pokemon's body then, and the Pokemon is still full
// size — so the whole absorption played out against a wall of texture. Staying wide until the
// ball drops means you watch the capture from where you threw it, and the push-in lands just as
// the ball settles on the ground to shake.
const ZOOM_LAMBDA = 6.5;          // damping rate toward the zoomed pose
const ZOOM_BACK = 1.8;            // how far in front of the ball the pushed-in camera sits
const ZOOM_UP = 0.55;

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
const CAM_QUAT = catchCamera.quaternion.clone();
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

// The tell that a curveball is charged is the ball VISIBLY SPINNING in your hand, and nothing
// else. There used to be a yellow halo ring around it as well; GO has no such ring, and it read
// as a second target circle sitting on the ball instead of as spin.

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

// ---- The catch itself: the click's star burst and the banner -----------------------------------
// Three shakes then the click, and the click IS the catch — so the click has to look like the
// answer. Yellow stars burst off the ball and fade, and the name of what you just caught rides
// above it. Both are sprites rather than billboards: the camera is pushed in and still damping
// when this fires, and a sprite is the one thing that cannot end up edge-on to it.
const CAUGHT_ORDER = 9;

// One five-pointed star, drawn once and tinted per sprite.
function starTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.translate(32, 32);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 12 : 29;                  // alternating inner / outer vertex
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.closePath();
  g.fillStyle = '#fff';
  g.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const STAR_COUNT = 16;
const STAR_LIFE = 0.95;                         // seconds, well inside the 1.5 s success hold
const STAR_GRAVITY = GRAVITY * 0.18;            // a lazy float-down: these are sparks, not pebbles
const stars = [];
{
  const tex = starTexture();
  for (let i = 0; i < STAR_COUNT; i++) {
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0xffe14d, transparent: true, opacity: 0,
      depthTest: false, depthWrite: false, fog: false,
    }));
    spr.renderOrder = CAUGHT_ORDER;
    spr.visible = false;
    catchScene.add(spr);
    stars.push({ spr, vx: 0, vy: 0, vz: 0, spin: 0, t: 0, size: 0.1 });
  }
}

// Out and slightly up in every direction from wherever the ball is actually lying. Every distance
// is a multiple of the ball's radius, so the burst is the same size on screen on a phone as on a
// wide desktop window — the same rule the rest of the file is built on.
function burstStars(at, ballRadius) {
  for (let i = 0; i < stars.length; i++) {
    const st = stars[i];
    // Evenly fanned with a little jitter. A purely random spread clumps, and a clump reads as one
    // smear of yellow rather than as stars.
    const a = (i / stars.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const sp = ballRadius * (6.5 + Math.random() * 5);
    st.vx = Math.cos(a) * sp;
    st.vy = Math.sin(a) * sp + ballRadius * 4;  // biased upward, so they arc instead of raining
    st.vz = (Math.random() - 0.5) * sp * 0.5;
    st.spin = (Math.random() - 0.5) * 7;
    st.size = ballRadius * (0.7 + Math.random() * 0.6);
    st.t = 0;
    st.spr.position.copy(at);
    st.spr.material.rotation = Math.random() * Math.PI;
    st.spr.material.opacity = 0;
    st.spr.scale.setScalar(st.size);
    st.spr.visible = true;
  }
}

function updateStars(dt) {
  for (const st of stars) {
    if (!st.spr.visible) continue;
    st.t += dt;
    st.vy += STAR_GRAVITY * dt;
    st.spr.position.x += st.vx * dt;
    st.spr.position.y += st.vy * dt;
    st.spr.position.z += st.vz * dt;
    st.spr.material.rotation += st.spin * dt;
    const p = st.t / STAR_LIFE;
    if (p >= 1) { st.spr.visible = false; st.spr.material.opacity = 0; continue; }
    // Snap in on the click, then fade and shrink the rest of the way out.
    st.spr.material.opacity = p < 0.1 ? p / 0.1 : 1 - (p - 0.1) / 0.9;
    st.spr.scale.setScalar(st.size * (1 - p * 0.45));
  }
}

// "<Name> was caught!", above the ball.
const CAUGHT_TEXT = new THREE.Sprite(new THREE.SpriteMaterial({
  transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false,
}));
CAUGHT_TEXT.renderOrder = CAUGHT_ORDER + 1;
CAUGHT_TEXT.visible = false;
catchScene.add(CAUGHT_TEXT);
let caughtTex = null;

function showCaughtText(msg) {
  caughtTex?.dispose();
  const cv = document.createElement('canvas');
  // The game's pixel face, with the same fallback stack index.html uses. The text is MEASURED
  // first and the canvas sized to it: the sprite is scaled by the canvas aspect, so a fixed-width
  // canvas would pad a short name with empty space and shrink the words to fit the padding.
  const font = '700 64px "PokemonPixel", "Silkscreen", "Trebuchet MS", system-ui, sans-serif';
  let g = cv.getContext('2d');
  g.font = font;
  cv.width = Math.ceil(g.measureText(msg).width) + 40;
  cv.height = 96;
  g = cv.getContext('2d');
  g.font = font;                                // resizing the canvas clears the context state
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(12,10,24,0.92)';        // the outline is what keeps it legible on any sky
  g.strokeText(msg, cv.width / 2, cv.height / 2);
  g.fillStyle = '#fff3b0';
  g.fillText(msg, cv.width / 2, cv.height / 2);

  caughtTex = new THREE.CanvasTexture(cv);
  caughtTex.colorSpace = THREE.SRGBColorSpace;
  CAUGHT_TEXT.material.map = caughtTex;
  CAUGHT_TEXT.material.needsUpdate = true;

  // Sized off the ball, then capped at 80% of the pushed-in frame's width so a long name cannot
  // run off both edges.
  const aspect = cv.width / cv.height;
  let h = Math.max(0.22, catchState.ballRadius * 2.1);
  let w = h * aspect;
  const wMax = 1.6 * halfWidthAt(ZOOM_BACK);
  if (w > wMax) { w = wMax; h = w / aspect; }
  CAUGHT_TEXT.scale.set(w, h, 1);
  CAUGHT_TEXT.userData.h = h;
  CAUGHT_TEXT.material.opacity = 0;
  CAUGHT_TEXT.visible = true;
}

// Sits above the resting ball and drifts up a touch as it fades in.
function updateCaughtText(t) {
  if (!CAUGHT_TEXT.visible) return;
  const s = catchState;
  const rise = Math.min(1, t / 0.45);
  CAUGHT_TEXT.position.set(
    s.hitPoint.x,
    s.ballRadius * 2.6 + CAUGHT_TEXT.userData.h * 0.5 + rise * s.ballRadius * 1.2,
    s.hitPoint.z,
  );
  CAUGHT_TEXT.material.opacity = Math.min(1, t / 0.2);
}

function hideCaught() {
  CAUGHT_TEXT.visible = false;
  CAUGHT_TEXT.material.opacity = 0;
  for (const st of stars) { st.spr.visible = false; st.spr.material.opacity = 0; }
}

// ---- The red capture light -----------------------------------------------------------------------
// Additive, unlit and un-fogged: this is an effect, not scenery.
//
// Drawn BELOW the ball's render order (6) on purpose. The ball is sitting inside the glow at this
// point, and if the glow paints after it the ball disappears into a red blob — the one thing the
// whole animation is supposed to be showing you is the Pokemon going INTO the ball, so the ball
// has to stay on top. depthTest stays on, so the glow's far hemisphere is still occluded by the
// Pokemon and it reads as a volume rather than a decal.
const ABSORB_ORDER = 5;

// The glow that engulfs the Pokemon and shrinks with it.
const ABSORB_GLOW = new THREE.Mesh(
  new THREE.SphereGeometry(1, 18, 12),
  new THREE.MeshBasicMaterial({
    color: 0xff4a2c, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  }),
);
ABSORB_GLOW.renderOrder = ABSORB_ORDER;
ABSORB_GLOW.visible = false;
catchScene.add(ABSORB_GLOW);

// The funnel of light between the two. Built along +Y as a unit-length cone: the WIDE end
// (radiusTop) is the Pokemon and the narrow end is the ball, so it reads as being sucked in.
const ABSORB_BEAM = new THREE.Mesh(
  new THREE.CylinderGeometry(0.5, 0.10, 1, 16, 1, true),
  new THREE.MeshBasicMaterial({
    color: 0xff6a3a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  }),
);
ABSORB_BEAM.renderOrder = ABSORB_ORDER;
ABSORB_BEAM.visible = false;
catchScene.add(ABSORB_BEAM);

const ABSORB_LIGHT = new THREE.PointLight(0xff4422, 0, 9);
catchScene.add(ABSORB_LIGHT);

const monHolder = new THREE.Group();
catchScene.add(monHolder);
const ballHolder = new THREE.Group();
catchScene.add(ballHolder);

// ---- Camera rig ------------------------------------------------------------------------------
// `camZoom` damps 0 (the wide throwing shot) -> 1 (pushed in on the ball for the shake). It MUST
// come back to exactly 0 before the next throw: the ring billboards, `pointAtNDC` and the ball's
// home point are all built from the wide pose's fixed basis, so a camera left a few degrees off
// would put the ball somewhere other than where the player is aiming.
let camZoom = 0;
const _zoomPos = new THREE.Vector3();
const _zoomLook = new THREE.Vector3();
const _restPoint = new THREE.Vector3();

function resetCamera() {
  camZoom = 0;
  catchCamera.position.copy(CAM_POS);
  catchCamera.quaternion.copy(CAM_QUAT);
  catchCamera.updateMatrixWorld(true);
}

function updateCamera(dt) {
  const s = catchState;
  const want = (s.phase === 'wobble' || s.phase === 'success') ? 1 : 0;
  camZoom = THREE.MathUtils.damp(camZoom, want, ZOOM_LAMBDA, dt);
  if (want === 0 && camZoom < 0.004) { if (camZoom !== 0) resetCamera(); return; }

  // Framed on where the ball is GOING TO REST, not on the ball. Tracking the ball means the camera
  // rides down with it during the fall and the drop reads as the world moving up instead of the
  // ball moving down. Aiming at the floor spot lets the ball fall into a held frame.
  const b = s.phase === 'wobble' || s.phase === 'success'
    ? _restPoint.set(s.hitPoint.x, s.ballRadius, s.hitPoint.z)
    : (s.ballObj ? s.ballObj.position : CAM_LOOK);
  const focusY = b.y + s.ballRadius * 0.6;
  _zoomPos.set(b.x * 0.45, focusY + ZOOM_UP, b.z + ZOOM_BACK);
  _zoomLook.set(b.x, focusY, b.z);
  catchCamera.position.lerpVectors(CAM_POS, _zoomPos, camZoom);
  _zoomLook.lerp(CAM_LOOK, 1 - camZoom);
  catchCamera.lookAt(_zoomLook);
  catchCamera.updateMatrixWorld(true);
}

// ---- State -------------------------------------------------------------------------------------
const BALL_HOME = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _beamDir = new THREE.Vector3();
const _beamUp = new THREE.Vector3(0, 1, 0);

export const catchState = {
  active: false,
  phase: 'idle',      // aim -> flying -> wobble -> success | fail -> aim (auto) | empty
  dex: null,
  ballId: 'poke-ball',
  monObj: null,
  ballObj: null,
  shadow: false,      // a shadow (aggressive) wild: wears the purple aura for this encounter
  monAura: null,      // that aura, a child of monObj — built in fitMonToFrame
  monX: 0, monDrift: 0, monBodyY: 0.8, monHeight: 1.4,
  monFit: 1,          // extra scale applied to keep a wide species inside the frame
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
  spinAngle: 0,       // accumulated yaw of a spinning ball, on top of BALL_FACE_Y
  curve: false,       // whether the throw in flight is a curveball
  grade: null,        // 'excellent' | 'great' | 'nice' | 'hit'
  wobbles: 0,
  shakesDone: 0,
  hitPoint: new THREE.Vector3(),   // where the ball struck; the absorb and the drop start here
  monStart: new THREE.Vector3(),   // where the Pokemon stood at that instant
  willCatch: false,
  resultMsg: '',
  accuracyPct: 0,
  onResult: null,     // (result) => void
  onThrow: null,      // () => bool: consume a ball; false means none left
  onGrade: null,      // (label) => void: pop "EXCELLENT!" etc. in the overlay
  onRearm: null,      // () => {ballId, ballsLeft} | null: GO hands you a fresh ball by itself
  onEmpty: null,      // () => void: fired once when the bag runs dry and there is nothing to throw
  onSfx: null,        // (name) => void: 'absorb' | 'shake' | 'lock', fired on the animation beats
  ballsLeft: 0,
  canvasW: 1, canvasH: 1,
  t: 0,
  phaseT: 0,
};

function clearMon() {
  // The aura before the body it hangs on: it is a child of monObj, and disposeObject deliberately
  // leaves geometry alone (it is shared with the loader cache) — which is right for the model and
  // wrong for an aura, whose geometry is built fresh for this encounter and shared with nothing.
  disposeAura(catchState.monAura);
  catchState.monAura = null;
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
  // Later-stage species make the same ball a worse bet, and the ring colour says so up front —
  // except with a Master Ball, where nothing about the target changes the answer, so the stage
  // penalty is skipped and the ring stays green on a Legendary.
  const c = CATALOG_BY_DEX.get(catchState.dex);
  if (item?.guaranteed) { /* certain: leave base alone */ }
  else if (c?.stage === 'Stage2') base -= 0.10;
  else if (c?.stage === 'Stage1') base -= 0.05;
  catchState.ringColor = ringColorFor(base);
  TARGET_RING.material.color.setHex(catchState.ringColor);
}

// ---- Lifecycle ---------------------------------------------------------------------------------
// Start a fresh catch attempt sequence for one wild Pokemon. `theme` is the floor theme and it
// dresses the whole stage.
// `shadow` is the wild's `aggressive` flag. It draws the same purple aura the Pokemon was wearing
// on the floor and in the battle you had to win to get here, so the thing you are throwing at is
// visibly the thing that came after you. It is the last screen that shows it: what comes out of the
// ball is a fresh mon with no flag on it (inventory.addCaught), so the aura going out is the catch.
export function startCatch({ dex, ballId, ballsLeft, onResult, onThrow, onGrade, onRearm, onSfx,
                             onEmpty, floorNumber = 1, theme = null, shadow = false }) {
  clearMon(); clearBall(); hideTrail(); hideAbsorb(); resetCamera();

  const th = theme || THEMES[0];
  if (!backdrop || backdropTheme?.id !== th.id) buildBackdrop(th);

  const c = CATALOG_BY_DEX.get(dex);
  const frac = MON_SCREEN_FRAC[c?.stage] ?? 0.28;
  const height = frac * 2 * halfHeightAt(targetDepth());

  Object.assign(catchState, {
    active: true, phase: 'aim', dex, ballId,
    // The aura itself is built in fitMonToFrame, which is the only place the body's real width is
    // known — see the note there.
    shadow, monAura: null,
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
    ball: null, held: null, spin: 0, spinAngle: 0, curve: false, grade: null, monFit: 1,
    wobbles: 0, shakesDone: 0, willCatch: false, resultMsg: '', accuracyPct: 0,
    onResult, onThrow, onGrade, onRearm, onSfx, onEmpty, ballsLeft, t: 0, phaseT: 0,
  });
  refreshRingColor();

  const monObj = createMonObject(dex, { height, onReady: fitMonToFrame });
  monObj.position.set(0, 0, TARGET_Z);
  monHolder.add(monObj);
  catchState.monObj = monObj;
  catchState.monFit = 1;

  // Both rings are sized here, not just the capture circle. main.js starts the encounter from
  // INSIDE the playing branch of the frame loop, so that frame renders the catch scene without
  // ever calling updateCatch — and a target ring left at its unit scale is drawn a third again
  // too big for one frame, which pops.
  const r = catchState.captureRadius;
  CAPTURE_RING.scale.set(r, r, 1);
  TARGET_RING.scale.set(r, r, 1);
  CAPTURE_RING.position.set(0, catchState.monBodyY, TARGET_Z + 0.02);
  TARGET_RING.position.set(0, catchState.monBodyY, TARGET_Z + 0.03);
  // Hidden until a finger is on the ball — updateRing owns their visibility from here.
  CAPTURE_RING.visible = false;
  TARGET_RING.visible = false;
  hideCaught();

  spawnBall();
}

// Shrink the loaded model until it fits the frame sideways, and re-centre the rings on whatever
// height that leaves. Called once, when the real model replaces the placeholder.
//
// `captureRadius` is deliberately NOT recomputed. It stays on the NOMINAL height for the species'
// stage, so shrinking a wide Pokemon to fit does not also make it a harder target — the circle
// ends up roughly hugging its width instead of its height, which is what it should do anyway.
// `monFit` then multiplies every other scale the Pokemon is given, so the dodge lunge and the
// absorb shrink both compose with it instead of throwing it away.
const _fitBox = new THREE.Box3();
const _fitSize = new THREE.Vector3();

function fitMonToFrame(group) {
  const s = catchState;
  if (group !== s.monObj) return;                 // a stale load from a previous encounter
  group.scale.setScalar(1);
  group.updateMatrixWorld(true);
  _fitBox.setFromObject(group).getSize(_fitSize);
  const maxW = MON_SCREEN_W * 2 * halfWidthAt(targetDepth());
  s.monFit = _fitSize.x > maxW ? maxW / _fitSize.x : 1;
  group.scale.setScalar(s.monFit);
  const visualH = Math.max(0.2, _fitSize.y * s.monFit);
  s.monBodyY = visualH * 0.55;
  CAPTURE_RING.position.y = s.monBodyY;
  TARGET_RING.position.y = s.monBodyY;

  // The shadow aura goes on HERE and not at spawn, for two reasons that both point at this line.
  //
  // Order: the width measurement above must not see it. An aura is deliberately wider than the
  // body it surrounds, so measuring the pair together would shrink the Pokemon to make room for
  // its own aura — and then shrink the aura with it, every encounter, compounding nothing but a
  // smaller Pokemon.
  //
  // Width: it is solved FROM that measurement. makeAura's cloud spans roughly 2.07 * height at
  // spread 1, which is sized for a creature standing on an open dungeon floor; here it has to land
  // about a quarter wider than the actual body, whatever shape the species turned out to be, or a
  // wide one (Kabuto, Wailmer) wears its aura inside itself and a tall thin one is lost in it.
  // It is a child of the group, so monFit and every scale updateMon applies — the dodge, the
  // attack lunge, the shrink into the ball — carry it along without any code of their own.
  //
  // `ring: false`: no ground disc here, unlike the dungeon and the battle field. This camera is
  // almost at eye level over a lit ground plane, so the disc flattened into a purple circle
  // painted on the grass under the Pokemon rather than anything attached to it — and it landed in
  // the same place as the capture and target rings, which are what the throw is aimed at. The
  // puffs alone carry the marker here.
  if (s.shadow && !s.monAura) {
    const spread = THREE.MathUtils.clamp(1.25 * Math.max(0.2, _fitSize.x) / (2.07 * s.monHeight), 0.4, 1);
    s.monAura = makeAura(s.monHeight, { spread, ring: false });
    group.add(s.monAura);
  }
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

// Square the ball back up so its button faces the camera. Anything that wants to rock or roll the
// ball composes on top of this rather than writing rotation directly.
function faceBall(obj, roll = 0) {
  obj.rotation.set(0, BALL_FACE_Y, roll);
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
  faceBall(pivot);
  ballHolder.add(pivot);
  catchState.ballObj = pivot;
  catchState.ball = { x: BALL_HOME.x, y: BALL_HOME.y, z: BALL_HOME.z, vx: 0, vy: 0, vz: 0 };
  catchState.spin = 0;
  catchState.spinAngle = 0;
  catchState.curve = false;
}

export function endCatch() {
  catchState.active = false;
  catchState.phase = 'idle';
  catchState.held = null;
  clearMon(); clearBall(); hideTrail(); hideAbsorb(); hideCaught();
  resetCamera();
  CAPTURE_RING.visible = false;
  TARGET_RING.visible = false;
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
  // Touching the ball is what puts the circles on the Pokemon, and the shrink starts from full.
  catchState.ringPhase = 0;
  catchState.ringRatio = 1;
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
  // Deep enough to cover FLICK_WINDOW even on a 120 Hz digitiser — flickOrigin walks backwards
  // through these and a short buffer would cut the search off mid-flick.
  if (h.samples.length > 20) h.samples.shift();

  // Which way the swirl went, and it is worth deriving rather than guessing — this had the sign
  // backwards and every curveball bent the wrong way.
  //
  // Screen y grows DOWNWARD. Take a clockwise swirl as the viewer sees it: right, then down. That
  // is prev = (1, 0) then cur = (0, +1), so the cross product prevDx*dy - prevDy*dx = +1.
  // CLOCKWISE is therefore POSITIVE here, and counter-clockwise negative. `spin` is +1 for a ball
  // that bends to the RIGHT (it is multiplied straight into +x), so:
  //     clockwise  -> +1 -> curves right
  //     counter-cw -> -1 -> curves left
  if (h.pathLen > SPIN_PATH_MIN && Math.abs(h.spinAccum) > SPIN_THRESHOLD) {
    catchState.spin = h.spinAccum > 0 ? 1 : -1;
  }
}

// Where the flick STARTED: walk back from the release point, through the drag samples, for as
// long as the path keeps heading the same way as its final leg.
//
// THIS IS THE CURVEBALL FIX and it must not be simplified back to "the oldest sample in the last
// N ms". A swirl is a LOOP, so the sample from a fixed 140 ms ago sits somewhere on the far side
// of that loop, and measuring from it reads the loop's CHORD as the throw. The chord is mostly
// sideways, the aim is the flick's angle, so every single curveball launched at the clamped
// maximum aim angle and flew straight off the side of the screen — in whichever direction the
// player habitually swirls. Walking back only through legs that agree with the last one isolates
// the straight flick at the end of the gesture from the swirl that preceded it.
function flickOrigin(samples, relX, relY, now) {
  const pts = samples.concat([{ x: relX, y: relY, t: now }]);
  let refX = 0, refY = 0, refLen = 0;
  let origin = pts[pts.length - 1];
  for (let k = pts.length - 1; k > 0; k--) {
    const a = pts[k - 1], b = pts[k];
    if (now - a.t > FLICK_WINDOW) break;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    // Sub-pixel jitter carries no direction. Before the flick is found it is trailing noise at
    // the release point and is skipped; once inside the flick it means the finger stopped, which
    // is where the flick began.
    if (len < 1) { if (refLen) break; continue; }
    if (!refLen) { refX = dx; refY = dy; refLen = len; origin = a; continue; }
    if ((refX * dx + refY * dy) / (refLen * len) < FLICK_STRAIGHT) break;
    origin = a;
  }
  return origin;
}

export function catchPointerUp(x, y, canvasW, canvasH) {
  const h = catchState.held;
  catchState.held = null;
  if (!catchState.active || catchState.phase !== 'aim' || !h) return;
  if (canvasW) { catchState.canvasW = canvasW; catchState.canvasH = canvasH; }
  const ch = catchState.canvasH;

  // Release velocity off the start of the final straight leg of the gesture. Velocity rather than
  // total drag distance is what makes this a flick: you can drag the ball slowly across the screen
  // to line up your aim and it costs you no power, exactly as in GO.
  //
  // BOTH axes are normalised by screen HEIGHT, not one by each. Normalising x by width and y by
  // height would stretch the flick ANGLE by the aspect ratio, and the angle is the aim — the same
  // physical gesture would throw somewhere different on a tablet than on a phone.
  const now = performance.now();
  const s0 = flickOrigin(h.samples, x, y, now);
  const dt = Math.max(0.016, (now - s0.t) / 1000);
  const up = ((s0.y - y) / ch) / dt;
  const side = ((x - s0.x) / ch) / dt;
  const flick = Math.hypot(up, side);
  const angle = Math.atan2(side, up);          // 0 = straight up the screen, + = to the right

  if (up <= 0 || flick < MIN_FLICK || Math.abs(angle) > MAX_FLICK_ANGLE) {
    // Not a throw. Let the ball settle back home so it never reads as stuck mid-drag.
    catchState.spin = 0;
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
    CAPTURE_RING.visible = false;
  }

  if (s.phase === 'aim') updateHeldBall(dt);
  else if (s.phase === 'flying') updateFlight(dt);
  else if (s.phase === 'absorb') updateAbsorb();
  else if (s.phase === 'fail' || s.phase === 'empty') updateDeadBall(dt);
  else if (s.phase === 'wobble') updateWobble();
  else if (s.phase === 'success' && s.ballObj) {
    faceBall(s.ballObj);
    s.ballObj.position.y = s.ballRadius + Math.abs(Math.sin(s.phaseT * 2.4)) * s.ballRadius * 0.5;
  }
  fadeTrail(dt);
  updateStars(dt);
  if (s.phase === 'success') updateCaughtText(s.phaseT);
  updateCamera(dt);
}

// The circles, on GO's rules.
//
// 1. They exist only WHILE YOU ARE TOUCHING THE BALL. An untouched Pokemon is just standing there;
//    the circles are the aiming reticle, so they belong to the hand that is aiming. They are also
//    reset to full on every touch (catchPointerDown), so the shrink always starts from the top of
//    its loop rather than from wherever an idle loop happened to have wandered to.
// 2. THE RING FREEZES AT RELEASE. The ratio the ring had the instant you let go is the ratio the
//    throw is graded against in resolveContact, and it stays on screen, frozen, for the whole
//    flight — so the circle the ball lands in is the circle you actually threw at. It used to keep
//    shrinking through the flight, which meant the grade was decided by where the loop happened to
//    be ~0.6 s after you released: the ring you aimed with was not the ring you were scored on.
// Both still track the Pokemon sideways, because a reticle that does not follow the target is not
// a reticle.
function updateRing(dt) {
  const s = catchState;
  const show = s.phase === 'flying' || (s.phase === 'aim' && !!s.held);
  CAPTURE_RING.visible = show;
  TARGET_RING.visible = show;

  if (!show) {
    // Nothing on screen and nothing in flight: park the loop at full so the next touch starts big.
    s.ringPhase = 0;
    s.ringRatio = 1;
  } else if (s.phase === 'aim') {
    s.ringPhase += dt / s.ringPeriod;
    while (s.ringPhase >= 1) s.ringPhase -= 1;
    s.ringRatio = 1 - s.ringPhase * (1 - MIN_RING_RATIO);
  }
  // 'flying' falls through with ringRatio untouched — that IS the freeze.

  const r = s.ringRatio * s.captureRadius;
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
  s.monObj.scale.setScalar(scale * s.monFit);
  // Turned in the Pokemon's own local space, so the cloud keeps orbiting at a steady rate while
  // the body leans and sidesteps under it rather than swinging with the lean.
  spinAura(s.monAura, dt);
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
    // A charged curveball is the ONE place the button is allowed to swing away from the camera:
    // the ball visibly spinning in your hand is the tell that the swirl took.
    s.spinAngle += dt * 22 * s.spin;
    obj.rotation.set(0, BALL_FACE_Y + s.spinAngle, 0);
  } else {
    s.spinAngle = 0;
    faceBall(obj);
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
  // Button forward the whole flight; only a curveball is allowed to spin, and only about Y so
  // the button sweeps past the camera rather than tumbling away from it.
  if (s.curve) { s.spinAngle += dt * 26 * s.spin; obj.rotation.set(0, BALL_FACE_Y + s.spinAngle, 0); }
  else faceBall(obj);
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

  // Inside the capture circle. The grade is the size of the target ring — which has been FROZEN
  // since the release, so this is the ring the player aimed with — and the ball has to be inside
  // that ring, not merely inside the white circle.
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
  // A Master Ball is certain, and the 0.97 cap above is why that cannot be said in the arithmetic
  // — it is said here instead. The grade, the accuracy and the bonus are all still computed and
  // still shown, because EXCELLENT! is worth seeing; they just no longer decide anything.
  s.willCatch = item?.guaranteed ? true : Math.random() < chance;
  s.accuracyPct = Math.round((1 - dist / R) * 100);

  const label = grade === 'hit' ? null
    : grade === 'excellent' ? 'EXCELLENT!'
    : grade === 'great' ? 'GREAT!' : 'NICE!';
  if (label || s.curve) s.onGrade?.([s.curve ? 'CURVEBALL!' : null, label].filter(Boolean).join(' '));

  // GO's shake count says the answer before the answer arrives: three shakes then the click is a
  // catch, and one or two is always a break-out. Which of one or two only says how close it was.
  s.wobbles = s.willCatch ? WOBBLES_CAUGHT : (chance > 0.55 ? 2 : 1);
  s.shakesDone = 0;
  hideTrail();
  TARGET_RING.visible = false;
  CAPTURE_RING.visible = false;

  // Contact is SEEN. The ball stops dead where it struck and the Pokemon is pulled into it as red
  // light from exactly that point — which is why the contact position is kept rather than the ball
  // being teleported to the Pokemon's feet.
  // Nudged toward the camera off the Pokemon's centre plane, so the ball comes to rest on the
  // near FACE of the thing it hit rather than buried inside it — otherwise the ball is invisible
  // for the whole absorb and there is nothing for the light to be drawn into.
  s.hitPoint.set(hx, hy, TARGET_Z + 0.5);
  s.ballObj.position.copy(s.hitPoint);
  faceBall(s.ballObj);
  if (s.monObj) s.monStart.copy(s.monObj.position);
  s.phase = 'absorb';
  s.phaseT = 0;
  s.onSfx?.('absorb');
}

// ---- The capture: impact, then the Pokemon drawn in as red light ---------------------------------
// Three stages off phaseT. The Pokemon shrinks and travels toward the BALL, wherever the ball
// happens to be sitting, with a funnel of light between the two — so the absorption is always
// anchored to the throw that earned it rather than to a fixed point on the stage.
function updateAbsorb() {
  const s = catchState;
  const obj = s.ballObj;
  if (!obj) return;
  const hp = s.hitPoint;

  // 1. Impact: the ball punches in and rocks back out toward the camera.
  const impact = Math.min(1, s.phaseT / ABSORB_IMPACT);
  obj.position.set(hp.x, hp.y, hp.z + Math.sin(impact * Math.PI) * 0.22);
  faceBall(obj, Math.sin(impact * Math.PI * 2) * 0.3);

  const pull = THREE.MathUtils.clamp((s.phaseT - ABSORB_IMPACT) / ABSORB_PULL, 0, 1);
  const fade = THREE.MathUtils.clamp((s.phaseT - ABSORB_IMPACT - ABSORB_PULL) / ABSORB_SETTLE, 0, 1);

  // 2. The Pokemon: shrinks and slides into the ball on an ease-in, so it hangs for a beat and
  //    then snaps away — a linear shrink reads as the model simply being scaled down.
  const e = pull * pull;
  if (s.monObj) {
    if (pull >= 1) {
      s.monObj.visible = false;
    } else {
      s.monObj.position.lerpVectors(s.monStart, hp, e);
      s.monObj.scale.setScalar(Math.max(0.02, 1 - e) * s.monFit);
    }
  }

  // 3. The light. The glow engulfs the Pokemon and shrinks with it; the beam funnels from the
  //    Pokemon's remaining bulk down into the ball.
  // Sized off monBodyY / captureRadius rather than the nominal monHeight, so a wide species that
  // was scaled down to fit the frame gets a glow that matches what is actually on screen.
  const glowAt = _tmp.copy(s.monStart).lerp(hp, e);
  glowAt.y += s.monBodyY * (1 - e);
  const flare = Math.sin(Math.min(1, s.phaseT / (ABSORB_IMPACT + 0.1)) * Math.PI * 0.5);
  // FLATTENED along z, not a round sphere. The ball is resting on the Pokemon's near face, so a
  // round glow of this radius encloses it — and three.js draws every transparent object after
  // every opaque one, so no renderOrder can lift the opaque ball back out of it. Squashing the
  // glow in depth keeps its near surface behind the ball while it still reads as a blob of light
  // around the Pokemon from this camera.
  ABSORB_GLOW.visible = fade < 1;
  ABSORB_GLOW.position.copy(glowAt);
  const gr = Math.max(0.03, s.captureRadius * 0.95 * (1 - e * 0.9));
  ABSORB_GLOW.scale.set(gr, gr, gr * 0.3);
  ABSORB_GLOW.material.opacity = 0.75 * flare * (1 - fade);

  ABSORB_LIGHT.position.copy(glowAt);
  ABSORB_LIGHT.intensity = 5.5 * flare * (1 - fade);

  const from = obj.position;
  const dir = _beamDir.copy(glowAt).sub(from);
  const len = dir.length();
  ABSORB_BEAM.visible = pull > 0 && fade < 1 && len > 0.05;
  if (ABSORB_BEAM.visible) {
    ABSORB_BEAM.position.copy(from).addScaledVector(dir, 0.5);
    ABSORB_BEAM.quaternion.setFromUnitVectors(_beamUp, dir.divideScalar(len));
    ABSORB_BEAM.scale.set(Math.max(0.06, 1 - e * 0.55), len, Math.max(0.06, 1 - e * 0.55));
    ABSORB_BEAM.material.opacity = 0.85 * Math.sin(pull * Math.PI) * (1 - fade);
  }

  if (s.phaseT < ABSORB_TOTAL) return;
  hideAbsorb();
  if (s.monObj) s.monObj.visible = false;
  s.phase = 'wobble';
  s.phaseT = 0;
}

function hideAbsorb() {
  ABSORB_GLOW.visible = false;
  ABSORB_GLOW.material.opacity = 0;
  ABSORB_BEAM.visible = false;
  ABSORB_BEAM.material.opacity = 0;
  ABSORB_LIGHT.intensity = 0;
}

// The ball FALLS to the floor, bounces, settles — and only then starts shaking. The fall is its
// own beat, not a lead-in that overlaps the first shake: the camera is aimed at the resting spot
// rather than at the ball, so the ball visibly drops into frame instead of the camera riding down
// with it and cancelling the whole sense of falling.
function updateWobble() {
  const s = catchState;
  if (!s.ballObj) return;
  const groundY = s.ballRadius;
  const fromY = s.hitPoint.y;

  // 1. Real gravity fall from the contact point, so the drop time follows the drop height.
  const fallT = Math.sqrt(Math.max(0.02, 2 * Math.max(0, fromY - groundY) / -GRAVITY));
  if (s.phaseT < fallT) {
    const y = fromY + 0.5 * GRAVITY * s.phaseT * s.phaseT;
    s.ballObj.position.set(s.hitPoint.x, Math.max(groundY, y), s.hitPoint.z);
    return;
  }

  // 2. One small bounce, then a still beat before anything shakes. The pause is what makes the
  //    first shake land as an event rather than as the tail of the fall.
  const afterFall = s.phaseT - fallT;
  if (afterFall < BOUNCE_TIME) {
    const p = afterFall / BOUNCE_TIME;
    s.ballObj.position.set(s.hitPoint.x, groundY + Math.sin(p * Math.PI) * (groundY * 1.1), s.hitPoint.z);
    return;
  }
  s.ballObj.position.set(s.hitPoint.x, groundY, s.hitPoint.z);
  const wt = afterFall - BOUNCE_TIME - SETTLE_PAUSE;
  if (wt < 0) return;

  // 3. The shakes. Each one is a quick rock inside a long period — the SILENCE after the rock is
  //    the suspense, so the ball must come to a dead stop between them rather than swaying the
  //    whole time.
  const total = WOBBLE_PER * s.wobbles;
  const inWobble = (wt % WOBBLE_PER) / WOBBLE_PER;
  const done = Math.min(s.wobbles, Math.floor(wt / WOBBLE_PER) + 1);
  if (done > s.shakesDone) { s.shakesDone = done; s.onSfx?.('shake'); }
  if (inWobble < WOBBLE_ROCK) {
    const r = inWobble / WOBBLE_ROCK;
    faceBall(s.ballObj, Math.sin(r * Math.PI * 2) * 0.42 * (1 - r * 0.35));
    s.ballObj.position.y = groundY + Math.abs(Math.sin(r * Math.PI * 2)) * groundY * 0.3;
  } else {
    faceBall(s.ballObj);
    s.ballObj.position.y = groundY;
  }
  if (wt <= total) return;

  faceBall(s.ballObj);
  if (s.willCatch) {
    // Three shakes and the click. The click IS the catch — stars off the ball and the name above
    // it, both fired on this exact frame so they land with the lock sound rather than after it.
    s.phase = 'success';
    s.phaseT = 0;
    s.onSfx?.('lock');
    const name = CATALOG_BY_DEX.get(s.dex)?.name || 'It';
    burstStars(s.ballObj.position, s.ballRadius);
    showCaughtText(`${name} was caught!`);
    s.resultMsg = `Gotcha! ${name} was caught!`;
    s.onResult?.({
      caught: true, msg: s.resultMsg, ballId: s.ballId, dex: s.dex,
      accuracy: s.accuracyPct, grade: s.grade, curve: s.curve,
    });
  } else {
    // Burst open: the Pokemon is back out where it was standing and the ball is flung aside. The
    // rings stay hidden until the re-arm — the camera is still pushed in, and they are billboards
    // built for the wide shot, so showing them here would face them the wrong way.
    if (s.monObj) {
      s.monObj.visible = true;
      s.monObj.position.copy(s.monStart);
      s.monObj.scale.setScalar(s.monFit);
    }
    const b = s.ball;
    b.x = s.ballObj.position.x; b.y = groundY; b.z = s.ballObj.position.z;
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
    // Even a knocked-away ball keeps its face to the camera rather than tumbling.
    faceBall(obj);
  }
  if (s.phase === 'empty' || s.phaseT < FAIL_HOLD) return;

  const next = s.onRearm?.();
  if (!next) {
    // Out of balls. The 'empty' phase used to be a DEAD END: there was nothing left to throw, the
    // encounter never resolved, and the only way out was noticing the small Run button in the
    // corner. It reads as a freeze. Tell main.js instead and let it close the encounter.
    s.phase = 'empty';
    s.phaseT = 0;
    s.onEmpty?.();
    return;
  }
  s.ballId = next.ballId;
  s.ballsLeft = next.ballsLeft;
  s.phase = 'aim';
  s.phaseT = 0;
  s.grade = null;
  s.willCatch = false;
  s.held = null;
  if (s.monObj) { s.monObj.visible = true; s.monObj.scale.setScalar(s.monFit); }
  // Hard-snap the camera back to the wide pose. The ring billboards and the ball's home point are
  // all built from that pose's fixed basis, so aiming from anything else would put the ball
  // somewhere other than where the player thinks it is.
  resetCamera();
  hideAbsorb();
  // Left hidden on purpose: the circles come back on the next touch of the ball, not with it.
  s.ringPhase = 0;
  s.ringRatio = 1;
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

// A Master Ball that did not connect. Every way a throw can fail funnels through finishThrow, so
// this is the one place that has to know the ball cannot: it takes the ball from wherever it ended
// up — short of the target, sailing over, swatted out of the air, off the side of the stage — puts
// it on the Pokemon, and hands the sequence to the ordinary capture from there.
//
// Deliberately NOT a special animation. The ball snapping to the target and the absorb and the
// three shakes playing out exactly as they do for a clean hit is what sells the Master Ball as a
// better ball rather than as a cutscene, and it means nothing downstream (the absorb, the camera
// push-in, the stars, onResult) needs a branch for it.
function masterBallHomesIn() {
  const s = catchState;
  s.grade = null;
  s.curve = false;
  s.spin = 0;
  s.willCatch = true;
  s.accuracyPct = 100;
  s.wobbles = WOBBLES_CAUGHT;
  s.shakesDone = 0;
  hideTrail();
  TARGET_RING.visible = false;
  CAPTURE_RING.visible = false;
  // Dead centre of the body, nudged toward the camera off its centre plane — the same contact
  // point a perfect throw would have produced. See the note in resolveContact.
  s.hitPoint.set(s.monX, s.monBodyY, TARGET_Z + 0.5);
  s.ballObj.position.copy(s.hitPoint);
  faceBall(s.ballObj);
  if (s.monObj) s.monStart.copy(s.monObj.position);
  s.phase = 'absorb';
  s.phaseT = 0;
  s.onSfx?.('absorb');
}

// A failed throw: report it, then let updateDeadBall re-arm when the beat is up.
// `reason` is what main.js branches on — string-matching the message was fragile.
function finishThrow(reason, msg) {
  const s = catchState;
  // ... unless it was a Master Ball, in which case there is no such thing as a failed throw. The
  // 'broke' reason is excluded because it cannot happen with one (willCatch is forced true in
  // resolveContact, so the wobbles always run to three) and because a ball that had already
  // captured has no business capturing a second time.
  if (reason !== 'broke' && ITEM_BY_ID.get(s.ballId)?.guaranteed && s.ballObj) {
    masterBallHomesIn();
    return;
  }
  s.resultMsg = msg;
  s.grade = null;
  s.phase = 'fail';
  s.phaseT = 0;
  s.spin = 0;
  s.curve = false;
  s.onResult?.({ caught: false, reason, msg, ballId: s.ballId, dex: s.dex, outOfBalls: s.ballsLeft <= 0 });
}
