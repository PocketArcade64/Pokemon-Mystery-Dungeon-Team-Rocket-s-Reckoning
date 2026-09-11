// Automatic battles, damage resolution, and enemy team generation.
//
// Combat is fully automatic (design brief §9): there is no move selection. The front-most healthy
// Pokemon on each side trade blows on a fixed cadence until one side is wiped. Damage comes only
// from evolution stage, with a x1.5 bonus when the attack is super effective. Resistances and
// immunities are ignored entirely — every other hit lands at normal damage.
import { DAMAGE_BY_STAGE, SUPER_EFFECTIVE_MULTIPLIER, POKEMON_CATALOG, CATALOG_BY_DEX,
         LEGENDARY_DEX, LEGENDARY_BIRD_DEX, MEWTWO_DEX, FULLY_EVOLVED_DEX,
         ROCKET_FLAVOR_DEX } from './data/pokemon-catalog.js';
import { isSuperEffective } from './data/type-chart.js';
import { makeMon } from './state.js';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---- Enemy team generation ---------------------------------------------------------------------
// Floors 1-4: a Team Rocket Grunt. One fixed "Rocket flavor" species (Arbok, Weezing, Muk...)
// plus random fill, with team size and HP both scaling on floor number. Floors 1-2 stay
// deliberately forgiving: one or two Basic-stage Pokemon at close to base HP.
export function generateGruntTeam(floorNumber) {
  const size = Math.min(4, floorNumber);
  // Under 1.0 on floor 1 on purpose. The fixed Rocket-flavour species are mostly Stage 1 (Arbok,
  // Weezing, Muk, Golbat...), so at full HP the very first grunt would out-stat a lone Basic
  // starter outright. Scaled down, floor 1 is beatable with a small caught team and still teaches
  // that you need to catch Pokemon before taking the stairs.
  const hpScale = 0.75 + (floorNumber - 1) * 0.15;
  const team = [];

  const flavour = makeMon(pick(ROCKET_FLAVOR_DEX), { hpScale });
  if (flavour) team.push(flavour);

  // Early floors draw from unevolved/mid species only; deeper floors open up to Stage 2.
  const allowedStages = floorNumber <= 2 ? ['Basic'] : floorNumber === 3 ? ['Basic', 'Stage1'] : ['Stage1', 'Stage2'];
  const fillPool = POKEMON_CATALOG.filter(p => allowedStages.includes(p.stage));
  while (team.length < size) {
    const m = makeMon(pick(fillPool).dex, { hpScale });
    if (m) team.push(m);
  }
  return team;
}

// Final floor: Giovanni. Fixed six-strong team per the design brief §11 —
// Mewtwo + 1 random legendary + 1 random legendary bird + 3 random fully-evolved Pokemon.
export function generateGiovanniTeam() {
  // COMPOSITION is fixed by the brief and is not tuned here. HP is, and it has to be under 1.0.
  // Combat is sequential 1v1 with damage fixed by stage, so a 6v6 comes down to (total HP x
  // damage) on each side. At full HP Giovanni's six — three Legendaries at 20 damage plus three
  // fully-evolved — outweigh ANY reachable player team by roughly 2x, making him not merely hard
  // but literally unbeatable. At this scale a party of six evolved Pokemon wins with a couple
  // standing, and a weaker or unevolved party loses. That is the capstone the brief asks for.
  const hpScale = 0.62;
  const team = [];
  team.push(makeMon(MEWTWO_DEX, { hpScale }));

  // "1 random legendary" is drawn excluding Mewtwo and the three birds, since those two slots are
  // filled separately — otherwise Giovanni can turn up with a duplicate.
  const otherLegendaries = LEGENDARY_DEX.filter(d => d !== MEWTWO_DEX && !LEGENDARY_BIRD_DEX.includes(d));
  team.push(makeMon(pick(otherLegendaries), { hpScale }));
  team.push(makeMon(pick(LEGENDARY_BIRD_DEX), { hpScale }));

  const used = new Set(team.map(m => m.dex));
  while (team.length < 6) {
    const dex = pick(FULLY_EVOLVED_DEX);
    if (used.has(dex)) continue;
    used.add(dex);
    team.push(makeMon(dex, { hpScale }));
  }
  return team.filter(Boolean);
}

// ---- Damage ------------------------------------------------------------------------------------
export function computeDamage(attacker, defender, attackBonus = 0) {
  const base = DAMAGE_BY_STAGE[attacker.stage] + attackBonus;
  const superEff = isSuperEffective(attacker.types, defender.types);
  const dmg = Math.max(1, Math.round(base * (superEff ? SUPER_EFFECTIVE_MULTIPLIER : 1)));
  return { dmg, superEff };
}

// ---- The battle object -------------------------------------------------------------------------
// step(dt) advances the clock and returns the events that happened this frame, so the battle
// overlay can animate them without the battle needing to know anything about the DOM.
// Events: {type:'hit'|'faint'|'switch'|'revive'|'end', ...}
const TURN_MS = 780;      // one attack per side per turn slot
const INTRO_MS = 900;
const OUTRO_MS = 700;

// Index of the first Pokemon on a team that can actually fight.
//
// This is what a battle OPENS on, and it matters for the player's side because slot 0 is the lead
// and the lead can be FAINTED: you keep the slot when one goes down, and the rest of the game
// already skips past it — syncPlayerModel and the HUD's lead card both read `partyAlive()[0]`, so
// the Pokemon you are walking around as is the first standing one, not slot 0.
//
// createBattle used to start at index 0 regardless and leave the correction to the end of the
// intro phase. That put a fainted Pokemon on the field for the whole 900 ms intro, announced it,
// and then swapped it out the moment the fighting started — which reads as the game sending out a
// KO'd Pokemon. Starting here instead means the battle opens on the one you were controlling.
const firstStanding = (team) => {
  const i = team.findIndex(m => m && m.hp > 0);
  return i < 0 ? 0 : i;               // a wiped team still needs a valid index to render from
};

