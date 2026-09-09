// Renderer / scene / camera bootstrap, plus the iOS-safe viewport sizing.
//
// Camera matches Rumble Run's look exactly — an ORTHOGRAPHIC diagonal-overhead rig, not a
// perspective one. The one deliberate difference: Rumble Run is a lane runner so it only follows
// the player's Z; this game is free-roam, so the camera follows BOTH X and Z, damped.
import * as THREE from 'three';

export const FRUSTUM_SIZE = 10;
export const CAM_OFFSET = new THREE.Vector3(-11, 13, -11);

export const canvas = document.getElementById('game-canvas');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

export const scene = new THREE.Scene();
export const camera = new THREE.OrthographicCamera(
  -FRUSTUM_SIZE, FRUSTUM_SIZE, FRUSTUM_SIZE, -FRUSTUM_SIZE, 0.1, 200,
);

// Lighting rig. Colors get re-tinted per floor theme by dungeon.js via applyThemeLighting().
export const hemiLight = new THREE.HemisphereLight(0xfff6e0, 0x3a3a52, 1.0);
scene.add(hemiLight);

export const dirLight = new THREE.DirectionalLight(0xfff4dc, 1.05);
dirLight.position.set(-6, 16, -6);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
dirLight.shadow.camera.left = -20; dirLight.shadow.camera.right = 20;
dirLight.shadow.camera.top = 20; dirLight.shadow.camera.bottom = -20;
// Without this, hard voxel corners on the Quest models catch thin bright self-shadow leak lines.
dirLight.shadow.normalBias = 0.05;
scene.add(dirLight);
scene.add(dirLight.target);

// The camera target the follow logic damps toward, in world space.
const camTarget = new THREE.Vector3();
let camInit = false;

export function followCamera(x, z, dt) {
  if (!camInit) { camTarget.set(x, 0, z); camInit = true; }
  const lambda = 6;
  camTarget.x = THREE.MathUtils.damp(camTarget.x, x, lambda, dt);
  camTarget.z = THREE.MathUtils.damp(camTarget.z, z, lambda, dt);
  camera.position.copy(camTarget).add(CAM_OFFSET);
  camera.lookAt(camTarget);
  // Flush the world matrix here rather than leaving it to the renderer: tap-to-move un-projects
  // through this camera, and a tap that arrives before the next render would otherwise raycast
  // through a stale matrix and land somewhere arbitrary.
  camera.updateMatrixWorld(true);
  // Keep the shadow frustum centred on the player so shadows never pop out at the map edges.
  dirLight.position.set(camTarget.x - 6, 16, camTarget.z - 6);
  dirLight.target.position.copy(camTarget);
  dirLight.target.updateMatrixWorld();
}

export function resetCameraFollow() { camInit = false; }

// ---- Viewport sizing ---------------------------------------------------------------------------
// Measure the canvas's CSS box (sized with 100lvh), NEVER window.innerHeight — innerHeight
// under-reports by the home-indicator zone in iOS standalone mode, which shows up as a dead band
// along the bottom of the screen.
const extraCameras = new Set();
export function registerCamera(cam) { extraCameras.add(cam); }
export function unregisterCamera(cam) { extraCameras.delete(cam); }

export function onViewportChange() {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  for (const cam of [camera, ...extraCameras]) {
    if (cam.isOrthographicCamera) {
      const f = cam.userData.frustum || FRUSTUM_SIZE;
      cam.left = -f * aspect; cam.right = f * aspect;
      cam.top = f; cam.bottom = -f;
    } else {
      cam.aspect = aspect;
    }
    cam.updateProjectionMatrix();
  }
}

window.addEventListener('resize', onViewportChange);
// iOS fires orientationchange before it has finished relaying out — defer two frames.
window.addEventListener('orientationchange', () => requestAnimationFrame(() => requestAnimationFrame(onViewportChange)));
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);
// iOS standalone settles its viewport shortly after launch without always firing `resize`.
window.addEventListener('load', () => setTimeout(onViewportChange, 300));
onViewportChange();

// ---- Context loss ------------------------------------------------------------------------------
// A lost context used to be indistinguishable from the game being broken: models rendered as
// untextured blocks, textures flashed, and returning to the title fixed nothing because the
// context was gone for the life of the page. Three.js re-initialises its own state on restore, but
// only if the loss event is cancelled — otherwise the browser never offers a restore at all.
//
// The real defence is not holding many contexts in the first place (see js/modelstage.js, which
// exists to keep the page at two). This is the backstop, and it logs loudly so the cause is
// visible rather than being guessed at from the symptoms.
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  console.error('[three-setup] WebGL context LOST on the main canvas - the dungeon will not draw ' +
                'until it is restored. This is usually too many live contexts or GPU memory.');
}, false);

canvas.addEventListener('webglcontextrestored', () => {
  console.warn('[three-setup] WebGL context restored; re-uploading GPU resources.');
  onViewportChange();
}, false);

// There is deliberately no createPreview() any more. It made a WebGL context per DOM preview
// canvas, and at four of those plus the dungeon's the page was over the limit that browsers
// enforce by killing the OLDEST context. Model views now go through createModelView() in
// js/modelstage.js, which shares one offscreen context between all of them.
