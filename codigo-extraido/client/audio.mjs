                                                                                   
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const now = () => globalThis.performance?.now?.() ?? Date.now();
const idOf = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function channelVolume(settings, channel) {
  const muteName = `mute${channel[0].toUpperCase()}${channel.slice(1)}`;
  if (settings?.muted || settings?.mute || settings?.[muteName] || settings?.[`${channel}Muted`]) return 0;
  const value = Number(settings?.[channel] ?? {music:35,effects:70,cries:75}[channel]);
  return Number.isFinite(value) ? clamp(value / 100, 0, 1) : 0;
}

export function selectMoveRecording(manifest, type, moveId, phase = 'cast') {
  const move = manifest?.moves?.[idOf(moveId)] || manifest?.moves?.[manifest?.types?.[type]];
  return move?.[phase] || (phase === 'cast' ? manifest?.effects?.hit : null);
}

export class AudioBus {
  constructor(settingsGetter = () => ({}), speciesGetter = () => null, options = {}) {
    this.settings = settingsGetter;
    this.species = speciesGetter;
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this.AudioContext = options.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
    this.clock = options.clock || now;
    this.context = 'menu';
    this.contextRevision = 0;
    this.musicRevision = 0;
    this.ctx = null;
    this.channels = {};
    this.buffers = new Map();
    this.pending = new Map();
    this.active = new Set();
    this.recent = new Map();
    this.mutes = new Set();
    this.lastCry = {id:null,at:-Infinity};
    this.musicSource = null;
    this.musicKey = null;
    this.musicLoading = null;
    this.errors = [];
    this.closed = false;
    this.ready = options.manifest ? Promise.resolve(options.manifest) : this.fetch('/data/audio.json')
      .then(response => { if (!response.ok) throw Error(`Audio manifest: ${response.status}`); return response.json(); });
    this.ready = this.ready.then(manifest => { this.manifest=manifest; return manifest; }).catch(error => { this._error(error); return null; });
    this._publish();
  }

  _error(error) {
    this.errors.push(String(error?.message || error));
    if (this.errors.length > 8) this.errors.shift();
    this._publish();
  }

  unlock() {
    if (this.closed || !this.AudioContext) return Promise.resolve(false);
    try {
      if (!this.ctx) {
        this.ctx = new this.AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = .8;
        this.master.connect(this.ctx.destination);
        for (const channel of ['music','effects','cries']) {
          this.channels[channel] = this.ctx.createGain();
          this.channels[channel].connect(this.master);
        }
        this.update();
        this.diagnosticsTimer = setInterval(()=>this._publish(),500);
        this.diagnosticsTimer.unref?.();
      }
      const resumed = this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();
      return Promise.resolve(resumed).then(() => {
        if (!this.musicSource && !this.musicLoading && this.context !== 'silent') void this._startMusic(++this.musicRevision);
        this._publish();
        return true;
      }).catch(error => { this._error(error); return false; });
    } catch (error) { this._error(error); return Promise.resolve(false); }
  }

  update() {
    if (!this.ctx) return;
    const settings = this.settings() || {};
    for (const [name, gain] of Object.entries(this.channels)) {
      const volume = this.mutes.has(name) ? 0 : channelVolume(settings,name);
      gain.gain.cancelScheduledValues(this.ctx.currentTime);
      gain.gain.setTargetAtTime(volume,this.ctx.currentTime,.025);
    }
    this._publish();
  }

  setMuted(channel, muted = true) {
    if (!['music','effects','cries'].includes(channel)) return;
    if (muted) this.mutes.add(channel); else this.mutes.delete(channel);
    this.update();
  }

  music(context) { return this.setContext(context); }
  setContext(context = 'menu') {
    const next = String(context);
    if (this.context === next) {
      if (this.ctx && !this.musicSource && !this.musicLoading && next !== 'silent') void this._startMusic(++this.musicRevision);
      return;
    }
    this.context = next;
    this.contextRevision++;
    const revision = ++this.musicRevision;
                                                                                        
    this.stopEffects();
    if (next === 'silent') this._fadeMusic();
    else if (this.ctx) void this._startMusic(revision);
    this._publish();
  }

