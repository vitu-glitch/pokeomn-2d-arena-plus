'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {WORLD,DIALOGUES,CHAPTERS,walkable,regionAt,defaultStory,summary}=require('./story.cjs');

const STAGES=[
  {id:'gym-1',name:'Brock',title:'Pewter Gym',kind:'gym',reward:'Boulder Badge',theme:'Rock',arena:'ruins',team:['geodude','onix','golem']},
  {id:'gym-2',name:'Misty',title:'Cerulean Gym',kind:'gym',reward:'Cascade Badge',theme:'Water',arena:'coast',team:['psyduck','staryu','starmie']},
  {id:'gym-3',name:'Lt. Surge',title:'Vermilion Gym',kind:'gym',reward:'Thunder Badge',theme:'Electric',arena:'stadium',team:['voltorb','magneton','raichu']},
  {id:'gym-4',name:'Erika',title:'Celadon Gym',kind:'gym',reward:'Rainbow Badge',theme:'Grass',arena:'forest',team:['tangela','victreebel','vileplume']},
  {id:'gym-5',name:'Koga',title:'Fuchsia Gym',kind:'gym',reward:'Soul Badge',theme:'Poison',arena:'forest',team:['weezing','muk','venomoth']},
  {id:'gym-6',name:'Sabrina',title:'Saffron Gym',kind:'gym',reward:'Marsh Badge',theme:'Psychic',arena:'ruins',team:['kadabra','mrmime','alakazam']},
  {id:'gym-7',name:'Blaine',title:'Cinnabar Gym',kind:'gym',reward:'Volcano Badge',theme:'Fire',arena:'volcano',team:['rapidash','ninetales','arcanine']},
  {id:'gym-8',name:'Giovanni',title:'Viridian Gym',kind:'gym',reward:'Earth Badge',theme:'Ground',arena:'ruins',team:['dugtrio','rhydon','nidoking']},
  {id:'victory-1',name:'Ace Trainer Rowan',title:'Victory Road · Gate',kind:'road',reward:'Road checkpoint I',theme:'Mixed',arena:'ruins',team:['machamp','golem','crobat']},
  {id:'victory-2',name:'Veteran Trainer Vale',title:'Victory Road · Summit',kind:'road',reward:'League invitation',theme:'Mixed',arena:'summit',team:['gyarados','arcanine','dragonite']},
  {id:'elite-1',name:'Lorelei',title:'Elite Four · Ice',kind:'elite',reward:'League checkpoint I',theme:'Ice',arena:'summit',team:['dewgong','cloyster','lapras']},
  {id:'elite-2',name:'Bruno',title:'Elite Four · Fighting',kind:'elite',reward:'League checkpoint II',theme:'Fighting',arena:'ruins',team:['hitmonlee','hitmonchan','machamp']},
  {id:'elite-3',name:'Agatha',title:'Elite Four · Ghost',kind:'elite',reward:'League checkpoint III',theme:'Ghost',arena:'forest',team:['haunter','arbok','gengar']},
  {id:'elite-4',name:'Lance',title:'Elite Four · Dragon',kind:'elite',reward:'Champion challenge',theme:'Dragon',arena:'summit',team:['gyarados','aerodactyl','dragonite']},
  {id:'champion',name:'Empress',title:'Empress · The Moonlit Court',kind:'champion',reward:'Hall of Fame',theme:'Moonlit Court',arena:'stadium',team:['gardevoir','zoroark','milotic']},
];

