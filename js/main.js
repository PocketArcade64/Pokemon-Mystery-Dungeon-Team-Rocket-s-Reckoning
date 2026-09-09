// State machine + the single requestAnimationFrame loop. This is the only module that knows the
// whole game; everything else is a self-contained system it drives.
import * as THREE from 'three';
import { state, makeMon, saveSettings, saveStats, recordDex, FLOORS_PER_RUN, MAX_PARTY } from './state.js';
import { renderer, scene, camera, canvas, followCamera, resetCameraFollow, onViewportChange } from './three-setup.js';
import { createMonObject, disposeObject, preloadDex } from './models.js';
import { STARTER_DEX, CATALOG_BY_DEX } from './data/pokemon-catalog.js';
import { ITEM_BY_ID } from './data/items.js';
import {
  generateFloor, buildFloor, disposeFloor, pickRunThemes, cellToWorld, cellValue, FLOOR,
  moveWithCollision, revealAround, updateWilds, updateFloorDecor, itemAtPlayer, wildAtPlayer,
  atStairs, drawMap, makeTrainerFigure,
} from './dungeon.js';
import { createInput } from './movement.js';
import { createBattle, generateGruntTeam, generateGiovanniTeam, wildEnemyTeam, describeTeam } from './battle.js';
import { startCatch, endCatch, updateCatch, setCatchBall, catchState, catchScene, catchCamera,
         catchPointerDown, catchPointerMove, catchPointerUp } from './catch.js';
import * as inv from './inventory.js';
import * as ui from './ui-screens.js';
import { uiHooks } from './ui-screens.js';
import { unlockAudio, playMusic, musicForMode, prefetchMusic, releaseMusic, sfx, applyVolumes } from './audio.js';

const PLAYER_SPEED = 4.7;
const player = { x: 0, z: 0 };
let playerObj = null, playerObjDex = null;
let elapsed = 0;
let battle = null;
let battleCtx = null;      // { kind, wild }
let catchCtx = null;       // { wild }

// ---- Mode switching ---------------------------------------------------------------------------
function setMode(next, { returnTo = null } = {}) {
  if (returnTo) state.returnTo = returnTo;
  state.mode = next;
  ui.showScreen(next);
  input.setEnabled(next === 'playing');
  if (next !== 'playing') ui.hideBanner();

  switch (next) {
    case 'title':
      teardownRun();
      break;
    case 'starter':
      ui.renderStarterSelect(offerStarters());
      break;
    case 'playing':
      ui.setControlHint(state.settings.controls);
      ui.updateHUD();
      break;
    case 'pause':
      ui.renderPause();
      drawFloorMap();
      break;
    case 'bag':
      ui.renderBag();
      break;
    case 'glossary':
      ui.renderGlossary();
      break;
    case 'settings':
      ui.renderSettings();
      break;
    case 'dex':
      ui.renderDex();
      break;
    default:
      break;
  }

  const key = musicForMode(next, {
    themeId: state.run?.floor?.theme?.id ?? null,
    battleKind: battleCtx?.kind ?? null,
  });
  if (key) playMusic(key);
}

