'use strict';

const { Dex } = require('@pkmn/sim');
const ARENA_DAMAGE_SCALE = 0.18;

                                                                                   
                                                                                  
                                                                              
                                                                           
const SUPPORTED_MOVE_IDS = new Set(`
tackle scratch pound quickattack extremespeed bodyslam headbutt slash cut strength stomp swift hypervoice
ember flamethrower fireblast flamewheel firepunch heatwave
watergun bubblebeam surf hydropump waterfall aquatail aquajet waterpulse
vinewhip razorleaf leafblade magicalleaf energyball gigadrain megadrain absorb seedbomb powerwhip leafstorm
thundershock thunderbolt thunder thunderpunch spark discharge zapcannon nuzzle chargebeam shockwave
powdersnow icebeam blizzard icepunch icywind frostbreath
karatechop brickbreak closecombat aurasphere focusblast vacuumwave machpunch drainpunch
poisonsting sludge sludgebomb sludgewave poisonjab crosspoison acid
mudslap mudshot earthpower earthquake bulldoze
gust wingattack aerialace airslash aircutter hurricane drillpeck peck bravebird
confusion psychic psybeam extrasensory psyshock zenheadbutt psychocut
bugbite strugglebug bugbuzz xscissor signalbeam silverwind leechlife
rockthrow rockslide stoneedge powergem ancientpower
astonish lick shadowball shadowclaw shadowsneak ominouswind
twister dragonbreath dragonclaw dragonpulse dracometeor
bite crunch darkpulse nightslash snarl feintattack
metalclaw ironhead flashcannon bulletpunch steelwing irontail mirrorshot
disarmingvoice drainingkiss fairywind moonblast dazzlinggleam playrough
takedown doubleedge wildcharge flareblitz headsmash volttackle
protect detect recover milkdrink softboiled slackoff healorder rest
swordsdance nastyplot dragondance agility irondefense acidarmor calmmind bulkup workup defensecurl harden amnesia
growl tailwhip leer metalsound screech charm faketears scaryface
thunderwave stunspore poisonpowder toxic willowisp sleeppowder spore hypnosis sing poisongas
splash transform counter mirrorcoat hiddenpower
`.trim().split(/\s+/));

const AOE_MOVES = new Set(['surf', 'earthquake', 'bulldoze', 'discharge', 'sludgewave', 'dazzlinggleam', 'hypervoice', 'heatwave', 'blizzard', 'rockslide', 'snarl', 'strugglebug', 'icywind']);
const PULSE_MOVES = new Set(['earthquake', 'bulldoze', 'discharge', 'dazzlinggleam', 'hypervoice', 'snarl', 'strugglebug']);
const SELF_STATUS = new Set(['protect', 'detect', 'recover', 'milkdrink', 'softboiled', 'slackoff', 'healorder', 'rest', 'swordsdance', 'nastyplot', 'dragondance', 'agility', 'irondefense', 'acidarmor', 'calmmind', 'bulkup', 'workup', 'defensecurl', 'harden', 'amnesia', 'splash', 'counter', 'mirrorcoat']);
const idOf = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const finite = (n, fallback = 0) => Number.isFinite(Number(n)) ? Number(n) : fallback;

function getMove(id) {
  id = idOf(id);
  if (!SUPPORTED_MOVE_IDS.has(id) && id !== 'struggle') return null;
  const move = Dex.moves.get(id);
  if (!move.exists) return null;
  return move;
}

function effectiveType(move) { return move.id === 'hiddenpower' ? 'Dark' : move.type; }

function typeMultiplier(type, targetTypes, ignoreImmunity = false) {
  let mult = 1;
  for (const targetType of targetTypes) {
    const code = Dex.types.get(targetType).damageTaken[type];
    if (code === 3) { if (!ignoreImmunity) return 0; }
    else if (code === 1) mult *= 2;
    else if (code === 2) mult /= 2;
  }
  return mult;
}

function stageMultiplier(stage) {
  const value = clamp(finite(stage), -6, 6);
  return value >= 0 ? (2 + value) / 2 : 2 / (2 - value);
}

function accuracyMultiplier(stage) {
  const value = clamp(finite(stage), -6, 6);
  return value >= 0 ? (3 + value) / 3 : 3 / (3 - value);
}

function canonicalStats(baseStats) {
                                                                           
  const result = {};
  for (const stat of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
    const base = finite(baseStats[stat], 50);
    result[stat] = Math.floor((2 * base + 31) * 0.5) + (stat === 'hp' ? 60 : 5);
  }
  if (baseStats.hp === 1) result.hp = 1;                            
  return result;
}