class CampaignStore {
  constructor(saveDir) {
    this.file=path.join(saveDir,'campaign.json');this.state={version:1,completed:[],revision:0,wins:0,losses:0,story:defaultStory()};this.dirty=false;this.lastSavedAt=0;
    fs.mkdirSync(saveDir,{recursive:true});
    try {
      const stored=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(stored.version===1 && Array.isArray(stored.completed)) {
                                                                                
                                                                            
        const ids=new Set(stored.completed);const completed=[];
        for(const stage of STAGES){if(!ids.has(stage.id))break;completed.push(stage.id);}
        const count=value=>Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
        const story=defaultStory(completed),saved=stored.story;
        if(saved&&typeof saved==='object') {
          if(walkable(saved.position,completed)){story.position={x:saved.position.x,y:saved.position.y};story.currentRegion=regionAt(story.position,completed);}
          story.dialogueSeen=Array.isArray(saved.dialogueSeen)?[...new Set(saved.dialogueSeen.filter(id=>DIALOGUES[id]&&(!DIALOGUES[id].requires||completed.includes(DIALOGUES[id].requires))))]:[];
          story.introSeen=Boolean(saved.introSeen||story.dialogueSeen.includes('intro'));
          story.endingSeen=completed.includes('champion')&&Boolean(saved.endingSeen||story.dialogueSeen.includes('ending'));
          if(saved.lastResult&&STAGES.some(s=>s.id===saved.lastResult.stage))story.lastResult={stage:saved.lastResult.stage,won:Boolean(saved.lastResult.won),dialogueId:saved.lastResult.won?`${saved.lastResult.stage}-after`:'lost-battle'};
        }
        this.state={version:1,completed,revision:count(stored.revision),wins:count(stored.wins),losses:count(stored.losses),story};
      }
    } catch(error) {
      if(error.code!=='ENOENT') {try{fs.copyFileSync(this.file,`${this.file}.corrupt-${Date.now()}`);}catch{}}
    }
  }
  view() {
    const completed=[...this.state.completed];
    return {version:1,revision:this.state.revision,wins:this.state.wins,losses:this.state.losses,
      badges:completed.filter(id=>id.startsWith('gym-')),completed,champion:completed.includes('champion'),
      unlocked:STAGES.slice(0,Math.min(STAGES.length,completed.length+1)).map(s=>s.id),stages:STAGES,
      nextStage:STAGES[completed.length]?.id||null,story:summary(this.state.story,completed)};
  }
  storyView() {
    const view=this.view();
    return {world:WORLD,progress:{...view.story,badges:view.badges,completed:view.completed,unlocked:view.unlocked,champion:view.champion,revision:view.revision,nextStage:view.nextStage},dialogues:DIALOGUES};
  }
  canPlay(id) {return this.view().unlocked.includes(id);}
  travel(position) {
    if(!walkable(position,this.state.completed))throw new Error('That part of the route is blocked or has not opened yet.');
    this.state.story.position={x:Math.round(position.x*10)/10,y:Math.round(position.y*10)/10};
    this.state.story.currentRegion=regionAt(position,this.state.completed);this.dirty=true;
    if(Date.now()-this.lastSavedAt>=1000)this.save();
    return this.storyView();
  }
  seeDialogue(id) {
    const scene=DIALOGUES[id];
    if(!scene||scene.requires&&!this.state.completed.includes(scene.requires))throw new Error('That chapter has not opened yet.');
    if(!this.state.story.dialogueSeen.includes(id)) {
      const before=JSON.parse(JSON.stringify(this.state)),wasDirty=this.dirty;
      this.state.story.dialogueSeen.push(id);if(id==='intro')this.state.story.introSeen=true;if(id==='ending')this.state.story.endingSeen=true;
      this.state.revision++;
      try{this.save();}catch(error){this.state=before;this.dirty=wasDirty;throw error;}
    }
    return this.storyView();
  }
  result(id,won) {
    if(!STAGES.some(s=>s.id===id)||!this.canPlay(id))throw new Error('That campaign stage is locked.');
    const before=JSON.parse(JSON.stringify(this.state));
    if(won) {this.state.wins++;if(!this.state.completed.includes(id))this.state.completed.push(id);}else this.state.losses++;
    this.state.revision++;
    const region=WORLD.regions.find(r=>r.stage===id);
    this.state.story.position={...region.spawn};this.state.story.currentRegion=region.id;
    this.state.story.lastResult={stage:id,won:Boolean(won),dialogueId:won?`${id}-after`:'lost-battle'};
    try {this.save();}catch(error){this.state=before;throw error;}
    return this.view();
  }
  save() {
    const temporary=`${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary,JSON.stringify(this.state,null,2),'utf8');
    fs.renameSync(temporary,this.file);
    this.dirty=false;this.lastSavedAt=Date.now();
  }
  flush(){if(this.dirty)this.save();}
}

module.exports={CampaignStore,STAGES};
