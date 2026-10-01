// Shared mutable game state + the four localStorage-backed slices (settings, lifetime stats, the
// one saved run per mode, and the eggs and hatched partners that outlive every run).
//
// Permadeath is total: `state.run` is thrown away and rebuilt from scratch every run, so nothing
// in it persists. Two things outlive a run — `state.stats`, a historical record shown on the
// Pokedex/Stats screen, which never feeds back into gameplay or odds (confirmed decision); and
// `state.saves`, which holds the run you are currently IN so that closing the app does not end it.
// A save is not a retreat: read the header over SAVE_KEY for why that distinction holds.
import { CATALOG_BY_DEX, DAMAGE_BY_STAGE } from './data/pokemon-catalog.js';

export const MAX_PARTY = 6;
export const FLOORS_PER_RUN = 5;

// ---- The three run modes -----------------------------------------------------------------------
// 'classic' is the original run and the brief's: five floors, Giovanni on the fifth, and beating
// him WINS. 'easy' is classic with no shadow Pokemon — not one wild is generated aggressive, so
// nothing chases you and every wild encounter goes straight to the catch — and is otherwise the
// same five floors and the same Giovanni. 'endless' has no end — it keeps handing out floors until
// the party wipes, with Giovanni standing on every fifth one as a checkpoint boss rather than as
// the finish line.
//
// The mode is a property of the RUN (`state.run.runMode`), not a setting, because everything that
// reads it is deciding what the next floor looks like. Every mode keeps its own save slot and its
// own headline number on the mode-select cards. The order here is the cards' order on screen.
export const RUN_MODES = ['easy', 'classic', 'endless'];

// The two modes that are a fixed five floors and end on a Giovanni WIN. Asked in one place because
// "is this run finite" is the question beginRun, continueRun and advanceFloor all actually ask.
export const isFiveFloorMode = (runMode) => runMode === 'classic' || runMode === 'easy';
export const ENDLESS_BOSS_EVERY = 5;

// Damage comes straight from the design brief; HP is our own scale, tuned so a Basic starter
// survives a few hits from an early grunt but a Legendary is a real wall.
export const HP_BY_STAGE = { Basic: 30, Stage1: 50, Stage2: 70, Legendary: 90 };

// Build a live battle-ready Pokemon from a dex number. `hpScale` is the floor-difficulty knob
// used for enemy teams; the player's Pokemon always come in at 1.0.
export function makeMon(dex, { hpScale = 1, aggressive = false } = {}) {
  const c = CATALOG_BY_DEX.get(dex);
  if (!c) return null;
  const maxHp = Math.round(HP_BY_STAGE[c.stage] * hpScale);
  return {
    dex,
    name: c.name,
    types: c.types.slice(),
    stage: c.stage,
    evolvesInto: c.evolvesInto.slice(),
    dmg: DAMAGE_BY_STAGE[c.stage],
    maxHp,
    hp: maxHp,
    aggressive,
  };
}

// ---- Settings (music/SFX volume + control scheme) ----------------------------------------------
const SETTINGS_KEY = 'pmd-trr.settings.v1';
const DEFAULT_SETTINGS = { music: 0.55, sfx: 0.8, controls: 'joystick' }; // 'joystick' | 'tap'

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch { return { ...DEFAULT_SETTINGS }; }   // private mode / blocked storage: run on defaults
}

export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* ignore */ }
}

// ---- Lifetime stats (the persistent Pokedex/Stats screen) --------------------------------------
const STATS_KEY = 'pmd-trr.stats.v1';
const DEFAULT_STATS = {
  runsPlayed: 0,
  runsWon: 0,          // classic wins
  // Easy wins, counted apart from classic's. Folding them into runsWon would let the Classic card's
  // headline number be raised by winning the easier mode.
  easyRunsWon: 0,
  bestFloor: 0,
  // Endless keeps its own depth record. `bestFloor` above counts every mode and tops out at 5 in
  // classic, so it cannot answer "how deep have I ever gone" once Endless exists — and the Endless
  // card's headline number is exactly that question.
  endlessBestFloor: 0,
  giovanniDefeats: 0,
  gruntsDefeated: 0,
  pokemonCaught: 0,
  coinsFound: 0,      // lifetime coin total, across every run
  coinsSpent: 0,      // ... and how much of it went to Kecleon
  seenDex: [],      // every species encountered anywhere
  caughtDex: [],    // every species successfully caught
  winnerDex: [],    // species that were in the party for a Giovanni win
  // How MANY times, per species (dex -> count), for the Pokedex's per-Pokemon line. Added 2026-10-01,
  // after the three sets above, so a record from before then has a species in a set with no count —
  // dexCount() reads that as 1 rather than 0. What each one counts:
  //   seenCount    once per FLOOR it wanders (not once per copy), once per Team Rocket battle it is
  //                sent into, and once each time it is your partner, evolves into being, or hatches.
  //                A wild you bump into was already counted for its floor, so the encounter is not
  //                counted again.
  //   caughtCount  catches in the catch minigame. A partner you started with is OWNED (it is in
  //                caughtDex) but was not caught, so it does not count here.
  //   winCount     runs won with it standing in the party — once per run, however many you had.
  seenCount: {},
  caughtCount: {},
  winCount: {},
};