  async _buffer(src) {
    if (this.buffers.has(src)) {
      const value = this.buffers.get(src); this.buffers.delete(src); this.buffers.set(src,value); return value;
    }
    if (this.pending.has(src)) return this.pending.get(src);
    if (!src?.startsWith('/assets/')) throw Error('Audio must use a bundled asset');
    const task = this.fetch(src).then(response => {
      if (!response.ok) throw Error(`Audio recording: ${response.status} ${src}`);
      return response.arrayBuffer();
    }).then(data => this.ctx.decodeAudioData(data)).then(buffer => {
      this.buffers.set(src,buffer);
                                                                                  
      let bytes = [...this.buffers.values()].reduce((sum,b)=>sum+b.length*b.numberOfChannels*4,0);
      for(const [key,value] of this.buffers) {
        if(bytes <= 64*1024*1024 || this.buffers.size<=1) break;
        this.buffers.delete(key); bytes -= value.length*value.numberOfChannels*4;
      }
      return buffer;
    }).finally(() => this.pending.delete(src));
    this.pending.set(src,task);
    return task;
  }

  _fadeMusic() {
    const playing = this.musicSource;
    this.musicSource = null; this.musicKey = null;
    if (!playing || !this.ctx) return;
    const at = this.ctx.currentTime;
    playing.gain.gain.cancelScheduledValues(at);
    playing.gain.gain.setValueAtTime(playing.gain.gain.value,at);
    playing.gain.gain.linearRampToValueAtTime(0,at+.35);
    try { playing.source.stop(at+.36); } catch {}
  }

