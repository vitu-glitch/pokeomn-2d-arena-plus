'use strict';

const { Dex, ARENA_DAMAGE_SCALE, clamp, finite, idOf, getMove, moveSpec, calculateDamage, typeMultiplier, stageMultiplier, accuracyMultiplier, canonicalStats, effectiveType } = require('./rules.cjs');

const ARENAS = {
  stadium: { id:'stadium', width:1200, height:760, obstacles:[{x:465,y:225,w:90,h:105},{x:645,y:430,w:90,h:105}] },
  forest: { id:'forest', width:1200, height:760, obstacles:[{x:290,y:190,w:80,h:100},{x:830,y:465,w:80,h:105},{x:545,y:315,w:110,h:130}] },
  volcano: { id:'volcano', width:1200, height:760, obstacles:[{x:470,y:120,w:105,h:170},{x:625,y:470,w:105,h:170}] },
  coast: { id:'coast', width:1200, height:760, obstacles:[{x:430,y:300,w:95,h:170},{x:675,y:300,w:95,h:170}] },
  ruins: { id:'ruins', width:1200, height:760, obstacles:[{x:355,y:165,w:75,h:95},{x:770,y:165,w:75,h:95},{x:355,y:500,w:75,h:95},{x:770,y:500,w:75,h:95}] },
  summit: { id:'summit', width:1200, height:760, obstacles:[{x:535,y:150,w:130,h:95},{x:535,y:515,w:130,h:95}] },
};

const SUPPORTED_ABILITIES = new Set('overgrow blaze torrent swarm hugepower purepower guts furcoat adaptability technician thickfat multiscale levitate waterabsorb voltabsorb flashfire lightningrod stormdrain motordrive sapsipper wonderguard sturdy immunity limber insomnia vitalspirit waterveil magmaarmor owntempo synchronize static flamebody poisonpoint effectspore naturalcure regenerator'.split(' '));
const DEPLOYMENT={initial:1.1,switch:1.0,ball:.55,grace:.35};
const PP_ORBS={radius:10,firstSpawn:10,intervalMin:10,intervalMax:14,maxActive:2,lifetime:18};
const blankStages = () => ({atk:0,def:0,spa:0,spd:0,spe:0,accuracy:0,evasion:0});
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
function unit(x,y) { const size=Math.hypot(x,y); return size > 0.00001 ? {x:x/size,y:y/size} : {x:1,y:0}; }
function circleRect(x,y,r,o) { return Math.hypot(x-clamp(x,o.x,o.x+o.w),y-clamp(y,o.y,o.y+o.h)) < r; }
function collides(x,y,r,arena) { return x<r+18 || x>arena.width-r-18 || y<r+18 || y>arena.height-r-18 || arena.obstacles.some(o=>circleRect(x,y,r,o)); }

function moveCircle(body, dx, dy, arena) {
  const count = Math.max(1,Math.ceil(Math.hypot(dx,dy)/8));
  for(let step=0;step<count;step++) {
    let x = body.x+dx/count, y = body.y+dy/count;
    if(!collides(x,body.y,body.radius,arena)) body.x=x;
    if(!collides(body.x,y,body.radius,arena)) body.y=y;
  }
}

function clearLine(a,b,arena,radius=3) {
  const length=distance(a,b), steps=Math.max(1,Math.ceil(length/12));
  for(let i=1;i<steps;i++) if(arena.obstacles.some(o=>circleRect(a.x+(b.x-a.x)*i/steps,a.y+(b.y-a.y)*i/steps,radius,o))) return false;
  return true;
}

function createPokemon(entry, slot, team, level=50) {
  const species=entry.species, stats=canonicalStats(species.baseStats,level);
  const canonical=Dex.species.get(species.id);
  const abilityName=canonical.abilities?.['0'] || '';
  return {
    id:`p${team}`, team, slot, level, xp:0, nextEvolutionLevel:8, species:species.id, originalSpecies:species.id, name:species.name,
    sprite:species.sprite, spriteAnimated:species.spriteAnimated, types:[...species.types], originalTypes:[...species.types],
    stats, originalStats:{...stats}, hp:stats.hp, maxHp:stats.hp, m1Cooldown:0, stages:blankStages(),
    ability:SUPPORTED_ABILITIES.has(idOf(abilityName)) ? idOf(abilityName) : '', abilityName, abilityImplemented:SUPPORTED_ABILITIES.has(idOf(abilityName)),
    moves:entry.moves.map(id => ({id,pp:getMove(id).pp,maxPp:getMove(id).pp,cooldown:0})),struggleCooldown:0,
    originalMoves:null, transformed:false, x:team?970:230,y:380,vx:0,vy:0,radius:24,facing:{x:team?-1:1,y:0},
    status:null,statusTime:0,statusTick:0,toxicCounter:0,confusion:0,flinch:0,
    protect:.8,dodge:0,dodgeCooldown:0,dodgeDirection:{x:1,y:0},attackLock:0,castLock:0,
    action:null,deployment:null,evolution:null,hitstun:0,hurtTime:0,freezeImmunity:0,
    knockX:0,knockY:0,counter:0,counterCategory:null,flashFire:false,
  };
}

function evolutionMoveScore(move, types) {
  if (!move) return -Infinity;
  if (move.category === 'Status') {
    if (move.heal) return 58;
    if (move.self?.boosts || move.boosts) return 45;
    return 12;
  }
  const power = Number(move.basePower) || 0;
  const accuracy = typeof move.accuracy === 'number' ? clamp(move.accuracy, 30, 100) / 100 : 1;
  const balancedPower = Math.min(100, power) - Math.max(0, power - 100) * 1.5;
  const stab = (types || []).includes(effectiveType(move)) ? 15 : 0;
  return balancedPower * accuracy + stab + (move.secondaries?.length ? 4 : 0) + (move.drain ? 5 : 0) - (move.recoil ? 8 : 0);
}

