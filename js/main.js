// State machine + the single requestAnimationFrame loop. This is the only module that knows the
// whole game; everything else is a self-contained system it drives.
import * as THREE from 'three';
import { state, makeMon, saveSettings, saveStats, recordDex, FLOORS_PER_RUN, MAX_PARTY } from './state.js';
import { renderer, scene, camera, canvas, followCamera, resetCameraFollow, onViewportChange } from './three-setup.js';
import { createMonObject, disposeObject, preloadDex, preloadPickupModels } from './models.js';
import { STARTER_DEX, CATALOG_BY_DEX } from './data/pokemon-catalog.js';
import { ITEM_BY_ID, COIN_BY_ID } from './data/items.js';
import {
  generateFloor, buildFloor, disposeFloor, pickRunThemes, pickShopFloors, pickChanseyFloors,
  atChansey, atUsedChansey, spendChansey, cellToWorld, cellValue,
  FLOOR, moveWithCollision, revealAround, revealWholeFloor, updateWilds, updateFloorDecor,
  itemAtPlayer, wildAtPlayer, atStairs, atShop, drawMap, makeTrainerFigure, STAIR_TOP, MINIMAP_CELLS,
} from './dungeon.js';
import { createInput } from './movement.js';
import { createBattle, generateGruntTeam, generateGiovanniTeam, wildEnemyTeam } from './battle.js';
import { startCatch, endCatch, updateCatch, setCatchBall, catchState, catchScene, catchCamera,
         catchPointerDown, catchPointerMove, catchPointerUp } from './catch.js';
import { titleScene, titleCamera, updateTitle } from './titlescene.js';
import * as inv from './inventory.js';
import * as ui from './ui-screens.js';
import { uiHooks } from './ui-screens.js';
import { unlockAudio, playMusic, playMusicExclusive, releaseMusicLock, musicForMode, prefetchMusic,
         releaseMusic, restartMusic, sfx, applyVolumes } from './audio.js';

const PLAYER_SPEED = 4.7;
const player = { x: 0, z: 0 };
// The last direction the player actually moved in, in the same angle convention the player model's
// rotation.y uses (atan2(dirX, dirZ)). The minimap's green arrow is drawn from this, so it has to
// PERSIST when movement stops — an arrow that snapped back to north the moment you let go of the
// joystick would be worse than no arrow at all.
let playerHeading = 0;
let playerObj = null, playerObjDex = null;
let elapsed = 0;
let battle = null;
let battleCtx = null;      // { kind, wild }
let catchCtx = null;       // { wild }

// The pause map's own view controls: rotation on top of the fixed view orientation, zoom, and pan.
// Reset every time the pause screen opens, so it always starts framed the same way the minimap is.
const mapView = { rot: 0, zoom: 1, panX: 0, panY: 0 };
export function resetMapView() { mapView.rot = 0; mapView.zoom = 1; mapView.panX = 0; mapView.panY = 0; }

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
      ui.updateHUD();
      break;
    // Coming BACK from the party switch: the screen is already built, it just has to be brought
    // back in step with whatever changed while it was away.
    case 'battle':
      if (battle) ui.updateBattleRows(battle);
      break;
    case 'switch':
      ui.renderSwitch({
        inBattle: state.returnTo === 'battle',
        currentIndex: state.returnTo === 'battle' ? battle?.partyIndex ?? 0 : 0,
      });
      break;
    case 'pause':
      resetMapView();
      ui.renderPause();
      drawFloorMap();
      break;
    case 'shop':
      ui.renderShop(shopCtx);
      break;
    case 'chansey':
      ui.renderChansey();
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
    case 'debug':
      ui.renderDebug();
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
// Three starters out of the 16-strong pool (design brief §3), one per slot: grass, then fire, then
// water, left to right.
//
// The slots used to be three blind draws from the whole pool, which meant a run could open on
// Chikorita / Treecko / Turtwig — three Grass starters, a choice between three of the same thing.
// Every mainline game offers the triangle, and it is the triangle that makes the pick mean
// something: whichever you take, you know what you gave up. Position is part of that too, so the
// types are pinned to slots rather than shuffled — the row reads the same way every run, and only
// WHICH generation's trio you are shown changes.
//
// Matched on the PRIMARY type (types[0]), not on "includes": Bulbasaur is Grass/Poison, and his
// second type must not let him stand in the fire or water slot.
const STARTER_SLOT_TYPES = ['Grass', 'Fire', 'Water'];

