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
  catchAgain: () => {},
  catchFlee: () => {},
  chooseBall: (_id) => {},
  resolveSwap: (_index) => {},
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
  end: 'screen-end',
};

export function showScreen(mode) {
  for (const id of Object.values(SCREEN_FOR_MODE)) $(id)?.classList.remove('visible');
  const target = SCREEN_FOR_MODE[mode];
  if (target) $(target).classList.add('visible');
  // The HUD is live during play and stays visible behind the catch overlay (which is transparent
  // by design so you can see the 3D mini-scene) but not behind any full sheet.
  $('hud').classList.toggle('visible', mode === 'playing');
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

// Called from the main loop so both rotating previews keep spinning while their screen is up.
export function updatePreviews(dt, mode) {
  if (mode === 'starter' && starterPreview) {
    starterPreview.holder.rotation.y += dt * 0.7;
    starterPreview.render();
  } else if (mode === 'dex' && dexPreview) {
    dexPreview.holder.rotation.y += dt * 0.7;
    dexPreview.render();
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
  $('starter-meta').innerHTML = `${c.types.join(' / ')} · ${c.stage} · No. ${String(c.dex).padStart(3, '0')}`;
  $('starter-row').querySelectorAll('.starter-card').forEach((el, idx) => {
    el.classList.toggle('selected', idx === i);
  });
  starterPreview.holder.rotation.y = 0;
  setPreviewModel(starterPreview.holder, starterPick, 1.5);
}

// ---- HUD --------------------------------------------------------------------------------------
export function updateHUD() {
  const run = state.run;
  if (!run) return;
  $('floor-num').textContent = String(run.floorIndex + 1);
  $('floor-theme').textContent = run.floor?.theme?.name || '—';

  const total = Object.values(run.bag).reduce((s, n) => s + n, 0);
  $('bag-count').textContent = String(total);

  const lead = inv.partyAlive()[0] || inv.party()[0];
  if (lead) {
    $('lead-name').textContent = lead.name;
    $('party-count').textContent = `· ${inv.partyAlive().length}/${inv.party().length}`;
    setHpBar($('lead-hpbar'), lead.hp, lead.maxHp);
  }

  const pills = [];
  const bonus = inv.currentAttackBonus();
  if (bonus > 0) {
    const left = Math.max(0, Math.ceil((run.attackBonusUntil - performance.now()) / 1000));
    pills.push(`<span class="buff-pill">X Attack +${bonus} · ${left}s</span>`);
  }
  if (inv.isRepelActive()) {
    const left = Math.max(0, Math.ceil((run.repelUntil - performance.now()) / 1000));
    pills.push(`<span class="buff-pill repel">Repel · ${left}s</span>`);
  }
  if (run.revives > 0) pills.push(`<span class="buff-pill">Revive ×${run.revives}</span>`);
  $('buff-strip').innerHTML = pills.join('');
}

function setHpBar(el, hp, maxHp) {
  const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
  el.querySelector('i').style.width = pct + '%';
  el.classList.toggle('mid', pct <= 50 && pct > 20);
  el.classList.toggle('low', pct <= 20);
}

export function setControlHint(mode) {
  $('tap-hint').classList.toggle('hidden', mode !== 'tap');
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

function renderTeamStrip(container, { selected = null, onPick = null, includeEmpty = true } = {}) {
  const p = inv.party();
  const cells = [];
  for (let i = 0; i < MAX_PARTY; i++) {
    const m = p[i];
    if (!m) {
      if (includeEmpty) cells.push(`<div class="team-slot empty"><div class="ts-name">—</div></div>`);
      continue;
    }
    const pct = Math.max(0, Math.min(100, (m.hp / m.maxHp) * 100));
    const barClass = pct <= 20 ? 'low' : pct <= 50 ? 'mid' : '';
    cells.push(`<div class="team-slot ${m.hp <= 0 ? 'fainted' : ''} ${selected === i ? 'selected' : ''}" data-i="${i}">
      <div class="ts-name">${m.name}</div>
      <div class="hpbar ${barClass}"><i style="width:${pct}%"></i></div>
      <div class="ts-hp">${m.hp}/${m.maxHp}</div>
      <div class="ts-dex">${m.stage}</div>
    </div>`);
  }
  container.innerHTML = cells.join('');
  if (onPick) {
    container.querySelectorAll('.team-slot[data-i]').forEach(el => {
      el.addEventListener('click', () => { sfx('select'); onPick(Number(el.dataset.i)); });
    });
  }
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
    detail.innerHTML = `<div class="id-name">—</div><div class="id-desc">Tap an item to see what it does.</div>`;
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
      : `<div class="id-desc" style="color:var(--gold)">Pick a Pokémon above first.</div>`;
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
    ['Runs', s.runsPlayed], ['Wins', s.runsWon], ['Best Floor', s.bestFloor ? 'B' + s.bestFloor + 'F' : '—'],
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
  else { $('dex-name').textContent = '—'; setPreviewModel(dexPreview.holder, -1); }
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
  $('dex-name').innerHTML = `${c.name}<span class="meta-inline">${c.types.join('/')} · ${tags.join(', ')}</span>`;
  $('dex-grid').querySelectorAll('.dex-cell').forEach(el => {
    el.classList.toggle('selected', Number(el.dataset.dex) === dex);
  });
  dexPreview.holder.rotation.y = 0;
  if (hasModelForDex(dex)) setPreviewModel(dexPreview.holder, dex, 1.5);
}

// ---- Battle -----------------------------------------------------------------------------------
export function renderBattle(battle) {
  $('battle-foe').innerHTML = battle.kind === 'giovanni'
    ? `<span class="vs">GIOVANNI</span>`
    : battle.kind === 'wild' ? battle.title : `<span class="vs">${battle.title}</span>`;
  $('battle-sub').textContent = battle.kind === 'wild' ? 'blocks your path!' : 'wants to battle!';
  $('btn-battle-continue').style.display = 'none';
  $('battle-log').textContent = 'Battle start!';
  renderCombatSide($('enemy-side'), battle.enemies, battle.enemyIndex);
  renderCombatSide($('party-side'), battle.party, battle.partyIndex);
}

function renderCombatSide(container, team, leadIndex) {
  container.innerHTML = team.map((m, i) => {
    const pct = Math.max(0, Math.min(100, (m.hp / m.maxHp) * 100));
    const barClass = pct <= 20 ? 'low' : pct <= 50 ? 'mid' : '';
    return `<div class="combat-row ${i === leadIndex && m.hp > 0 ? 'lead' : ''} ${m.hp <= 0 ? 'fainted' : ''}" data-i="${i}">
      <div class="cr-main">
        <div class="cr-name">${m.name}</div>
        <div class="hpbar ${barClass}"><i style="width:${pct}%"></i></div>
        <div class="cr-hpnum">${m.hp} / ${m.maxHp} HP · ${m.types.join('/')}</div>
      </div>
      <div class="cr-stage">${m.stage === 'Legendary' ? 'LGND' : m.stage.toUpperCase()}</div>
    </div>`;
  }).join('');
}

export function updateBattleRows(battle) {
  renderCombatSide($('enemy-side'), battle.enemies, battle.enemyIndex);
  renderCombatSide($('party-side'), battle.party, battle.partyIndex);
}

export function battleLog(html) { $('battle-log').innerHTML = html; }

export function showBattleContinue(label = 'Continue') {
  const b = $('btn-battle-continue');
  b.textContent = label;
  b.style.display = 'block';
}

// A damage number that floats off the row that just got hit.
export function floatDamage(side, index, dmg, superEff) {
  const container = side === 'enemy' ? $('enemy-side') : $('party-side');
  const row = container.querySelector(`.combat-row[data-i="${index}"]`);
  if (!row) return;
  row.classList.add('hurt');
  setTimeout(() => row.classList.remove('hurt'), 160);
  const el = document.createElement('div');
  el.className = 'float-dmg' + (superEff ? ' se' : '');
  el.textContent = `-${dmg}`;
  const r = row.getBoundingClientRect();
  el.style.left = (r.right - 54) + 'px';
  el.style.top = (r.top + 6) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

// ---- Catch overlay ----------------------------------------------------------------------------
export function renderCatchUI({ dex, activeBall, msg = null, showAgain = false, hint = null }) {
  const c = CATALOG_BY_DEX.get(dex);
  $('catch-name').textContent = c ? `Wild ${c.name}` : 'Wild Pokémon';
  $('catch-sub').innerHTML = c ? `${c.types.join(' / ')} · ${c.stage}` : '';
  const msgEl = $('catch-msg');
  msgEl.classList.toggle('hidden', !msg);
  if (msg) msgEl.textContent = msg;
  $('catch-hint').textContent = hint || 'Land it in the shrinking ring · swirl first to curve';
  $('btn-catch-again').style.display = showAgain ? 'block' : 'none';

  const chips = BALL_IDS.filter(id => inv.countOf(id) > 0).map(id => {
    const item = ITEM_BY_ID.get(id);
    return `<div class="ball-chip ${id === activeBall ? 'active' : ''}" data-id="${id}">
      ${item.svg}<span>×${inv.countOf(id)}</span></div>`;
  });
  $('catch-balls').innerHTML = chips.length ? chips.join('') : `<div class="ball-chip">No balls left!</div>`;
  $('catch-balls').querySelectorAll('.ball-chip[data-id]').forEach(el => {
    el.addEventListener('click', () => { sfx('select'); uiHooks.chooseBall(el.dataset.id); });
  });
}

export function setCatchFleeLabel(label) { $('btn-catch-flee').textContent = label; }

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
  $('swap-sub').textContent = `You caught ${newMon.name} (${newMon.types.join('/')}, ${newMon.stage}) — but you are already carrying ${MAX_PARTY}.`;
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
      ? `You walked away on B${floorReached}F. Your team and everything you were carrying stay down there — that is the deal.`
      : `Your team fell on B${floorReached}F. Everything you were carrying is gone — that is the deal down here.`;
  $('end-stats').innerHTML = [
    ['Floor', 'B' + floorReached + 'F'],
    ['Caught', caught],
    ['Best Ever', state.stats.bestFloor ? 'B' + state.stats.bestFloor + 'F' : '—'],
  ].map(([l, v]) => `<div class="stat-tile"><div class="sv">${v}</div><div class="sl">${l}</div></div>`).join('');
}

// ---- Pause ------------------------------------------------------------------------------------
export function renderPause() {
  const run = state.run;
  $('pause-sub').textContent = run
    ? `B${run.floorIndex + 1}F · ${run.floor.theme.name} · ${inv.partyAlive().length}/${inv.party().length} standing`
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
  click('btn-catch-again', () => { sfx('select'); uiHooks.catchAgain(); });
  click('btn-catch-flee', () => { sfx('back'); uiHooks.catchFlee(); });

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
