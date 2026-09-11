// OBJ/MTL loading pipeline for the Pokemon Quest roster and the standalone ball models.
//
// The Quest roster is OBJ + MTL + PNG only — static voxel meshes, no skeletons and no animation —
// so a plain .clone() is safe for per-instance copies (Rumble Run needed SkeletonUtils only for
// its FBX rips). Everything else in here is the set of render fixes carried over from Rumble Run's
// loadModelOrNull, which are what make these models read as clean flat voxels instead of
// speckled ones. Each fix is commented with the artifact it kills.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { QUEST_DEX } from './data/questdex.js';

export const QB = 'Pokemon Quest 3D Models/';

// Folder/file names contain spaces, '#' and 'e' — every segment has to be URL-encoded or the
// fetch 404s (a bare '#' would be read as a fragment).
export function encodePath(p) {
  return p.split('/').map(seg => encodeURIComponent(seg)).join('/');
}

// Shrink every triangle's UVs slightly toward its own centroid. Quest models map each flat face
// onto a solid-color patch in a shared atlas with white gutters between patches; when a model
// renders small, samples land on a patch border and pick up the gutter — the white specks along
// cube edges. The faces are solid colors, so pulling samples inward costs nothing visually.
function insetUVs(root, k = 0.06) {
  root.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const uv = o.geometry.attributes.uv;
    if (!uv || o.geometry.index) return;   // OBJ loads non-indexed; skip anything else
    for (let i = 0; i < uv.count; i += 3) {
      const cu = (uv.getX(i) + uv.getX(i + 1) + uv.getX(i + 2)) / 3;
      const cv = (uv.getY(i) + uv.getY(i + 1) + uv.getY(i + 2)) / 3;
      for (let j = i; j < i + 3; j++) {
        uv.setXY(j, uv.getX(j) + (cu - uv.getX(j)) * k, uv.getY(j) + (cv - uv.getY(j)) * k);
      }
    }
    uv.needsUpdate = true;
  });
}

const modelCache = new Map();

// Loads an OBJ (with its sibling MTL when present) and applies the Quest render fixes.
// Resolves to null rather than rejecting, so a missing model degrades to a colored placeholder
// instead of taking the frame loop down.
export function loadModelOrNull(path) {
  if (!path) return Promise.resolve(null);
  if (modelCache.has(path)) return modelCache.get(path);

  const slash = path.lastIndexOf('/');
  const rawDir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const rawFile = slash >= 0 ? path.slice(slash + 1) : path;
  const encDir = encodePath(rawDir);
  const encFile = encodeURIComponent(rawFile);
  const mtlName = rawFile.replace(/\.obj$/i, '.mtl');

  const objLoad = (mats) => {
    const l = new OBJLoader().setPath(encDir);
    if (mats) l.setMaterials(mats);
    return l.loadAsync(encFile);
  };

  const p = new MTLLoader().setPath(encDir).setResourcePath(encDir)
    .loadAsync(encodeURIComponent(mtlName))
    .then(mtl => { mtl.preload(); return objLoad(mtl); })
    .catch(() => objLoad(null))      // no .mtl, or it failed: load untextured geometry
    .then(model => {
      insetUVs(model);
      model.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = false;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(mm => {
          if (!mm) return;
          // A black diffuse alongside a texture multiplies the map to black; white it out.
          if (mm.map && mm.color && mm.color.r < 0.05 && mm.color.g < 0.05 && mm.color.b < 0.05) {
            mm.color.setRGB(1, 1, 1);
          }
          // THE white-specks fix: Quest .mtl files ship "Ks 1 1 1 / Ns 100" — full-strength pure
          // white specular. On big flat voxel faces under a strong directional light that fires
          // tight white glints along every cube edge and corner. Zero it out.
          if (mm.specular) mm.specular.setRGB(0, 0, 0);
          if (mm.map) {
            // Tiny palette textures: linear filtering blends neighboring palette pixels at UV
            // borders, showing as white flecks. Nearest + no mipmaps + edge clamp keeps every
            // face a flat, clean color at any render size.
            mm.map.magFilter = THREE.NearestFilter;
            mm.map.minFilter = THREE.NearestFilter;
            mm.map.generateMipmaps = false;
            mm.map.wrapS = mm.map.wrapT = THREE.ClampToEdgeWrapping;
            mm.map.colorSpace = THREE.SRGBColorSpace;
            mm.map.needsUpdate = true;
          }
        });
      });
      return model;
    })
    .catch(err => {
      console.warn(`[models] placeholder for ${path}: ${(err && err.message) || err}`);
      return null;
    });

  modelCache.set(path, p);
  return p;
}

