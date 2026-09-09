// Every screen's DOM: building it, filling it, and toggling between them.
//
// The pattern is the one Rumble Run used and it holds up: plain absolutely-positioned
// `<div class="screen">` siblings, exactly one carrying `.visible` at a time, switched by a single
// function. Nothing here knows about the game loop — main.js registers callbacks on `uiHooks` and
// this module only ever calls those.
import { state, MAX_PARTY, saveSettings, saveStats, resetStats } from './state.js';
import { ITEMS, ITEM_BY_ID, BALL_IDS } from './data/items.js';
import { CATALOG_BY_DEX } from './data/pokemon-catalog.js';
import { typeIconPath } from './data/type-chart.js';
import { createPreview } from './three-setup.js';
import { setPreviewModel, hasModelForDex } from './models.js';
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
  newRun: () => {},
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

let bannerTimer = null;
export function banner({ kicker, main, sub, ms = 1700 }) {
  $('banner-kicker').textContent = kicker;
  $('banner-main').textContent = main;
  $('banner-sub').textContent = sub || '';
  $('banner').classList.add('visible');
  clearTimeout(bannerTimer);
  return new Promise(resolve => {
    bannerTimer = setTimeout(() => {
      $('banner').classList.remove('visible');
      resolve();
    }, ms);
  });
}

export function hideBanner() {
  clearTimeout(bannerTimer);
  $('banner').classList.remove('visible');
}

// ---- 3D previews (starter select + Pokedex) ----------------------------------------------------
let starterPreview = null, dexPreview = null;

function ensurePreviews() {
  if (!starterPreview) starterPreview = createPreview($('starter-preview'), { frustum: 1.25 });
  if (!dexPreview) dexPreview = createPreview($('dex-preview'), { frustum: 1.25 });
}

// Called from the main loop so every screen that owns a 3D canvas keeps rendering while it is up.
export function updatePreviews(dt, mode) {
  if (mode === 'starter' && starterPreview) {
    starterPreview.holder.rotation.y += dt * 0.7;
    starterPreview.render();
  } else if (mode === 'dex' && dexPreview) {
    dexPreview.holder.rotation.y += dt * 0.7;
    dexPreview.render();
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
  $('starter-meta').innerHTML = `${c.types.join(' / ')} - ${c.stage} - No. ${String(c.dex).padStart(3, '0')}`;
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
export function renderSettings() {
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

function ensureBattlePreviews() {
  // frustum 0.9 leaves a little air around a model fitted to 1.0 tall.
  if (!foePreview) foePreview = createPreview($('foe-model'), { frustum: 0.9 });
  if (!youPreview) youPreview = createPreview($('you-model'), { frustum: 0.9 });
}

export function renderBattle(battle) {
  ensureBattlePreviews();
  foeShownDex = null;
  youShownDex = null;
  fieldBob = 0;

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

function syncFighter(side, mon, preview, getShown, setShown) {
  const wrap = $(`${side}-fighter`);
  if (!mon || !preview) return;
  wrap.classList.toggle('fainted', mon.hp <= 0);
  if (getShown() === mon.dex) return;
  setShown(mon.dex);
  // Your side is turned to face AWAY from the camera — that is the back view.
  preview.holder.rotation.y = side === 'you' ? Math.PI : 0;
  setPreviewModel(preview.holder, mon.dex, 1.0);
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
  foePreview.render();
  youPreview.render();
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

// A damage number that floats off whichever side just got hit — over that side's info box, where
// the HP bar the player is watching actually is.
export function floatDamage(side, _index, dmg, superEff) {
  const box = side === 'enemy' ? $('foe-box') : $('you-box');
  if (!box) return;
  box.classList.add('hurt');
  $(`${side === 'enemy' ? 'foe' : 'you'}-fighter`)?.classList.add('hurt');
  setTimeout(() => {
    box.classList.remove('hurt');
    $(`${side === 'enemy' ? 'foe' : 'you'}-fighter`)?.classList.remove('hurt');
  }, 160);
  const el = document.createElement('div');
  el.className = 'float-dmg' + (superEff ? ' se' : '');
  el.textContent = `-${dmg}`;
  const r = box.getBoundingClientRect();
  el.style.left = (r.right - 62) + 'px';
  el.style.top = (r.top + 6) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

// ---- Party switch ------------------------------------------------------------------------------
// One screen for both callers: the Swap button in battle and the lead-Pokemon card on the dungeon
// HUD. A fainted member is not offered — there is nothing it can do on either side of that call.
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

// ---- Pause ------------------------------------------------------------------------------------
export function renderPause() {
  const run = state.run;
  $('pause-sub').textContent = run
    ? `B${run.floorIndex + 1}F - ${run.floor.theme.name} - ${inv.partyAlive().length}/${inv.party().length} standing`
    : '';
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

  click('btn-resume', () => { sfx('confirm'); uiHooks.resume(); });
  click('btn-pause-bag', () => { sfx('select'); uiHooks.openBag(); });
  click('btn-pause-glossary', () => { sfx('select'); uiHooks.openGlossary(); });
  click('btn-pause-settings', () => { sfx('select'); uiHooks.openSettings(); });
  click('btn-quit', () => { sfx('back'); uiHooks.quitRun(); });

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
  click('btn-reset-stats', () => {
    resetStats();
    saveStats();
    sfx('back');
    toast('Lifetime record erased.');
    renderSettings();
  });

  click('btn-battle-continue', () => { sfx('confirm'); uiHooks.battleContinue(); });
  click('btn-battle-swap', () => { sfx('select'); uiHooks.openSwitch(); });

  // The lead-Pokemon card on the dungeon HUD is the other way into the same screen.
  click('btn-lead', () => { sfx('select'); uiHooks.openSwitch(); });
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
