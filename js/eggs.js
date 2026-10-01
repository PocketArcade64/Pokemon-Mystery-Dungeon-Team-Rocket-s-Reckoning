// Eggs: found on dungeon floors, banked when a run ends, hatched from the title screen into a
// partner that any later run can start with. The storage is state.eggs (see state.js); this module
// is every rule about it, so main.js, dungeon generation and the UI all ask the same questions here.
//
// THE LIFECYCLE
//   1. A floor may lay ONE egg down, in place of one of its presents (EGG_CHANCE per present, never
//      more than one per floor — see generateFloor's `eggChance`).
//   2. Picking it up puts it in the RUN (`run.eggs`), which rides in the floor-arrival snapshot like
//      the bag does. An egg is not ready to hatch while the run it was found in is still going.
//   3. When the run ends — a win, a wipe, an abandon, or a saved run being thrown away by starting a
//      new one in its mode — its eggs are BANKED into state.eggs.ready. They survive a loss on
//      purpose: Endless can only ever end in one, and an egg that a loss took away would mean Endless
//      could never hatch anything.
//   4. Hatching turns one banked egg into a dex number in state.eggs.hatched, and that Pokemon is
//      then offered on starter select behind the egg button.
//
// WHAT AN EGG CAN HOLD: a Basic or a Legendary, never a Stage 1 or Stage 2 — and never one already
// hatched, so every egg is a new partner. That makes the pool FINITE, and the spawn gate below is
// what keeps a found egg from ever being one the pool cannot fill.
import { state, saveEggs, saveStats, recordDex, RUN_MODES } from './state.js';
import { POKEMON_CATALOG, CATALOG_BY_DEX } from './data/pokemon-catalog.js';
import { hasModelForDex } from './models.js';

// The chance any one present on a floor is an egg instead. A floor lays 10 + 3n presents (13 on B1F,
// 25 on B5F) and stops at the first egg, so this works out to roughly a 49% chance of an egg on B1F
// rising to about 72% on B5F — two or three eggs across a five-floor run.
export const EGG_CHANCE = 1 / 20;

// Everything an egg can hold, in dex order. A species without a Quest model is left out for the same
// reason the wild pools leave it out: a hatch has to have something to show coming out of the shell.
export const EGG_POOL = POKEMON_CATALOG
  .filter(p => (p.stage === 'Basic' || p.stage === 'Legendary') && hasModelForDex(p.dex))
  .map(p => p.dex);

const POOL_SET = new Set(EGG_POOL);

export function eggsReady() { return state.eggs.ready; }

// The partners unlocked so far, in dex order for display. Filtered against the catalog so a dex that
// has since left it cannot reach starter select with no data behind it.
export function hatchedDex() {
  return state.eggs.hatched.filter(d => CATALOG_BY_DEX.has(d)).sort((a, b) => a - b);
}

function unhatched() {
  const got = new Set(state.eggs.hatched);
  return EGG_POOL.filter(d => !got.has(d));
}

// How many of the pool are hatched, against how many it holds — the progress line on both egg
// screens. Counted against the pool rather than `hatched.length`, so the two numbers always agree.
export function hatchProgress() {
  const got = new Set(state.eggs.hatched);
  return { have: EGG_POOL.filter(d => got.has(d)).length, total: EGG_POOL.length };
}

// Every egg that exists and has not been hatched yet, wherever it is: banked, held by the run being
// played, or sitting in another mode's saved run. The live run is counted from `run.eggs` rather than
// from its own save slot, because the slot was written on arrival and an egg picked up since is not
// in it yet.
export function eggsOutstanding(run = state.run) {
  const live = run && RUN_MODES.includes(run.runMode) ? run.runMode : null;
  let n = state.eggs.ready;
  for (const m of RUN_MODES) if (m !== live) n += Math.max(0, state.saves[m]?.eggs | 0);
  if (live) n += Math.max(0, run.eggs | 0);
  return n;
}

// THE SPAWN GATE. An egg may only be laid while there are more Pokemon left to hatch than there are
// eggs already out there to hatch them — so every egg in existence is guaranteed a new Pokemon, and
// once the eggs on hand would cover the whole pool, floors stop laying them at all.
export function eggCanSpawn(run = state.run) {
  return unhatched().length > eggsOutstanding(run);
}

// The run is over: whatever eggs it found are now ready to hatch. Returns how many were banked, which
// the end screen reports. Zeroes the run's count, so a second call (there is no such path, but the run
// object lives on until the next one replaces it) cannot bank the same eggs twice.
export function bankRunEggs(run) {
  const n = Math.max(0, run?.eggs | 0);
  if (!n) return 0;
  run.eggs = 0;
  state.eggs.ready += n;
  saveEggs();
  return n;
}

// A saved run is about to be discarded (a New Run in its mode). Its eggs were found fairly, so they
// are banked rather than thrown away with it — the same answer an abandoned run gets.
export function bankSavedEggs(runMode) {
  const n = Math.max(0, state.saves[runMode]?.eggs | 0);
  if (!n) return 0;
  state.eggs.ready += n;
  saveEggs();
  return n;
}

// Decide what the next egg holds, WITHOUT spending it. The hatch screen asks this when it opens, so
// the Pokemon's model can load while the egg is being tapped and be ready the instant the shell
// breaks. Nothing is written until commitHatch — backing out of the screen leaves the egg whole, and
// the next open rolls again. Uniform over what is left: a Legendary is exactly as likely as any Basic.
export function rollHatch() {
  if (state.eggs.ready <= 0) return null;
  const left = unhatched();
  if (!left.length) return null;
  return left[Math.floor(Math.random() * left.length)];
}

// The shell has broken: spend the egg and unlock `dex`. Refuses a dex that is not in the pool or is
// already hatched, so nothing can hatch a Stage 2 or a duplicate. A hatched Pokemon counts as SEEN in
// the Pokedex; it becomes "caught" the first time it is taken into a run, the same way a starter is.
export function commitHatch(dex) {
  if (state.eggs.ready <= 0 || !POOL_SET.has(dex) || state.eggs.hatched.includes(dex)) return false;
  state.eggs.ready -= 1;
  state.eggs.hatched.push(dex);
  saveEggs();
  recordDex('seenDex', dex);
  saveStats();
  return true;
}

// The debug menu's egg button. Capped by the same gate the floors use, so a debug egg is never one
// that could hatch nothing. Returns how many were actually added.
export function debugAddEggs(n) {
  const room = Math.max(0, unhatched().length - eggsOutstanding());
  const add = Math.min(n, room);
  if (add > 0) { state.eggs.ready += add; saveEggs(); }
  return add;
}