// ---- Run lifecycle ----------------------------------------------------------------------------
// Three starters offered at random out of the 16-strong pool (design brief §3).
function offerStarters() {
  const pool = STARTER_DEX.slice();
  const offer = [];
  while (offer.length < 3 && pool.length) {
    offer.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  preloadDex(offer);
  return offer;
}

function beginRun(starterDex) {
  state.run = {
    themes: pickRunThemes(FLOORS_PER_RUN),
    floorIndex: -1,
    floor: null,
    party: [makeMon(starterDex)],
    bag: inv.startingBag(),
    activeBall: null,
    attackBonus: 0,
    attackBonusUntil: 0,
    repelUntil: 0,
    revives: 0,
    caught: 0,
    pendingCatch: null,
  };
  state.stats.runsPlayed++;
  recordDex('seenDex', starterDex);
  recordDex('caughtDex', starterDex);   // your partner counts as one you have had
  saveStats();
  enterFloor(0);
}

// Permadeath: nothing carries over. The run object is dropped whole and the next one is built
// from scratch — no items, no unlocks, no leftover party.
function teardownRun() {
  if (state.run?.floor) disposeFloor(state.run.floor);
  if (playerObj) { disposeObject(playerObj); playerObj = null; playerObjDex = null; }
  state.run = null;
  battle = null;
  battleCtx = null;
  catchCtx = null;
  endCatch();
}

function enterFloor(index) {
  const run = state.run;
  const leavingTheme = run.floor?.theme?.id ?? null;
  if (run.floor) disposeFloor(run.floor);

  const theme = run.themes[index];
  const floor = generateFloor(index + 1, theme);
  run.floor = floor;
  run.floorIndex = index;
  scene.add(buildFloor(floor));

  // The floor boss stands ON the up-stairs tile, so you cannot ascend without going through them.
  const isFinal = index === FLOORS_PER_RUN - 1;
  prefetchMusic(isFinal ? 'giovanni' : 'grunt');
  const fig = isFinal
    ? makeTrainerFigure({ suit: 0x23232b, accent: 0xf5a623, hair: 0x14141a, scale: 1.2 })
    : makeTrainerFigure({ suit: 0x1d1d24, accent: 0xd8202a, scale: 1.0 });
  const sw = cellToWorld(floor, floor.stairsCell.x, floor.stairsCell.y);
  fig.position.set(sw.x, 0.54, sw.z);   // 0.54 = top of the three stair steps
  fig.rotation.y = Math.PI * 0.75;      // face back down the diagonal, toward the camera
  floor.group.add(fig);
  floor.boss = { obj: fig, defeated: false, kind: isFinal ? 'giovanni' : 'grunt' };

  const start = cellToWorld(floor, floor.startCell.x, floor.startCell.y);
  player.x = start.x; player.z = start.z;
  input.setContext(floor, player);
  resetCameraFollow();
  followCamera(player.x, player.z, 1);
  syncPlayerModel();
  revealAround(floor, player.x, player.z, 7);

  // Everything that wanders this floor counts as "seen" for the lifetime Pokedex.
  for (const w of floor.wilds) recordDex('seenDex', w.dex);
  if (index + 1 > state.stats.bestFloor) state.stats.bestFloor = index + 1;
  saveStats();

  setMode('playing');
  // Only now that the new theme is the one playing: a run walks through up to eleven of these and
  // each decoded theme is tens of megabytes, so the floor we just left gives its buffer back.
  if (leavingTheme && leavingTheme !== theme.id) releaseMusic(leavingTheme);
  ui.banner({
    kicker: isFinal ? 'The Bottom' : 'Descending',
    main: theme.name,
    sub: isFinal ? `Basement Floor ${index + 1} - Giovanni is here` : `Basement Floor ${index + 1}`,
    ms: 1800,
  });
}

function advanceFloor() {
  const run = state.run;
  if (run.floorIndex + 1 >= FLOORS_PER_RUN) { winRun(); return; }
  sfx('stairs');
  ui.banner({ kicker: 'Floor Clear', main: 'Up the stairs', sub: 'The way down opens', ms: 1200 })
    .then(() => { if (state.run) enterFloor(run.floorIndex + 1); });
}

// The lead Pokemon is what you actually steer, so the model has to follow party changes
// (a faint, an evolution, a swap after a catch).
function syncPlayerModel() {
  const lead = inv.partyAlive()[0] || inv.party()[0];
  if (!lead) return;
  if (playerObj && playerObjDex === lead.dex) return;
  if (playerObj) disposeObject(playerObj);
  const height = lead.stage === 'Stage2' ? 1.15 : lead.stage === 'Stage1' ? 1.0 : 0.88;
  playerObj = createMonObject(lead.dex, { height, tint: 0xf5c74a });
  playerObj.position.set(player.x, 0, player.z);
  scene.add(playerObj);
  playerObjDex = lead.dex;
}

function winRun() {
  const run = state.run;
  state.stats.runsWon++;
  state.stats.giovanniDefeats++;
  for (const m of inv.partyAlive()) recordDex('winnerDex', m.dex);
  saveStats();
  // No sting here: the victory fanfare has been playing since Giovanni went down, and the win
  // screen carries it over.
  ui.renderEnd({
    won: true,
    floorReached: run.floorIndex + 1,
    caught: run.caught,
    partyNames: inv.partyAlive().map(m => m.name),
  });
  setMode('end');
}

function loseRun({ abandoned = false } = {}) {
  const run = state.run;
  saveStats();
  sfx('defeat');
  ui.renderEnd({
    won: false,
    abandoned,
    floorReached: run.floorIndex + 1,
    caught: run.caught,
    partyNames: [],
  });
  setMode('end');
  playMusic(null);          // the game-over screen is silent
}

// ---- Battles ----------------------------------------------------------------------------------
function startBattle(kind, wild = null) {
  const run = state.run;
  let enemies, title;
  if (kind === 'giovanni') { enemies = generateGiovanniTeam(); title = 'Giovanni'; }
  else if (kind === 'grunt') { enemies = generateGruntTeam(run.floorIndex + 1); title = 'Team Rocket Grunt'; }
  else { enemies = wildEnemyTeam(wild.dex, run.floorIndex + 1); title = `Wild ${CATALOG_BY_DEX.get(wild.dex).name}`; }

  for (const e of enemies) recordDex('seenDex', e.dex);
  saveStats();

  battleCtx = { kind, wild };
  battle = createBattle({
    party: inv.party(),
    enemies,
    kind,
    title,
    attackBonus: inv.currentAttackBonus(),
    revives: run.revives,
  });
  sfx('encounter');
  setMode('battle');
  ui.renderBattle(battle);
  if (kind !== 'wild') ui.battleLog(`${title} sent out ${describeTeam(enemies)}!`);
}

function updateBattleFrame(dtMs) {
  if (!battle) return;
  const events = battle.step(dtMs);
  for (const ev of events) {
    if (ev.type === 'hit') {
      const side = ev.side === 'party' ? 'enemy' : 'party';
      const idx = side === 'enemy' ? battle.enemies.indexOf(ev.defender) : battle.party.indexOf(ev.defender);
      ui.floatDamage(side, idx, ev.dmg, ev.superEff);
      ui.updateBattleRows(battle);
      ui.battleLog(`${ev.attacker.name} struck ${ev.defender.name} for ${ev.dmg}` +
        (ev.superEff ? ` <span class="se">- super effective!</span>` : '.'));
      sfx(ev.superEff ? 'superhit' : 'hit');
    } else if (ev.type === 'faint') {
      ui.updateBattleRows(battle);
      ui.battleLog(`${ev.mon.name} fainted!`);
      sfx('faint');
    } else if (ev.type === 'revive') {
      ui.updateBattleRows(battle);
      ui.battleLog(`${ev.mon.name} was pulled back from the brink by a Revive!`);
      state.run.revives = battle.revives;
      sfx('evolve');
    } else if (ev.type === 'switch') {
      ui.updateBattleRows(battle);
      ui.battleLog(`${ev.mon.name} steps up!`);
    } else if (ev.type === 'end') {
      finishBattle(ev.result);
    }
  }
}

function finishBattle(result) {
  state.run.revives = battle.revives;
  const ctx = battleCtx;
  if (result === 'lose') {
    ui.battleLog('Your whole team has fainted...');
    ui.showBattleContinue('See how far you got');
    return;
  }
  // Win. Beating Team Rocket — a Grunt or Giovanni — earns the victory fanfare, which plays over
  // the result text until you tap Continue. A worn-down wild is not a Rocket win, and its theme
  // has to carry straight on into the catch minigame, so that branch leaves the music alone.
  if (ctx.kind === 'wild') {
    ui.battleLog(`${ctx.wild ? CATALOG_BY_DEX.get(ctx.wild.dex).name : 'It'} is worn down - now is your chance!`);
    ui.showBattleContinue('Throw a Ball');
  } else if (ctx.kind === 'grunt') {
    playMusic('victory');
    state.stats.gruntsDefeated++;
    saveStats();
    ui.battleLog('The Grunt scrambles off the stairs!');
    ui.showBattleContinue('Take the stairs');
  } else {
    playMusic('victory');
    ui.battleLog('Giovanni is beaten. The dungeon is yours.');
    ui.showBattleContinue('Finish the run');
  }
}

// The "Continue" button under the battle overlay resolves whatever the battle led to.
function onBattleContinue() {
  const ctx = battleCtx;
  const won = battle?.result === 'win';
  syncPlayerModel();

  if (!won) { loseRun(); return; }

  if (ctx.kind === 'wild') {
    ctx.wild.defeated = true;
    beginCatch(ctx.wild);
    return;
  }
  if (ctx.kind === 'grunt') {
    knockOutBoss();
    setMode('playing');
    advanceFloor();
    return;
  }
  knockOutBoss();
  winRun();
}

// Lay the trainer figure out flat and shove it clear of the stairs.
function knockOutBoss() {
  const floor = state.run?.floor;
  if (!floor?.boss) return;
  floor.boss.defeated = true;
  floor.cleared = true;
  const fig = floor.boss.obj;
  fig.rotation.z = Math.PI / 2;
  fig.position.y = 0.3;
  fig.position.x += 1.6;
}

// ---- Catch minigame ---------------------------------------------------------------------------
function beginCatch(wild) {
  const ballId = inv.activeBall();
  if (!ballId) {
    ui.toast('You have no Poke Balls left!');
    // Leave the wild alone for a while so you are not stuck bumping into it with an empty bag,
    // and send it walking off rather than leaving it standing in your footprint.
    wild.cooldownUntil = performance.now() + 10000;
    sendWildAway(wild);
    setMode('playing');
    return;
  }
  catchCtx = { wild };
  startCatch({
    dex: wild.dex,
    ballId,
    ballsLeft: inv.countOf(ballId),
    floorNumber: state.run.floorIndex + 1,
    // The encounter stage is dressed as the floor you are standing on.
    theme: state.run.floor.theme,
    onThrow: () => {
      const id = catchState.ballId;
      if (inv.countOf(id) <= 0) return false;
      inv.removeItem(id, 1);
      sfx(catchState.spin !== 0 ? 'curve' : 'throw');
      ui.renderCatchUI({ dex: wild.dex, activeBall: id });
      return true;
    },
    onResult: onCatchResult,
    // The capture beats, fired by catch.js on the animation itself so the sound lands with the
    // frame rather than a fixed delay after it.
    onSfx: (name) => sfx(name),
    // GO hands you a fresh ball on its own after a failed throw. Returning null means the bag is
    // empty: catch.js parks in its 'empty' phase and the Run button is all that is left.
    onRearm: () => {
      const id = inv.activeBall();
      if (!id) return null;
      ui.renderCatchUI({ dex: wild.dex, activeBall: id });
      return { ballId: id, ballsLeft: inv.countOf(id) };
    },
    onGrade: (label) => {
      // The grade lands the instant the ball touches, well before the wobbles resolve — that
      // read-ahead is most of what makes a good GO throw feel good.
      sfx(label.includes('EXCELLENT') ? 'excellent' : label.includes('GREAT') ? 'great' : 'nice');
      ui.flashCatchGrade(label);
    },
  });
  setMode('catch');
  ui.renderCatchUI({ dex: wild.dex, activeBall: ballId });
}

// Point a wild away from the player and let it walk off. Used when an encounter cannot start — a
// wanderer left standing inside the player reads as broken.
function sendWildAway(wild) {
  const dx = wild.x - player.x, dz = wild.z - player.z;
  const d = Math.hypot(dx, dz) || 1;
  wild.dirX = dx / d; wild.dirZ = dz / d;
  wild.retarget = 2.5;
}

function onCatchResult(res) {
  const wild = catchCtx?.wild;
  if (!wild) return;

  if (res.caught) {
    sfx('caught');
    state.run.caught++;
    wild.gone = true;
    disposeObject(wild.obj);
    const outcome = inv.addCaught(res.dex);
    // Let the lock click, its shimmer and the fanfare all land before the screen changes.
    setTimeout(() => {
      endCatch();
      if (outcome.needsSwap) {
        ui.renderSwap(outcome.mon);
        setMode('swap');
      } else {
        syncPlayerModel();
        setMode('playing');
        const bonus = [res.curve ? 'Curveball' : null, res.grade && res.grade !== 'hit' ? res.grade : null]
          .filter(Boolean).join(' + ');
        ui.toast(bonus ? `${res.msg} (${bonus})` : `${res.msg} Added to your team.`);
      }
    }, 1500);
    return;
  }

  // Failed throw. catch.js re-arms by itself after a beat (onRearm above), exactly as GO does, and
  // the scene has already shown what happened — the only thing left is the sound and the ball
  // count on the swap button.
  sfx(res.reason === 'broke' ? 'broke' : res.reason === 'deflect' ? 'deflect' : 'select');
  ui.renderCatchUI({ dex: wild.dex, activeBall: inv.activeBall() });
}

// Running ends the encounter for good: the wild LEAVES THE FLOOR. It used to be parked on a
// cooldown and left standing where it was, which meant it promptly walked straight through the
// player — there is no wild-vs-player collision, and a cooldown only suppresses the encounter,
// not the body.
function onCatchFlee() {
  const wild = catchCtx?.wild;
  endCatch();
  if (wild && !wild.gone) {
    wild.gone = true;
    disposeObject(wild.obj);
    wild.obj = null;
    ui.toast(`${CATALOG_BY_DEX.get(wild.dex)?.name || 'It'} slipped away.`);
  }
  catchCtx = null;
  setMode('playing');
}

// ---- The playing-mode frame -------------------------------------------------------------------
function updatePlaying(dt) {
  const run = state.run;
  const floor = run.floor;
  if (!floor) return;

  const dir = input.update(floor, player, dt);
  if (dir.magnitude > 0) {
    moveWithCollision(floor, player, dir.x * PLAYER_SPEED * dt, dir.z * PLAYER_SPEED * dt);
    if (playerObj) playerObj.rotation.y = Math.atan2(dir.x, dir.z);
  }
  if (playerObj) {
    playerObj.position.set(player.x, 0, player.z);
    // A small walk bob — the Quest models have no animation of their own.
    playerObj.position.y = dir.magnitude > 0 ? Math.abs(Math.sin(elapsed * 11)) * 0.07 : 0;
  }

  revealAround(floor, player.x, player.z, 6);
  updateWilds(floor, dt, player, { repelled: inv.isRepelActive() });
  updateFloorDecor(floor, dt, elapsed);
  followCamera(player.x, player.z, dt);

  // Item pickup.
  const it = itemAtPlayer(floor, player);
  if (it) {
    it.taken = true;
    if (it.obj) it.obj.visible = false;
    inv.addItem(it.itemId, 1);
    sfx('pickup');
    ui.toast(`Found ${ITEM_BY_ID.get(it.itemId).name}!`);
  }

  // The up-stairs, and whoever is standing on them.
  if (atStairs(floor, player)) {
    if (!floor.boss.defeated) {
      startBattle(floor.boss.kind);
      return;
    }
    advanceFloor();
    return;
  }

  // Wild encounters. Max Repel suppresses them entirely while it is up.
  if (!inv.isRepelActive()) {
    const wild = wildAtPlayer(floor, player);
    const now = performance.now();
    if (wild && !(wild.cooldownUntil && now < wild.cooldownUntil)) {
      // Aggressive wanderers force a battle first; winning it unlocks the catch minigame.
      if (wild.aggressive && !wild.defeated) startBattle('wild', wild);
      else beginCatch(wild);
      return;
    }
  }

  if (inv.isPartyWiped()) { loseRun(); return; }
  ui.updateHUD();
  drawMap(ui.minimapCtx(), floor, player);
}

function drawFloorMap() {
  const floor = state.run?.floor;
  if (floor) drawMap(ui.floormapCtx(), floor, player, { detail: true });
}

// ---- Item hooks that need main's state --------------------------------------------------------
inv.hooks.revealMap = () => { if (state.run?.floor) state.run.floor.mapRevealed = true; };
inv.hooks.revealEntities = () => { if (state.run?.floor) state.run.floor.entitiesRevealed = true; };
inv.hooks.toast = (msg) => ui.toast(msg);
inv.hooks.warpToStairs = () => {
  const floor = state.run?.floor;
  if (!floor) return;
  // Land just off the stairs rather than on them: an Escape Rope should not shove you straight
  // into the boss fight before you have had a chance to heal up.
  const s = floor.stairsCell;
  for (const r of [3, 4, 2, 5]) {
    for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      if (cellValue(floor, s.x + dx, s.y + dy) !== FLOOR) continue;
      const w = cellToWorld(floor, s.x + dx, s.y + dy);
      player.x = w.x; player.z = w.z;
      resetCameraFollow();
      followCamera(player.x, player.z, 1);
      revealAround(floor, player.x, player.z, 7);
      return;
    }
  }
};

