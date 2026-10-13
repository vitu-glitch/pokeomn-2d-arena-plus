const PROTOCOL='empress-battle-1';
const MAX_GUEST_BYTES=16384;
const MAX_STATE_BYTES=262144;
const DEFAULT_TIMEOUT=25000;
let peerLibrary;

export function parseOnlineInvite(value) {
  const text=String(value||'').trim();
  let code,token;
  const match=/^EMPRESS1:([A-Z0-9]{6}):([A-Za-z0-9_-]{32})$/i.exec(text);
  if(match){code=match[1].toUpperCase();token=match[2];}
  else {
    let url;try{url=new URL(text);}catch{throw Error('Paste the complete Empress online code.');}
    if(url.protocol!=='empress:'||url.hostname!=='battle')throw Error('Paste the complete Empress online code.');
    code=(url.searchParams.get('room')||'').toUpperCase();token=url.searchParams.get('token')||'';
  }
  if(!/^[A-Z0-9]{6}$/.test(code)||!/^[A-Za-z0-9_-]{32}$/.test(token))throw Error('This Empress online code is incomplete or invalid.');
  return {online:true,code,token,url:onlineInvite({code,token})};
}

export function onlineInvite({code,token}) {return `EMPRESS1:${code}:${token}`;}

function peerId(invite) {return `empress-pokemon-${invite.code}-${invite.token.slice(0,12)}`;}

export function guestMessage(value,invite) {
  if(typeof value!=='string'||value.length>MAX_GUEST_BYTES)return null;
  let message;try{message=JSON.parse(value);}catch{return null;}
  if(!message||typeof message!=='object'||Array.isArray(message))return null;
  if(message.type==='hello')return JSON.stringify({type:'hello',name:String(message.name||'Trainer').slice(0,24)});
  if(message.type==='joinRoom') {
    if(message.code!==invite.code||message.token!==invite.token)return null;
    return JSON.stringify({type:'joinRoom',code:invite.code,token:invite.token,team:message.team});
  }
  if(message.type==='ping')return JSON.stringify({type:'ping',at:Number.isFinite(message.at)?message.at:0});
  if(message.type==='leave')return JSON.stringify({type:'leave'});
  if(message.type==='input') {
    const input={type:'input'};
    for(const key of ['seq','dx','dy','aimX','aimY','cast','switch'])if(Number.isFinite(message[key]))input[key]=message[key];
    input.dodge=message.dodge===true;
    return JSON.stringify(input);
  }
  return null;
}

function loadPeer() {
  if(globalThis.Peer)return Promise.resolve(globalThis.Peer);
  if(!peerLibrary)peerLibrary=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=new URL('./vendor/peerjs-1.5.5.min.js',import.meta.url).href;
    script.onload=()=>globalThis.Peer?resolve(globalThis.Peer):reject(Error('The Empress online component could not start.'));
    script.onerror=()=>{peerLibrary=null;reject(Error('The Empress online component could not load.'));};
    document.head.append(script);
  });
  return peerLibrary;
}

async function connectionOptions(overrides={}) {
  let config={iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun.cloudflare.com:3478']}]};
  if(!overrides.config)try {
    const response=await fetch('/api/online-config',{signal:AbortSignal.timeout(5000)});
    const data=response.ok?await response.json():null;
    if(Array.isArray(data?.iceServers)&&data.iceServers.length)config={iceServers:data.iceServers};
  }catch{}
  return {secure:true,debug:0,config,...overrides};
}

function onlineError(error) {
  if(error?.type==='peer-unavailable')return 'This online room is no longer available. Ask your friend for a new code.';
  if(error?.type==='unavailable-id')return 'This online room could not register. Create a new room.';
  return 'The online connection could not be established. Keep both games open and check your internet connection. Some networks require a TURN relay.';
}

function waitPeer(peer,timeout) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{peer.destroy();reject(Error('The online signaling service did not respond. Check your internet connection.'));},timeout);
    peer.once('open',()=>{clearTimeout(timer);resolve();});
    peer.once('error',error=>{clearTimeout(timer);reject(Error(onlineError(error)));});
  });
}

