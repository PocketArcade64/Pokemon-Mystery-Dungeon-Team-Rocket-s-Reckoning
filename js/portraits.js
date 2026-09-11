// Still portraits of a species' 3D model, rendered once and cached as a PNG data URL.
//
// The bag's team strip shows all six party members' models at once, and the switch and
// swap-or-release screens do the same. Six live 3D views would be six WebGL contexts, and a page
// gets only a handful before the browser starts killing the oldest — see js/modelstage.js for what
// that does to the dungeon. So these are flat images: each species is rendered ONCE through the
// shared offscreen stage and never rendered again.
import * as THREE from 'three';
import { setPreviewModel, hasModelForDex } from './models.js';
import { renderToStage } from './modelstage.js';

const SIZE = 160;           // square, and comfortably above the ~64px the strip displays at
// Half-height of the ortho box. Models are fitted to 1.0 tall and then centred on the camera's own
// axis, so 0.65 leaves about 15% margin above and below — enough that a tall species is not
// touching the frame and a small one is not lost in it.
const FRUSTUM = 0.65;

// A three-quarter view, turned to face the viewer's LEFT.
//
// A model's forward direction at rotation.y = 0 is +Z, straight down the camera's axis, which is a
// dead-flat front elevation — the least informative angle there is on a voxel model, since it hides
// the depth entirely and makes a Charmander and a Charmeleon read as the same silhouette. Rotating
// by -PI/4 puts forward at (-0.71, 0, +0.71): toward the camera and to the left, so the roster
// shows each Pokemon's front and one flank at once. Same convention the battle field's foe uses
// (see FACING in js/ui-screens.js).
const PORTRAIT_YAW = -Math.PI / 4;

let rig = null;

function ensureRig() {
  if (rig) return rig;
  // A plain 2D canvas: the stage renders, this receives the blit, and toDataURL reads it back.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  // Dead level and aimed at the origin, so world y=0 is the middle of the image and a model
  // straddling it is centred by construction.
  const camera = new THREE.OrthographicCamera(-FRUSTUM, FRUSTUM, FRUSTUM, -FRUSTUM, 0.01, 60);
  camera.userData.frustum = FRUSTUM;
  camera.position.set(0, 0, 4);
  camera.lookAt(0, 0, 0);

  const holder = new THREE.Group();
  holder.rotation.y = PORTRAIT_YAW;

  rig = { canvas, ctx, camera, holder };
  return rig;
}

// Wait until every texture on `root` has actually decoded.
//
// This is REQUIRED, not an optimisation. A Quest model is an OBJ plus an MTL plus a PNG atlas, and
// loadModelOrNull resolves as soon as the geometry is parsed — MTLLoader kicks the atlas off in the
// background and nobody awaits it. A live preview does not care, because it re-renders every frame
// and the texture simply appears. A portrait is ONE render that is then cached forever, so
// snapshotting early bakes an untextured model in: every species that had not already been drawn
// somewhere else in the game came out as a black silhouette.
//
// It POLLS rather than listening for a load event, and it has to. TextureLoader hands back a
// Texture whose `.image` is still UNDEFINED and fills it in later, so at the moment a model
// resolves there is frequently no image object to attach a listener to at all — only a material
// with an empty `map`. Waiting on "images that exist but are not complete" therefore waits on
// nothing, which is exactly how the black silhouettes got through the first attempt at this.
function texturesReady(root) {
  let ready = true;
  root.traverse(o => {
    if (!ready || !o.isMesh) return;
    for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!mat || !mat.map) continue;               // untextured material: nothing to wait for
      const img = mat.map.image;
      // No image yet = still in flight. An ImageBitmap is decoded by definition; an
      // HTMLImageElement reports through .complete, and a zero width means it decoded to nothing.
      if (!img || !(img.width > 0) || (img.complete === false)) { ready = false; return; }
    }
  });
  return ready;
}

async function awaitTextures(root, timeoutMs = 6000) {
  const deadline = performance.now() + timeoutMs;
  while (!texturesReady(root)) {
    // A texture that never arrives must not wedge the queue: past the deadline we take the shot we
    // can get, which is the untextured render — but only for a genuinely broken asset.
    if (performance.now() > deadline) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

const cache = new Map();    // dex -> data URL, or null once we know there is no model for it
const pending = new Map();  // dex -> in-flight promise

// One holder is shared by every portrait, so the renders have to be strictly sequential:
// setPreviewModel clears the holder, and two overlapping calls would photograph each other's model.
let queue = Promise.resolve();

// Synchronous read for render paths. Returns the data URL if it is already cached, else null —
// callers draw a placeholder and re-render when requestPortrait resolves.
export function portraitFor(dex) {
  return cache.get(dex) || null;
}

// Render (or return the cached) portrait for `dex`. Resolves to a data URL, or null when the
// species has no Quest model.
export function requestPortrait(dex) {
  if (cache.has(dex)) return Promise.resolve(cache.get(dex));
  if (pending.has(dex)) return pending.get(dex);
  if (!hasModelForDex(dex)) { cache.set(dex, null); return Promise.resolve(null); }

  const job = queue.then(async () => {
    if (cache.has(dex)) return cache.get(dex);
    const r = ensureRig();
    const fitted = await setPreviewModel(r.holder, dex, 1.0);
    if (!fitted) { cache.set(dex, null); return null; }

    // Models are fitted by HEIGHT, so a wide flat species (Kabuto, Wailmer) comes out wider than
    // the frame. Measure what we actually got and shrink it to fit the box in both axes — the same
    // problem the catch minigame's encounter frame has.
    //
    // The holder's world matrix is flushed FIRST so the measurement includes PORTRAIT_YAW.
    // Box3.setFromObject walks down from the object it is given and takes its parent's matrixWorld
    // as it finds it, so without this the box is the model's unrotated footprint — and a turned
    // model is wider on screen than a square-on one (up to 1.41x for a long species), which is
    // exactly the case the shrink exists to catch.
    r.holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(fitted);
    const w = box.max.x - box.min.x;
    const limit = FRUSTUM * 2 * 0.92;
    const shrink = w > limit ? limit / w : 1;
    if (shrink < 1) fitted.scale.setScalar(shrink);
    // fitModel stands the model ON y=0, so lower it by half its own height to straddle the
    // camera's axis. Aiming the camera above the model instead is what cropped its feet off.
    fitted.position.y = -0.5 * shrink;

    await awaitTextures(fitted);
    const shot = renderToStage(r.holder, r.camera, 1);
    r.ctx.clearRect(0, 0, SIZE, SIZE);
    r.ctx.drawImage(shot.canvas, shot.sx, shot.sy, shot.sw, shot.sh, 0, 0, SIZE, SIZE);
    const url = r.canvas.toDataURL('image/png');
    cache.set(dex, url);
    return url;
  }).catch(() => { cache.set(dex, null); return null; });

  // The queue advances on the job either way, so one failed portrait cannot wedge the rest.
  queue = job.then(() => {}, () => {});
  pending.set(dex, job);
  job.then(() => pending.delete(dex), () => pending.delete(dex));
  return job;
}

// Warm a set of dex numbers, calling `onEach` as each one lands so the caller can redraw. Used by
// the bag: the party is known the moment the screen opens, and the portraits arrive a frame or two
// later without the screen having to wait on any of them.
export function preloadPortraits(dexList, onEach = null) {
  for (const dex of dexList) {
    if (cache.has(dex)) continue;
    requestPortrait(dex).then(url => { if (url && onEach) onEach(dex, url); });
  }
}