// ---- Input ------------------------------------------------------------------------------------
const input = createInput({
  canvas,
  joystickRoot: document.getElementById('joystick'),
  joystickKnob: document.getElementById('joystick-knob'),
  camera,
});
input.setMode(state.settings.controls);
input.onTapMarker((_world, ok) => { if (!ok) ui.toast('No route there.'); });

// Catch-minigame throw gestures go straight to the canvas — the catch overlay is pointer-through
// except for its own buttons, so a grab-and-flick anywhere on the play area drives the ball.
// The canvas size goes in on EVERY event, not just the release: the held ball tracks the finger
// in canvas-relative units, so a move arriving before any release still needs the measurements.
function catchPoint(e) {
  const t = e.changedTouches ? e.changedTouches[0] : (e.touches ? e.touches[0] : e);
  return { x: t.clientX, y: t.clientY };
}
const cw = () => canvas.clientWidth;
const chh = () => canvas.clientHeight;
canvas.addEventListener('touchstart', (e) => {
  if (state.mode !== 'catch') return;
  const p = catchPoint(e);
  catchPointerDown(p.x, p.y, cw(), chh());
}, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  if (state.mode !== 'catch') return;
  const p = catchPoint(e);
  catchPointerMove(p.x, p.y, cw(), chh());
}, { passive: true });
canvas.addEventListener('touchend', (e) => {
  if (state.mode !== 'catch') return;
  const p = catchPoint(e);
  catchPointerUp(p.x, p.y, cw(), chh());
}, { passive: true });
canvas.addEventListener('mousedown', (e) => {
  if (state.mode === 'catch') catchPointerDown(e.clientX, e.clientY, cw(), chh());
});
window.addEventListener('mousemove', (e) => {
  if (state.mode === 'catch') catchPointerMove(e.clientX, e.clientY, cw(), chh());
});
window.addEventListener('mouseup', (e) => {
  if (state.mode === 'catch') catchPointerUp(e.clientX, e.clientY, cw(), chh());
});