class Battle {
  constructor({id,teams,arena='stadium',mode='cpu',stage=null,cpuLevel=1,random=Math.random,speciesById=null,onFinish=()=>{}}) {
    this.id=id; this.arena=ARENAS[arena] || ARENAS.stadium; this.mode=mode; this.stage=stage;
    this.teams=teams.map((team,index)=>({name:team.name,roster:team.team.map((p,slot)=>createPokemon(p,slot,index,mode==='battle-royale'?5:50)),active:0,input:{dx:0,dy:0,aimX:index?0:1200,aimY:380},switchCooldown:0,respawn:0,cpu:Boolean(team.cpu),aiTimer:0,attackWait:1,aiSide:index%2?-1:1}));
    if(mode==='battle-royale')for(const team of this.teams)for(const p of team.roster){p.healthScale=2.2;p.maxHp=Math.round(p.maxHp*p.healthScale);p.hp=p.maxHp;p.stats.hp=p.maxHp;p.originalStats.hp=p.maxHp;}
    this.projectiles=[]; this.ppOrbs=[]; this.nextPpOrbAt=PP_ORBS.firstSpawn; this.effects=[]; this.events=[]; this.tick=0; this.time=0; this.phase='battle'; this.paused=false; this.nextId=1; this.random=random; this.onFinish=onFinish; this.cpuLevel=cpuLevel;this.speciesById=speciesById||new Map();this.eliminations=teams.map(()=>0);this.zone=mode==='battle-royale'?{x:this.arena.width/2,y:this.arena.height/2,initialRadius:560,radius:560,minRadius:105,startsAt:65,closesAt:360,damage:2}:null;this.zoneDamageClock=0;
    const center={x:this.arena.width/2,y:this.arena.height/2};
    for(let index=0;index<this.teams.length;index++) {
      const team=this.teams[index],p=this.active(index);
      if(this.teams.length===2){p.x=index?970:230;p.y=380;p.facing={x:index?-1:1,y:0};}
      else {const baseAngle=-Math.PI/2+Math.PI*2*index/this.teams.length;let placed=false;for(let attempt=0;attempt<30;attempt++){const angle=baseAngle+attempt*.31,radius=270-Math.floor(attempt/15)*25,x=center.x+Math.cos(angle)*radius,y=center.y+Math.sin(angle)*radius,clear=!collides(x,y,p.radius,this.arena)&&this.teams.slice(0,index).every((other,otherIndex)=>distance(this.active(otherIndex),{x,y})>p.radius*2+12);if(clear){p.x=x;p.y=y;p.facing=unit(center.x-x,center.y-y);placed=true;break;}}if(!placed){const angle=baseAngle;p.x=center.x+Math.cos(angle)*220;p.y=center.y+Math.sin(angle)*220;p.facing=unit(center.x-p.x,center.y-p.y);}}
      team.input.aimX=p.x+p.facing.x*300;team.input.aimY=p.y+p.facing.y*300;
      this.beginDeployment(p,true);
      if(mode==='battle-royale'&&index===0)p.protect=4.5;
    }
  }
  setPaused(paused) {
    if(this.mode==='friend'||this.mode==='demo')return false;
    this.paused=Boolean(paused);
    if(this.paused)for(const team of this.teams){team.input.dx=0;team.input.dy=0;team.input.cast=null;team.input.m1=false;team.input.dodge=false;team.input.switch=null;}
    return true;
  }
  active(team) { const t=this.teams[team]; return t?.roster?.[t.active]||null; }
  opponents(teamIndex, livingOnly=true) { return this.teams.map((team,index)=>({index,p:this.active(index)})).filter(({index,p})=>index!==teamIndex&&p&&(!livingOnly||p.hp>0)).map(item=>item.p); }
  nearestOpponent(teamIndex, from=this.active(teamIndex)) { if(!from)return null;return this.opponents(teamIndex).sort((a,b)=>distance(from,a)-distance(from,b))[0]||null; }
  event(kind,text,extra={}) { const event={id:this.nextId++,kind,text,at:this.time,...extra}; this.events.push(event); this.events=this.events.slice(-24); return event; }
  effect(kind,x,y,type,text='',life=.65) { this.effects.push({id:this.nextId++,kind,x,y,type,text,life}); }
  input(teamIndex,input) {
    if(this.phase!=='battle'||this.paused) return;
    const t=this.teams[teamIndex]; if(!t) return;
    const vector=unit(finite(input.dx),finite(input.dy)); const mag=Math.min(1,Math.hypot(finite(input.dx),finite(input.dy)));
    t.input.dx=vector.x*mag; t.input.dy=vector.y*mag;
    t.input.aimX=clamp(finite(input.aimX,t.input.aimX),0,this.arena.width);
    t.input.aimY=clamp(finite(input.aimY,t.input.aimY),0,this.arena.height);
    t.input.lockOn=Boolean(input.lockOn);
    const p=this.active(teamIndex);
    if(p?.evolution){t.input.dx=0;t.input.dy=0;t.input.cast=null;t.input.m1=false;t.input.dodge=false;t.input.switch=null;return;}
    if(mag>.001&&!p.action&&!p.deployment)p.facing={...vector};
    if(Number.isInteger(input.switch)) this.switchPokemon(teamIndex,input.switch);
    if(input.dodge) this.dodge(teamIndex);
    if(input.m1) this.basicAttack(teamIndex);
    if(Number.isInteger(input.cast)) this.cast(teamIndex,input.cast);
  }
  dodge(teamIndex) {
    const p=this.active(teamIndex), t=this.teams[teamIndex];
    if(p.hp<=0 || p.deployment || p.evolution || p.action || p.hitstun>0 || p.dodgeCooldown>0 || p.status==='slp' || p.status==='frz' || p.flinch>0) return false;
    p.dodge=.26; p.dodgeCooldown=2.8;
    p.dodgeDirection=Math.hypot(t.input.dx,t.input.dy)>.001?unit(t.input.dx,t.input.dy):{...p.facing};
    this.effect('dodge',p.x,p.y,p.types[0],'',.25); return true;
  }
  switchPokemon(teamIndex,slot,forced=false) {
    const t=this.teams[teamIndex], before=this.active(teamIndex), after=t.roster[slot];
    if(!after || after.hp<=0 || slot===t.active || (!forced&&(before.hp<=0 || t.switchCooldown>0 || before.deployment || before.evolution || before.dodge>0 || before.action || before.hitstun>0))) return false;
    const outgoingSpecies=before.species;
    if(before.hp>0)this.event('recall',`${before.name}, return!`,{team:teamIndex,sourceSpecies:outgoingSpecies,targetSpecies:after.species,x:before.x,y:before.y,duration:.25});
    if(before.ability==='naturalcure') {before.status=null;before.statusTime=0;}
    if(before.ability==='regenerator' && before.hp>0) before.hp=Math.min(before.maxHp,before.hp+Math.floor(before.maxHp/3));
    before.stages=blankStages(); before.confusion=0; before.toxicCounter=0;before.counter=0;before.protect=0;before.action=null;before.attackLock=0;before.deployment=null;
    if(before.transformed) this.resetTransform(before);
    t.active=slot; t.respawn=0; t.switchCooldown=7;t.attackWait=1;
    after.x=before.x;after.y=before.y;after.vx=0;after.vy=0;after.knockX=0;after.knockY=0;after.dodge=0;after.protect=.8;
    after.facing={...before.facing};after.castLock=.5;after.action=null;after.attackLock=0;after.hitstun=0;after.hurtTime=0;
    this.beginDeployment(after,false);
    this.event('switch',`${t.name} sent out ${after.name}!`,{team:teamIndex,species:after.species,targetSpecies:after.species,sourceSpecies:outgoingSpecies,x:after.x,y:after.y}); return true;
  }
  beginDeployment(p,initial=false) {
    const total=initial?DEPLOYMENT.initial:DEPLOYMENT.switch;
    p.deployment={id:this.nextId++,phase:'ball',elapsed:0,duration:DEPLOYMENT.ball,total,totalElapsed:0,ballDuration:DEPLOYMENT.ball,releaseDuration:total-DEPLOYMENT.ball,initial};
    p.protect=total+DEPLOYMENT.grace;p.castLock=total;p.action=null;p.attackLock=0;p.vx=0;p.vy=0;p.knockX=0;p.knockY=0;
    this.teams[p.team].attackWait=total+.6;
    this.event('deploy',`Go, ${p.name}!`,{team:p.team,species:p.species,targetSpecies:p.species,x:p.x,y:p.y,fromX:p.x-(p.team?-1:1)*120,fromY:p.y+70,initial,deploymentId:p.deployment.id,duration:total,ballDuration:DEPLOYMENT.ball,releaseDuration:total-DEPLOYMENT.ball});
  }
  updateDeployment(p,dt) {
    const deployment=p.deployment;if(!deployment)return false;
    deployment.totalElapsed=Math.min(deployment.total,deployment.totalElapsed+dt);
    if(deployment.phase==='ball'&&deployment.totalElapsed+1e-8>=deployment.ballDuration) {
      deployment.phase='release';deployment.elapsed=deployment.totalElapsed-deployment.ballDuration;deployment.duration=deployment.releaseDuration;
      this.event('deployRelease',`${p.name} appeared!`,{team:p.team,species:p.species,targetSpecies:p.species,x:p.x,y:p.y,deploymentId:deployment.id,duration:deployment.releaseDuration});
      this.effect('summon',p.x,p.y,p.types[0],p.name,deployment.releaseDuration);
    }else deployment.elapsed=deployment.phase==='ball'?deployment.totalElapsed:deployment.totalElapsed-deployment.ballDuration;
    if(deployment.totalElapsed+1e-8>=deployment.total){p.deployment=null;p.castLock=0;return false;}
    return true;
  }
  resetTransform(p) {
    p.species=p.originalSpecies;p.types=[...p.originalTypes];p.stats={...p.originalStats};p.moves=p.originalMoves;p.originalMoves=null;p.transformed=false;
    const species=Dex.species.get(p.originalSpecies);p.name=species.name;p.abilityName=species.abilities['0'];p.ability=SUPPORTED_ABILITIES.has(idOf(p.abilityName))?idOf(p.abilityName):'';
  }
  changeStages(p,boosts) {
    if(!boosts) return;
    for(const [stat,amount] of Object.entries(boosts)) if(stat in p.stages) p.stages[stat]=clamp(p.stages[stat]+amount,-6,6);
    this.effect('boost',p.x,p.y,p.types[0],Object.entries(boosts).map(([s,v])=>`${s.toUpperCase()} ${v>0?'+':''}${v}`).join(' '),1);
  }
  applyStatus(p,status,source=null) {
    if(p.hp<=0 || p.status) return false;
    if(status==='brn'&&(p.types.includes('Fire')||p.ability==='waterveil')) return false;
    if((status==='psn'||status==='tox')&&(p.types.includes('Poison')||p.types.includes('Steel')||p.ability==='immunity')) return false;
    if(status==='par'&&(p.types.includes('Electric')||p.ability==='limber')) return false;
    if(status==='frz'&&(p.types.includes('Ice')||p.ability==='magmaarmor'||p.freezeImmunity>0)) return false;
    if(status==='slp'&&['insomnia','vitalspirit'].includes(p.ability)) return false;
    p.status=status;p.statusTime=status==='slp'?4+this.random()*4:status==='frz'?.8+this.random():60;p.statusTick=0;p.toxicCounter=0;
    this.event('status',`${p.name}: ${status.toUpperCase()}`,{team:p.team,status});
    this.effect('status',p.x,p.y,p.types[0],status.toUpperCase(),1.2);
    if(p.ability==='synchronize'&&source&&['par','brn','psn','tox'].includes(status)) this.applyStatus(source,status,null);
    return true;
  }
  basicAttack(teamIndex) {
    const t=this.teams[teamIndex],p=this.active(teamIndex);
    if(this.mode!=='battle-royale'||!t||!p||p.hp<=0||p.deployment||p.evolution||p.action||p.hitstun>0||p.attackLock>0||p.dodge>0||p.flinch>0||p.status==='slp'||p.status==='frz'||p.m1Cooldown>0)return false;
    const target=this.nearestOpponent(teamIndex,p);
    if(!target||target.hp<=0||distance(p,target)>220||!clearLine(p,target,this.arena))return false;
    const direction=unit(target.x-p.x,target.y-p.y);
    moveCircle(p,direction.x*28,direction.y*28,this.arena);
    p.facing=direction;p.m1Cooldown=.42;p.attackLock=.12;
    const move=getMove('scratch');
    this.effect('slash',p.x+direction.x*48,p.y+direction.y*48,'Normal','',.35);
    this.hit(p,target,move,direction,{sourceSpecies:p.species,actionId:this.nextId++});
    this.event('m1',`${p.name} used Scratch!`,{team:teamIndex,targetSpecies:target.species,sourceSpecies:p.species,x:target.x,y:target.y});
    return true;
  }
  cast(teamIndex,slot) {
    const t=this.teams[teamIndex], p=this.active(teamIndex);
    if(p.hp<=0 || p.deployment || p.evolution || p.action || p.hitstun>0 || p.castLock>0 || p.attackLock>0 || p.dodge>0 || p.flinch>0 || p.status==='slp') return false;
    const state=p.moves[slot],exhausted=state?.pp<=0;
    if(!Number.isInteger(slot) || !state || slot<0 || slot>3 || (exhausted?p.struggleCooldown:state.cooldown)>0) return false;
    const move=getMove(exhausted?'struggle':state.id), spec=moveSpec(move);
    if(p.status==='frz') {
      if(!move.flags?.defrost)return false;
      p.status=null;p.statusTime=0;p.freezeImmunity=4;this.effect('status',p.x,p.y,'Fire','Thawed',.8);
    }
    if(exhausted)p.struggleCooldown=spec.cooldown;
    else {state.pp--;state.cooldown=spec.cooldown;}
    p.attackLock=spec.windup+spec.recovery;
    if(p.status==='par' && this.random()<.25) {this.effect('status',p.x,p.y,'Electric','Paralyzed',.8);return false;}
    if(p.confusion>0 && this.random()<1/3) {
      const selfMove={id:'confusionself',type:'???',basePower:40,category:'Physical',critRatio:0};
      const amount=calculateDamage(p,p,selfMove,()=>.5).damage;
      this.dealDamage(p,amount,p,null);this.effect('status',p.x,p.y,'Psychic','Confused',.9);return false;
    }
    let direction=unit(p.facing.x,p.facing.y);
    let guidedTarget=null;
    if(this.mode==='battle-royale'&&!t.cpu){
      const target=this.nearestOpponent(teamIndex,p),range=target?distance(p,target):Infinity,toTarget=target?unit(target.x-p.x,target.y-p.y):null;
      if(target&&range<760){const facingDot=direction.x*toTarget.x+direction.y*toTarget.y;if(t.input.lockOn||facingDot>-.45){guidedTarget=target;if(t.input.lockOn)direction=toTarget;else{const weight=range<280?.48:.34;direction=unit(direction.x*(1-weight)+toTarget.x*weight,direction.y*(1-weight)+toTarget.y*weight);}}}
    }
    p.facing=direction;
    p.action={id:this.nextId++,phase:'windup',move:move.id,kind:spec.kind,category:move.category,type:spec.type,sourceSpecies:p.species,targetTeam:guidedTarget?.team??null,homingRate:guidedTarget?(t.input.lockOn?4.2:1.65):0,aimX:p.x+direction.x*spec.range,aimY:p.y+direction.y*spec.range,direction:{...direction},elapsed:0,duration:spec.windup,windup:spec.windup,recovery:spec.recovery,startedAt:this.time,released:false};
    this.event('cast',`${p.name} is preparing ${move.name}.`,this.actionEvent(p,p.action));
    this.effect('windup',p.x,p.y,spec.type,'',spec.windup);
    return true;
  }
  actionEvent(p,action) {
    return {team:p.team,sourceSpecies:action.sourceSpecies,move:action.move,type:action.type,category:action.category,attackKind:action.kind,direction:{...action.direction},aimX:action.aimX,aimY:action.aimY,windup:action.windup,recovery:action.recovery,actionId:action.id,x:p.x,y:p.y};
  }
  updateAction(p,dt) {
    const action=p.action;if(!action)return;
    if(p.hp<=0||this.active(p.team)!==p){p.action=null;p.attackLock=0;return;}
    if(action.phase==='windup'&&(p.status==='slp'||p.status==='frz'||p.flinch>0)){this.event('cancel',`${p.name}'s attack was interrupted.`,this.actionEvent(p,action));p.action=null;p.attackLock=.15;return;}
    if(p.hitstun>0)return;
    action.elapsed=Math.min(action.duration,action.elapsed+dt);
    if(action.elapsed+1e-8<action.duration)return;
    if(action.phase==='windup') {
      action.phase='recovery';action.elapsed=0;action.duration=action.recovery;p.attackLock=action.recovery;
      this.release(p,action);
    }else{p.action=null;p.attackLock=0;}
  }
  release(p,action) {
    if(action.released||p.hp<=0||this.active(p.team)!==p)return false;
    action.released=true;
    const teamIndex=p.team,move=getMove(action.move),spec=moveSpec(move),direction=action.direction;
    const context={sourceSpecies:action.sourceSpecies,actionId:action.id};
    this.event('release',`${p.name} released ${move.name}.`,this.actionEvent(p,action));
    this.event('move',`${p.name} used ${move.name}!`,this.actionEvent(p,action));
    this.effect('cast',p.x,p.y,spec.type,'',.25);
    if(spec.kind==='self') {
      if(move.id==='protect'||move.id==='detect') {p.protect=1.5;this.effect('protect',p.x,p.y,'Normal','Protect',1.5);}
      else if(move.id==='rest') {
        if(p.hp===p.maxHp||['insomnia','vitalspirit'].includes(p.ability)){this.effect('status',p.x,p.y,'Psychic','Failed',.8);return true;}
        p.hp=p.maxHp;p.status='slp';p.statusTime=8;p.statusTick=0;p.toxicCounter=0;this.effect('heal',p.x,p.y,'Psychic','Rest',1);
      }
      else if(move.heal) this.heal(p,Math.floor(p.maxHp*move.heal[0]/move.heal[1]));
      else if(move.id==='counter'||move.id==='mirrorcoat') {p.counter=1.7;p.counterCategory=move.id==='counter'?'Physical':'Special';this.effect('counter',p.x,p.y,spec.type,'Ready',1.7);}
      else if(move.id==='splash') this.effect('status',p.x,p.y,'Normal','Splash!',.7);
      else this.changeStages(p,move.boosts);
      return true;
    }
    const enemy=this.nearestOpponent(teamIndex,p);
    if(!enemy)return true;
    if(spec.kind==='target') {
      if(distance(p,enemy)>550 || !clearLine(p,enemy,this.arena)) return true;
      if(enemy.protect>0||enemy.dodge>0||enemy.transformed||p.transformed||enemy.hp<=0) return true;
      p.originalMoves=p.moves.map(m=>({...m}));p.moves=enemy.moves.map(m=>({id:m.id,pp:5,maxPp:5,cooldown:1}));
      p.types=[...enemy.types];p.stats={...enemy.stats,hp:p.stats.hp};p.stages={...enemy.stages};p.species=enemy.species;p.name=enemy.name;p.ability=enemy.ability;p.abilityName=enemy.abilityName;p.transformed=true;
      this.effect('summon',p.x,p.y,p.types[0],'Transform',1);return true;
    }
    if(spec.kind==='pulse') {
      this.effect('pulse',p.x,p.y,spec.type,'',.45);
      for(const target of this.opponents(teamIndex)) if(distance(p,target)<=spec.range+target.radius && clearLine(p,target,this.arena)) this.hit(p,target,move,direction,context);
    } else if(spec.kind==='melee') {
      moveCircle(p,direction.x*(move.priority>0?72:34),direction.y*(move.priority>0?72:34),this.arena);
      this.effect('slash',p.x+direction.x*45,p.y+direction.y*45,spec.type,'',.28);
      const targets=this.opponents(teamIndex).filter(target=>distance(p,target)<=spec.range+target.radius && direction.x*unit(target.x-p.x,target.y-p.y).x+direction.y*unit(target.x-p.x,target.y-p.y).y>.35 && clearLine(p,target,this.arena)).sort((a,b)=>distance(p,a)-distance(p,b));
      if(targets.length)this.hit(p,targets[0],move,direction,context);
    } else {
      const start={x:p.x+direction.x*(p.radius+spec.radius+3),y:p.y+direction.y*(p.radius+spec.radius+3)};
      if(!clearLine(p,start,this.arena,spec.radius)||collides(start.x,start.y,spec.radius,this.arena)) return true;
      this.projectiles.push({id:this.nextId++,team:teamIndex,owner:p,...context,move:move.id,type:spec.type,kind:move.category==='Status'?'status':spec.radius>=25?'wave':'bolt',x:start.x,y:start.y,vx:direction.x*spec.speed,vy:direction.y*spec.speed,radius:spec.radius,life:spec.range/spec.speed,travel:0,targetTeam:action.targetTeam,homingRate:action.homingRate||0});
    }
    return true;
  }
  heal(p,amount) {if(p.hp<=0)return;const heal=Math.min(p.maxHp-p.hp,amount);if(heal<=0)return;p.hp+=heal;this.effect('heal',p.x,p.y,'Grass',`+${heal}`,.9);}
  abilityBlocks(attacker,defender,move) {
    const type=effectiveType(move), ability=defender.ability;
    if(type==='Ground'&&ability==='levitate') return true;
    if(ability==='wonderguard'&&move.category!=='Status'&&move.id!=='struggle'&&typeMultiplier(type,defender.types)<=1) return true;
    if((type==='Water'&&['waterabsorb','stormdrain'].includes(ability))||(type==='Electric'&&['voltabsorb','lightningrod','motordrive'].includes(ability))||(type==='Fire'&&ability==='flashfire')||(type==='Grass'&&ability==='sapsipper')) {
      if(ability==='waterabsorb'||ability==='voltabsorb')this.heal(defender,Math.floor(defender.maxHp/4));
      if(ability==='stormdrain'||ability==='lightningrod')this.changeStages(defender,{spa:1});
      if(ability==='motordrive')this.changeStages(defender,{spe:1});
      if(ability==='sapsipper')this.changeStages(defender,{atk:1});
      if(ability==='flashfire')defender.flashFire=true;
      return true;
    }
    return false;
  }
  hit(attacker,defender,move,direction,context={}) {
    if(attacker?.evolution || defender.hp<=0 || defender.dodge>0 || defender.evolution) return;
    if(defender.protect>0) {this.effect('blocked',defender.x,defender.y,'Normal','Protected',.7);return;}
    if(this.abilityBlocks(attacker,defender,move)) {this.effect('immune',defender.x,defender.y,defender.types[0],defender.abilityName,.9);return;}
    const mult=accuracyMultiplier((attacker.stages.accuracy||0)-(defender.stages.evasion||0));
    const alwaysHits=move.accuracy===true || (move.id==='toxic'&&attacker.types.includes('Poison'));
    if(!alwaysHits && this.random()*100>move.accuracy*mult) {this.effect('miss',defender.x,defender.y,'Normal','Miss',.6);return;}
    if(move.category==='Status') {
      if(move.id==='thunderwave'&&typeMultiplier('Electric',defender.types)===0 || move.flags?.powder&&defender.types.includes('Grass')) {this.effect('immune',defender.x,defender.y,effectiveType(move),'Immune',.8);return;}
      if(move.status && !this.applyStatus(defender,move.status,attacker)) this.effect('immune',defender.x,defender.y,effectiveType(move),'No effect',.8);
      this.changeStages(defender,move.boosts);return;
    }
    const result=calculateDamage(attacker,defender,move,this.random);
    if(result.effectiveness===0) {this.effect('immune',defender.x,defender.y,effectiveType(move),'Immune',.7);return;}
    let amount=result.damage;
    if(attacker.flashFire&&effectiveType(move)==='Fire') amount=Math.floor(amount*1.5);
    if(this.mode==='battle-royale')amount=Math.min(Math.max(1,Math.floor(amount*.78)),Math.max(2,Math.floor(defender.maxHp*0.16)));
    if(defender.ability==='sturdy'&&defender.hp===defender.maxHp&&amount>=defender.hp) amount=defender.hp-1;
    const dealt=Math.min(defender.hp,amount);
    this.dealDamage(defender,amount,attacker,move,context);
    if(dealt>0&&this.mode==='battle-royale')this.awardExperience(attacker.team,25,false);
    if(result.effectiveness>1) this.effect('effective',defender.x,defender.y-25,effectiveType(move),'Super effective!',.75);
    else if(result.effectiveness<1)this.effect('resisted',defender.x,defender.y-25,effectiveType(move),'Resisted',.6);
    if(result.critical)this.effect('critical',defender.x,defender.y-44,effectiveType(move),'Critical!',.6);
    const knock=move.basePower>=100?clamp(480+(move.basePower-100)*6,480,720):clamp(200+move.basePower*2.5,200,450);
    defender.knockX+=direction.x*knock;defender.knockY+=direction.y*knock;
    if(dealt>0&&defender.hp>0){defender.hitstun=Math.max(defender.hitstun,clamp(.12+move.basePower/1500,.12,.2));defender.hurtTime=Math.max(defender.hurtTime,.26);}
    if(move.drain)this.heal(attacker,Math.max(1,Math.floor(dealt*move.drain[0]/move.drain[1])));
    if(move.recoil)this.dealDamage(attacker,Math.max(1,Math.round(dealt*move.recoil[0]/move.recoil[1])),attacker,null);
    if(move.id==='struggle')this.dealDamage(attacker,Math.max(1,Math.round(attacker.maxHp/4)),attacker,null);
    if(move.self?.boosts)this.changeStages(attacker,move.self.boosts);
    if(move.self?.status)this.applyStatus(attacker,move.self.status);
    if(defender.status==='frz'&&effectiveType(move)==='Fire') {defender.status=null;defender.statusTime=0;defender.freezeImmunity=4;}
    const secondary=move.secondaries|| (move.secondary?[move.secondary]:[]);
    for(const effect of secondary) if(this.random()*100<(effect.chance??100)) {
      if(effect.status&&defender.hp>0)this.applyStatus(defender,effect.status,attacker);
      if(effect.boosts&&defender.hp>0)this.changeStages(defender,effect.boosts);
      if(effect.self?.boosts)this.changeStages(attacker,effect.self.boosts);
      if(effect.volatileStatus==='flinch'&&defender.hp>0)defender.flinch=.35;
      if(effect.volatileStatus==='confusion'&&defender.hp>0&&defender.ability!=='owntempo') {defender.confusion=10;this.effect('status',defender.x,defender.y,'Psychic','Confused',1);}
    }
    if(move.flags?.contact&&attacker.hp>0&&this.random()<.3) {
      const passive={static:'par',flamebody:'brn',poisonpoint:'psn'}[defender.ability];if(passive)this.applyStatus(attacker,passive,defender);
      if(defender.ability==='effectspore'&&!attacker.types.includes('Grass'))this.applyStatus(attacker,['par','psn','slp'][Math.floor(this.random()*3)],defender);
    }
    if(defender.counter>0&&defender.counterCategory===move.category&&dealt>0&&attacker.hp>0&&defender.hp>0) {
      const counterType=move.category==='Physical'?'Fighting':'Psychic';
      if(typeMultiplier(counterType,attacker.types)>0) {this.dealDamage(attacker,dealt*2,defender,null);this.effect('counter',attacker.x,attacker.y,counterType,'Counter!',.7);}
      defender.counter=0;
    }
  }
  refreshLevelStats(p,hpRatio=p.hp/Math.max(1,p.maxHp)) {
    const species=this.speciesById.get(p.originalSpecies),canonical=Dex.species.get(p.originalSpecies),base=species?.baseStats||canonical?.baseStats;
    if(!base)return;
    const raw=canonicalStats(base,p.level),hp=Math.round(raw.hp*(p.healthScale||1)),stats={...raw,hp};p.originalStats={...stats};p.stats={...stats};p.maxHp=hp;p.hp=clamp(Math.round(hpRatio*p.maxHp),p.hp>0?1:0,p.maxHp);
  }
  tryEvolution(p) {
    if(!this.speciesById.size||p.transformed||p.evolution)return false;
    const canonical=Dex.species.get(p.originalSpecies),threshold=p.nextEvolutionLevel||Math.min(8,Math.max(5,Number(canonical?.evoLevel)||8));
    if(p.level<threshold)return false;
    const nextIds=(canonical?.evos||[]).map(idOf).filter(id=>this.speciesById.has(id));
    if(!nextIds.length){p.nextEvolutionLevel=null;return false;}
    const nextId=nextIds[Math.floor(this.random()*nextIds.length)],previousSpecies=p.species,previousName=p.name;
    p.evolution={fromSpecies:previousSpecies,toSpecies:nextId,elapsed:0,duration:2.6};
    p.action=null;p.attackLock=0;p.castLock=0;p.vx=0;p.vy=0;p.knockX=0;p.knockY=0;
    p.protect=Math.max(p.protect||0,p.evolution.duration+.25);
    this.event('evolutionStart',previousName+' is evolving!',{team:p.team,sourceSpecies:previousSpecies,targetSpecies:nextId,species:nextId,x:p.x,y:p.y,duration:p.evolution.duration});
    return true;
  }
  upgradeEvolutionMoves(p, species) {
    const allowedIds = [...new Set([...(species.learnset || []), ...(species.moves || [])].map(idOf))];
    const available = new Map();
    for (const id of allowedIds) {
      const move = getMove(id);
      if (move && move.id !== 'struggle') available.set(move.id, move);
    }
    if (!available.size) return [];

    const slots = (p.moves || []).slice(0, 4).map((entry, index) => ({
      index, entry: { ...entry }, move: available.get(idOf(entry.id)) || null,
    }));
    while (slots.length < 4) slots.push({ index: slots.length, entry: null, move: null });

    const used = new Set(slots.filter(slot => slot.move).map(slot => slot.move.id));
    const candidates = [...available.values()]
      .filter(move => move.category !== 'Status' && (move.basePower || 0) >= 35)
      .sort((a, b) => evolutionMoveScore(b, species.types) - evolutionMoveScore(a, species.types) || a.name.localeCompare(b.name));
    const fallbackCandidates = [...available.values()]
      .sort((a, b) => evolutionMoveScore(b, species.types) - evolutionMoveScore(a, species.types) || a.name.localeCompare(b.name));
    const learned = [];
    const assign = (slot, move) => {
      if (slot.move) used.delete(slot.move.id);
      slot.move = move;
      slot.entry = { id: move.id, pp: move.pp, maxPp: move.pp, cooldown: 0 };
      used.add(move.id);
      learned.push({ id: move.id, name: move.name });
    };

    // If this evolution cannot use an old move, replace it with a legal move immediately.
    for (const slot of slots.filter(item => !item.move)) {
      const candidate = candidates.find(move => !used.has(move.id))
        || fallbackCandidates.find(move => !used.has(move.id));
      if (candidate) assign(slot, candidate);
    }

    // Each evolution can teach up to two stronger attacks, while keeping useful healing/buff moves.
    let upgrades = 0;
    while (upgrades < 2) {
      const weakest = slots
        .filter(slot => slot.move && !(slot.move.category === 'Status' && (slot.move.heal || slot.move.self?.boosts || slot.move.boosts)))
        .sort((a, b) => evolutionMoveScore(a.move, species.types) - evolutionMoveScore(b.move, species.types) || b.index - a.index)[0];
      if (!weakest) break;
      const weakestScore = evolutionMoveScore(weakest.move, species.types);
      const candidate = candidates.find(move => !used.has(move.id) && evolutionMoveScore(move, species.types) >= weakestScore + 12);
      if (!candidate) break;
      assign(weakest, candidate);
      upgrades++;
    }

    p.moves = slots.filter(slot => slot.move && slot.entry).map(slot => slot.entry).slice(0, 4);
    return learned;
  }
  finishEvolution(p) {
    const transition=p.evolution;if(!transition)return false;
    const species=this.speciesById.get(transition.toSpecies);
    if(!species){p.evolution=null;return false;}
    const previousName=p.name,previousSpecies=p.species,nextCanonical=Dex.species.get(species.id);
    p.evolution=null;p.species=species.id;p.originalSpecies=species.id;
    p.nextEvolutionLevel=(nextCanonical?.evos||[]).map(idOf).some(id=>this.speciesById.has(id))?p.level+2:null;
    p.name=species.name;p.sprite=species.sprite;p.spriteAnimated=species.spriteAnimated;p.types=[...species.types];p.originalTypes=[...species.types];p.transformed=false;p.originalMoves=null;
    const learnedMoves=this.upgradeEvolutionMoves(p,species);
    const raw=canonicalStats(species.baseStats,p.level),hp=Math.round(raw.hp*(p.healthScale||1)),stats={...raw,hp};
    p.originalStats={...stats};p.stats={...stats};p.maxHp=hp;p.hp=p.maxHp;
    p.abilityName=nextCanonical?.abilities?.['0']||species.abilities?.['0']||'';p.ability=SUPPORTED_ABILITIES.has(idOf(p.abilityName))?idOf(p.abilityName):'';p.abilityImplemented=SUPPORTED_ABILITIES.has(idOf(p.abilityName));
    p.status=null;p.statusTime=0;p.toxicCounter=0;p.confusion=0;p.flinch=0;p.hitstun=0;p.hurtTime=0;p.action=null;p.attackLock=0;p.castLock=0;p.vx=0;p.vy=0;p.knockX=0;p.knockY=0;
    const learnedSummary=learnedMoves.length?` Learned ${learnedMoves.map(move=>move.name).join(' & ')}.`:'';
    this.event('evolution',p.name+' evolved!'+learnedSummary+' Full HP restored!',{team:p.team,sourceSpecies:previousSpecies,targetSpecies:p.species,species:p.species,learnedMoves:learnedMoves.map(move=>move.id),x:p.x,y:p.y});
    this.effect('summon',p.x,p.y,p.types[0],p.name,1.2);return true;
  }
  updateEvolution(p,dt) {
    if(!p.evolution)return false;
    p.evolution.elapsed=Math.min(p.evolution.duration,p.evolution.elapsed+dt);
    if(p.evolution.elapsed+1e-8<p.evolution.duration)return true;
    this.finishEvolution(p);return false;
  }
  awardExperience(teamIndex,amount=60,notify=true) {
    if(this.mode!=='battle-royale')return;
    const p=this.active(teamIndex);if(!p||p.hp<=0)return;
    if(p.transformed)this.resetTransform(p);
    p.xp=Math.min(5700,p.xp+amount);const targetLevel=Math.min(100,5+Math.floor(p.xp/60));
    while(p.level<targetLevel){const hpRatio=p.hp/Math.max(1,p.maxHp);p.level++;this.refreshLevelStats(p,hpRatio);this.event('levelUp',`${p.name} reached level ${p.level}!`,{team:teamIndex,level:p.level,xp:p.xp,x:p.x,y:p.y});this.tryEvolution(p);}
    this.event('xp',`${p.name} gained ${amount} XP!`,{team:teamIndex,xp:p.xp,level:p.level,x:p.x,y:p.y,silent:!notify});
  }
  eliminate(teamIndex, reason='eliminated') { const p=this.active(teamIndex);if(p?.evolution)p.evolution=null;if(p&&p.hp>0)this.dealDamage(p,p.hp,null,null);if(this.mode==='battle-royale'){const alive=this.teams.map(t=>t.roster.some(mon=>mon.hp>0));const count=alive.filter(Boolean).length;if(count<=1)this.finish(count===1?alive.findIndex(Boolean):null,reason);} }
  dealDamage(p,amount,source,move,context={}) {
    if(p.hp<=0||p.evolution)return 0;
    const dealt=Math.min(p.hp,Math.max(0,Math.floor(amount)));p.hp-=dealt;
    this.effect('damage',p.x,p.y-20,move?effectiveType(move):'Normal',String(dealt),.8);
    if(dealt>0){p.hurtTime=.26;this.event('hurt',`${p.name} took ${dealt} damage.`,{team:p.team,targetSpecies:p.species,sourceSpecies:context.sourceSpecies||source?.species||null,move:move?.id||null,actionId:context.actionId||null,damage:dealt,x:p.x,y:p.y,duration:.26});}
    if(p.hp<=0) {p.vx=0;p.vy=0;p.protect=0;p.dodge=0;p.action=null;p.deployment=null;p.attackLock=0;p.hitstun=0;this.event('faint',`${p.name} fainted!`,{team:p.team,species:p.species,targetSpecies:p.species,sourceSpecies:context.sourceSpecies||source?.species||null,x:p.x,y:p.y,duration:1.15});this.effect('faint',p.x,p.y,p.types[0],'',1.1);this.teams[p.team].respawn=1.15;if(this.mode==='battle-royale'&&source&&Number.isInteger(source.team)&&source.team!==p.team){this.eliminations[source.team]=(this.eliminations[source.team]||0)+1;this.awardExperience(source.team,60);this.heal(source,Math.floor(source.maxHp*.18));this.event('elimination',`${this.teams[source.team].name} eliminated ${p.name}!`,{team:source.team,targetSpecies:p.species,sourceSpecies:source.species,x:p.x,y:p.y});}}
  }
  updatePokemon(p,dt,active) {
    for(const m of p.moves)m.cooldown=Math.max(0,m.cooldown-dt);
    for(const key of ['protect','dodge','dodgeCooldown','attackLock','castLock','counter','confusion','flinch','hitstun','hurtTime','freezeImmunity','struggleCooldown','m1Cooldown'])p[key]=Math.max(0,p[key]-dt);
    if(!active||p.hp<=0||p.deployment)return;
    if(p.status) {
      p.statusTime=Math.max(0,p.statusTime-dt);p.statusTick+=dt;
      if(p.statusTick>=4) {
        p.statusTick-=4;
        if(p.status==='brn')this.dealDamage(p,Math.max(1,Math.floor(p.maxHp/16)),p,null);
        if(p.status==='psn')this.dealDamage(p,Math.max(1,Math.floor(p.maxHp/8)),p,null);
        if(p.status==='tox')this.dealDamage(p,Math.max(1,Math.floor(p.maxHp*++p.toxicCounter/16)),p,null);
        if(p.status==='frz'&&this.random()<.2)p.statusTime=0;
      }
      if(p.statusTime<=0) {if(p.status==='frz')p.freezeImmunity=4;p.status=null;p.toxicCounter=0;}
    }
  }
  ppRecoverySlot(p) {
    let slot=-1,deficit=0;
    for(let index=0;index<p.moves.length;index++) {
      const move=p.moves[index],missing=(move.maxPp-move.pp)/move.maxPp;
      if(missing>deficit){slot=index;deficit=missing;}
    }
    return slot;
  }
  spawnPpOrb() {
    if(this.ppOrbs.length>=PP_ORBS.maxActive)return null;
    const candidates=Array.from({length:24},()=>({x:this.arena.width*(.35+this.random()*.3),y:90+this.random()*(this.arena.height-180)}));
    candidates.push(...[80,120,200,280,380,480,560,640,680].map(y=>({x:this.arena.width/2,y})));
    const point=candidates.find(candidate=>!collides(candidate.x,candidate.y,40,this.arena)&&this.ppOrbs.every(orb=>distance(orb,candidate)>=120)&&this.teams.every((team,index)=>{const p=this.active(index);return p.hp<=0||distance(p,candidate)>=120;}));
    if(!point)return null;
    const orb={id:this.nextId++,...point,radius:PP_ORBS.radius,life:PP_ORBS.lifetime,maxLife:PP_ORBS.lifetime};
    this.ppOrbs.push(orb);return orb;
  }
  updatePpOrbs(dt) {
    for(const orb of this.ppOrbs)orb.life-=dt;
    this.ppOrbs=this.ppOrbs.filter(orb=>orb.life>0);
    if(this.time+1e-8>=this.nextPpOrbAt) {
      this.spawnPpOrb();
      this.nextPpOrbAt=this.time+PP_ORBS.intervalMin+this.random()*(PP_ORBS.intervalMax-PP_ORBS.intervalMin);
    }
    for(const orb of this.ppOrbs) {
      const eligible=this.teams.map((team,index)=>{const p=this.active(index);return {p,slot:this.ppRecoverySlot(p),distance:distance(p,orb)};}).filter(({p,slot,distance})=>p.hp>0&&!p.deployment&&slot>=0&&distance<=p.radius+orb.radius);
      if(!eligible.length)continue;
      eligible.sort((a,b)=>a.distance-b.distance);
      const closest=eligible.filter(candidate=>Math.abs(candidate.distance-eligible[0].distance)<1e-8);
      const {p,slot}=closest[Math.min(closest.length-1,Math.floor(this.random()*closest.length))],move=p.moves[slot];
      move.pp=Math.min(move.maxPp,move.pp+1);orb.life=0;
      this.effect('pp',p.x,p.y-20,'Psychic','+1 PP',.9);
      this.event('ppPickup',`${p.name} recovered 1 PP for ${getMove(move.id).name}!`,{team:p.team,slot,move:move.id,pp:move.pp,x:orb.x,y:orb.y});
    }
    this.ppOrbs=this.ppOrbs.filter(orb=>orb.life>0);
  }
  cpuInput(index) {
    const t=this.teams[index], p=this.active(index), enemy=this.nearestOpponent(index);
    if(p.hp<=0||!enemy||p.deployment)return;
    const hasOffense=pokemon=>pokemon.moves.some(state=>state.pp>0&&(getMove(state.id).basePower>0||['counter','mirrorcoat','transform'].includes(state.id)));
    const exhaustedOffense=!hasOffense(p);
    if(exhaustedOffense) {
      const reserve=t.roster.findIndex((candidate,slot)=>slot!==t.active&&candidate.hp>0&&hasOffense(candidate));
      if(reserve>=0&&this.switchPokemon(index,reserve))return;
    }
    const range=distance(p,enemy);
    let best=null;
    for(let slot=0;slot<p.moves.length;slot++) {
      const state=p.moves[slot],exhausted=state.pp<=0,move=getMove(exhausted?'struggle':state.id),spec=moveSpec(move);
      if((exhausted?p.struggleCooldown:state.cooldown)>0)continue;
      let score=(move.basePower||0)*(move.id==='struggle'?1:typeMultiplier(effectiveType(move),enemy.types))*(move.id!=='struggle'&&p.types.includes(effectiveType(move))?1.5:1);
      if(move.category==='Physical')score*=p.stats.atk/enemy.stats.def;else if(move.category==='Special')score*=p.stats.spa/enemy.stats.spd;
      if(spec.kind==='melee'&&range>180)score*=.55;
      if(spec.kind==='pulse'&&range>spec.range)score*=.5;
      if(move.heal||move.id==='rest')score=p.hp<p.maxHp*.5?170:0;
      else if(move.id==='protect'||move.id==='detect')score=this.projectiles.some(s=>s.team!==index&&distance(s,p)<220)?200:0;
      else if(move.id==='transform')score=p.transformed?0:300;
      else if(move.id==='counter'||move.id==='mirrorcoat')score=range<420?80:0;
      else if(move.status)score=enemy.status?0:50;
      else if(move.category==='Status'&&move.boosts)score=Object.entries(move.boosts).some(([s,v])=>v>0?p.stages[s]<2:enemy.stages[s]>-2)?45:0;
      score*=.85+this.random()*.3;
      if(!best||score>best.score)best={slot,move,spec,score};
    }
    const supply=p.moves.some(state=>state.pp<=0)||p.moves.reduce((sum,state)=>sum+state.pp,0)<p.moves.reduce((sum,state)=>sum+state.maxPp,0)*.5?this.ppOrbs.filter(orb=>distance(p,orb)<360&&clearLine(p,orb,this.arena,p.radius+3)).sort((a,b)=>distance(p,a)-distance(p,b))[0]:null;
    const movementTarget=supply||enemy,navRange=distance(p,movementTarget),navDir=unit(movementTarget.x-p.x,movementTarget.y-p.y);
    const attackRange=best?.spec.kind==='melee'?95:best?.spec.kind==='pulse'?160:360;
    let vx=supply?navDir.x:navRange>attackRange?navDir.x:navRange<attackRange*.65?-navDir.x:0,vy=supply?navDir.y:navRange>attackRange?navDir.y:navRange<attackRange*.65?-navDir.y:0;
    if(!supply){vx+=-navDir.y*t.aiSide*.48;vy+=navDir.x*t.aiSide*.48;}
    if(this.random()<.015)t.aiSide*=-1;
    if(!clearLine(p,movementTarget,this.arena,p.radius+6)) {
      const corners=this.arena.obstacles.flatMap(o=>[{x:o.x-45,y:o.y-45},{x:o.x+o.w+45,y:o.y-45},{x:o.x-45,y:o.y+o.h+45},{x:o.x+o.w+45,y:o.y+o.h+45}]);
      const visible=corners.filter(c=>!collides(c.x,c.y,p.radius,this.arena)&&clearLine(p,c,this.arena,p.radius+3));
      visible.sort((a,b)=>distance(p,a)+distance(a,movementTarget)+(clearLine(a,movementTarget,this.arena,p.radius)?0:250)-(distance(p,b)+distance(b,movementTarget)+(clearLine(b,movementTarget,this.arena,p.radius)?0:250)));
      if(visible.length){const nav=unit(visible[0].x-p.x,visible[0].y-p.y);vx=nav.x;vy=nav.y;}
    }
    const check={x:p.x+vx*65,y:p.y+vy*65};
    if(collides(check.x,check.y,p.radius,this.arena)){const side=unit(-navDir.y*t.aiSide,navDir.x*t.aiSide);vx=side.x;vy=side.y;if(collides(p.x+vx*50,p.y+vy*50,p.radius,this.arena)){t.aiSide*=-1;vx=-vx;vy=-vy;}}
    const shotTime=range/(best?.spec.speed||480),skill=Math.min(.9,.45+this.cpuLevel*.035);
    const aimX=enemy.x+enemy.vx*shotTime*skill+(this.random()-.5)*(40-this.cpuLevel*2),aimY=enemy.y+enemy.vy*shotTime*skill+(this.random()-.5)*(40-this.cpuLevel*2);
    const danger=this.projectiles.find(s=>s.team!==index&&distance(s,p)<145&&(s.vx*(p.x-s.x)+s.vy*(p.y-s.y))>0);
    const mayCast=best&&(best.score>0||exhaustedOffense)&&(best.spec.kind==='self'||best.spec.kind==='target'||range<best.spec.range+10)&&clearLine(p,enemy,this.arena);
    const ready=t.attackWait<=0&&!p.action&&p.hitstun<=0&&p.castLock<=0;
    const attackSlot=ready&&mayCast?best.slot:null;
    if(attackSlot!==null){const attackFacing=unit(aimX-p.x,aimY-p.y);vx=attackFacing.x;vy=attackFacing.y;}
    this.input(index,{dx:vx,dy:vy,aimX,aimY,cast:attackSlot,dodge:Boolean(danger&&this.random()<.25+this.cpuLevel*.025)});
    if(attackSlot!==null)t.attackWait=this.cpuLevel<=4?1.45-this.cpuLevel*.06:Math.max(.95,1.15-(this.cpuLevel-4)*.02);
  }
  step(dt=1/60) {
    if(this.phase!=='battle'||this.paused)return;dt=clamp(dt,0,1/20);this.time+=dt;this.tick++;
    if(this.zone){const z=this.zone,progress=clamp((this.time-z.startsAt)/(z.closesAt-z.startsAt),0,1);z.radius=z.initialRadius+(z.minRadius-z.initialRadius)*progress;if(this.time>=z.startsAt){this.zoneDamageClock+=dt;if(this.zoneDamageClock>=1){this.zoneDamageClock-=1;for(let i=0;i<this.teams.length;i++){const p=this.active(i);if(p&&p.hp>0&&distance(p,z)>z.radius){const damage=Math.max(1,Math.round(z.damage+progress*10));this.dealDamage(p,damage,p,null);this.event('zoneDamage',`${p.name} was hurt by the closing zone!`,{team:i,species:p.species,x:p.x,y:p.y,damage});}}}}}
    for(let teamIndex=0;teamIndex<this.teams.length;teamIndex++) {
      const t=this.teams[teamIndex];t.switchCooldown=Math.max(0,t.switchCooldown-dt);t.attackWait=Math.max(0,t.attackWait-dt);
      for(let slot=0;slot<t.roster.length;slot++)this.updatePokemon(t.roster[slot],dt,slot===t.active);
      let p=this.active(teamIndex);
      if(p.hp>0&&this.updateEvolution(p,dt)){p.vx=0;p.vy=0;continue;}
      if(p.hp<=0) {
        t.respawn-=dt;
        const next=t.roster.findIndex(candidate=>candidate.hp>0);
        if(next>=0&&t.respawn<=0)this.switchPokemon(teamIndex,next,true);
        continue;
      }
      if(this.updateDeployment(p,dt)){p.vx=0;p.vy=0;continue;}
      this.updateAction(p,dt);
      if(p.hp<=0)continue;
      if(t.cpu){t.aiTimer-=dt;if(t.aiTimer<=0){t.aiTimer=.14+this.random()*.1;this.cpuInput(teamIndex);}}
      p=this.active(teamIndex);
      if(p.deployment){p.vx=0;p.vy=0;continue;}
      if(p.action)p.facing={...p.action.direction};else if(Math.hypot(t.input.dx,t.input.dy)>.001)p.facing=unit(t.input.dx,t.input.dy);
      let speed=clamp(115+p.stats.spe*.65,125,250)*Math.sqrt(stageMultiplier(p.stages.spe));
      if(p.status==='par')speed*=.5;
      if(p.action)speed*=.35;
      const immobile=p.status==='slp'||p.status==='frz'||p.flinch>0||p.hitstun>0;
      p.vx=immobile?0:t.input.dx*speed;p.vy=immobile?0:t.input.dy*speed;
      if(p.dodge>0){p.vx=p.dodgeDirection.x*690;p.vy=p.dodgeDirection.y*690;}
      moveCircle(p,(p.vx+p.knockX)*dt,(p.vy+p.knockY)*dt,this.arena);
      p.knockX*=Math.exp(-8*dt);p.knockY*=Math.exp(-8*dt);
    }
    for(let i=0;i<this.teams.length;i++)for(let j=i+1;j<this.teams.length;j++){const first=this.active(i),second=this.active(j);if(!first||!second||first.hp<=0||second.hp<=0)continue;const overlap=first.radius+second.radius-distance(first,second);if(overlap>0){const push=unit(second.x-first.x,second.y-first.y);moveCircle(first,-push.x*overlap/2,-push.y*overlap/2,this.arena);moveCircle(second,push.x*overlap/2,push.y*overlap/2,this.arena);}}
    this.updatePpOrbs(dt);
    for(const shot of this.projectiles) {
      shot.life-=dt;if(shot.life<=0)continue;
      const targets=this.opponents(shot.team),count=Math.max(1,Math.ceil(Math.hypot(shot.vx,shot.vy)*dt/8));
      for(let i=0;i<count;i++) {
        if(shot.homingRate>0&&Number.isInteger(shot.targetTeam)){
          const target=this.active(shot.targetTeam);
          if(target&&target.hp>0){const speed=Math.hypot(shot.vx,shot.vy),current=unit(shot.vx,shot.vy),desired=unit(target.x-shot.x,target.y-shot.y),angle=Math.atan2(current.x*desired.y-current.y*desired.x,current.x*desired.x+current.y*desired.y),turn=clamp(angle,-shot.homingRate*dt/count,shot.homingRate*dt/count),cos=Math.cos(turn),sin=Math.sin(turn),vx=current.x*cos-current.y*sin,vy=current.x*sin+current.y*cos;shot.vx=vx*speed;shot.vy=vy*speed;}
        }
        shot.x+=shot.vx*dt/count;shot.y+=shot.vy*dt/count;
        if(collides(shot.x,shot.y,shot.radius,this.arena)){shot.life=0;this.effect('impact',shot.x,shot.y,shot.type,'',.3);break;}
        const target=targets.filter(p=>p.hp>0&&distance(shot,p)<=shot.radius+p.radius).sort((a,b)=>distance(shot,a)-distance(shot,b))[0];
        if(target){this.hit(shot.owner,target,getMove(shot.move),unit(shot.vx,shot.vy),{sourceSpecies:shot.sourceSpecies,actionId:shot.actionId});shot.life=0;this.effect('impact',shot.x,shot.y,shot.type,'',.35);break;}
      }
    }
    this.projectiles=this.projectiles.filter(p=>p.life>0);this.effects.forEach(e=>e.life-=dt);this.effects=this.effects.filter(e=>e.life>0).slice(-70);this.events=this.events.filter(e=>this.time-e.at<2.5);
    const alive=this.teams.map(t=>t.roster.some(p=>p.hp>0));
    if(this.mode==='battle-royale') {
      const survivors=alive.map((isAlive,index)=>({isAlive,index,kills:this.eliminations[index]||0,p:this.active(index)})).filter(entry=>entry.isAlive);
      if(survivors.length<=1)this.finish(survivors.length?survivors[0].index:null,'last-survivor');
      else if(this.time>=420){survivors.sort((a,b)=>b.kills-a.kills||b.p.hp/Math.max(1,b.p.maxHp)-a.p.hp/Math.max(1,a.p.maxHp));const a=survivors[0],b=survivors[1];this.finish(a.kills===b.kills&&Math.abs(a.p.hp/a.p.maxHp-b.p.hp/b.p.maxHp)<.001?null:a.index,'time');}
    } else if(!alive[0]||!alive[1])this.finish(alive[0]===alive[1]?null:alive[0]?0:1,'knockout');
    else if(this.time>=300) {const health=this.teams.map(t=>t.roster.reduce((n,p)=>n+p.hp/p.maxHp,0)/t.roster.length);this.finish(Math.abs(health[0]-health[1])<.001?null:health[0]>health[1]?0:1,'time');}
  }
  finish(winner,reason='knockout') {if(this.phase!=='battle')return;this.phase='finished';this.winner=winner;this.reason=reason;this.event('result',winner===null?'Draw!':`${this.teams[winner].name} wins!`,{winner});this.onFinish({winner,reason,battle:this});}
  startMessage(selfTeam) {
    return {type:'battleStart',id:this.id,mode:this.mode,stage:this.stage,arena:this.arena,selfTeam,rules:{level:this.mode==='battle-royale'?5:50,ivs:31,evs:0,nature:'neutral',turnSeconds:4,limitSeconds:this.mode==='battle-royale'?420:300,arenaDamageScale:ARENA_DAMAGE_SCALE,freezeSeconds:[.8,1.8],facingBasedAttacks:true,deployment:DEPLOYMENT,spawnShield:DEPLOYMENT.grace,ppOrbs:PP_ORBS},teams:this.teams.map(t=>({name:t.name,pokemon:t.roster.map(p=>({species:p.species,name:p.name,types:p.types,level:p.level,xp:p.xp,hp:p.hp,maxHp:p.maxHp,sprite:p.sprite,spriteAnimated:p.spriteAnimated,ability:p.abilityName,abilityImplemented:p.abilityImplemented,moves:p.moves.map(m=>({...m,name:getMove(m.id).name,type:effectiveType(getMove(m.id)),category:getMove(m.id).category,cooldown:moveSpec(getMove(m.id)).cooldown,windup:moveSpec(getMove(m.id)).windup,recovery:moveSpec(getMove(m.id)).recovery,attackKind:moveSpec(getMove(m.id)).kind}))}))}))};
  }
  snapshot() {
    return {type:'state',id:this.id,tick:this.tick,time:this.time,phase:this.phase,paused:this.paused,arenaId:this.arena.id,zone:this.zone?{...this.zone,timeToStart:Math.max(0,this.zone.startsAt-this.time),closing:this.time>=this.zone.startsAt}:null,
      remaining:this.teams.filter(t=>t.roster.some(p=>p.hp>0)).length,eliminations:[...this.eliminations],fighters:this.teams.map((t,i)=>{const p=this.active(i);return {id:p.id,team:p.team,slot:p.slot,species:p.species,name:p.name,level:p.level,xp:p.xp,nextEvolutionLevel:p.nextEvolutionLevel,x:p.x,y:p.y,vx:p.vx,vy:p.vy,radius:p.radius,facing:p.facing,hp:p.hp,maxHp:p.maxHp,types:p.types,status:p.status,statusTime:p.statusTime,protect:p.protect,dodge:p.dodge,dodgeCooldown:p.dodgeCooldown,stages:p.stages,cooldowns:p.moves.map(m=>m.pp<=0?p.struggleCooldown:m.cooldown),pp:p.moves.map(m=>m.pp),maxPp:p.moves.map(m=>m.maxPp),moves:p.moves.map(m=>m.id),switchCooldown:t.switchCooldown,ability:p.abilityName,abilityImplemented:p.abilityImplemented,confusion:p.confusion,counter:p.counter,m1Cooldown:p.m1Cooldown||0,action:p.action?{...p.action,direction:{...p.action.direction}}:null,deployment:p.deployment?{...p.deployment}:null,hitstun:p.hitstun,hurtTime:p.hurtTime,freezeImmunity:p.freezeImmunity,evolution:p.evolution?{...p.evolution}:null};}),
      benches:this.teams.map(t=>t.roster.map(p=>({species:p.species,name:p.name,hp:p.hp,maxHp:p.maxHp,status:p.status}))),
      projectiles:this.projectiles.map(({owner,...s})=>s),ppOrbs:this.ppOrbs.map(orb=>({...orb})),effects:this.effects,events:this.events};
  }
}

module.exports={Battle,ARENAS,SUPPORTED_ABILITIES,DEPLOYMENT,PP_ORBS,createPokemon,moveCircle,collides,clearLine,circleRect,unit};