export async function createOnlineHost({code,token,serverOrigin=location.origin,onStatus=()=>{},peerOptions={},timeout=DEFAULT_TIMEOUT}) {
  const invite=parseOnlineInvite(onlineInvite({code,token}));
  const Peer=await loadPeer();
  const peer=new Peer(peerId(invite),await connectionOptions(peerOptions));
  let active=null,closed=false;
  const bridges=new Set();
  const close=()=>{if(closed)return;closed=true;for(const bridge of bridges)bridge.close();bridges.clear();peer.destroy();};
  peer.on('connection',connection=>{
    if(closed||active||connection.label!==PROTOCOL||connection.metadata?.protocol!==PROTOCOL||connection.metadata?.code!==invite.code||connection.metadata?.token!==invite.token){connection.close();return;}
    active=connection;
    let ws=null,done=false,queue=[],rateAt=Date.now(),rateCount=0;
    const bridge={close:()=>{if(done)return;done=true;clearTimeout(timer);bridges.delete(bridge);if(active===connection)active=null;try{connection.close();}catch{}try{ws?.close();}catch{};}};
    const timer=setTimeout(()=>{onStatus('The guest connection timed out. Share a fresh code if needed.');bridge.close();},timeout);
    bridges.add(bridge);
    connection.on('open',()=>{
      if(done)return;
      const url=new URL('/ws?guest=1',serverOrigin);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      ws=new WebSocket(url);
      ws.onopen=()=>{clearTimeout(timer);for(const item of queue)ws.send(item);queue=[];onStatus('Friend connected online.');};
      ws.onmessage=event=>{
        if(done||!connection.open)return;
        if(connection.dataChannel?.bufferedAmount>512*1024){bridge.close();return;}
        connection.send(event.data);
      };
      ws.onerror=()=>bridge.close();ws.onclose=()=>bridge.close();
    });
    connection.on('data',value=>{
      if(done)return;
      if(Date.now()-rateAt>1000){rateAt=Date.now();rateCount=0;}
      if(++rateCount>140){bridge.close();return;}
      const safe=guestMessage(value,invite);
      if(!safe){bridge.close();return;}
      if(ws?.readyState===1)ws.send(safe);
      else if(queue.length<16)queue.push(safe);
      else bridge.close();
    });
    connection.on('error',()=>bridge.close());connection.on('close',()=>bridge.close());
  });
  peer.on('error',error=>{if(!closed)onStatus(onlineError(error));});
  peer.on('disconnected',()=>{if(closed)return;onStatus('Online signaling disconnected. Existing battles can continue.');try{peer.reconnect();}catch{}});
  try{await waitPeer(peer,timeout);}catch(error){close();throw error;}
  onStatus('Online room ready. Share the complete Empress code.');
  return {code:invite.url,invite:invite.url,close};
}

class OnlineSocket {
  constructor(invite,options) {
    this.invite=invite;this.options=options;this.readyState=0;this.listeners=new Map();this.peer=null;this.connection=null;this.timer=null;
    this.onopen=null;this.onmessage=null;this.onerror=null;this.onclose=null;this.url=`online:${invite.code}`;
    this.start();
  }
  get bufferedAmount(){return this.connection?.dataChannel?.bufferedAmount||0;}
  addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);}
  removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
  emit(type,event={}){const value={type,target:this,...event};this[`on${type}`]?.(value);for(const listener of this.listeners.get(type)||[])listener(value);}
  async start() {
    try {
      const Peer=await loadPeer();
      const config=await connectionOptions(this.options.peerOptions||{});
      if(this.readyState!==0)return;
      this.peer=new Peer(undefined,config);
      this.peer.on('error',error=>this.fail(onlineError(error)));
      this.peer.on('connection',connection=>connection.close());
      await waitPeer(this.peer,this.options.timeout||DEFAULT_TIMEOUT);
      if(this.readyState!==0)return;
      this.connection=this.peer.connect(peerId(this.invite),{label:PROTOCOL,reliable:true,serialization:'raw',metadata:{protocol:PROTOCOL,code:this.invite.code,token:this.invite.token}});
      this.timer=setTimeout(()=>this.fail('The host could not be reached online. Keep both games open. Your network may need a configured TURN relay.'),this.options.timeout||DEFAULT_TIMEOUT);
      this.connection.on('open',()=>{if(this.readyState!==0)return;clearTimeout(this.timer);this.readyState=1;this.options.onStatus?.('Connected to the online host.');this.emit('open');});
      this.connection.on('data',data=>{if(this.readyState!==1)return;if(typeof data!=='string'||data.length>MAX_STATE_BYTES){this.fail('The host sent an invalid online message.');return;}this.emit('message',{data});});
      this.connection.on('error',error=>this.fail(onlineError(error)));
      this.connection.on('close',()=>this.close(1001,'The host connection closed.'));
    }catch(error){this.fail(error.message);}
  }
  fail(message){if(this.readyState>=2)return;this.options.onStatus?.(message);this.emit('error',{message});this.close(1006,message);}
  send(value){if(this.readyState!==1)throw Error('The online connection is not open.');if(typeof value!=='string'||value.length>MAX_GUEST_BYTES)throw Error('The online message is too large.');if(this.bufferedAmount>256*1024){this.fail('The online connection could not keep up.');return;}this.connection.send(value);}
  close(code=1000,reason='') {if(this.readyState===3)return;this.readyState=3;clearTimeout(this.timer);try{this.connection?.close();}catch{}try{this.peer?.destroy();}catch{}this.emit('close',{code,reason,wasClean:code===1000});}
}

export function connectOnline(invite,options={}) {return new OnlineSocket(typeof invite==='string'?parseOnlineInvite(invite):parseOnlineInvite(onlineInvite(invite)),options);}