function offerStarters() {
  const offer = [];
  for (const type of STARTER_SLOT_TYPES) {
    const pool = STARTER_DEX.filter(d => CATALOG_BY_DEX.get(d)?.types[0] === type);
    // A slot with nothing to fill it is skipped rather than left as a hole in the row. The pool
    // ships five Grass, five Fire and six Water, so this is only reachable if that pool is edited.
    if (pool.length) offer.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  preloadDex(offer);
  return offer;
}

function beginRun(starterDex) {
  // TEAR THE PREVIOUS RUN DOWN FIRST. This is not belt-and-braces, it is the only thing that does
  // it on the "Play Again" path: that button goes newRun -> setMode('starter') -> here, and
  // setMode only calls teardownRun() for 'title'. Because the line below then replaces state.run
  // wholesale with a fresh object whose `floor` is null, enterFloor's own
  // `if (run.floor) disposeFloor(run.floor)` had nothing left to find and the OLD floor's Group
  // stayed in the scene for the life of the page — one orphaned floor per new run, accumulating.
  //
  // What that looked like: the previous floor's walls were still being drawn, sitting on top of
  // the new floor's, while collision read the new floor's grid. So some walls you could see were
  // walls you could walk straight through, and some you could not see were solid. Verified by
  // counting instanced meshes in the scene: 5 on run 1, 11 on run 2, and still 5 left over after
  // returning to the title.
  teardownRun();
  state.run = {
    themes: pickRunThemes(FLOORS_PER_RUN),
    // Which floors carry Kecleon's stall is decided ONCE, here, rather than per floor: the
    // no-two-random-stalls-in-a-row rule needs to see the whole run at once.
    shopFloors: pickShopFloors(FLOORS_PER_RUN),
    // Chansey's rest stops, decided up front for the same reason: it is a property of the RUN, and
    // deciding per floor would make it impossible to reason about how many a run can hold.
    chanseyFloors: pickChanseyFloors(FLOORS_PER_RUN),
    floorIndex: -1,
    floor: null,
    party: [makeMon(starterDex)],
    bag: inv.startingBag(),
    coins: 0,
    activeBall: null,
    attackBonus: 0,
    attackBonusUntil: 0,
    repelUntil: 0,
    revives: 0,
    caught: 0,
    pendingCatch: null,
  };
  // The floor pickup models (balls, the present, the three coins) are wanted in bulk the instant
  // the first floor builds, so warm them on the way in rather than watching a field of
  // placeholder blocks resolve.
  preloadPickupModels();
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
  // The shop screen holds the stall it was opened from, and that stall belongs to a floor that is
  // being disposed right now.
  shopCtx = null;
  endCatch();
}

function enterFloor(index) {
  const run = state.run;
  const leavingTheme = run.floor?.theme?.id ?? null;
  if (run.floor) disposeFloor(run.floor);

  const theme = run.themes[index];
  const floor = generateFloor(index + 1, theme, {
    shop: run.shopFloors.has(index + 1),
    chansey: run.chanseyFloors.has(index + 1),
  });
  run.floor = floor;
  run.floorIndex = index;
  scene.add(buildFloor(floor));
  // Kecleon's theme has to be ready the moment the player walks onto the blanket, and at 78 s it
  // is a big decode. Warmed on arrival on a stall floor, and given back on the way off one, so a
  // run still holds about two tracks rather than three.
  if (floor.shop) prefetchMusic('kecleon');
  else releaseMusic('kecleon');

  // The floor boss stands ON the up-stairs tile, so you cannot ascend without going through them.
  const isFinal = index === FLOORS_PER_RUN - 1;
  // On the last floor, warm Giovanni's own defeat fanfare alongside his battle theme — it has to
  // land on the frame he goes down, and it is the only track cued by the fight rather than by a
  // screen change.
  if (isFinal) prefetchMusic('giovanni', 'victory-boss');
  else prefetchMusic('grunt');
  const fig = isFinal
    ? makeTrainerFigure({ suit: 0x23232b, accent: 0xf5a623, hair: 0x14141a, scale: 1.2 })
    : makeTrainerFigure({ suit: 0x1d1d24, accent: 0xd8202a, scale: 1.0 });
  const sw = cellToWorld(floor, floor.stairsCell.x, floor.stairsCell.y);
  // STAIR_TOP is dungeon.js's own word on where the top of its stairwell is: the near lip of the
  // well, at floor level, with the flight dropping away behind them. The stairs descend now, so
  // "standing on the stairs" means standing at the head of them and not on a plinth — and because
  // the lip is 1.35 out from the stairs tile and atStairs() fires at 1.3, you are stopped by the
  // encounter with the Grunt filling the screen in front of the drop.
  fig.position.set(sw.x, STAIR_TOP.y, sw.z + STAIR_TOP.z);
  fig.rotation.y = STAIR_TOP.facing;
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

  // Arriving on a floor plays its theme from the TOP. Floor themes are `resume: true` so that
  // stepping out of a battle or the shop drops you back in where you left off, but this is not a
  // return — it is a new floor (or, through beginRun, a new run), and the saved position has to go
  // before setMode() below asks for the track. Done here rather than after, so only one source
  // ever starts.
  restartMusic(theme.id);
  setMode('playing');
  // Only now that the new theme is the one playing: a run walks through up to eleven of these and
  // each decoded theme is tens of megabytes, so the floor we just left gives its buffer back.
  if (leavingTheme && leavingTheme !== theme.id) releaseMusic(leavingTheme);
  // Mystery Dungeon's floor card, and nothing more than Mystery Dungeon puts on it: the dungeon's
  // NAME on the first line and the FLOOR under it. No kicker — the empty element collapses.
  // `ms` is the HOLD only; banner() adds the text's fade in and out and the black lifting off the
  // new floor on top of it.
  ui.banner({ kicker: '', main: theme.name, sub: `B${index + 1}F`, ms: 950 });
}

function advanceFloor() {
  const run = state.run;
  if (run.floorIndex + 1 >= FLOORS_PER_RUN) { winRun(); return; }
  // The descending-stairs sound, then straight into the next floor's card — PMD shows ONE title
  // card per floor, so the old "Floor Clear / Up the stairs" banner that used to play first is
  // gone. enterFloor puts the card up itself.
  sfx('stairs');
  enterFloor(run.floorIndex + 1);
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
  // No sting here, and no playMusic call either: Victory! (Team Galactic) has been playing since
  // Giovanni went down and holds the music lock, so the win screen simply carries it over.
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
  ui.renderEnd({
    won: false,
    abandoned,
    floorReached: run.floorIndex + 1,
    caught: run.caught,
    partyNames: [],
  });
  setMode('end');
  // You Lose answers the run the way Giovanni's fanfare answers a win: it OWNS the mixer from
  // here. playMusicExclusive stops whatever floor or battle theme was running and locks every
  // later playMusic() out, so the game-over screen stays on this one track until the player
  // leaves it (goTitle / newRun both call releaseMusicLock).
  //
  // Called INSTEAD of the synthesized 'defeat' sting, not alongside it — the sting is a
  // descending sawtooth run and it played straight over the front of the jingle. The win screen
  // has worked this way from the start: the track is the sound of the run ending.
  playMusicExclusive('lose');
}

// ---- Battles ----------------------------------------------------------------------------------
function startBattle(kind, wild = null) {
  const run = state.run;
  let enemies, title;
  if (kind === 'giovanni') { enemies = generateGiovanniTeam(); title = 'Giovanni'; }
  else if (kind === 'grunt') { enemies = generateGruntTeam(run.floorIndex + 1); title = 'Team Rocket Grunt'; }
  else { enemies = wildEnemyTeam(wild.dex, run.floorIndex + 1, wild.aggressive); title = `Wild ${CATALOG_BY_DEX.get(wild.dex).name}`; }

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
  // The LEAD only, the way the games announce it. Listing all six of Giovanni's ran to four lines
  // in the message band, and how many he is carrying is already on the Poke Ball strip in his box.
  // enemyLead() rather than enemies[0]: a freshly generated team is all standing, so they are the
  // same today, but the announcement should name whoever is actually on the field.
  if (kind !== 'wild') ui.battleLog(`${title} sent out ${battle.enemyLead()?.name || 'a Pokemon'}!`);
}

function updateBattleFrame(dtMs) {
  if (!battle) return;
  const events = battle.step(dtMs);
  for (const ev of events) {
    if (ev.type === 'hit') {
      const side = ev.side === 'party' ? 'enemy' : 'party';
      const idx = side === 'enemy' ? battle.enemies.indexOf(ev.defender) : battle.party.indexOf(ev.defender);
      // Deliberately NOT written to the message band. A hit is shown on the field — the number
      // floating off the Pokemon that took it, its model flashing, its HP bar dropping. Narrating
      // every blow in text as well meant the band rewrote itself twice a second, which is what the
      // eye followed instead of the fight. Only the beats that change the situation get a line:
      // a faint, a switch, a revive, the result.
      // Who SWUNG, before what it did to whoever took it: the attacker steps in, and the flash and
      // the damage number land on the other one. `ev.side` is the attacking side.
      ui.lungeAttacker(ev.side === 'party' ? 'you' : 'foe');
      ui.floatDamage(side, idx, ev.dmg, ev.superEff);
      ui.updateBattleRows(battle);
      sfx(ev.superEff ? 'superhit' : 'hit');
    } else if (ev.type === 'faint') {
      ui.updateBattleRows(battle);
      ui.battleLog(`${ev.mon.name} fainted!`);
      sfx('faint');
    } else if (ev.type === 'revive') {
      ui.updateBattleRows(battle);
      ui.battleLog(`${ev.mon.name} was pulled back from the brink by a Revive!`);
      state.run.revives = battle.revives;
      sfx('revive');
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
    // Giovanni gets his own, bigger fanfare, and it OWNS the speakers from here: playMusicExclusive
    // locks every later playMusic out, so the win screen and anything the player opens on the way
    // through it stay on this track. releaseMusicLock() runs when they leave the win screen.
    playMusicExclusive('victory-boss');
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
    // An empty bag means the catch minigame cannot open at all, so the encounter has to be
    // resolved right here or the wild is left standing inside the player.
    //
    // A wild you have already BEATEN IN BATTLE is gone for good. It has nothing left to give and,
    // being one of the aggressive ones, it would otherwise chase you forever: updateWilds re-homes
    // an aggressive wild onto the player every single frame, so the cooldown below suppresses the
    // encounter while the body keeps walking straight through you. That was the bug. Knocking a
    // wild out and having it leave is also what the mainline games do.
    if (wild.defeated) {
      removeWild(wild);
      ui.toast(`No Poke Balls left - ${CATALOG_BY_DEX.get(wild.dex)?.name || 'it'} got away!`);
      setMode('playing');
      return;
    }
    // One you merely bumped into is left on the floor: you might still find a ball down here. It
    // goes on a cooldown, which updateWilds also reads as "do not chase", and walks away rather
    // than standing in your footprint.
    ui.toast('You have no Poke Balls left!');
    wild.cooldownUntil = performance.now() + 10000;
    sendWildAway(wild);
    setMode('playing');
    return;
  }
  catchCtx = { wild };
  // Wipe the LAST encounter's throw grade before this one opens. Done here and not in
  // renderCatchUI, which also runs mid-encounter (every throw, every ball swap) and would cut a
  // live grade short. See resetCatchGrade for why a finished animation still needs clearing.
  ui.resetCatchGrade();
  ui.clearCatchNote();
  startCatch({
    dex: wild.dex,
    ballId,
    ballsLeft: inv.countOf(ballId),
    floorNumber: state.run.floorIndex + 1,
    // The encounter stage is dressed as the floor you are standing on.
    theme: state.run.floor.theme,
    // A shadow Pokemon keeps its purple aura right up to the moment the ball locks.
    shadow: !!wild.aggressive,
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
    // The bag ran dry mid-encounter and there is nothing left to throw. End it rather than
    // parking on a screen with no move left — the Run button in the corner was the only way out
    // and it read as a freeze. The wild leaves the floor, exactly as fleeing does; it has to,
    // because a wild left standing has no collision with the player and walks through them.
    onEmpty: () => {
      const w = catchCtx?.wild;
      const name = CATALOG_BY_DEX.get(w?.dex)?.name || 'It';
      // Say WHY the screen is about to close, on the screen it is closing — the empty bag is the
      // one outcome here with nothing to see in the 3D scene, so without this line the close
      // reads as the game giving up on its own. Then the beat that follows lets the last ball
      // finish falling, and the exploration view gets the other half of the sentence.
      ui.catchNote('You are out of Pokeballs');
      setTimeout(() => {
        if (state.mode !== 'catch') return;      // already resolved some other way
        endCatch();
        ui.clearCatchNote();
        removeWild(w);
        catchCtx = null;
        setMode('playing');
        ui.toast(`${name} fled!`);
      }, 1600);
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

// Take a wild off the floor for good — body and all. There is no wild-vs-player collision, so a
// wild that stays in the world after its encounter has ended walks straight through the player;
// anything that ends an encounter permanently has to come through here.
function removeWild(wild) {
  if (!wild || wild.gone) return;
  wild.gone = true;
  disposeObject(wild.obj);
  wild.obj = null;
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
        // No toast. The catch screen has already said "<Name> was caught!" in 3D above the ball,
        // and repeating it along the bottom of the dungeon a second later is the same sentence
        // twice. The jingle is what marks the new team member on the way back out.
        sfx('join');
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
    removeWild(wild);
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
    playerHeading = Math.atan2(dir.x, dir.z);
    if (playerObj) playerObj.rotation.y = playerHeading;
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

  // Pickups. Three kinds now, and each announces itself with its own SPRITE rather than a line of
  // text — a present on the floor deliberately does not say what is in it, so the reveal at the
  // moment you pick it up is the whole point. ui.pickupPopup draws the `icon` from items.js — the
  // item's pixel-art sprite, or the coins' ASCII-grid SVG.
  const it = itemAtPlayer(floor, player);
  if (it) {
    it.taken = true;
    if (it.obj) it.obj.visible = false;
    if (it.kind === 'coin') {
      const coin = COIN_BY_ID.get(it.coinId);
      const got = inv.addCoinPickup(it.coinId);
      sfx('money');
      ui.pickupPopup({ icon: coin.icon, name: coin.name, qty: `+${got}` });
    } else {
      const item = ITEM_BY_ID.get(it.itemId);
      const qty = it.qty || 1;
      inv.addItem(it.itemId, qty);
      sfx('pickup');
      ui.pickupPopup({ icon: item.icon, name: item.name, qty: qty > 1 ? `x${qty}` : '' });
    }
  }

  // Kecleon's stall. Checked before the stairs and the encounter test so walking onto the blanket
  // always opens the shop rather than losing to whatever else happens to be in range.
  if (atShop(floor, player)) {
    openShop();
    return;
  }

  // Chansey's rest stop, checked alongside the stall and for the same reason. A SPENT one takes no
  // turn and opens nothing: it just says so, because a prompt whose only button is dead is worse
  // than no prompt.
  if (atChansey(floor, player)) {
    openChansey();
    return;
  }
  if (atUsedChansey(floor, player)) {
    ui.toast('Chansey has already done all she can on this floor.');
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
  // Locked to the view orientation and to a window around the player: no rot/zoom/pan, so the
  // minimap always reads the same way round as the screen does.
  drawMap(ui.minimapCtx(), floor, player, { heading: playerHeading, cellsAcross: MINIMAP_CELLS });
}

function drawFloorMap() {
  const floor = state.run?.floor;
  if (!floor) return;
  // Before the draw, not after: the map's bitmap tracks the panel it is shown in, and resizing a
  // canvas clears it. See syncFloorMapSize for why the bitmap is not a fixed square any more.
  ui.syncFloorMapSize();
  drawMap(ui.floormapCtx(), floor, player, {
    detail: true, heading: playerHeading,
    rot: mapView.rot, zoom: mapView.zoom, panX: mapView.panX, panY: mapView.panY,
  });
}

// ---- Kecleon's shop ---------------------------------------------------------------------------
let shopCtx = null;        // { shop, stock }

function openShop() {
  const shop = state.run?.floor?.shop;
  if (!shop) return;
  // The stock is rolled once per stall and then kept, so closing and reopening the screen cannot
  // be used to re-roll what is on the shelf.
  if (!shop.stock) shop.stock = inv.rollShopStock();
  shopCtx = { shop, stock: shop.stock };
  setMode('shop', { returnTo: 'playing' });
}

function closeShop() {
  shopCtx = null;
  // Stepping off the blanket is what re-arms the trigger (see atShop), and closing the screen
  // leaves the player standing ON it — so the latch is left set and walking away clears it.
  setMode('playing');
}

function openChansey() {
  if (!state.run?.floor?.chansey) return;
  setMode('chansey', { returnTo: 'playing' });
}

// ---- Item hooks that need main's state --------------------------------------------------------
// revealWholeFloor, not a bare `mapRevealed = true`: drawMap now keeps a cached terrain canvas
// patched from the fog-of-war dirty list, and "everything is visible now" has no dirty list — the
// cache has to be dropped so it repaints from scratch.
inv.hooks.revealMap = () => { if (state.run?.floor) revealWholeFloor(state.run.floor); };
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
  // Leaving the win screen is what ends Giovanni's fanfare's hold on the mixer, by either door:
  // the title screen has its own theme and a new run needs a floor theme.
  goTitle: () => { releaseMusicLock(); setMode('title', { returnTo: 'title' }); },
  resume: () => setMode('playing'),
  quitRun: () => { if (state.run) loseRun({ abandoned: true }); else setMode('title'); },
  openPause: () => setMode('pause'),
  // The pause map's rotate / zoom / pan gestures. They stack on TOP of the fixed view orientation
  // rather than replacing it, so `rot: 0` is always "the way you are looking" — which is what
  // makes reopening the pause screen (resetMapView, above) a meaningful way back.
  mapRotate: (delta) => { mapView.rot += delta; drawFloorMap(); },
  mapZoom: (factor, originX = 0, originY = 0) => {
    const next = Math.min(6, Math.max(0.6, mapView.zoom * factor));
    const applied = next / mapView.zoom;
    // Zoom about the gesture's own point, not about the canvas centre: pinching on a corner of the
    // map and having it fly away from under your fingers is the classic way this feels broken.
    mapView.panX = originX + (mapView.panX - originX) * applied;
    mapView.panY = originY + (mapView.panY - originY) * applied;
    mapView.zoom = next;
    drawFloorMap();
  },
  mapPan: (dx, dy) => { mapView.panX += dx; mapView.panY += dy; drawFloorMap(); },
  // Buying from Kecleon. The coin spend, the bag credit and the stock decrement all happen inside
  // inv.buyFromShop so a refused purchase cannot half-apply.
  shopBuy: (itemId) => {
    if (!shopCtx) return;
    const res = inv.buyFromShop(shopCtx.stock, itemId);
    ui.toast(res.msg);
    sfx(res.ok ? 'buy' : 'back');
    if (res.ok) ui.renderShop(shopCtx);
  },
  shopLeave: closeShop,
  // Chansey's rest stop. Heals every party member to FULL — including the fainted ones, which is
  // the one thing medicines no longer do (see inventory.heal) and a large part of why the stop is
  // worth walking to. It is not a Revive: a Revive is a thing you carry, and this is a place.
  chanseyHeal: () => {
    const floor = state.run?.floor;
    if (!floor?.chansey || floor.chansey.used) return;
    let healed = 0, revived = 0;
    for (const mon of inv.party()) {
      if (mon.hp >= mon.maxHp) continue;
      if (mon.hp <= 0) revived++;
      healed++;
      mon.hp = mon.maxHp;
    }
    spendChansey(floor);
    sfx('heal');
    syncPlayerModel();            // a revived slot 0 changes who you are walking around as
    ui.updateHUD();
    setMode('playing');
    ui.toast(healed === 0
      ? 'Your team was already in perfect shape. Chansey saw you off anyway.'
      : revived > 0
        ? `Chansey healed your whole team — and brought ${revived} back on their feet!`
        : 'Chansey healed your whole team to full!');
  },
  chanseyLeave: () => {
    // Leaving does NOT spend her: you can walk away and come back later in the floor, which is
    // what makes finding her early worth remembering rather than worth using on the spot.
    sfx('back');
    setMode('playing');
  },
  openBag: () => setMode('bag', { returnTo: state.mode === 'pause' ? 'pause' : 'playing' }),
  closeBag: () => setMode(state.returnTo === 'pause' ? 'pause' : 'playing'),
  openGlossary: () => setMode('glossary', { returnTo: state.mode }),
  openSettings: () => setMode('settings', { returnTo: state.mode }),
  openDex: () => setMode('dex', { returnTo: state.mode }),
  // The debug menu is a room off Settings, not a screen in its own right, so neither of these
  // touches `returnTo`: it still points at whatever opened Settings (the title screen or the pause
  // screen), which is where Settings' own Back has to go when the player finally gets there.
  openDebug: () => setMode('debug'),
  closeDebug: () => setMode('settings'),
  // Both give-hooks are the debug menu's whole reach into a run, and both are inert without one.
  // They deliberately go through inventory.addItem rather than writing state.run.bag: that is the
  // function the rest of the game adds items with, so anything it does (or grows to do) happens
  // here too and a debug-given item is indistinguishable from a found one.
  debugGive: (itemId, n) => {
    if (!state.run) return;
    inv.addItem(itemId, n);
    const item = ITEM_BY_ID.get(itemId);
    ui.toast(`Added ${n} ${item?.name || itemId}.`);
  },
  // Straight onto run.coins, and NOT through addCoinPickup: that one also credits
  // stats.coinsFound, and the lifetime record is a record of what was played. Debug money is not.
  debugGiveCoins: (n) => {
    if (!state.run) return;
    state.run.coins = (state.run.coins || 0) + n;
    ui.updateHUD();
    ui.toast(`Added ${n} coins.`);
  },
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
  },
  battleContinue: onBattleContinue,
  catchFlee: onCatchFlee,
  chooseBall: (id) => {
    inv.itemApi.setActiveBall(id);
    setCatchBall(id, inv.countOf(id));
    if (catchCtx) ui.renderCatchUI({ dex: catchCtx.wild.dex, activeBall: id });
  },
  // The full-screen switch. ONE caller now: the battle Swap button. The dungeon's lead card used to
  // come through here too — that is why this and chooseSwitch below still branch on
  // state.returnTo — but it now opens the inline list instead (openLeadMenu, below). So the
  // `'playing'` half of both branches is currently unreachable. It is kept rather than deleted
  // because it is the whole of what a non-battle caller would need, and `returnTo` is what would
  // route one here; do not "simplify" it away and then have to rediscover it.
  openSwitch: () => {
    if (inv.partyAlive().length < 2) { ui.toast('You have nobody else to swap to.'); return; }
    setMode('switch', { returnTo: state.mode === 'battle' ? 'battle' : 'playing' });
  },
  // The dungeon HUD's inline swap list. Kept separate from openSwitch/chooseSwitch, which are the
  // battle Swap button's full-screen path: that one branches on state.returnTo, and reusing it from
  // the HUD would have it read a `returnTo` left over from whatever last set it.
  openLeadMenu: () => {
    if (inv.partyAlive().length < 2) { ui.toast('You have nobody else to swap to.'); return; }
    sfx('select');
    ui.setLeadMenu(true);
  },
  chooseLead: (index) => {
    const p = inv.party();
    const target = p[index];
    if (!target || target.hp <= 0 || index === 0) return;
    sfx('confirm');
    // Slot 0 IS the lead — it is what syncPlayerModel and every "who is out" read uses — so the
    // swap is a move to the front, with everyone else keeping their order behind them.
    p.splice(index, 1);
    p.unshift(target);
    syncPlayerModel();
    ui.updateHUD();
    ui.toast(`${target.name} takes the lead.`);
  },
  chooseSwitch: (index) => {
    const target = inv.party()[index];
    if (!target || target.hp <= 0) return;
    sfx('confirm');
    if (state.returnTo === 'battle' && battle) {
      // In battle it changes who is out RIGHT NOW. Deliberately free: combat is automatic, so
      // there is no turn to give up, and charging one would just be a hidden penalty.
      if (index !== battle.partyIndex) {
        battle.partyIndex = index;
        ui.battleLog(`${target.name} was sent out!`);
      }
      setMode('battle');
      ui.updateBattleRows(battle);
      return;
    }
    // In the dungeon it changes who you steer, which is party slot 0 — so move them there and
    // keep everyone else in order behind them. Currently unreachable: the dungeon goes through
    // chooseLead above, which does the same move without the screen change. See openSwitch.
    const p = inv.party();
    p.splice(index, 1);
    p.unshift(target);
    syncPlayerModel();
    setMode('playing');
    ui.toast(`${target.name} takes the lead.`);
  },
  resolveSwap: (index) => {
    const res = inv.resolvePendingCatch(index);
    if (res) {
      ui.toast(res.released
        ? `${res.mon.name} was released back into the dungeon.`
        : `${res.replaced.name} was swapped out for ${res.mon.name}.`);
      // Swapping one in is the other door a Pokemon joins the team by, so it gets the same jingle
      // the straight-into-an-empty-slot path gets. Releasing is not joining, and gets nothing.
      if (!res.released) sfx('join');
    }
    catchCtx = null;
    syncPlayerModel();
    setMode('playing');
  },
  newRun: () => { releaseMusicLock(); setMode('starter'); },
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
    case 'title': updateTitle(dt); break;
    default: break;
  }

  ui.updatePreviews(dt, state.mode);
  // Three scenes share the one renderer, picked by mode: the catch minigame's, the title screen's
  // diorama, and the dungeon itself. The title screen's `.sheet` background is a scrim rather than
  // the full gradient precisely so this shows through it.
  if (state.mode === 'catch') renderer.render(catchScene, catchCamera);
  else if (state.mode === 'title') renderer.render(titleScene, titleCamera);
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
