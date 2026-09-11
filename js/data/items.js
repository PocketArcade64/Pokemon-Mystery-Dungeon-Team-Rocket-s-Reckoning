// Every item / power-up in the game (design brief §8), plus the three coin denominations. This
// file is the SINGLE source of truth for four consumers: floor spawn logic (dungeon.js reads
// `spawnWeight`), the bag screen and the pickup popup (both render `icon`), the Glossary screen
// (reads `name` + `desc`), and Kecleon's shop (reads `shopPrice` + `shopDesc`).
//
// `desc` and `shopDesc` are two different jobs and neither can do the other's. `desc` is the
// Glossary's entry: two or three sentences with room to explain the mechanic. `shopDesc` is ONE
// short line that has to fit a shop row under the item's name at 0.754rem beside a price — so it
// says what the thing does and nothing else. Every item with a `shopPrice` needs one.
//
// Coins live here rather than in their own module because they share `icon` and exactly the same
// consumers. They are NOT bag items and are deliberately not in ITEMS: they never occupy a bag
// slot, cannot be "used", and are spent only at Kecleon's shop. See COINS at the bottom.
//
// `use(api, mon)` performs the effect. `api` is supplied by inventory.js and exposes only what
// items are allowed to touch, so nothing here needs to import game state:
//   api.party            live party array (mon objects: {dex,name,types,stage,hp,maxHp,dmg})
//   api.heal(mon, amt)   amt === Infinity restores to full; returns HP actually restored.
//                        Does NOTHING to a fainted Pokemon — reviving is the Revive's job alone.
//   api.revive(mon)      brings a FAINTED Pokemon back at half HP; returns the HP it came back on
//   api.evolve(mon)      evolves in place if its evolvesInto is non-empty; returns new name or null
//   api.revealMap()      Town Map: uncovers the whole floor on the minimap
//   api.revealEntities() Dowsing Machine: uncovers every item + wild Pokemon on the floor
//   api.buffAttack(bonus, ms)
//   api.setRepel(ms)
//   api.warpToStairs()
//   api.grantRevive()
//   api.setActiveBall(id)
// Every use() returns { ok, msg } — msg is shown as a toast; ok:false leaves the item unconsumed.

// ---- Icons -------------------------------------------------------------------------------------
// Item icons are hand-drawn 30x30 pixel-art PNGs under assets/sprites/, one per item, named after
// the item's `id` — so `master-ball` is assets/sprites/master-ball.png, and adding an item means
// dropping a matching file in beside the others. They replaced an earlier set of ASCII-grid SVGs
// drawn in this file: the PNGs read far better at the 54px bag cell, and the 10x10 grid could not
// draw the shading and highlights the sprites have.
//
// The property is called `icon` and not `svg` because it is no longer SVG for items — though it
// still is for the coins below, which have no sprite of their own. Every consumer drops it
// straight into innerHTML, so it has to be markup rather than a bare path.
// `image-rendering: pixelated` comes from the CSS of whichever container holds it (see the
// `svg, img` icon rules in index.html): at 30x30 blown up to a 54px cell, smoothing turns the art
// to mush.
const SPRITES = 'assets/sprites/';
const spriteIcon = (id) => `<img src="${SPRITES}${id}.png" alt="" draggable="false" />`;

// The coins' art is a 10x10 grid drawn as ASCII right here in the source, so it is editable
// without a paint program: change a character, change the pixel. `pal` maps each character to a
// colour and '.' is transparent.
//
// 10x10 rather than a finer grid on purpose — the whole UI is deliberately chunky pixel art, and
// at the 54px bag cell one grid square lands on ~5 device pixels, which is what makes the blocks
// read as blocks. `shape-rendering="crispEdges"` keeps the rect edges from being antialiased into
// grey seams when the cell size is not an exact multiple of 10.
//
// One <rect> per horizontal run of the same colour keeps the emitted markup small.
function pixelIcon(pal, rows) {
  const n = rows.length;
  let out = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let w = 1;
      while (x + w < row.length && row[x + w] === ch) w++;
      if (ch !== '.') {
        out += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${pal[ch]}"/>`;
      }
      x += w;
    }
  });
  return `<svg viewBox="0 0 ${rows[0].length} ${n}" shape-rendering="crispEdges" `
    + `xmlns="http://www.w3.org/2000/svg">${out}</svg>`;
}