// Recenter on the x/z bbox of the model's BASE (bottom 40% of its height) rather than the whole
// mesh: voxel ears, tails and hats overhang one side and drag the full-bbox center off the
// creature's actual footprint, which makes it stand visibly off-centre on its tile.
function recenterOnBase(obj) {
  obj.updateMatrixWorld(true);
  const full = new THREE.Box3().setFromObject(obj);
  const cut = full.min.y + (full.max.y - full.min.y) * 0.4;
  const base = new THREE.Box3().makeEmpty();
  const v = new THREE.Vector3();
  obj.traverse(o => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.y <= cut) base.expandByPoint(v);
    }
  });
  const c = base.isEmpty() ? full.getCenter(new THREE.Vector3()) : base.getCenter(new THREE.Vector3());
  return { x: -c.x, z: -c.z, minY: full.min.y, height: Math.max(full.max.y - full.min.y, 0.001) };
}

// Scale a freshly cloned model to `targetHeight` world units and sit it with its feet at y=0,
// centred on its base footprint. Returns a wrapper Group whose origin is that footprint centre.
//
// `strip` removes matching child objects BEFORE anything is measured — the order matters. The
// standalone ball models ship a display pedestal (object "bd<Name>Model_Base"), and a ball in
// flight must not be carrying its shop stand around; stripping it after the fit would leave the
// ball scaled and offset for a bounding box it no longer has.
function fitModel(model, targetHeight, { strip = null } = {}) {
  const wrap = new THREE.Group();
  const m = model.clone(true);
  if (strip) {
    for (const child of [...m.children]) if (strip.test(child.name || '')) m.remove(child);
  }
  const info = recenterOnBase(m);
  const s = targetHeight / info.height;
  m.scale.setScalar(s);
  m.position.set(info.x * s, -info.minY * s, info.z * s);
  wrap.add(m);
  return wrap;
}

// ---- Quest roster lookup -----------------------------------------------------------------------
// questdex.js carries costume/regional variants as independent entries sharing a dex number
// (e.g. Pikachu and "Pikachu (Ash Cap)"), so pick the plain base form: its id is exactly
// "q" + 4-digit dex with no variant suffix. Fall back to the first entry for that dex.
const isBaseId = (id) => /^q\d{4}$/.test(id);
const questByDex = new Map();
for (const e of QUEST_DEX) {
  const cur = questByDex.get(e.d);
  if (!cur || (isBaseId(e.id) && !isBaseId(cur.id))) questByDex.set(e.d, e);
}

export function questEntryForDex(dex) { return questByDex.get(dex) || null; }

export function modelPathForDex(dex) {
  const e = questEntryForDex(dex);
  return e ? QB + e.o : null;
}

export function hasModelForDex(dex) { return questByDex.has(dex); }

// ---- Instance factory --------------------------------------------------------------------------
// Returns a Group RIGHT NOW containing a placeholder block, and hot-swaps in the real model when
// it finishes loading. Callers position/rotate the returned Group and never wait on a promise, so
// dungeon population never stalls the frame loop.
const PLACEHOLDER_COLOR = 0x8a8fa8;

// `onReady` fires once the real model has replaced the placeholder. The catch minigame needs it:
// models are fitted by HEIGHT, so a wide, flat species (Kabuto, Wailmer) comes out far wider than
// it is tall and overflows the encounter frame — and there is no way to know how wide until the
// model is actually loaded and measured.
export function createMonObject(dex, { height = 1.0, tint = PLACEHOLDER_COLOR, onReady = null } = {}) {
  const group = new THREE.Group();
  group.userData.shared = true;
  const ph = new THREE.Mesh(
    new THREE.BoxGeometry(height * 0.6, height, height * 0.6),
    new THREE.MeshStandardMaterial({ color: tint }),
  );
  ph.position.y = height / 2;
  ph.castShadow = true;
  group.add(ph);
  group.userData.ready = false;

  const path = modelPathForDex(dex);
  loadModelOrNull(path).then(model => {
    if (!model || group.userData.disposed) return;
    group.remove(ph);
    ph.geometry.dispose(); ph.material.dispose();
    group.add(fitModel(model, height));
    group.userData.ready = true;
    onReady?.(group);
  });
  return group;
}

// Standalone ball models, keyed by the item ids in js/data/items.js.
export const BALL_MODEL_PATHS = {
  'poke-ball': QB + 'Poké Ball Model/bdPokeBallModel.obj',
  'great-ball': QB + 'Great Ball Model/bdGreatBallModel.obj',
  'ultra-ball': QB + 'Ultra Ball Model/bdUltraBallModel.obj',
  'master-ball': QB + 'Master Ball Model/bdMasterBallModel.obj',
  'premier-ball': QB + 'Premier Ball Model/bdPremierBallModel.obj',
};

// ---- Models that are not part of the Quest roster ----------------------------------------------
// These four came out of the old project's non-Quest rips and live under 'Extra 3D Models/' rather
// than alongside the Quest set, because they are not Quest models and do not follow its naming.
// The folder names are plain ASCII with no leading '#', unlike the Quest folders — see the
// .nojekyll note in HANDOFF.md for why that matters on GitHub Pages.
//
// The gift box and the three coins shipped as .smd/.dae only, and the loader here is OBJ+MTL, so
// they were converted to OBJ offline. Kecleon already had a clean OBJ.
export const XB = 'Extra 3D Models/';