export function createBattle({ party, enemies, kind = 'grunt', title = 'Team Rocket Grunt',
                              attackBonus = 0, revives = 0 }) {
  const b = {
    kind, title,
    party, enemies,
    attackBonus,
    revives,
    phase: 'intro',       // intro -> fighting -> outro -> done
    result: null,         // 'win' | 'lose'
    turn: 0,              // even: player attacks, odd: enemy attacks
    timer: INTRO_MS,
    log: [],
    partyIndex: firstStanding(party),
    enemyIndex: firstStanding(enemies),
  };

  const firstAlive = (team, from = 0) => {
    for (let i = from; i < team.length; i++) if (team[i].hp > 0) return i;
    for (let i = 0; i < team.length; i++) if (team[i].hp > 0) return i;
    return -1;
  };
  const alive = (mon) => !!mon && mon.hp > 0;

  b.partyLead = () => b.party[b.partyIndex] || null;
  b.enemyLead = () => b.enemies[b.enemyIndex] || null;
  b.partyAlive = () => b.party.filter(m => m.hp > 0).length;
  b.enemiesAlive = () => b.enemies.filter(m => m.hp > 0).length;

  b.step = function step(dtMs) {
    const events = [];
    b.timer -= dtMs;
    if (b.timer > 0) return events;

    if (b.phase === 'intro') {
      b.phase = 'fighting';
      b.timer = TURN_MS;
      // ONLY when the standing lead cannot fight. This used to reset both indices to
      // firstAlive() unconditionally, which silently threw away a swap made during the intro —
      // and the intro is exactly when the Swap button is offered (see updateSwapButton, which
      // deliberately enables it in this phase because it is "the one moment you most want to
      // choose who leads"). The new lead was shown on the field, the log said it was sent out,
      // and then the Pokemon you had swapped AWAY from took the first hit.
      //
      // It is also no longer what handles a FAINTED lead — firstStanding() does that at
      // construction, so the fainted one is never put on the field in the first place. What is
      // left here is the genuine edge case: a lead that stopped being able to fight DURING the
      // intro (an item used on the bag screen cannot faint anyone, but this costs nothing).
      if (!alive(b.partyLead())) b.partyIndex = Math.max(0, firstAlive(b.party));
      if (!alive(b.enemyLead())) b.enemyIndex = Math.max(0, firstAlive(b.enemies));
      return events;
    }

    if (b.phase === 'outro') {
      b.phase = 'done';
      events.push({ type: 'end', result: b.result });
      return events;
    }

    if (b.phase !== 'fighting') return events;

    const playerTurn = b.turn % 2 === 0;
    const attacker = playerTurn ? b.partyLead() : b.enemyLead();
    const defender = playerTurn ? b.enemyLead() : b.partyLead();
    b.turn++;
    b.timer = TURN_MS;

    if (!attacker || !defender || attacker.hp <= 0) return events;   // covered by the checks below

    const { dmg, superEff } = computeDamage(attacker, defender, playerTurn ? b.attackBonus : 0);
    defender.hp = Math.max(0, defender.hp - dmg);
    events.push({ type: 'hit', side: playerTurn ? 'party' : 'enemy', attacker, defender, dmg, superEff });
    b.log.push(`${attacker.name} hit ${defender.name} for ${dmg}${superEff ? ' - super effective!' : ''}`);

    if (defender.hp === 0) {
      // A held Revive brings the fainted party member straight back at half HP, so the player
      // never loses the slot; enemies never get one.
      if (!playerTurn && b.revives > 0) {
        b.revives--;
        defender.hp = Math.max(1, Math.round(defender.maxHp / 2));
        events.push({ type: 'revive', mon: defender });
        b.log.push(`${defender.name} was revived!`);
      } else {
        events.push({ type: 'faint', side: playerTurn ? 'enemy' : 'party', mon: defender });
        b.log.push(`${defender.name} fainted!`);
        const team = playerTurn ? b.enemies : b.party;
        const next = firstAlive(team);
        if (next < 0) {
          b.result = playerTurn ? 'win' : 'lose';
          b.phase = 'outro';
          b.timer = OUTRO_MS;
          return events;
        }
        if (playerTurn) b.enemyIndex = next; else b.partyIndex = next;
        events.push({ type: 'switch', side: playerTurn ? 'enemy' : 'party', mon: team[next] });
      }
    }
    return events;
  };

  return b;
}

// A single wild Pokemon standing in as a one-mon enemy team, for the forced battle an aggressive
// wanderer triggers (design brief §7: win it and the catch minigame unlocks).
// `aggressive` is carried through onto the mon rather than dropped here. It is the only thing that
// forces this battle in the first place — a passive wild is walked around — and it is what the foe
// fighter's purple aura is drawn from, so the Pokemon that was glowing on the floor is still
// glowing across the table from you.
export function wildEnemyTeam(dex, floorNumber, aggressive = false) {
  // Wilds come in softer than trainers at the same depth: bumping into one is an accident of
  // exploration, not a fight you chose, and on floor 1 it is often your starter alone.
  const m = makeMon(dex, { hpScale: 0.6 + (floorNumber - 1) * 0.12, aggressive });
  return m ? [m] : [];
}

export function stageLabel(dex) {
  const c = CATALOG_BY_DEX.get(dex);
  return c ? c.stage : 'Basic';
}