const OUTLINE = '#17101f';

// Both medicines report the same three outcomes, and the two FAILURES are not the same thing:
// `api.heal` returns 0 both for a full-HP target and for a fainted one, and telling a player their
// fainted Pokemon "is already at full HP" is nonsense. ok:false leaves the item in the bag either
// way (see useItem), so a misdirected medicine is never wasted — it just says why.
// `success` is a builder rather than a string because only one of the two wants to name a number.
const healResult = (got, mon, success) => {
  if (got > 0) return { ok: true, msg: success(got) };
  if (mon.hp <= 0) return { ok: false, msg: `${mon.name} has fainted. Only a Revive can bring it back.` };
  return { ok: false, msg: `${mon.name} is already at full HP.` };
};

export const ITEMS = [
  {
    id: 'poke-ball', name: 'Poke Ball', kind: 'ball', ballTier: 0, catchBase: 0.42, spawnWeight: 22, shopPrice: 10,
    desc: 'The standard capture device. Used in the catch minigame - a steady base catch rate that your throw accuracy builds on.',
    shopDesc: 'The standard ball. A steady base catch rate.',
    icon: spriteIcon('poke-ball'),
    use: (api) => (api.setActiveBall('poke-ball'), { ok: false, msg: 'Poke Ball set for your next throw.' }),
  },
  {
    id: 'great-ball', name: 'Great Ball', kind: 'ball', ballTier: 1, catchBase: 0.58, spawnWeight: 13, shopPrice: 20,
    desc: 'A better ball than the Poke Ball. Raises the base catch chance before your throw accuracy is added on top.',
    shopDesc: 'A stronger ball. Better odds than a Poke Ball.',
    icon: spriteIcon('great-ball'),
    use: (api) => (api.setActiveBall('great-ball'), { ok: false, msg: 'Great Ball set for your next throw.' }),
  },
  {
    id: 'ultra-ball', name: 'Ultra Ball', kind: 'ball', ballTier: 2, catchBase: 0.74, spawnWeight: 7, shopPrice: 40,
    desc: 'The best ball you can buy down here. The highest base catch chance - a clean throw with one is close to a sure thing.',
    shopDesc: 'The best ball on sale. The highest catch rate.',
    icon: spriteIcon('ultra-ball'),
    use: (api) => (api.setActiveBall('ultra-ball'), { ok: false, msg: 'Ultra Ball set for your next throw.' }),
  },
  {
    // The one ball that CANNOT fail, and the only item in the game that ignores the minigame.
    //
    // `guaranteed` is a flag rather than a catchBase of 1.0 on purpose: catch.js caps every
    // computed chance at 0.97 and docks later evolution stages, so arithmetic alone can never
    // express "certain". catchBase is still 1 so that the difficulty ring's colour maths lands on
    // green without a special case; the certainty itself lives in the `guaranteed` branches in
    // catch.js (resolveContact and finishThrow), which is also what makes a MISS a catch.
    //
    // NOT in the spawn or shop pools. It has no `shopPrice`, which is what keeps it off Kecleon's
    // blanket (rollShopStock only stocks priced items), and no `spawnWeight`, because it does not
    // spawn on its own: randomBallId() gives it a MASTER_BALL_CHANCE shot at replacing whichever
    // ball a floor was about to lay down. It is also excluded from inventory.bestBall(), so
    // holding one never silently arms it for a throw you did not mean to spend it on — the only
    // way it goes in your hand is picking it out of the bag or the catch screen's ball menu.
    id: 'master-ball', name: 'Master Ball', kind: 'ball', ballTier: 3, catchBase: 1, guaranteed: true,
    desc: 'The finest ball Silph Co. ever made, and there is no such thing as a bad throw with one. It catches whatever you threw it at - even if the ball never touched it. Never sold, and only ever found by luck.',
    icon: spriteIcon('master-ball'),
    use: (api) => (api.setActiveBall('master-ball'), { ok: false, msg: 'Master Ball set. This one cannot miss.' }),
  },
  {
    id: 'oran-berry', name: 'Oran Berry', kind: 'heal', needsTarget: true, spawnWeight: 20, shopPrice: 10,
    desc: 'A tart blue berry. Restores 20 HP to one party Pokemon. Like every medicine down here it does nothing for a Pokemon that has already fainted - that is a Revive’s job.',
    shopDesc: 'Restores 20 HP to one party Pokemon.',
    icon: spriteIcon('oran-berry'),
    // `healResult` is shared by both medicines: api.heal returns 0 both when there is nothing to
    // heal and when the target is fainted, and those are two different things to be told.
    use: (api, mon) => healResult(api.heal(mon, 20), mon, (n) => `${mon.name} recovered ${n} HP.`),
  },
  {
    id: 'full-restore', name: 'Full Restore', kind: 'heal', needsTarget: true, spawnWeight: 9, shopPrice: 30,
    desc: 'A potent medicine. Restores one party Pokemon to full HP, however much it has lost. It cannot bring back a Pokemon that has fainted - only a Revive does that.',
    shopDesc: 'Restores one Pokemon to full HP.',
    icon: spriteIcon('full-restore'),
    use: (api, mon) => healResult(api.heal(mon, Infinity), mon, () => `${mon.name} was fully restored.`),
  },
  {
    id: 'rare-candy', name: 'Rare Candy', kind: 'boost', needsTarget: true, spawnWeight: 8, shopPrice: 55,
    desc: 'Evolves one eligible party Pokemon on the spot. Has no effect on a Pokemon with nowhere left to evolve.',
    shopDesc: 'Evolves one eligible party Pokemon on the spot.',
    icon: spriteIcon('rare-candy'),
    use: (api, mon) => {
      const newName = api.evolve(mon);
      return newName
        ? { ok: true, msg: `Congratulations! It evolved into ${newName}!` }
        : { ok: false, msg: `${mon.name} cannot evolve any further.` };
    },
  },
  {
    id: 'town-map', name: 'Town Map', kind: 'field', spawnWeight: 10, shopPrice: 15,
    desc: 'Reveals the current floor’s full layout on the minimap and the pause map. Does not show items or Pokemon.',
    shopDesc: 'Reveals this floor’s full layout on your map.',
    icon: spriteIcon('town-map'),
    use: (api) => (api.revealMap(), { ok: true, msg: 'The whole floor layout appeared on your map!' }),
  },
  {
    id: 'dowsing-machine', name: 'Dowsing Machine', kind: 'field', spawnWeight: 9, shopPrice: 20,
    desc: 'Pings the floor and marks every item and every wild Pokemon on your map, wherever they are.',
    shopDesc: 'Marks every item and wild Pokemon on your map.',
    icon: spriteIcon('dowsing-machine'),
    use: (api) => (api.revealEntities(), { ok: true, msg: 'Every item and Pokemon on this floor was marked!' }),
  },
  {
    id: 'x-attack', name: 'X Attack', kind: 'boost', spawnWeight: 11, shopPrice: 25,
    desc: 'A combat stimulant. Every party Pokemon deals +5 damage per hit for the next 60 seconds.',
    shopDesc: 'Every party Pokemon hits for +5 for 60 seconds.',
    icon: spriteIcon('x-attack'),
    use: (api) => (api.buffAttack(5, 60000), { ok: true, msg: 'Your team’s attack rose! (+5 damage for 60s)' }),
  },
  {
    id: 'max-repel', name: 'Max Repel', kind: 'field', spawnWeight: 9, shopPrice: 20,
    desc: 'Wild Pokemon keep their distance for 45 seconds - they will not close in or trigger an encounter.',
    shopDesc: 'Wild Pokemon keep their distance for 45 seconds.',
    icon: spriteIcon('max-repel'),
    use: (api) => (api.setRepel(45000), { ok: true, msg: 'Wild Pokemon will keep away for 45 seconds.' }),
  },
  {
    id: 'escape-rope', name: 'Escape Rope', kind: 'field', spawnWeight: 8, shopPrice: 15,
    desc: 'Warps you straight to this floor’s up-stairs. The Rocket Grunt guarding them still has to be beaten.',
    shopDesc: 'Warps you straight to this floor’s up-stairs.',
    icon: spriteIcon('escape-rope'),
    use: (api) => (api.warpToStairs(), { ok: true, msg: 'You were pulled toward the stairs!' }),
  },
  {
    // The ONLY thing in the game that undoes a faint, and it does that job two ways.
    //
    // Pick a fainted party member in the bag and it brings THAT one back at half HP. Use it with
    // nobody picked (or with a healthy Pokemon picked) and it goes into reserve instead, firing
    // automatically the next time someone goes down mid-battle — which is the only form that is
    // any use during a fight, since the bag is not reachable from the battle screen.
    //
    // The direct form exists because medicines stopped reviving (see inventory.heal). Without it
    // a Pokemon that fainted with no Revive already in reserve was simply gone for the rest of the
    // run with nothing in the game able to help, and both medicines' text would be promising a
    // Revive that could not actually be pointed at it.
    //
    // `needsTarget` is deliberately NOT set: it must stay usable with no target at all.
    id: 'revive', name: 'Revive', kind: 'boost', spawnWeight: 7, shopPrice: 45,
    desc: 'The only thing that undoes a faint. Use it on a fainted party Pokemon to bring it back at half HP - or use it with nobody selected to hold it in reserve, and the next Pokemon to faint mid-battle comes straight back on its own.',
    shopDesc: 'Revives a fainted Pokemon, or waits in reserve.',
    icon: spriteIcon('revive'),
    use: (api, mon) => {
      if (mon && mon.hp <= 0) {
        const got = api.revive(mon);
        return { ok: true, msg: `${mon.name} was revived with ${got} HP!` };
      }
      api.grantRevive();
      return { ok: true, msg: 'A Revive is standing by for your next fainted Pokemon.' };
    },
  },
];

