// Every screen's DOM: building it, filling it, and toggling between them.
//
// The pattern is the one Rumble Run used and it holds up: plain absolutely-positioned
// `<div class="screen">` siblings, exactly one carrying `.visible` at a time, switched by a single
// function. Nothing here knows about the game loop — main.js registers callbacks on `uiHooks` and
// this module only ever calls those.
import * as THREE from 'three';
import { state, MAX_PARTY, saveSettings, saveStats, resetStats } from './state.js';
import { ITEMS, ITEM_BY_ID, BALL_IDS } from './data/items.js';
import { CATALOG_BY_DEX } from './data/pokemon-catalog.js';
import { typeIconPath } from './data/type-chart.js';
import { createModelView } from './modelstage.js';
import { setPreviewModel, hasModelForDex, KECLEON_MODEL } from './models.js';
import { makeAura, spinAura, disposeAura } from './aura.js';
import { portraitFor, preloadPortraits } from './portraits.js';
import * as inv from './inventory.js';
import { sfx, applyVolumes } from './audio.js';

const $ = (id) => document.getElementById(id);

// Callbacks main.js fills in. Keeping them in one object avoids a circular import.
export const uiHooks = {
  startRun: () => {},
  chooseStarter: (_dex) => {},
  resume: () => {},
  quitRun: () => {},
  openBag: () => {},
  closeBag: () => {},
  openPause: () => {},
  goTitle: () => {},
  openGlossary: () => {},
  openSettings: () => {},
  openDex: () => {},
  back: () => {},
  useItem: (_itemId, _mon) => {},
  setControls: (_mode) => {},
  battleContinue: () => {},
  catchFlee: () => {},
  chooseBall: (_id) => {},
  resolveSwap: (_index) => {},
  openSwitch: () => {},
  chooseSwitch: (_index) => {},
  // The dungeon HUD's inline swap list: opening it (guarded on having someone to swap to) and
  // picking from it. The battle Swap button still goes through openSwitch/chooseSwitch.
  openLeadMenu: () => {},
  chooseLead: (_index) => {},
  newRun: () => {},
  // Kecleon's shop
  shopBuy: (_itemId) => {},
  shopLeave: () => {},
  // The pause map's gestures. There is no reset hook: the map has no Reset button any more, and
  // main.js resets the view every time the pause screen opens.
  mapRotate: (_delta) => {},
  mapZoom: (_factor, _originX, _originY) => {},
  mapPan: (_dx, _dy) => {},
};

const SCREEN_FOR_MODE = {
  title: 'screen-title',
  starter: 'screen-starter',
  pause: 'screen-pause',
  bag: 'screen-bag',
  glossary: 'screen-glossary',
  settings: 'screen-settings',
  dex: 'screen-dex',
  battle: 'screen-battle',
  catch: 'screen-catch',
  swap: 'screen-swap',
  switch: 'screen-switch',
  shop: 'screen-shop',
  end: 'screen-end',
};

export function showScreen(mode) {
  for (const id of Object.values(SCREEN_FOR_MODE)) $(id)?.classList.remove('visible');
  const target = SCREEN_FOR_MODE[mode];
  if (target) $(target).classList.add('visible');
  // The HUD is live during play and stays visible behind the catch overlay (which is transparent
  // by design so you can see the 3D mini-scene) but not behind any full sheet.
  $('hud').classList.toggle('visible', mode === 'playing');
  // A ball picker left open would still be sitting there on the next encounter.
  if (mode !== 'catch') setBallMenu(false);
  // Same for the lead swap list: it lives on the dungeon HUD, so anything that leaves `playing`
  // (a battle, the pause screen, an encounter) has to put it away — otherwise it is still hanging
  // over the HUD when you come back.
  if (mode !== 'playing') setLeadMenu(false);
}

// ---- Type badges -------------------------------------------------------------------------------
function typeBadges(types) {
  return `<div class="type-badges">${types
    .map(t => `<img src="${encodeURI(typeIconPath(t))}" alt="${t}" title="${t}" />`)
    .join('')}</div>`;
}

// ---- Toast / banner ----------------------------------------------------------------------------
let toastTimer = null;
export function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// The floor title card, as Mystery Dungeon does it: an opaque black screen with the dungeon's name
// and the floor number fading up out of it, holding, fading back out, and then the black itself
// lifting off the floor you have arrived on.
//
// The black does NOT fade in. enterFloor swaps the floor synchronously and puts this up in the same
// task, so no frame is ever drawn between the two — the black therefore lands on the first frame
// after the old floor and the cut is invisible. Fading it in would instead show the NEW floor for
// 400ms and then hide it, which reads as a screen wipe rather than as arriving somewhere. Only the
// last step is a reveal. See the #banner CSS for the same note from the other side.
const BANNER_FADE_MS = 420;       // matches the two `transition: opacity` durations in the CSS
let bannerTimers = [];

function clearBannerTimers() {
  for (const t of bannerTimers) clearTimeout(t);
  bannerTimers = [];
}
const afterBanner = (fn, ms) => bannerTimers.push(setTimeout(fn, ms));

// `ms` is the HOLD — how long the text stands fully lit. The two fades and the black lifting are
// on top of it, so the whole card runs about ms + 3 * BANNER_FADE_MS.
export function banner({ kicker, main, sub, ms = 900 }) {
  const el = $('banner');
  $('banner-kicker').textContent = kicker;
  $('banner-main').textContent = main;
  $('banner-sub').textContent = sub || '';
  clearBannerTimers();
  // Black up, text still invisible. The classes are cleared first so a card arriving while one is
  // still running (two floors in quick succession) starts from the same state as a cold one.
  el.classList.remove('lit', 'lifting');
  el.classList.add('visible');
  // Forces the style flush, so adding `lit` on the next line is a TRANSITION from opacity 0 rather
  // than the text simply existing at opacity 1 — same reason the pickup popup reads offsetWidth.
  void el.offsetWidth;
  el.classList.add('lit');
  return new Promise(resolve => {
    afterBanner(() => {
      el.classList.remove('lit');                  // text fades out
      afterBanner(() => {
        el.classList.add('lifting');               // then the black lifts off the new floor
        afterBanner(() => {
          el.classList.remove('visible', 'lifting');
          resolve();
        }, BANNER_FADE_MS);
      }, BANNER_FADE_MS);
    }, BANNER_FADE_MS + ms);
  });
}

export function hideBanner() {
  clearBannerTimers();
  $('banner').classList.remove('visible', 'lit', 'lifting');
}