// Every floor pickup that is not a ball is a wrapped present, exactly as in Mystery Dungeon.
// Two materials: a cream carton (box.png) and the red ribbon and bow (obj_frame_red.png).
export const GIFT_BOX_MODEL = XB + 'Gift Box/giftbox.obj';

// The shopkeeper. Kecleon (dex 352) is NOT in the Quest roster or POKEMON_CATALOG, so he is
// deliberately reached by path rather than through modelPathForDex() — he is an NPC, never a
// catchable species, and giving him a catalog entry would put him in the wild spawn pools.
export const KECLEON_MODEL = XB + 'Kecleon/Kecleon.obj';

// Keyed by the coin ids in js/data/items.js, the same way BALL_MODEL_PATHS is keyed by item id.
export const COIN_MODEL_PATHS = {
  'coin-silver': XB + 'Poke Coin Silver/poke_coin_silver.obj',
  'coin-gold': XB + 'Poke Coin Gold/poke_coin_gold.obj',
  'coin-large': XB + 'Poke Coin Large/poke_coin_large.obj',
};

// Generic "load this exact path and fit it to a height" factory, for the models above. Same
// placeholder-then-hot-swap contract as createMonObject so a caller never waits on a promise.
export function createModelObject(path, { height = 0.5, tint = PLACEHOLDER_COLOR, onReady = null } = {}) {
  const group = new THREE.Group();
  group.userData.shared = true;
  const ph = new THREE.Mesh(
    new THREE.BoxGeometry(height * 0.7, height, height * 0.7),
    new THREE.MeshStandardMaterial({ color: tint }),
  );
  ph.position.y = height / 2;
  ph.castShadow = true;
  group.add(ph);
  group.userData.ready = false;

  loadModelOrNull(path).then(model => {
    if (!model || group.userData.disposed) return;
    group.remove(ph);
    ph.geometry.dispose(); ph.material.dispose();
    group.add(fitModel(model, height));
    group.userData.ready = true;
    onReady?.(group);
  });
  return group;
}

// `onReady` fires once the real model has replaced the placeholder. Anything a caller sets on the
// group's meshes — renderOrder, castShadow — is set on the PLACEHOLDER only if it is applied at
// call time, because the swap happens a load later; the catch minigame needs both re-applied or
// the thrown ball renders behind the depthTest-off capture rings.
export function createBallObject(itemId, { size = 0.42, onReady = null } = {}) {
  const group = new THREE.Group();
  group.userData.shared = true;
  const ph = new THREE.Mesh(
    new THREE.SphereGeometry(size / 2, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xe5453b }),
  );
  ph.position.y = size / 2;
  group.add(ph);

  loadModelOrNull(BALL_MODEL_PATHS[itemId] || BALL_MODEL_PATHS['poke-ball']).then(model => {
    if (!model || group.userData.disposed) return;
    group.remove(ph);
    ph.geometry.dispose(); ph.material.dispose();
    group.add(fitModel(model, size, { strip: /_Base$/i }));
    group.userData.ready = true;
    onReady?.(group);
  });
  return group;
}

// Warm the cache for a set of dex numbers (starter trio, boss team) so they pop in without a
// visible placeholder beat. Fire-and-forget.
export function preloadDex(dexList) {
  for (const d of dexList) loadModelOrNull(modelPathForDex(d));
}

// Warm the floor-pickup models. A floor now scatters 15+ balls, a dozen presents and up to
// seventeen coins, all created in one burst by buildFloor; without this the first second of every
// floor is a field of placeholder blocks.
export function preloadPickupModels() {
  loadModelOrNull(GIFT_BOX_MODEL);
  for (const p of Object.values(COIN_MODEL_PATHS)) loadModelOrNull(p);
  for (const id of ['poke-ball', 'great-ball', 'ultra-ball']) loadModelOrNull(BALL_MODEL_PATHS[id]);
}

// Detach an instance from the scene. Deliberately does NOT dispose geometry or materials:
// .clone() shares both with the cached source model, so disposing them here would blank out every
// future instance of that species. The `disposed` flag also stops an in-flight load from
// hot-swapping a model into a group that is already gone.
export function disposeObject(group) {
  if (!group) return;
  group.userData.disposed = true;
  group.parent?.remove(group);
}

// A rotating-preview helper for the starter-select / Pokedex / shop panels: loads the model at a
// fixed display height into the given holder Group, clearing whatever was there.
//
// `explicitPath` bypasses the dex lookup, for the models that have no dex number to look up —
// Kecleon in the shop is not in the Quest roster or POKEMON_CATALOG.
export function setPreviewModel(holder, dex, height = 1.6, explicitPath = null) {
  while (holder.children.length) holder.remove(holder.children[0]);
  const path = explicitPath || modelPathForDex(dex);
  const token = (holder.userData.token = (holder.userData.token || 0) + 1);
  return loadModelOrNull(path).then(model => {
    if (!model || holder.userData.token !== token) return null;
    const fitted = fitModel(model, height);
    holder.add(fitted);
    return fitted;
  });
}