export const ITEM_BY_ID = new Map(ITEMS.map(i => [i.id, i]));
export const BALL_IDS = ITEMS.filter(i => i.kind === 'ball').map(i => i.id);

// Weighted random draw over everything that has a spawnWeight. The Master Ball has none, so it
// can never come out of here — see MASTER_BALL_CHANCE below for its one way in.
export function randomItemId(rng = Math.random) {
  const total = ITEMS.reduce((s, i) => s + (i.spawnWeight || 0), 0);
  let r = rng() * total;
  for (const i of ITEMS) { r -= (i.spawnWeight || 0); if (r <= 0) return i.id; }
  return ITEMS[0].id;
}

// The same draw with the balls taken out.
//
// Floors now guarantee AT LEAST 15 Poke Balls, and dungeon.js hits that with a dedicated pass that
// counts what it has placed. If the generic pickup draw could also roll a ball it would overshoot
// that floor by an unbounded amount and the guarantee would stop meaning anything, so the two
// pools are kept disjoint: balls come only from the guaranteed pass (and from Kecleon).
const FIELD_ITEMS = ITEMS.filter(i => i.kind !== 'ball');
export function randomFieldItemId(rng = Math.random) {
  const total = FIELD_ITEMS.reduce((s, i) => s + i.spawnWeight, 0);
  let r = rng() * total;
  for (const i of FIELD_ITEMS) { r -= i.spawnWeight; if (r <= 0) return i.id; }
  return FIELD_ITEMS[0].id;
}

