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
        if(signature&&['fireblast','bodyslam','volttackle','wildcharge','struggle','doubleedge','takedown','flareblitz','aquajet','quickattack','extremespeed','headbutt','zenheadbutt','ironhead','closecombat','dragonclaw','playrough','leafblade','slash'].includes(signature)) this.effects.push({kind:'moveImpact',move:signature,x:effect.x,y:effect.y+12,type:effect.type,life:.52,max:.52});
        this.burst(effect.x, effect.y + 12, effect.type, 9, 70);
        this.addDecal(effect.x,effect.y+20,effect.type);
        if (this.settings().screenShake) this.shake = Math.max(this.shake, signature==='bodyslam'||signature==='fireblast'?4:2);
      }
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
      const chargeLengths={volttackle:118,wildcharge:98,flareblitz:92,aquajet:78,quickattack:90,extremespeed:128,doubleedge:76,takedown:64,struggle:52};
      if(chargeLengths[moveId])this.effects.push({kind:'chargeTrail',x,y:y-12,type:event.type,direction,life:.42,max:.42,move:moveId,length:Math.max(2,Number.isFinite(Number(event.dashDistance))?Number(event.dashDistance):chargeLengths[moveId])});
      else if(moveId==='bodyslam')this.effects.push({kind:'bodySlamLaunch',x,y:y-12,type:'Normal',direction,life:.42,max:.42,move:moveId});
      else if(moveId==='closecombat')this.effects.push({kind:'combatFlurry',x:x+direction.x*24,y:y+direction.y*24-12,type:event.type,direction,life:.42,max:.42,move:moveId});
      else if(moveId==='dragonclaw'||moveId==='leafblade'||moveId==='slash')this.effects.push({kind:'clawArc',x:x+direction.x*36,y:y+direction.y*36-12,type:event.type,direction,life:.34,max:.34,move:moveId});
      else if(moveId==='playrough')this.effects.push({kind:'fairyImpact',x:x+direction.x*34,y:y+direction.y*34-12,type:event.type,direction,life:.4,max:.4,move:moveId});
      else if(['headbutt','zenheadbutt','ironhead'].includes(moveId))this.effects.push({kind:'heavyImpact',x:x+direction.x*34,y:y+direction.y*34-12,type:event.type,direction,life:.38,max:.38,move:moveId});
      else if(['firepunch','thunderpunch','icepunch','machpunch','bulletpunch','drainpunch'].includes(moveId))this.effects.push({kind:'elementalPunch',x:x+direction.x*34,y:y+direction.y*34-12,type:event.type,direction,life:.34,max:.34,move:moveId});
      else if(['vinewhip','powerwhip'].includes(moveId))this.effects.push({kind:'vineWhip',x:x+direction.x*35,y:y+direction.y*35-12,type:'Grass',direction,life:.38,max:.38,move:moveId});
      else this.effects.push({kind:'slash',x,y:y-12,type:event.type,direction,life:.28,max:.28,move:event.move});
    }
    else if (kind === 'pulse') {const pulseLife={earthquake:.9,bulldoze:.72,discharge:.68,dazzlinggleam:.68,hypervoice:.62,snarl:.62,strugglebug:.62}[event.move]||.52;this.effects.push({kind:'pulse',x,y,type:event.type,life:pulseLife,max:pulseLife,radius:move.arena?.range||170,move:event.move,direction});}
    else if (kind === 'self') this.effects.push({kind:'self',x,y,type:event.type,life:.5,max:.5});
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
    const transition=f.evolution;if(!transition)return;
    const ctx=this.ctx,progress=clamp((transition.elapsed+clamp((now-this.lastSnapshot)/1000,0,.08))/Math.max(.1,transition.duration),0,1);
    const pulse=.5+.5*Math.sin(now/58),radius=25+progress*34,flash=Math.pow(Math.max(0,Math.sin(now/83)),8);
    ctx.save();ctx.translate(pos.x,pos.y-20);ctx.globalCompositeOperation='lighter';

    // Bright central aura and the rotating rings used by classic evolution scenes.
    ctx.globalAlpha=.26+.32*pulse;
    const glow=ctx.createRadialGradient(0,0,2,0,0,54+progress*38);
    glow.addColorStop(0,'rgba(255,255,255,1)');
    glow.addColorStop(.28,'rgba(255,249,207,.78)');
    glow.addColorStop(.62,'rgba(255,213,104,.24)');
    glow.addColorStop(1,'rgba(255,211,110,0)');
    ctx.fillStyle=glow;ctx.fillRect(-100,-100,200,165);

    ctx.globalAlpha=.48+.48*pulse;ctx.strokeStyle='#fff9dc';ctx.lineWidth=2;
    for(let ring=0;ring<4;ring++){
      ctx.save();
      ctx.rotate((now/560)*(ring%2?-.9:1)+ring*1.57);
      ctx.beginPath();
      ctx.ellipse(0,0,radius+ring*5,8+ring*3,0,0,TAU);
      ctx.stroke();ctx.restore();
    }

    // Short rays spin around the Pokémon; individual motes orbit at different speeds.
    ctx.lineWidth=1.5;ctx.strokeStyle='#fff3b7';
    for(let ray=0;ray<10;ray++){
      const angle=ray*TAU/10+now/330*(ray%2?1:-1),inner=13+pulse*7,outer=radius+9+(ray%3)*5;
      ctx.globalAlpha=.22+.55*((Math.sin(now/95+ray)+1)/2);
      ctx.beginPath();ctx.moveTo(Math.cos(angle)*inner,Math.sin(angle)*inner*.65);ctx.lineTo(Math.cos(angle)*outer,Math.sin(angle)*outer*.65);ctx.stroke();
    }
    for(let mote=0;mote<16;mote++){
      const angle=mote*TAU/16+now/390*(mote%2?1:-1),orbit=radius+Math.sin(now/135+mote)*7;
      const x=Math.cos(angle)*orbit,y=Math.sin(angle)*orbit*.62;
      ctx.globalAlpha=.35+.65*((Math.sin(now/78+mote*1.3)+1)/2);
      ctx.fillStyle=mote%4===0?'#fff':'#ffe78c';
      ctx.beginPath();ctx.arc(x,y,mote%3===0?2.8:1.8,0,TAU);ctx.fill();
    }

    // A clean white pulse near the end marks the instant the new form appears.
    if(progress>.68){
      ctx.globalAlpha=(.08+.22*pulse+flash*.42)*(progress-.68)/.32;
      ctx.fillStyle='#fff';
      ctx.beginPath();ctx.ellipse(0,-2,22+progress*28,27+progress*30,0,0,TAU);ctx.fill();
    }
    ctx.globalAlpha=.9;ctx.textAlign='center';ctx.textBaseline='middle';
    const source=this.species(transition.fromSpecies)?.name||f.name;
    ctx.font='800 10px Barlow, sans-serif';ctx.fillStyle='#fff7cf';
    ctx.shadowColor='#ffdb73';ctx.shadowBlur=8;
    ctx.fillText(`WHAT? ${source.toUpperCase()} IS EVOLVING!`,0,-67,205);
    const destination=this.species(transition.toSpecies)?.name;
    if(destination){
      ctx.shadowBlur=0;ctx.font='800 10px Barlow, sans-serif';ctx.fillStyle='#fff';
      ctx.fillText(destination.toUpperCase(),0,61,160);
    }
    ctx.globalAlpha=.8;ctx.fillStyle='#111b2b99';ctx.fillRect(-31,74,62,3);
    ctx.fillStyle='#ffe88c';ctx.fillRect(-30,75,60*progress,1);
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
      else if(f.evolution){const phase=clamp((f.evolution.elapsed+clamp((now-this.lastSnapshot)/1000,0,.08))/Math.max(.1,f.evolution.duration),0,1),pulse=.5+.5*Math.sin(now/58),silhouette=phase<.18||Math.floor(now/95)%2===0;ctx.filter=silhouette?'brightness(0) invert(1) sepia(1) saturate(5) hue-rotate(345deg) drop-shadow(0 0 '+(5+pulse*10)+'px #fff1a3)':'brightness('+(1.2+pulse*2.1)+') saturate(1.8) drop-shadow(0 0 '+(4+pulse*8)+'px #fff1a3)';}
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
    img.style.filter=f.evolution?(Math.floor(now/95)%2===0?`brightness(0) invert(1) sepia(1) saturate(5) hue-rotate(345deg) drop-shadow(0 0 ${5+evolutionPulse*10}px #fff1a3)`:`brightness(${1.2+evolutionPulse*2.1}) saturate(1.8) drop-shadow(0 0 ${4+evolutionPulse*8}px #fff1a3)`):desired==='hurt'?'brightness(1.7)':f.hp<=0?'saturate(.35)':'';
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
    const beamMoves=['hydropump','watergun','flamethrower','icebeam','thunderbolt','hyperbeam','solarbeam'];
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
    }else if(['psychic','psybeam','confusion','psyshock'].includes(p.move)){
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
    }else if(['blizzard','frostbreath','icywind'].includes(p.move)){
      ctx.rotate(now*.01);ctx.strokeStyle='#dcfcff';ctx.lineWidth=1.6;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.5+i*.35),r*(.4+i*.2),now*.01+i,0,TAU);ctx.stroke();}for(let i=0;i<7;i++){const a=i*TAU/7+now*.002;ctx.fillStyle=i%2?'#77caed':'#efffff';ctx.beginPath();ctx.moveTo(Math.cos(a)*r*1.2,Math.sin(a)*r*.8);ctx.lineTo(Math.cos(a+.2)*r*.25,Math.sin(a+.2)*r*.18);ctx.lineTo(Math.cos(a-.18)*r*.8,Math.sin(a-.18)*r*.5);ctx.closePath();ctx.fill();}
    }else if(p.move==='flashcannon'){
      const grad=ctx.createRadialGradient(-r*.2,-r*.2,1,0,0,r*1.5);grad.addColorStop(0,'#fff');grad.addColorStop(.3,'#d9f6ff');grad.addColorStop(.62,'#799ca9');grad.addColorStop(1,'#47616b00');ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,r*1.3,0,TAU);ctx.fill();ctx.strokeStyle='#f2ffff';ctx.lineWidth=2;for(let i=0;i<3;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.85+i*.25),r*(.42+i*.16),now*.005+i,0,TAU);ctx.stroke();}
    }else if(['aircutter','gust','hurricane','twister'].includes(p.move)){
      ctx.rotate(now*.008);ctx.strokeStyle=p.move==='hurricane'?'#d7ecff':'#ecf7ff';ctx.lineWidth=2.4;for(let i=0;i<4;i++){ctx.beginPath();ctx.ellipse(0,0,r*(.45+i*.28),r*(.25+i*.2),now*.012+i*.5,.15,Math.PI*1.8);ctx.stroke();}if(p.move==='aircutter'){ctx.beginPath();ctx.moveTo(-r*1.5,-r*.3);ctx.quadraticCurveTo(0,-r*1.3,r*1.4,0);ctx.quadraticCurveTo(0,r*.35,-r*1.5,-r*.3);ctx.stroke();}
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
        if(m==='fireblast'){
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
        }else if(['bodyslam','struggle','doubleedge','takedown','headbutt','zenheadbutt','ironhead'].includes(m)){
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
      }else if(e.kind==='slash'){const angle=Math.atan2(e.direction.y,e.direction.x);ctx.rotate(angle);ctx.lineWidth=6*(1-t)+1;ctx.beginPath();ctx.arc(0,0,32+t*45,-1.1+t*.6,1.1+t*.6);ctx.stroke();ctx.strokeStyle='#ffffe6';ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,29+t*42,-.9+t*.6,.9+t*.6);ctx.stroke();}
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
      else if(e.kind==='self'||e.kind==='heal'||e.kind==='boost'){ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(0,-t*25,18+Math.sin(t*Math.PI)*8,9,0,0,TAU);ctx.stroke();for(let j=0;j<3;j++)ctx.fillRect(Math.cos(j*2.1)*17,-t*45-j*3,3,5);}
      else{ctx.lineWidth=2*(1-t)+1;const radius=e.kind==='muzzle'?4+t*12:5+t*26;ctx.beginPath();ctx.arc(0,0,radius,0,TAU);ctx.stroke();}
      ctx.restore();
    }
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
