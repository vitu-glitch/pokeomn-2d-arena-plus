const TAU = Math.PI * 2;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const mix = (a, b, t) => a + (b - a) * t;
const COLORS = {Normal:'#e5dfc0',Fire:'#ff994a',Water:'#66c9ff',Electric:'#ffe969',Grass:'#a6ed79',Ice:'#b2efff',Fighting:'#f6b78b',Poison:'#d097ef',Ground:'#d8bc85',Flying:'#c4d5ff',Psychic:'#ff99d6',Bug:'#c8e978',Rock:'#d3c2a1',Ghost:'#b39cf3',Dragon:'#a4b4ff',Dark:'#ba96e7',Steel:'#c1e0e7',Fairy:'#ffb7e9',Stellar:'#c7ffec'};
const tint = type => COLORS[type] || COLORS.Normal;
const FIELD = {x:145,y:125,w:910,h:510};
const SCENE = {x:-FIELD.x/FIELD.w*1200,y:-FIELD.y/FIELD.h*760,w:1200/FIELD.w*1200,h:760/FIELD.h*760};

                                                                        
export function directionRow(dx, dy) {
  return (Math.round(Math.atan2(dx, dy) / (Math.PI / 4)) + 8) % 8;
}

export function frameDurations(animation) {
  const count = Math.max(1, Number(animation.frames) || animation.durations?.length || 1);
  const fps = Number(animation.fps) || 60;
  return Array.from({length:count}, (_, i) => {
    const duration = Number(animation.durations?.[i] ?? animation.durations?.[0] ?? 6);
    return Math.max(1 / 120, animation.durationUnit === 'seconds' ? duration : duration / fps);
  });
}

                                                                                      
export function frameAt(animation, seconds, loop = true) {
  const durations = frameDurations(animation);
  const total = durations.reduce((a, b) => a + b, 0);
  let time = loop ? ((seconds % total) + total) % total : clamp(seconds, 0, total - 0.00001);
  for (let index = 0; index < durations.length; index++) {
    if (time < durations[index]) return index;
    time -= durations[index];
  }
  return durations.length - 1;
}

                                                                                
export function actionFrame(animation, phase, elapsed, windup, recovery) {
  const durations = frameDurations(animation);
  const hit = clamp(Number(animation.hitFrame) >= 0 ? Number(animation.hitFrame) : Math.floor(durations.length * 0.45), 0, durations.length - 1);
  const before = durations.slice(0, hit).reduce((a, b) => a + b, 0);
  const after = durations.slice(hit).reduce((a, b) => a + b, 0);
  const seconds = phase === 'windup'
    ? before * clamp(elapsed / Math.max(0.01, windup), 0, 0.999)
    : before + after * clamp(elapsed / Math.max(0.01, recovery), 0, 0.999);
  return frameAt(animation, seconds, false);
}

function animationFor(entry, desired) {
  if (!entry) return null;
  const choices = {
    idle:['idle','walk'], walk:['walk','idle'],
    attack:['attack','shoot','special','charge'],
    shoot:['shoot','special','attack','charge'],
    special:['special','shoot','attack','charge'],
    charge:['charge','special','attack','idle'],
    hurt:['hurt','attack','idle'], faint:['faint','hurt','idle'], sleep:['sleep','idle'],
  };
  for (const key of choices[desired] || [desired]) {
    if (entry[key]) return {name:key, data:entry[key]};
  }
  return null;
}

function attackAnimation(action) {
  if (action.kind === 'melee' || action.attackKind === 'melee') return 'attack';
  if (action.kind === 'self' || action.attackKind === 'self') return 'charge';
  if (action.category === 'Special') return 'special';
  return 'shoot';
}

export class CombatRenderer {
  constructor({canvas, overlay, species, moves, settings, audio, notice}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.overlay = overlay;
    this.species = species;
    this.moves = moves;
    this.settings = settings;
    this.audio = audio;
    this.notice = notice;
    this.manifest = {};
    this.images = new Map();
    this.metrics = new Map();
    this.arenas = new Map();
    this.reset(null);
  }

  setManifest(manifest) { this.manifest = manifest?.species || manifest || {}; }

  reset(battle) {
    this.battle = battle;
    this.characters = new Map();
    this.seen = new Set();
    this.particles = [];
    this.dust = [];
    this.decals = [];
    this.effects = [];
    this.emissions = new Map();
    this.labels = [];
    this.ghosts = [];
    this.recalls = [];
    this.camera = {x:600, y:380, zoom:1.58, initialized:false};
    this.shake = 0;
    this.hitStopUntil = 0;
    this.hitStopAt = 0;
    this.lastSnapshot = 0;
    this.state = null;
    this.previous = null;
    this.overlay.replaceChildren();
    if (battle) {
      this.loadArena(battle.arena?.id || 'stadium');
      for (const team of battle.teams || []) for (const p of team.pokemon || []) this.preload(p.species);
    }
  }

  loadImage(src) {
    if (!src) return null;
    let result = this.images.get(src);
    if (result) return result.ready ? result.image : null;
    const image = new Image();
    result = {image, ready:false, failed:false};
    this.images.set(src, result);
    image.onload = () => { result.ready = true; };
    image.onerror = () => { result.failed = true; };
    image.src = src;
    return null;
  }

  preload(id) {
    const entry = this.manifest[id];
    if (entry) for (const anim of Object.values(entry)) if (anim?.src) this.loadImage(anim.src);
    this.loadImage(this.species(id)?.sprite);
  }

  loadArena(id) {
    if (!this.arenas.has(id)) {
      const image = new Image();
      this.arenas.set(id, {image, ready:false});
      image.onload = () => { this.arenas.get(id).ready = true; };
      image.src = `/assets/arenas/${id}.png`;
    }
  }

  getCharacter(fighter) {
    let record = this.characters.get(fighter.id);
    if (!record || record.species !== fighter.species) {
      if (record?.element) record.element.remove();
      record = {species:fighter.species, row:2, walkTime:0, idleTime:0, hurtUntil:0,
        faintAt:0, enteredAt:performance.now(), lastHp:fighter.hp, action:null, element:null,
        lastX:fighter.x, lastY:fighter.y, lastRender:0};
      this.characters.set(fighter.id, record);
      this.preload(fighter.species);
    }
    return record;
  }

  applySnapshot(state, previous, now) {
    this.previous = previous;
    this.state = state;
    this.lastSnapshot = now;
    for (const f of state.fighters || []) {
      const record = this.getCharacter(f);
      const previousFighter=previous?.fighters?.find(p=>p.id===f.id&&p.species===f.species);
      if(previousFighter&&(f.hitstun>0||f.hurtTime>0)&&Math.hypot(f.x-previousFighter.x,f.y-previousFighter.y)>1.5)this.addSkid(previousFighter,f);
      if (f.hp < record.lastHp && f.hp > 0) record.hurtUntil = now + 210;
      if (f.hurtTime > 0 || f.hitstun > 0) record.hurtUntil = Math.max(record.hurtUntil, now + Math.max(f.hurtTime || 0, f.hitstun || 0) * 1000);
      if (f.hp <= 0 && !record.faintAt) record.faintAt = now;
      record.lastHp = f.hp;
      if (f.action) {
        const server = f.action;
        record.action = {...server, observedAt:now,
          phase:server.phase || 'windup',
          elapsed:Number(server.elapsed) || 0,
          direction:server.direction || f.facing,
          kind:server.kind || server.attackKind};
      } else if (record.action && now - record.action.observedAt > 180) record.action = null;
    }
    for (const event of state.events || []) {
      const key = `event:${event.id}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const fighter = state.fighters?.find(f => f.team === event.team && (!event.sourceSpecies || f.species === event.sourceSpecies))
        || state.fighters?.find(f => f.team === event.team);
      const record = fighter ? this.getCharacter(fighter) : null;
      const move = this.moves(event.move) || {};
      if (event.kind === 'cast') {
        if (record && !fighter.action) record.action = {...event, kind:event.attackKind || move.arena?.kind,
          phase:'windup', elapsed:0, observedAt:now, direction:event.direction || fighter.facing};
        this.audio.windup(event.move,event.type,Math.max(.08,event.windup||.18));
      }
      if (event.kind === 'cancel' && record) record.action = null;
      if (event.kind === 'release') {
        this.release(event, fighter, record, now);
      } else if (event.kind === 'move' && !state.fighters?.some(f => f.action) && !state.events?.some(e=>e.kind==='release'&&e.move===event.move&&e.team===event.team)) {
                                                                                              
        this.release({...event, attackKind:move.arena?.kind, direction:fighter?.facing}, fighter, record, now);
      }
      if (event.kind === 'hurt' && record) {
        record.hurtUntil = now + 230;
        record.hitDirection = event.direction || {x:-(fighter.facing?.x||1),y:-(fighter.facing?.y||0)};
        this.audio.hit(event.type,event.effectiveness);
        if (this.settings().screenShake) this.shake = Math.max(this.shake, 3);
        this.hitStopAt = now;
        this.hitStopUntil = now + 55;
      }
      if (event.kind === 'faint') {
        this.audio.faint();
        if (record) record.faintAt = now;
        this.notice(event.text || `${fighter?.name || 'Pokémon'} fainted!`, event.type);
        this.burst(event.x ?? fighter?.x, event.y ?? fighter?.y, event.type, 14, 45);
      }
      if (event.kind === 'switch') {

        if (record) record.enteredAt = now;
        if (fighter) this.effects.push({kind:'summon',x:fighter.x,y:fighter.y,type:'Normal',life:.55,max:.55});
        this.notice(event.text || 'Pokémon switched!', 'Normal');
      }
      if(event.kind==='deploy'){if(record){record.deployedAt=now;record.deploymentOrigin={x:event.fromX,y:event.fromY};}this.audio.sendout();}
      if(event.kind==='deployRelease'){this.audio.cry(event.species||fighter?.species);this.burst(event.x,event.y-14,'Normal',16,70);}
      if(event.kind==='recall'){this.audio.recall();const old=previous?.fighters?.find(f=>f.team===event.team&&f.species===event.sourceSpecies);this.recalls.push({species:event.sourceSpecies,x:event.x,y:event.y,facing:old?.facing||{x:1,y:0},life:.28,max:.28});}
      if(event.kind==='ppPickup'){this.audio.heal();this.burst(event.x,event.y-8,'Psychic',10,45);}
      if (['status','evolutionStart','evolution','levelUp','elimination','xp'].includes(event.kind) && event.text && !event.silent && !(event.kind==='xp'&&state.events?.some(item=>item.team===event.team&&['evolution','levelUp'].includes(item.kind)))) this.notice(event.text,event.type||'Normal');
    }
    for (const effect of state.effects || []) {
      const key = `fx:${effect.id}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (effect.text) this.labels.push({x:effect.x,y:effect.y-18,text:effect.text,type:effect.type,life:.9,max:.9});
      if (effect.kind === 'damage') {
        const signature=effect.move;
        if(signature) this.effects.push({kind:'moveImpact',move:signature,x:effect.x,y:effect.y+12,type:effect.type,life:.52,max:.52});
        this.burst(effect.x, effect.y + 12, effect.type, 9, 70);
        this.addDecal(effect.x,effect.y+20,effect.type);
        if (this.settings().screenShake) this.shake = Math.max(this.shake, signature==='bodyslam'||signature==='fireblast'?4:2);
      }
      if(effect.kind==='slash'&&effect.move==='scratch'){const life=Math.max(.2,Number(effect.life)||.28);this.effects.push({...effect,life,max:life});}
      if (['impact','effective','critical','heal','boost','immune','blocked','wispHit'].includes(effect.kind)) {
        const life=Math.max(.2,Number(effect.life)||.35);
        this.effects.push({...effect,life,max:life});
        if (effect.kind==='impact') this.burst(effect.x,effect.y,effect.type,12,90);
        if (effect.kind==='impact') this.addDecal(effect.x,effect.y,effect.type);
      }
    }
    if (this.seen.size > 1600) this.seen = new Set([...this.seen].slice(-800));
  }

  release(event, fighter, record, now) {
    const move = this.moves(event.move) || {};
    if (record) record.action = {...event,kind:event.attackKind || move.arena?.kind,
      phase:'recovery',elapsed:0,observedAt:now,windup:event.windup||.18,recovery:event.recovery||.25,
      direction:event.direction||fighter.facing};
    const direction = event.direction || fighter?.facing || {x:1,y:0};
    const x = event.x ?? fighter?.x, y = event.y ?? fighter?.y;
    if (!Number.isFinite(x)) return;
    if(event.actionId){this.emissions.set(event.actionId,{x:x+direction.x*18,y:y+direction.y*18-12,at:now,type:event.type,move:event.move});if(this.emissions.size>64)this.emissions.delete(this.emissions.keys().next().value);}
    const kind = event.attackKind || move.arena?.kind || 'projectile';
    this.audio.cast(event.type || move.type,event.move);
    if (kind === 'melee') {
      const moveId=event.move;
      const chargeLengths={volttackle:118,wildcharge:98,flareblitz:92,bravebird:96,headsmash:86,aquajet:78,quickattack:90,extremespeed:128,doubleedge:76,takedown:64,struggle:52};
      if(chargeLengths[moveId])this.effects.push({kind:'chargeTrail',x,y:y-12,type:event.type,direction,life:.42,max:.42,move:moveId,length:Math.max(2,Number.isFinite(Number(event.dashDistance))?Number(event.dashDistance):chargeLengths[moveId])});
      else if(moveId==='bodyslam')this.effects.push({kind:'bodySlamLaunch',x,y:y-12,type:'Normal',direction,life:.42,max:.42,move:moveId});
      else if(moveId==='flamewheel')this.effects.push({kind:'fireWheel',x,y:y-12,type:'Fire',direction,life:.48,max:.48,move:moveId});
      else if(['waterfall','aquatail'].includes(moveId))this.effects.push({kind:'waterSlash',x:x+direction.x*34,y:y+direction.y*34-12,type:'Water',direction,life:.4,max:.4,move:moveId});
      else if(['tackle','pound','strength','stomp','takedown','doubleedge'].includes(moveId))this.effects.push({kind:'heavyImpact',x:x+direction.x*34,y:y+direction.y*34-12,type:event.type,direction,life:.34,max:.34,move:moveId});
      else if(['bite','crunch','bugbite'].includes(moveId))this.effects.push({kind:'biteImpact',x:x+direction.x*33,y:y+direction.y*33-12,type:event.type,direction,life:.34,max:.34,move:moveId});
      else if(moveId==='leechlife')this.effects.push({kind:'leechDrain',x:x+direction.x*33,y:y+direction.y*33-12,type:'Bug',direction,life:.45,max:.45,move:moveId});
      else if(moveId==='lick'||moveId==='astonish'||moveId==='shadowsneak')this.effects.push({kind:'shadowClaw',x:x+direction.x*33,y:y+direction.y*33-12,type:'Ghost',direction,life:.35,max:.35,move:moveId});
      else if(moveId==='drillpeck')this.effects.push({kind:'drillPeck',x:x+direction.x*33,y:y+direction.y*33-12,type:'Flying',direction,life:.36,max:.36,move:moveId});
      else if(moveId==='closecombat')this.effects.push({kind:'combatFlurry',x:x+direction.x*24,y:y+direction.y*24-12,type:event.type,direction,life:.42,max:.42,move:moveId});
      else if(['dragonclaw','leafblade','slash','cut','shadowclaw','psychocut','nightslash','metalclaw','steelwing','irontail','poisonjab','crosspoison','drillpeck','peck','wingattack','aerialace','airslash','xscissor'].includes(moveId))this.effects.push({kind:moveId==='xscissor'?'xScissor':moveId==='shadowclaw'?'shadowClaw':'clawArc',x:x+direction.x*36,y:y+direction.y*36-12,type:event.type,direction,life:.36,max:.36,move:moveId});
      else if(moveId==='playrough')this.effects.push({kind:'fairyImpact',x:x+direction.x*34,y:y+direction.y*34-12,type:event.type,direction,life:.4,max:.4,move:moveId});
      else if(['headbutt','zenheadbutt','ironhead','headsmash'].includes(moveId))this.effects.push({kind:'heavyImpact',x:x+direction.x*34,y:y+direction.y*34-12,type:event.type,direction,life:.38,max:.38,move:moveId});
      else if(['firepunch','thunderpunch','icepunch','machpunch','bulletpunch','drainpunch','karatechop','brickbreak','spark','nuzzle'].includes(moveId))this.effects.push({kind:'elementalPunch',x:x+direction.x*34,y:y+direction.y*34-12,type:event.type,direction,life:.34,max:.34,move:moveId});
      else if(['vinewhip','powerwhip'].includes(moveId))this.effects.push({kind:'vineWhip',x:x+direction.x*35,y:y+direction.y*35-12,type:'Grass',direction,life:.38,max:.38,move:moveId});
      else this.effects.push({kind:'slash',x,y:y-12,type:event.type,direction,life:.28,max:.28,move:event.move});
    }
    else if (kind === 'pulse') {const pulseLife={earthquake:.9,bulldoze:.72,discharge:.68,dazzlinggleam:.68,hypervoice:.62,snarl:.62,strugglebug:.62}[event.move]||.52;this.effects.push({kind:'pulse',x,y,type:event.type,life:pulseLife,max:pulseLife,radius:move.arena?.range||170,move:event.move,direction});}
    else if (kind === 'self') this.effects.push({kind:'self',x,y,type:event.type,life:.72,max:.72,move:event.move});
    else if (kind === 'target') this.effects.push({kind:'transformAura',x,y,type:'Psychic',direction,life:.8,max:.8,move:event.move});
    else this.effects.push({kind:'muzzle',x:x+direction.x*20,y:y+direction.y*20-12,type:event.type,direction,life:.2,max:.2});
    this.burst(x+direction.x*15,y+direction.y*15,event.type||move.type,7,40);
  }

  burst(x,y,type,count,speed) {
    if (!this.settings().particles || !Number.isFinite(x) || !Number.isFinite(y)) return;
    for (let i=0;i<count;i++) {
      const angle=Math.random()*TAU, velocity=speed*(.3+Math.random()*.7), life=.22+Math.random()*.3;
      this.particles.push({x,y,vx:Math.cos(angle)*velocity,vy:Math.sin(angle)*velocity,life,max:life,type,size:1+Math.random()*2.5});
    }
    if (this.particles.length>500) this.particles.splice(0,this.particles.length-500);
  }

  addDecal(x,y,type) {
    if(!Number.isFinite(x)||!Number.isFinite(y))return;
    const existing=this.decals.find(d=>d.kind!=='skid'&&d.type===type&&d.life>3.7&&Math.hypot(d.x-x,d.y-y)<22);
    if(existing)return;
    const kind=type==='Fire'||type==='Electric'?'scorch':type==='Water'||type==='Poison'?'splash':type==='Ice'?'frost':'crack';
    this.decals.push({x,y,type,kind,life:4,max:4,angle:Math.random()*TAU,size:14+Math.random()*10,
      marks:Array.from({length:7},(_,i)=>({angle:i*TAU/7+(Math.random()-.5)*.3,length:.55+Math.random()*.45,width:2+Math.random()*4}))});
    if(this.decals.length>48)this.decals.splice(0,this.decals.length-48);
  }

  addSkid(before,after) {
    const dx=after.x-before.x,dy=after.y-before.y,distance=Math.hypot(dx,dy),steps=Math.min(5,Math.max(1,Math.ceil(distance/8))),angle=Math.atan2(dy,dx);
    for(let i=0;i<steps;i++){const t=i/steps,life=.35+Math.random()*.3;
      this.dust.push({x:mix(before.x,after.x,t),y:mix(before.y,after.y,t),vx:-dx/distance*(6+Math.random()*9),vy:-dy/distance*(6+Math.random()*9),life,max:life,size:3+Math.random()*4});}
    this.decals.push({x:before.x,y:before.y,kind:'skid',angle,size:Math.min(18,distance+4),life:1.45,max:1.45});
    if(this.dust.length>100)this.dust.splice(0,this.dust.length-100);
    if(this.decals.length>48)this.decals.splice(0,this.decals.length-48);
  }

