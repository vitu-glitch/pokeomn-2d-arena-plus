'use strict';

const path=require('node:path');
const fs=require('node:fs');
const http=require('node:http');
const crypto=require('node:crypto');
const express=require('express');
const {WebSocketServer,WebSocket}=require('ws');
const {Battle,ARENAS,SUPPORTED_ABILITIES,DEPLOYMENT}=require('./engine.cjs');
const {validateTeam,idOf,ARENA_DAMAGE_SCALE,Dex}=require('./rules.cjs');
const {CampaignStore,STAGES}=require('./campaign.cjs');

const send=(socket,data)=>{if(socket.readyState===WebSocket.OPEN && socket.bufferedAmount<512*1024)socket.send(JSON.stringify(data));};
function localRequest(req) {
  const address=req.socket.remoteAddress||'';
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address))return false;
  if(req.headers['x-forwarded-for']||req.headers['forwarded']||req.headers['cf-connecting-ip']||req.headers['x-real-ip'])return false;
  try {const host=new URL(`http://${req.headers.host}`).hostname;return ['127.0.0.1','localhost','[::1]'].includes(host);}catch{return false;}
}
function sameOrigin(req) {
  if(!req.headers.origin)return true;
  try{return new URL(req.headers.origin).host===req.headers.host;}catch{return false;}
}
function hostConnection(req) {
  try {return new URL(req.url||'/','http://localhost').searchParams.get('guest')!=='1'&&localRequest(req)&&sameOrigin(req);}catch{return false;}
}
function permittedSocketOrigin(req) {
  if(!req.headers.origin||sameOrigin(req))return true;
  try {
    const origin=new URL(req.headers.origin);
    return ['http:','https:'].includes(origin.protocol)&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname);
  }catch{return false;}
}
function safeEqual(a,b) {if(typeof a!=='string'||typeof b!=='string')return false;const first=Buffer.from(a),second=Buffer.from(b);return first.length===second.length&&crypto.timingSafeEqual(first,second);}
function cleanName(name) {return String(name||'Trainer').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,24)||'Trainer';}

