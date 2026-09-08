// Every item / power-up in the game (design brief §8). This file is the SINGLE source of truth for
// three consumers: floor spawn logic (dungeon.js reads `spawnWeight`), the bag screen and the
// world pickup marker (both render `svg`), and the Glossary screen (reads `name` + `desc`).
//
// `use(api, mon)` performs the effect. `api` is supplied by inventory.js and exposes only what
// items are allowed to touch, so nothing here needs to import game state:
//   api.party            live party array (mon objects: {dex,name,types,stage,hp,maxHp,dmg})
//   api.heal(mon, amt)   amt === Infinity restores to full; returns HP actually restored
//   api.evolve(mon)      evolves in place if its evolvesInto is non-empty; returns new name or null
//   api.revealMap()      Town Map: uncovers the whole floor on the minimap
//   api.revealEntities() Dowsing Machine: uncovers every item + wild Pokemon on the floor
//   api.buffAttack(bonus, ms)
//   api.setRepel(ms)
//   api.warpToStairs()
//   api.grantRevive()
//   api.setActiveBall(id)
// Every use() returns { ok, msg } — msg is shown as a toast; ok:false leaves the item unconsumed.

// ---- Pixel-art icons ---------------------------------------------------------------------------
// Every icon is a 10x10 grid drawn as ASCII right here in the source, so the art is editable
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

// Shared ball art. `top` is the upper hemisphere, `mark` the species-specific decoration colour
// used by the Great and Ultra Balls (the plain Poke Ball just paints it the same as `top`).
const ballArt = (top, hi, mark = top, rows2 = '.kTtTTTTk.', rows3 = 'kTtTTTTTTk') => pixelIcon(
  { k: OUTLINE, T: top, t: hi, a: mark, W: '#ffffff', B: '#eef1f8' },
  [
    '...kkkk...',
    '.kkTTTTkk.',
    rows2,
    rows3,
    'kkkkkkkkkk',
    'kWWkBBkWWk',
    'kWWkkkkWWk',
    'kWWWWWWWWk',
    '.kkWWWWkk.',
    '...kkkk...',
  ],
);

