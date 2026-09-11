// Shared mutable game state + the two localStorage-backed slices (settings and lifetime stats).
//
// Permadeath is total: `state.run` is thrown away and rebuilt from scratch every run, so nothing
// in it persists. The ONLY thing that survives a run is `state.stats` — a historical record shown
// on the Pokedex/Stats screen. It never feeds back into gameplay or odds (confirmed decision).
import { CATALOG_BY_DEX, DAMAGE_BY_STAGE } from './data/pokemon-catalog.js';

export const MAX_PARTY = 6;
export const FLOORS_PER_RUN = 5;

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
  runsWon: 0,
  bestFloor: 0,
  giovanniDefeats: 0,
  gruntsDefeated: 0,
  pokemonCaught: 0,
  coinsFound: 0,      // lifetime coin total, across every run
  coinsSpent: 0,      // ... and how much of it went to Kecleon
  seenDex: [],      // every species encountered anywhere
  caughtDex: [],    // every species successfully caught
  winnerDex: [],    // species that were in the party for a Giovanni win
};

function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    return raw ? { ...DEFAULT_STATS, ...JSON.parse(raw) } : { ...DEFAULT_STATS };
  } catch { return { ...DEFAULT_STATS }; }
}

export function saveStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(state.stats)); } catch { /* ignore */ }
}

// Declared after the loaders on purpose: both are called right here during module evaluation, so
// their consts have to exist first.
export const state = {
  mode: 'boot',        // set by main.js's setMode() state machine
  returnTo: 'title',   // where Glossary/Settings go "Back" to (title vs. pause)
  run: null,
  settings: loadSettings(),
  stats: loadStats(),
};

export function resetStats() {
  state.stats = { ...DEFAULT_STATS, seenDex: [], caughtDex: [], winnerDex: [] };
  saveStats();
}

// Push a dex number onto one of the stats lists, keeping it unique and sorted.
export function recordDex(listName, dex) {
  const list = state.stats[listName];
  if (!list || list.includes(dex)) return;
  list.push(dex);
  list.sort((a, b) => a - b);
}