// Every array and object in the stats is copied, never shared with DEFAULT_STATS: a shallow spread
// alone left a first-time player's lists BEING the defaults' lists, so every species recorded was
// also written into DEFAULT_STATS.
function freshStats(saved = {}) {
  const s = { ...DEFAULT_STATS, ...saved };
  for (const k of ['seenDex', 'caughtDex', 'winnerDex']) s[k] = Array.isArray(s[k]) ? s[k].slice() : [];
  for (const k of ['seenCount', 'caughtCount', 'winCount']) {
    s[k] = s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) ? { ...s[k] } : {};
  }
  return s;
}

function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    return freshStats(raw ? JSON.parse(raw) : {});
  } catch { return freshStats(); }
}

export function saveStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(state.stats)); } catch { /* ignore */ }
}

// ---- Saved runs (one slot per mode) ------------------------------------------------------------
// PERMADEATH IS STILL TOTAL. This is not a checkpoint you can retreat to: the slot holds the run
// you are CURRENTLY in, so closing the app and coming back puts you where you were, and dying
// wipes it. You cannot reload a floor to undo a wipe, because the only write is on ARRIVAL at a
// floor and death clears the slot before anything can be written again.
//
// A snapshot is taken at the START of every floor and nowhere else. That choice is what keeps this
// small and honest: on arrival you have not opened a chest, moved a step or met anything, so the
// only things that describe your position are your party, your bag, your coins and which floor you
// are on. Mid-floor state — where you are standing, what the fog has revealed, which wilds are
// still about, which pickups are gone — is never written, and does not have to be.
//
// The consequence, and it is the honest one to state: CONTINUING REGENERATES THE FLOOR. The layout
// you get is a fresh one for the same floor number and theme, not the one you saw. Since the write
// happens before you have taken a step, that is very nearly invisible — but it is why the floor is
// not stored, and storing it would mean either persisting the whole cell grid or threading a seeded
// RNG through all of dungeon.js's generation.
//
// What is deliberately NOT saved:
//   - `attackBonus` / `attackBonusUntil` / `repelUntil`. All three are deadlines on
//     performance.now(), which restarts at 0 on a fresh page — a restored deadline would read as
//     far in the future and leave an X Attack or a Max Repel running forever. A timed buff does not
//     survive closing the app, and that is the correct answer rather than a limitation.
//   - `pendingCatch`. The swap-or-release prompt is always resolved before play resumes, so there
//     is never one outstanding at a floor boundary.
//   - `floor`. See above.
const SAVE_KEY = 'pmd-trr.saves.v1';

function loadSaves() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    // One slot per mode, and nothing else: a slot for a mode that no longer exists is dropped
    // rather than carried, so a rename in RUN_MODES cannot resurrect an unreadable save.
    const out = {};
    for (const m of RUN_MODES) out[m] = parsed?.[m] ?? null;
    return out;
  } catch { return Object.fromEntries(RUN_MODES.map(m => [m, null])); }
}

function writeSaves() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state.saves)); } catch { /* ignore */ }
}

// The snapshot. Party members are stored as `{dex, hp}` and NOT as whole objects: makeMon(dex)
// rebuilds name, types, stage, damage and maxHp from the catalog, so everything else in a mon is
// derived data that would only go stale if the catalog were edited under a save. HP is the one
// thing that is genuinely the run's, and `evolve()` already resets maxHp from HP_BY_STAGE, so a
// mon that evolved mid-run round-trips exactly.
export function saveRun(run) {
  if (!run) return;
  state.saves[run.runMode] = {
    runMode: run.runMode,
    floorNumber: run.floorIndex + 1,
    themeIds: run.themeIds.slice(),
    shopFloors: [...run.shopFloors],
    chanseyFloors: [...run.chanseyFloors],
    // How far the per-floor fixture rolls have got. It has to be in here: without it a restored run
    // would re-roll the fixtures for the floor it is standing on, which in classic means rolling
    // ENDLESS's schedule over a run that had already decided all five floors up front.
    fixturesThrough: run.fixturesThrough | 0,
    lastRandomShop: run.lastRandomShop ?? -10,
    party: run.party.map(m => ({ dex: m.dex, hp: m.hp })),
    bag: { ...run.bag },
    coins: run.coins,
    activeBall: run.activeBall,
    revives: run.revives,
    caught: run.caught,
    // Eggs found so far this run. They are the run's until it ends (see js/eggs.js), so they ride in
    // the snapshot like the bag does — and an egg picked up on a floor the app was then closed on is
    // lost with the rest of that floor, which is the same honest answer the bag gets.
    eggs: run.eggs | 0,
    savedAt: Date.now(),
  };
  writeSaves();
}