  async _startMusic(revision) {
    this.musicLoading=revision;
    this._publish();
    try {
      const manifest = await this.ready;
      if (!manifest || !this.ctx || this.closed || revision!==this.musicRevision || this.context==='silent') return;
      const key = manifest.music[this.context] || manifest.music.menu;
      if (this.musicSource && this.musicKey===key) return;
      const file = manifest.files[key];
      if (!file) return;
      const buffer = await this._buffer(file.src);
      if (this.closed || revision!==this.musicRevision || this.context==='silent') return;
      this._fadeMusic();
      const source = this.ctx.createBufferSource(), gain = this.ctx.createGain();
      source.buffer = buffer;
      source.loop = file.loop !== false;
      source.loopStart = Math.max(0,Math.min(file.loopStart || 0,buffer.duration-.01));
      source.loopEnd = buffer.duration;
      source.connect(gain); gain.connect(this.channels.music);
      gain.gain.setValueAtTime(0,this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(file.gain ?? .55,this.ctx.currentTime+.5);
      const playing = {source,gain,startedAt:this.ctx.currentTime,duration:buffer.duration,loopStart:source.loopStart};
      this.musicSource = playing; this.musicKey = key;
      source.onended=()=>{source.disconnect();gain.disconnect();if(this.musicSource===playing){this.musicSource=null;this.musicKey=null;}};
      source.start();
    } catch (error) { this._error(error); }
    finally { if(this.musicLoading===revision)this.musicLoading=null; this._publish(); }
  }

  _allowed(channel) {
    return !this.closed && !!this.ctx && this.context!=='silent' && !this.mutes.has(channel) && channelVolume(this.settings(),channel)>0;
  }

  async _play(key, channel='effects', options={}) {
    if (!this._allowed(channel)) return false;
    const revision = this.contextRevision, requestedAt = this.clock();
    try {
      const manifest = await this.ready;
      if(typeof key==='function')key=key(manifest);
      const file = key && typeof key === 'object' ? key : manifest?.files?.[key];
      if (!file) return false;
      const recent = this.recent.get(file.src) ?? -Infinity;
      if (requestedAt-recent<(options.throttle ?? 50)) return false;
      this.recent.set(file.src,requestedAt);
      if(this.recent.size>100)this.recent.delete(this.recent.keys().next().value);
      const buffer = await this._buffer(file.src);
      if (revision!==this.contextRevision || !this._allowed(channel) || this.clock()-requestedAt>1500) return false;
      const voices=[...this.active].filter(v=>v.channel===channel);
      const limit=channel==='cries'?2:12;
      if(voices.length>=limit)try{voices[0].source.stop();}catch{}
      const source=this.ctx.createBufferSource(),gain=this.ctx.createGain();
      source.buffer=buffer; source.connect(gain); gain.connect(this.channels[channel]);
      const volume=(file.gain ?? .6)*(options.gain ?? 1),at=this.ctx.currentTime;
      gain.gain.setValueAtTime(volume,at);
      const voice={source,gain,channel};this.active.add(voice);
      source.onended=()=>{this.active.delete(voice);source.disconnect();gain.disconnect();};
      source.start();
      if(options.duration && buffer.duration>options.duration){
        const end=at+Math.max(.04,options.duration);
        gain.gain.setValueAtTime(volume,Math.max(at,end-.03));
        gain.gain.linearRampToValueAtTime(0,end);
        source.stop(end+.01);
      }
      return true;
    } catch(error){this._error(error);return false;}
  }

  effect(name, options={}) { return this._play(m=>m?.effects?.[name],'effects',options); }
  cast(type,moveId) { return this._play(m=>selectMoveRecording(m,type,moveId)); }
  move(moveId,type) { return this.cast(type,moveId); }
  windup(moveId,type,duration=.18) {
    return this._play(m=>selectMoveRecording(m,type,moveId,'windup'),'effects',{duration,gain:.6});
  }
                                                                                     
  tone(_frequency,duration=.18) { return this.effect('charge',{duration,gain:.4,throttle:90}); }
  click() { return this.effect('click',{throttle:45}); }
  hit(_type,effectiveness=1) { return this.effect(effectiveness>1?'hitStrong':effectiveness>0&&effectiveness<1?'hitWeak':'hit',{throttle:40}); }
  sendout() { return this.effect('sendout'); }
  recall() { return this.effect('recall'); }
  faint() { return this.effect('faint'); }
  heal() { return this.effect('heal'); }
  win() { this.setContext('victory'); }
  cry(speciesId) {
    const mon=typeof speciesId==='object'?speciesId:this.species(speciesId);
    const src=mon?.cry;
    if(!src || !this._allowed('cries'))return Promise.resolve(false);
    const current=this.clock();
    if(this.lastCry.id===src&&current-this.lastCry.at<650)return Promise.resolve(false);
    this.lastCry={id:src,at:current};
    return this._play({src,gain:.65},'cries',{throttle:80});
  }

  stopEffects() { for(const voice of this.active)try{voice.source.stop();}catch{}this.active.clear(); }
  stop() { this.setContext('silent'); }
  destroy() { this.closed=true;this.contextRevision++;this.musicRevision++;this.stopEffects();this._fadeMusic();this.buffers.clear();clearInterval(this.diagnosticsTimer);void this.ctx?.close?.();this._publish(); }
  get status() { return {context:this.context,track:this.musicKey,unlocked:!!this.ctx,state:this.ctx?.state||'locked',elapsed:this.musicSource?Math.max(0,this.ctx.currentTime-this.musicSource.startedAt):0,activeVoices:this.active.size,cachedRecordings:this.buffers.size,errors:[...this.errors]}; }
  _publish() {
    const root=globalThis.document?.documentElement;
    if(!root)return;
    const settings=this.settings()||{},muted=this.mutes.has('music')||channelVolume(settings,'music')===0;
    root.dataset.audioScene=this.context;
    root.dataset.audioTrack=this.musicKey||'';
    root.dataset.audioState=this.closed?'closed':!this.ctx?'locked':this.context==='silent'?'silent':muted?'muted':this.ctx.state!=='running'?this.ctx.state:this.musicSource?'playing':this.musicLoading?'loading':this.errors.length?'error':'ready';
    root.dataset.audioElapsed=(this.musicSource?Math.max(0,this.ctx.currentTime-this.musicSource.startedAt):0).toFixed(2);
    root.dataset.audioVoices=String(this.active.size);
    for(const channel of ['music','effects','cries'])root.dataset[`audio${channel[0].toUpperCase()}${channel.slice(1)}Volume`]=String(this.mutes.has(channel)?0:channelVolume(settings,channel));
  }
}

const noop = () => {};
export const SILENT_AUDIO = Object.freeze(Object.fromEntries([
  'unlock','update','setMuted','music','setContext','cast','move','windup','tone','click','hit','sendout','recall','faint','heal','win','cry','effect','stopEffects','stop','destroy'
].map(name=>[name,noop])));
