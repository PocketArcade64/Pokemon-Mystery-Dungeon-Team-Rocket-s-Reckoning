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

const SVG = (inner) => `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

// Shared ball art: `top` is the upper hemisphere color, `band` the trim under it.
const ballArt = (top, band, extra = '') => SVG(`
  <circle cx="24" cy="24" r="17" fill="#f4f4f4" stroke="#1a1a20" stroke-width="2.5"/>
  <path d="M7 24a17 17 0 0 1 34 0z" fill="${top}" stroke="#1a1a20" stroke-width="2.5"/>
  ${extra}
  <rect x="7" y="21.5" width="34" height="5" fill="${band}" stroke="#1a1a20" stroke-width="2"/>
  <circle cx="24" cy="24" r="5.5" fill="#fff" stroke="#1a1a20" stroke-width="2.5"/>
  <circle cx="24" cy="24" r="2" fill="#c9ccd6"/>`);

export const ITEMS = [
  {
    id: 'poke-ball', name: 'Poké Ball', kind: 'ball', ballTier: 0, catchBase: 0.42, spawnWeight: 22,
    desc: 'The standard capture device. Used in the catch minigame — a steady base catch rate that your throw accuracy builds on.',
    svg: ballArt('#e5453b', '#1a1a20'),
    use: (api) => (api.setActiveBall('poke-ball'), { ok: false, msg: 'Poké Ball set for your next throw.' }),
  },
  {
    id: 'great-ball', name: 'Great Ball', kind: 'ball', ballTier: 1, catchBase: 0.58, spawnWeight: 13,
    desc: 'A better ball than the Poké Ball. Raises the base catch chance before your throw accuracy is added on top.',
    svg: ballArt('#3b6fd4', '#1a1a20', '<path d="M13 11c4 4 6 8 6 13h4c0-7-3-12-7-16zM35 11c-4 4-6 8-6 13h-4c0-7 3-12 7-16z" fill="#e5453b" stroke="#1a1a20" stroke-width="1.6"/>'),
    use: (api) => (api.setActiveBall('great-ball'), { ok: false, msg: 'Great Ball set for your next throw.' }),
  },
  {
    id: 'ultra-ball', name: 'Ultra Ball', kind: 'ball', ballTier: 2, catchBase: 0.74, spawnWeight: 7,
    desc: 'The best ball you will find down here. The highest base catch chance — a clean throw with one is close to a sure thing.',
    svg: ballArt('#26262c', '#1a1a20', '<path d="M13 12h8v9h-8zM27 12h8v9h-8z" fill="#f2c12e" stroke="#1a1a20" stroke-width="1.6"/>'),
    use: (api) => (api.setActiveBall('ultra-ball'), { ok: false, msg: 'Ultra Ball set for your next throw.' }),
  },
  {
    id: 'oran-berry', name: 'Oran Berry', kind: 'heal', needsTarget: true, spawnWeight: 20,
    desc: 'A tart blue berry. Restores 20 HP to one party Pokémon.',
    svg: SVG(`
      <path d="M24 12c-8 0-13 5-13 12s6 11 13 11 13-4 13-11-5-12-13-12z" fill="#4f8ee0" stroke="#1a1a20" stroke-width="2.5"/>
      <path d="M17 20c2-3 5-4 7-4" stroke="#bcd9ff" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      <path d="M24 12c0-4 3-6 6-6-1 4-3 6-6 6z" fill="#5fbf52" stroke="#1a1a20" stroke-width="2"/>`),
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
    svg: SVG(`
      <rect x="16" y="14" width="16" height="26" rx="3" fill="#eef2f8" stroke="#1a1a20" stroke-width="2.5"/>
      <rect x="20" y="8" width="8" height="7" rx="2" fill="#8f97a8" stroke="#1a1a20" stroke-width="2.5"/>
      <rect x="16" y="24" width="16" height="9" fill="#e5453b" stroke="#1a1a20" stroke-width="2"/>
      <path d="M24 25.5v6M21 28.5h6" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`),
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
    svg: SVG(`
      <rect x="14" y="18" width="20" height="12" rx="4" fill="#f0648c" stroke="#1a1a20" stroke-width="2.5"/>
      <path d="M14 18l-7-4v20l7-4zM34 18l7-4v20l-7-4z" fill="#7ec8f0" stroke="#1a1a20" stroke-width="2.5"/>
      <path d="M19 22h10" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`),
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
    svg: SVG(`
      <path d="M8 14l10-4 12 4 10-4v24l-10 4-12-4-10 4z" fill="#f2e3bd" stroke="#1a1a20" stroke-width="2.5"/>
      <path d="M18 10v24M30 14v24" stroke="#1a1a20" stroke-width="1.6"/>
      <path d="M12 22c5-3 9 3 14 0s7 2 11 0" stroke="#5fbf52" stroke-width="2.2" fill="none"/>
      <circle cx="27" cy="29" r="2.6" fill="#e5453b" stroke="#1a1a20" stroke-width="1.6"/>`),
    use: (api) => (api.revealMap(), { ok: true, msg: 'The whole floor layout appeared on your map!' }),
  },
  {
    id: 'dowsing-machine', name: 'Dowsing Machine', kind: 'field', spawnWeight: 9,
    desc: 'Pings the floor and marks every item and every wild Pokémon on your map, wherever they are.',
    svg: SVG(`
      <rect x="12" y="20" width="24" height="18" rx="4" fill="#d8452f" stroke="#1a1a20" stroke-width="2.5"/>
      <rect x="17" y="25" width="14" height="8" rx="2" fill="#9be8c8" stroke="#1a1a20" stroke-width="2"/>
      <path d="M24 20v-6" stroke="#1a1a20" stroke-width="2.5"/>
      <path d="M17 11a10 10 0 0 1 14 0" stroke="#f2c12e" stroke-width="2.4" fill="none" stroke-linecap="round"/>`),
    use: (api) => (api.revealEntities(), { ok: true, msg: 'Every item and Pokémon on this floor was marked!' }),
  },
  {
    id: 'x-attack', name: 'X Attack', kind: 'boost', spawnWeight: 11,
    desc: 'A combat stimulant. Every party Pokémon deals +5 damage per hit for the next 60 seconds.',
    svg: SVG(`
      <rect x="15" y="16" width="18" height="24" rx="3" fill="#f2933a" stroke="#1a1a20" stroke-width="2.5"/>
      <rect x="20" y="9" width="8" height="8" rx="2" fill="#8f97a8" stroke="#1a1a20" stroke-width="2.5"/>
      <path d="M20 24l8 9M28 24l-8 9" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`),
    use: (api) => (api.buffAttack(5, 60000), { ok: true, msg: 'Your team’s attack rose! (+5 damage for 60s)' }),
  },
  {
    id: 'max-repel', name: 'Max Repel', kind: 'field', spawnWeight: 9,
    desc: 'Wild Pokémon keep their distance for 45 seconds — they will not close in or trigger an encounter.',
    svg: SVG(`
      <rect x="16" y="16" width="16" height="24" rx="3" fill="#5fbf52" stroke="#1a1a20" stroke-width="2.5"/>
      <rect x="20" y="9" width="8" height="8" rx="2" fill="#8f97a8" stroke="#1a1a20" stroke-width="2.5"/>
      <path d="M34 14c3 0 5 2 5 5M34 19c1.5 0 2.5 1 2.5 2.5" stroke="#9be8c8" stroke-width="2.2" fill="none" stroke-linecap="round"/>
      <path d="M20 26h8M20 31h8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`),
    use: (api) => (api.setRepel(45000), { ok: true, msg: 'Wild Pokémon will keep away for 45 seconds.' }),
  },
  {
    id: 'escape-rope', name: 'Escape Rope', kind: 'field', spawnWeight: 8,
    desc: 'Warps you straight to this floor’s up-stairs. The Rocket Grunt guarding them still has to be beaten.',
    svg: SVG(`
      <path d="M13 40c0-10 6-10 6-18s-4-8-4-12" stroke="#c98a4b" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M35 40c0-10-6-10-6-18s4-8 4-12" stroke="#a86f36" stroke-width="4" fill="none" stroke-linecap="round"/>
      <circle cx="24" cy="34" r="6" fill="none" stroke="#e0d3b4" stroke-width="3"/>`),
    use: (api) => (api.warpToStairs(), { ok: true, msg: 'You were pulled toward the stairs!' }),
  },
  {
    id: 'revive', name: 'Revive', kind: 'boost', spawnWeight: 7,
    desc: 'Held in reserve. The next time a party Pokémon faints in battle it is automatically brought back at half HP.',
    svg: SVG(`
      <path d="M24 8l4.6 10.4L40 20l-8 7.6L34 40l-10-5.6L14 40l2-12.4L8 20l11.4-1.6z" fill="#f2d54e" stroke="#1a1a20" stroke-width="2.5"/>
      <path d="M24 17v10M19 22h10" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`),
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
