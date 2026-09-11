// ONE offscreen WebGL context, shared by every model view that is not the dungeon itself.
//
// WHY THIS EXISTS. A browser allows a page only a small number of live WebGL contexts — on iOS it
// is single digits — and when the cap is passed it silently KILLS THE OLDEST ONE. If that is the
// dungeon's own renderer, the game keeps running while drawing nothing: models come out as
// untextured placeholder blocks, textures flash, and no amount of returning to the title fixes it
// because the context is gone for the life of the page. Only relaunching the app clears it.
//
// The game used to hold a context per model view: the dungeon, the starter-select preview, the
// Pokedex preview, both battle fighters, and the portrait renderer — six. Now it holds two: the
// dungeon's, and this one. Every DOM-facing model view is a plain 2D canvas that this stage renders
// into and BLITS to, so adding another view from here on costs nothing.
//
// HOW THE BLIT WORKS. The stage renders at a fixed STAGE_PX square, so its drawing buffer is
// allocated exactly once — resizing a WebGL canvas per frame reallocates that buffer and is its own
// source of GPU churn. A view narrower or shorter than square gets a viewport of its own aspect
// inside that square, and only that sub-rect is blitted. WebGL's origin is the BOTTOM-left of the
// canvas while canvas-2D's is the top-left, which is why the source rect's `sy` counts back from
// STAGE_PX rather than being 0.
import * as THREE from 'three';

const STAGE_PX = 512;      // generous for every view here; the two battle fighters are ~176 CSS px

let stage = null;

function ensureStage() {
  if (stage) return stage;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = STAGE_PX;
  // preserveDrawingBuffer keeps the rendered frame readable after the draw call returns, which both
  // the blit and the portrait cache's toDataURL depend on. Without it some drivers hand back an
  // already-cleared buffer.
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);          // STAGE_PX already IS the pixel size
  renderer.setClearColor(0x000000, 0);

  // The lighting rig the old per-view previews each carried a copy of.
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6a6a88, 1.25));
  const dl = new THREE.DirectionalLight(0xfff6e6, 1.0);
  dl.position.set(-3, 5, 4);
  scene.add(dl);

  stage = { canvas, renderer, scene };
  return stage;
}

// Render `holder` through `camera` at the given aspect ratio, and return the stage canvas plus the
// source rect to blit out of it. Holders are added and removed around the single render call, so
// views never see each other's models.
export function renderToStage(holder, camera, aspect) {
  const s = ensureStage();
  const a = aspect > 0 ? aspect : 1;
  const vw = a >= 1 ? STAGE_PX : Math.max(1, Math.round(STAGE_PX * a));
  const vh = a >= 1 ? Math.max(1, Math.round(STAGE_PX / a)) : STAGE_PX;

  if (camera.isOrthographicCamera) {
    const f = camera.userData.frustum ?? 1;
    camera.left = -f * a; camera.right = f * a;
    camera.top = f; camera.bottom = -f;
    camera.updateProjectionMatrix();
  } else {
    camera.aspect = a;
    camera.updateProjectionMatrix();
  }

  // The scissor is what confines the clear to this view's box; without it a tall view would be
  // wiped by the next short one.
  s.renderer.setViewport(0, 0, vw, vh);
  s.renderer.setScissor(0, 0, vw, vh);
  s.renderer.setScissorTest(true);
  s.scene.add(holder);
  s.renderer.render(s.scene, camera);
  s.scene.remove(holder);

  return { canvas: s.canvas, sx: 0, sy: STAGE_PX - vh, sw: vw, sh: vh };
}

// A model view backed by a plain 2D canvas in the DOM. Drop-in for what createPreview used to
// return — `.holder` to put a model in and spin, `.render()` to draw a frame — but it costs no
// WebGL context of its own.
// Radians of yaw per CSS pixel of drag. Straight from Rumble Run's Pokedex preview, which is the
// feel this is meant to match: about 57 px of travel for a quarter turn, so a thumb-width flick
// turns a model far enough to see its side and a full sweep of the screen goes most of the way
// round.
const DRAG_RADIANS_PER_PX = 0.013;

export function createModelView(targetCanvas, {
  frustum = 1.5, camY = 1.7, camZ = 4.4, lookY = 0.75, draggable = false,
} = {}) {
  const ctx = targetCanvas.getContext('2d');
  const holder = new THREE.Group();

  const camera = new THREE.OrthographicCamera(-frustum, frustum, frustum, -frustum, 0.01, 60);
  camera.userData.frustum = frustum;
  camera.position.set(0, camY, camZ);
  camera.lookAt(0, lookY, 0);

  function render() {
    const cw = targetCanvas.clientWidth, chh = targetCanvas.clientHeight;
    if (!cw || !chh) return;                  // laid out but not yet visible: nothing to draw into
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.max(1, Math.round(cw * dpr));
    const bh = Math.max(1, Math.round(chh * dpr));
    // Assigning width/height also clears the canvas, so only do it on a real size change.
    if (targetCanvas.width !== bw || targetCanvas.height !== bh) {
      targetCanvas.width = bw; targetCanvas.height = bh;
    } else {
      ctx.clearRect(0, 0, bw, bh);
    }
    const r = renderToStage(holder, camera, bw / bh);
    ctx.drawImage(r.canvas, r.sx, r.sy, r.sw, r.sh, 0, 0, bw, bh);
  }

  const view = { holder, camera, render, resize: render, dragging: false };

  // DRAG TO SPIN, as Rumble Run's Pokedex does it: while a finger is down the yaw follows it, and
  // on release the caller's idle spin picks up from wherever it was left. There is no snap-back
  // and no inertia — `holder.rotation.y` is the only state, so releasing mid-turn simply leaves it
  // there. The caller owns the idle spin and is responsible for pausing it on `view.dragging`
  // (see updatePreviews); doing it here would mean this module knowing each view's spin rate.
  //
  // The delta is tracked from `clientX` rather than read off `e.movementX`. Rumble Run used
  // movementX, but this game is built for a phone first, and movementX is a MouseEvent property
  // that touch-derived pointer events do not reliably populate on iOS Safari — there it reads 0
  // and the model never turns. A tracked delta behaves identically under a mouse.
  if (draggable) {
    // The page is `touch-action: none` globally, but say it here too: this is the one element whose
    // behaviour depends on it, and it must not start a scroll or a pinch instead of a drag.
    targetCanvas.style.touchAction = 'none';
    targetCanvas.style.cursor = 'grab';
    let lastX = 0;
    targetCanvas.addEventListener('pointerdown', (e) => {
      view.dragging = true;
      lastX = e.clientX;
      targetCanvas.style.cursor = 'grabbing';
      // Capture, so a drag that wanders off the small canvas keeps turning the model instead of
      // stopping dead at the edge.
      try { targetCanvas.setPointerCapture(e.pointerId); } catch { /* not capturable: no matter */ }
    });
    targetCanvas.addEventListener('pointermove', (e) => {
      if (!view.dragging) return;
      holder.rotation.y += (e.clientX - lastX) * DRAG_RADIANS_PER_PX;
      lastX = e.clientX;
    });
    const endDrag = () => {
      view.dragging = false;
      targetCanvas.style.cursor = 'grab';
    };
    targetCanvas.addEventListener('pointerup', endDrag);
    targetCanvas.addEventListener('pointercancel', endDrag);
    // A pointerup that lands outside the canvas after capture was lost would otherwise leave the
    // view stuck in `dragging` and the idle spin switched off for good.
    targetCanvas.addEventListener('lostpointercapture', endDrag);
  }

  return view;
}