// ---- Pickup popup ------------------------------------------------------------------------------
// What you picked up, shown as its own PIXEL SPRITE rather than as a line of toast text.
//
// This exists because of the present. Every non-ball pickup on the floor is now a wrapped gift box,
// which deliberately gives nothing away about what is inside it — so the moment of picking it up
// is the moment you find out, and a sprite is how the game says it everywhere else (the bag, the
// glossary, the ball picker). `qty` carries the count for a ball lot ("x4") or a coin's value
// ("+40"), and is blank for a single item.
//
// It floats above the toast slot rather than replacing it: toast is still what reports things the
// player DID (used an item, a Pokemon got away), and the two can legitimately land together.
let pickupTimer = null;
export function pickupPopup({ svg, name, qty = '' }, ms = 1500) {
  const el = $('pickup-pop');
  el.innerHTML = `<div class="pickup-icon">${svg}</div>`
    + `<div class="pickup-text"><span class="pickup-name">${name}</span>`
    + (qty ? `<span class="pickup-qty">${qty}</span>` : '') + '</div>';
  // Restart the rise-and-fade animation even when one is already running: two pickups a few
  // hundred ms apart (walking through a cluster of coins) must not leave the second one static.
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(pickupTimer);
  pickupTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ---- 3D previews (starter select + Pokedex) ----------------------------------------------------
let starterPreview = null, dexPreview = null;

function ensurePreviews() {
  if (!starterPreview) starterPreview = createModelView($('starter-preview'), { frustum: 1.25 });
  if (!dexPreview) dexPreview = createModelView($('dex-preview'), { frustum: 1.25 });
}

// Called from the main loop so every screen that owns a 3D canvas keeps rendering while it is up.
export function updatePreviews(dt, mode) {
  if (mode === 'starter' && starterPreview) {
    starterPreview.holder.rotation.y += dt * 0.7;
    starterPreview.render();
  } else if (mode === 'dex' && dexPreview) {
    dexPreview.holder.rotation.y += dt * 0.7;
    dexPreview.render();
  } else if (mode === 'shop' && shopPreview) {
    // Kecleon does NOT spin. The starter and Pokedex previews turn because they are display
    // pieces you are inspecting; Kecleon is a shopkeeper you are talking to, and a shopkeeper who
    // revolves reads as merchandise. His yaw is set once in renderShop and left alone. Still
    // rendered every frame, because the model arrives a load after the screen opens.
    shopPreview.render();
  } else if (mode === 'battle') {
    updateBattleField(dt);
  }
}

// ---- Starter select ----------------------------------------------------------------------------
let starterOffer = [];
let starterPick = null;

export function renderStarterSelect(offer) {
  ensurePreviews();
  starterOffer = offer;
  starterPick = null;
  const row = $('starter-row');
  row.innerHTML = offer.map((dex, i) => {
    const c = CATALOG_BY_DEX.get(dex);
    return `<div class="starter-card" data-i="${i}">
      <span class="sc-name">${c.name}</span>
      ${typeBadges(c.types)}
    </div>`;
  }).join('');
  row.querySelectorAll('.starter-card').forEach(el => {
    el.addEventListener('click', () => selectStarter(Number(el.dataset.i)));
  });
  selectStarter(0);
}

function selectStarter(i) {
  starterPick = starterOffer[i];
  sfx('select');
  const c = CATALOG_BY_DEX.get(starterPick);
  $('starter-name').textContent = c.name;
  // Type ICONS only — no "Fire - Basic - No. 909". Every starter in the pool is Basic and its dex
  // number decides nothing about the run, so that line was two facts that could not be acted on
  // padding out the one that can: type is the whole of what this choice is. The icons also say it
  // without reading, which is how the rest of the game says a type (the cards below, the catch
  // screen, the team strip).
  $('starter-meta').innerHTML = typeBadges(c.types);
  $('starter-row').querySelectorAll('.starter-card').forEach((el, idx) => {
    el.classList.toggle('selected', idx === i);
  });
  starterPreview.holder.rotation.y = 0;
  setPreviewModel(starterPreview.holder, starterPick, 1.5);
}

// ---- Poke Ball strips ---------------------------------------------------------------------------
// One ball per Pokemon on a side, greyed out once it has fainted. Used by the dungeon HUD's party
// indicator and by both battle info boxes.
function ballStrip(team) {
  return team.map(m => `<svg class="ball ${m.hp > 0 ? '' : 'out'}" viewBox="0 0 12 12" aria-hidden="true">
    <use href="#px-ball" /></svg>`).join('');
}

// ---- HUD --------------------------------------------------------------------------------------
export function updateHUD() {
  const run = state.run;
  if (!run) return;
  $('floor-num').textContent = String(run.floorIndex + 1);
  $('floor-theme').textContent = run.floor?.theme?.name || '-';

  const total = Object.values(run.bag).reduce((s, n) => s + n, 0);
  $('bag-count').textContent = String(total);
  $('coin-count').textContent = String(inv.coins());

  const lead = inv.partyAlive()[0] || inv.party()[0];
  if (lead) {
    $('lead-name').textContent = lead.name;
    setHpBar($('lead-hpbar'), lead.hp, lead.maxHp);
  }
  // The ball row under the card replaces the old "- 3/4" text on the name line: it says the same
  // thing (how many you are carrying, how many are still standing) without any reading.
  $('party-balls').innerHTML = ballStrip(inv.party());

  const pills = [];
  const bonus = inv.currentAttackBonus();
  if (bonus > 0) {
    const left = Math.max(0, Math.ceil((run.attackBonusUntil - performance.now()) / 1000));
    pills.push(`<span class="buff-pill">X Attack +${bonus} - ${left}s</span>`);
  }
  if (inv.isRepelActive()) {
    const left = Math.max(0, Math.ceil((run.repelUntil - performance.now()) / 1000));
    pills.push(`<span class="buff-pill repel">Repel - ${left}s</span>`);
  }
  if (run.revives > 0) pills.push(`<span class="buff-pill">Revive x${run.revives}</span>`);
  $('buff-strip').innerHTML = pills.join('');
}

// ---- The HUD's inline swap list ----------------------------------------------------------------
// The lead card used to open the full-screen `switch` mode. In the dungeon that is a whole screen
// for one tap — it hides the floor you are standing on to answer a question about a card in the
// corner. The battle Swap button still uses the full screen (there is nothing behind it worth
// keeping in view); out here the list expands out of the button itself.
//
// Every party member is listed, INCLUDING the one already out and any that have fainted. Seeing the
// whole team is half the reason to open it, so those are marked and disabled rather than omitted —
// a list whose length changes as members faint is a list you cannot build muscle memory for.
let leadMenuOpen = false;

export function setLeadMenu(open) {
  const menu = $('lead-menu');
  const btn = $('btn-lead');
  if (!menu || !btn) return;
  if (open) renderLeadMenu();
  leadMenuOpen = open;
  menu.classList.toggle('open', open);
  btn.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', String(open));
}

export function toggleLeadMenu() { setLeadMenu(!leadMenuOpen); }
export function isLeadMenuOpen() { return leadMenuOpen; }

function renderLeadMenu() {
  const p = inv.party();
  const menu = $('lead-menu');
  menu.innerHTML = p.map((m, i) => {
    const pct = Math.max(0, Math.min(100, (m.hp / m.maxHp) * 100));
    const barClass = pct <= 20 ? 'low' : pct <= 50 ? 'mid' : '';
    const dead = m.hp <= 0;
    const current = i === 0;
    const art = portraitFor(m.dex);
    // Disabled for the current lead and for anyone fainted: picking either is a no-op, and a row
    // that looks pressable and does nothing is worse than one that says it cannot be.
    return `<button class="lead-row${current ? ' current' : ''}${dead ? ' fainted' : ''}"
         ${current || dead ? 'disabled' : `data-i="${i}"`} role="menuitem">
      ${art ? `<img class="lr-art" src="${art}" alt="" />` : `<span class="lr-art"></span>`}
      <span class="lr-body">
        <span class="lr-name">${m.name}</span>
        <span class="hpbar ${barClass}"><i style="width:${pct}%"></i></span>
      </span>
    </button>`;
  }).join('');
  for (const el of menu.querySelectorAll('.lead-row[data-i]')) {
    el.addEventListener('click', () => {
      // Retract FIRST, then swap. The animation is the feedback that the tap landed, and closing
      // on the way out means the list is already collapsing while the lead card re-renders under
      // it — which is what makes it read as one movement instead of a menu that vanishes.
      setLeadMenu(false);
      uiHooks.chooseLead(Number(el.dataset.i));
    });
  }
  // The portraits are rendered once per species and cached; any that are not ready yet arrive a
  // frame or two later, and the list redraws itself in place — but only while it is still open.
  preloadPortraits(p.map(m => m.dex), () => { if (leadMenuOpen) renderLeadMenu(); });
}

function setHpBar(el, hp, maxHp) {
  const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
  el.querySelector('i').style.width = pct + '%';
  el.classList.toggle('mid', pct <= 50 && pct > 20);
  el.classList.toggle('low', pct <= 20);
}

// ---- Bag --------------------------------------------------------------------------------------
let bagSelectedItem = null;
let bagSelectedMon = null;

export function renderBag() {
  bagSelectedItem = null;
  bagSelectedMon = null;
  renderTeamStrip($('bag-team'), { onPick: (i) => { bagSelectedMon = i; renderBag2(); } });
  renderBagItems();
  renderBagDetail();
}

// Re-render just the parts that change on a selection, so scroll position is kept.
function renderBag2() {
  renderTeamStrip($('bag-team'), {
    selected: bagSelectedMon,
    onPick: (i) => { bagSelectedMon = i; renderBag2(); },
  });
  renderBagItems();
  renderBagDetail();
}

// A roster card per party member, in the reading order the bag screen asks for: the Pokemon's
// MODEL at the top, then its NAME, then its HEALTH, then its TYPES under the health bar.
//
// The model is a flat portrait from js/portraits.js rather than a live 3D canvas — see that module
// for why. A portrait that has not been rendered yet leaves the frame empty and the card redraws
// itself when it lands, so opening the bag never waits on a model load.
function renderTeamStrip(container, { selected = null, onPick = null, includeEmpty = true,
                                      disableFainted = false } = {}) {
  const p = inv.party();
  const cells = [];
  for (let i = 0; i < MAX_PARTY; i++) {
    const m = p[i];
    if (!m) {
      if (includeEmpty) cells.push(`<div class="team-slot empty">-</div>`);
      continue;
    }
    const pct = Math.max(0, Math.min(100, (m.hp / m.maxHp) * 100));
    const barClass = pct <= 20 ? 'low' : pct <= 50 ? 'mid' : '';
    const art = portraitFor(m.dex);
    const dead = m.hp <= 0;
    cells.push(`<div class="team-slot ${dead ? 'fainted' : ''} ${selected === i ? 'selected' : ''}"
         ${dead && disableFainted ? '' : `data-i="${i}"`}>
      ${art ? `<img class="ts-art" src="${art}" alt="" />` : `<div class="ts-art"></div>`}
      <div class="ts-name">${m.name}</div>
      <div class="hpbar ${barClass}"><i style="width:${pct}%"></i></div>
      <div class="ts-hp">${m.hp}/${m.maxHp}</div>
      ${typeBadges(m.types)}
    </div>`);
  }
  container.innerHTML = cells.join('');
  if (onPick) {
    container.querySelectorAll('.team-slot[data-i]').forEach(el => {
      el.addEventListener('click', () => { sfx('select'); onPick(Number(el.dataset.i)); });
    });
  }
  // Kick off whatever portraits are still missing and redraw this same strip as each arrives.
  preloadPortraits(p.map(m => m.dex), () => {
    if (!container.isConnected) return;
    renderTeamStrip(container, { selected, onPick, includeEmpty, disableFainted });
  });
}

function renderBagItems() {
  const entries = inv.bagEntries();
  const grid = $('bag-items');
  $('bag-empty').style.display = entries.length ? 'none' : 'block';
  grid.innerHTML = entries.map(({ item, count }) => `
    <div class="item-cell ${bagSelectedItem === item.id ? 'selected' : ''}" data-id="${item.id}" title="${item.name}">
      ${item.svg}<span class="qty">${count}</span>
    </div>`).join('');
  grid.querySelectorAll('.item-cell').forEach(el => {
    el.addEventListener('click', () => {
      sfx('select');
      bagSelectedItem = el.dataset.id;
      renderBag2();
    });
  });
}

function renderBagDetail() {
  const detail = $('bag-detail');
  const useBtn = $('btn-bag-use');
  if (!bagSelectedItem) {
    detail.innerHTML = `<div class="id-name">-</div><div class="id-desc">Tap an item to see what it does.</div>`;
    useBtn.disabled = true;
    useBtn.textContent = 'Use';
    return;
  }
  const item = ITEM_BY_ID.get(bagSelectedItem);
  const needsTarget = !!item.needsTarget;
  const target = bagSelectedMon !== null ? inv.party()[bagSelectedMon] : null;
  let note = '';
  if (item.kind === 'ball') {
    note = `<div class="id-desc" style="color:var(--gold)">Selecting a ball sets which one you throw in the catch minigame.</div>`;
  } else if (needsTarget) {
    note = target
      ? `<div class="id-desc" style="color:var(--gold)">Target: ${target.name}</div>`
      : `<div class="id-desc" style="color:var(--gold)">Pick a Pokemon above first.</div>`;
  }
  detail.innerHTML = `<div class="id-name">${item.name}</div><div class="id-desc">${item.desc}</div>${note}`;
  useBtn.disabled = needsTarget && !target;
  useBtn.textContent = item.kind === 'ball' ? 'Select Ball' : 'Use';
}

// ---- Glossary ---------------------------------------------------------------------------------
export function renderGlossary() {
  $('glossary-list').innerHTML = ITEMS.map(i => `
    <div class="gloss-row">
      <div class="gloss-icon">${i.svg}</div>
      <div>
        <div class="gloss-name">${i.name}</div>
        <div class="gloss-desc">${i.desc}</div>
      </div>
    </div>`).join('');
}

// ---- Settings ---------------------------------------------------------------------------------
// ---- Settings ---------------------------------------------------------------------------------
// The word that has to be typed before Erase Records will fire. Compared case-insensitively and
// trimmed: this is a "are you sure you meant this" gate, not a secret, and an autocapitalised R
// off a phone keyboard should not be a wrong answer.
const RESET_WORD = 'reset';

function setResetGate(armed) {
  $('reset-gate').hidden = !armed;
  $('btn-reset-stats').hidden = armed;
  if (!armed) {
    $('reset-pass').value = '';
    $('btn-reset-go').disabled = true;
  }
}

export function renderSettings() {
  // Always opens closed: leaving the screen with the field half-filled and coming back to a live
  // Erase button is exactly the accident this gate exists to prevent.
  setResetGate(false);
  $('vol-music').value = Math.round(state.settings.music * 100);
  $('vol-sfx').value = Math.round(state.settings.sfx * 100);
  $('vol-music-val').textContent = Math.round(state.settings.music * 100) + '%';
  $('vol-sfx-val').textContent = Math.round(state.settings.sfx * 100) + '%';
  $('ctrl-joystick').setAttribute('aria-pressed', String(state.settings.controls === 'joystick'));
  $('ctrl-tap').setAttribute('aria-pressed', String(state.settings.controls === 'tap'));
}

// ---- Pokedex / Stats --------------------------------------------------------------------------
let dexSelected = null;

export function renderDex() {
  ensurePreviews();
  const s = state.stats;
  $('dex-stats').innerHTML = [
    ['Runs', s.runsPlayed], ['Wins', s.runsWon], ['Best Floor', s.bestFloor ? 'B' + s.bestFloor + 'F' : '-'],
    ['Giovanni KOs', s.giovanniDefeats], ['Grunts KOd', s.gruntsDefeated], ['Caught', s.pokemonCaught],
  ].map(([label, val]) => `<div class="stat-tile"><div class="sv">${val}</div><div class="sl">${label}</div></div>`).join('');

  // Everything ever seen, with caught / run-winner picked out by border color.
  const seen = s.seenDex.slice().sort((a, b) => a - b);
  $('dex-empty').style.display = seen.length ? 'none' : 'block';
  $('dex-grid').innerHTML = seen.map(dex => {
    const c = CATALOG_BY_DEX.get(dex);
    if (!c) return '';
    const cls = s.winnerDex.includes(dex) ? 'winner' : s.caughtDex.includes(dex) ? 'caught' : '';
    return `<div class="dex-cell ${cls} ${dexSelected === dex ? 'selected' : ''}" data-dex="${dex}">
      <span>${c.name}</span></div>`;
  }).join('');

  $('dex-grid').querySelectorAll('.dex-cell').forEach(el => {
    el.addEventListener('click', () => { sfx('select'); selectDex(Number(el.dataset.dex)); });
  });

  if (seen.length) selectDex(dexSelected && seen.includes(dexSelected) ? dexSelected : seen[0]);
  else { $('dex-name').textContent = '-'; setPreviewModel(dexPreview.holder, -1); }
}

function selectDex(dex) {
  dexSelected = dex;
  const c = CATALOG_BY_DEX.get(dex);
  const s = state.stats;
  const tags = [];
  if (s.winnerDex.includes(dex)) tags.push('won a run');
  else if (s.caughtDex.includes(dex)) tags.push('caught');
  else tags.push('seen');
  // The trailing detail drops out of the display face: in Press Start 2P it is wide enough to
  // wrap onto a second line and shove the stat grid down.
  $('dex-name').innerHTML = `${c.name}<span class="meta-inline">${c.types.join('/')} - ${tags.join(', ')}</span>`;
  $('dex-grid').querySelectorAll('.dex-cell').forEach(el => {
    el.classList.toggle('selected', Number(el.dataset.dex) === dex);
  });
  dexPreview.holder.rotation.y = 0;
  if (hasModelForDex(dex)) setPreviewModel(dexPreview.holder, dex, 1.5);
}

// ---- Battle -----------------------------------------------------------------------------------
// Mainline Pokemon's screen. The two Pokemon on the field are live 3D in their own small canvases,
// which is what makes the back view free: your side's holder is turned a half-turn, so the same
// model that faces the camera on the foe's side faces away on yours.
const TRAINER_SPRITE_DIR = 'assets/sprites/';
// A grunt's sprite is drawn at random per battle. There is one grunt sprite in the folder today;
// this is a list so that dropping more in and naming them here is the whole change.
const GRUNT_SPRITES = ['Team Rocket Grunt.png'];
const GIOVANNI_SPRITE = 'Giovanni.png';

let foePreview = null, youPreview = null;
// Which dex each side's canvas is currently showing, so a re-render only reloads on a real switch.
let foeShownDex = null, youShownDex = null;
let fieldBob = 0;

// Half-height of the fighters' ortho box, with the camera dead level on the origin. A model is
// fitted to 1.0 tall and then dropped so its FEET sit just above the frame's bottom edge — see
// placeFighter. Aiming the camera above the model instead left it floating in the middle of the
// frame with its ground shadow stranded underneath it.
const FIGHTER_FRUSTUM = 0.62;

function ensureBattlePreviews() {
  const opts = { frustum: FIGHTER_FRUSTUM, camY: 0, camZ: 4, lookY: 0 };
  if (!foePreview) foePreview = createModelView($('foe-model'), opts);
  if (!youPreview) youPreview = createModelView($('you-model'), opts);
}

// Stand a freshly loaded fighter on the bottom of its frame, shrinking it if it is wider than the
// frame is. Models are fitted by HEIGHT, so a wide species (Marowak with its bone, Gyarados) comes
// out wider than tall and would otherwise run off both sides.
function placeFighter(fitted) {
  if (!fitted) return;
  const box = new THREE.Box3().setFromObject(fitted);
  const w = box.max.x - box.min.x;
  const limit = FIGHTER_FRUSTUM * 2 * 0.94;
  const shrink = w > limit ? limit / w : 1;
  if (shrink < 1) fitted.scale.setScalar(shrink);
  fitted.position.y = -FIGHTER_FRUSTUM * 0.86;
}

export function renderBattle(battle) {
  ensureBattlePreviews();
  foeShownDex = null;
  youShownDex = null;
  fieldBob = 0;
  // The previous battle's auras, given back here rather than left to the syncFighter calls at the
  // end of this function: those bail out early on a side with no lead, and an aura's geometry is
  // its own rather than the loader cache's, so bailing out would strand it.
  disposeAura(fighterAura.foe);
  disposeAura(fighterAura.you);
  fighterAura.foe = null;
  fighterAura.you = null;

  // The trainer, standing behind their Pokemon. Wild encounters have nobody there.
  const img = $('foe-trainer'), nameEl = $('foe-trainer-name');
  $('battle-field').classList.toggle('wild', battle.kind === 'wild');
  if (battle.kind === 'wild') {
    img.classList.add('hidden');
    nameEl.classList.add('hidden');
  } else {
    if (!battle.trainerSprite) {
      battle.trainerSprite = battle.kind === 'giovanni'
        ? GIOVANNI_SPRITE
        : GRUNT_SPRITES[Math.floor(Math.random() * GRUNT_SPRITES.length)];
    }
    // A missing sprite file hides the image rather than leaving a broken-image icon on the field.
    // The name label stays either way, so you always know who you are fighting — same rule the
    // music follows: an absent asset costs you the asset, not the screen.
    img.onerror = () => { img.classList.add('hidden'); };
    img.onload = () => { img.classList.remove('hidden'); };
    img.src = encodeURI(TRAINER_SPRITE_DIR + battle.trainerSprite);
    img.alt = '';
    // Re-setting `src` to a value the browser already has decoded does fire `load` again, but not
    // on every engine — so un-hide straight away when the image is already there.
    if (img.complete && img.naturalWidth > 0) img.classList.remove('hidden');
    nameEl.textContent = battle.kind === 'giovanni' ? 'GIOVANNI' : 'ROCKET GRUNT';
    nameEl.classList.remove('hidden');
  }

  $('btn-battle-continue').style.display = 'none';
  // Swapping is only ever offered while the fight is live and you have someone to swap TO.
  updateSwapButton(battle);
  $('battle-log').textContent = battle.kind === 'wild'
    ? `A wild ${battle.enemies[0]?.name || 'Pokemon'} blocks your path!`
    : `${battle.title} wants to battle!`;
  updateBattleRows(battle);
}

// Refresh both info boxes and both models against the battle's current state. Called every time
// anything lands, so it has to be cheap: the models are only touched when the lead actually changes.
export function updateBattleRows(battle) {
  const foe = battle.enemyLead();
  const you = battle.partyLead();

  fillMonBox('foe', foe, { showNumbers: false });
  fillMonBox('you', you, { showNumbers: true });

  // The ball strips are TRAINER-BATTLE ONLY: a lone wild Pokemon has no team to count, so both
  // strips stay empty and collapse (see .mb-balls:empty).
  const trainerFight = battle.kind !== 'wild';
  $('foe-balls').innerHTML = trainerFight ? ballStrip(battle.enemies) : '';
  $('you-balls').innerHTML = trainerFight ? ballStrip(battle.party) : '';

  syncFighter('foe', foe, foePreview, () => foeShownDex, (d) => { foeShownDex = d; });
  syncFighter('you', you, youPreview, () => youShownDex, (d) => { youShownDex = d; });
  updateSwapButton(battle);
}

function fillMonBox(side, mon, { showNumbers }) {
  if (!mon) return;
  $(`${side}-name`).textContent = mon.name;
  // Stands where a level does in the games. "Stage1" -> "STAGE 1"; Basic and Legendary have no
  // number, and Legendary is shortened because the full word does not fit beside a long name.
  $(`${side}-stage`).textContent = mon.stage === 'Legendary'
    ? 'LGND'
    : mon.stage.replace(/(\d)$/, ' $1').toUpperCase();
  setHpBar($(`${side}-hpbar`), mon.hp, mon.maxHp);
  // Exact HP is shown for your own Pokemon only, exactly as the games do it.
  if (showNumbers) $('you-hpnum').textContent = `${mon.hp} / ${mon.maxHp}`;
}

// A model's forward direction at rotation.y = 0 is +Z, which is straight at the camera. So a
// half-turn is a dead-on back view and 0 is a dead-on front view — but the two then face the
// camera rather than each other. Angling both by 45 degrees puts them on the screen's diagonal,
// looking across it at one another:
//   YOURS  3/4 PI  -> forward (+0.71, 0, -0.71): away from the camera and to the RIGHT (up-right)
//   FOE   -1/4 PI  -> forward (-0.71, 0, +0.71): toward the camera and to the LEFT (down-left)
const FACING = { you: Math.PI * 0.75, foe: -Math.PI * 0.25 };

// The aura is attached to the FITTED model rather than to the holder, so it inherits both of
// placeFighter's adjustments: the drop that stands the model on the bottom of the frame (which puts
// the aura's ground ring at its feet) and the shrink a too-wide species gets (which keeps the aura
// hugging the body instead of hanging off it).
//
// `spread` is well under 1 because a fighter frame is only FIGHTER_FRUSTUM * 2 = 1.24 units wide
// against a model fitted to 1.0 tall — at the dungeon's full width the ring is 2.07 across and
// runs off both sides, clipped mid-arc, which reads as a rendering fault rather than as an aura.
// At 0.52 the ring comes out ~1.08 wide, so it surrounds the body with margin left over on both
// sides. The frames are square (`aspect-ratio: 1`), so that arithmetic holds at every screen size.
const FIGHTER_AURA_SPREAD = 0.52;
// Both sides' auras, so updateBattleField can turn whichever one exists. `you` is in here for one
// reason only: so that a side that has no aura is explicitly recorded as having none, and the last
// fighter's cloud cannot be left spinning over its replacement.
const fighterAura = { foe: null, you: null };

function syncFighter(side, mon, preview, getShown, setShown) {
  const wrap = $(`${side}-fighter`);
  if (!mon || !preview) return;
  wrap.classList.toggle('fainted', mon.hp <= 0);
  if (getShown() === mon.dex) return;
  setShown(mon.dex);
  preview.holder.rotation.y = FACING[side];
  // Dropped BEFORE the load, not when it resolves: setPreviewModel empties the holder immediately,
  // so holding the reference past this point would spin a group that is no longer on screen. An
  // aura's geometry is its own rather than the loader cache's, so it is disposed rather than just
  // detached — one is built per lead, and a six-strong Giovanni team would otherwise leave five.
  disposeAura(fighterAura[side]);
  fighterAura[side] = null;
  setPreviewModel(preview.holder, mon.dex, 1.0).then(fitted => {
    placeFighter(fitted);
    // A shadow Pokemon keeps its aura for the whole fight. Only a wild is ever flagged aggressive,
    // and only the foe's side can hold one — a caught Pokemon is rebuilt without the flag, so
    // your own fighters have nothing to draw (see aura.js).
    if (!fitted || !mon.aggressive) return;
    const aura = makeAura(1.0, { spread: FIGHTER_AURA_SPREAD });
    fitted.add(aura);
    fighterAura[side] = aura;
  });
}

// Driven from the main loop so both fighters keep rendering: the models load asynchronously, so a
// single render at battle start would show empty frames.
export function updateBattleField(dt) {
  if (!foePreview || !youPreview) return;
  fieldBob += dt;
  // A slow breathing bob. The Quest models have no animation of their own, and two dead-still
  // models on an otherwise static screen read as a frozen game.
  foePreview.holder.position.y = Math.sin(fieldBob * 1.7) * 0.022;
  youPreview.holder.position.y = Math.sin(fieldBob * 1.7 + 1.1) * 0.026;
  // The shadow aura turns at the same rate it does in the dungeon, so it is recognisably the same
  // effect on the same Pokemon rather than a second purple thing that happens in battles.
  spinAura(fighterAura.foe, dt);
  spinAura(fighterAura.you, dt);
  foePreview.render();
  youPreview.render();
}

// The attacker's step into its blow.
//
// Screen space, not model space: the two fighters sit in separate square canvases pinned to
// opposite corners of the field (foe top-right, you bottom-left), and their ORTHOGRAPHIC cameras
// make a 3D step toward the opponent — which is mostly a step along Z — almost invisible, since an
// ortho projection does not scale with depth. A transform on the wrapper moves the whole fighter,
// platform shadow and all, diagonally across the field toward the other one, which is the read.
//
// Restarted rather than guarded: the two sides alternate on a 780 ms turn slot and the lunge is
// 260 ms, so they never overlap — but a swap or a revive can re-render mid-animation, and removing
// the class and forcing a reflow before re-adding it is what makes the next one actually play.
export function lungeAttacker(side) {
  const el = $(`${side}-fighter`);
  if (!el) return;
  el.classList.remove('lunge');
  void el.offsetWidth;
  el.classList.add('lunge');
  setTimeout(() => el.classList.remove('lunge'), 300);
}

export function battleLog(html) { $('battle-log').innerHTML = html; }

export function showBattleContinue(label = 'Continue') {
  const b = $('btn-battle-continue');
  b.textContent = label;
  b.style.display = 'block';
  // The fight is over once Continue is up, so there is nothing left to swap into.
  $('btn-battle-swap').style.display = 'none';
}

function updateSwapButton(battle) {
  // Offered for the whole live fight, INTRO INCLUDED. Gating it on 'fighting' meant the button
  // only appeared once the first blow landed, because that is the next thing that re-renders the
  // screen — so the one moment you most want to choose who leads was the one it was missing.
  const live = battle.phase === 'intro' || battle.phase === 'fighting';
  $('btn-battle-swap').style.display = live && battle.partyAlive() > 1 ? 'block' : 'none';
}

// The damage number, floating off the Pokemon that just took the hit.
//
// This is now the ONLY report of a hit — nothing is written to the message band for one any more.
// A line of prose per blow meant the band rewrote itself twice a second and the actual fight was
// the thing nobody watched. So the number lands on the body it belongs to, over the model rather
// than over the info box, and a super-effective hit says so here instead of in the log.
export function floatDamage(side, _index, dmg, superEff) {
  const key = side === 'enemy' ? 'foe' : 'you';
  const fighter = $(`${key}-fighter`);
  const box = $(`${key}-box`);
  if (!fighter) return;

  box?.classList.add('hurt');
  fighter.classList.add('hurt');
  setTimeout(() => {
    box?.classList.remove('hurt');
    fighter.classList.remove('hurt');
  }, 160);

  const el = document.createElement('div');
  el.className = 'float-dmg' + (superEff ? ' se' : '');
  el.innerHTML = superEff
    ? `-${dmg}<span class="se-tag">SUPER EFFECTIVE</span>`
    : `-${dmg}`;
  const r = fighter.getBoundingClientRect();
  // Centred on the model and started around its shoulders, so the rise clears the body.
  el.style.left = (r.left + r.width / 2) + 'px';
  el.style.top = (r.top + r.height * 0.22) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

// ---- Party switch ------------------------------------------------------------------------------
// The BATTLE Swap button's screen. It used to serve the dungeon HUD's lead card as well, which is
// why it still takes `inBattle` and swaps its own subtitle — the dungeon path is now the inline
// list that grows out of the lead card (see setLeadMenu), because a full screen there hid the floor
// you were standing on to answer a question about a card in the corner. In a battle there is
// nothing behind the screen worth keeping in view, so this stayed.
//
// `inBattle` is kept rather than hardcoded: renderSwitch is reached through state.returnTo, and a
// caller that is not a battle is still a legitimate thing to add.
// A fainted member is not offered — there is nothing it can do on either side of that call.
export function renderSwitch({ inBattle, currentIndex }) {
  $('switch-sub').textContent = inBattle
    ? 'Send out a different Pokemon. A fainted one cannot be sent out.'
    : 'Pick who leads the way. A fainted one cannot take the lead.';
  renderTeamStrip($('switch-team'), {
    selected: currentIndex,
    includeEmpty: false,
    disableFainted: true,
    onPick: (i) => uiHooks.chooseSwitch(i),
  });
}

// ---- Catch overlay ----------------------------------------------------------------------------
// Three controls, GO's layout: Run top-left, the 3D ball bottom-middle (canvas, not DOM), and the
// ball swap bottom-right. The swap is a single button carrying the ball you are holding and how
// many are left; tapping it pops the other tiers up above it, and picking one closes it again.
let ballMenuOpen = false;

// The only text on the screen is the name, with the type icons under it. There is deliberately no
// prompt line and no result line — what the throw did is visible in the 3D scene.
export function renderCatchUI({ dex, activeBall }) {
  const c = CATALOG_BY_DEX.get(dex);
  $('catch-name').textContent = c ? c.name : 'Pokemon';
  $('catch-sub').innerHTML = c ? typeBadges(c.types) : '';

  const held = BALL_IDS.filter(id => inv.countOf(id) > 0);
  const current = activeBall && inv.countOf(activeBall) > 0 ? activeBall : held[0] || null;
  const item = current ? ITEM_BY_ID.get(current) : null;
  $('catch-ball-icon').innerHTML = item ? item.svg : '';
  $('catch-ball-count').textContent = current ? `x${inv.countOf(current)}` : 'x0';
  $('btn-catch-ball').style.opacity = held.length ? '1' : '0.45';

  // Only the tiers you are NOT holding right now — a picker whose top entry is the ball already in
  // your hand is a wasted tap.
  const others = held.filter(id => id !== current);
  const menu = $('catch-ballmenu');
  menu.innerHTML = others.map(id => {
    const it = ITEM_BY_ID.get(id);
    return `<div class="ball-chip" data-id="${id}" title="${it.name}">${it.svg}<span>x${inv.countOf(id)}</span></div>`;
  }).join('');
  menu.querySelectorAll('.ball-chip[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      sfx('select');
      setBallMenu(false);
      uiHooks.chooseBall(el.dataset.id);
    });
  });
  if (!others.length) setBallMenu(false);
}

