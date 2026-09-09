// Party (max 6) and bag state, item use, and the swap-or-release flow when a catch fills the team.
//
// The item effect functions in js/data/items.js never touch game state directly — they receive the
// `itemApi` built here. Anything an item needs that lives outside inventory (warping the player,
// revealing the map, showing a toast) comes through `hooks`, which main.js fills in on boot.
import { state, MAX_PARTY, HP_BY_STAGE, makeMon, recordDex, saveStats } from './state.js';
import { ITEM_BY_ID, ITEMS, BALL_IDS } from './data/items.js';
import { CATALOG_BY_DEX, DAMAGE_BY_STAGE } from './data/pokemon-catalog.js';

// Filled in by main.js — everything an item needs that inventory itself does not own.
export const hooks = {
  warpToStairs: () => {},
  revealMap: () => {},
  revealEntities: () => {},
  toast: (_msg) => {},
};

// Every run starts with a small ball stock; without it the first peaceful wanderer is unwinnable.
export function startingBag() {
  return { 'poke-ball': 3, 'oran-berry': 1 };
}

export function countOf(itemId) {
  return (state.run?.bag?.[itemId]) || 0;
}

export function addItem(itemId, n = 1) {
  if (!state.run) return;
  state.run.bag[itemId] = countOf(itemId) + n;
}

export function removeItem(itemId, n = 1) {
  if (!state.run) return;
  const left = countOf(itemId) - n;
  if (left > 0) state.run.bag[itemId] = left;
  else delete state.run.bag[itemId];
}

// The bag screen renders in this order: balls first, then everything else in items.js order, so
// the grid layout is stable run to run instead of shuffling as pickups come in.
export function bagEntries() {
  if (!state.run) return [];
  return ITEMS
    .filter(i => countOf(i.id) > 0)
    .map(i => ({ item: i, count: countOf(i.id) }));
}

// ---- Party ------------------------------------------------------------------------------------
export function party() { return state.run?.party || []; }
export function partyAlive() { return party().filter(m => m.hp > 0); }
export function isPartyWiped() { return party().length > 0 && partyAlive().length === 0; }

// Heals up to `amount` HP (Infinity = full). Deliberately allowed to bring a fainted Pokemon back:
// Full Heal is described as doing exactly that, and losing a slot for a whole run is brutal.
export function heal(mon, amount) {
  if (!mon) return 0;
  const before = mon.hp;
  mon.hp = amount === Infinity ? mon.maxHp : Math.min(mon.maxHp, mon.hp + amount);
  return mon.hp - before;
}

// Evolves in place, preserving the fraction of HP the Pokemon was on. Only targets listed in the
// catalog's `evolvesInto` are possible, and that list only ever contains species that actually
// have a Quest model — so an evolution can never produce a Pokemon we cannot render.
export function evolve(mon) {
  if (!mon || !mon.evolvesInto || mon.evolvesInto.length === 0) return null;
  const targetDex = mon.evolvesInto[Math.floor(Math.random() * mon.evolvesInto.length)];
  const c = CATALOG_BY_DEX.get(targetDex);
  if (!c) return null;
  const ratio = mon.hp / mon.maxHp;
  mon.dex = c.dex;
  mon.name = c.name;
  mon.types = c.types.slice();
  mon.stage = c.stage;
  mon.evolvesInto = c.evolvesInto.slice();
  mon.dmg = DAMAGE_BY_STAGE[c.stage];
  mon.maxHp = HP_BY_STAGE[c.stage];
  mon.hp = Math.max(1, Math.round(mon.maxHp * ratio));
  recordDex('seenDex', c.dex);
  saveStats();
  return c.name;
}

// Adds a freshly caught Pokemon. Returns {added:false, needsSwap:true} when the party is full —
// main.js then puts up the swap-or-release prompt (design brief §7).
export function addCaught(dex) {
  const mon = makeMon(dex);
  if (!mon) return { added: false, needsSwap: false };
  state.stats.pokemonCaught++;
  recordDex('seenDex', dex);
  recordDex('caughtDex', dex);
  saveStats();
  if (party().length < MAX_PARTY) {
    party().push(mon);
    return { added: true, needsSwap: false, mon };
  }
  state.run.pendingCatch = mon;
  return { added: false, needsSwap: true, mon };
}

// Resolve the swap-or-release prompt. `index` = party slot to replace, or null to release.
export function resolvePendingCatch(index) {
  const mon = state.run?.pendingCatch;
  if (!mon) return null;
  state.run.pendingCatch = null;
  if (index === null || index === undefined) return { released: true, mon };
  const old = party()[index];
  party()[index] = mon;
  return { released: false, mon, replaced: old };
}

// ---- Balls ------------------------------------------------------------------------------------
// The catch minigame defaults to the best ball on hand unless the player picked one in the bag.
export function bestBall() {
  const held = BALL_IDS.filter(id => countOf(id) > 0);
  if (!held.length) return null;
  return held.reduce((best, id) => {
    const a = ITEM_BY_ID.get(id), b = ITEM_BY_ID.get(best);
    return a.ballTier > b.ballTier ? id : best;
  }, held[0]);
}

export function activeBall() {
  const chosen = state.run?.activeBall;
  if (chosen && countOf(chosen) > 0) return chosen;
  return bestBall();
}

export function totalBalls() {
  return BALL_IDS.reduce((s, id) => s + countOf(id), 0);
}

// ---- The api handed to item effect functions ---------------------------------------------------
export const itemApi = {
  get party() { return party(); },
  heal,
  evolve,
  revealMap: () => hooks.revealMap(),
  revealEntities: () => hooks.revealEntities(),
  buffAttack: (bonus, ms) => {
    if (!state.run) return;
    state.run.attackBonus = bonus;
    state.run.attackBonusUntil = performance.now() + ms;
  },
  setRepel: (ms) => {
    if (!state.run) return;
    state.run.repelUntil = performance.now() + ms;
  },
  warpToStairs: () => hooks.warpToStairs(),
  grantRevive: () => { if (state.run) state.run.revives = (state.run.revives || 0) + 1; },
  setActiveBall: (id) => { if (state.run) state.run.activeBall = id; },
};

// Use one item out of the bag. `mon` is required for items with needsTarget.
// The item is only consumed when its effect reports ok:true, so a Rare Candy on a fully-evolved
// Pokemon (or an Oran Berry on a healthy one) is not wasted.
export function useItem(itemId, mon = null) {
  const item = ITEM_BY_ID.get(itemId);
  if (!item) return { ok: false, msg: 'Nothing happened.' };
  if (countOf(itemId) <= 0) return { ok: false, msg: `You have no ${item.name}.` };
  if (item.needsTarget && !mon) return { ok: false, msg: `Choose a Pokemon to use the ${item.name} on.` };
  const res = item.use(itemApi, mon) || { ok: false, msg: 'Nothing happened.' };
  if (res.ok) removeItem(itemId, 1);
  return res;
}

// Current attack bonus, expired-aware. Read by battle creation and shown on the HUD.
export function currentAttackBonus() {
  if (!state.run) return 0;
  if (!state.run.attackBonusUntil || performance.now() > state.run.attackBonusUntil) {
    state.run.attackBonus = 0;
    return 0;
  }
  return state.run.attackBonus || 0;
}

export function isRepelActive() {
  return !!(state.run?.repelUntil && performance.now() < state.run.repelUntil);
}