export const ITEMS = [
  {
    id: 'poke-ball', name: 'Poké Ball', kind: 'ball', ballTier: 0, catchBase: 0.42, spawnWeight: 22,
    desc: 'The standard capture device. Used in the catch minigame — a steady base catch rate that your throw accuracy builds on.',
    svg: ballArt('#e5453b', '#ff8f86'),
    use: (api) => (api.setActiveBall('poke-ball'), { ok: false, msg: 'Poké Ball set for your next throw.' }),
  },
  {
    id: 'great-ball', name: 'Great Ball', kind: 'ball', ballTier: 1, catchBase: 0.58, spawnWeight: 13,
    desc: 'A better ball than the Poké Ball. Raises the base catch chance before your throw accuracy is added on top.',
    // The two red stripes down the blue shell.
    svg: ballArt('#3b6fd4', '#7ea6ef', '#e5453b', '.kTaTTaTk.', 'kTaTTTTaTk'),
    use: (api) => (api.setActiveBall('great-ball'), { ok: false, msg: 'Great Ball set for your next throw.' }),
  },
  {
    id: 'ultra-ball', name: 'Ultra Ball', kind: 'ball', ballTier: 2, catchBase: 0.74, spawnWeight: 7,
    desc: 'The best ball you will find down here. The highest base catch chance — a clean throw with one is close to a sure thing.',
    // The two yellow blocks on the black shell.
    svg: ballArt('#2a2a33', '#565662', '#f2c12e', '.kaaTTaak.', 'kTaaTTaaTk'),
    use: (api) => (api.setActiveBall('ultra-ball'), { ok: false, msg: 'Ultra Ball set for your next throw.' }),
  },
  {
    id: 'oran-berry', name: 'Oran Berry', kind: 'heal', needsTarget: true, spawnWeight: 20,
    desc: 'A tart blue berry. Restores 20 HP to one party Pokémon.',
    svg: pixelIcon({ k: OUTLINE, B: '#4f8ee0', h: '#bcd9ff', g: '#5fbf52' }, [
      '....gg....',
      '...gg.....',
      '..kkkkkk..',
      '.kBBBBBBk.',
      'kBhBBBBBBk',
      'kBhBBBBBBk',
      'kBBBBBBBBk',
      '.kBBBBBBk.',
      '..kkkkkk..',
      '..........',
    ]),
    use: (api, mon) => {
      const got = api.heal(mon, 20);
      return got > 0
        ? { ok: true, msg: `${mon.name} recovered ${got} HP.` }
        : { ok: false, msg: `${mon.name} is already at full HP.` };
    },
  },
  {
    id: 'full-heal', name: 'Full Heal', kind: 'heal', needsTarget: true, spawnWeight: 9,
    desc: 'A potent medicine. Restores one party Pokémon to full HP — and it will revive a fainted one.',
    svg: pixelIcon({ k: OUTLINE, W: '#eef2f8', R: '#e5453b', S: '#8f97a8' }, [
      '...kkk....',
      '..kSSSk...',
      '..kkkkk...',
      '.kWWWWWk..',
      '.kRRWRRk..',
      '.kRWWWRk..',
      '.kRRWRRk..',
      '.kWWWWWk..',
      '.kkkkkkk..',
      '..........',
    ]),
    use: (api, mon) => {
      const got = api.heal(mon, Infinity);
      return got > 0
        ? { ok: true, msg: `${mon.name} was fully restored.` }
        : { ok: false, msg: `${mon.name} is already at full HP.` };
    },
  },
  {
    id: 'rare-candy', name: 'Rare Candy', kind: 'boost', needsTarget: true, spawnWeight: 8,
    desc: 'Evolves one eligible party Pokémon on the spot. Has no effect on a Pokémon with nowhere left to evolve.',
    svg: pixelIcon({ k: OUTLINE, P: '#f0648c', p: '#ffc0d4', C: '#7ec8f0' }, [
      '..........',
      '..........',
      'kk......kk',
      'kCkkkkkkCk',
      'kCPPPPPPCk',
      'kCPpPPPPCk',
      'kCPPPPPPCk',
      'kCkkkkkkCk',
      'kk......kk',
      '..........',
    ]),
    use: (api, mon) => {
      const newName = api.evolve(mon);
      return newName
        ? { ok: true, msg: `Congratulations! It evolved into ${newName}!` }
        : { ok: false, msg: `${mon.name} cannot evolve any further.` };
    },
  },
  {
    id: 'town-map', name: 'Town Map', kind: 'field', spawnWeight: 10,
    desc: 'Reveals the current floor’s full layout on the minimap and the pause map. Does not show items or Pokémon.',
    svg: pixelIcon({ k: OUTLINE, M: '#f2e3bd', G: '#5fbf52', R: '#e5453b' }, [
      '..........',
      'kkkkkkkkkk',
      'kMMMMMMMMk',
      'kMGGMMGGMk',
      'kMMGGMGMMk',
      'kMMMMGGMMk',
      'kMMMRMMMMk',
      'kMMMMMMMMk',
      'kkkkkkkkkk',
      '..........',
    ]),
    use: (api) => (api.revealMap(), { ok: true, msg: 'The whole floor layout appeared on your map!' }),
  },
  {
    id: 'dowsing-machine', name: 'Dowsing Machine', kind: 'field', spawnWeight: 9,
    desc: 'Pings the floor and marks every item and every wild Pokémon on your map, wherever they are.',
    svg: pixelIcon({ k: OUTLINE, R: '#d8452f', S: '#9be8c8' }, [
      '..k...k...',
      '...k.k....',
      '....k.....',
      'kkkkkkkkkk',
      'kRRRRRRRRk',
      'kRkSSSSkRk',
      'kRkSSSSkRk',
      'kRRRRRRRRk',
      'kkkkkkkkkk',
      '..........',
    ]),
    use: (api) => (api.revealEntities(), { ok: true, msg: 'Every item and Pokémon on this floor was marked!' }),
  },
  {
    id: 'x-attack', name: 'X Attack', kind: 'boost', spawnWeight: 11,
    desc: 'A combat stimulant. Every party Pokémon deals +5 damage per hit for the next 60 seconds.',
    svg: pixelIcon({ k: OUTLINE, O: '#f2933a', W: '#ffffff', S: '#8f97a8' }, [
      '...kkk....',
      '..kSSSk...',
      '..kkkkk...',
      '.kOOOOOk..',
      '.kOWOWOk..',
      '.kOOWOOk..',
      '.kOWOWOk..',
      '.kOOOOOk..',
      '.kkkkkkk..',
      '..........',
    ]),
    use: (api) => (api.buffAttack(5, 60000), { ok: true, msg: 'Your team’s attack rose! (+5 damage for 60s)' }),
  },
  {
    id: 'max-repel', name: 'Max Repel', kind: 'field', spawnWeight: 9,
    desc: 'Wild Pokémon keep their distance for 45 seconds — they will not close in or trigger an encounter.',
    svg: pixelIcon({ k: OUTLINE, N: '#5fbf52', W: '#d8f5cf', S: '#8f97a8' }, [
      '...kkk....',
      '..kSSSk...',
      '..kkkkk...',
      '.kNNNNNk.k',
      '.kNWWWNk..',
      '.kNNNNNk.k',
      '.kNWWWNk..',
      '.kNNNNNk..',
      '.kkkkkkk..',
      '..........',
    ]),
    use: (api) => (api.setRepel(45000), { ok: true, msg: 'Wild Pokémon will keep away for 45 seconds.' }),
  },
  {
    id: 'escape-rope', name: 'Escape Rope', kind: 'field', spawnWeight: 8,
    desc: 'Warps you straight to this floor’s up-stairs. The Rocket Grunt guarding them still has to be beaten.',
    svg: pixelIcon({ k: OUTLINE, R: '#c98a4b' }, [
      '..........',
      '..kkkkkk..',
      '.kRRRRRRk.',
      'kRRk..kRRk',
      'kRR....RRk',
      'kRRk..kRRk',
      '.kRRRRRRk.',
      '..kkkkkk..',
      '..........',
      '..........',
    ]),
    use: (api) => (api.warpToStairs(), { ok: true, msg: 'You were pulled toward the stairs!' }),
  },
  {
    id: 'revive', name: 'Revive', kind: 'boost', spawnWeight: 7,
    desc: 'Held in reserve. The next time a party Pokémon faints in battle it is automatically brought back at half HP.',
    svg: pixelIcon({ k: OUTLINE, Y: '#f2d54e' }, [
      '....kk....',
      '...kYYk...',
      '...kYYk...',
      'kkkkYYkkkk',
      'kYYYYYYYYk',
      '.kYYYYYYk.',
      '..kYYYYk..',
      '.kYk..kYk.',
      '.k......k.',
      '..........',
    ]),
    use: (api) => (api.grantRevive(), { ok: true, msg: 'A Revive is standing by for your next fainted Pokémon.' }),
  },
];

export const ITEM_BY_ID = new Map(ITEMS.map(i => [i.id, i]));
export const BALL_IDS = ITEMS.filter(i => i.kind === 'ball').map(i => i.id);

// Weighted random draw, used by dungeon.js when populating a floor with pickups.
export function randomItemId(rng = Math.random) {
  const total = ITEMS.reduce((s, i) => s + i.spawnWeight, 0);
  let r = rng() * total;
  for (const i of ITEMS) { r -= i.spawnWeight; if (r <= 0) return i.id; }
  return ITEMS[0].id;
}