// iOS refuses to start any audio before a real user gesture touches the graph.
const unlock = () => { unlockAudio(); applyVolumes(); };
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('touchstart', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });

// ---- UI callbacks -----------------------------------------------------------------------------
Object.assign(uiHooks, {
  startRun: () => setMode('starter'),
  chooseStarter: (dex) => beginRun(dex),
  goTitle: () => setMode('title', { returnTo: 'title' }),
  resume: () => setMode('playing'),
  quitRun: () => { if (state.run) loseRun({ abandoned: true }); else setMode('title'); },
  openPause: () => setMode('pause'),
  openBag: () => setMode('bag', { returnTo: state.mode === 'pause' ? 'pause' : 'playing' }),
  closeBag: () => setMode(state.returnTo === 'pause' ? 'pause' : 'playing'),
  openGlossary: () => setMode('glossary', { returnTo: state.mode }),
  openSettings: () => setMode('settings', { returnTo: state.mode }),
  openDex: () => setMode('dex', { returnTo: state.mode }),
  back: () => setMode(state.returnTo === 'playing' && !state.run ? 'title' : state.returnTo),
  useItem: (itemId, mon) => {
    const res = inv.useItem(itemId, mon);
    ui.toast(res.msg);
    if (res.ok) {
      const item = ITEM_BY_ID.get(itemId);
      sfx(itemId === 'rare-candy' ? 'evolve' : 'confirm');
      syncPlayerModel();
      ui.updateHUD();
      // Field items act on the dungeon, so drop straight back into it to see the effect.
      if (item.kind === 'field') setMode('playing');
    } else {
      sfx('back');
    }
  },
  setControls: (m) => {
    state.settings.controls = m;
    saveSettings();
    input.setMode(m);
    ui.setControlHint(m);
  },
  battleContinue: onBattleContinue,
  catchFlee: onCatchFlee,
  chooseBall: (id) => {
    inv.itemApi.setActiveBall(id);
    setCatchBall(id, inv.countOf(id));
    if (catchCtx) ui.renderCatchUI({ dex: catchCtx.wild.dex, activeBall: id });
  },
  resolveSwap: (index) => {
    const res = inv.resolvePendingCatch(index);
    if (res) {
      ui.toast(res.released
        ? `${res.mon.name} was released back into the dungeon.`
        : `${res.replaced.name} was swapped out for ${res.mon.name}.`);
    }
    catchCtx = null;
    syncPlayerModel();
    setMode('playing');
  },
  newRun: () => setMode('starter'),
});

// ---- Boot -------------------------------------------------------------------------------------
ui.bindUI();
onViewportChange();
setMode('title');
ui.boot(true);

// One simulation + render step. Split out from the rAF callback so the whole game can be advanced
// by an explicit dt, which is what makes it testable without a live animation frame.
function tick(dtMs) {
  const dt = dtMs / 1000;
  elapsed += dt;

  switch (state.mode) {
    case 'playing': updatePlaying(dt); break;
    case 'battle': updateBattleFrame(dtMs); break;
    case 'catch': updateCatch(dt); break;
    default: break;
  }

  ui.updatePreviews(dt, state.mode);
  if (state.mode === 'catch') renderer.render(catchScene, catchCamera);
  else renderer.render(scene, camera);
}

let last = performance.now();
function frame(now) {
  const dtMs = Math.min(50, now - last);   // clamp: a backgrounded tab must not teleport anyone
  last = now;
  tick(dtMs);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
