// Super-effective-only type chart. Per the design brief (§9) resistances and immunities are
// ignored entirely: every hit lands at normal damage unless it is super effective, in which case
// it is multiplied by SUPER_EFFECTIVE_MULTIPLIER (x1.5, confirmed).
// Keys are attacking types; values are the defending types they are super effective against.
export const TYPES = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground',
  'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
];

export const SUPER_EFFECTIVE = {
  Normal:   [],
  Fire:     ['Grass', 'Ice', 'Bug', 'Steel'],
  Water:    ['Fire', 'Ground', 'Rock'],
  Electric: ['Water', 'Flying'],
  Grass:    ['Water', 'Ground', 'Rock'],
  Ice:      ['Grass', 'Ground', 'Flying', 'Dragon'],
  Fighting: ['Normal', 'Ice', 'Rock', 'Dark', 'Steel'],
  Poison:   ['Grass', 'Fairy'],
  Ground:   ['Fire', 'Electric', 'Poison', 'Rock', 'Steel'],
  Flying:   ['Grass', 'Fighting', 'Bug'],
  Psychic:  ['Fighting', 'Poison'],
  Bug:      ['Grass', 'Psychic', 'Dark'],
  Rock:     ['Fire', 'Ice', 'Flying', 'Bug'],
  Ghost:    ['Psychic', 'Ghost'],
  Dragon:   ['Dragon'],
  Dark:     ['Psychic', 'Ghost'],
  Steel:    ['Ice', 'Rock', 'Fairy'],
  Fairy:    ['Fighting', 'Dragon', 'Dark'],
};

// An attack is super effective if ANY of the attacker's types beats ANY of the defender's types.
export function isSuperEffective(attackerTypes, defenderTypes) {
  if (!attackerTypes || !defenderTypes) return false;
  return attackerTypes.some(a => (SUPER_EFFECTIVE[a] || []).some(t => defenderTypes.includes(t)));
}

// Type badge art shipped in "Pokemon Types/" — question.png is the unknown placeholder.
export function typeIconPath(type) {
  return TYPES.includes(type) ? `Pokemon Types/${type}.png` : 'Pokemon Types/question.png';
}

// Flat tint per type, used for HUD accents and themed floor lighting.
export const TYPE_COLOR = {
  Normal: 0xa8a878, Fire: 0xf08030, Water: 0x6890f0, Electric: 0xf8d030, Grass: 0x78c850,
  Ice: 0x98d8d8, Fighting: 0xc03028, Poison: 0xa040a0, Ground: 0xe0c068, Flying: 0xa890f0,
  Psychic: 0xf85888, Bug: 0xa8b820, Rock: 0xb8a038, Ghost: 0x705898, Dragon: 0x7038f8,
  Dark: 0x705848, Steel: 0xb8b8d0, Fairy: 0xee99ac,
};
