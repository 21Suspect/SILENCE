import {defaults,bindKey,keyLabel,type Settings,type Action,type VolumeKey} from '../core/settings';
import {WORLD_DESTINATIONS, COASTAL_DESTINATIONS, pathX} from '../sim/world/world';
import {WORLD_V2} from '../sim/world/world-flags';
import {POI_PLACEMENTS,placeLocal} from '../sim/world/world-layout';
import {createTapTracker} from '../core/tap';
import {renderSize,pixelCostVs1080,resolutionLabel,RESOLUTIONS} from '../core/quality';
type CreatureMode='natural'|'hunt'|'idle'|'walk'|'run'|'tree';
type AdminOptions={
  getState:()=>{hours:number;cycleSpeed:number;flying:boolean;position:number[];fps:number;solids:number};
  setHours:(hours:number)=>void;setSpeed:(speed:number)=>void;setFlying:(flying:boolean)=>void;
  spawn:(mode:CreatureMode)=>void;dismiss:()=>void;teleport:(x:number,z:number)=>void;
  visibility:(open:boolean)=>void;settings:Settings;settingsChanged:()=>void;volumeChanged:()=>void;listening:(on:boolean)=>void;
};

/** Pause menu; developer tools share the same modal and focus handling. */
export function createAdmin(container:HTMLElement,options:AdminOptions){
  const style=document.createElement('style');style.textContent=`
    .silence-admin{position:absolute;right:20px;top:20px;width:min(340px,calc(100vw - 40px));max-height:calc(100dvh - 40px);overflow:auto;padding:22px;background:rgba(16,23,23,.96);color:#dfe7e1;border:1px solid #45514b;border-radius:8px;box-shadow:0 18px 70px #0008;font:13px/1.5 system-ui,sans-serif;z-index:5;user-select:auto;touch-action:auto;backdrop-filter:blur(16px)}
    .silence-admin[hidden]{display:none}.silence-admin header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}.silence-admin strong{font-size:15px;letter-spacing:.16em;font-weight:500}.silence-admin small{color:#94a69b}.silence-admin label{display:block;margin:15px 0 7px;color:#c0cec5}.silence-admin .row{display:flex;gap:6px;margin-top:8px}.silence-admin button,.silence-admin select{font:inherit;color:inherit;border:1px solid #45514b;background:#25322c;border-radius:4px;padding:8px 10px;cursor:pointer;min-height:35px}.silence-admin button:hover{background:#38483d}.silence-admin button:focus-visible,.silence-admin select:focus-visible,.silence-admin input:focus-visible{outline:2px solid #becbb8;outline-offset:2px}.silence-admin .row>*{flex:1;min-width:0}.silence-admin input[type=range]{width:100%;accent-color:#b7c5ab}.silence-admin select{width:100%}.silence-admin input[type=checkbox]{accent-color:#b7c5ab;margin-right:8px}.silence-admin hr{border:0;border-top:1px solid #3a4740;margin:19px 0}.silence-admin output{font-variant-numeric:tabular-nums;float:right;color:#e7ecdf}.silence-admin p{color:#94a69b;margin:10px 0 0;font-size:12px}.silence-admin .close{padding:2px 10px;font-size:20px;background:transparent}.silence-admin footer{margin-top:18px;color:#7f9588;font-size:11px;font-variant-numeric:tabular-nums}
  `;container.appendChild(style);
  const names:Record<string,string>={cabin:'Cabin',mast:'Relay mast',hut:'Relay hut',generator:'Generator',lookout:'Fire lookout',logstack:'Logging camp',camp:'Hunter camp',chapel:'Chapel',mine:'Mine',roadbridge:'Road bridge'};
  const destinations=WORLD_V2?[...POI_PLACEMENTS.filter(p=>names[p.asset]).map(p=>{const [x,z]=placeLocal(p,...(p.entrance??[4,4]));return{name:names[p.asset],x,z};}),...COASTAL_DESTINATIONS]:WORLD_DESTINATIONS.filter(d=>d.name!=='Forest trail');
  const panel=document.createElement('section');panel.className='silence-admin';panel.hidden=true;panel.setAttribute('aria-label','Pause menu');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
  panel.innerHTML=`<header><strong>SILENCE <small>/ PAUSED</small></strong><button class="close" aria-label="Resume game">Resume</button></header><nav role="tablist" aria-label="Pause settings"><button role="tab" data-tab="graphics">Graphics Settings</button><button role="tab" data-tab="sound">Sound Settings</button><button role="tab" data-tab="developer">Developer Options</button><button role="tab" data-tab="keys">Keybindings</button></nav><section data-page="graphics" role="tabpanel"><h2>Graphics Settings</h2><div class="graphics-row"><label for="silence-quality">Quality preset</label><select id="silence-quality"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="custom">Custom</option></select></div>
    <div class="graphics-row"><label for="silence-resolution">Resolution</label><select id="silence-resolution">${RESOLUTIONS.map(r=>`<option value="${r}">${resolutionLabel(r)}</option>`).join('')}</select></div>
    <p id="silence-resolution-note" class="note" role="status"></p>
    <div class="graphics-row"><label for="silence-shadows">Shadow resolution</label><select id="silence-shadows" data-graphics="shadows"><option value="1024">1024 · Low</option><option value="2048">2048 · Medium</option><option value="4096">4096 · High</option></select></div>
    <div class="graphics-row"><label for="silence-shadowRate">Shadow updates</label><select id="silence-shadowRate" data-graphics="shadowRate"><option value="0">Every frame</option><option value="30">30 Hz</option></select></div>
    <div class="graphics-row"><label for="silence-fog">Volumetric fog</label><select id="silence-fog" data-graphics="fog"><option value="0.5">Low</option><option value="0.75">Medium</option><option value="1">High</option></select></div>
    <div class="graphics-row"><label for="silence-reflections">Water reflections</label><select id="silence-reflections" data-graphics="reflections"><option value="256">Low</option><option value="512">Medium</option><option value="768">High</option></select></div>
    <div class="graphics-row"><label for="silence-waterDetail">Water detail</label><select id="silence-waterDetail" data-graphics="waterDetail"><option value="0">Low</option><option value="1">Medium</option><option value="2">High</option></select></div>
    <div class="graphics-row"><label for="silence-aa">Anti-aliasing</label><select id="silence-aa" data-graphics="aa"><option value="0">Off</option><option value="1">FXAA</option><option value="2">2× MSAA + FXAA</option><option value="4">4× MSAA + FXAA</option></select></div>
    <div class="graphics-row"><label for="silence-anisotropy">Anisotropic filtering</label><select id="silence-anisotropy" data-graphics="anisotropy"><option value="1">Off</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option><option value="16">16×</option></select></div>
    <div class="graphics-row"><label for="silence-framecap">Frame rate limit</label><select id="silence-framecap"><option value="60">60</option><option value="120">120</option><option value="0">Off</option></select></div>
    <div class="graphics-row"><label for="silence-fov">Field of view <output data-value="fov"></output></label><input id="silence-fov" data-graphics="fov" type="range" min="55" max="95" step="1"></div>
    <div class="graphics-row"><span>VSync</span><span class="muted">Browser controlled</span></div>
    <div class="graphics-row"><label for="silence-perfOverlay">Performance overlay <small>P shows or hides it</small></label><input id="silence-perfOverlay" type="checkbox" style="justify-self:start"></div></section><section data-page="sound" role="tabpanel" hidden><h2>Sound Settings</h2>
    <div class="graphics-row"><label for="silence-masterVolume">Master volume <output data-value="masterVolume"></output></label><input id="silence-masterVolume" data-sound="masterVolume" type="range" min="0" max="100" step="5"></div>
    <div class="graphics-row"><label for="silence-ambienceVolume">Ambience <output data-value="ambienceVolume"></output></label><input id="silence-ambienceVolume" data-sound="ambienceVolume" type="range" min="0" max="100" step="5"></div>
    <div class="graphics-row"><label for="silence-creatureVolume">Creature <output data-value="creatureVolume"></output></label><input id="silence-creatureVolume" data-sound="creatureVolume" type="range" min="0" max="100" step="5"></div></section><section data-page="keys" role="tabpanel" hidden><h2>Keybindings</h2><div id="silence-bindings"></div><label for="silence-sensitivity">Look sensitivity</label><input id="silence-sensitivity" type="range" min="0.25" max="2.5" step="0.05"><div class="graphics-row"><label for="silence-objectiveHints">Objective hint <small>O shows or hides it</small></label><input id="silence-objectiveHints" type="checkbox" style="justify-self:start"></div><button id="silence-reset">Reset keybindings</button><span id="silence-bind-message" role="status"></span></section><section data-page="developer" role="tabpanel" hidden><h2>Developer Options</h2>
    <label for="silence-hour">Time of day <output id="silence-clock">16:00</output></label><input id="silence-hour" type="range" min="0" max="23.99" step="0.01" aria-label="Time of day">
    <div class="row"><button data-hour="6.75">Dawn</button><button data-hour="12">Noon</button><button data-hour="18.5">Dusk</button><button data-hour="0">Night</button></div>
    <label for="silence-cycle">Day / night cycle</label><select id="silence-cycle"><option value="0">Paused</option><option value="1" selected>Normal · 24 minutes</option><option value="8">Fast · 3 minutes</option><option value="32">Preview · 45 seconds</option></select>
    <hr><label for="silence-creature">Creature behavior</label><select id="silence-creature"><option value="natural">Natural · bring it near, it decides</option><option value="hunt">Hunt · bring it near, hunting</option><option value="tree">Tree ambush</option><option value="idle">Hold nearby · idle</option><option value="walk">Walk</option><option value="run">Run</option></select><div class="row"><button id="silence-spawn">Spawn out of view</button><button id="silence-dismiss">Dismiss</button></div>
    <hr><label><input id="silence-fly" type="checkbox">Fly / noclip</label>
    <label for="silence-place">Explore</label><select id="silence-place"><option value="">Choose a destination…</option><option value="${pathX(12)},12">Forest trail</option>${WORLD_V2?'':'<option value="-18,-42">Abandoned shelter</option>'}${destinations.map(d=>`<option value="${d.x},${d.z}">${d.name}</option>`).join('')}</select>
    <footer id="silence-status"></footer></section>`;
  const backdrop=document.createElement('div');backdrop.className='silence-pause-backdrop';backdrop.hidden=true;container.appendChild(backdrop);
  container.appendChild(panel);
  style.textContent+=` .silence-pause-backdrop{position:absolute;inset:0;background:#0009;z-index:5;backdrop-filter:blur(5px)}.silence-pause-backdrop[hidden]{display:none}.silence-admin{z-index:6;left:50%;top:50%;right:auto;transform:translate(-50%,-50%);width:min(650px,calc(100vw - 32px));box-sizing:border-box;max-height:calc(100dvh - 32px);padding:28px}.silence-admin nav{display:flex;gap:5px;border-bottom:1px solid #45514b;padding-bottom:14px}.silence-admin nav button{flex:1;font-size:12px;padding:10px 5px}.silence-admin [aria-selected=true]{background:#536052;color:#fff}.silence-admin h2{font-size:18px;font-weight:400;margin:24px 0 12px}.silence-admin [hidden]{display:none}.silence-admin .binding{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:7px}.silence-admin .binding button{min-width:110px}.silence-admin .close{font-size:13px;padding:8px 14px}@media(max-width:480px){.silence-admin{padding:18px}.silence-admin nav button{font-size:11px}}`;
  style.textContent+=`
    .silence-mobile-pause{position:absolute;top:0;left:0;z-index:7;width:calc(64px + env(safe-area-inset-left,0px));height:calc(64px + env(safe-area-inset-top,0px));padding:0;border:0;background:transparent;box-shadow:none;outline:none;appearance:none;touch-action:none;-webkit-tap-highlight-color:transparent;display:none}
    @media(any-pointer:coarse){.silence-mobile-pause{display:block}}
  `;
  const mobile=document.createElement('button');mobile.type='button';mobile.className='silence-mobile-pause';mobile.setAttribute('aria-label','Pause game');container.appendChild(mobile);
  const tabs=Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-tab]'));
  let page='graphics';
  function selectTab(name:string){page=name;for(const tab of tabs){const selected=tab.dataset.tab===name;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;tab.id='tab-'+tab.dataset.tab;tab.setAttribute('aria-controls','page-'+tab.dataset.tab);}for(const page of panel.querySelectorAll<HTMLElement>('[data-page]')){page.hidden=page.dataset.page!==name;page.id='page-'+page.dataset.page;page.setAttribute('aria-labelledby','tab-'+page.dataset.page);}}
  for(const tab of tabs){tab.addEventListener('click',()=>{selectTab(tab.dataset.tab!);hear();});tab.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();const i=e.key==='Home'?0:e.key==='End'?tabs.length-1:(tabs.indexOf(tab)+(['ArrowRight','ArrowDown'].includes(e.key)?1:tabs.length-1))%tabs.length;selectTab(tabs[i].dataset.tab!);hear();tabs[i].focus();});}selectTab('graphics');
  style.textContent+=`
  .silence-admin{inset:0;transform:none;width:100%;height:100dvh;max-height:100dvh;border:0;border-radius:0;box-shadow:none;background:rgba(7,13,12,.96);display:grid;grid-template-columns:220px minmax(0,760px);grid-template-rows:auto minmax(0,1fr);justify-content:center;gap:36px;padding:48px;overflow:hidden}
  .silence-admin[hidden]{display:none}.silence-admin header{grid-column:1/-1;margin:0;padding-bottom:24px;border-bottom:1px solid #ffffff20}.silence-admin strong{font-size:24px;letter-spacing:.22em}.silence-admin strong small{display:block;font-size:10px;margin-top:7px;letter-spacing:.2em}.silence-admin nav{display:flex;flex-direction:column;justify-content:flex-start;border:0;gap:8px;padding:0}.silence-admin nav button{flex:0;text-align:left;font-size:14px;padding:14px 16px;background:transparent;border:0;border-left:2px solid transparent;border-radius:0}.silence-admin nav [aria-selected=true]{background:#ffffff08;border-left-color:#c7d1c7}.silence-admin section[data-page]{overflow:auto;padding:0 16px 24px 0;overscroll-behavior:contain}.silence-admin h2{margin:0 0 26px;font-size:20px}.silence-admin button,.silence-admin select{border-radius:0;background:#ffffff06;border-color:#ffffff26}.silence-admin .graphics-row{display:grid;grid-template-columns:1fr minmax(160px,230px);align-items:center;gap:24px;padding:14px 0;border-bottom:1px solid #ffffff12}.silence-admin .graphics-row label{margin:0}.silence-admin .graphics-row output{float:none;margin-left:12px;color:#94a69b}.silence-admin .muted{color:#94a69b;font-size:12px}.silence-admin p.note{margin:2px 0 4px;padding:0 0 12px;border-bottom:1px solid #ffffff12;line-height:1.45}.silence-admin .binding{border-bottom:1px solid #ffffff12;padding:7px 0;margin:0}
  @media(max-width:700px){.silence-admin{padding:24px 18px;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr);gap:20px}.silence-admin header{padding-bottom:18px}.silence-admin nav{flex-direction:row;gap:4px}.silence-admin nav button{flex:1;text-align:center;font-size:11px;padding:10px 4px;border-left:0;border-bottom:2px solid transparent}.silence-admin nav [aria-selected=true]{border-bottom-color:#c7d1c7}.silence-admin section[data-page]{padding-right:4px}.silence-admin .graphics-row{grid-template-columns:1fr 160px;gap:12px}.silence-admin strong{font-size:20px}}
  `;
  let capturing:Action|undefined;
  const bindings=panel.querySelector<HTMLElement>('#silence-bindings')!,message=panel.querySelector<HTMLElement>('#silence-bind-message')!;
  const labels:Record<Action,string>={forward:'Move forward',back:'Move backward',left:'Strafe left',right:'Strafe right',sprint:'Sprint',crouch:'Crouch / fly down',interact:'Interact',fullscreen:'Fullscreen',rise:'Jump / fly up / release ladder',drop:'Drop item'};
  function renderBindings(){bindings.replaceChildren();for(const action of Object.keys(labels) as Action[]){const row=document.createElement('div');row.className='binding';const label=document.createElement('span');label.textContent=labels[action];const button=document.createElement('button');button.textContent=capturing===action?'Press a key…':keyLabel(options.settings.bindings[action]);button.setAttribute('aria-label',labels[action]+': '+button.textContent);button.onclick=()=>{capturing=action;renderBindings();};row.appendChild(label);row.appendChild(button);bindings.appendChild(row);}}
  renderBindings();
  const quality=panel.querySelector('#silence-quality') as unknown as HTMLSelectElement;
  const graphics=Array.from(panel.querySelectorAll('[data-graphics]')) as unknown as (HTMLInputElement|HTMLSelectElement)[];
  function refreshGraphics(){quality.value=options.settings.quality;for(const input of graphics){const key=input.dataset.graphics as keyof Settings;input.value=String(options.settings[key]);}panel.querySelector('[data-value="fov"]')!.textContent=options.settings.fov+'°';}
  quality.onchange=()=>{const q=quality.value as Settings['quality'];options.settings.quality=q;if(q!=='custom'){const low=q==='low',mid=q==='medium';Object.assign(options.settings,{shadows:low?1024:mid?2048:4096,shadowRate:low?30:0,waterDetail:low?0:mid?1:2,fog:low?.5:mid?.75:1,reflections:low?256:mid?512:768,aa:low?1:mid?2:4,anisotropy:low?4:mid?8:16});}refreshGraphics();options.settingsChanged();};
  for(const input of graphics)input.onchange=()=>{(options.settings as unknown as Record<string,unknown>)[input.dataset.graphics!]=Number(input.value);options.settings.quality='custom';refreshGraphics();options.settingsChanged();};refreshGraphics();
  // Resolution is the one choice that decides the cost of a frame (it is per-pixel bound), so it is its own setting: the presets
  // leave it alone, and so does the game. The note says what it renders and warns when Native is a lot of pixels.
  const resolution=panel.querySelector('#silence-resolution') as unknown as HTMLSelectElement,resolutionNote=panel.querySelector<HTMLElement>('#silence-resolution-note')!;
  function describeResolution(){
    const r=options.settings.resolution,w=Math.max(1,container.clientWidth),h=Math.max(1,container.clientHeight),dpr=window.devicePixelRatio||1;
    const size=renderSize(r,w,h,dpr),native=renderSize(0,w,h,dpr),mp=(n:{width:number;height:number})=>(n.width*n.height/1e6).toFixed(1);
    let text=`Renders ${size.width} × ${size.height} (${mp(size)} MP).`;
    if(r>0&&size.height<r)text+=` This window has only ${native.height} rows of screen pixels, so that is its native size.`;
    const cost=pixelCostVs1080(r,w,h,dpr);
    if(r===0&&cost>1.6)text+=` That is ${cost.toFixed(1)}× the pixels of 1080p: on a high-density (Retina) screen Native costs several times as much GPU time a frame.`;
    resolutionNote.textContent=text;
  }
  resolution.value=String(options.settings.resolution);describeResolution();
  resolution.onchange=()=>{options.settings.resolution=Number(resolution.value);describeResolution();options.settingsChanged();};
  const perfOverlay=panel.querySelector<HTMLInputElement>('#silence-perfOverlay')!;perfOverlay.checked=options.settings.perfOverlay;perfOverlay.onchange=()=>{options.settings.perfOverlay=perfOverlay.checked;options.settingsChanged();};
  // Not a picture-quality choice, so changing it leaves the quality preset as it is.
  const frameCap=panel.querySelector('#silence-framecap') as unknown as HTMLSelectElement;frameCap.value=String(options.settings.frameCap);frameCap.onchange=()=>{options.settings.frameCap=Number(frameCap.value);options.settingsChanged();};
  const sensitivity=panel.querySelector<HTMLInputElement>('#silence-sensitivity')!;sensitivity.value=String(options.settings.sensitivity);sensitivity.oninput=()=>{options.settings.sensitivity=Number(sensitivity.value);options.settingsChanged();};
  const objectiveHints=panel.querySelector<HTMLInputElement>('#silence-objectiveHints')!;objectiveHints.checked=options.settings.objectiveHints;objectiveHints.onchange=()=>{options.settings.objectiveHints=objectiveHints.checked;options.settingsChanged();};
  // Volumes follow the thumb while it drags; the saved settings are written once, on release.
  const sound=Array.from(panel.querySelectorAll<HTMLInputElement>('[data-sound]'));
  function refreshSound(){for(const input of sound){const key=input.dataset.sound as VolumeKey;input.value=String(options.settings[key]);panel.querySelector(`[data-value="${key}"]`)!.textContent=options.settings[key]+'%';}}
  for(const input of sound){input.oninput=()=>{options.settings[input.dataset.sound as VolumeKey]=Number(input.value);refreshSound();options.volumeChanged();};input.onchange=()=>options.settingsChanged();}refreshSound();
  panel.querySelector<HTMLButtonElement>('#silence-reset')!.onclick=()=>{options.settings.bindings=defaults().bindings;capturing=undefined;renderBindings();options.settingsChanged();};
  const capture=(e:KeyboardEvent)=>{if(!open)return;if(capturing){e.preventDefault();e.stopImmediatePropagation();const action=capturing;if(e.code==='Escape'){capturing=undefined;message.textContent='';}else if(bindKey(options.settings,action,e.code)){capturing=undefined;message.textContent='';options.settingsChanged();}else message.textContent='Unavailable key';renderBindings();if(!capturing)(bindings.children[Object.keys(labels).indexOf(action)].querySelector('button') as HTMLButtonElement).focus();return;}if(e.key==='Tab'){const focusable=Array.from(panel.querySelectorAll<HTMLElement>('button,input,select,[tabindex="0"]')).filter(el=>el.tabIndex>=0&&el.getClientRects().length);const first=focusable[0],last=focusable[focusable.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};window.addEventListener('keydown',capture,true);
  const mobileTap=createTapTracker();
  let mobilePointer:number|undefined,mobileX=0,mobileY=0;
  mobile.onpointerdown=e=>{
    if(e.button!==0||mobilePointer!==undefined)return;
    e.preventDefault();e.stopPropagation();
    mobilePointer=e.pointerId;mobileX=e.clientX;mobileY=e.clientY;
    mobileTap.begin(performance.now());mobile.setPointerCapture(e.pointerId);
  };
  mobile.onpointermove=e=>{
    if(e.pointerId!==mobilePointer)return;
    mobileTap.move(Math.hypot(e.clientX-mobileX,e.clientY-mobileY));
    mobileX=e.clientX;mobileY=e.clientY;
  };
  mobile.onpointerup=e=>{
    if(e.pointerId!==mobilePointer)return;
    e.preventDefault();e.stopPropagation();mobilePointer=undefined;
    mobileTap.move(Math.hypot(e.clientX-mobileX,e.clientY-mobileY));
    if(mobileTap.end(performance.now()))setOpen(!open);
  };
  mobile.onpointercancel=mobile.onlostpointercapture=e=>{if(e.pointerId===mobilePointer){mobilePointer=undefined;mobileTap.cancel();}};
  mobile.onclick=e=>{e.preventDefault();e.stopPropagation();if(e.detail===0)setOpen(!open);};

  const hour=panel.querySelector<HTMLInputElement>('#silence-hour')!,clock=panel.querySelector<HTMLOutputElement>('#silence-clock')!,speed=(panel.querySelector('#silence-cycle') as unknown as HTMLSelectElement),flying=panel.querySelector<HTMLInputElement>('#silence-fly')!,status=panel.querySelector<HTMLElement>('#silence-status')!;
  let open=false,lastRefresh=0;
  // The game is paused behind the menu, but its sound keeps running while the Sound page is up, so a slider can be heard.
  const hear=()=>{if(open)options.listening(page==='sound');};
  const refresh=()=>{const s=options.getState();if(document.activeElement!==hour)hour.value=String(s.hours);const minutes=Math.floor(s.hours*60);clock.value=`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;speed.value=String(s.cycleSpeed);flying.checked=s.flying;status.textContent=`${s.fps} FPS · ${s.position.map(n=>Math.round(n)).join(', ')} · ${s.solids.toLocaleString()} nearby solids`;};
  const setOpen=(value:boolean)=>{if(open===value)return;open=value;capturing=undefined;renderBindings();panel.hidden=backdrop.hidden=!open;mobile.setAttribute('aria-label',open?'Resume game':'Pause game');options.listening(false);options.visibility(open);hear();if(open){objectiveHints.checked=options.settings.objectiveHints;/* O may have changed it while the menu was shut */perfOverlay.checked=options.settings.perfOverlay;/* and P this one */describeResolution();refresh();panel.querySelector<HTMLButtonElement>('.close')!.focus();}};
  panel.querySelector('.close')!.addEventListener('click',()=>setOpen(false));
  hour.addEventListener('input',()=>{options.setHours(Number(hour.value));refresh();});
  for(const button of panel.querySelectorAll<HTMLButtonElement>('[data-hour]'))button.addEventListener('click',()=>{options.setHours(Number(button.dataset.hour));refresh();});
  speed.addEventListener('change',()=>options.setSpeed(Number(speed.value)));
  flying.addEventListener('change',()=>{options.setFlying(flying.checked);refresh();});
  panel.querySelector('#silence-spawn')!.addEventListener('click',()=>options.spawn((panel.querySelector('#silence-creature') as unknown as HTMLSelectElement).value as CreatureMode));
  panel.querySelector('#silence-dismiss')!.addEventListener('click',options.dismiss);
  (panel.querySelector('#silence-place') as unknown as HTMLSelectElement).addEventListener('change',event=>{const select=event.target as HTMLSelectElement;if(select.value){const [x,z]=select.value.split(',').map(Number);options.teleport(x,z);select.value='';refresh();}});
  panel.addEventListener('pointerdown',e=>e.stopPropagation());panel.addEventListener('touchstart',e=>e.stopPropagation());
  return {get open(){return open;},toggle(){setOpen(!open);},show(tab?:string){if(tab){selectTab(tab);hear();}setOpen(true);},close(){setOpen(false);},update(now:number){if(open&&now-lastRefresh>250){lastRefresh=now;refresh();}},dispose(){window.removeEventListener('keydown',capture,true);mobile.remove();backdrop.remove();panel.remove();style.remove();}};
}
