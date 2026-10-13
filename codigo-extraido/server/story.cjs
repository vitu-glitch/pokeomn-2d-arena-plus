'use strict';

                                                                             
                                                                   
const DIALOGUES={};
function dialogue(id,title,speaker,lines,requires=null){return DIALOGUES[id]={id,title,speaker,lines,requires};}
dialogue('intro','A letter sealed in silver','Professor Oak',[
  'A black envelope arrived at the lab this morning. The seal belongs to Empress, the reigning Indigo Champion.',
  'She has reopened the Midnight Circuit: eight Gym lanterns, the climb through Victory Road, and four guardians of the League.',
  'Her invitation is simple: bring partners you trust, earn every badge, and meet her beneath the moonlit dome.',
  'Your Pokémon are ready. Move to the Pewter stop on the route map and select it to meet Brock. Each victory opens the next stop.',
]);
dialogue('home-guide','Before the first step','Professor Oak',[
  'Move between the unlocked stops on the route map. Select a stop to meet its trainer and hear their challenge.',
  'Your team recovers between challenges, and every earned badge remains yours even if you lose later.',
  'In the arena, move to face your opponent, then use one of your four moves. A dodge or a well-timed switch can save a partner.',
]);

const CHAPTERS=[
  {stage:'gym-1',region:'pewter',place:'Pewter Town',speaker:'Brock',theme:'stone',x:680,y:1860,
    before:['Empress asked each of us to light a lantern for a trainer worth meeting. Mine stands on a foundation of stone.','Strength begins with knowing your footing. Watch the pillars, choose your angle, and commit when the opening is real.','Earn the Boulder Badge, and I will open the eastern road to Cerulean.'],
    after:['You did not ask your partners to break the mountain. You found a way through it.','Take the Boulder Badge. The first lantern is yours, and the road to Misty is open.','Remember that feeling: you can pause, look, and choose. There is no need to rush every fight.']},
  {stage:'gym-2',region:'cerulean',place:'Cerulean Waterfront',speaker:'Misty',theme:'water',x:1140,y:1860,
    before:['Brock says you have steady feet. Let us see whether you can keep them when the rhythm changes.','Water never takes the same route twice. Follow your opponent, leave room to dodge, and do not chase every splash.','The Cascade lantern guides ships toward Vermilion. Win here, and we will light it together.'],
    after:['That was a real current! You adjusted instead of trying to force the same attack again.','The Cascade Badge is yours. Lt. Surge is waiting beyond the harbor road.','Empress once lost to me because she refused to retreat a single step. Ask her about it when you reach the League.']},
  {stage:'gym-3',region:'vermilion',place:'Vermilion Harbor',speaker:'Lt. Surge',theme:'electric',x:1580,y:1860,
    before:['Welcome to the harbor, challenger! The League needs trainers who can keep their heads when the lights start flashing.','A big attack is a promise. If you wind it up in the wrong place, the enemy has time to answer.','Show me clean timing, and the Thunder Badge will carry you onto the garden road.'],
    after:['Good discipline! You gave your partners a chance to act instead of throwing them into every hit.','Take the Thunder Badge. The gate to Celadon is powered up.','The Champion is quiet, but quiet does not mean uncertain. Watch her as carefully as you watched me.']},
  {stage:'gym-4',region:'celadon',place:'Celadon Gardens',speaker:'Erika',theme:'forest',x:2020,y:1860,
    before:['Please take a breath. The circuit is a long journey, and your partners notice when you are tired.','A garden survives through balance: a little patience, a little shelter, and the courage to grow toward the light.','Our battle will decide whether the Rainbow lantern joins your path.'],
    after:['Your team made room for one another. That is a beautiful kind of strength.','Here is the Rainbow Badge. The woodland path to Fuchsia is now open.','Empress tends the flowers in the League courtyard herself. Even the darkest hall needs something living in it.']},
  {stage:'gym-5',region:'fuchsia',place:'Fuchsia Woodland',speaker:'Koga',theme:'forest',x:2460,y:1660,
    before:['You have followed four bright lanterns. Here, the lesson waits in the shadows between them.','Poison, a missed opening, a careless pursuit: a small mistake can follow you through an entire battle.','Observe first. When you can recognize a trap without fearing it, the Soul Badge will be yours.'],
    after:['You saw through the feint and kept your purpose. The Soul lantern answers you.','Take this badge, then follow the northern trail to Saffron.','You will hear many stories about Empress. Learn from them, but face the person before you rather than a rumor.']},
  {stage:'gym-6',region:'saffron',place:'Saffron Observatory',speaker:'Sabrina',theme:'psychic',x:2460,y:1200,
    before:['I knew a challenger would arrive today. I did not know what they would choose. That part is always yours.','Your opponents reveal intentions in the moment before a move. Learn to see the windup without surrendering your own plan.','The Marsh lantern opens the western passage toward Cinnabar. Show me a future you have earned.'],
    after:['There were many possible endings. You and your partners chose this one together.','The Marsh Badge is yours. Follow the warm lights west to Blaine.','At the end of this road, Empress will ask why you came. No prediction can answer that question for you.']},
  {stage:'gym-7',region:'cinnabar',place:'Cinnabar Caldera',speaker:'Blaine',theme:'fire',x:2010,y:1200,
    before:['A quiz before we begin: what happens when a trainer confuses courage with standing in a flamethrower?','They get a very short lesson! Keep moving, respect the heat, and save your boldest answer for the right opening.','The Volcano lantern has waited a long time for a challenger with a little spark.'],
    after:['Correct! Courage is deciding when to step in, and when to step aside.','Here is the Volcano Badge. Viridian lies along the cooling ridge to the west.','Seven lanterns, one to go. Let that warm you; do not let it make you careless.']},
  {stage:'gym-8',region:'viridian',place:'Viridian Stone Gate',speaker:'Giovanni',theme:'stone',x:1550,y:1200,
    before:['Seven leaders have judged you worthy. Their judgment earns you an audience, not a victory.','A trainer who understands power must also understand its limits. Type advantage, position, and patience are all forms of power.','Defeat me, and the Earth Badge will open Victory Road.'],
    after:['You used what you had, and you did not abandon your partners when the ground shifted.','Take the Earth Badge. All eight lanterns are lit. The mountain gate is open.','Beyond this point there are no Gym leaders left to impress. Decide what you are fighting for.']},
  {stage:'victory-1',region:'victory-gate',place:'Victory Road · Lower Pass',speaker:'Ace Trainer Rowan',theme:'stone',x:1110,y:1130,
    before:['Eight badges! I have been watching their lanterns appear along the horizon.','I am the first road warden. Our job is to make sure no trainer reaches the summit by luck alone.','You can return to earlier towns whenever you need a moment. When you are ready, show me the team that brought you here.'],
    after:['That was no accident. The upper pass is yours.','There is one more warden at the summit. They will test how you handle a team without a single shared weakness.','Look back before you climb. Every light down there is a place where you learned something.']},
  {stage:'victory-2',region:'victory-summit',place:'Victory Road · High Camp',speaker:'Veteran Trainer Vale',theme:'snow',x:690,y:900,
    before:['The air is thin up here. Trainers sometimes reach the summit and forget to breathe.','I will not give you a neat pattern to solve. You will need to adapt, switch, and trust more than one partner.','Beyond this camp stands the Indigo League. Let us find out whether you are ready to enter.'],
    after:['You are ready. Take this invitation through the northern gate.','The Elite Four will each ask you a different question. Your answers will be written in the way you battle.','You have a checkpoint here. A defeat inside the League will never erase the road you have already earned.']},
  {stage:'elite-1',region:'league-ice',place:'Indigo League · Crystal Hall',speaker:'Lorelei',theme:'snow',x:690,y:430,
    before:['Welcome to the Indigo League. Leave the noise of the climb outside.','Ice rewards calm decisions. A brief freeze is a setback, not a reason to give up your next opening.','If you can keep your purpose when the battle slows, the first inner door will open.'],
    after:['A steady heart outlasts a cold moment. You may pass.','Bruno waits in the Stone Hall. His challenge is direct, but direct never means simple.']},
  {stage:'elite-2',region:'league-stone',place:'Indigo League · Stone Hall',speaker:'Bruno',theme:'stone',x:1150,y:430,
    before:['Your footsteps are steady. Good. A strong stance begins before the first blow.','A partner needs space to strike and a path to retreat. Watch both.','Show me strength that protects the team behind it.'],
    after:['You stood your ground when it mattered, and yielded when it was wise.','The Stone Hall recognizes you. Agatha waits beyond the next lantern.']},
  {stage:'elite-3',region:'league-shade',place:'Indigo League · Violet Hall',speaker:'Agatha',theme:'ghost',x:1610,y:430,
    before:['So this is the trainer everyone has been whispering about. You look more alive than most legends.','Do not let a dark room make you imagine a monster in every corner. Some attacks will pass straight through the wrong opponent.','Use your knowledge. Fear is a poor substitute for a type chart.'],
    after:['There. A little experience has more bite than a grand reputation.','Go to Lance. And when you meet Empress, tell her the flowers she sent are still blooming.']},
  {stage:'elite-4',region:'league-dragon',place:'Indigo League · Dragon Hall',speaker:'Lance',theme:'dragon',x:2070,y:430,
    before:['The last Elite door stands behind me. Beyond it, the Champion is waiting.','A powerful team can end a battle quickly, but a great trainer gives every partner a reason to trust them.','Bring everything you learned on the road. I will do the same.'],
    after:['You have earned the final audience. The moonlit court is open.','Empress chose her name as a promise to stand with dignity, not above other people. Meet her with the same respect.','Whatever happens next, you already belong among the trainers who made this journey.']},
  {stage:'champion',region:'moon-court',place:'Indigo League · Moonlit Court',speaker:'Empress',theme:'moon',x:2530,y:430,
    before:['At last. I watched the lanterns wake along your road, one by one. Welcome to my court.','They call me Empress. The title sounds solitary, but no one reaches this room alone. Gardevoir, Zoroark, and Milotic have carried every victory with me.','I opened the circuit because a crown should never become a locked door. Tonight, you have the right to challenge mine.','You have heard why everyone else battles. Now show me your answer.'],
    after:['Beautifully fought. You did not try to become the trainer you imagined I was. You trusted the one you had become.','The title of Champion is yours. Let the Hall of Fame remember every partner who brought you here.','Keep the lanterns lit for whoever follows. A journey this good deserves another beginning.']},
];

