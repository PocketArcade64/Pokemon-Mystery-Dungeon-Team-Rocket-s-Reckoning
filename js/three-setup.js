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

// ---- Small self-contained renderers for the DOM preview canvases -------------------------------
// Used by the starter-select and Pokedex screens for the rotating 3D model preview. Each gets its
// own WebGL context, matching how Rumble Run's roster screen worked.
export function createPreview(previewCanvas, { frustum = 1.5, background = null } = {}) {
  const r = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true, alpha: !background });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const s = new THREE.Scene();
  if (background !== null) s.background = new THREE.Color(background);
  s.add(new THREE.HemisphereLight(0xffffff, 0x6a6a88, 1.25));
  const dl = new THREE.DirectionalLight(0xfff6e6, 1.0);
  dl.position.set(-3, 5, 4);
  s.add(dl);
  const c = new THREE.OrthographicCamera(-frustum, frustum, frustum, -frustum, 0.01, 60);
  c.userData.frustum = frustum;
  c.position.set(0, 1.7, 4.4);
  c.lookAt(0, 0.75, 0);
  const holder = new THREE.Group();
  s.add(holder);

  function resize() {
    const w = previewCanvas.clientWidth || 1, h = previewCanvas.clientHeight || 1;
    r.setSize(w, h, false);
    const aspect = w / h;
    c.left = -frustum * aspect; c.right = frustum * aspect;
    c.top = frustum; c.bottom = -frustum;
    c.updateProjectionMatrix();
  }
  resize();
  return { renderer: r, scene: s, camera: c, holder, resize, render: () => { resize(); r.render(s, c); } };
}