export function setBallMenu(open) {
  ballMenuOpen = open && $('catch-ballmenu').children.length > 0;
  $('catch-ballmenu').classList.toggle('hidden', !ballMenuOpen);
}

export function toggleBallMenu() { setBallMenu(!ballMenuOpen); }

// "NICE!" / "GREAT!" / "EXCELLENT!" / "CURVEBALL!" on contact. The class has to come off and go
// back on for the animation to restart on a second throw, and reading offsetWidth in between is
// what forces the style flush that makes the removal take effect.
export function flashCatchGrade(label) {
  const el = $('catch-grade');
  // One <span> per award so a curveball and a throw grade stack instead of running off the edges.
  el.innerHTML = label.split(' ')
    .filter(Boolean)
    .map(part => `<span>${part}</span>`)
    .join('');
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

// Wipe the grade, called by main.js when a NEW encounter starts.
//
// This is not housekeeping, it fixes a real bug: the last throw's award flashed up again over the
// next Pokemon you met and then vanished. `gradePop` ends at opacity 0 and holds there with
// `forwards`, so leaving `.pop` on the element looks harmless — but a CSS animation inside a
// `display: none` subtree is CANCELLED, and the catch screen is hidden between encounters. Showing
// it again therefore RESTARTED the animation from 0% and replayed the whole pop, stale text and
// all. Clearing the class is what actually matters; emptying the text is belt and braces for any
// future path that shows the screen without an animation to restart.
export function resetCatchGrade() {
  const el = $('catch-grade');
  if (!el) return;
  el.classList.remove('pop');
  el.innerHTML = '';
}

// The catch screen's one line of result text — see the #catch-note CSS for why this screen has
// exactly one. Shown while the encounter is closing itself, so it needs no timer: whatever put it
// up is on its way out, and clearCatchNote() runs when the next encounter opens.
export function catchNote(text) {
  const el = $('catch-note');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
}

export function clearCatchNote() {
  const el = $('catch-note');
  if (!el) return;
  el.classList.remove('show');
  el.textContent = '';
}

// ---- Swap or release --------------------------------------------------------------------------
let swapSelected = null;

export function renderSwap(newMon) {
  swapSelected = null;
  $('swap-sub').textContent = `You caught ${newMon.name} (${newMon.types.join('/')}, ${newMon.stage}) - but you are already carrying ${MAX_PARTY}.`;
  const draw = () => renderTeamStrip($('swap-team'), {
    selected: swapSelected,
    includeEmpty: false,
    onPick: (i) => { swapSelected = i; $('btn-swap-confirm').disabled = false; draw(); },
  });
  draw();
  $('btn-swap-confirm').disabled = true;
}

export function swapSelection() { return swapSelected; }

// ---- End of run -------------------------------------------------------------------------------
export function renderEnd({ won, floorReached, caught, partyNames, abandoned = false }) {
  $('end-kicker').textContent = won ? 'Run Complete' : 'Run Over';
  $('end-kicker').style.color = won ? 'var(--gold)' : 'var(--danger)';
  $('end-title').textContent = won ? 'Giovanni Falls' : abandoned ? 'Run Abandoned' : 'Wiped Out';
  $('end-sub').textContent = won
    ? `Team Rocket's hold on the dungeon is broken. ${partyNames.length ? partyNames.join(', ') + ' made it out.' : ''}`
    : abandoned
      ? `You walked away on B${floorReached}F. Your team and everything you were carrying stay down there - that is the deal.`
      : `Your team fell on B${floorReached}F. Everything you were carrying is gone - that is the deal down here.`;
  $('end-stats').innerHTML = [
    ['Floor', 'B' + floorReached + 'F'],
    ['Caught', caught],
    ['Best Ever', state.stats.bestFloor ? 'B' + state.stats.bestFloor + 'F' : '-'],
  ].map(([l, v]) => `<div class="stat-tile"><div class="sv">${v}</div><div class="sl">${l}</div></div>`).join('');
}

// ---- Kecleon's shop ----------------------------------------------------------------------------
// Kecleon himself is rendered through createModelView, NOT a new WebGLRenderer: the page is
// allowed exactly two live WebGL contexts (the dungeon's and modelstage's shared offscreen one),
// and a third gets the dungeon's killed by the browser. See js/modelstage.js.
let shopPreview = null;
let shopModelShown = false;

function ensureShopPreview() {
  if (shopPreview) return shopPreview;
  shopPreview = createModelView($('shop-canvas'), { frustum: 0.95, camY: 0.72, camZ: 2.6, lookY: 0.6 });
  return shopPreview;
}

export function renderShop(ctx) {
  if (!ctx) return;
  const view = ensureShopPreview();
  if (!shopModelShown) {
    // Loaded straight from its path rather than through a dex lookup: Kecleon is not in the Quest
    // roster or POKEMON_CATALOG, he is an NPC.
    // `brighten`: his texture is a dark green and the shop panel gives him none of the dungeon
    // stall's warm point light, so at rig brightness he came out as a near-black silhouette.
    setPreviewModel(view.holder, null, 1.15, KECLEON_MODEL, { brighten: 1.5 });
    // A fixed three-quarter yaw, set once. He is standing still and facing the customer; the
    // slight turn is only so he is not a dead-flat front elevation.
    view.holder.rotation.y = -0.34;
    shopModelShown = true;
  }
  $('shop-coins').textContent = String(inv.coins());

  // The line under each item's name is WHAT IT DOES (items.js `shopDesc`), not its stock count.
  // It used to be the count, and that made the shop unusable for its actual purpose: the icons are
  // 10x10 pixel art and the names are bare nouns, so anyone who had not already found that item on
  // a floor and read it in the Glossary was buying blind. "3 left" is worth knowing but it is never
  // the question you came to the stall with.
  //
  // The stock and the shortfall are not dropped, they move — into their own column under the price,
  // which is where both belong anyway: they are facts about the OFFER, not about the item.
  //
  // SOLD OUT and CAN'T AFFORD are different states and must not look the same. Sold out is gone,
  // so it is greyed right out; too expensive is still on the shelf, so the row stays in full colour
  // with its price in red and the shortfall spelled out under it. Both are disabled — but
  // greyscaling an unaffordable row would wash the red price out, which is the one thing on it that
  // explains why it cannot be pressed.
  const rows = ctx.stock.map(line => {
    const item = ITEM_BY_ID.get(line.itemId);
    const sold = line.stock <= 0;
    const short = !sold && inv.coins() < line.price;
    const cls = sold ? ' sold' : short ? ' short' : '';
    // Narrow column, so the shortfall loses the word "coins" — it sits directly under a coin price.
    const note = sold ? 'Sold out'
      : short ? `${line.price - inv.coins()} short` : `${line.stock} left`;
    return `<button class="shop-row${cls}" data-item="${item.id}" ${sold || short ? 'disabled' : ''}>
      <span class="shop-ico">${item.svg}</span>
      <span class="shop-body">
        <span class="shop-name">${item.name}</span>
        <span class="shop-desc">${item.shopDesc || item.desc}</span>
      </span>
      <span class="shop-meta">
        <span class="shop-price">${line.price}</span>
        <span class="shop-stock">${note}</span>
      </span>
    </button>`;
  }).join('');
  const grid = $('shop-rows');
  grid.innerHTML = rows;
  for (const btn of grid.querySelectorAll('.shop-row')) {
    btn.addEventListener('click', () => uiHooks.shopBuy(btn.dataset.item));
  }
}

// ---- Pause ------------------------------------------------------------------------------------
// Abandoning a run is the one irreversible button in the game — permadeath is total, so there is
// no undo and nothing carries over — and it now sits in a screen CORNER, which is exactly where a
// thumb lands by accident while reaching for the map. So it takes two presses: the first arms it
// and relabels it, the second ends the run.
const QUIT_ARM_MS = 4000;
let quitArmed = false;
let quitTimer = null;

// Both labels are two lines, and both are set with innerHTML rather than textContent: the button
// sits in the screen's top-right corner and is kept narrow so the title can sit at the very top
// beside it (see --quit-w), which only works with the words stacked. The ARMED label is two lines
// as well — "Confirm?" over "End Run" rather than a bare "Confirm?" — so arming does not change
// the button's height under the finger that is about to press it again.
const QUIT_LABEL = 'Abandon<br>Run';
const QUIT_LABEL_ARMED = 'Confirm?<br>End Run';

function disarmQuit() {
  quitArmed = false;
  clearTimeout(quitTimer);
  const b = $('btn-quit');
  if (!b) return;
  b.innerHTML = QUIT_LABEL;
  b.classList.remove('armed');
}

export function renderPause() {
  const run = state.run;
  $('pause-sub').textContent = run
    ? `B${run.floorIndex + 1}F - ${run.floor.theme.name} - ${inv.partyAlive().length}/${inv.party().length} standing`
    : '';
  // Always opens disarmed. Leaving it armed across a close and reopen would mean one stray press
  // on a freshly opened pause screen could end the run, which is the whole thing this prevents.
  disarmQuit();
}

// ---- The pause map's rotate / zoom / pan gestures ----------------------------------------------
// One-finger drag pans, two-finger pinch zooms and twists, and the buttons under the map do the
// same things discoverably — the gestures alone would be invisible to anyone who did not try them,
// and the buttons alone would feel stiff on a phone.
function bindFloorMapGestures() {
  const el = $('floormap');
  const pointers = new Map();
  let lastMid = null, lastSpread = 0, lastAngle = 0;

  const mid = () => {
    const pts = [...pointers.values()];
    return {
      x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
      y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
    };
  };
  // The canvas is 620 backing pixels inside a CSS box of whatever size the panel resolved to, and
  // object-fit:contain letterboxes it. Gesture deltas have to be converted into canvas pixels or a
  // drag moves the map by the wrong amount on every screen size.
  const toCanvas = (d) => {
    const r = el.getBoundingClientRect();
    const shown = Math.min(r.width, r.height) || 1;
    return d * (el.width / shown);
  };

  el.addEventListener('pointerdown', (e) => {
    // Capture so a drag that leaves the canvas keeps panning instead of stopping dead at the edge.
    // Guarded because it throws on a pointer id the element does not actually own, and losing the
    // capture is survivable while losing the whole gesture handler is not.
    try { el.setPointerCapture(e.pointerId); } catch { /* drag still works, just not off-canvas */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastMid = mid();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      lastSpread = Math.hypot(a.x - b.x, a.y - b.y);
      lastAngle = Math.atan2(b.y - a.y, b.x - a.x);
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = mid();
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (lastSpread > 8 && spread > 8) {
        const r = el.getBoundingClientRect();
        // Zoom about the pinch's own midpoint, expressed relative to the canvas centre — the same
        // frame uiHooks.mapZoom treats its origin in.
        uiHooks.mapZoom(spread / lastSpread,
          toCanvas(m.x - (r.left + r.width / 2)), toCanvas(m.y - (r.top + r.height / 2)));
        // A twist of the two fingers rotates. Unwrapped through atan2's +-PI seam, or a small
        // twist across it spins the map most of the way round.
        let d = angle - lastAngle;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        uiHooks.mapRotate(d);
      }
      lastSpread = spread;
      lastAngle = angle;
    } else if (lastMid) {
      uiHooks.mapPan(toCanvas(m.x - lastMid.x), toCanvas(m.y - lastMid.y));
    }
    lastMid = m;
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    lastMid = pointers.size ? mid() : null;
    if (pointers.size < 2) lastSpread = 0;
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    uiHooks.mapZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12,
      toCanvas(e.clientX - (r.left + r.width / 2)), toCanvas(e.clientY - (r.top + r.height / 2)));
  }, { passive: false });
}