function calculateDamage(attacker, defender, move, random = Math.random) {
  const type = effectiveType(move);
  const effectiveness = move.id === 'struggle' ? 1 : typeMultiplier(type, defender.types, Boolean(move.ignoreImmunity));
  if (effectiveness === 0) return { damage: 0, canonicalDamage: 0, effectiveness: 0, critical: false };
  const critRate = move.willCrit ? 1 : move.critRatio >= 2 ? 1 / 8 : 1 / 24;
  const critical = random() < critRate;
  const atkStat = move.category === 'Physical' ? 'atk' : 'spa';
  const defStat = move.overrideDefensiveStat || (move.category === 'Physical' ? 'def' : 'spd');
  let atkStage = attacker.stages?.[atkStat] || 0;
  let defStage = defender.stages?.[defStat] || 0;
  if (critical) { atkStage = Math.max(0, atkStage); defStage = Math.min(0, defStage); }
  let attack = attacker.stats[atkStat] * stageMultiplier(atkStage);
  let defense = defender.stats[defStat] * stageMultiplier(defStage);
  if (attacker.ability === 'hugepower' || attacker.ability === 'purepower') { if (atkStat === 'atk') attack *= 2; }
  if (attacker.ability === 'guts' && attacker.status && atkStat === 'atk') attack *= 1.5;
  if (defender.ability === 'furcoat' && defStat === 'def') defense *= 2;
  let power = move.basePower;
  if (attacker.hp <= attacker.maxHp / 3 && ({blaze:'Fire',torrent:'Water',overgrow:'Grass',swarm:'Bug'})[attacker.ability] === type) power *= 1.5;
  if (attacker.ability === 'technician' && power <= 60) power *= 1.5;
  let damage = Math.floor(Math.floor(Math.floor(2 * 50 / 5 + 2) * power * attack / defense) / 50) + 2;
  if (critical) damage = Math.floor(damage * 1.5);
  damage = Math.floor(damage * (85 + Math.floor(random() * 16)) / 100);
  if (attacker.types.includes(type) && move.id !== 'struggle') damage = Math.floor(damage * (attacker.ability === 'adaptability' ? 2 : 1.5));
  damage = Math.floor(damage * effectiveness);
  if (attacker.status === 'brn' && move.category === 'Physical' && attacker.ability !== 'guts') damage = Math.floor(damage / 2);
  if (defender.ability === 'thickfat' && ['Fire', 'Ice'].includes(type)) damage = Math.floor(damage / 2);
  if (defender.ability === 'multiscale' && defender.hp === defender.maxHp) damage = Math.floor(damage / 2);
  const canonicalDamage=Math.max(1,damage);
  return { damage: Math.max(1,Math.floor(canonicalDamage*ARENA_DAMAGE_SCALE)), canonicalDamage, effectiveness, critical };
}

function moveSpec(move) {
  const isSelf = SELF_STATUS.has(move.id);
  const melee = Boolean(move.flags?.contact) && move.id !== 'drainingkiss';
  const power = move.basePower || 0;
  const fast=move.priority>0;
  const strong=power>=100;
  return {
    id: move.id, type: effectiveType(move), category: move.category,
    kind: isSelf ? 'self' : move.id === 'transform' ? 'target' : PULSE_MOVES.has(move.id) ? 'pulse' : melee ? 'melee' : 'projectile',
    cooldown: move.id === 'protect' || move.id === 'detect' ? 13 : move.heal || move.id === 'rest' ? 15 : move.category === 'Status' ? 7 : clamp(1.1 + power / 45 - move.priority * 0.3, 1.0, 4.6),
    radius: melee ? 44 : AOE_MOVES.has(move.id) ? 32 : move.category === 'Status' ? 16 : power >= 100 ? 20 : 13,
    speed: move.priority > 0 ? 700 : 430 + (move.category === 'Special' ? 50 : 0),
    range: melee ? 118 : PULSE_MOVES.has(move.id) ? 205 : 690,
    windup: fast ? .08 : strong ? .30 : .18,
    recovery: fast ? .18 : strong ? .32 : .25,
  };
}

function validateTeam(team, catalog) {
  if (!Array.isArray(team) || team.length < 1 || team.length > 3) throw new Error('Choose one to three Pokémon.');
  const speciesMap = catalog.speciesById || new Map(catalog.species.map(p => [p.id, p]));
  return team.map(entry => {
    const id = idOf(typeof entry === 'string' ? entry : entry?.species || entry?.id);
    const species = speciesMap.get(id);
    if (!species) throw new Error('That Pokémon is not in this roster.');
    const allowed = new Set([...(species.learnset || []), ...(species.moves || [])].map(idOf));
    const requested = typeof entry === 'object' && Array.isArray(entry.moves) && entry.moves.length ? entry.moves.map(idOf) : species.moves;
    if (!requested?.length || requested.length > 4) throw new Error(`${species.name} needs one to four supported legal moves.`);
    if (new Set(requested).size !== requested.length) throw new Error('Move slots must contain different moves.');
    for (const move of requested) if (!allowed.has(move) || !getMove(move)) throw new Error(`${species.name} cannot use that move in this ruleset.`);
    return { species, moves: requested };
  });
}

module.exports = { Dex, ARENA_DAMAGE_SCALE, SUPPORTED_MOVE_IDS, SELF_STATUS, AOE_MOVES, idOf, clamp, finite, getMove, effectiveType, typeMultiplier, stageMultiplier, accuracyMultiplier, canonicalStats, calculateDamage, moveSpec, validateTeam };