  drawGroundEffects(dt,arenaId) {
    const ctx=this.ctx;
    for(let i=this.decals.length-1;i>=0;i--){const d=this.decals[i];d.life-=dt;if(d.life<=0){this.decals.splice(i,1);continue;}ctx.save();ctx.translate(d.x,d.y);ctx.rotate(d.angle);ctx.globalAlpha=Math.min(1,d.life/1.8)*.62;
      if(d.kind==='skid'){ctx.strokeStyle='#0f182d';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(0,-3);ctx.lineTo(d.size,-3);ctx.moveTo(0,3);ctx.lineTo(d.size*.85,3);ctx.stroke();}
      else if(d.kind==='splash'){ctx.fillStyle=d.type==='Poison'?'#734783':'#5688a699';ctx.beginPath();ctx.ellipse(0,0,d.size,d.size*.54,0,0,TAU);ctx.fill();for(const m of d.marks){ctx.fillStyle=d.type==='Poison'?'#ae80bc99':'#a8dce299';ctx.beginPath();ctx.ellipse(Math.cos(m.angle)*d.size*m.length,Math.sin(m.angle)*d.size*m.length*.6,m.width,m.width*.5,0,0,TAU);ctx.fill();}}
      else if(d.kind==='scorch'){ctx.fillStyle='#14151dc9';ctx.beginPath();ctx.ellipse(0,0,d.size,d.size*.66,0,0,TAU);ctx.fill();ctx.fillStyle='#291d2588';ctx.beginPath();ctx.ellipse(2,0,d.size*.66,d.size*.45,0,0,TAU);ctx.fill();for(const m of d.marks){ctx.strokeStyle=d.life>3.4?'#dc8a5288':'#171d29aa';ctx.lineWidth=m.width*.45;ctx.beginPath();ctx.moveTo(Math.cos(m.angle)*d.size*.6,Math.sin(m.angle)*d.size*.38);ctx.lineTo(Math.cos(m.angle)*d.size*m.length*1.35,Math.sin(m.angle)*d.size*m.length*.85);ctx.stroke();}}
      else{ctx.strokeStyle=d.kind==='frost'?'#a5d4e199':'#131c2fbf';ctx.lineWidth=d.kind==='frost'?1.5:1.2;for(const m of d.marks){const length=d.size*m.length;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.cos(m.angle+.12)*length*.55,Math.sin(m.angle+.12)*length*.45);ctx.lineTo(Math.cos(m.angle)*length,Math.sin(m.angle)*length*.7);ctx.stroke();ctx.beginPath();ctx.moveTo(Math.cos(m.angle+.12)*length*.55,Math.sin(m.angle+.12)*length*.45);ctx.lineTo(Math.cos(m.angle+.65)*length*.78,Math.sin(m.angle+.65)*length*.56);ctx.stroke();}}
      ctx.restore();
    }
    const dustColor=arenaId==='summit'?'#d8eaf0':arenaId==='coast'?'#d8c296':arenaId==='forest'?'#9b9470':arenaId==='volcano'?'#8e7772':'#8c9aa7';
    for(let i=this.dust.length-1;i>=0;i--){const d=this.dust[i];d.life-=dt;if(d.life<=0){this.dust.splice(i,1);continue;}d.x+=d.vx*dt;d.y+=d.vy*dt;const age=1-d.life/d.max;ctx.save();ctx.globalAlpha=(1-age)*.46;ctx.fillStyle=dustColor;ctx.beginPath();ctx.ellipse(d.x,d.y-3-age*5,d.size*(1+age),d.size*(.55+age*.4),0,0,TAU);ctx.fill();ctx.restore();}
  }

  updateCamera(self, aim, dt) {
    if (!self) return;
    const margin=14, halfW=600/this.camera.zoom, halfH=380/this.camera.zoom;
    const dx=aim.x-self.x,dy=aim.y-self.y,d=Math.hypot(dx,dy)||1;
    const targetX=clamp(self.x+dx/d*28+(self.vx||0)*.055,SCENE.x+halfW+margin,SCENE.x+SCENE.w-halfW-margin);
    const targetY=clamp(self.y+dy/d*20+(self.vy||0)*.055,SCENE.y+halfH+margin,SCENE.y+SCENE.h-halfH-margin);
    const amount=this.camera.initialized?1-Math.exp(-dt*11):1;
    this.camera.x=mix(this.camera.x,targetX,amount);
    this.camera.y=mix(this.camera.y,targetY,amount);
    this.camera.initialized=true;
  }

  worldToScreen(x,y) { return {x:600+(x-this.camera.x)*this.camera.zoom,y:380+(y-this.camera.y)*this.camera.zoom}; }
  screenToWorld(x,y) { return {x:clamp(this.camera.x+(x-600)/this.camera.zoom,0,1200),y:clamp(this.camera.y+(y-380)/this.camera.zoom,0,760)}; }

  interpolate(f, now) {
    const previous=this.previous?.fighters?.find(p=>p.id===f.id&&p.species===f.species);
    if (!previous||Math.hypot(f.x-previous.x,f.y-previous.y)>120) return {x:f.x,y:f.y};
    const t=clamp((now-this.lastSnapshot)/50,0,1);
    return {x:mix(previous.x,f.x,t),y:mix(previous.y,f.y,t)};
  }

  render(battle,state,now,dt,{selfTeam,aimX,aimY,resultShown,lockTargetTeam}) {
    if (!battle) return;
    if (this.battle?.id!==battle.id) this.reset(battle);
    this.battle=battle;
    const ctx=this.ctx,self=state?.fighters?.find(f=>f.team===selfTeam);
    this.updateCamera(self,{x:aimX,y:aimY},dt);
    ctx.clearRect(0,0,1200,760);
    ctx.save();
    ctx.translate(600,380);
    ctx.scale(this.camera.zoom,this.camera.zoom);
    ctx.translate(-this.camera.x,-this.camera.y);
    if(this.shake>.05){ctx.translate((Math.random()-.5)*this.shake,(Math.random()-.5)*this.shake);this.shake*=Math.exp(-dt*18);}
    const arenaId=battle.arena?.id||'stadium',arena=this.arenas.get(arenaId);
    ctx.imageSmoothingEnabled=false;
    if(arena?.ready)ctx.drawImage(arena.image,SCENE.x,SCENE.y,SCENE.w,SCENE.h);
    else{ctx.fillStyle='#344858';ctx.fillRect(SCENE.x,SCENE.y,SCENE.w,SCENE.h);ctx.strokeStyle='#8fa6ab';ctx.strokeRect(0,0,1200,760);}
    this.drawGroundEffects(dt,arenaId);
    this.drawZone(state?.zone);
    this.drawObstacles(battle.arena?.obstacles||[],arenaId);
    this.drawPpOrbs(state?.ppOrbs||[],now);
    const fighters=[...(state?.fighters||[])].sort((a,b)=>a.y-b.y);
    for(const f of fighters){const pos=this.interpolate(f,now);this.drawShadow(f,pos,selfTeam,now);}

    const animationDt = now < this.hitStopUntil ? 0 : dt;
    for(const f of fighters)this.drawCharacter(f,this.interpolate(f,now),now,animationDt,selfTeam);
    for(const f of fighters)if(f.evolution)this.drawEvolution(f,this.interpolate(f,now),now);
    for(const f of fighters)this.drawDeployment(f,this.interpolate(f,now),now);
    this.drawRecalls(dt);
    for(const f of fighters)this.drawStatus(f,this.interpolate(f,now),now);
    for(const projectile of state?.projectiles||[])this.drawProjectile(projectile,now,dt);
    this.drawEffects(dt,now);
    this.drawParticles(dt);
    for(const f of fighters)this.drawLabel(f,this.interpolate(f,now),selfTeam);
    if(Number.isInteger(lockTargetTeam)){const target=fighters.find(f=>f.team===lockTargetTeam&&f.hp>0);if(target)this.drawTargetLock(target,this.interpolate(target,now),now);}
    this.drawDamageLabels(dt);
    ctx.restore();
    if(!this.lastDiagnosticAt||now-this.lastDiagnosticAt>100){this.canvas.dataset.animations=JSON.stringify(this.diagnostics());this.canvas.dataset.camera=JSON.stringify({x:this.camera.x,y:this.camera.y,zoom:this.camera.zoom});this.lastDiagnosticAt=now;}
    const enemy=fighters.find(f=>f.team!==selfTeam);
    if(enemy&&enemy.hp>0)this.drawOffscreenOpponent(enemy);
    for(const [id,record] of this.characters)if(!fighters.some(f=>f.id===id)){record.element?.remove();this.characters.delete(id);}
  }

  drawEvolution(f,pos,now) {
    const transition=f.evolution;
    if(!transition)return;
    const duration=Math.max(.1,Number(transition.duration)||2.6);
    const progress=clamp((Number(transition.elapsed)||0)+clamp((now-this.lastSnapshot)/1000,0,.08),0,duration)/duration;
    const ease=progress*progress*(3-2*progress);
    const pulse=.5+.5*Math.sin(progress*Math.PI*9);
    const next=this.species(transition.toSpecies);
    const nextType=next?.types?.[0]||this.species(f.species)?.types?.[0]||'Fairy';
    const accent=tint(nextType);
    const ctx=this.ctx;
    ctx.save();
    ctx.translate(pos.x,pos.y-18);
    ctx.globalCompositeOperation='lighter';
    ctx.lineCap='round';
    ctx.lineJoin='round';

    // Evolution is staged like a hand-keyed sprite effect: build, orbit, flash, resolve.
    const orbit=22+ease*27;
    ctx.globalAlpha=(.34+.18*pulse)*(1-progress*.38);
    ctx.strokeStyle='#fff9e0';
    ctx.lineWidth=1.5;
    for(let ring=0;ring<2;ring++){
      const rx=orbit+ring*7,ry=5+ring*2;
      for(let segment=0;segment<3;segment++){
        const start=segment*TAU/3+progress*TAU*(ring===0?1.1:-.72);
        ctx.beginPath();
        ctx.ellipse(0,4,rx,ry,ring?.12:-.1,start,start+.7+(ring*.2));
        ctx.stroke();
      }
    }

    // Two tapered light ribbons wrap around the Pokémon.
    for(let side=-1;side<=1;side+=2){
      ctx.globalAlpha=(.18+.34*pulse)*(1-progress*.42);
      ctx.strokeStyle=side<0?accent:'#fff4bf';
      ctx.lineWidth=side<0?2.2:1.2;
      ctx.beginPath();
      ctx.moveTo(side*(10+progress*5),28);
      ctx.bezierCurveTo(side*(orbit+13),18,side*(orbit-3),-13,side*(12+progress*8),-47);
      ctx.stroke();
      ctx.globalAlpha=(.3+.32*pulse)*(1-progress*.38);
      ctx.lineWidth=1;
      ctx.beginPath();
      ctx.moveTo(side*(4+progress*4),24);
      ctx.bezierCurveTo(side*(orbit*.72),8,side*(orbit*.67),-18,side*(4+progress*7),-39);
      ctx.stroke();
    }

    // Small, deterministic four-point glints travel upward on curved paths.
    for(let i=0;i<10;i++){
      const direction=i%2?1:-1;
      const angle=i*TAU/10+progress*TAU*direction*.82;
      const rise=progress*65;
      const rx=18+(i%4)*6+Math.sin(progress*Math.PI)*7;
      const x=Math.cos(angle)*rx;
      const y=20-rise+Math.sin(angle*1.4+i)*5;
      const glint=(.35+.65*Math.abs(Math.sin(progress*TAU*2+i*1.7)))*(1-progress*.27);
      const size=(i%3===0?3:1.8)+pulse*.6;
      ctx.globalAlpha=glint;
      ctx.fillStyle=i%3===0?'#fffef1':accent;
      ctx.beginPath();
      ctx.moveTo(x,y-size*1.8);
      ctx.lineTo(x+size*.48,y-size*.35);
      ctx.lineTo(x+size*1.6,y);
      ctx.lineTo(x+size*.35,y+size*.38);
      ctx.lineTo(x,y+size*1.8);
      ctx.lineTo(x-size*.35,y+size*.38);
      ctx.lineTo(x-size*1.6,y);
      ctx.lineTo(x-size*.48,y-size*.35);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha=glint*.72;
      ctx.fillStyle='#fffef2';
      ctx.fillRect(x-.55,y-.55,1.1,1.1);
    }

    // One authored burst marks the instant the new form appears.
    const burst=Math.max(0,1-Math.abs(progress-.735)/.105);
    if(burst>0){
      const strength=burst*burst;
      ctx.globalAlpha=.72*strength;
      ctx.strokeStyle='#fffef4';
      ctx.lineWidth=1.8;
      for(let i=0;i<12;i++){
        const angle=i*TAU/12-.08;
        const inner=11+(i%3)*3;
        const outer=(i%3===0?orbit+21:i%3===1?orbit+8:orbit+15)*strength+inner;
        const bend=angle+((i%2)?1:-1)*.055;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle)*inner,Math.sin(angle)*inner*.7);
        ctx.lineTo(Math.cos(bend)*outer*.62,Math.sin(bend)*outer*.43);
        ctx.lineTo(Math.cos(angle+.025)*outer,Math.sin(angle+.025)*outer*.7);
        ctx.stroke();
      }
      ctx.globalAlpha=.24*strength;
      ctx.fillStyle=accent;
      ctx.beginPath();
      ctx.ellipse(0,0,orbit+25,orbit*.66,0,0,TAU);
      ctx.fill();
      ctx.globalAlpha=.95*strength;
      ctx.fillStyle='#fffef4';
      ctx.beginPath();
      ctx.moveTo(0,-13);ctx.lineTo(3,-3);ctx.lineTo(13,0);ctx.lineTo(3,3);
      ctx.lineTo(0,13);ctx.lineTo(-3,3);ctx.lineTo(-13,0);ctx.lineTo(-3,-3);
      ctx.closePath();ctx.fill();
    }

    // Light resolves into a narrow vertical streak at the end.
    if(progress>.84){
      const resolve=clamp((progress-.84)/.16,0,1);
      ctx.globalAlpha=(1-resolve)*.56;
      ctx.strokeStyle='#fffef2';
      ctx.lineWidth=2;
      ctx.beginPath();ctx.moveTo(0,34);ctx.lineTo(0,-54);ctx.stroke();
      ctx.globalAlpha=(1-resolve)*.32;
      ctx.strokeStyle=accent;
      ctx.lineWidth=6;
      ctx.beginPath();ctx.moveTo(0,25);ctx.lineTo(0,-43);ctx.stroke();
    }
    ctx.restore();
  }

  drawTargetLock(f,pos,now) {
    const ctx=this.ctx,pulse=1.5+Math.sin(now/105)*2;
    ctx.save();ctx.translate(pos.x,pos.y-15);ctx.strokeStyle='#ffe09a';ctx.lineWidth=2;ctx.globalAlpha=.94;
    ctx.beginPath();ctx.arc(0,0,31+pulse,0,TAU);ctx.stroke();
    const w=28+pulse,h=35+pulse;
    ctx.beginPath();ctx.moveTo(-w,-h+10);ctx.lineTo(-w,-h);ctx.lineTo(-w+10,-h);ctx.moveTo(w-10,-h);ctx.lineTo(w,-h);ctx.lineTo(w,-h+10);ctx.moveTo(-w,h-10);ctx.lineTo(-w,h);ctx.lineTo(-w+10,h);ctx.moveTo(w-10,h);ctx.lineTo(w,h);ctx.lineTo(w,h-10);ctx.stroke();
    ctx.fillStyle='#fff0c3';ctx.font='800 8px Barlow, sans-serif';ctx.textAlign='center';ctx.fillText('LOCKED',0,-43-pulse);ctx.restore();
  }

  drawZone(zone) {
    if(!zone||!Number.isFinite(zone.radius))return;
    const ctx=this.ctx;
    if(zone.closing){
      ctx.save();
      ctx.fillStyle='rgba(82,17,31,.27)';
      ctx.beginPath();
      ctx.rect(0,0,1200,760);
      ctx.arc(zone.x,zone.y,Math.max(0,zone.radius),0,Math.PI*2,true);
      try{ctx.fill('evenodd');}catch{ctx.fill();}
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle=zone.closing?'#ff9a9acc':'#c9e8ff70';
    ctx.lineWidth=zone.closing?4:2;
    ctx.setLineDash(zone.closing?[12,9]:[7,10]);
    ctx.beginPath();
    ctx.arc(zone.x,zone.y,Math.max(0,zone.radius),0,Math.PI*2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawPpOrbs(orbs,now) {
    const ctx=this.ctx;
    for(const orb of orbs){
      if(!Number.isFinite(orb.x)||!Number.isFinite(orb.y))continue;
      const phase=String(orb.id).length,pulse=Math.sin(now/350+phase),bob=Math.sin(now/500+phase)*2;
      ctx.save();ctx.translate(Math.round(orb.x),Math.round(orb.y));
      ctx.globalAlpha=orb.life<3?.55+.35*Math.sin(now/110):1;
      ctx.fillStyle='#09152666';ctx.beginPath();ctx.ellipse(0,4,9,4,0,0,TAU);ctx.fill();
      ctx.strokeStyle='#d4b77e55';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(0,4,12+pulse,6,0,0,TAU);ctx.stroke();
      ctx.translate(0,-8+bob);ctx.fillStyle='#18283d';ctx.fillRect(-6,-8,12,16);ctx.fillRect(-8,-6,16,12);
      ctx.fillStyle='#9f83c5';ctx.fillRect(-5,-6,10,12);ctx.fillRect(-6,-4,12,8);
      ctx.fillStyle='#cdb3e8';ctx.fillRect(-4,-5,7,4);ctx.fillStyle='#efe1bb';ctx.fillRect(-3,-5,3,2);
      ctx.fillStyle='#725a9a';ctx.fillRect(-4,3,8,3);ctx.fillStyle='#f4deb0';ctx.fillRect(-3,-1,6,2);ctx.fillRect(-1,-3,2,6);
      ctx.restore();
    }
  }

  drawObstacles(obstacles,id) {
    const ctx=this.ctx;
    for(const o of obstacles){
      const{x,y,w,h}=o;
      ctx.save();ctx.translate(x,y);
      const polygon=(points,fill,stroke)=>{ctx.beginPath();points.forEach(([px,py],i)=>i?ctx.lineTo(px,py):ctx.moveTo(px,py));ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill();}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke();}};
      const rim=[[5,0],[w-7,0],[w,7],[w,h-6],[w-7,h],[6,h],[0,h-7],[0,6]];
      ctx.fillStyle='#07122477';ctx.fillRect(6,9,w,h-2);
      if(id==='stadium'){
        polygon(rim,'#1c2c43','#101b2e');
        polygon([[6,5],[w-7,5],[w-5,8],[w-5,h-14],[6,h-14]],'#435774','#788ba0');
        ctx.fillStyle='#2c3d57';ctx.fillRect(5,h-14,w-10,9);
        ctx.strokeStyle='#ad955c';ctx.lineWidth=2;ctx.strokeRect(12,13,w-24,h-39);
        ctx.strokeStyle='#1c3149';ctx.lineWidth=2;ctx.strokeRect(17,18,w-34,h-49);
        for(const xx of [7,w-13])for(const yy of [7,h-22]){ctx.fillStyle='#cab576';ctx.fillRect(xx,yy,6,5);ctx.fillStyle='#786a4d';ctx.fillRect(xx+1,yy+4,5,2);}
        ctx.save();ctx.translate(w/2,(h-9)/2);ctx.rotate(Math.PI/4);ctx.strokeStyle='#c3ae71';ctx.lineWidth=2;ctx.strokeRect(-10,-10,20,20);ctx.fillStyle='#778ba0';ctx.fillRect(-3,-3,6,6);ctx.restore();
        ctx.fillStyle='#8b98a455';for(let i=0;i<5;i++)ctx.fillRect(19+(i*17)%(w-32),19+(i*23)%(h-40),3,2);
      }else if(id==='summit'){
        polygon(rim,'#51718a','#355d7c');
        polygon([[3,h-13],[5,16],[w*.29,2],[w*.57,6],[w*.8,0],[w-4,21],[w-2,h-16],[w*.7,h-3],[w*.26,h-6]],'#8cb6c9','#c0e3ee');
        polygon([[w*.29,2],[w*.43,h*.49],[5,16]],'#d4edf0');
        polygon([[w*.57,6],[w*.43,h*.49],[w*.29,2]],'#b9d9e6');
        polygon([[w*.8,0],[w*.72,h*.53],[w*.43,h*.49],[w*.57,6]],'#a5d3e4');
        polygon([[w*.72,h*.53],[w-4,21],[w-2,h-16],[w*.7,h-3]],'#6694b2');
        polygon([[w*.43,h*.49],[w*.72,h*.53],[w*.7,h-3],[w*.26,h-6],[3,h-13]],'#76a2bb');
        ctx.strokeStyle='#e6fbff9c';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(w*.29,2);ctx.lineTo(w*.43,h*.49);ctx.lineTo(w*.26,h-6);ctx.moveTo(w*.8,0);ctx.lineTo(w*.72,h*.53);ctx.lineTo(w*.7,h-3);ctx.stroke();
        ctx.fillStyle='#e2eff0';ctx.fillRect(7,14,18,5);ctx.fillRect(w*.55,7,w*.24,4);ctx.fillStyle='#b1d4de';ctx.fillRect(4,h-9,12,6);
      }else if(id==='volcano'){
        polygon(rim,'#261e29','#171725');
        polygon([[5,9],[w*.34,2],[w-7,6],[w-4,h*.38],[w*.69,h-10],[6,h-9]],'#574047','#80605b');
        polygon([[w*.34,2],[w*.44,h*.44],[6,h-9],[5,9]],'#72504e');
        polygon([[w*.44,h*.44],[w-4,h*.38],[w*.69,h-10],[6,h-9]],'#3d303c');
        ctx.strokeStyle='#e895586b';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(w*.34,3);ctx.lineTo(w*.42,h*.35);ctx.lineTo(w*.55,h*.48);ctx.lineTo(w*.48,h*.72);ctx.lineTo(w*.61,h-10);ctx.moveTo(w*.55,h*.48);ctx.lineTo(w-7,h*.37);ctx.stroke();
        ctx.fillStyle='#9b655b';for(let i=0;i<8;i++)ctx.fillRect(8+(i*23)%(w-18),11+(i*31)%(h-25),4,3);
        ctx.fillStyle='#c8845366';ctx.fillRect(9,h-11,9,3);ctx.fillRect(w-20,9,8,3);
      }else if(id==='forest'){
        polygon(rim,'#293f37','#1d302d');
        polygon([[5,12],[w*.28,3],[w*.62,5],[w-5,17],[w-3,h-15],[w*.58,h-7],[6,h-11]],'#61715b','#90a078');
        polygon([[w*.28,3],[w*.4,h*.43],[6,h-11],[5,12]],'#819074');
        polygon([[w*.4,h*.43],[w*.62,5],[w-5,17],[w-3,h-15],[w*.58,h-7]],'#52644e');
        ctx.strokeStyle='#344d3a';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(w*.28,3);ctx.lineTo(w*.4,h*.43);ctx.lineTo(w*.58,h-7);ctx.moveTo(w*.4,h*.43);ctx.lineTo(7,h*.54);ctx.stroke();
        for(let i=0;i<11;i++){const xx=6+(i*11)%(w-20),yy=5+(i*7)%17;ctx.fillStyle=['#6c9251','#81a158','#466d3e'][i%3];ctx.fillRect(xx,yy,8+(i%3)*3,5);}
        ctx.fillStyle='#90a867';ctx.fillRect(3,h-17,12,5);ctx.fillStyle='#365b36';ctx.fillRect(1,h-12,15,8);ctx.fillRect(w-11,h-18,10,12);
      }else if(id==='coast'){
        polygon(rim,'#716b59','#545950');
        polygon([[5,12],[w*.24,3],[w*.63,2],[w-5,13],[w-3,h-17],[w*.59,h-6],[6,h-10]],'#b6b294','#ded4aa');
        polygon([[w*.24,3],[w*.38,h*.43],[6,h-10],[5,12]],'#cbc4a4');
        polygon([[w*.38,h*.43],[w*.63,2],[w-5,13],[w-3,h-17],[w*.59,h-6]],'#969f8d');
        ctx.strokeStyle='#798775';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(w*.24,3);ctx.lineTo(w*.38,h*.43);ctx.lineTo(w*.59,h-6);ctx.stroke();
        ctx.fillStyle='#e1d6b4';for(let i=0;i<7;i++)ctx.fillRect(9+(i*17)%(w-22),12+(i*29)%(h-30),5+(i%2)*3,3);
        ctx.fillStyle='#637f70';ctx.fillRect(3,h-17,11,8);ctx.fillRect(w-13,h-21,10,12);ctx.fillStyle='#a6bab0';ctx.fillRect(w-11,h-24,5,3);
      }else{
        polygon(rim,'#36404d','#222d3b');
        polygon([[6,7],[w*.35,3],[w*.43,8],[w-6,6],[w-5,h-13],[6,h-13]],'#777e83','#a0a4a0');
        ctx.fillStyle='#56656d';ctx.fillRect(5,h-13,w-10,8);
        ctx.strokeStyle='#46545f';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(7,h*.34);ctx.lineTo(w-7,h*.34);ctx.moveTo(7,h*.64);ctx.lineTo(w-7,h*.64);ctx.moveTo(w*.38,h*.34);ctx.lineTo(w*.38,h*.64);ctx.moveTo(w*.68,h*.64);ctx.lineTo(w*.68,h-14);ctx.stroke();
        ctx.strokeStyle='#b0ad9577';ctx.lineWidth=1.5;ctx.strokeRect(14,15,w-28,h-40);ctx.beginPath();ctx.moveTo(w*.28,21);ctx.lineTo(w*.64,21);ctx.lineTo(w*.64,h*.42);ctx.lineTo(w*.44,h*.42);ctx.stroke();
        ctx.fillStyle='#81916c';ctx.fillRect(7,7,14,4);ctx.fillRect(w-19,h-18,11,5);ctx.fillStyle='#39493e';ctx.fillRect(w-14,h-12,12,8);
      }
      ctx.restore();
    }
  }

  drawShadow(f,pos,selfTeam,now) {
    if(f.deployment?.phase==='ball')return;
    const ctx=this.ctx;
    ctx.save();ctx.translate(pos.x,pos.y);ctx.fillStyle='#0815256b';ctx.beginPath();ctx.ellipse(0,1,20,9,0,0,TAU);ctx.fill();
    ctx.lineWidth=1.6;ctx.strokeStyle=f.team===selfTeam?'#ffdc7399':'#f58c9677';ctx.beginPath();ctx.ellipse(0,1,23,11,0,0,TAU);ctx.stroke();
    if(f.protect){ctx.strokeStyle='#a7e5ffc9';ctx.fillStyle='#8edfff14';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,-15,29,35,0,0,TAU);ctx.fill();ctx.stroke();}
    if(f.dodge){ctx.strokeStyle='#ffffff88';ctx.lineWidth=2;for(let i=0;i<3;i++){ctx.beginPath();ctx.moveTo(-f.facing.x*(18+i*9)-f.facing.y*12,-f.facing.y*(18+i*9)+f.facing.x*12);ctx.lineTo(-f.facing.x*(18+i*9)+f.facing.y*12,-f.facing.y*(18+i*9)-f.facing.x*12);ctx.stroke();}}
    ctx.restore();
  }

  drawAim(f,aimX,aimY) {
    const ctx=this.ctx,dx=aimX-f.x,dy=aimY-f.y,length=Math.hypot(dx,dy)||1;
    ctx.save();ctx.translate(f.x,f.y);ctx.rotate(Math.atan2(dy,dx));ctx.strokeStyle='#fff0a54d';ctx.lineWidth=1;ctx.setLineDash([3,5]);ctx.beginPath();ctx.moveTo(27,0);ctx.lineTo(84,0);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#ffe490aa';ctx.beginPath();ctx.moveTo(94,0);ctx.lineTo(86,-3);ctx.lineTo(86,3);ctx.closePath();ctx.fill();ctx.restore();
  }

  measureSpecies(id,entry) {
    if(this.metrics.has(id))return this.metrics.get(id);
    const base=animationFor(entry,'idle'),image=base&&this.loadImage(base.data.src);
    if(!image)return null;
    const a=base.data,w=a.frameWidth,h=a.frameHeight;
    const surface=document.createElement('canvas');surface.width=w;surface.height=h;
    const draw=surface.getContext('2d',{willReadFrequently:true});
    let minY=h,maxY=0,minX=w,maxX=0;
    for(let row=0;row<Math.min(8,a.directions||1);row++){
      draw.clearRect(0,0,w,h);draw.drawImage(image,0,row*h,w,h,0,0,w,h);
      const data=draw.getImageData(0,0,w,h).data;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(data[(y*w+x)*4+3]>80){minY=Math.min(minY,y);maxY=Math.max(maxY,y);minX=Math.min(minX,x);maxX=Math.max(maxX,x);}
    }
    const p=this.species(id),targetHeight=clamp(32+Math.sqrt(p?.heightm||1)*9,35,49);
    const scale=targetHeight/Math.max(16,maxY-minY+1);
    const result={scale,footOffset:4,height:targetHeight,width:(maxX-minX+1)*scale};
    this.metrics.set(id,result);return result;
  }

  drawCharacter(f,pos,now,dt,selfTeam) {
    const ctx=this.ctx,record=this.getCharacter(f),entry=this.manifest[f.species];
    if(f.deployment?.phase==='ball'){if(record.element)record.element.style.opacity='0';record.drawnAnimation='pokeball-throw';record.drawnFrame=Math.floor(f.deployment.elapsed*12);record.drawnRow=0;return;}
    if(f.facing)record.row=directionRow(f.facing.x,f.facing.y);
    const speed=Math.hypot(f.vx||0,f.vy||0),moving=speed>8&&f.hp>0&&f.status!=='frz'&&f.status!=='slp';
    let desired=moving?'walk':'idle';
    const action=record.action;
    let elapsed=action ? action.elapsed+(f.hitstun>0?0:(now-action.observedAt)/1000) : 0;
    if(action&&elapsed>(action.phase==='windup'?action.windup||.3:action.recovery||.3)+.15){record.action=null;}
    const activeAction=f.status==='frz'||f.status==='slp'?null:record.action;
    if(moving){record.walkTime+=dt*clamp(speed/130,.55,1.55);record.row=directionRow(f.vx,f.vy);}
    else if(f.status!=='frz')record.idleTime+=dt;
    if(activeAction){desired=attackAnimation(activeAction);record.row=directionRow(activeAction.direction?.x??f.facing?.x??1,activeAction.direction?.y??f.facing?.y??0);}
    if(f.status==='slp'&&!activeAction)desired='sleep';
    if(record.hurtUntil>now&&f.hp>0)desired='hurt';
    if(f.hp<=0){desired='faint';if(!record.faintAt)record.faintAt=now;}
    const animation=animationFor(entry,desired),image=animation&&this.loadImage(animation.data.src),metrics=entry&&this.measureSpecies(f.species,entry);
    const reaction=record.hurtUntil>now?Math.sin((record.hurtUntil-now)/230*Math.PI)*5:0;
    let offsetX=(record.hitDirection?.x||-f.facing?.x||0)*reaction,offsetY=(record.hitDirection?.y||-f.facing?.y||0)*reaction;
    const actionPhase=activeAction?.phase,progress=activeAction?clamp(elapsed/(actionPhase==='windup'?activeAction.windup||.18:activeAction.recovery||.25),0,1):0;
    if(activeAction){const dir=activeAction.direction||f.facing||{x:1,y:0};const lunge=activeAction.kind==='melee'?(actionPhase==='windup'?-3*progress:Math.sin(progress*Math.PI)*(activeAction.move==='volttackle'||activeAction.move==='extremespeed'?18:10)):(actionPhase==='recovery'?-Math.sin(progress*Math.PI)*3:0);offsetX+=dir.x*lunge;offsetY+=dir.y*lunge;if(activeAction.move==='bodyslam'){if(actionPhase==='windup')offsetY+=progress*5;else offsetY-=Math.sin(progress*Math.PI)*29;}}
    const summon=f.deployment?.phase==='release'?clamp((f.deployment.elapsed+(now-this.lastSnapshot)/1000)/Math.max(.1,f.deployment.duration),0,1):1,faintTime=record.faintAt?(now-record.faintAt)/1000:0;
    const alpha=f.hp<=0?clamp(1-(faintTime-.6)/.5,0,1):f.dodge?.65:1;
    if(image&&metrics){
      record.element?.remove();record.element=null;
      const a=animation.data;
      let frame=frameAt(a,desired==='walk'?record.walkTime:record.idleTime,true);
      if(activeAction&&['attack','shoot','special','charge'].includes(desired))frame=actionFrame(a,actionPhase,elapsed,activeAction.windup||.18,activeAction.recovery||.25);
      if(desired==='hurt')frame=frameAt(a,(230-(record.hurtUntil-now))/1000,false);
      if(desired==='faint')frame=frameAt(a,faintTime,false);
      const row=(a.directions||8)===1?0:record.row;
      ctx.save();ctx.translate(pos.x+offsetX,pos.y+offsetY);ctx.globalAlpha=alpha*summon;
      const runtimeStride=desired==='walk'&&(!entry.walk||Number(entry.walk.frames)<2);
      if(runtimeStride){const stride=record.walkTime*15;ctx.translate(0,-Math.abs(Math.sin(stride))*2.5);ctx.rotate(Math.sin(stride)*.035);ctx.scale(1,1+Math.sin(stride*2)*.03);}
      ctx.scale(metrics.scale*(.7+.3*summon),metrics.scale*(.7+.3*summon));ctx.imageSmoothingEnabled=false;
      if(f.deployment?.phase==='release'&&summon<.7)ctx.filter='brightness(4) saturate(0)';
      else if(record.hurtUntil>now&&Math.floor(now/55)%2===0)ctx.filter='brightness(1.65)';
      else if(f.status==='frz')ctx.filter='saturate(.35) brightness(1.15)';
      else if(f.evolution){const phase=clamp((f.evolution.elapsed+clamp((now-this.lastSnapshot)/1000,0,.08))/Math.max(.1,f.evolution.duration),0,1),pulse=.5+.5*Math.sin(phase*Math.PI*9),beat=phase<.12||(phase>.68&&phase<.82)||(phase>.17&&phase<.66&&Math.floor(phase*9)%2===0);ctx.filter=beat?'brightness(0) invert(1) drop-shadow(0 0 2px #fff) drop-shadow(0 0 '+(5+pulse*7)+'px #fffbe3)':'brightness('+(1.04+pulse*.18)+') saturate(1.18) drop-shadow(0 0 '+(2+pulse*3)+'px #fff7d8)';}
      const anchor=a.anchors?.[row]?.[frame] || [a.frameWidth/2,a.frameHeight/2+metrics.footOffset];
      ctx.drawImage(image,frame*a.frameWidth,row*a.frameHeight,a.frameWidth,a.frameHeight,-anchor[0],-anchor[1],a.frameWidth,a.frameHeight);
      ctx.restore();
      record.drawnAnimation=runtimeStride?'runtime-walk':animation.name;record.drawnFrame=frame;record.drawnRow=row;
    }else this.drawFallback(f,pos,record,desired,now,{offsetX,offsetY,alpha,summon,progress,actionPhase});
    if(activeAction?.phase==='windup')this.drawWindup(pos,activeAction,progress,now);
    record.lastRender=now;record.lastX=pos.x;record.lastY=pos.y;
  }

  drawFallback(f,pos,record,desired,now,visual) {
    let element=record.element;
    if(!element){element=document.createElement('div');element.className='combat-fallback';const image=document.createElement('img');image.src=this.species(f.species)?.sprite||'';image.alt=f.name;image.draggable=false;element.append(image);this.overlay.append(element);record.element=element;}
    const screen=this.worldToScreen(pos.x+visual.offsetX,pos.y+visual.offsetY);
    const p=this.species(f.species),height=clamp(32+Math.sqrt(p?.heightm||1)*9,35,49)*this.camera.zoom;
    const width=height*1.2;
    const moving=desired==='walk',phase=record.walkTime*15;
    const step=moving?Math.abs(Math.sin(phase))*2.8:0;
    const lean=moving?Math.sin(phase)*3:desired==='hurt'?-10:record.action?(visual.actionPhase==='windup'?-7*visual.progress:9*Math.sin(visual.progress*Math.PI)):0;
    const horizontal=record.row>=5&&record.row<=7?-1:1;
    const squash=moving?1+Math.sin(phase*2)*.025:record.action&&visual.actionPhase==='windup'?1-visual.progress*.08:1;
    const faintProgress=f.hp<=0?clamp((now-record.faintAt)/700,0,1):0;
    const evolutionPulse=f.evolution?.5+.5*Math.sin(now/58):0;
    if(f.status==='frz'){
      const frozenImage=this.loadImage(p?.sprite);
      if(frozenImage){const worldHeight=height/this.camera.zoom,worldWidth=worldHeight*Math.min(1.4,frozenImage.width/Math.max(1,frozenImage.height));element.style.opacity='0';this.ctx.save();this.ctx.translate(pos.x,pos.y);this.ctx.scale(horizontal,1);this.ctx.filter='saturate(.4) brightness(1.15)';this.ctx.drawImage(frozenImage,-worldWidth/2,-worldHeight*.88,worldWidth,worldHeight);this.ctx.restore();record.drawnAnimation='runtime-frozen';record.drawnFrame=0;record.drawnRow=record.row;return;}
    }
    element.style.left=screen.x/12+'%';element.style.top=screen.y/7.6+'%';element.style.width=width/12+'%';element.style.height=height/7.6+'%';
    element.style.opacity=String(visual.alpha*visual.summon);element.style.zIndex=String(10+Math.floor(pos.y/10));
    element.dataset.status=f.status||'';
    const img=element.firstElementChild;const evolutionScale=f.evolution?1.02+evolutionPulse*.055:1;img.style.transform=`translateY(${-step}px) scale(${horizontal*(.8+.2*visual.summon)*evolutionScale},${squash*(1-faintProgress*.55)*evolutionScale}) rotate(${lean+faintProgress*70}deg)`;
    const evolutionPhase=f.evolution?clamp((f.evolution.elapsed+clamp((now-this.lastSnapshot)/1000,0,.08))/Math.max(.1,f.evolution.duration),0,1):0,evolutionBeat=evolutionPhase<.12||(evolutionPhase>.68&&evolutionPhase<.82)||(evolutionPhase>.17&&evolutionPhase<.66&&Math.floor(evolutionPhase*9)%2===0);img.style.filter=f.evolution?(evolutionBeat?'brightness(0) invert(1) drop-shadow(0 0 2px #fff) drop-shadow(0 0 '+(5+evolutionPulse*7)+'px #fffbe3)':'brightness('+(1.04+evolutionPulse*.18)+') saturate(1.18) drop-shadow(0 0 '+(2+evolutionPulse*3)+'px #fff7d8)'):desired==='hurt'?'brightness(1.7)':f.hp<=0?'saturate(.35)':'';
    record.drawnAnimation=`runtime-${desired}`;record.drawnFrame=Math.floor(record.walkTime*8)%4;record.drawnRow=record.row;
  }

  drawPixelBall(x,y,rotation=0,open=0,alpha=1) {
    const ctx=this.ctx;ctx.save();ctx.translate(x,y);ctx.rotate(rotation);ctx.globalAlpha=alpha;ctx.scale(.9,.9);
    const shell=(offset,top)=>{ctx.save();ctx.translate(0,offset);ctx.fillStyle='#151b2b';ctx.fillRect(-6,top?-7:0,12,7);ctx.fillRect(-8,top?-5:0,16,5);ctx.fillStyle=top?'#d85562':'#e4e7df';ctx.fillRect(-5,top?-6:1,10,5);ctx.fillRect(-7,top?-4:1,14,3);ctx.fillStyle=top?'#ff8990':'#ffffff';ctx.fillRect(-4,top?-5:1,5,2);ctx.restore();};
    shell(-open*5,true);shell(open*3,false);if(!open){ctx.fillStyle='#172036';ctx.fillRect(-8,-1,16,3);ctx.fillRect(-3,-3,6,7);ctx.fillStyle='#e8e9df';ctx.fillRect(-2,-2,4,5);ctx.fillStyle='#afc4cd';ctx.fillRect(-1,-1,2,2);}ctx.restore();
  }
  drawDeployment(f,pos,now) {
    const d=f.deployment;if(!d)return;const ctx=this.ctx,record=this.getCharacter(f),elapsed=d.elapsed+clamp((now-this.lastSnapshot)/1000,0,.06);
    if(d.phase==='ball'){const t=clamp(elapsed/(d.ballDuration||.55),0,1),origin=record.deploymentOrigin||{x:pos.x+(f.team?120:-120),y:pos.y+70},x=mix(origin.x,pos.x,t),groundY=mix(origin.y,pos.y,t),y=groundY-Math.sin(t*Math.PI)*75-5;
      ctx.save();ctx.fillStyle='#10223655';ctx.beginPath();ctx.ellipse(x,groundY,7-3*Math.sin(t*Math.PI),3,0,0,TAU);ctx.fill();ctx.restore();this.drawPixelBall(x,y,t*TAU*1.5);for(let i=1;i<=3;i++){const pt=Math.max(0,t-i*.018);this.drawPixelBall(mix(origin.x,pos.x,pt),mix(origin.y,pos.y,pt)-Math.sin(pt*Math.PI)*75-5,pt*TAU*1.5,0,.055*(4-i));}
    }else{const t=clamp(elapsed/(d.releaseDuration||.5),0,1);ctx.save();ctx.translate(pos.x,pos.y-12);ctx.globalCompositeOperation='lighter';const glow=ctx.createRadialGradient(0,0,1,0,0,44*(1-t)+15);glow.addColorStop(0,`rgba(255,255,235,${(1-t)*.8})`);glow.addColorStop(1,'rgba(143,213,255,0)');ctx.fillStyle=glow;ctx.fillRect(-65,-65,130,130);ctx.strokeStyle=`rgba(200,233,255,${(1-t)*.9})`;ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,8,12+t*40,5+t*18,0,0,TAU);ctx.stroke();for(let i=0;i<8;i++){const a=i*TAU/8,r=10+t*45;ctx.fillStyle=`rgba(255,249,194,${1-t})`;ctx.fillRect(Math.cos(a)*r-1,Math.sin(a)*r*.65-1,2,2);}ctx.restore();this.drawPixelBall(pos.x,pos.y+2,0,Math.sin(t*Math.PI),1-t);}
  }
  drawRecalls(dt) {
    const ctx=this.ctx;for(let i=this.recalls.length-1;i>=0;i--){const r=this.recalls[i];r.life-=dt;if(r.life<=0){this.recalls.splice(i,1);continue;}const t=1-r.life/r.max,entry=this.manifest[r.species],animation=animationFor(entry,'idle'),image=animation&&this.loadImage(animation.data.src),metrics=entry&&this.measureSpecies(r.species,entry);ctx.save();ctx.translate(r.x,r.y);ctx.globalAlpha=1-t;ctx.filter='sepia(1) saturate(5) hue-rotate(310deg) brightness(1.6)';ctx.scale(1-t*.88,1-t*.88);if(image&&metrics){const a=animation.data,row=a.directions===1?0:directionRow(r.facing.x,r.facing.y),anchor=a.anchors?.[row]?.[0]||[a.frameWidth/2,a.frameHeight/2+4];ctx.scale(metrics.scale,metrics.scale);ctx.drawImage(image,0,row*a.frameHeight,a.frameWidth,a.frameHeight,-anchor[0],-anchor[1],a.frameWidth,a.frameHeight);}ctx.restore();ctx.save();ctx.strokeStyle=`rgba(255,123,146,${1-t})`;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(r.x,r.y-15);ctx.lineTo(r.x-85*t,r.y+45*t);ctx.stroke();ctx.restore();this.drawPixelBall(r.x-85*t,r.y+45*t,0,0,1-t);}
  }

  drawWindup(pos,action,progress,now) {
    const ctx=this.ctx,dir=action.direction||{x:1,y:0},c=tint(action.type),radius=4+progress*10;
    ctx.save();ctx.translate(pos.x,pos.y-12);ctx.strokeStyle=c;ctx.globalAlpha=.35+progress*.5;ctx.lineWidth=1.4;
    if(action.move==='fireblast'){
      ctx.translate(dir.x*17,dir.y*17);ctx.rotate(now*.002);ctx.globalCompositeOperation='lighter';ctx.shadowColor='#ff6d31';ctx.shadowBlur=15;
      for(let i=0;i<5;i++){const a=i*TAU/5-Math.PI/2,orbit=9+progress*9;ctx.fillStyle=i%2?'#ffc653':'#ff5b29';ctx.beginPath();ctx.arc(Math.cos(a)*orbit,Math.sin(a)*orbit,3+progress*2,0,TAU);ctx.fill();}
      ctx.strokeStyle='#ffe49a';ctx.lineWidth=1.7;ctx.beginPath();for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,r=i%2?4+progress*5:13+progress*8;ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);}ctx.closePath();ctx.stroke();
    }else if(action.move==='willowisp'){
      ctx.translate(dir.x*15,dir.y*15);ctx.globalCompositeOperation='lighter';ctx.shadowColor='#a092ff';ctx.shadowBlur=12;
      for(let i=0;i<3;i++){const a=now*.005+i*TAU/3,r=8+progress*3;ctx.fillStyle=i%2?'#7e69ec':'#c7b9ff';ctx.beginPath();ctx.ellipse(Math.cos(a)*r,Math.sin(a)*r*.65,3,6,a,0,TAU);ctx.fill();}
    }else if(['volttackle','wildcharge'].includes(action.move)){
      ctx.translate(dir.x*18,dir.y*18);ctx.rotate(Math.atan2(dir.y,dir.x));ctx.globalCompositeOperation='lighter';ctx.strokeStyle='#ffe96c';ctx.shadowColor='#57d9ff';ctx.shadowBlur=12;ctx.lineWidth=2;
      for(let i=0;i<3;i++){ctx.beginPath();ctx.moveTo(-7,-7+i*7);ctx.lineTo(-1,-12+i*7);ctx.lineTo(3,-2+i*7);ctx.lineTo(9,-8+i*7);ctx.stroke();}
    }else if(action.move==='bodyslam'){
      ctx.translate(dir.x*22,dir.y*22);ctx.strokeStyle='#fff0c8';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,5,9+progress*16,3+progress*4,0,0,TAU);ctx.stroke();ctx.beginPath();ctx.moveTo(-10,-2);ctx.lineTo(-7,-8-progress*5);ctx.moveTo(10,-2);ctx.lineTo(7,-8-progress*5);ctx.stroke();
    }else if(action.kind==='melee'){ctx.translate(dir.x*22,dir.y*22);ctx.rotate(Math.atan2(dir.y,dir.x));ctx.beginPath();ctx.arc(0,0,11+progress*5,-1,1);ctx.stroke();}
    else{ctx.translate(dir.x*17,dir.y*17);ctx.shadowColor=c;ctx.shadowBlur=14;ctx.fillStyle=c+'88';ctx.beginPath();ctx.arc(0,0,radius,0,TAU);ctx.fill();ctx.stroke();for(let i=0;i<4;i++){const a=now*.006+i*TAU/4,r=18-progress*7;ctx.fillStyle='#ffffff';ctx.fillRect(Math.cos(a)*r-1,Math.sin(a)*r-1,2,2);}}
    ctx.restore();
  }

  drawStatus(f,pos,now) {
    if(!f.status||f.hp<=0)return;
    const ctx=this.ctx,phase=now/1000;
    ctx.save();ctx.translate(pos.x,pos.y);
    if(f.status==='frz'){
      const gradient=ctx.createLinearGradient(-20,-46,24,6);gradient.addColorStop(0,'#c8f9ff9c');gradient.addColorStop(.35,'#76bfe047');gradient.addColorStop(1,'#3b8fcd88');ctx.fillStyle=gradient;ctx.strokeStyle='#b9f4ff';ctx.lineWidth=1.6;
      ctx.beginPath();ctx.moveTo(-23,-2);ctx.lineTo(-25,-24);ctx.lineTo(-13,-42);ctx.lineTo(5,-49);ctx.lineTo(23,-31);ctx.lineTo(25,-4);ctx.lineTo(10,7);ctx.lineTo(-12,7);ctx.closePath();ctx.fill();ctx.stroke();
      ctx.strokeStyle='#e2ffffaa';ctx.lineWidth=.8;ctx.beginPath();ctx.moveTo(-13,-42);ctx.lineTo(-7,-17);ctx.lineTo(-23,-2);ctx.moveTo(5,-49);ctx.lineTo(10,-21);ctx.lineTo(25,-4);ctx.moveTo(-7,-17);ctx.lineTo(10,-21);ctx.lineTo(10,7);ctx.stroke();
      for(let i=0;i<3;i++){const x=Math.sin(phase*.7+i*2)*32,y=-15-Math.cos(phase*.8+i*2)*33;ctx.fillStyle='#d6fbffbb';ctx.fillRect(x,y,2,2);}
    }else if(f.status==='brn'){
      for(let i=0;i<4;i++){const t=(phase*.8+i*.23)%1,x=Math.sin(i*2.4+phase)*17,y=3-t*39;ctx.globalAlpha=1-t;ctx.fillStyle=i%2?'#ffca72':'#ff7c4d';ctx.beginPath();ctx.moveTo(x,y-6);ctx.quadraticCurveTo(x+6,y+5,x,y+6);ctx.quadraticCurveTo(x-5,y+4,x,y-6);ctx.fill();}
    }else if(f.status==='par'){
      ctx.strokeStyle='#ffe968';ctx.shadowColor='#ffd74b';ctx.shadowBlur=8;ctx.lineWidth=1.6;
      if(Math.floor(phase*7)%5<3)for(let side=-1;side<=1;side+=2){ctx.beginPath();ctx.moveTo(side*19,-36);ctx.lineTo(side*26,-27);ctx.lineTo(side*18,-18);ctx.lineTo(side*27,-8);ctx.stroke();}
    }else if(f.status==='psn'||f.status==='tox'){
      for(let i=0;i<4;i++){const t=(phase*.55+i*.24)%1,x=Math.sin(i*2.1+phase*.5)*22,y=6-t*42;ctx.globalAlpha=(1-t)*.7;ctx.fillStyle='#b982d6';ctx.strokeStyle='#e4b3f7';ctx.lineWidth=.7;ctx.beginPath();ctx.arc(x,y,2+t*3,0,TAU);ctx.fill();ctx.stroke();}
    }else if(f.status==='slp'){
      ctx.fillStyle='#d6e5f5';ctx.font='700 10px Barlow,sans-serif';ctx.globalAlpha=.7;ctx.fillText('z',13,-32-(phase*9)%13);ctx.font='700 7px Barlow,sans-serif';ctx.fillText('z',21,-43-(phase*6)%9);
    }
    ctx.restore();
  }

  drawProjectile(p,now,dt) {
    const ctx=this.ctx,type=p.type||this.moves(p.move)?.type||'Normal',c=tint(type),angle=Math.atan2(p.vy||0,p.vx||1),r=clamp(p.move==='fireblast'?17:p.move==='willowisp'?9:p.radius||9,5,22);
    const age=clamp((now-this.lastSnapshot)/1000,0,.05),x=p.x+(p.vx||0)*age,y=p.y+(p.vy||0)*age-12;
    const emission=this.emissions.get(p.actionId);
    const beamMoves=['hydropump','watergun','flamethrower','icebeam','thunderbolt','hyperbeam','solarbeam','gigadrain','megadrain','absorb','chargebeam'];
    if(emission&&beamMoves.includes(p.move)&&now-emission.at<650){
      const dx=x-emission.x,dy=y-emission.y,length=Math.hypot(dx,dy)||1,normal={x:-dy/length,y:dx/length};
      ctx.save();ctx.globalCompositeOperation='lighter';ctx.lineCap='round';ctx.lineJoin='round';ctx.shadowColor=c;ctx.shadowBlur=p.move==='flamethrower'?18:12;
      const ribbon=(color,width,wobble,frequency)=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(emission.x,emission.y);for(let i=1;i<=16;i++){const t=i/16,wave=Math.sin(i*frequency+now*.025)*wobble*Math.sin(t*Math.PI);ctx.lineTo(emission.x+dx*t+normal.x*wave,emission.y+dy*t+normal.y*wave);}ctx.stroke();};
      if(p.move==='flamethrower'){
        ribbon('#ec3d20aa',18,7,2.8);ribbon('#ff7b28',11,5,3.7);ribbon('#ffc45d',6,3,5.4);ribbon('#fff4c2',2,1.3,6.2);
        for(let i=0;i<7;i++){const t=(i/7+(now/260)%1)%1;this.particles.push({x:emission.x+dx*t+normal.x*Math.sin(now*.02+i)*5,y:emission.y+dy*t+normal.y*Math.sin(now*.02+i)*5,vx:normal.x*(Math.random()-.5)*65,vy:normal.y*(Math.random()-.5)*65,life:.12,max:.12,type:'Fire',size:1+Math.random()*2});}
      }else if(p.move==='hydropump'){
        ribbon('#1b8dff66',20,4,2);ribbon('#4ccfff',13,3,3);ribbon('#c7fbff',5,1.5,4);for(let i=0;i<4;i++){const t=(i/4+(now/180)%1)%1;ctx.fillStyle='#d9fbff';ctx.globalAlpha=.75;ctx.beginPath();ctx.arc(emission.x+dx*t+normal.x*Math.sin(now*.02+i)*9,emission.y+dy*t+normal.y*Math.sin(now*.02+i)*9,2,0,TAU);ctx.fill();}ctx.globalAlpha=1;
      }else if(p.move==='solarbeam'){
        ribbon('#2a9a45aa',21,3,2.4);ribbon('#7df36a',13,2.5,3.2);ribbon('#dbff9a',6,1.2,4.6);ribbon('#fffbd2',2,1,5.4);
        for(let i=0;i<8;i++){const t=(i/8+(now/320)%1)%1;ctx.fillStyle=i%2?'#ffffc0':'#8bff7d';ctx.globalAlpha=.8;ctx.beginPath();ctx.arc(emission.x+dx*t+normal.x*Math.sin(now*.015+i)*5,emission.y+dy*t+normal.y*Math.sin(now*.015+i)*5,2+(i%2),0,TAU);ctx.fill();}ctx.globalAlpha=1;
      }else if(p.move==='icebeam'){
        ribbon('#3c9be888',15,3.5,3.5);ribbon('#93ebff',9,2.5,4.5);ribbon('#efffff',3,1.2,6);
        for(let i=0;i<8;i++){const t=(i/8+(now/250)%1)%1,xx=emission.x+dx*t,yy=emission.y+dy*t,side=Math.sin(i*9+now*.02)*7;ctx.save();ctx.translate(xx+normal.x*side,yy+normal.y*side);ctx.rotate(Math.atan2(dy,dx)+(i%2?1:-1)*.45);ctx.fillStyle=i%2?'#b7f4ff':'#f3ffff';ctx.strokeStyle='#66c1e7';ctx.lineWidth=.8;ctx.beginPath();ctx.moveTo(0,-4);ctx.lineTo(3,0);ctx.lineTo(0,5);ctx.lineTo(-2,1);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();}
      }else if(p.move==='hyperbeam'){
        ribbon('#b733e988',24,3,2);ribbon('#ed79ff',16,2,3.3);ribbon('#fff1ff',7,1,5);ribbon('#ffffff',2,0.6,7);
        ctx.strokeStyle='#ffd7ff';ctx.lineWidth=1.6;for(let side=-1;side<=1;side+=2){ctx.beginPath();ctx.moveTo(emission.x+normal.x*side*12,emission.y+normal.y*side*12);ctx.lineTo(x+normal.x*side*12,y+normal.y*side*12);ctx.stroke();}
      }else if(p.move==='thunderbolt'){
        ribbon('#4fc8ff99',14,6,7);ribbon('#ffe85a',8,5,8.4);ribbon('#fffde0',2.4,3.2,10);
        for(let i=0;i<5;i++){const t=(i/5+(now/220)%1)%1,xx=emission.x+dx*t,yy=emission.y+dy*t;ctx.strokeStyle='#e7ffff';ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(xx,yy);ctx.lineTo(xx+normal.x*9+Math.sin(now*.03+i)*4,yy+normal.y*9-5);ctx.stroke();}
      }else if(['absorb','megadrain','gigadrain'].includes(p.move)){
        ribbon('#186b32bb',13,5,3);ribbon('#55db74',7,4,4.8);ribbon('#caffb1',2,1.5,6);
        for(let i=0;i<8;i++){const t=(i/8+(now/300)%1)%1,xx=emission.x+dx*t,yy=emission.y+dy*t;ctx.save();ctx.translate(xx+normal.x*Math.sin(i*2+now*.015)*6,yy+normal.y*Math.sin(i*2+now*.015)*6);ctx.rotate(now*.01+i);ctx.fillStyle=i%2?'#d3ff9c':'#6be18a';ctx.beginPath();ctx.moveTo(-3,0);ctx.quadraticCurveTo(0,-5,4,0);ctx.quadraticCurveTo(0,3,-3,0);ctx.fill();ctx.restore();}
      }else if(p.move==='chargebeam'){
        ribbon('#4acfff77',11,4,6);ribbon('#ffe663',6,4,8);ribbon('#fffde1',2,2,10);
      }else{
        ctx.strokeStyle=c+'88';ctx.lineWidth=p.move==='hydropump'?12:type==='Fire'?10:5;
        ctx.beginPath();ctx.moveTo(emission.x,emission.y);for(let i=1;i<=12;i++){const t=i/12,wave=(type==='Electric'?Math.sin(i*9+now*.08)*4:Math.sin(i*2+now*.03)*2)*Math.sin(t*Math.PI);ctx.lineTo(emission.x+dx*t+normal.x*wave,emission.y+dy*t+normal.y*wave);}ctx.stroke();ctx.strokeStyle=type==='Water'?'#c6f8ffcc':'#fff9dfbb';ctx.lineWidth=type==='Water'?3:1.8;ctx.stroke();
      }ctx.restore();
    }
    ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.globalCompositeOperation='lighter';ctx.shadowColor=c;ctx.shadowBlur=15;
    if(p.move==='fireblast'){
      const pulse=.88+.18*Math.sin(now*.025);ctx.rotate(now*.004);for(let i=0;i<7;i++){const a=i*TAU/7+now*.001,radius=r*(1.25+(i%2)*.22);ctx.fillStyle=i%2?'#ff5a23':'#ffd15b';ctx.globalAlpha=.48;ctx.beginPath();ctx.ellipse(Math.cos(a)*radius,Math.sin(a)*radius*.72,3,6,a,0,TAU);ctx.fill();}ctx.globalAlpha=1;
      const points=[];for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,rr=(i%2?r*.55:r*1.42)*pulse;points.push([Math.cos(a)*rr,Math.sin(a)*rr]);}ctx.beginPath();points.forEach(([px,py],i)=>i?ctx.lineTo(px,py):ctx.moveTo(px,py));ctx.closePath();ctx.fillStyle='#ff612b';ctx.fill();ctx.strokeStyle='#ffe16c';ctx.lineWidth=2;ctx.stroke();
      const core=ctx.createRadialGradient(-2,-3,1,0,0,r);core.addColorStop(0,'#fffbd3');core.addColorStop(.32,'#ffdd69');core.addColorStop(.72,'#ff7b2f');core.addColorStop(1,'#b52c48');ctx.fillStyle=core;ctx.beginPath();ctx.arc(0,0,r*.72,0,TAU);ctx.fill();ctx.strokeStyle='#fff5bc';ctx.lineWidth=1.4;ctx.beginPath();ctx.arc(0,0,r*.42,0,TAU);ctx.stroke();
    }else if(p.move==='willowisp'){
      ctx.rotate(Math.sin(now*.008+p.x)*.18);for(let i=0;i<3;i++){const side=i-1,phase=now*.01+i*2.1;ctx.globalAlpha=.7;ctx.fillStyle=i===1?'#b3a5ff':'#6857d9';ctx.beginPath();ctx.moveTo(-r*.6,side*2);ctx.quadraticCurveTo(-r*1.5+Math.sin(phase)*3,side*r,-r*.4+Math.cos(phase)*4,side*r*1.2);ctx.quadraticCurveTo(r*.2,side*r*.4,r*.35,side*1.5);ctx.quadraticCurveTo(-r*.1,side*2,-r*.6,side*2);ctx.fill();}ctx.globalAlpha=1;
      const core=ctx.createRadialGradient(-2,-3,1,0,0,r*1.35);core.addColorStop(0,'#ffffff');core.addColorStop(.27,'#e4ddff');core.addColorStop(.58,'#9d83ff');core.addColorStop(1,'#5444b900');ctx.fillStyle=core;ctx.beginPath();ctx.arc(0,0,r*1.4,0,TAU);ctx.fill();ctx.strokeStyle='#d8ceff';ctx.lineWidth=1.4;ctx.beginPath();ctx.ellipse(0,0,r*1.1,r*.78,Math.sin(now*.006)*.5,0,TAU);ctx.stroke();for(let i=0;i<3;i++){const a=now*.012+i*TAU/3,orbit=r*1.8;ctx.fillStyle='#c5baff';ctx.beginPath();ctx.arc(Math.cos(a)*orbit,Math.sin(a)*orbit*.65,1.5,0,TAU);ctx.fill();}
    }else if(p.move==='shadowball'){
      const core=ctx.createRadialGradient(-r*.3,-r*.35,1,0,0,r*1.6);core.addColorStop(0,'#f0dcff');core.addColorStop(.25,'#a67be8');core.addColorStop(.62,'#51357c');core.addColorStop(1,'#241c4500');ctx.fillStyle=core;ctx.beginPath();ctx.arc(0,0,r*1.65,0,TAU);ctx.fill();ctx.strokeStyle='#d9b4ff';ctx.lineWidth=1.5;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(1.25+i*.18),r*(.7+i*.1),now*.008+i,0,TAU);ctx.stroke();}for(let i=0;i<5;i++){const a=now*.006+i*TAU/5;ctx.fillStyle='#392651';ctx.fillRect(Math.cos(a)*r*1.45-2,Math.sin(a)*r*1.1-2,4,4);}
    }else if(['rockthrow','rockslide'].includes(p.move)){
      ctx.rotate(now*.008);ctx.fillStyle='#8c7863';ctx.strokeStyle='#e2ceb0';ctx.lineWidth=1.6;ctx.beginPath();ctx.moveTo(-r*1.2,-r*.35);ctx.lineTo(-r*.65,-r*1.05);ctx.lineTo(r*.28,-r*.92);ctx.lineTo(r*1.15,-r*.28);ctx.lineTo(r*.72,r*.72);ctx.lineTo(-r*.28,r*1.05);ctx.lineTo(-r*1.1,r*.45);ctx.closePath();ctx.fill();ctx.stroke();
      ctx.fillStyle='#c9b497';ctx.beginPath();ctx.moveTo(-r*.65,-r*1.05);ctx.lineTo(r*.28,-r*.92);ctx.lineTo(r*.08,-r*.05);ctx.lineTo(-r*1.2,-r*.35);ctx.closePath();ctx.fill();ctx.fillStyle='#5c514a';ctx.beginPath();ctx.moveTo(r*.08,-r*.05);ctx.lineTo(r*1.15,-r*.28);ctx.lineTo(r*.72,r*.72);ctx.lineTo(-r*.1,r*.44);ctx.closePath();ctx.fill();
      if(p.move==='rockslide')for(let i=0;i<3;i++){const a=now*.006+i*TAU/3,orbit=r*1.5;ctx.save();ctx.translate(Math.cos(a)*orbit,Math.sin(a)*orbit*.7);ctx.rotate(-a);ctx.fillStyle=i%2?'#d1bea0':'#776759';ctx.fillRect(-2,-3,5,6);ctx.restore();}
    }else if(p.move==='stoneedge'){
      ctx.rotate(now*.006);ctx.fillStyle='#9bd6e8';ctx.strokeStyle='#ecffff';ctx.lineWidth=1.7;ctx.beginPath();ctx.moveTo(r*1.8,0);ctx.lineTo(r*.05,-r*.48);ctx.lineTo(-r*1.1,-r*1.25);ctx.lineTo(-r*.78,-r*.08);ctx.lineTo(-r*1.25,r*.8);ctx.lineTo(r*.1,r*.42);ctx.closePath();ctx.fill();ctx.stroke();ctx.fillStyle='#4e95b8';ctx.beginPath();ctx.moveTo(r*.05,-r*.48);ctx.lineTo(r*1.8,0);ctx.lineTo(r*.1,r*.42);ctx.closePath();ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(-r*1.1,-r*1.25);ctx.lineTo(r*.05,-r*.48);ctx.lineTo(-r*.78,-r*.08);ctx.stroke();
    }else if(p.move==='earthpower'){
      const pulse=.8+.2*Math.sin(now*.012);ctx.fillStyle='#b48b5c';ctx.strokeStyle='#f0d29b';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(0,0,r*1.1*pulse,0,TAU);ctx.fill();ctx.stroke();ctx.fillStyle='#604a38';for(let i=0;i<4;i++){const a=i*TAU/4+now*.006,xx=Math.cos(a)*r*1.15,yy=Math.sin(a)*r*.8;ctx.save();ctx.translate(xx,yy);ctx.rotate(a);ctx.beginPath();ctx.moveTo(-3,-2);ctx.lineTo(1,-6);ctx.lineTo(4,1);ctx.lineTo(-1,4);ctx.closePath();ctx.fill();ctx.restore();}ctx.strokeStyle='#d4ffad';ctx.lineWidth=1.3;ctx.beginPath();ctx.arc(0,0,r*.55,-.8,1.1);ctx.stroke();
    }else if(p.move==='thunder'){
      ctx.rotate(now*.004);ctx.fillStyle='#ffe85a';ctx.strokeStyle='#fffce4';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(r*.1,-r*1.7);ctx.lineTo(r*.62,-r*.35);ctx.lineTo(r*.16,-r*.25);ctx.lineTo(r*.42,r*1.3);ctx.lineTo(-r*.7,r*.05);ctx.lineTo(-r*.22,-r*.12);ctx.closePath();ctx.fill();ctx.stroke();ctx.strokeStyle='#63dfff';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(-r*.95,-r*.8);ctx.lineTo(-r*.45,-r*.32);ctx.lineTo(-r*.72,r*.2);ctx.moveTo(r*.8,-r*.6);ctx.lineTo(r*.35,-r*.05);ctx.lineTo(r*.85,r*.35);ctx.stroke();
    }else if(p.move==='zapcannon'){
      const grad=ctx.createRadialGradient(-r*.3,-r*.25,1,0,0,r*1.6);grad.addColorStop(0,'#fffde8');grad.addColorStop(.28,'#ffe55a');grad.addColorStop(.7,'#3ecaff');grad.addColorStop(1,'#3ecaff00');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*1.45,0,TAU);ctx.fill();ctx.strokeStyle='#fff4a6';ctx.lineWidth=2;for(let i=0;i<4;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.8+i*.13),r*(.55+i*.1),now*.01+i,0,TAU);ctx.stroke();}for(let i=0;i<6;i++){const a=i*TAU/6+now*.008;ctx.beginPath();ctx.moveTo(Math.cos(a)*r*.6,Math.sin(a)*r*.5);ctx.lineTo(Math.cos(a+.17)*r*1.4,Math.sin(a+.17)*r*1.1);ctx.stroke();}
    }else if(['psychic','psybeam','confusion','psyshock','extrasensory'].includes(p.move)){
      if(p.move==='psybeam'){const colors=['#ff5f93','#ffc66a','#c7ff83','#75e6ff','#aa92ff'];for(let i=0;i<5;i++){ctx.strokeStyle=colors[i];ctx.lineWidth=2.5;ctx.beginPath();ctx.arc(0,0,r*(.55+i*.18),-1.6+i*.16,1.3+i*.16);ctx.stroke();}}
      const grad=ctx.createRadialGradient(-r*.3,-r*.3,1,0,0,r*1.55);grad.addColorStop(0,'#fff4ff');grad.addColorStop(.28,'#f4a7ff');grad.addColorStop(.62,'#a967e5');grad.addColorStop(1,'#753bb000');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*(p.move==='psybeam'?1.12:1.4),0,TAU);ctx.fill();ctx.strokeStyle='#f8d3ff';ctx.lineWidth=1.5;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.85+i*.2),r*(.5+i*.13),now*.009+i,0,TAU);ctx.stroke();}if(p.move==='confusion'){ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(0,0,r*.22,0,TAU);ctx.fill();}
    }else if(['sludge','sludgebomb','acid'].includes(p.move)){
      ctx.rotate(Math.sin(now*.009)*.18);const grad=ctx.createRadialGradient(-r*.2,-r*.2,1,0,0,r*1.35);grad.addColorStop(0,'#e8ffb0');grad.addColorStop(.22,'#a4d950');grad.addColorStop(.64,'#6e409b');grad.addColorStop(1,'#42235200');ctx.fillStyle=grad;ctx.beginPath();ctx.ellipse(0,0,r*(p.move==='sludgebomb'?1.3:1),r*.9,0,0,TAU);ctx.fill();ctx.strokeStyle='#d4ff93';ctx.lineWidth=1.2;for(let i=0;i<5;i++){const a=i*TAU/5+now*.004;ctx.beginPath();ctx.arc(Math.cos(a)*r*.9,Math.sin(a)*r*.65,1.4+(i%2),0,TAU);ctx.stroke();}for(let i=0;i<3;i++){ctx.fillStyle='#b2e75d';ctx.beginPath();ctx.arc(Math.cos(now*.004+i*2)*r*.7,Math.sin(now*.005+i*2)*r*.6,1.5,0,TAU);ctx.fill();}
    }else if(['bubblebeam','waterpulse'].includes(p.move)){
      ctx.globalAlpha=.92;for(let i=0;i<6;i++){const a=i*TAU/6+now*.004,orbit=r*(.45+(i%3)*.3);ctx.fillStyle=i%2?'#6bd5ff':'#e4fbff';ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.beginPath();ctx.arc(Math.cos(a)*orbit,Math.sin(a)*orbit*.7,2+i%3,0,TAU);ctx.fill();ctx.stroke();}ctx.strokeStyle='#8ae5ff';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,0,r*1.2,r*.68,now*.008,0,TAU);ctx.stroke();
    }else if(['energyball','gigadrain','leafstorm'].includes(p.move)){
      ctx.rotate(now*.007);const grad=ctx.createRadialGradient(-r*.3,-r*.3,1,0,0,r*1.5);grad.addColorStop(0,'#edffd5');grad.addColorStop(.26,'#8dfa65');grad.addColorStop(.68,'#2f9a4c');grad.addColorStop(1,'#17462700');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*1.35,0,TAU);ctx.fill();for(let i=0;i<5;i++){const a=i*TAU/5,xx=Math.cos(a)*r*.95,yy=Math.sin(a)*r*.65;ctx.save();ctx.translate(xx,yy);ctx.rotate(a);ctx.fillStyle=i%2?'#d0ff91':'#61db63';ctx.beginPath();ctx.moveTo(-r*.28,0);ctx.quadraticCurveTo(0,-r*.5,r*.38,0);ctx.quadraticCurveTo(0,r*.25,-r*.28,0);ctx.fill();ctx.strokeStyle='#eaffc7';ctx.lineWidth=.7;ctx.beginPath();ctx.moveTo(-r*.25,0);ctx.lineTo(r*.28,0);ctx.stroke();ctx.restore();}ctx.strokeStyle='#ddffc0';ctx.lineWidth=1.3;ctx.beginPath();ctx.ellipse(0,0,r*1.15,r*.48,now*.012,0,TAU);ctx.stroke();
    }else if(p.move==='dracometeor'){
      ctx.rotate(now*.003);ctx.fillStyle='#ff6e47';ctx.beginPath();ctx.moveTo(r*1.6,0);ctx.lineTo(-r*.5,-r*.8);ctx.lineTo(-r*1.7,-r*.35);ctx.lineTo(-r*.9,0);ctx.lineTo(-r*1.5,r*.6);ctx.lineTo(-r*.2,r*.55);ctx.closePath();ctx.fill();ctx.fillStyle='#ffd36b';ctx.beginPath();ctx.arc(r*.3,0,r*.55,0,TAU);ctx.fill();ctx.strokeStyle='#ffb58b';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-r*1.6,0);ctx.lineTo(-r*2.8,-r*.45);ctx.moveTo(-r*1.5,r*.2);ctx.lineTo(-r*2.7,r*.55);ctx.stroke();
    }else if(p.move==='dragonpulse'){
      const grad=ctx.createRadialGradient(0,0,1,0,0,r*1.3);grad.addColorStop(0,'#e7f6ff');grad.addColorStop(.25,'#83d4fa');grad.addColorStop(.58,'#587fe6');grad.addColorStop(1,'#3b5dcc00');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*1.25,0,TAU);ctx.fill();ctx.strokeStyle='#b8e6ff';ctx.lineWidth=2;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.65+i*.3),r*(.36+i*.18),now*.01+i*1.4,0,TAU);ctx.stroke();}
    }else if(['moonblast','dazzlinggleam'].includes(p.move)){
      const grad=ctx.createRadialGradient(-r*.25,-r*.25,1,0,0,r*1.5);grad.addColorStop(0,'#fff');grad.addColorStop(.3,'#ffe1fa');grad.addColorStop(.65,'#f38ddb');grad.addColorStop(1,'#bd6fe300');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*1.35,0,TAU);ctx.fill();ctx.strokeStyle='#fff0ff';ctx.lineWidth=1.4;for(let i=0;i<6;i++){const a=i*TAU/6+now*.003;ctx.save();ctx.translate(Math.cos(a)*r,Math.sin(a)*r*.6);ctx.rotate(a);ctx.fillStyle=i%2?'#ff9ee8':'#fff';ctx.beginPath();for(let j=0;j<8;j++){const theta=-Math.PI/2+j*Math.PI/4,rr=j%2?1.8:4.5;ctx.lineTo(Math.cos(theta)*rr,Math.sin(theta)*rr);}ctx.closePath();ctx.fill();ctx.restore();}
    }else if(['blizzard','frostbreath','icywind','powdersnow'].includes(p.move)){
      ctx.rotate(now*.01);ctx.strokeStyle='#dcfcff';ctx.lineWidth=1.6;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.5+i*.35),r*(.4+i*.2),now*.01+i,0,TAU);ctx.stroke();}for(let i=0;i<7;i++){const a=i*TAU/7+now*.002;ctx.fillStyle=i%2?'#77caed':'#efffff';ctx.beginPath();ctx.moveTo(Math.cos(a)*r*1.2,Math.sin(a)*r*.8);ctx.lineTo(Math.cos(a+.2)*r*.25,Math.sin(a+.2)*r*.18);ctx.lineTo(Math.cos(a-.18)*r*.8,Math.sin(a-.18)*r*.5);ctx.closePath();ctx.fill();}
    }else if(p.move==='flashcannon'){
      const grad=ctx.createRadialGradient(-r*.2,-r*.2,1,0,0,r*1.5);grad.addColorStop(0,'#fff');grad.addColorStop(.3,'#d9f6ff');grad.addColorStop(.62,'#799ca9');grad.addColorStop(1,'#47616b00');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*1.3,0,TAU);ctx.fill();ctx.strokeStyle='#f2ffff';ctx.lineWidth=2;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.85+i*.25),r*(.42+i*.16),now*.005+i,0,TAU);ctx.stroke();}
    }else if(['aircutter','gust','hurricane','twister'].includes(p.move)){
      ctx.rotate(now*.008);ctx.strokeStyle=p.move==='hurricane'?'#d7ecff':'#ecf7ff';ctx.lineWidth=2.4;for(let i=0;i<4;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.45+i*.28),r*(.25+i*.2),now*.012+i*.5,.15,Math.PI*1.8);ctx.stroke();}if(p.move==='aircutter'){ctx.beginPath();ctx.moveTo(-r*1.5,-r*.3);ctx.quadraticCurveTo(0,-r*1.3,r*1.4,0);ctx.quadraticCurveTo(0,r*.35,-r*1.5,-r*.3);ctx.stroke();}
    }else if(['spore','sleeppowder','stunspore','poisonpowder','poisongas','toxic'].includes(p.move)){
      const poison=['poisonpowder','poisongas','toxic'].includes(p.move),electric=p.move==='stunspore',sleep=p.move==='spore'||p.move==='sleeppowder';ctx.rotate(Math.sin(now*.006)*.12);
      const palette=poison?['#d7a5ff','#8a4fb4','#44245f']:electric?['#faff9d','#b8df4b','#70a743']:sleep?['#eeffbb','#8bdc7b','#4da879']:['#d6ffa4','#9ae45b','#5b953d'];
      const cloud=ctx.createRadialGradient(0,0,1,0,0,r*1.8);cloud.addColorStop(0,palette[0]);cloud.addColorStop(.35,palette[1]+'bb');cloud.addColorStop(1,palette[2]+'00');ctx.fillStyle=cloud;ctx.beginPath();ctx.arc(0,0,r*1.7,0,TAU);ctx.fill();
      for(let i=0;i<11;i++){const a=i*TAU/11+now*.002,rr=r*(.35+(i%4)*.22),xx=Math.cos(a)*rr,yy=Math.sin(a)*rr*.63;ctx.fillStyle=i%3===0?'#fff5d5':palette[i%palette.length];ctx.strokeStyle=palette[0];ctx.lineWidth=.7;ctx.beginPath();ctx.ellipse(xx,yy,1.4+(i%2),2+(i%3),a,0,TAU);ctx.fill();ctx.stroke();}
      if(p.move==='toxic'||p.move==='poisongas'){ctx.strokeStyle='#d7a5ff';ctx.lineWidth=1.4;for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(Math.cos(now*.004+i)*r*.5,Math.sin(now*.005+i)*r*.35,2+i,0,TAU);ctx.stroke();}}
    }else if(p.move==='thunderwave'){
      ctx.globalCompositeOperation='lighter';ctx.strokeStyle='#fff1a0';ctx.lineWidth=2.3;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.6+i*.27),r*(.4+i*.18),now*.01+i,0,TAU);ctx.stroke();}ctx.beginPath();ctx.moveTo(-r,-r*.6);ctx.lineTo(-r*.15,-r*.05);ctx.lineTo(-r*.55,r*.2);ctx.lineTo(r*.3,r*.75);ctx.lineTo(r*.1,r*.2);ctx.lineTo(r*.8,-r*.35);ctx.stroke();
    }else if(['hypnosis','sing','growl','screech','metalsound'].includes(p.move)){
      ctx.globalCompositeOperation='lighter';const color=p.move==='metalsound'?'#d8f4ff':p.move==='hypnosis'?'#d4a6ff':'#fff1c8';ctx.strokeStyle=color;ctx.lineWidth=2;for(let i=0;i<4;i++){const radius=r*(.45+i*.32);ctx.beginPath();ctx.ellipse(0,0,radius,radius*.58,Math.sin(now*.005+i)*.3,-1.7,1.65);ctx.stroke();}
      if(p.move==='hypnosis'){ctx.strokeStyle='#fff';ctx.lineWidth=2.4;ctx.beginPath();ctx.moveTo(-r*.55,0);ctx.bezierCurveTo(-r*.15,-r*.85,r*.55,-r*.65,r*.15,0);ctx.bezierCurveTo(-r*.35,r*.65,r*.2,r*.9,r*.55,r*.1);ctx.stroke();}
      if(p.move==='metalsound'){ctx.fillStyle='#c5e4f2';for(let i=0;i<5;i++){const a=i*TAU/5+now*.004;ctx.fillRect(Math.cos(a)*r*.7-2,Math.sin(a)*r*.45-2,4,4);}}
    }else if(['charm','faketears','scaryface','leer'].includes(p.move)){
      ctx.globalCompositeOperation='lighter';const color=p.move==='charm'?'#ffacd9':p.move==='faketears'?'#99d9ff':'#fa777f';ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,0,r*1.2,r*.68,now*.005,0,TAU);ctx.stroke();
      if(p.move==='faketears'){for(let i=0;i<5;i++){const a=i*TAU/5;ctx.fillStyle='#b9edff';ctx.beginPath();ctx.moveTo(Math.cos(a)*r*.7,Math.sin(a)*r*.4-3);ctx.quadraticCurveTo(Math.cos(a)*r*.7+3,Math.sin(a)*r*.4+2,Math.cos(a)*r*.7,Math.sin(a)*r*.4+5);ctx.quadraticCurveTo(Math.cos(a)*r*.7-3,Math.sin(a)*r*.4+2,Math.cos(a)*r*.7,Math.sin(a)*r*.4-3);ctx.fill();}}
      else for(let i=0;i<5;i++){const a=i*TAU/5+now*.004;ctx.fillStyle='#fff4ff';ctx.beginPath();ctx.arc(Math.cos(a)*r*.85,Math.sin(a)*r*.48,2,0,TAU);ctx.fill();}
    }else if(p.move==='seedbomb'){
      ctx.rotate(now*.01);const grad=ctx.createRadialGradient(-r*.2,-r*.25,1,0,0,r*1.4);grad.addColorStop(0,'#e9ffb3');grad.addColorStop(.35,'#70bb44');grad.addColorStop(.7,'#4a7b38');grad.addColorStop(1,'#243e1c00');ctx.fillStyle=grad;ctx.beginPath();ctx.ellipse(0,0,r*1.15,r*.9,0,0,TAU);ctx.fill();ctx.strokeStyle='#eaffb1';ctx.lineWidth=1.5;for(let i=0;i<5;i++){const a=i*TAU/5;ctx.beginPath();ctx.moveTo(Math.cos(a)*r*.4,Math.sin(a)*r*.3);ctx.lineTo(Math.cos(a)*r*1.2,Math.sin(a)*r*.8);ctx.stroke();}
    }else if(p.move==='mirrorshot'){
      ctx.rotate(now*.01);ctx.fillStyle='#bad4e3';ctx.strokeStyle='#f6ffff';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,-r*1.25);ctx.lineTo(r*.92,-r*.3);ctx.lineTo(r*.65,r*.8);ctx.lineTo(-r*.65,r*.8);ctx.lineTo(-r*.92,-r*.3);ctx.closePath();ctx.fill();ctx.stroke();ctx.strokeStyle='#627c95';ctx.beginPath();ctx.moveTo(0,-r*1.1);ctx.lineTo(0,r*.7);ctx.moveTo(-r*.75,-r*.25);ctx.lineTo(r*.75,-r*.25);ctx.stroke();ctx.beginPath();ctx.arc(0,0,r*1.4,0,TAU);ctx.stroke();
        }else if(p.move==='surf'){
      ctx.rotate(Math.sin(now*.006)*.08);const wave=ctx.createLinearGradient(-r*1.6,-r,r*1.4,r);wave.addColorStop(0,'#218cff');wave.addColorStop(.45,'#54d8ff');wave.addColorStop(.78,'#dbffff');wave.addColorStop(1,'#81d9ff');ctx.fillStyle=wave;ctx.beginPath();ctx.moveTo(-r*1.7,r*.55);ctx.quadraticCurveTo(-r*.9,-r*.9,-r*.15,-r*.15);ctx.quadraticCurveTo(r*.25,-r*1.65,r*1.4,-r*.4);ctx.quadraticCurveTo(r*.7,r*.9,-r*.2,r*.75);ctx.closePath();ctx.fill();ctx.strokeStyle='#e9ffff';ctx.lineWidth=1.8;ctx.beginPath();ctx.moveTo(-r*1.2,r*.34);ctx.quadraticCurveTo(-r*.3,-r*.5,r*.3,-r*.15);ctx.quadraticCurveTo(r*.65,-r*.75,r*1.12,-r*.36);ctx.stroke();for(let i=0;i<6;i++){const px=-r+i*r*.42,py=Math.sin(now*.012+i*1.7)*r*.6;ctx.fillStyle=i%2?'#efffff':'#a2efff';ctx.beginPath();ctx.arc(px,py,1.3+(i%2),0,TAU);ctx.fill();}
    }else if(p.move==='swift'){
      ctx.rotate(now*.004);for(let i=0;i<5;i++){const a=i*TAU/5+now*.003,orbit=r*.65,xx=Math.cos(a)*orbit,yy=Math.sin(a)*orbit*.62;ctx.save();ctx.translate(xx,yy);ctx.rotate(a+now*.002);ctx.fillStyle='#fff1a4';ctx.strokeStyle='#ffffff';ctx.lineWidth=1;ctx.beginPath();for(let j=0;j<10;j++){const theta=-Math.PI/2+j*Math.PI/5,rr=j%2?r*.14:r*.45;ctx.lineTo(Math.cos(theta)*rr,Math.sin(theta)*rr);}ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();}ctx.strokeStyle='#ffe6a2';ctx.lineWidth=1.4;ctx.beginPath();ctx.arc(0,0,r*1.1,0,TAU);ctx.stroke();
    }else if(['razorleaf','magicalleaf'].includes(p.move)){
      ctx.rotate(now*.01);for(let i=0;i<(p.move==='razorleaf'?4:6);i++){const a=i*TAU/(p.move==='razorleaf'?4:6),orbit=r*(p.move==='razorleaf'?.48:.82);ctx.save();ctx.translate(Math.cos(a)*orbit,Math.sin(a)*orbit*.6);ctx.rotate(a+.7);ctx.fillStyle=p.move==='razorleaf'?'#71c94e':i%2?'#a7ff7a':'#59dca1';ctx.strokeStyle=p.move==='razorleaf'?'#e0ffad':'#efffd8';ctx.lineWidth=1.1;ctx.beginPath();ctx.moveTo(-r*.5,0);ctx.quadraticCurveTo(-r*.08,-r*.4,r*.5,0);ctx.quadraticCurveTo(r*.05,r*.18,-r*.5,0);ctx.closePath();ctx.fill();ctx.stroke();ctx.beginPath();ctx.moveTo(-r*.42,0);ctx.lineTo(r*.39,0);ctx.stroke();ctx.restore();}
    }else if(['aurasphere','focusblast'].includes(p.move)){
      const palette=p.move==='aurasphere'?['#d5ffff','#5ce4ff','#2579e8']:['#fff1d1','#ffb65e','#e75f38'];const grad=ctx.createRadialGradient(-r*.25,-r*.28,1,0,0,r*1.7);grad.addColorStop(0,palette[0]);grad.addColorStop(.28,palette[1]);grad.addColorStop(.7,palette[2]);grad.addColorStop(1,palette[2]+'00');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*1.45,0,TAU);ctx.fill();ctx.strokeStyle=palette[0];ctx.lineWidth=2;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.7+i*.23),r*(.45+i*.14),now*.009+i*.9,0,TAU);ctx.stroke();}for(let i=0;i<4;i++){const a=now*.008+i*TAU/4;ctx.fillStyle=palette[i%3];ctx.beginPath();ctx.arc(Math.cos(a)*r,Math.sin(a)*r*.62,2.4,0,TAU);ctx.fill();}
    }else if(p.move==='vacuumwave'){
      ctx.rotate(now*.008);ctx.strokeStyle='#f3faff';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-r*1.5,-r*.1);ctx.quadraticCurveTo(-r*.15,-r*1.25,r*1.45,0);ctx.quadraticCurveTo(-r*.2,r*.35,-r*1.5,-r*.1);ctx.stroke();ctx.strokeStyle='#9bd5ff';ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(0,0,r*1.05,r*.34,0,0,TAU);ctx.stroke();for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.5+i*.25),r*(.15+i*.06),0,0,TAU);ctx.stroke();}
    }else if(['mudshot','mudslap'].includes(p.move)){
      ctx.rotate(Math.sin(now*.01)*.15);ctx.fillStyle='#876143';ctx.strokeStyle='#d0a26c';ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(-r,-r*.25);ctx.quadraticCurveTo(-r*.25,-r*1.2,r*.45,-r*.5);ctx.quadraticCurveTo(r*1.25,-r*.2,r*.72,r*.55);ctx.quadraticCurveTo(r*.1,r*1.1,-r*.6,r*.55);ctx.closePath();ctx.fill();ctx.stroke();for(let i=0;i<5;i++){const a=i*TAU/5+now*.004;ctx.fillStyle=i%2?'#b99062':'#654a35';ctx.beginPath();ctx.arc(Math.cos(a)*r*.8,Math.sin(a)*r*.5,1.5+(i%2),0,TAU);ctx.fill();}
    }else if(p.move==='darkpulse'){
      const grad=ctx.createRadialGradient(-r*.28,-r*.3,1,0,0,r*1.55);grad.addColorStop(0,'#f6dcff');grad.addColorStop(.24,'#9f64d8');grad.addColorStop(.58,'#512a83');grad.addColorStop(1,'#27113900');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*1.4,0,TAU);ctx.fill();ctx.strokeStyle='#c59aff';ctx.lineWidth=2;for(let i=0;i<4;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.7+i*.2),r*(.35+i*.15),now*.008+i,0,TAU);ctx.stroke();}for(let i=0;i<6;i++){const a=i*TAU/6+now*.005;ctx.fillStyle='#3b225b';ctx.beginPath();ctx.moveTo(Math.cos(a)*r*.6,Math.sin(a)*r*.4);ctx.lineTo(Math.cos(a+.16)*r*1.35,Math.sin(a+.16)*r*.9);ctx.lineTo(Math.cos(a-.1)*r*1.05,Math.sin(a-.1)*r*.72);ctx.closePath();ctx.fill();}
    }else if(['powergem','ancientpower'].includes(p.move)){
      ctx.rotate(now*.008);for(let i=0;i<6;i++){const a=i*TAU/6,orbit=r*(.5+(i%2)*.3);ctx.save();ctx.translate(Math.cos(a)*orbit,Math.sin(a)*orbit*.65);ctx.rotate(a);ctx.fillStyle=i%2?'#7bdcff':'#e6fbff';ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,-r*.55);ctx.lineTo(r*.25,0);ctx.lineTo(0,r*.45);ctx.lineTo(-r*.2,r*.05);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();}ctx.strokeStyle='#8dd8ff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(0,0,r*.8,0,TAU);ctx.stroke();
    }else if(['bugbuzz','signalbeam','silverwind'].includes(p.move)){
      if(p.move==='signalbeam'){const rainbow=['#fa7baa','#ffcf6c','#acff86','#68e4ff','#bca1ff'];rainbow.forEach((color,i)=>{ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,r*(.45+i*.15),-1.7+i*.13,1.2+i*.13);ctx.stroke();});}
      else if(p.move==='bugbuzz'){ctx.strokeStyle='#e6f9a2';ctx.lineWidth=2.5;for(let i=0;i<4;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.45+i*.3),r*(.3+i*.17),now*.009+i*.4,-1.3,1.5);ctx.stroke();}ctx.fillStyle='#b4dc65';for(let i=0;i<5;i++){const a=i*TAU/5;ctx.beginPath();ctx.ellipse(Math.cos(a)*r*.8,Math.sin(a)*r*.5,3,1.5,a,0,TAU);ctx.fill();}}
      else{for(let i=0;i<7;i++){const a=i*TAU/7+now*.004,orbit=r*(.35+(i%3)*.27);ctx.save();ctx.translate(Math.cos(a)*orbit,Math.sin(a)*orbit*.65);ctx.rotate(a);ctx.fillStyle=i%2?'#e8ffc4':'#92d46a';ctx.beginPath();ctx.moveTo(-r*.25,0);ctx.quadraticCurveTo(-r*.08,-r*.3,r*.35,0);ctx.quadraticCurveTo(0,r*.13,-r*.25,0);ctx.fill();ctx.restore();}}
    }else if(['drainingkiss','disarmingvoice','fairywind'].includes(p.move)){
      if(p.move==='drainingkiss'){ctx.fillStyle='#ff8fcf';ctx.strokeStyle='#fff0fa';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,r*.95);ctx.bezierCurveTo(-r*1.7,-r*.05,-r*.8,-r*1.1,0,-r*.25);ctx.bezierCurveTo(r*.8,-r*1.1,r*1.7,-r*.05,0,r*.95);ctx.fill();ctx.stroke();ctx.strokeStyle='#ffe8f6';ctx.beginPath();ctx.arc(0,-r*.1,r*.7,.15,Math.PI*.85);ctx.stroke();}
      else{ctx.strokeStyle='#ffc0ef';ctx.lineWidth=2;for(let i=0;i<4;i++){const rr=r*(.4+i*.28);ctx.beginPath();ctx.ellipse(0,0,rr,rr*.6,now*.004+i,-1.7,1.5);ctx.stroke();}for(let i=0;i<5;i++){const a=i*TAU/5+now*.004;ctx.fillStyle='#fff0ff';ctx.beginPath();ctx.arc(Math.cos(a)*r*.9,Math.sin(a)*r*.5,1.4,0,TAU);ctx.fill();}}
    }else if(p.move==='ember'){
      for(let i=4;i>=0;i--){ctx.globalAlpha=1-i*.13;const rr=r*(.4+i*.2);ctx.fillStyle=i%2?'#ff8b37':'#ffd46a';ctx.beginPath();ctx.ellipse(-i*3,Math.sin(now*.018+i)*3,rr,rr*.74,now*.004+i,0,TAU);ctx.fill();}ctx.globalAlpha=1;ctx.fillStyle='#fff6cb';ctx.beginPath();ctx.arc(r*.15,0,r*.35,0,TAU);ctx.fill();
    }else if(p.move==='thundershock'){
      ctx.globalCompositeOperation='lighter';ctx.strokeStyle='#fff27a';ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(-r*1.25,0);ctx.lineTo(-r*.55,-r*.25);ctx.lineTo(-r*.22,r*.2);ctx.lineTo(r*.25,-r*.38);ctx.lineTo(r*1.1,0);ctx.stroke();ctx.strokeStyle='#5fdcff';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(-r*.8,r*.2);ctx.lineTo(-r*.15,0);ctx.lineTo(r*.45,r*.3);ctx.stroke();
    }else if(p.move==='spark'){
      ctx.rotate(now*.006);const grad=ctx.createRadialGradient(0,0,1,0,0,r*1.2);grad.addColorStop(0,'#fffcd5');grad.addColorStop(.45,'#ffe45a');grad.addColorStop(1,'#ffcf3700');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*1.25,0,TAU);ctx.fill();for(let i=0;i<8;i++){const a=i*TAU/8,reach=r*(1.3+(i%3)*.15);ctx.strokeStyle=i%2?'#fff7a5':'#63dbff';ctx.lineWidth=i%2?2:1.3;ctx.beginPath();ctx.moveTo(Math.cos(a)*r*.65,Math.sin(a)*r*.45);ctx.lineTo(Math.cos(a+.09)*reach,Math.sin(a+.09)*reach*.7);ctx.stroke();}
    }else if(p.move==='nuzzle'){
      ctx.globalCompositeOperation='lighter';ctx.fillStyle='#fff2a3';ctx.beginPath();ctx.arc(0,0,r*.9,0,TAU);ctx.fill();ctx.strokeStyle='#ffe55e';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,0,r*1.3,r*.8,now*.014,0,TAU);ctx.stroke();for(let i=0;i<5;i++){const a=i*TAU/5+now*.006;ctx.fillStyle=i%2?'#fff':'#6edbff';ctx.beginPath();ctx.arc(Math.cos(a)*r*1.35,Math.sin(a)*r*.9,1.8,0,TAU);ctx.fill();}
    }else if(p.move==='shockwave'){
      ctx.globalCompositeOperation='lighter';for(let i=0;i<4;i++){const rr=r*(.55+i*.38);ctx.strokeStyle=i%2?'#bdeaff':'#ffed81';ctx.lineWidth=2-i*.25;ctx.beginPath();ctx.ellipse(0,0,rr,rr*.64,now*.005+i*.3,0,TAU);ctx.stroke();}ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(0,0,r*.28,0,TAU);ctx.fill();
    }else if(p.move==='poisonsting'){
      ctx.rotate(now*.01);ctx.fillStyle='#9f68c4';ctx.strokeStyle='#f1d0ff';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(r*1.4,0);ctx.lineTo(-r*.25,-r*.48);ctx.lineTo(-r*1.1,-r*.6);ctx.lineTo(-r*.75,0);ctx.lineTo(-r*1.1,r*.6);ctx.lineTo(-r*.25,r*.48);ctx.closePath();ctx.fill();ctx.stroke();ctx.fillStyle='#d2a0e9';for(let i=0;i<3;i++){const a=i*TAU/3;ctx.beginPath();ctx.arc(Math.cos(a)*r*.75,Math.sin(a)*r*.55,1.5,0,TAU);ctx.fill();}
    }else if(p.move==='sludgewave'){
      ctx.globalCompositeOperation='lighter';ctx.rotate(now*.003);ctx.strokeStyle='#a2dc64';ctx.lineWidth=3;for(let i=0;i<4;i++){const rr=r*(.45+i*.3);ctx.beginPath();ctx.ellipse(0,0,rr,rr*.54,Math.sin(now*.004+i)*.2,0,TAU);ctx.stroke();}ctx.fillStyle='#7b4ca2';ctx.beginPath();ctx.moveTo(-r*1.25,r*.2);ctx.quadraticCurveTo(-r*.4,-r*1.2,r*.25,-r*.1);ctx.quadraticCurveTo(r*.8,-r*.9,r*1.3,r*.15);ctx.quadraticCurveTo(r*.1,r*.75,-r*1.25,r*.2);ctx.fill();for(let i=0;i<7;i++){const a=i*TAU/7;ctx.fillStyle=i%2?'#d2ff80':'#aa6cd5';ctx.beginPath();ctx.arc(Math.cos(a)*r,Math.sin(a)*r*.5,1.5+(i%3),0,TAU);ctx.fill();}
    }else if(p.move==='dragonbreath'){
      ctx.rotate(now*.003);for(let i=0;i<4;i++){ctx.globalAlpha=.85-i*.15;ctx.strokeStyle=['#80dfff','#90b5ff','#b9a4ff','#fff0ce'][i];ctx.lineWidth=5-i;ctx.beginPath();ctx.moveTo(-r*1.5,i*2-3);ctx.bezierCurveTo(-r*.6,-r+i*3,r*.35,r-i*5,r*1.4,Math.sin(now*.009+i)*r*.35);ctx.stroke();}ctx.globalAlpha=1;ctx.fillStyle='#c3eeff';ctx.beginPath();ctx.arc(0,0,r*.35,0,TAU);ctx.fill();
    }else if(p.move==='headsmash'){
      ctx.rotate(now*.005);ctx.fillStyle='#465c78';ctx.strokeStyle='#d5ecff';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(r*1.35,0);ctx.lineTo(r*.35,-r*.65);ctx.lineTo(-r*.45,-r*1.1);ctx.lineTo(-r*1.2,-r*.45);ctx.lineTo(-r*.7,r*.65);ctx.lineTo(r*.25,r*.9);ctx.closePath();ctx.fill();ctx.stroke();ctx.strokeStyle='#b7d7f5';ctx.beginPath();ctx.moveTo(-r*.45,-r*1.1);ctx.lineTo(r*.1,-r*.08);ctx.lineTo(r*1.35,0);ctx.moveTo(-r*.7,r*.65);ctx.lineTo(r*.1,-r*.08);ctx.stroke();
    }else if(p.move==='hiddenpower'){
      ctx.rotate(now*.005);const grad=ctx.createRadialGradient(-r*.3,-r*.25,1,0,0,r*1.7);grad.addColorStop(0,'#fff');grad.addColorStop(.25,'#d8c5ff');grad.addColorStop(.55,'#8e7bdf');grad.addColorStop(.8,'#423a7b');grad.addColorStop(1,'#221b4400');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*1.45,0,TAU);ctx.fill();ctx.strokeStyle='#e4ddff';ctx.lineWidth=1.4;for(let i=0;i<8;i++){const a=i*TAU/8,inner=r*.55,outer=r*(1.1+(i%3)*.14);ctx.beginPath();ctx.moveTo(Math.cos(a)*inner,Math.sin(a)*inner);ctx.lineTo(Math.cos(a+.05)*outer,Math.sin(a+.05)*outer);ctx.stroke();}ctx.strokeStyle='#a5e9ff';ctx.beginPath();ctx.ellipse(0,0,r*1.1,r*.55,now*.006,0,TAU);ctx.stroke();
    }else if(p.move==='tailwhip'){
      ctx.rotate(Math.sin(now*.008)*.12);ctx.globalCompositeOperation='lighter';for(let i=0;i<4;i++){ctx.strokeStyle=i%2?'#fff1c8':'#dabd8a';ctx.lineWidth=4-i*.6;ctx.beginPath();ctx.moveTo(-r*1.4,(i-1.5)*3);ctx.bezierCurveTo(-r*.45,-r*.9+i*2,r*.35,r*.85-i*2,r*1.35,Math.sin(now*.012+i)*r*.3);ctx.stroke();}for(let i=0;i<3;i++){const a=i*TAU/3+now*.003;ctx.fillStyle='#fff3d1';ctx.beginPath();ctx.arc(Math.cos(a)*r*.7,Math.sin(a)*r*.45,1.5,0,TAU);ctx.fill();}
    }else if(p.move==='heatwave'){
      ctx.globalAlpha=.75;for(let i=0;i<4;i++){const rr=r*(.5+i*.3);ctx.strokeStyle=i%2?'#ffc76b':'#ff7445';ctx.lineWidth=3-i*.45;ctx.beginPath();for(let j=0;j<=20;j++){const a=j*TAU/20,rad=rr+Math.sin(a*4+now*.012+i)*3;const xx=Math.cos(a)*rad,yy=Math.sin(a)*rad*.62;j?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy);}ctx.stroke();}ctx.fillStyle='#fff0b0';ctx.beginPath();ctx.arc(0,0,r*.35,0,TAU);ctx.fill();
    }else if(['overheat','eruption','inferno','mysticalfire','incinerate','lavaplume','sacredfire','blastburn','firepledge','flameburst','burningjealousy','flamecharge'].includes(p.move)){
      // A single tapered flame with a hot core and a few separated cinders.
      const scale=p.move==='eruption'||p.move==='blastburn'?1.3:p.move==='flamecharge'?.8:1;
      ctx.rotate(Math.sin(now*.012)*.08);
      for(let layer=0;layer<3;layer++){
        const length=r*(1.7-layer*.26)*scale,width=r*(.82-layer*.19)*scale,offset=-layer*2;
        ctx.globalAlpha=layer===0?.78:1;
        ctx.fillStyle=layer===0?'#d83c27':layer===1?'#ff7d2b':'#ffc453';
        ctx.beginPath();ctx.moveTo(-r*.65,offset);
        ctx.bezierCurveTo(-r*.2,-width*.8,length*.58,-width*.65,length,offset-Math.sin(now*.025+layer)*r*.12);
        ctx.bezierCurveTo(length*.63,width*.7,-r*.1,width*.5,-r*.65,offset);
        ctx.closePath();ctx.fill();
      }
      ctx.globalAlpha=1;ctx.fillStyle='#fff4c7';ctx.beginPath();ctx.ellipse(r*.18,0,r*.55,r*.22,0,0,TAU);ctx.fill();
      for(let i=0;i<4;i++){const a=i*TAU/4+now*.001,px=r*(.7+(i%2)*.55),py=Math.sin(a)*r*(.55+(i%3)*.1);ctx.fillStyle=i%2?'#ffdf80':'#fff0b5';ctx.fillRect(px,py,2.5,2.5);}
    }else if(['bubblebeam','bubble','brine','scald','originpulse','hydrocannon','waterpledge','muddywater','whirlpool'].includes(p.move)){
      // Rounded water pearls and a curved wake, never a glowing orb with a halo.
      const big=['hydrocannon','originpulse','waterpledge'].includes(p.move),scale=big?1.25:1;
      ctx.strokeStyle='#2f9ddd';ctx.lineWidth=2.3;ctx.beginPath();ctx.moveTo(-r*1.65,r*.15);
      ctx.bezierCurveTo(-r*.8,-r*.5,r*.35,r*.45,r*1.65,-r*.08);ctx.stroke();
      ctx.strokeStyle='#d9fcff';ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(-r*1.25,r*.06);
      ctx.quadraticCurveTo(0,-r*.18,r*1.3,-r*.03);ctx.stroke();
      const pearls=big?5:4;
      for(let i=0;i<pearls;i++){const px=-r*.65+i*r*.43,py=Math.sin(now*.009+i*1.8)*r*.25-(i%2)*r*.06,size=(i===pearls-1?r*.42:r*(.22+(i%2)*.07))*scale;
        ctx.fillStyle=i%2?'#5cc8f1':'#b9f4ff';ctx.strokeStyle='#f2ffff';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(px,py,size,size*.78,-.2,0,TAU);ctx.fill();ctx.stroke();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(px-size*.22,py-size*.24,Math.max(1,size*.18),0,TAU);ctx.fill();}
      if(p.move==='whirlpool'){ctx.strokeStyle='#e7fdff';ctx.lineWidth=1.7;ctx.beginPath();ctx.ellipse(0,0,r*1.2,r*.6,now*.004,0,TAU);ctx.stroke();}
    }else if(['electroball','electroweb','risingvoltage','voltswitch','electroshot','paraboliccharge','thunderfang','wildboltstorm'].includes(p.move)){
      // A sharp central bolt with two forks; the electric silhouette reads at small scale.
      ctx.strokeStyle='#4dbaf3';ctx.lineWidth=5;ctx.beginPath();ctx.moveTo(-r*1.6,r*.1);ctx.lineTo(-r*.72,-r*.18);ctx.lineTo(-r*.35,r*.32);ctx.lineTo(r*.05,-r*.56);ctx.lineTo(r*.38,-r*.05);ctx.lineTo(r*1.6,-r*.24);ctx.stroke();
      ctx.strokeStyle='#ffed69';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-r*1.4,r*.04);ctx.lineTo(-r*.68,-r*.08);ctx.lineTo(-r*.29,r*.2);ctx.lineTo(r*.06,-r*.36);ctx.lineTo(r*.4,-r*.01);ctx.lineTo(r*1.35,-r*.18);ctx.stroke();
      ctx.strokeStyle='#fffce1';ctx.lineWidth=1.2;ctx.stroke();
      if(p.move==='electroweb'){ctx.strokeStyle='#ffe96b';ctx.lineWidth=1;for(let i=-1;i<=1;i++){ctx.beginPath();ctx.moveTo(-r*.6,i*r*.22);ctx.lineTo(r*.15,i*r*.22);ctx.lineTo(r*.65,i*r*.38);ctx.stroke();}}
    }else if(['energyball','leafstorm','petalblizzard','pollenpuff','seedflare','magicalleaf','grassyglide','appleacid'].includes(p.move)){
      // Leaves orbit a compact green core; individually readable, outlined silhouettes.
      const angle=now*.0025;
      const core=ctx.createRadialGradient(-r*.2,-r*.18,1,0,0,r*.9);core.addColorStop(0,'#f4ffd5');core.addColorStop(.38,'#a7e86a');core.addColorStop(1,'#4fae50');
      ctx.fillStyle=core;ctx.beginPath();ctx.arc(0,0,r*.6,0,TAU);ctx.fill();
      const count=p.move==='petalblizzard'?8:5;
      for(let i=0;i<count;i++){const a=i*TAU/count+angle,dist=r*(.7+(i%2)*.22),size=r*(.36+(i%3)*.07);ctx.save();ctx.translate(Math.cos(a)*dist,Math.sin(a)*dist*.7);ctx.rotate(a+.5);
        ctx.fillStyle=i%2?'#65bc4e':'#b3ec70';ctx.strokeStyle='#e5ffb9';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,size*.7);ctx.quadraticCurveTo(-size*1.05,-size*.12,0,-size);ctx.quadraticCurveTo(size*1.05,-size*.12,0,size*.7);ctx.closePath();ctx.fill();ctx.stroke();ctx.strokeStyle='#f0ffd0';ctx.beginPath();ctx.moveTo(0,size*.52);ctx.lineTo(0,-size*.73);ctx.stroke();ctx.restore();}
    }else if(['aurorabeam','freezedry','icywind','powdersnow','glaciate','iciclespear','iciclecrash','avalanche'].includes(p.move)){
      // Layered ice splinters, with crisp edges and narrow highlights.
      for(let i=0;i<5;i++){const side=(i-2),px=side*r*.44,py=Math.sin(now*.006+i)*r*.18,size=r*(.48+(i%3)*.16);ctx.save();ctx.translate(px,py);ctx.rotate(side*.25);
        ctx.fillStyle=i%2?'#73ccec':'#d5faff';ctx.strokeStyle='#f6ffff';ctx.lineWidth=1.1;ctx.beginPath();ctx.moveTo(0,-size);ctx.lineTo(size*.28,-size*.08);ctx.lineTo(size*.14,size*.77);ctx.lineTo(-size*.22,size*.34);ctx.closePath();ctx.fill();ctx.stroke();ctx.strokeStyle='#5ab0dd';ctx.beginPath();ctx.moveTo(0,-size*.76);ctx.lineTo(size*.08,size*.45);ctx.stroke();ctx.restore();}
      ctx.strokeStyle='#efffff';ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(-r*1.3,r*.05);ctx.lineTo(r*1.25,-r*.06);ctx.stroke();
    }else if(['psyshock','psystrike','futuresight','storedpower','extrasensory','expandingforce','lusterpurge','mistball','prismaticlaser'].includes(p.move)){
      // Psychic attacks use a clean lens motif and offset rings, not a generic sphere.
      ctx.strokeStyle='#9576dd';ctx.lineWidth=2.2;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.58+i*.26),r*(.28+i*.13),Math.sin(now*.004+i)*.08,i*.7,Math.PI*1.65+i*.7);ctx.stroke();}
      ctx.strokeStyle='#f6c7fa';ctx.lineWidth=1.6;ctx.beginPath();ctx.moveTo(-r*1.35,0);ctx.lineTo(-r*.45,-r*.12);ctx.lineTo(0,-r*.62);ctx.lineTo(r*.35,-r*.15);ctx.lineTo(r*1.4,0);ctx.stroke();
      ctx.fillStyle='#fff1ff';ctx.beginPath();ctx.arc(0,0,r*.22,0,TAU);ctx.fill();
      for(let i=0;i<4;i++){const a=i*TAU/4+now*.003;ctx.fillStyle='#d5baff';ctx.beginPath();ctx.arc(Math.cos(a)*r*.8,Math.sin(a)*r*.36,1.8,0,TAU);ctx.fill();}
    }else if(['hex','ominouswind','poltergeist','astralbarrage','nightdaze','shadowbone','spectralthief'].includes(p.move)){
      // Ghostly shards peel away from a dark central slash.
      ctx.strokeStyle='#a891eb';ctx.lineWidth=2.2;ctx.beginPath();ctx.moveTo(-r*1.35,r*.2);ctx.quadraticCurveTo(-r*.25,-r*.65,r*1.25,-r*.05);ctx.stroke();
      ctx.strokeStyle='#efe8ff';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(-r*.9,r*.08);ctx.quadraticCurveTo(0,-r*.28,r*.9,0);ctx.stroke();
      for(let i=0;i<5;i++){const a=i*TAU/5+now*.002,dist=r*(.45+(i%2)*.5);ctx.fillStyle=i%2?'#7562c8':'#c2b4ff';ctx.beginPath();ctx.moveTo(Math.cos(a)*dist,Math.sin(a)*dist*.6);
        ctx.lineTo(Math.cos(a+.18)*(dist+r*.26),Math.sin(a+.18)*(dist+r*.26)*.6);ctx.lineTo(Math.cos(a-.12)*(dist+r*.1),Math.sin(a-.12)*(dist+r*.1)*.6);ctx.closePath();ctx.fill();}
    }else if(['gunkshot','venoshock','acid','acidspray','malignantchain','sludge','shellsidearm'].includes(p.move)){
      // Poison travels as heavy droplets with small pointed tails and a sharp highlight.
      for(let i=0;i<5;i++){const x0=(i-2)*r*.47,y0=Math.sin(i*1.7+now*.007)*r*.2,sz=r*(.2+(i%3)*.08);
        ctx.fillStyle=i%2?'#77449b':'#a06bc1';ctx.strokeStyle='#e5b8f2';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x0-sz*.7,y0);ctx.quadraticCurveTo(x0-sz,y0-sz*1.2,x0,y0-sz*1.15);ctx.quadraticCurveTo(x0+sz*1.1,y0-sz*.5,x0+sz*.55,y0+sz*.45);ctx.quadraticCurveTo(x0,y0+sz*.75,x0-sz*.7,y0);ctx.closePath();ctx.fill();ctx.stroke();ctx.fillStyle='#f4d8ff';ctx.fillRect(x0-sz*.2,y0-sz*.52,Math.max(1,sz*.22),Math.max(1,sz*.2));}
    }else if(['dragonrage','twister','breaking-swipe','coreenforcer','clangingscales','roaroftime'].includes(p.move)){
      // Dragon moves are alternating scales and a compressed double spiral.
      ctx.strokeStyle='#8b76d5';ctx.lineWidth=3;for(let ring=0;ring<2;ring++){ctx.beginPath();ctx.ellipse(0,0,r*(.52+ring*.34),r*(.32+ring*.16),ring?-.17:.17,now*.003+ring,now*.003+ring+Math.PI*1.65);ctx.stroke();}
      for(let i=0;i<6;i++){const x0=(i-2.5)*r*.36,y0=Math.sin(i*1.6+now*.005)*r*.15;ctx.fillStyle=i%2?'#9d84e4':'#e58ba7';ctx.beginPath();ctx.moveTo(x0-r*.12,y0);ctx.lineTo(x0,y0-r*.18);ctx.lineTo(x0+r*.2,y0);ctx.lineTo(x0,y0+r*.13);ctx.closePath();ctx.fill();}
      ctx.strokeStyle='#fae4ff';ctx.lineWidth=1.1;ctx.beginPath();ctx.moveTo(-r,0);ctx.lineTo(r,0);ctx.stroke();
    }else if(['moonblast','disarmingvoice','fairywind','mistyexplosion','strange-steam','naturesmadness'].includes(p.move)){
      // Fairy attacks use a few deliberate starbursts and a clean curved ribbon.
      ctx.strokeStyle='#f38fd4';ctx.lineWidth=2.2;ctx.beginPath();ctx.moveTo(-r*1.35,r*.08);ctx.quadraticCurveTo(0,-r*.48,r*1.35,-r*.03);ctx.stroke();
      ctx.strokeStyle='#ffe7fa';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(-r,0);ctx.quadraticCurveTo(0,r*.18,r,0);ctx.stroke();
      for(let i=0;i<5;i++){const a=i*TAU/5+now*.0015,dist=r*(.4+(i%2)*.38);const x0=Math.cos(a)*dist,y0=Math.sin(a)*dist*.5;
        ctx.fillStyle=i%2?'#fff4ff':'#ffb0e7';ctx.beginPath();ctx.moveTo(x0,y0-r*.14);ctx.lineTo(x0+r*.055,y0-r*.055);ctx.lineTo(x0+r*.16,y0);ctx.lineTo(x0+r*.055,y0+r*.05);ctx.lineTo(x0,y0+r*.14);ctx.lineTo(x0-r*.055,y0+r*.05);ctx.lineTo(x0-r*.16,y0);ctx.lineTo(x0-r*.055,y0-r*.055);ctx.closePath();ctx.fill();}
    }else if(['mudshot','mudbomb','scorchingsands','sandtomb','thousandarrows','precipiceblades'].includes(p.move)){
      ctx.strokeStyle='#d3b788';ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(-r*1.45,r*.18);ctx.quadraticCurveTo(-r*.2,-r*.65,r*1.4,-r*.06);ctx.stroke();
      for(let i=0;i<6;i++){const a=i*TAU/6,dist=r*(.45+(i%3)*.24),x0=Math.cos(a)*dist,y0=Math.sin(a)*dist*.58,sz=r*(.12+(i%2)*.06);ctx.save();ctx.translate(x0,y0);ctx.rotate(a+.5);ctx.fillStyle=i%2?'#8e7d64':'#c2a77b';ctx.strokeStyle='#f2dfb9';ctx.lineWidth=.8;ctx.beginPath();ctx.moveTo(-sz,-sz*.35);ctx.lineTo(-sz*.2,-sz);ctx.lineTo(sz,-sz*.3);ctx.lineTo(sz*.6,sz*.6);ctx.lineTo(-sz*.6,sz*.5);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();}
    }else if(['triattack','weatherball','judgment','technoblast','terrainpulse','revelationdance'].includes(p.move)){
      const colors=p.move==='triattack'?['#ff916a','#77d8ff','#a3ec76']:p.move==='weatherball'?['#ffb34c','#7bd5f3','#c3b5f2']:['#f4e8b4','#c3d7e8','#e7b7e9'];
      for(let i=0;i<3;i++){const px=(i-1)*r*.63,py=Math.sin(now*.004+i*2)*r*.08,rr=r*(.25+(i===1?.05:0));ctx.fillStyle=colors[i];ctx.strokeStyle='#fff';ctx.lineWidth=1.1;ctx.beginPath();ctx.arc(px,py,rr,0,TAU);ctx.fill();ctx.stroke();ctx.fillStyle='#fff7e6';ctx.beginPath();ctx.arc(px-rr*.25,py-rr*.25,rr*.2,0,TAU);ctx.fill();}
    }else if(type==='Electric'){
      const length=75;ctx.strokeStyle=c;ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(-length,0);for(let i=1;i<8;i++)ctx.lineTo(-length+i*length/7,(i===7?0:Math.sin(now*.065+i*3)*7));ctx.stroke();ctx.strokeStyle='#fffce8';ctx.lineWidth=1.5;ctx.stroke();
    }else if(type==='Fire'){
      for(let i=5;i>=0;i--){ctx.globalAlpha=1-i/7;ctx.fillStyle=i>2?'#ec6944':i>0?'#ffb353':'#fff4b5';ctx.beginPath();ctx.ellipse(-i*10,Math.sin(now*.04+i)*i,Math.max(3,r-i),Math.max(2,(r-i)*.75),0,0,TAU);ctx.fill();}
    }else if(type==='Water'){
      const g=ctx.createLinearGradient(-70,0,10,0);g.addColorStop(0,'#5dceff00');g.addColorStop(1,'#77dbff');ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(-75,0);ctx.quadraticCurveTo(-10,-r*1.2,r,0);ctx.quadraticCurveTo(-10,r*1.2,-75,0);ctx.fill();ctx.strokeStyle='#e0ffff';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,0,r,r*.65,0,0,TAU);ctx.stroke();
    }else if(type==='Ice'){
      ctx.fillStyle='#b9f5ff';ctx.strokeStyle='#ffffff';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(r*1.7,0);ctx.lineTo(-r*.6,-r*.65);ctx.lineTo(-r,0);ctx.lineTo(-r*.6,r*.65);ctx.closePath();ctx.fill();ctx.stroke();ctx.strokeStyle='#79bde4';ctx.beginPath();ctx.moveTo(-r,0);ctx.lineTo(r*1.7,0);ctx.stroke();
    }else if(type==='Grass'){
      ctx.rotate(now*.016);ctx.fillStyle=c;ctx.beginPath();ctx.moveTo(r*1.5,0);ctx.quadraticCurveTo(-r,-r*1.8,-r,0);ctx.quadraticCurveTo(-r,r,r*1.5,0);ctx.fill();ctx.strokeStyle='#d6ffc3';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(-r,0);ctx.lineTo(r,0);ctx.stroke();
    }else{
      const gradient=ctx.createRadialGradient(0,0,1,0,0,r*1.8);gradient.addColorStop(0,'#ffffff');gradient.addColorStop(.25,c);gradient.addColorStop(1,c+'00');ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(0,0,r*1.8,0,TAU);ctx.fill();ctx.strokeStyle=c;ctx.lineWidth=1.5;ctx.beginPath();ctx.ellipse(0,0,r*1.5,r*.75,now*.013,0,TAU);ctx.stroke();
    }
    ctx.restore();
    if(this.settings().particles&&Math.random()<.5){const life=.12+Math.random()*.13;this.particles.push({x:x-Math.cos(angle)*r,y:y-Math.sin(angle)*r,vx:-Math.cos(angle)*30,vy:-Math.sin(angle)*30,life,max:life,type,size:1+Math.random()*2});}
  }

  drawEffects(dt,now) {
    const ctx=this.ctx;
    for(let i=this.effects.length-1;i>=0;i--){const e=this.effects[i];e.life-=dt;if(e.life<=0){this.effects.splice(i,1);continue;}const t=1-e.life/e.max,c=tint(e.type);ctx.save();ctx.translate(e.x,e.y);ctx.globalAlpha=(1-t)*.85;ctx.strokeStyle=c;ctx.fillStyle=c+'44';ctx.shadowColor=c;ctx.shadowBlur=14;
      if(e.kind==='chargeTrail'){
        const angle=Math.atan2(e.direction?.y||0,e.direction?.x||1),len=Math.max(10,e.length||75),move=e.move;ctx.rotate(angle);ctx.lineCap='round';ctx.lineJoin='round';
        if(move==='volttackle'||move==='wildcharge'){
          for(let strand=0;strand<3;strand++){ctx.strokeStyle=strand===1?'#fffbe0':strand===0?'#ffe96a':'#73d8ff';ctx.globalAlpha=(1-t)*(.95-strand*.18);ctx.lineWidth=strand===1?2.2:3.5;ctx.beginPath();ctx.moveTo(0,(strand-1)*5);for(let j=1;j<=8;j++){const px=len*t*j/8,py=(strand-1)*5+Math.sin(j*8+now*.05+strand)*7;ctx.lineTo(px,py);}ctx.stroke();}
          for(let i=0;i<5;i++){const px=len*t*(i+1)/6;ctx.fillStyle=i%2?'#fff6bd':'#ffe969';ctx.fillRect(px-2,Math.sin(now*.05+i*3)*9-2,4,4);}
        }else if(move==='flareblitz'){
          for(let i=0;i<4;i++){const tail=-i*6,reach=len*t;ctx.globalAlpha=(1-t*.55)*(1-i*.17);ctx.fillStyle=['#ff4a28','#ff762d','#ffb23f','#fff0a4'][i];ctx.beginPath();ctx.moveTo(0,tail-5-i);ctx.quadraticCurveTo(reach*.42,tail-14-i*2,reach,tail);ctx.quadraticCurveTo(reach*.53,tail+10+i,0,tail+5+i);ctx.closePath();ctx.fill();}
        }else if(move==='bravebird'){
          for(let i=0;i<5;i++){const tail=-i*4,reach=len*t;ctx.globalAlpha=(1-t*.45)*(1-i*.15);ctx.strokeStyle=i%2?'#ffffff':'#8fd5ff';ctx.lineWidth=i===0?4:2;ctx.beginPath();ctx.moveTo(0,tail);ctx.bezierCurveTo(reach*.25,tail-13,reach*.65,tail+5,reach,tail+Math.sin(now*.02+i)*3);ctx.stroke();}
          for(let i=0;i<4;i++){const px=len*t*(i+1)/5;ctx.fillStyle=i%2?'#ffffff':'#9bdcff';ctx.beginPath();ctx.moveTo(px,-5);ctx.quadraticCurveTo(px+4,-1,px+7,5);ctx.quadraticCurveTo(px+1,3,px,-5);ctx.fill();}
        }else if(move==='headsmash'){
          for(let i=0;i<4;i++){const tail=-i*6,reach=len*t;ctx.globalAlpha=(1-t*.55)*(1-i*.15);ctx.strokeStyle=i%2?'#d8eaff':'#708ba8';ctx.lineWidth=3-i*.35;ctx.beginPath();ctx.moveTo(0,tail);ctx.lineTo(reach*.4,tail-7-i);ctx.lineTo(reach,tail+Math.sin(now*.02+i)*3);ctx.stroke();}
          for(let i=0;i<5;i++){const px=len*t*(i+1)/6;ctx.fillStyle=i%2?'#8b9eb4':'#e1edf9';ctx.fillRect(px-2,Math.sin(now*.03+i*2)*8-2,4,4);}
        }else if(move==='extremespeed'){
          ctx.globalCompositeOperation='lighter';for(let i=0;i<5;i++){ctx.globalAlpha=(1-t*.6)*(1-i*.13);ctx.strokeStyle=i%2?'#fff':'#8bd9ff';ctx.lineWidth=i===0?3.5:1.7;ctx.beginPath();ctx.moveTo(0,(i-2)*5);ctx.lineTo(len*t*.45,(i-2)*7-3);ctx.lineTo(len*t,Math.sin(now*.03+i)*2);ctx.stroke();}ctx.globalAlpha=1;ctx.strokeStyle='#d4f4ff';ctx.lineWidth=1.5;ctx.beginPath();ctx.ellipse(len*t*.72,0,5+t*10,3+t*5,0,0,TAU);ctx.stroke();
        }else if(move==='quickattack'){
          for(let i=0;i<4;i++){ctx.globalAlpha=(1-t*.5)*(1-i*.17);ctx.strokeStyle=i%2?'#fff':'#d9e6f5';ctx.lineWidth=i===0?3:1.6;ctx.beginPath();ctx.moveTo(0,(i-1.5)*4);ctx.lineTo(len*t*.5,(i-1.5)*6-3);ctx.lineTo(len*t,0);ctx.stroke();}ctx.globalAlpha=1;
        }else if(move==='aquajet'){
          ctx.strokeStyle='#c9f8ff';ctx.lineWidth=11;ctx.beginPath();ctx.moveTo(0,0);ctx.quadraticCurveTo(len*t*.52,-10,len*t,0);ctx.stroke();ctx.strokeStyle='#39bfff';ctx.lineWidth=6;ctx.beginPath();ctx.moveTo(0,0);ctx.quadraticCurveTo(len*t*.5,8,len*t,0);ctx.stroke();for(let i=0;i<5;i++){const px=len*t*(i+1)/6;ctx.fillStyle='#b9f4ff';ctx.beginPath();ctx.arc(px,Math.sin(now*.06+i)*5,2,0,TAU);ctx.fill();}
        }else if(move==='struggle'){
          ctx.setLineDash([6,4]);ctx.strokeStyle='#e7e0d1';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(0,-8);ctx.lineTo(len*t*.45,5);ctx.lineTo(len*t*.72,-5);ctx.lineTo(len*t,0);ctx.stroke();ctx.setLineDash([]);ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,7);ctx.lineTo(len*t*.66,1);ctx.stroke();
          for(let i=0;i<5;i++){const px=len*t*(i+1)/6;ctx.fillStyle=i%2?'#e7aa6b':'#fff1cf';ctx.fillRect(px-2,Math.sin(now*.04+i*2)*10-2,4,4);}
        }else{
          for(let i=0;i<5;i++){ctx.globalAlpha=(1-t*.55)*(1-i*.14);ctx.strokeStyle=i%2?'#ffffff':'#d9e8ff';ctx.lineWidth=i===0?3:1.5;ctx.beginPath();ctx.moveTo(0,(i-2)*5);ctx.lineTo(len*t*(.52+i*.1),((i%2)?-1:1)*(7+i));ctx.lineTo(len*t,0);ctx.stroke();}
        }
      }else if(e.kind==='elementalPunch'){
        const move=e.move,angle=Math.atan2(e.direction?.y||0,e.direction?.x||1),radius=10+t*27;ctx.rotate(angle);ctx.globalCompositeOperation='lighter';
        const palette=move==='firepunch'?['#ff4f29','#ffbd48','#fff0b0']:move==='thunderpunch'?['#5bceff','#ffe85b','#fffbd7']:move==='icepunch'?['#62c9f1','#c7f6ff','#fff']:move==='drainpunch'?['#37c96c','#9dffb4','#edffdc']:move==='bulletpunch'?['#66899e','#d9f5ff','#fff']:['#e6a169','#fff0d0','#fff'];
        ctx.strokeStyle=palette[0];ctx.lineWidth=5*(1-t)+1;for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(9-i*4,0,radius*(.7+i*.2),-.9+i*.16,.85+i*.16);ctx.stroke();}
        for(let i=0;i<7;i++){const a=i*TAU/7,reach=radius*(.7+(i%3)*.16);ctx.strokeStyle=palette[i%palette.length];ctx.lineWidth=i%2?1.5:2.6;ctx.beginPath();ctx.moveTo(8+Math.cos(a)*4,Math.sin(a)*3);ctx.lineTo(8+Math.cos(a+.08)*reach,Math.sin(a+.08)*reach*.65);ctx.stroke();}
        if(move==='firepunch'){for(let i=0;i<4;i++){const a=-.65+i*.42;ctx.fillStyle=palette[i%3];ctx.beginPath();ctx.moveTo(7,Math.sin(a)*4);ctx.quadraticCurveTo(18,-7-i*2,22+Math.sin(now*.02+i)*4,-14-i);ctx.quadraticCurveTo(20,1,7,Math.sin(a)*4);ctx.fill();}}
        if(move==='thunderpunch'){ctx.strokeStyle='#fff4a6';ctx.lineWidth=2;for(let i=0;i<4;i++){const a=i*TAU/4;ctx.beginPath();ctx.moveTo(10+Math.cos(a)*7,Math.sin(a)*7);ctx.lineTo(10+Math.cos(a+.2)*13,Math.sin(a+.2)*13-5);ctx.lineTo(10+Math.cos(a-.08)*19,Math.sin(a-.08)*19+3);ctx.stroke();}}
        if(move==='icepunch'){for(let i=0;i<4;i++){const a=i*TAU/4;ctx.save();ctx.translate(12+Math.cos(a)*radius*.7,Math.sin(a)*radius*.55);ctx.rotate(a);ctx.fillStyle='#d6fbff';ctx.strokeStyle='#6bc3e6';ctx.beginPath();ctx.moveTo(0,-5);ctx.lineTo(3,0);ctx.lineTo(0,5);ctx.lineTo(-2,1);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();}}
        if(move==='drainpunch'){ctx.strokeStyle='#b7ffca';ctx.lineWidth=2;for(let i=0;i<3;i++){ctx.beginPath();ctx.moveTo(-12,(i-1)*5);ctx.quadraticCurveTo(-2,(i-1)*17,14,(i-1)*2);ctx.stroke();}}
      }else if(e.kind==='vineWhip'){
        const move=e.move;ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1));ctx.globalCompositeOperation='lighter';ctx.lineCap='round';ctx.lineJoin='round';
        for(let vine=0;vine<(move==='powerwhip'?4:3);vine++){const offset=(vine-(move==='powerwhip'?1.5:1))*6,reach=22+t*28;ctx.strokeStyle=vine%2?'#3da950':'#90e966';ctx.lineWidth=(move==='powerwhip'?4.5:2.5)*(1-t*.35);ctx.beginPath();ctx.moveTo(0,offset);ctx.bezierCurveTo(reach*.35,offset-14+vine*3,reach*.62,offset+12-vine*4,reach,offset+Math.sin(now*.02+vine)*5);ctx.stroke();
          const tx=reach*.62,ty=offset+4;ctx.fillStyle=vine%2?'#d7ff9b':'#5bc968';ctx.beginPath();ctx.moveTo(tx-4,ty);ctx.quadraticCurveTo(tx+1,ty-8,tx+9,ty-7);ctx.quadraticCurveTo(tx+6,ty,tx-4,ty);ctx.fill();
          if(move==='powerwhip')for(let thorn=0;thorn<3;thorn++){const tt=.25+thorn*.2,xx=reach*tt,yy=offset+Math.sin(tt*Math.PI)*4;ctx.fillStyle='#d9ff9b';ctx.beginPath();ctx.moveTo(xx,yy);ctx.lineTo(xx+5,yy-4);ctx.lineTo(xx+2,yy+2);ctx.closePath();ctx.fill();}
        }
      }else if(e.kind==='bodySlamLaunch'){
        const radius=10+t*42;ctx.strokeStyle='#e9d9b7';ctx.lineWidth=3*(1-t)+.6;ctx.beginPath();ctx.ellipse(0,5,radius,radius*.34,0,0,TAU);ctx.stroke();ctx.strokeStyle='#fff1d0';ctx.lineWidth=1.4;
        for(let i=0;i<7;i++){const a=i*TAU/7+t*.6,r0=radius*.38,r1=radius*(.75+((i%3)*.08));ctx.beginPath();ctx.moveTo(Math.cos(a)*r0,5+Math.sin(a)*r0*.35);ctx.lineTo(Math.cos(a+.09)*r1,5+Math.sin(a+.09)*r1*.35);ctx.stroke();}
      }else if(e.kind==='combatFlurry'){
        ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1));ctx.globalCompositeOperation='lighter';
        for(let i=0;i<5;i++){ctx.strokeStyle=i%2?'#fff4d3':c;ctx.lineWidth=4-i*.45;ctx.beginPath();const offset=(i-2)*.12;ctx.arc((i-2)*4,0,12+i*5,-1.05+offset+t*.4,.25+offset+t*.4);ctx.stroke();}
        for(let i=0;i<4;i++){const a=now*.013+i*TAU/4;ctx.fillStyle='#fff4d3';ctx.beginPath();ctx.arc(Math.cos(a)*24,Math.sin(a)*14,2,0,TAU);ctx.fill();}
      }else if(e.kind==='biteImpact'){
        ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1));const radius=12+t*20;ctx.globalCompositeOperation='lighter';ctx.strokeStyle=e.move==='crunch'?'#c8a4ff':e.move==='bugbite'?'#ceec87':'#fff0d1';ctx.lineWidth=3;ctx.beginPath();ctx.arc(0,0,radius,-1.15,-.1);ctx.stroke();ctx.beginPath();ctx.arc(0,0,radius,.1,1.15);ctx.stroke();for(let i=0;i<6;i++){const a=-.85+i*.34;ctx.fillStyle='#fff';ctx.beginPath();ctx.moveTo(Math.cos(a)*radius,Math.sin(a)*radius*.65);ctx.lineTo(Math.cos(a+.08)*(radius-6),Math.sin(a+.08)*(radius-6)*.65);ctx.lineTo(Math.cos(a+.16)*(radius+1),Math.sin(a+.16)*(radius+1)*.65);ctx.fill();}
      }else if(e.kind==='leechDrain'){
        ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1));ctx.globalCompositeOperation='lighter';const radius=12+t*25;for(let i=0;i<4;i++){ctx.strokeStyle=i%2?'#baffaa':'#48cf71';ctx.lineWidth=2.8-i*.4;ctx.beginPath();ctx.moveTo(-radius*.65,(i-1.5)*4);ctx.bezierCurveTo(-radius*.25,-radius*.6,radius*.38,radius*.6,radius,Math.sin(now*.02+i)*4);ctx.stroke();}for(let i=0;i<4;i++){const a=i*TAU/4+now*.005;ctx.fillStyle='#e3ffb5';ctx.beginPath();ctx.ellipse(Math.cos(a)*radius*.6,Math.sin(a)*radius*.38,3,1.5,a,0,TAU);ctx.fill();}
      }else if(e.kind==='drillPeck'){
        ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1));ctx.globalCompositeOperation='lighter';const radius=10+t*24;for(let i=0;i<4;i++){ctx.strokeStyle=i%2?'#d5f0ff':'#77bce8';ctx.lineWidth=2.3;ctx.beginPath();ctx.ellipse(i*3,0,radius*(.48+i*.13),radius*(.25+i*.06),now*.015+i*.6,0,TAU);ctx.stroke();}ctx.fillStyle='#fff';ctx.beginPath();ctx.moveTo(radius,0);ctx.lineTo(radius*.5,-5);ctx.lineTo(radius*.5,5);ctx.closePath();ctx.fill();
      }else if(e.kind==='xScissor'){
        ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1));ctx.globalCompositeOperation='lighter';
        for(let pass=0;pass<2;pass++){ctx.save();ctx.rotate(pass?-.72:.72);ctx.strokeStyle=pass?'#ffe5a0':'#b5ed68';ctx.lineWidth=6*(1-t)+1;ctx.beginPath();ctx.moveTo(-15,-19);ctx.quadraticCurveTo(2,-7,30+t*6,1);ctx.stroke();ctx.strokeStyle='#fff';ctx.lineWidth=1.8;ctx.beginPath();ctx.moveTo(-12,-18);ctx.lineTo(27+t*6,0);ctx.stroke();ctx.restore();}
        ctx.strokeStyle='#e8ffb5';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(15,-10);ctx.lineTo(24,-2);ctx.lineTo(15,6);ctx.moveTo(21,-12);ctx.lineTo(30,-4);ctx.lineTo(21,4);ctx.stroke();
      }else if(e.kind==='shadowClaw'){
        ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1));ctx.globalCompositeOperation='lighter';
        for(let i=0;i<4;i++){ctx.save();ctx.rotate((i-1.5)*.18);ctx.strokeStyle=i%2?'#c5a0ff':'#6a48b7';ctx.lineWidth=5-i*.6;ctx.beginPath();ctx.moveTo(-6,-18+i*3);ctx.bezierCurveTo(7,-12+i*4,17,-5+i*2,30+t*9,0);ctx.stroke();ctx.restore();}
        ctx.strokeStyle='#f0dcff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(8,0,13+t*5,-.9,.9);ctx.stroke();
      }else if(e.kind==='fireWheel'){
        ctx.globalCompositeOperation='lighter';const radius=11+t*24;ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1)+now*.007);
        for(let i=0;i<9;i++){const a=i*TAU/9,reach=radius*(.78+(i%3)*.13);ctx.save();ctx.rotate(a);ctx.fillStyle=['#ff4b25','#ff982f','#ffd05e'][i%3];ctx.beginPath();ctx.moveTo(0,0);ctx.quadraticCurveTo(5,-reach*.42,2,-reach);ctx.quadraticCurveTo(-5,-reach*.48,0,0);ctx.fill();ctx.restore();}
        ctx.strokeStyle='#fff1a2';ctx.lineWidth=2.3;ctx.beginPath();ctx.ellipse(0,0,radius,radius*.65,0,0,TAU);ctx.stroke();ctx.strokeStyle='#ff682d';ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(0,0,radius*.72,radius*.45,now*.01,0,TAU);ctx.stroke();
      }else if(e.kind==='waterSlash'){
        ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1));ctx.globalCompositeOperation='lighter';const radius=16+t*24;
        ctx.strokeStyle='#d6fbff';ctx.lineWidth=8*(1-t)+1.2;ctx.beginPath();ctx.arc(4,0,radius,-1.15,.9);ctx.stroke();ctx.strokeStyle='#45c8ff';ctx.lineWidth=4*(1-t)+.8;ctx.beginPath();ctx.arc(4,0,radius*.85,-1.05,.95);ctx.stroke();ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(4,0,radius*.7,-.95,.9);ctx.stroke();
        for(let i=0;i<7;i++){const a=-1+i*.31,rr=radius*(.65+(i%3)*.13);ctx.fillStyle=i%2?'#7de4ff':'#efffff';ctx.beginPath();ctx.arc(Math.cos(a)*rr,Math.sin(a)*rr*.6,1.5+(i%2),0,TAU);ctx.fill();}
      }else if(e.kind==='clawArc'){
        ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1));ctx.globalCompositeOperation='lighter';
        for(let i=0;i<3;i++){ctx.save();ctx.rotate((i-1)*.28);ctx.strokeStyle=i===1?'#fff5d6':c;ctx.lineWidth=4-i*.6;ctx.beginPath();ctx.moveTo(-7,-17+i*4);ctx.quadraticCurveTo(9,-7+i*3,25+t*12,0);ctx.stroke();ctx.restore();}
      }else if(e.kind==='fairyImpact'){
        ctx.globalCompositeOperation='lighter';for(let i=0;i<8;i++){const a=i*TAU/8+now*.003,radius=9+t*27,xx=Math.cos(a)*radius,yy=Math.sin(a)*radius*.7;ctx.save();ctx.translate(xx,yy);ctx.rotate(a);ctx.fillStyle=i%2?'#ff8fe2':'#fff4ff';ctx.beginPath();for(let j=0;j<8;j++){const a2=-Math.PI/2+j*Math.PI/4,rr=j%2?2.2:5;ctx.lineTo(Math.cos(a2)*rr,Math.sin(a2)*rr);}ctx.closePath();ctx.fill();ctx.restore();}ctx.strokeStyle='#ffc5f2';ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,10+t*21,0,TAU);ctx.stroke();
      }else if(e.kind==='heavyImpact'){
        const radius=8+t*29;ctx.globalCompositeOperation='lighter';ctx.strokeStyle=e.move==='ironhead'?'#e6f7ff':'#fff0c8';ctx.lineWidth=3*(1-t)+.8;ctx.beginPath();ctx.ellipse(0,0,radius,radius*.62,0,0,TAU);ctx.stroke();
        for(let i=0;i<8;i++){const a=i*TAU/8+Math.PI/8,inner=radius*.25,outer=radius*(.7+(i%3)*.14);ctx.strokeStyle=i%2?'#fff':'#ffd98e';ctx.lineWidth=i%2?1.6:2.6;ctx.beginPath();ctx.moveTo(Math.cos(a)*inner,Math.sin(a)*inner);ctx.lineTo(Math.cos(a+.1)*outer,Math.sin(a+.1)*outer);ctx.stroke();}
        if(e.move==='ironhead'){ctx.fillStyle='#c9efff';for(let i=0;i<3;i++){const a=now*.01+i*TAU/3;ctx.fillRect(Math.cos(a)*radius*.8-2,Math.sin(a)*radius*.5-2,4,4);}}
      }else if(e.kind==='moveImpact'){
        const m=e.move,radius=9+t*38;ctx.globalCompositeOperation='lighter';
        if(this.drawSignatureImpact(e,t,now,c,radius)){}else if(m==='fireblast'){
          ctx.rotate(now*.002);ctx.strokeStyle='#ff652b';ctx.lineWidth=5*(1-t)+1;ctx.beginPath();ctx.arc(0,0,radius,0,TAU);ctx.stroke();ctx.strokeStyle='#ffe58a';ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,radius*.63,0,TAU);ctx.stroke();
          for(let i=0;i<10;i++){const a=i*TAU/10,inner=radius*.42,outer=radius*(.88+(i%2)*.22);ctx.strokeStyle=i%2?'#fff0a8':'#ff693b';ctx.lineWidth=i%2?2:4;ctx.beginPath();ctx.moveTo(Math.cos(a)*inner,Math.sin(a)*inner);ctx.lineTo(Math.cos(a)*outer,Math.sin(a)*outer);ctx.stroke();}
          ctx.fillStyle='#fff1aa';ctx.beginPath();ctx.arc(0,0,Math.max(2,9*(1-t)),0,TAU);ctx.fill();
        }else if(['volttackle','wildcharge'].includes(m)){
          ctx.strokeStyle='#fff4a0';ctx.lineWidth=3;for(let i=0;i<7;i++){const a=i*TAU/7+now*.008,r0=radius*.22,r1=radius*(.7+(i%3)*.13);ctx.beginPath();ctx.moveTo(Math.cos(a)*r0,Math.sin(a)*r0);ctx.lineTo(Math.cos(a)*r1*.45+4,Math.sin(a)*r1*.45);ctx.lineTo(Math.cos(a+.12)*r1,Math.sin(a+.12)*r1);ctx.stroke();}
          ctx.strokeStyle='#54cfff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(0,0,radius*.54,0,TAU);ctx.stroke();
        }else if(m==='flareblitz'){
          for(let i=0;i<7;i++){const a=i*TAU/7,reach=radius*(.65+(i%3)*.18);ctx.save();ctx.rotate(a);ctx.fillStyle=i%2?'#ff612a':'#ffbd4b';ctx.beginPath();ctx.moveTo(0,0);ctx.quadraticCurveTo(8,-reach*.5,0,-reach);ctx.quadraticCurveTo(-7,-reach*.45,0,0);ctx.fill();ctx.restore();}
        }else if(m==='aquajet'){
          ctx.strokeStyle='#d8fbff';ctx.lineWidth=2.5;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,radius*(.4+i*.25),radius*(.23+i*.15),0,0,TAU);ctx.stroke();}for(let i=0;i<7;i++){const a=i*TAU/7;ctx.fillStyle='#8ce6ff';ctx.beginPath();ctx.arc(Math.cos(a)*radius*.8,Math.sin(a)*radius*.5,2+(i%2),0,TAU);ctx.fill();}
        }else if(m==='headsmash'){
          const radius=10+t*36;ctx.strokeStyle='#c7dff5';ctx.lineWidth=3*(1-t)+1;ctx.beginPath();ctx.ellipse(0,0,radius,radius*.6,0,0,TAU);ctx.stroke();ctx.fillStyle='#93a7bf';for(let i=0;i<10;i++){const a=i*TAU/10,rr=radius*(.65+(i%3)*.13);ctx.save();ctx.translate(Math.cos(a)*rr,Math.sin(a)*rr*.55);ctx.rotate(a);ctx.beginPath();ctx.moveTo(-2,-5);ctx.lineTo(3,-8);ctx.lineTo(5,2);ctx.lineTo(-3,4);ctx.closePath();ctx.fill();ctx.restore();}
        }else if(['bite','crunch','bugbite'].includes(m)){
          const radius=9+t*27;ctx.strokeStyle=m==='crunch'?'#ba9bf4':m==='bugbite'?'#c0e875':'#e7d5ac';ctx.lineWidth=3;ctx.beginPath();ctx.arc(0,0,radius,-1.1,-.12);ctx.stroke();ctx.beginPath();ctx.arc(0,0,radius,.12,1.1);ctx.stroke();for(let i=0;i<5;i++){const a=-.8+i*.4;ctx.fillStyle='#fff';ctx.beginPath();ctx.moveTo(Math.cos(a)*radius,Math.sin(a)*radius*.65);ctx.lineTo(Math.cos(a+.1)*(radius-5),Math.sin(a+.1)*(radius-5)*.65);ctx.lineTo(Math.cos(a+.19)*(radius+2),Math.sin(a+.19)*(radius+2)*.65);ctx.fill();}
        }else if(m==='leechlife'){
          const radius=9+t*30;ctx.globalCompositeOperation='lighter';ctx.strokeStyle='#a5f48c';ctx.lineWidth=3;for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(0,0,radius*(.45+i*.22),-1.8+i*.15,1.4+i*.15);ctx.stroke();}for(let i=0;i<6;i++){const a=i*TAU/6+now*.004;ctx.fillStyle=i%2?'#d6ffab':'#50c76a';ctx.beginPath();ctx.ellipse(Math.cos(a)*radius*.7,Math.sin(a)*radius*.45,3,1.5,a,0,TAU);ctx.fill();}
        }else if(['bodyslam','struggle','doubleedge','takedown','headbutt','zenheadbutt','ironhead','tackle','pound','strength','stomp'].includes(m)){
          ctx.strokeStyle=m==='ironhead'?'#d3f3ff':'#f3d9a6';ctx.lineWidth=3*(1-t)+1;ctx.beginPath();ctx.ellipse(0,0,radius,radius*.52,0,0,TAU);ctx.stroke();
          for(let i=0;i<9;i++){const a=i*TAU/9,inner=radius*.35,outer=radius*(.7+(i%3)*.12);ctx.strokeStyle=i%2?'#d7c5a0':'#fff0c8';ctx.lineWidth=i%2?1.3:2;ctx.beginPath();ctx.moveTo(Math.cos(a)*inner,Math.sin(a)*inner*.6);ctx.lineTo(Math.cos(a+.08)*outer,Math.sin(a+.08)*outer*.6);ctx.stroke();}
          if(m==='struggle'){ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(-radius*.4,-radius*.2);ctx.lineTo(-radius*.1,radius*.15);ctx.lineTo(radius*.1,-radius*.16);ctx.lineTo(radius*.42,radius*.14);ctx.stroke();}
        }else if(m==='closecombat'){
          for(let i=0;i<4;i++){ctx.save();ctx.rotate(i*TAU/4+t);ctx.strokeStyle=i%2?'#fff0ca':c;ctx.lineWidth=3;ctx.beginPath();ctx.arc(0,0,radius*.7,-1.1,1.1);ctx.stroke();ctx.restore();}
        }else if(m==='playrough'){
          for(let i=0;i<8;i++){const a=i*TAU/8+now*.004;ctx.fillStyle=i%2?'#ffc4f2':'#fff';ctx.beginPath();ctx.arc(Math.cos(a)*radius*.75,Math.sin(a)*radius*.45,2.5,0,TAU);ctx.fill();}
        }else{
          ctx.strokeStyle='#fff5d5';ctx.lineWidth=4*(1-t)+1;for(let i=0;i<3;i++){ctx.save();ctx.rotate((i-1)*.25);ctx.beginPath();ctx.arc(0,0,radius*.7,-.85,.85);ctx.stroke();ctx.restore();}
        }
      }else if(e.kind==='wispHit'){
        ctx.globalCompositeOperation='lighter';for(let i=0;i<5;i++){const a=i*TAU/5+now*.004,reach=13+t*10;ctx.save();ctx.rotate(a);ctx.fillStyle=i%2?'#7d6bf4':'#c0b4ff';ctx.beginPath();ctx.moveTo(0,0);ctx.quadraticCurveTo(reach*.8,-reach*.35,reach*.3,-reach);ctx.quadraticCurveTo(-reach*.8,-reach*.45,0,0);ctx.fill();ctx.restore();}ctx.strokeStyle='#c9bcff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(0,0,12+t*10,0,TAU);ctx.stroke();
      }else if(e.kind==='slash'&&e.move==='scratch'){ctx.rotate(Math.atan2(e.direction?.y||0,e.direction?.x||1));ctx.globalCompositeOperation='lighter';for(let i=0;i<3;i++){ctx.save();ctx.rotate((i-1)*.17);ctx.strokeStyle=i===1?'#fffbdc':'#d8deea';ctx.lineWidth=4-i*.55;ctx.beginPath();ctx.moveTo(1,-13+i*7);ctx.quadraticCurveTo(10,-4+i*7,22+t*12,1+i*7);ctx.stroke();ctx.restore();}ctx.fillStyle='#fff5bf';ctx.beginPath();ctx.arc(24+t*8,0,2.2,0,TAU);ctx.fill();}
      else if(e.kind==='slash'){const angle=Math.atan2(e.direction?.y||0,e.direction?.x||1);ctx.rotate(angle);ctx.lineWidth=6*(1-t)+1;ctx.beginPath();ctx.arc(0,0,32+t*45,-1.1+t*.6,1.1+t*.6);ctx.stroke();ctx.strokeStyle='#ffffe6';ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,29+t*42,-.9+t*.6,.9+t*.6);ctx.stroke();}
      else if(e.kind==='pulse'&&e.move==='earthquake'){
        // Earthquake: fractured ground, pressure rings, and kicked-up stone shards.
        const radius=Math.max(20,e.radius||170)*t;ctx.globalCompositeOperation='source-over';ctx.globalAlpha=(1-t)*.95;
        ctx.strokeStyle='#201d23';ctx.lineWidth=5*(1-t)+1;ctx.beginPath();ctx.ellipse(0,0,radius,radius*.67,0,0,TAU);ctx.stroke();
        ctx.strokeStyle='#bca27a';ctx.lineWidth=2.5*(1-t)+.5;ctx.beginPath();ctx.ellipse(0,0,radius*.88,radius*.58,0,0,TAU);ctx.stroke();
        for(let i=0;i<14;i++){const a=i*TAU/14+.09,inner=radius*(.16+(i%3)*.045),outer=radius*(.72+(i%4)*.065),bend=a+((i%2)?1:-1)*.11;
          ctx.strokeStyle=i%2?'#302b2a':'#e1c99a';ctx.lineWidth=i%3===0?3:1.6;ctx.beginPath();ctx.moveTo(Math.cos(a)*inner,Math.sin(a)*inner*.67);ctx.lineTo(Math.cos(bend)*outer*.52,Math.sin(bend)*outer*.35);ctx.lineTo(Math.cos(a-.04)*outer,Math.sin(a-.04)*outer*.67);ctx.stroke();
          if(i%2===0){ctx.beginPath();ctx.moveTo(Math.cos(bend)*outer*.52,Math.sin(bend)*outer*.35);ctx.lineTo(Math.cos(bend+.24)*outer*.73,Math.sin(bend+.24)*outer*.48);ctx.stroke();}
        }
        for(let i=0;i<10;i++){const a=i*TAU/10+now*.0002,rr=radius*(.5+(i%3)*.14),xx=Math.cos(a)*rr,yy=Math.sin(a)*rr*.62;ctx.save();ctx.translate(xx,yy-5*(1-t));ctx.rotate(a);ctx.fillStyle=i%2?'#d6bf91':'#8c8069';ctx.beginPath();ctx.moveTo(-3,-2);ctx.lineTo(2,-6);ctx.lineTo(5,1);ctx.lineTo(-1,4);ctx.closePath();ctx.fill();ctx.restore();}
      }else if(e.kind==='pulse'&&e.move==='bulldoze'){
        // Bulldoze: low, rolling earth waves with heavy chunks of soil.
        const radius=Math.max(20,e.radius||170)*t;ctx.globalAlpha=(1-t)*.85;ctx.strokeStyle='#9b8058';ctx.lineWidth=5*(1-t)+1;
        for(let ring=0;ring<3;ring++){const r=radius*(.5+ring*.22);ctx.beginPath();ctx.ellipse(0,0,r,r*(.35+ring*.07),Math.sin(now*.002+ring)*.06,Math.PI*.08,Math.PI*.92);ctx.stroke();}
        ctx.globalAlpha=(1-t)*.9;for(let i=0;i<12;i++){const a=i*TAU/12+now*.001,rr=radius*(.5+(i%3)*.12);ctx.save();ctx.translate(Math.cos(a)*rr,Math.sin(a)*rr*.46);ctx.rotate(a+now*.003);ctx.fillStyle=i%2?'#bd9b68':'#78654a';ctx.beginPath();ctx.moveTo(-4,-3);ctx.lineTo(-1,-8);ctx.lineTo(6,-4);ctx.lineTo(4,4);ctx.lineTo(-3,3);ctx.closePath();ctx.fill();ctx.restore();}
      }else if(e.kind==='pulse'&&e.move==='discharge'){
        // Discharge: a burst of forked electricity rather than a plain circle.
        const radius=Math.max(20,e.radius||170)*t;ctx.globalCompositeOperation='lighter';ctx.strokeStyle='#ffe75c';ctx.lineWidth=2.6;ctx.shadowBlur=17;
        for(let i=0;i<12;i++){const a=i*TAU/12+now*.001,inner=radius*(.22+(i%3)*.07),outer=radius*(.74+(i%4)*.06),mx=Math.cos(a+.08)*outer*.52,my=Math.sin(a+.08)*outer*.52*.7;
          ctx.beginPath();ctx.moveTo(Math.cos(a)*inner,Math.sin(a)*inner*.7);ctx.lineTo(mx,my);ctx.lineTo(Math.cos(a-.08)*outer,Math.sin(a-.08)*outer*.7);ctx.stroke();
          if(i%2===0){ctx.strokeStyle='#fffbd4';ctx.beginPath();ctx.moveTo(mx,my);ctx.lineTo(mx+Math.cos(a+1)*9,my+Math.sin(a+1)*7);ctx.stroke();ctx.strokeStyle='#ffe75c';}
        }
        ctx.strokeStyle='#fffbd4';ctx.lineWidth=1.4;ctx.beginPath();ctx.ellipse(0,0,radius*.33,radius*.23,0,0,TAU);ctx.stroke();
      }else if(e.kind==='pulse'&&e.move==='dazzlinggleam'){
        const radius=Math.max(20,e.radius||170)*t;ctx.globalCompositeOperation='lighter';ctx.strokeStyle='#ffc2ee';ctx.lineWidth=2;
        for(let i=0;i<18;i++){const a=i*TAU/18+now*.0006,r0=radius*.18,r1=radius*(.7+(i%3)*.1);ctx.beginPath();ctx.moveTo(Math.cos(a)*r0,Math.sin(a)*r0*.72);ctx.lineTo(Math.cos(a)*r1,Math.sin(a)*r1*.72);ctx.stroke();}
        for(let i=0;i<9;i++){const a=i*TAU/9-now*.0008,rr=radius*(.35+(i%2)*.28),xx=Math.cos(a)*rr,yy=Math.sin(a)*rr*.68;ctx.save();ctx.translate(xx,yy);ctx.rotate(a);ctx.fillStyle=i%2?'#fff':'#ff9fe2';ctx.beginPath();for(let j=0;j<8;j++){const theta=-Math.PI/2+j*Math.PI/4,r=j%2?2.5:6;ctx.lineTo(Math.cos(theta)*r,Math.sin(theta)*r);}ctx.closePath();ctx.fill();ctx.restore();}
      }else if(e.kind==='pulse'&&e.move==='hypervoice'){
        const radius=Math.max(20,e.radius||170)*t;ctx.strokeStyle='#f3deff';ctx.lineWidth=3*(1-t)+.8;
        for(let ring=0;ring<4;ring++){const r=radius*(.38+ring*.18),wobble=4+ring*2;ctx.beginPath();for(let j=0;j<=32;j++){const a=j*TAU/32,rad=r+Math.sin(a*5+now*.009+ring)*wobble;const x=Math.cos(a)*rad,y=Math.sin(a)*rad*.57;j?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();}
      }else if(e.kind==='pulse'&&e.move==='snarl'){
        const radius=Math.max(20,e.radius||170)*t;ctx.strokeStyle='#8c73ca';ctx.lineWidth=2.4;ctx.globalCompositeOperation='lighter';
        for(let i=0;i<5;i++){const r=radius*(.3+i*.14);ctx.beginPath();for(let j=0;j<=28;j++){const a=j*TAU/28,spike=Math.sin(a*7+now*.006+i)*4;const x=Math.cos(a)*(r+spike),y=Math.sin(a)*(r+spike)*.62;j?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();}
        for(let i=0;i<8;i++){const a=i*TAU/8+now*.001;ctx.strokeStyle='#c2abff';ctx.beginPath();ctx.moveTo(Math.cos(a)*radius*.22,Math.sin(a)*radius*.15);ctx.lineTo(Math.cos(a)*radius*.74,Math.sin(a)*radius*.45);ctx.stroke();}
      }else if(e.kind==='pulse'&&e.move==='strugglebug'){
        const radius=Math.max(20,e.radius||170)*t;ctx.globalCompositeOperation='lighter';ctx.strokeStyle='#b5e85e';ctx.lineWidth=2;
        for(let i=0;i<12;i++){const a=i*TAU/12+now*.0015,r0=radius*.2,r1=radius*(.68+(i%3)*.09);ctx.beginPath();ctx.moveTo(Math.cos(a)*r0,Math.sin(a)*r0*.7);ctx.lineTo(Math.cos(a+.06)*r1*.53,Math.sin(a+.06)*r1*.35);ctx.lineTo(Math.cos(a-.06)*r1,Math.sin(a-.06)*r1*.7);ctx.stroke();}
        for(let i=0;i<8;i++){const a=i*TAU/8-now*.002,rr=radius*(.45+(i%3)*.12);ctx.fillStyle=i%2?'#edffac':'#80bd45';ctx.beginPath();ctx.ellipse(Math.cos(a)*rr,Math.sin(a)*rr*.6,3,1.4,a,0,TAU);ctx.fill();}
      }else if(e.kind==='pulse'){
        ctx.lineWidth=3;for(let j=0;j<2;j++){const r=8+clamp(t-j*.15,0,1)*Math.min(185,e.radius||170);ctx.beginPath();ctx.ellipse(0,0,r,r*.7,0,0,TAU);ctx.stroke();}
      }
      else if(e.kind==='summon'){ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,0,15+t*33,8+t*17,0,0,TAU);ctx.stroke();ctx.fillStyle='#fff5ce';ctx.fillRect(-2,-55*(1-t),4,55*(1-t));}
      else if(e.kind==='transformAura'){
        ctx.globalCompositeOperation='lighter';const radius=18+t*31;for(let i=0;i<4;i++){ctx.save();ctx.rotate(now*.004*(i%2?1:-1)+i*TAU/4);ctx.strokeStyle=i%2?'#e4d6ff':'#a2e7ff';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,0,radius*(.7+i*.09),radius*(.38+i*.06),0,-1.7,1.7);ctx.stroke();ctx.restore();}ctx.fillStyle='#fff';ctx.globalAlpha=(1-t)*.9;ctx.beginPath();ctx.arc(0,0,7+t*8,0,TAU);ctx.fill();ctx.globalAlpha=1;for(let i=0;i<8;i++){const a=i*TAU/8+now*.002,rr=radius*(.7+(i%3)*.1);ctx.fillStyle=i%2?'#d7c4ff':'#b7f5ff';ctx.fillRect(Math.cos(a)*rr-1.5,Math.sin(a)*rr*.58-1.5,3,3);}
      }else if(e.kind==='self'&&['counter','mirrorcoat'].includes(e.move)){
        ctx.globalCompositeOperation='lighter';ctx.strokeStyle=e.move==='counter'?'#ffbf9c':'#b8eaff';ctx.lineWidth=2.2;const r=19+t*20;ctx.beginPath();ctx.arc(0,0,r,-1.3,1.3);ctx.stroke();ctx.beginPath();ctx.arc(0,0,r,.6,3.5);ctx.stroke();for(let i=0;i<5;i++){const a=i*TAU/5+now*.004;ctx.fillStyle=e.move==='counter'?'#fff0c9':'#e3fbff';ctx.beginPath();ctx.moveTo(Math.cos(a)*r,Math.sin(a)*r*.6);ctx.lineTo(Math.cos(a+.13)*(r+7),Math.sin(a+.13)*(r+7)*.6);ctx.lineTo(Math.cos(a-.1)*(r+4),Math.sin(a-.1)*(r+4)*.6);ctx.fill();}
      }else if(e.kind==='self'&&['protect','detect'].includes(e.move)){
        const r=22+t*9;ctx.globalCompositeOperation='lighter';ctx.strokeStyle='#a7e5ff';ctx.lineWidth=2;ctx.beginPath();for(let i=0;i<7;i++){const a=-Math.PI/2+i*TAU/6,xx=Math.cos(a)*r,yy=Math.sin(a)*r*.72;i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy);}ctx.closePath();ctx.stroke();ctx.fillStyle='#c5f4ff15';ctx.fill();ctx.strokeStyle='#f8ffff';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(0,0,r*.6,r*.4,0,0,TAU);ctx.stroke();
      }else if(e.kind==='self'&&['recover','milkdrink','softboiled','slackoff','healorder','rest'].includes(e.move)){
        ctx.globalCompositeOperation='lighter';for(let i=0;i<3;i++){const r=8+t*30+i*6;ctx.strokeStyle=i%2?'#d5ffad':'#fff5c5';ctx.lineWidth=2-i*.3;ctx.beginPath();ctx.ellipse(0,-t*16,r,r*.48,now*.002+i,0,TAU);ctx.stroke();}
        for(let i=0;i<9;i++){const a=i*TAU/9+now*.001,rr=14+t*30;ctx.fillStyle=i%2?'#9df27c':'#fff1a5';ctx.beginPath();ctx.arc(Math.cos(a)*rr,Math.sin(a)*rr*.5-t*12,1.5+(i%3)*.4,0,TAU);ctx.fill();}
      }else if(e.kind==='self'&&['swordsdance','irondefense','defensecurl','harden','acidarmor'].includes(e.move)){
        ctx.globalCompositeOperation='lighter';const r=15+t*26;for(let i=0;i<3;i++){ctx.save();ctx.rotate(now*.004+i*TAU/3);ctx.strokeStyle=i%2?'#fff5d2':'#d5e7ff';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(r*.4,-r*.9);ctx.lineTo(r*.68,0);ctx.lineTo(r*.4,r*.9);ctx.stroke();ctx.restore();}
        ctx.strokeStyle='#fff0bd';ctx.lineWidth=1.5;ctx.beginPath();ctx.ellipse(0,0,r,r*.5,0,0,TAU);ctx.stroke();
      }else if(e.kind==='self'&&['agility','dragondance'].includes(e.move)){
        ctx.globalCompositeOperation='lighter';for(let i=0;i<5;i++){const a=i*TAU/5+now*.005,r=12+t*32;ctx.strokeStyle=i%2?'#fff':'#a8e6ff';ctx.lineWidth=2;ctx.beginPath();ctx.arc(Math.cos(a)*r*.22,Math.sin(a)*r*.13,r*.7,-1.1,.9);ctx.stroke();}
        if(e.move==='dragondance'){ctx.strokeStyle='#8eb6ff';ctx.lineWidth=2.4;ctx.beginPath();ctx.ellipse(0,0,20+t*18,10+t*8,now*.01,0,TAU);ctx.stroke();}
      }else if(e.kind==='self'&&['calmmind','nastyplot','amnesia','workup','bulkup'].includes(e.move)){
        ctx.globalCompositeOperation='lighter';const color=e.move==='calmmind'||e.move==='amnesia'?'#c6a5ff':'#ffd98f';ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,-t*10,14+t*22,8+t*12,0,0,TAU);ctx.stroke();
        for(let i=0;i<5;i++){const a=now*.003+i*TAU/5,rr=15+t*22;ctx.fillStyle=i%2?'#fff5d4':color;ctx.beginPath();ctx.arc(Math.cos(a)*rr,Math.sin(a)*rr*.52-t*8,2.1,0,TAU);ctx.fill();}
      }else if(e.kind==='self'||e.kind==='heal'||e.kind==='boost'){
        ctx.globalCompositeOperation='lighter';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,-t*25,18+Math.sin(t*Math.PI)*8,9,0,0,TAU);ctx.stroke();for(let j=0;j<5;j++){ctx.fillStyle=j%2?'#e8fca9':'#fff4d1';ctx.fillRect(Math.cos(j*2.1+now*.002)*17,-t*45-j*3,3,5);}
      }
      else{ctx.lineWidth=2*(1-t)+1;const radius=e.kind==='muzzle'?4+t*12:5+t*26;ctx.beginPath();ctx.arc(0,0,radius,0,TAU);ctx.stroke();}
      ctx.restore();
    }
  }

  drawSignatureImpact(e,t,now,c,radius) {
    const ctx=this.ctx,m=e.move,fade=1-t;
    const star=(x,y,outer,inner,points,rotation,fill)=>{
      ctx.beginPath();
      for(let i=0;i<points*2;i++){
        const a=rotation+i*Math.PI/points,r=i%2?inner:outer,px=x+Math.cos(a)*r,py=y+Math.sin(a)*r;
        i?ctx.lineTo(px,py):ctx.moveTo(px,py);
      }
      ctx.closePath();if(fill){ctx.fillStyle=fill;ctx.fill();}
    };
    ctx.save();ctx.globalCompositeOperation='lighter';ctx.globalAlpha=fade*.88;ctx.lineCap='round';ctx.lineJoin='round';

    if(m==='flamethrower'||m==='ember'||m==='firepunch'||m==='firefang'){
      const scale=m==='flamethrower'?1.15:m==='ember'?.58:.82;
      for(let i=0;i<7;i++){
        const a=i*TAU/7,inner=radius*.12*scale,outer=radius*(.52+(i%3)*.12)*scale;
        ctx.save();ctx.rotate(a);ctx.fillStyle=i%3===0?'#fff5bb':i%3===1?'#ffba43':'#f25a29';
        ctx.beginPath();ctx.moveTo(inner,-2);ctx.quadraticCurveTo(outer*.42,-outer*.9,outer,-outer*.12);ctx.quadraticCurveTo(outer*.72,outer*.08,inner,3);ctx.fill();ctx.restore();
      }
      ctx.fillStyle='#fff4b5';ctx.beginPath();ctx.ellipse(0,0,Math.max(3,radius*.17),Math.max(3,radius*.13),0,0,TAU);ctx.fill();
      ctx.restore();return true;
    }
    if(m==='hydropump'||m==='watergun'||m==='surf'||m==='waterpulse'){
      const scale=m==='hydropump'?1.3:m==='surf'?1.1:.78;
      ctx.strokeStyle='#d8fbff';ctx.lineWidth=3.5*fade+1;ctx.beginPath();ctx.moveTo(-radius*.86*scale,radius*.1);
      ctx.bezierCurveTo(-radius*.68,-radius*.52*scale,-radius*.26,-radius*.12*scale,0,-radius*.48*scale);
      ctx.bezierCurveTo(radius*.36,-radius*.82*scale,radius*.6,-radius*.18*scale,radius*.84*scale,radius*.08);ctx.stroke();
      ctx.strokeStyle='#38bdf2';ctx.lineWidth=4.5*fade+1;ctx.beginPath();ctx.moveTo(-radius*.86*scale,radius*.08);ctx.quadraticCurveTo(0,radius*.52*scale,radius*.82*scale,-radius*.02);ctx.stroke();
      for(let i=0;i<8;i++){const a=i*TAU/8+.2,rx=radius*(.4+(i%3)*.16)*scale,x=Math.cos(a)*rx,y=Math.sin(a)*rx*.7;
        ctx.fillStyle=i%2?'#f3ffff':'#8ae6ff';ctx.beginPath();ctx.moveTo(x,y-4);ctx.quadraticCurveTo(x+5,y-1,x+2,y+4);ctx.quadraticCurveTo(x-4,y+3,x,y-4);ctx.fill();}
      ctx.restore();return true;
    }
    if(m==='thunderbolt'||m==='thunder'||m==='thundershock'||m==='discharge'||m==='zapcannon'){
      ctx.strokeStyle='#fff9d2';ctx.lineWidth=2.2;ctx.beginPath();ctx.moveTo(-radius*.8,radius*.14);ctx.lineTo(-radius*.48,-radius*.22);
      ctx.lineTo(-radius*.27,radius*.08);ctx.lineTo(-radius*.02,-radius*.64);ctx.lineTo(radius*.13,-radius*.19);
      ctx.lineTo(radius*.44,-radius*.36);ctx.lineTo(radius*.29,radius*.06);ctx.lineTo(radius*.78,-radius*.1);ctx.stroke();
      ctx.strokeStyle='#ffdb45';ctx.lineWidth=4*fade+1;ctx.beginPath();ctx.moveTo(-radius*.7,radius*.24);ctx.lineTo(-radius*.38,-radius*.03);
      ctx.lineTo(-radius*.2,radius*.2);ctx.lineTo(radius*.04,-radius*.43);ctx.lineTo(radius*.19,-radius*.02);ctx.lineTo(radius*.62,-radius*.22);ctx.stroke();
      star(0,0,Math.max(3,radius*.17),Math.max(1,radius*.065),4,Math.PI/4,'#fffde8');ctx.restore();return true;
    }
    if(m==='icebeam'||m==='iceshard'||m==='icepunch'||m==='blizzard'){
      for(let i=0;i<7;i++){const a=i*TAU/7+.17,dist=radius*(.28+(i%3)*.17),size=radius*(.15+(i%2)*.04);
        ctx.save();ctx.translate(Math.cos(a)*dist,Math.sin(a)*dist*.65);ctx.rotate(a+.25);
        ctx.fillStyle=i%2?'#d9faff':'#80d9f5';ctx.strokeStyle='#f6ffff';ctx.lineWidth=1;ctx.beginPath();
        ctx.moveTo(0,-size);ctx.lineTo(size*.42,-size*.14);ctx.lineTo(size*.26,size*.85);ctx.lineTo(-size*.23,size*.52);ctx.closePath();ctx.fill();ctx.stroke();
        ctx.strokeStyle='#4da8d3';ctx.beginPath();ctx.moveTo(0,-size*.78);ctx.lineTo(size*.16,size*.4);ctx.stroke();ctx.restore();}
      ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(0,0,radius*.42,0,TAU);ctx.stroke();ctx.restore();return true;
    }
    if(m==='solarbeam'||m==='razorleaf'||m==='seedbomb'||m==='leafstorm'||m==='magicalleaf'){
      for(let i=0;i<8;i++){const a=i*TAU/8,dist=radius*(.28+(i%3)*.16),size=radius*(.15+(i%2)*.045);
        ctx.save();ctx.translate(Math.cos(a)*dist,Math.sin(a)*dist*.68);ctx.rotate(a+.4);ctx.fillStyle=i%2?'#9ce85a':'#56b94d';ctx.strokeStyle='#ddffad';ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(-size*.15,size*.65);ctx.quadraticCurveTo(-size*.88,-size*.12,0,-size);ctx.quadraticCurveTo(size*.85,-size*.25,size*.15,size*.65);ctx.closePath();ctx.fill();ctx.stroke();
        ctx.strokeStyle='#eaffc4';ctx.beginPath();ctx.moveTo(0,size*.42);ctx.lineTo(0,-size*.7);ctx.stroke();ctx.restore();}
      star(0,0,radius*.22,radius*.1,4,Math.PI/4,'#efffd6');ctx.restore();return true;
    }
    if(m==='shadowball'||m==='darkpulse'||m==='nightshade'||m==='shadowclaw'){
      ctx.strokeStyle='#6e4aa6';ctx.lineWidth=4*fade+1;ctx.beginPath();ctx.arc(0,0,radius*.68,-2.25,.95);ctx.stroke();
      ctx.strokeStyle='#d9b7ff';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(0,0,radius*.48,.8,4.4);ctx.stroke();
      for(let i=0;i<6;i++){const a=i*TAU/6+.15,dist=radius*(.5+(i%2)*.16),size=radius*(.12+(i%3)*.025);
        ctx.fillStyle=i%2?'#5c438f':'#af8be8';ctx.beginPath();ctx.moveTo(Math.cos(a)*dist,Math.sin(a)*dist*.7);
        ctx.quadraticCurveTo(Math.cos(a+.18)*(dist+size),Math.sin(a+.18)*(dist+size)*.7,Math.cos(a)*(dist+size*1.4),Math.sin(a)*(dist+size*1.4)*.7);
        ctx.quadraticCurveTo(Math.cos(a-.1)*(dist+size*.3),Math.sin(a-.1)*(dist+size*.3)*.7,Math.cos(a)*dist,Math.sin(a)*dist*.7);ctx.fill();}
      star(0,0,radius*.2,radius*.09,4,Math.PI/4,'#e9d5ff');ctx.restore();return true;
    }
    if(m==='rockslide'||m==='rockthrow'||m==='stoneedge'||m==='earthpower'||m==='bulldoze'){
      ctx.globalCompositeOperation='source-over';ctx.strokeStyle='#f2d9a9';ctx.lineWidth=2.2*fade+1;ctx.beginPath();
      ctx.moveTo(-radius*.88,-radius*.1);ctx.lineTo(-radius*.56,radius*.06);ctx.lineTo(-radius*.26,-radius*.42);ctx.lineTo(-radius*.03,radius*.04);
      ctx.lineTo(radius*.21,-radius*.24);ctx.lineTo(radius*.46,radius*.12);ctx.lineTo(radius*.78,-radius*.06);ctx.stroke();
      for(let i=0;i<6;i++){const a=i*TAU/6+.25,dist=radius*(.32+(i%3)*.17),size=radius*(.13+(i%2)*.05);
        ctx.save();ctx.translate(Math.cos(a)*dist,Math.sin(a)*dist*.65);ctx.rotate(a+.5);ctx.fillStyle=i%2?'#8e7d67':'#c5ad88';ctx.strokeStyle='#ead7b6';ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(-size*.7,-size*.2);ctx.lineTo(-size*.18,-size);ctx.lineTo(size*.72,-size*.56);ctx.lineTo(size*.6,size*.43);ctx.lineTo(-size*.28,size*.78);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();}
      ctx.restore();return true;
    }
    if(m==='aurasphere'||m==='focusblast'){
      ctx.strokeStyle='#b0e9ff';ctx.lineWidth=4*fade+1;ctx.beginPath();ctx.ellipse(0,0,radius*.77,radius*.48,0,0,TAU);ctx.stroke();
      ctx.strokeStyle='#f6ffff';ctx.lineWidth=1.5;ctx.beginPath();ctx.ellipse(0,0,radius*.56,radius*.32,0,0,TAU);ctx.stroke();
      for(let i=0;i<8;i++){const a=i*TAU/8+t*.4,dist=radius*(.58+(i%3)*.1);star(Math.cos(a)*dist,Math.sin(a)*dist*.6,3.5,1.4,4,a,'#7bd7ff');}
      star(0,0,radius*.21,radius*.11,4,Math.PI/4,'#efffff');ctx.restore();return true;
    }
    if(m==='dragonpulse'||m==='dragonbreath'||m==='dracometeor'){
      for(let layer=0;layer<3;layer++){const r=radius*(.32+layer*.19),offset=layer%2?Math.PI/8:0;
        ctx.strokeStyle=layer===1?'#eee1ff':layer===0?'#8b78df':'#ec7d9f';ctx.lineWidth=3.2-layer*.65;ctx.beginPath();
        for(let j=0;j<=20;j++){const a=j*TAU/20,dist=r+Math.sin(a*3+now*.009+layer)*radius*.055,x=Math.cos(a+offset)*dist,y=Math.sin(a+offset)*dist*.58;j?ctx.lineTo(x,y):ctx.moveTo(x,y);}
        ctx.stroke();}
      for(let i=0;i<5;i++){const a=i*TAU/5+now*.002;star(Math.cos(a)*radius*.68,Math.sin(a)*radius*.38,3.5,1.2,4,a,'#fff2f5');}
      ctx.restore();return true;
    }
    if(m==='sludgebomb'||m==='sludgewave'||m==='toxic'||m==='poisonsting'||m==='poisongas'){
      for(let i=0;i<6;i++){const a=i*TAU/6+.13,dist=radius*(.25+(i%3)*.14),size=radius*(.13+(i%2)*.035);
        ctx.fillStyle=i%2?'#a16bc5':'#744398';ctx.strokeStyle='#dfb8ef';ctx.lineWidth=1;ctx.beginPath();
        ctx.moveTo(Math.cos(a)*dist,Math.sin(a)*dist*.68);
        ctx.quadraticCurveTo(Math.cos(a+.15)*(dist+size),Math.sin(a+.15)*(dist+size)*.68,Math.cos(a)*(dist+size*1.25),Math.sin(a)*(dist+size*1.25)*.68);
        ctx.quadraticCurveTo(Math.cos(a-.12)*(dist+size*.4),Math.sin(a-.12)*(dist+size*.4)*.68,Math.cos(a)*dist,Math.sin(a)*dist*.68);ctx.fill();ctx.stroke();}
      for(let i=0;i<5;i++){const a=i*TAU/5,dist=radius*(.5+(i%2)*.16);ctx.fillStyle='#d6a2ee';ctx.beginPath();ctx.arc(Math.cos(a)*dist,Math.sin(a)*dist*.65,1.7+(i%2),0,TAU);ctx.fill();}
      ctx.restore();return true;
    }
    if(m==='aircutter'||m==='hurricane'||m==='wingattack'||m==='aerialace'||m==='airslash'){
      for(let i=0;i<3;i++){ctx.save();ctx.rotate((i-1)*.26);ctx.strokeStyle=i===1?'#ffffff':'#bbd8f6';ctx.lineWidth=(4-i)*fade+1;ctx.beginPath();
        ctx.moveTo(-radius*.64,-radius*.22+i*3);ctx.quadraticCurveTo(-radius*.08,-radius*.86,radius*.7,0);ctx.quadraticCurveTo(radius*.04,radius*.12,-radius*.64,-radius*.22+i*3);ctx.stroke();ctx.restore();}
      for(let i=0;i<4;i++){const a=i*TAU/4+.1;star(Math.cos(a)*radius*.57,Math.sin(a)*radius*.42,3,1,4,a,'#e6f5ff');}
      ctx.restore();return true;
    }
    if(m==='flashcannon'||m==='meteorbeam'||m==='steelbeam'||m==='gyroball'){
      for(let i=0;i<7;i++){const a=i*TAU/7+.12,dist=radius*(.3+(i%3)*.14),size=radius*(.12+(i%2)*.05);
        ctx.save();ctx.translate(Math.cos(a)*dist,Math.sin(a)*dist*.65);ctx.rotate(a+.4);ctx.fillStyle=i%2?'#9cc7d0':'#d8eced';ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.beginPath();
        ctx.moveTo(0,-size);ctx.lineTo(size*.6,-size*.1);ctx.lineTo(size*.35,size*.8);ctx.lineTo(-size*.3,size*.4);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();}
      ctx.strokeStyle='#efffff';ctx.lineWidth=2.3;ctx.beginPath();ctx.ellipse(0,0,radius*.54,radius*.28,0,0,TAU);ctx.stroke();
      star(0,0,radius*.18,radius*.08,4,Math.PI/4,'#fff');ctx.restore();return true;
    }
    if(m==='signalbeam'||m==='bugbuzz'||m==='strugglebug'){
      for(let i=0;i<4;i++){const width=radius*(.42+i*.13);ctx.strokeStyle=i%2?'#e8ffa0':'#8ccf55';ctx.lineWidth=1.6;ctx.beginPath();
        for(let j=0;j<=18;j++){const x=-width+2*width*j/18,y=Math.sin(j*.85+now*.018+i*.8)*radius*.18*(1-Math.abs(x)/Math.max(1,width));j?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();}
      for(let i=0;i<6;i++){const a=i*TAU/6+now*.002;star(Math.cos(a)*radius*.63,Math.sin(a)*radius*.43,3.4,1.4,4,a,i%2?'#eaffb2':'#fff');}
      ctx.restore();return true;
    }
    if(m==='psybeam'||m==='psychic'||m==='confusion'){
      for(let layer=0;layer<3;layer++){const r=radius*(.28+layer*.19);ctx.strokeStyle=layer===0?'#f5e4ff':layer===1?'#e68bd8':'#9c7ce4';ctx.lineWidth=2.8-layer*.6;ctx.beginPath();
        for(let i=0;i<=26;i++){const a=i*TAU/26,dist=r+Math.sin(a*4+now*.009+layer)*radius*.08,x=Math.cos(a)*dist,y=Math.sin(a)*dist*.58;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();}
      star(0,0,radius*.22,radius*.1,4,now*.002,'#fff4ff');ctx.restore();return true;
    }
    if(m==='swift'||m==='hypervoice'||m==='sonicboom'){
      for(let i=0;i<8;i++){const a=i*TAU/8+.1,dist=radius*(.25+(i%3)*.17);star(Math.cos(a)*dist,Math.sin(a)*dist*.62,5,2.1,4,a,'#fff4c4');}
      for(let i=0;i<3;i++){ctx.strokeStyle=i%2?'#fff4c4':'#e6c35e';ctx.lineWidth=1.6;ctx.beginPath();ctx.ellipse(0,0,radius*(.42+i*.19),radius*(.28+i*.1),i*.08,0,TAU);ctx.stroke();}
      ctx.restore();return true;
    }
    ctx.restore();return false;
  }

  drawParticles(dt) {
    const ctx=this.ctx;
    for(let i=this.particles.length-1;i>=0;i--){const p=this.particles[i];p.life-=dt;if(p.life<=0){this.particles.splice(i,1);continue;}p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=Math.exp(-dt*4);p.vy*=Math.exp(-dt*4);ctx.globalAlpha=p.life/p.max;ctx.fillStyle=tint(p.type);ctx.fillRect(p.x-p.size/2,p.y-p.size/2,p.size,p.size);}
    ctx.globalAlpha=1;
  }

  drawLabel(f,pos,selfTeam) {
    if(f.hp<=0)return;
    const ctx=this.ctx,width=48,ratio=clamp(f.hp/f.maxHp,0,1);
    ctx.save();ctx.translate(pos.x,pos.y+16);ctx.fillStyle='#081527bb';ctx.fillRect(-width/2-2,-1,width+4,5);ctx.fillStyle=f.team===selfTeam?'#a0ddb1':'#eb9ea6';ctx.fillRect(-width/2,0,width*ratio,2.5);ctx.font='600 7px Barlow, sans-serif';ctx.textAlign='center';ctx.textBaseline='top';ctx.lineWidth=2;ctx.strokeStyle='#081527';ctx.strokeText(f.name,0,7);ctx.fillStyle='#fff9df';ctx.fillText(f.name,0,7);ctx.restore();
  }

  drawDamageLabels(dt) {
    const ctx=this.ctx;
    for(let i=this.labels.length-1;i>=0;i--){const p=this.labels[i];p.life-=dt;p.y-=25*dt;if(p.life<=0){this.labels.splice(i,1);continue;}ctx.save();ctx.globalAlpha=Math.min(1,p.life/.25);ctx.font=`800 ${/^\+?\d+$/.test(p.text)?16:11}px "Barlow Condensed",sans-serif`;ctx.textAlign='center';ctx.lineWidth=3;ctx.strokeStyle='#081323';ctx.strokeText(p.text,p.x,p.y);ctx.fillStyle=tint(p.type);ctx.fillText(p.text,p.x,p.y);ctx.restore();}
  }

  drawOffscreenOpponent(enemy) {
    const p=this.worldToScreen(enemy.x,enemy.y);
    if(p.x>35&&p.x<1165&&p.y>90&&p.y<650)return;
    const x=clamp(p.x,36,1164),y=clamp(p.y,115,640),angle=Math.atan2(p.y-y,p.x-x),ctx=this.ctx;
    ctx.save();ctx.translate(x,y);ctx.fillStyle='#162237da';ctx.strokeStyle='#efb6bcaa';ctx.lineWidth=1;ctx.beginPath();ctx.arc(0,0,17,0,TAU);ctx.fill();ctx.stroke();ctx.rotate(angle);ctx.fillStyle='#f6b3bd';ctx.beginPath();ctx.moveTo(8,0);ctx.lineTo(-5,-5);ctx.lineTo(-5,5);ctx.closePath();ctx.fill();ctx.restore();
  }

  diagnostics() {
    return [...this.characters].map(([id,r])=>({id,species:r.species,animation:r.drawnAnimation,frame:r.drawnFrame,row:r.drawnRow,authored:!!this.manifest[r.species]}));
  }
}