dialogue('ending','The lanterns remain','Empress',[
  'Beyond the glass dome, the first light of morning reaches the mountain. Every lantern on the road is still shining.',
  'Your team steps beside you as the Hall of Fame records a new Champion. Empress offers a quiet smile and a final bow.',
  'The Midnight Circuit is complete. You may explore every town, speak to the trainers again, and return for rematches whenever you wish.',
  'You came to earn a crown. You leave with a road full of people and Pokémon who know your name.',
],'champion');
dialogue('lost-battle','A pause on the road','League Attendant',[
  'Your partners have recovered. A lost battle does not erase a badge, a friendship, or anything you learned.',
  'You can change your team, explore an earlier town, or speak to this trainer when you are ready for another attempt.',
]);

const home={id:'pallet',name:'Pallet Lantern Square',kind:'home',theme:'forest',x:260,y:1860,stage:null,requires:null};
const REGIONS=[home,...CHAPTERS.map((chapter,index)=>({id:chapter.region,name:chapter.place,kind:index<8?'town':index<10?'road':index<14?'league':'champion',theme:chapter.theme,x:chapter.x,y:chapter.y,stage:chapter.stage,requires:index?CHAPTERS[index-1].stage:null}))].map(region=>({...region,width:320,height:280,bounds:{x:region.x-160,y:region.y-140,w:320,h:280},spawn:{x:region.x,y:region.y+80}}));
const ROUTES=REGIONS.slice(1).map((region,index)=>{
  const from=REGIONS[index];
  return {id:`route-${from.id}-${region.id}`,from:from.id,to:region.id,width:112,requires:region.requires,unlockAfter:region.requires,points:[{x:from.x,y:from.y},{x:region.x,y:region.y}],name:`${from.name} → ${region.name}`,lockedText:region.requires?`Earn the ${region.requires.startsWith('gym-')?'previous badge':'previous victory'} to open this passage.`:''};
});
const NPCS=[{id:'oak',name:'Professor Oak',x:home.x,y:home.y-35,region:home.id,dialogue:'intro',afterDialogue:'home-guide',stage:null,portrait:'oak'}];
for(const [index,chapter] of CHAPTERS.entries()) {
  dialogue(`${chapter.stage}-approach`,chapter.place,chapter.speaker,chapter.before,index?CHAPTERS[index-1].stage:null);
  dialogue(`${chapter.stage}-after`,chapter.stage==='champion'?'A new Champion':`${chapter.speaker}'s lantern`,chapter.speaker,chapter.after,chapter.stage);
  NPCS.push({id:`trainer-${chapter.stage}`,name:chapter.speaker,x:chapter.x,y:chapter.y-35,region:chapter.region,dialogue:`${chapter.stage}-approach`,afterDialogue:`${chapter.stage}-after`,stage:chapter.stage,portrait:chapter.stage==='champion'?'empress':chapter.speaker.toLowerCase().replace(/[^a-z]/g,'')});
                                                                              
  const id=`${chapter.region}-resident`;
  dialogue(id,'Along the lantern road','Route Keeper',[
    index<8?`The ${chapter.place} lantern lights after its Gym challenge. Travelers stop here to watch it wake.`:index<10?'The mountain feels smaller when you can see how far you have already walked.':'The League halls are quiet because the Pokémon are listening as closely as the trainers.',
    `Your next conversation is with ${chapter.speaker}. The notice beside the path will remember your objective.`,
  ],index?CHAPTERS[index-1].stage:null);
  NPCS.push({id,name:'Route Keeper',x:chapter.x-105,y:chapter.y+70,region:chapter.region,dialogue:id,afterDialogue:id,stage:null,portrait:'keeper'});
}
const OBSTACLES=REGIONS.flatMap(region=>[
  {id:`${region.id}-planter-a`,region:region.id,kind:region.theme==='stone'?'rock':'tree',x:region.x-135,y:region.y-130,w:34,h:34,solid:true},
  {id:`${region.id}-planter-b`,region:region.id,kind:region.theme==='snow'?'crystal':'tree',x:region.x+101,y:region.y-130,w:34,h:34,solid:true},
]).filter(obstacle=>!ROUTES.some(route=>route.points.slice(1).some((b,index)=>segmentDistance({x:obstacle.x+obstacle.w/2,y:obstacle.y+obstacle.h/2},route.points[index],b)<=route.width/2+Math.hypot(obstacle.w,obstacle.h)/2+10)));
const WORLD={id:'midnight-circuit',title:'The Midnight Circuit',width:2800,height:2100,tileSize:32,spawn:{...REGIONS[0].spawn,region:'pallet'},regions:REGIONS,routes:ROUTES,obstacles:OBSTACLES,npcs:NPCS,portals:[]};