// Weighted draw over the ball tiers, for the guaranteed-ball pass. Deliberately steeper than the
// `spawnWeight` ratio: that one was balanced against a pool the field items were also in, and
// reused here it hands out Ultra Balls on floor 1 at a rate that trivialises early catches.
// The Master Ball is deliberately absent — it is not a tier in this draw, it is an override on it.
const BALL_SPAWN_WEIGHT = { 'poke-ball': 66, 'great-ball': 26, 'ultra-ball': 8 };
const BALL_TIERS = Object.keys(BALL_SPAWN_WEIGHT);

// The Master Ball's only way into the game: every ball a floor is about to lay down gets this
// chance of turning out to be one instead.
//
// Rolled per PICKUP and not per ball. A ball pickup holds 1-5 of its type, and five guaranteed
// catches out of one marker is not a rare find, it is the rest of the run — so dungeon.js pins the
// quantity to 1 when this comes up. It still counts toward the floor's fifteen, which means a
// Master Ball costs that floor one ordinary ball and nothing more.
//
// A floor lays down roughly 6 ball pickups to clear its quota of 15, so at 1/50 a given floor has
// about an 11% chance of holding one and a full five-floor run about 45%. That is the intent:
// something most runs never see.
export const MASTER_BALL_CHANCE = 1 / 50;