export function clearSave(runMode) {
  if (!(runMode in state.saves)) return;
  state.saves[runMode] = null;
  writeSaves();
}

// What the mode-select card needs to draw a "Continue" offer, or null when there is nothing to
// continue. Validated here rather than at the call site: a slot with no party in it is not a run
// anyone can go back to, and a hand-edited or half-written slot must not reach the renderer.
export function savedRunSummary(runMode) {
  const s = state.saves[runMode];
  if (!s || !Array.isArray(s.party) || s.party.length === 0) return null;
  const party = s.party.filter(m => m && Number.isFinite(m.dex));
  if (!party.length) return null;
  return {
    runMode,
    floorNumber: Math.max(1, s.floorNumber | 0),
    party: party.map(m => ({ dex: m.dex, hp: Math.max(0, m.hp | 0) })),
    // What the run has to show for itself so far. The card puts these under the team, because
    // "B14F with these six, 9 caught and 240 coins in hand" is a fuller answer to "do I want to go
    // back in" than the floor number alone — and all three are already in the snapshot.
    caught: Math.max(0, s.caught | 0),
    coins: Math.max(0, s.coins | 0),
    eggs: Math.max(0, s.eggs | 0),
    savedAt: s.savedAt || 0,
  };
}

// ---- Eggs (kept across runs) -------------------------------------------------------------------
// The one thing besides the lifetime record that outlives a run, and unlike the record it DOES feed
// back into play: a hatched Pokemon can be picked as the partner for any later run. See js/eggs.js
// for the rules; this is only the storage.
//   ready    eggs banked from finished runs, waiting on the Hatch Eggs screen
//   hatched  dex numbers already hatched, in the order they came out. An egg never repeats one.
// Its own key rather than part of the stats, but Erase Records clears both (see resetEggs).
const EGGS_KEY = 'pmd-trr.eggs.v1';

function loadEggs() {
  try {
    const raw = localStorage.getItem(EGGS_KEY);
    const p = raw ? JSON.parse(raw) : null;
    const hatched = Array.isArray(p?.hatched) ? p.hatched.filter(d => Number.isFinite(d)) : [];
    return { ready: Math.max(0, p?.ready | 0), hatched: [...new Set(hatched)] };
  } catch { return { ready: 0, hatched: [] }; }
}

export function saveEggs() {
  try { localStorage.setItem(EGGS_KEY, JSON.stringify(state.eggs)); } catch { /* ignore */ }
}

// Declared after the loaders on purpose: all four are called right here during module evaluation,
// so their consts have to exist first.
export const state = {
  mode: 'boot',        // set by main.js's setMode() state machine
  returnTo: 'title',   // where Glossary/Settings go "Back" to (title vs. pause)
  run: null,
  settings: loadSettings(),
  stats: loadStats(),
  saves: loadSaves(),
  eggs: loadEggs(),
};

export function resetStats() {
  state.stats = freshStats();
  saveStats();
}

// Erase Records' other half: every egg and every hatched partner, as if the game had never been
// played. "Every egg" includes the ones the live run and the saved runs are carrying — leaving those
// would bring eggs straight back the moment one of those runs ended. The saved runs themselves (party,
// floor, bag) are kept, as Erase Records has always kept them.
export function resetEggs() {
  state.eggs = { ready: 0, hatched: [] };
  saveEggs();
  if (state.run && RUN_MODES.includes(state.run.runMode)) state.run.eggs = 0;
  let touched = false;
  for (const m of RUN_MODES) {
    if (state.saves[m]?.eggs) { state.saves[m].eggs = 0; touched = true; }
  }
  if (touched) writeSaves();
}

// Push a dex number onto one of the stats lists, keeping it unique and sorted.
export function recordDex(listName, dex) {
  const list = state.stats[listName];
  if (!list || list.includes(dex)) return;
  list.push(dex);
  list.sort((a, b) => a - b);
}

// The per-species counters (see seenCount / caughtCount / winCount above), each paired with the set
// it implies — counting a sighting also registers the species as seen, and so on — so a caller
// cannot bump a count without the Pokedex knowing the species at all.
const COUNT_SET = { seenCount: 'seenDex', caughtCount: 'caughtDex', winCount: 'winnerDex' };

export function countDex(countName, dex) {
  const counts = state.stats[countName];
  if (!counts || dex == null) return;
  counts[dex] = (counts[dex] | 0) + 1;
  recordDex(COUNT_SET[countName], dex);
}

// What the Pokedex shows. A species in the set with no count is one recorded before the counts
// existed: it has happened at least once, so it reads 1, never 0.
export function dexCount(countName, dex) {
  const n = state.stats[countName]?.[dex] | 0;
  return n > 0 ? n : (state.stats[COUNT_SET[countName]]?.includes(dex) ? 1 : 0);
}