function unlockedRegions(completed){const done=new Set(completed);return REGIONS.filter(region=>!region.requires||done.has(region.requires)).map(region=>region.id);}
function segmentDistance(point,a,b){const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;const t=length?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length)):0;return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);}
function walkable(point,completed) {
  if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<16||point.x>WORLD.width-16||point.y<16||point.y>WORLD.height-16)return false;
  if(OBSTACLES.some(o=>point.x>=o.x-10&&point.x<=o.x+o.w+10&&point.y>=o.y-10&&point.y<=o.y+o.h+10))return false;
  const done=new Set(completed),unlocked=new Set(unlockedRegions(completed));
  if(REGIONS.some(region=>unlocked.has(region.id)&&point.x>=region.bounds.x+10&&point.x<=region.bounds.x+region.bounds.w-10&&point.y>=region.bounds.y+10&&point.y<=region.bounds.y+region.bounds.h-10))return true;
  return ROUTES.some(route=>(!route.requires||done.has(route.requires))&&route.points.slice(1).some((b,index)=>segmentDistance(point,route.points[index],b)<=route.width/2-10));
}
function regionAt(point,completed){const open=new Set(unlockedRegions(completed));return REGIONS.filter(r=>open.has(r.id)).sort((a,b)=>Math.hypot(a.x-point.x,a.y-point.y)-Math.hypot(b.x-point.x,b.y-point.y))[0]?.id||'pallet';}
function defaultStory(completed=[]) {
  const current=CHAPTERS[Math.min(completed.length,CHAPTERS.length-1)];
  const region=completed.length?REGIONS.find(r=>r.id===current.region):REGIONS[0];
  return {position:{...region.spawn},currentRegion:region.id,introSeen:false,endingSeen:false,dialogueSeen:[],lastResult:null};
}
function summary(story,completed) {
  const chapter=CHAPTERS[Math.min(completed.length,CHAPTERS.length-1)];
  return {...story,position:{...story.position},dialogueSeen:[...story.dialogueSeen],chapter:completed.includes('champion')?'Champion of the Midnight Circuit':chapter.place,objective:completed.includes('champion')?'Visit the Hall of Fame, explore the open circuit, or challenge your favorite trainers again.':`Travel to ${chapter.place} and speak with ${chapter.speaker}.`,unlockedRegions:unlockedRegions(completed)};
}

module.exports={WORLD,DIALOGUES,CHAPTERS,walkable,regionAt,defaultStory,summary,unlockedRegions};