export function boot(hide = true) { $('boot').classList.toggle('hidden', hide); }

// ---- Wire up every static control --------------------------------------------------------------
export function bindUI() {
  const click = (id, fn) => $(id).addEventListener('click', fn);

  click('btn-start', () => { sfx('confirm'); uiHooks.startRun(); });
  click('btn-dex', () => { sfx('select'); uiHooks.openDex(); });
  click('btn-glossary-title', () => { sfx('select'); uiHooks.openGlossary(); });
  click('btn-settings-title', () => { sfx('select'); uiHooks.openSettings(); });

  click('btn-starter-go', () => {
    if (starterPick == null) return;
    sfx('confirm');
    uiHooks.chooseStarter(starterPick);
  });
  click('btn-starter-back', () => { sfx('back'); uiHooks.goTitle(); });

  click('btn-bag', () => { sfx('select'); uiHooks.openBag(); });
  click('btn-pause', () => { sfx('select'); uiHooks.openPause(); });
  // Tapping the minimap opens the pause screen, which is where the full floor map lives. The
  // minimap only shows a 34-cell window, so "I want to see the rest of it" is the obvious thing
  // to want when you look at it.
  click('minimap-wrap', () => { sfx('select'); uiHooks.openPause(); });

  click('btn-resume', () => { sfx('confirm'); uiHooks.resume(); });
  // The floor map has no buttons of its own — drag pans, pinch zooms, two fingers twist to rotate.
  bindFloorMapGestures();

  click('btn-shop-leave', () => { sfx('back'); uiHooks.shopLeave(); });
  click('btn-pause-bag', () => { sfx('select'); uiHooks.openBag(); });
  click('btn-pause-glossary', () => { sfx('select'); uiHooks.openGlossary(); });
  click('btn-pause-settings', () => { sfx('select'); uiHooks.openSettings(); });
  click('btn-quit', () => {
    if (!quitArmed) {
      quitArmed = true;
      const b = $('btn-quit');
      b.innerHTML = QUIT_LABEL_ARMED;
      b.classList.add('armed');
      sfx('select');
      quitTimer = setTimeout(disarmQuit, QUIT_ARM_MS);
      return;
    }
    disarmQuit();
    sfx('back');
    uiHooks.quitRun();
  });

  click('btn-bag-close', () => { sfx('back'); uiHooks.closeBag(); });
  click('btn-bag-use', () => {
    if (!bagSelectedItem) return;
    const mon = bagSelectedMon !== null ? inv.party()[bagSelectedMon] : null;
    uiHooks.useItem(bagSelectedItem, mon);
    renderBag2();
  });

  click('btn-glossary-back', () => { sfx('back'); uiHooks.back(); });
  click('btn-settings-back', () => { sfx('back'); uiHooks.back(); });
  click('btn-dex-back', () => { sfx('back'); uiHooks.back(); });

  const musicSlider = $('vol-music'), sfxSlider = $('vol-sfx');
  musicSlider.addEventListener('input', () => {
    state.settings.music = Number(musicSlider.value) / 100;
    $('vol-music-val').textContent = musicSlider.value + '%';
    applyVolumes();
    saveSettings();
  });
  sfxSlider.addEventListener('input', () => {
    state.settings.sfx = Number(sfxSlider.value) / 100;
    $('vol-sfx-val').textContent = sfxSlider.value + '%';
    saveSettings();
  });
  sfxSlider.addEventListener('change', () => sfx('select'));

  click('ctrl-joystick', () => { sfx('select'); uiHooks.setControls('joystick'); renderSettings(); });
  click('ctrl-tap', () => { sfx('select'); uiHooks.setControls('tap'); renderSettings(); });
  // Erase Records is gated on typing the word `reset`. The check is re-run on the Erase press
  // itself and not left to the button's `disabled` state, so the password is what performs the
  // erase rather than just what reveals the button.
  const passOk = () => $('reset-pass').value.trim().toLowerCase() === RESET_WORD;
  click('btn-reset-stats', () => { sfx('select'); setResetGate(true); $('reset-pass').focus(); });
  click('btn-reset-cancel', () => { sfx('back'); setResetGate(false); });
  $('reset-pass').addEventListener('input', () => { $('btn-reset-go').disabled = !passOk(); });
  $('reset-pass').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (passOk()) $('btn-reset-go').click();
  });
  click('btn-reset-go', () => {
    if (!passOk()) return;
    resetStats();
    saveStats();
    sfx('back');
    toast('Lifetime record erased.');
    setResetGate(false);
    renderSettings();
  });

  click('btn-battle-continue', () => { sfx('confirm'); uiHooks.battleContinue(); });
  click('btn-battle-swap', () => { sfx('select'); uiHooks.openSwitch(); });

  // The lead-Pokemon card on the dungeon HUD is the other way into the same screen.
  // The lead card toggles its own inline list rather than opening the full `switch` screen — see
  // setLeadMenu. The "nobody else to swap to" guard stays with the CALLER (main.js's
  // openLeadMenu), because it needs the party, and a list with one unpickable row in it is not an
  // answer to a tap.
  click('btn-lead', () => {
    if (leadMenuOpen) { sfx('back'); setLeadMenu(false); return; }
    uiHooks.openLeadMenu();
  });
  click('btn-switch-back', () => { sfx('back'); uiHooks.back(); });
  click('btn-catch-ball', () => { sfx('select'); toggleBallMenu(); });
  click('btn-catch-flee', () => { sfx('back'); setBallMenu(false); uiHooks.catchFlee(); });

  click('btn-swap-confirm', () => {
    if (swapSelected === null) return;
    sfx('confirm');
    uiHooks.resolveSwap(swapSelected);
  });
  click('btn-swap-release', () => { sfx('back'); uiHooks.resolveSwap(null); });

  click('btn-end-again', () => { sfx('confirm'); uiHooks.newRun(); });
  click('btn-end-title', () => { sfx('back'); uiHooks.goTitle(); });
}