export function randomBallId(rng = Math.random) {
  if (rng() < MASTER_BALL_CHANCE) return 'master-ball';
  const total = BALL_TIERS.reduce((s, id) => s + BALL_SPAWN_WEIGHT[id], 0);
  let r = rng() * total;
  for (const id of BALL_TIERS) { r -= BALL_SPAWN_WEIGHT[id]; if (r <= 0) return id; }
  return BALL_TIERS[0];
}

// ---- Coins ------------------------------------------------------------------------------------
// The three denominations that scatter across every floor, and the only currency Kecleon takes.
// Coins are not bag items (see the file header): they collapse into a single `run.coins` total the
// moment they are picked up, so there is nothing to carry and nothing to choose between.
//
// VALUES ARE 1 / 5 / 10, as in Pokemon Rumble Run. That is the scale the whole economy is set on
// and it is why every shopPrice above is a two-digit number: coins are counted in ones and tens
// here, not in hundreds.
//
// THE ECONOMY, because the shop prices above are meaningless without it. dungeon.js spawns
// `7 + floor * 2` coins (9 on floor 1 up to 17 on floor 5) drawn on the weights below, which is an
// expected 3.2 coins per pickup and so roughly 29-54 per floor. Kecleon is guaranteed on floor 4,
// so a player who has cleared three floors arrives with about 120: enough for a strong loadout (an
// Ultra Ball at 40 and a Rare Candy at 55, with change for a Town Map) and not enough to clear the
// shelf. Finding him early instead, on floor 1, leaves about 30 — one or two of the cheap items,
// which is what an early stall should be.
// Changing a weight or a value here means re-reading the prices above.
const coinArt = (body, glyph, rim, fat = false) => pixelIcon(
  { k: OUTLINE, S: body, P: glyph, H: rim },
  fat
    ? ['..kkkkkk..', '.kHHHHHHk.', 'kHSPPPSSHk', 'kHSPSSPSSk', 'kHSPSSPSSk',
       'kHSPPPSSHk', 'kHSPSSSSHk', 'kHSPSSSSHk', '.kHHHHHHk.', '..kkkkkk..']
    : ['...kkkk...', '.kkSSSSkk.', 'kSSPPPSSSk', 'kSSPSSPSSk', 'kSSPSSPSSk',
       'kSSPPPSSSk', 'kSSPSSSSSk', 'kSSPSSSSSk', '.kkSSSSkk.', '...kkkk...'],
);

export const COINS = [
  {
    id: 'coin-silver', name: 'Silver Coin', value: 1, spawnWeight: 60,
    // Model height in world units, taken from the rip's own proportions (0.447 / 0.639 / 0.990)
    // so the three denominations stay in their real size relationship on the floor.
    height: 0.45,
    icon: coinArt('#cfd8dc', '#6f7d84', '#eceff1'),
  },
  {
    id: 'coin-gold', name: 'Gold Coin', value: 5, spawnWeight: 28,
    height: 0.62,
    icon: coinArt('#f2c12e', '#9a6f14', '#ffe082'),
  },
  {
    id: 'coin-large', name: 'Big Gold Coin', value: 10, spawnWeight: 12,
    height: 0.9,
    icon: coinArt('#ffd54f', '#8a5f0f', '#fff3c4', true),
  },
];

export const COIN_BY_ID = new Map(COINS.map(c => [c.id, c]));

export function randomCoinId(rng = Math.random) {
  const total = COINS.reduce((s, c) => s + c.spawnWeight, 0);
  let r = rng() * total;
  for (const c of COINS) { r -= c.spawnWeight; if (r <= 0) return c.id; }
  return COINS[0].id;
}
