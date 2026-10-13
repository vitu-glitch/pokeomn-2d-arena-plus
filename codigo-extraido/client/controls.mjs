export const KEY_ACTIONS=Object.freeze([
  {id:'up',label:'Move up',contexts:['battle','story'],defaults:['KeyW','ArrowUp']},
  {id:'down',label:'Move down',contexts:['battle','story'],defaults:['KeyS','ArrowDown']},
  {id:'left',label:'Move left',contexts:['battle','story'],defaults:['KeyA','ArrowLeft']},
  {id:'right',label:'Move right',contexts:['battle','story'],defaults:['KeyD','ArrowRight']},
  {id:'move1',label:'Move 1',contexts:['battle'],defaults:['Digit1']},
  {id:'move2',label:'Move 2',contexts:['battle'],defaults:['Digit2']},
  {id:'move3',label:'Move 3',contexts:['battle'],defaults:['Digit3']},
  {id:'move4',label:'Move 4',contexts:['battle'],defaults:['Digit4']},
  {id:'dodge',label:'Dodge',contexts:['battle'],defaults:['Space']},
  {id:'previous',label:'Previous Pokémon',contexts:['battle'],defaults:['KeyQ']},
  {id:'next',label:'Next Pokémon',contexts:['battle'],defaults:['KeyE']},
  {id:'interact',label:'Story visit / dialogue',contexts:['story'],defaults:['KeyE','Enter','Space']}
].map(action=>Object.freeze({...action,contexts:Object.freeze(action.contexts),defaults:Object.freeze(action.defaults)})));

export function validKeyCode(code){return code!=='F11'&&typeof code==='string'&&/^(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)|Arrow(?:Up|Down|Left|Right)|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ShiftLeft|ShiftRight|ControlLeft|ControlRight|AltLeft|AltRight|CapsLock|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|F(?:[1-9]|1[0-2]))$/.test(code);}

export function defaultBindings(){return Object.fromEntries(KEY_ACTIONS.map(action=>[action.id,[...action.defaults]]));}

function overlap(first,second){return first.contexts.some(context=>second.contexts.includes(context));}

export function bindKey(bindings,id,index,code){
  const action=KEY_ACTIONS.find(item=>item.id===id);
  if(!action||!Number.isInteger(index)||index<0||index>=action.defaults.length||!validKeyCode(code))return null;
  const next=Object.fromEntries(KEY_ACTIONS.map(item=>[item.id,[...(bindings[item.id]||item.defaults)]]));
  const previous=next[id][index];
  if(previous===code)return {bindings:next,swapped:[]};
  const selected=new Set([id]);
  let changed=true;
  while(changed){
    changed=false;
    for(const candidate of KEY_ACTIONS){
      if(selected.has(candidate.id)||!next[candidate.id].some(key=>key===previous||key===code))continue;
      if(KEY_ACTIONS.some(item=>selected.has(item.id)&&overlap(item,candidate))){selected.add(candidate.id);changed=true;}
    }
  }
  for(const item of selected)next[item]=next[item].map(key=>key===previous?code:key===code?previous:key);
  return {bindings:next,swapped:[...selected].filter(item=>item!==id)};
}

export function normalizeBindings(saved){
  let bindings=defaultBindings();
  if(!saved||typeof saved!=='object')return bindings;
  for(const action of KEY_ACTIONS){
    const values=Array.isArray(saved[action.id])?saved[action.id]:[saved[action.id]];
    for(let index=0;index<action.defaults.length;index++){
      const code=values[index];
      if(validKeyCode(code))bindings=bindKey(bindings,action.id,index,code).bindings;
    }
  }
  return bindings;
}

export function actionForKey(bindings,code,context){return KEY_ACTIONS.find(action=>action.contexts.includes(context)&&bindings[action.id]?.includes(code))?.id||null;}

export function movementVector(bindings,pressed){
  const has=id=>bindings[id].some(code=>pressed.has(code));
  return {x:Number(has('right'))-Number(has('left')),y:Number(has('down'))-Number(has('up'))};
}

export function displayKey(code){
  const labels={Space:'SPACE',ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→',Enter:'ENTER',Tab:'TAB',Backspace:'BACKSPACE',Delete:'DEL',Insert:'INS',Home:'HOME',End:'END',PageUp:'PAGE UP',PageDown:'PAGE DOWN',ShiftLeft:'L SHIFT',ShiftRight:'R SHIFT',ControlLeft:'L CTRL',ControlRight:'R CTRL',AltLeft:'L ALT',AltRight:'R ALT',CapsLock:'CAPS',Minus:'−',Equal:'=',BracketLeft:'[',BracketRight:']',Backslash:'\\',Semicolon:';',Quote:"'",Backquote:'`',Comma:',',Period:'.',Slash:'/'};
  return labels[code]||String(code||'').replace(/^Key/,'').replace(/^Digit/,'').replace(/^Numpad/,'NUM ').toUpperCase();
}