async function startServer({port=0,host='127.0.0.1',rootDir=path.join(__dirname,'..'),saveDir=path.join(rootDir,'save')}={}) {
  rootDir=path.resolve(rootDir);saveDir=path.resolve(saveDir);
  const catalogPath=path.join(rootDir,'client','data','catalog.json');
  const catalog=JSON.parse(fs.readFileSync(catalogPath,'utf8'));
  for(const species of catalog.species){
    const canonical=Dex.species.get(species.id);
    const total=Object.values(canonical?.baseStats||species.baseStats||{}).reduce((sum,value)=>sum+Number(value||0),0);
    species.battleRoyaleStarter=Boolean(canonical&&!canonical.prevo&&Array.isArray(canonical.evos)&&canonical.evos.length>0&&!canonical.forme&&!canonical.isNonstandard&&!['Uber','AG'].includes(canonical.tier)&&total<=450&&Array.isArray(species.moves)&&species.moves.length>0);
    species.evos=Array.isArray(canonical?.evos)?[...canonical.evos]:[];
  }
  catalog.speciesById=new Map(catalog.species.map(p=>[p.id,p]));
  const campaign=new CampaignStore(saveDir);
  const rooms=new Map(),players=new Map(),battles=new Map();
  const app=express();app.disable('x-powered-by');
  app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-cache');next();});
  app.get('/api/health',(_req,res)=>res.json({ok:true,name:'Pokemon Battle Royale',version:'0.5.0'}));
  app.get('/api/online-config',(req,res)=>{
    if(!localRequest(req))return res.status(403).json({error:'Connection settings belong to the local host.'});
    let configured=null;
    try {if(process.env.EMPRESS_ICE_SERVERS)configured=JSON.parse(process.env.EMPRESS_ICE_SERVERS);}catch{}
    if(Array.isArray(configured)&&configured.length&&configured.length<=12)return res.json({iceServers:configured,relayConfigured:configured.some(entry=>[].concat(entry.urls||[]).some(url=>/^turns?:/i.test(url)))});
    res.json({iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478']}],relayConfigured:false});
  });
  app.get('/api/catalog',(_req,res)=>res.json(catalog));
  app.get('/api/arenas',(_req,res)=>res.json(Object.values(ARENAS)));
  app.get('/api/rules',(_req,res)=>res.json({level:50,ivs:31,evs:0,nature:'neutral',generation:'Modern National Dex',turnSeconds:4,arenaDamageScale:ARENA_DAMAGE_SCALE,freezeSeconds:[.8,1.8],thawImmunitySeconds:4,spawnShieldSeconds:DEPLOYMENT.grace,deployment:DEPLOYMENT,facingBasedAttacks:true,supportedAbilities:[...SUPPORTED_ABILITIES],notes:[`Attack damage uses the canonical formula, types and stats, then applies a ${ARENA_DAMAGE_SCALE} arena multiplier for longer real-time fights.`,'Attacks follow the last direction you moved. Moves commit to a visible windup, release and recovery; movement slows during commitment.','Hits cause brief hitstun and collision-aware knockback. Freeze lasts 0.8–1.8 seconds, followed by four seconds of freeze immunity.','Pokémon deploy from a Poké Ball before they can move or attack. Deployment is protected, followed by 0.35 seconds of protection.','Real-time cooldown, projectile, dodge, flinch, status duration and counter timing are arena adaptations.','Unsupported abilities are displayed but inactive; no held items, weather, terrain, Mega evolution, Z-Moves, Dynamax, or Terastallization.','All combatants use level 50, neutral natures, 31 IVs and 0 EVs. Hidden Power is Dark.','The Midnight Circuit is a connected story journey with checkpoints and a fully healed team at each challenge.']}));
  app.get('/api/campaign',(req,res)=>{if(!localRequest(req))return res.status(403).json({error:'Campaign progress belongs to the local host.'});res.json(campaign.view());});
  app.get('/api/story',(req,res)=>{if(!localRequest(req))return res.status(403).json({error:'Story progress belongs to the local host.'});res.json(campaign.storyView());});
  app.get('/data/movement.json',(req,res,next)=>{
    const compressed=path.join(rootDir,'client','data','movement.json.gz');
    res.vary('Accept-Encoding');
    if(!req.acceptsEncodings('gzip')||!fs.existsSync(compressed))return next();
    res.type('json');res.setHeader('Content-Encoding','gzip');res.sendFile(compressed);
  });
  app.use(express.static(path.join(rootDir,'client'),{index:'index.html',dotfiles:'deny',fallthrough:true}));
  app.use((_req,res)=>res.status(404).json({error:'Not found'}));
  const server=http.createServer(app);
  const wss=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    if(req.url?.split('?')[0]!=='/ws'){socket.destroy();return;}
    if(!permittedSocketOrigin(req)){socket.destroy();return;}
    const isHost=hostConnection(req);
    const localCount=[...players.values()].filter(player=>player.local).length;
    if(isHost?localCount>=8:players.size-localCount>=20){socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });

  function roomMessage(room) {
    const roster=room.members.map(id=>players.get(id)).filter(Boolean);
    for(const member of roster)send(member.ws,{type:'room',code:room.code,token:room.token,invitePath:`/?room=${room.code}&token=${room.token}`,host:room.host===member.id,players:roster.map(p=>({name:p.name,ready:true})),arena:room.arena});
  }
  function removeFromRoom(player) {
    const room=rooms.get(player.room);player.room=null;if(!room)return;
    room.members=room.members.filter(id=>id!==player.id);
    if(room.host===player.id || room.members.length===0) {
      rooms.delete(room.code);
      for(const id of room.members){const other=players.get(id);if(other){other.room=null;send(other.ws,{type:'roomClosed',message:'The host closed this room.'});}}
    }else roomMessage(room);
  }
  function leave(player,reason='left') {
    if(player.battle) {
      const entry=battles.get(player.battle);
      if(entry && entry.battle.phase==='battle'){
        if(entry.battle.mode==='battle-royale')entry.battle.eliminate(player.team,reason);
        else entry.battle.finish(1-player.team,reason);
      }
      if(entry){entry.players=entry.players.filter(id=>id!==player.id);if(entry.players.length===0)battles.delete(entry.battle.id);}
      player.battle=null;
    }
    removeFromRoom(player);player.team=0;
  }
  function launch(memberPlayers,teamSpecs,{mode,stage=null,arena='stadium',cpuLevel=1}) {
    const id=crypto.randomBytes(10).toString('hex');
    const entry={battle:null,players:memberPlayers.map(p=>p.id),finishedAt:0};
    const battle=new Battle({id,teams:teamSpecs,mode,stage,arena,cpuLevel,speciesById:catalog.speciesById,onFinish:({winner,reason})=>{
      entry.finishedAt=Date.now();
      let progress=null,saveError=null;
      if(mode==='campaign') {
        const localPlayer=players.get(entry.players[0]);
        if(localPlayer?.local && reason==='knockout') {
          try{progress=campaign.result(stage,winner===0);}catch(error){saveError='Progress could not be saved: '+error.message;}
        }else progress=campaign.view();
      }
      for(const playerId of entry.players) {const p=players.get(playerId);if(p){send(p.ws,battle.snapshot());send(p.ws,{type:'result',winner,selfWon:winner===p.team,reason,campaign:p.local?progress:null,story:p.local&&mode==='campaign'?campaign.storyView():null,error:saveError});}}
    }});
    entry.battle=battle;battles.set(id,entry);
    memberPlayers.forEach((p,index)=>{p.battle=id;p.team=index;p.lastSeq=-1;send(p.ws,battle.startMessage(index));send(p.ws,battle.snapshot());});
    return battle;
  }
  function cpuTeam(ids) {
    return validateTeam(ids.map(id=>({species:id})),catalog);
  }
  const quickRoster=['charizard','blastoise','venusaur','pikachu','gengar','lucario','gardevoir','dragonite','scizor','sylveon','arcanine','sceptile','swampert','greninja','mimikyu','garchomp'];
  const royaleNames=['Misty','Brock','Rival','Nova','Iris','Ash','Cynthia','Raihan','Dawn','Blaze','Storm','Ace'];
  wss.on('connection',(ws,req)=>{
    const id=crypto.randomBytes(12).toString('hex');
    const player={id,ws,name:'Trainer',room:null,battle:null,team:0,local:hostConnection(req),lastSeq:-1,rateAt:Date.now(),rateCount:0,alive:true,admissionTimer:null};
    players.set(id,player);
    if(!player.local){player.admissionTimer=setTimeout(()=>ws.close(1008,'Join with a valid invitation to stay connected.'),30000);player.admissionTimer.unref();}
    send(ws,{type:'hello',playerId:id,local:player.local,catalogVersion:catalog.version,campaign:player.local?campaign.view():null});
    ws.on('pong',()=>{player.alive=true;});
    ws.on('message',buffer=>{
      try {
        const now=Date.now();if(now-player.rateAt>1000){player.rateAt=now;player.rateCount=0;}if(++player.rateCount>140){ws.close(1008,'Too many messages');return;}
        const message=JSON.parse(buffer.toString('utf8'));if(!message || typeof message!=='object'||Array.isArray(message))throw new Error('Invalid message.');
        if(message.type==='hello'){player.name=cleanName(message.name);send(ws,{type:'hello',playerId:id,local:player.local,catalogVersion:catalog.version,campaign:player.local?campaign.view():null});}
        else if(message.type==='ping')send(ws,{type:'pong',at:message.at});
        else if(message.type==='leave'){leave(player);send(ws,{type:'left',campaign:player.local?campaign.view():null});}
        else if(['getStory','travel','storyDialogue'].includes(message.type)) {
          if(!player.local)throw new Error('Story progress belongs to the local host.');
          if(message.type==='travel'&&battles.get(player.battle)?.battle.phase==='battle')throw new Error('Finish the battle before continuing your journey.');
          const story=message.type==='travel'?campaign.travel({x:message.x,y:message.y}):message.type==='storyDialogue'?campaign.seeDialogue(String(message.id||'')):campaign.storyView();
          send(ws,{type:'story',story});
        }
        else if(message.type==='watchDemo') {
          if(!player.local)throw new Error('The exhibition runs on the local host.');
          leave(player);
          const pool=[...quickRoster].sort(()=>crypto.randomInt(1000)/1000-.5);
          launch([player],[{name:'Amber Team',team:cpuTeam(pool.slice(0,3)),cpu:true},{name:'Violet Team',team:cpuTeam(pool.slice(3,6)),cpu:true}],{mode:'demo',arena:ARENAS[message.arena]?message.arena:'stadium',cpuLevel:6});
        }
        else if(message.type==='createRoom') {
          if(!player.local)throw new Error('Only the host can create an invitation.');
          const selected=validateTeam(message.team,catalog);leave(player);
          let code;do{code=crypto.randomBytes(5).toString('base64url').toUpperCase().replace(/[-_]/g,'').slice(0,6);}while(code.length!==6||rooms.has(code));
          const room={code,token:crypto.randomBytes(24).toString('base64url'),host:id,members:[id],arena:ARENAS[message.arena]?message.arena:'stadium',createdAt:now};
          player.selected=selected;player.room=code;rooms.set(code,room);roomMessage(room);
        }
        else if(message.type==='joinRoom') {
          const code=String(message.code||'').trim().toUpperCase(),room=rooms.get(code);
          if(!room||!safeEqual(message.token,room.token)||room.members.length!==1||now-room.createdAt>30*60*1000)throw new Error('This invitation is invalid, expired, or already in use.');
          if(room.host===id)throw new Error('You are already the host.');
          const selected=validateTeam(message.team,catalog);const hostPlayer=players.get(room.host);if(!hostPlayer)throw new Error('The host is no longer connected.');
          leave(player);player.selected=selected;player.room=code;room.members.push(id);if(player.admissionTimer){clearTimeout(player.admissionTimer);player.admissionTimer=null;}roomMessage(room);
          launch([hostPlayer,player],[{name:hostPlayer.name,team:hostPlayer.selected},{name:player.name,team:selected}],{mode:'friend',arena:room.arena});
        }
        else if(message.type==='startCpu') {
          if(!player.local)throw new Error('Solo battles run on the host computer. Use an invitation to join a friend.');
          const selected=validateTeam(message.team,catalog);
          const stage=message.stage?STAGES.find(s=>s.id===message.stage):null;
          if(message.stage&&(!stage||!campaign.canPlay(stage.id)))throw new Error('That campaign stage is locked.');
          leave(player);
          const ids=stage?.team||[...quickRoster].sort(()=>crypto.randomInt(1000)/1000-.5).slice(0,selected.length);
          launch([player],[{name:player.name,team:selected},{name:stage?.name||'CPU Trainer',team:cpuTeam(ids),cpu:true}],{mode:stage?'campaign':'cpu',stage:stage?.id||null,arena:stage?.arena||(ARENAS[message.arena]?message.arena:'stadium'),cpuLevel:stage?STAGES.indexOf(stage)+1:4});
        }
        else if(message.type==='startBattleRoyale') {
          if(!player.local)throw new Error('Battle Royale starts on the host computer.');
          const selected=validateTeam([message.pokemon],catalog);
          if(!selected[0].species.battleRoyaleStarter)throw new Error('Choose a first-stage Pokémon that can evolve.');
          leave(player);
          const starterId=selected[0].species.id;
          const candidates=catalog.species.filter(species=>species.id!==starterId&&species.battleRoyaleStarter);
          for(let i=candidates.length-1;i>0;i--){const j=crypto.randomInt(i+1);[candidates[i],candidates[j]]=[candidates[j],candidates[i]];}
          const rivals=[];
          for(const species of candidates){
            try{const team=cpuTeam([species.id]);rivals.push({name:royaleNames[rivals.length%royaleNames.length]+' '+String(rivals.length+1).padStart(2,'0'),team,cpu:true});}
            catch{ /* Skip catalog entries without a legal supported moveset. */ }
            if(rivals.length===11)break;
          }
          if(rivals.length<5)throw new Error('Not enough Pokémon data to build a Battle Royale.');
          const teamSpecs=[{name:player.name,team:selected},...rivals];
          launch([player],teamSpecs,{mode:'battle-royale',arena:ARENAS[message.arena]?message.arena:'stadium',cpuLevel:4});
        }
        else if(message.type==='input') {
          const entry=battles.get(player.battle);if(!entry||entry.battle.mode==='demo')return;
          if(Number.isFinite(message.seq)&&message.seq<=player.lastSeq)return;
          if(Number.isFinite(message.seq))player.lastSeq=message.seq;
          entry.battle.input(player.team,message);
        }
        else throw new Error('Unknown message type.');
      }catch(error){send(ws,{type:'error',message:error.message||'The request could not be handled.'});}
    });
    ws.on('error',()=>{});
    ws.on('close',()=>{if(player.admissionTimer)clearTimeout(player.admissionTimer);leave(player,'disconnect');players.delete(id);if(player.local){try{campaign.flush();}catch(error){console.error('Could not save story position:',error.message);}}});
  });

  let previous=performance.now(),accumulator=0,networkTicks=0;
  const simulation=setInterval(()=>{
    const now=performance.now();accumulator+=Math.min(.1,(now-previous)/1000);previous=now;
    let steps=0;
    while(accumulator>=1/60&&steps++<6){for(const entry of battles.values())entry.battle.step(1/60);accumulator-=1/60;networkTicks++;
      if(networkTicks%3===0)for(const entry of battles.values())if(entry.battle.phase==='battle'){const state=entry.battle.snapshot();for(const id of entry.players){const p=players.get(id);if(p)send(p.ws,state);}}
    }
    for(const [id,entry]of battles)if(entry.finishedAt&&Date.now()-entry.finishedAt>10000){battles.delete(id);for(const pid of entry.players){const p=players.get(pid);if(p?.battle===id)p.battle=null;}}
    for(const [code,room]of rooms)if(room.members.length===1&&Date.now()-room.createdAt>30*60*1000){const p=players.get(room.host);if(p){p.room=null;send(p.ws,{type:'roomClosed',message:'This invitation expired.'});}rooms.delete(code);}
  },1000/60);
  simulation.unref();
  const heartbeat=setInterval(()=>{for(const p of players.values()){if(!p.alive){p.ws.terminate();continue;}p.alive=false;p.ws.ping();}},15000);heartbeat.unref();

  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});});
  } catch(error) {
    clearInterval(simulation);clearInterval(heartbeat);
    await new Promise(resolve=>wss.close(resolve));
    server.close(()=>{});
    throw error;
  }
  return {port:server.address().port,host,app,server,
    close:async()=>{clearInterval(simulation);clearInterval(heartbeat);campaign.flush();for(const p of players.values())p.ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));},
    inspect:()=>({players:players.size,rooms:rooms.size,battles:battles.size}),
  };
}

if(require.main===module) {
  const args=process.argv.slice(2);const value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
  startServer({port:Number(value('--port')||3210),host:value('--host')||'127.0.0.1',saveDir:value('--save-dir'),rootDir:value('--root-dir')}).then(instance=>{
    console.log(`Empress: Pokémon 2D — http://${instance.host}:${instance.port}`);
    const shutdown=()=>instance.close().finally(()=>process.exit(0));process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  }).catch(error=>{console.error(error);process.exitCode=1;});
}

module.exports={startServer,localRequest,sameOrigin,permittedSocketOrigin,safeEqual,hostConnection};