export const minimapCtx = () => $('minimap').getContext('2d');
export const floormapCtx = () => $('floormap').getContext('2d');

// Match the pause map's BITMAP to the box it is displayed in, before drawing into it.
//
// This is what killed the two empty translucent bands above and below the map. The canvas shipped a
// fixed 620x620 bitmap and `object-fit: contain`, but its box is the panel's — 346x556 on a phone.
// Contain fitted the square bitmap into the tall box at 346x346 and centred it, which left 105px
// of the panel's own `rgba(255,255,255,0.06)` ground showing top and bottom: two semi-translucent
// strips with nothing in them, framed as if they held something.
//
// drawMap already handles a non-square canvas — it takes `Math.min(cw, ch)` for the scale and puts
// the origin at the box centre — so sizing the bitmap to the box makes the map FILL the panel, at
// the same scale as before, showing more floor above and below instead of dead plate.
//
// Called on every draw rather than once on open, which covers a rotate or a window resize while
// the pause screen is up. The width/height assignment is guarded because assigning either one
// clears the canvas, and it is a no-op reallocation of the drawing buffer besides.
export function syncFloorMapSize() {
  const cv = $('floormap');
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return false;                    // laid out but not visible yet: nothing to size to
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (cv.width === bw && cv.height === bh) return false;
  cv.width = bw; cv.height = bh;
  return true;
}
