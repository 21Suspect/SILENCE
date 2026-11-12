import {RESOLUTIONS,DEFAULT_RESOLUTION} from './quality';
export const defaultBindings={forward:'KeyW',back:'KeyS',left:'KeyA',right:'KeyD',sprint:'ShiftLeft',crouch:'ControlLeft',interact:'KeyE',fullscreen:'KeyF',rise:'Space',drop:'KeyQ'};
export type Action=keyof typeof defaultBindings;
export type Settings={quality:'low'|'medium'|'high'|'custom';/** Rows to render (720, 1080, 1440), or 0 for the screen's own pixels (game/core/quality.ts). */resolution:number;shadows:number;shadowRate:number;waterDetail:number;fog:number;/** Screen-space ambient occlusion: 0 off, 1 medium, 2 high (game/render/post/ambient-occlusion.ts). */ambientOcclusion:number;reflections:number;aa:number;anisotropy:number;/** Most frames a second to draw; 0 draws one for every refresh of the screen. */frameCap:number;fov:number;sensitivity:number;masterVolume:number;ambienceVolume:number;creatureVolume:number;objectiveHints:boolean;/** The frame-time corner (game/ui/perf-overlay.ts). */perfOverlay:boolean;bindings:Record<Action,string>};
/** The three sound sliders, in percent. 100 is the game's own mix; the slider sets how far below it you want it. */
export const volumeKeys=['masterVolume','ambienceVolume','creatureVolume'] as const;
export type VolumeKey=typeof volumeKeys[number];
/** Slider percent to gain. Squared, so the steps feel even to the ear: 50% is a quarter of the power, and 100% leaves the mix untouched. */
export const volumeGain=(percent:number)=>{const v=Math.max(0,Math.min(100,percent))/100;return v*v;};
export const defaults=():Settings=>({quality:'high',resolution:DEFAULT_RESOLUTION,shadows:4096,shadowRate:0,waterDetail:2,fog:1,ambientOcclusion:2,reflections:768,aa:4,anisotropy:16,frameCap:60,fov:69,sensitivity:1,masterVolume:100,ambienceVolume:100,creatureVolume:100,objectiveHints:true,perfOverlay:false,bindings:{...defaultBindings}});
export function validKey(code:string){return /^(Key[A-Z]|Digit[0-9]|ShiftLeft|ShiftRight|ControlLeft|ControlRight|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(code);}
export function bindKey(settings:Settings,action:Action,code:string){
 if(!validKey(code))return false;
 const other=(Object.keys(settings.bindings) as Action[]).find(a=>a!==action&&settings.bindings[a]===code);
 if(other)settings.bindings[other]=settings.bindings[action];settings.bindings[action]=code;return true;
}
export function readSettings(value:string|null){const result=defaults();try{const data=JSON.parse(value??'null');if(!data)return result;
 if(['low','medium','high','custom'].includes(data.quality))result.quality=data.quality;
 // "Automatic" was the High settings plus a scaler that lowered the resolution by itself; the scaler is gone, the settings stay.
 if(data.quality==='auto')result.quality='high';
 if((RESOLUTIONS as readonly number[]).includes(data.resolution))result.resolution=data.resolution;
 if(Number.isFinite(data.sensitivity))result.sensitivity=Math.max(.25,Math.min(2.5,data.sensitivity));
 for(const [key,values] of Object.entries({shadows:[1024,2048,4096],shadowRate:[0,30],waterDetail:[0,1,2],fog:[.5,.75,1],ambientOcclusion:[0,1,2],reflections:[256,512,768],aa:[0,1,2,4],anisotropy:[1,2,4,8,16]}))if(values.includes(data[key]))(result as unknown as Record<string,unknown>)[key]=data[key];
 if([0,60,120].includes(data.frameCap))result.frameCap=data.frameCap;
 if(Number.isFinite(data.fov))result.fov=Math.max(55,Math.min(95,data.fov));
 for(const key of volumeKeys)if(Number.isFinite(data[key]))result[key]=Math.round(Math.max(0,Math.min(100,data[key])));
 /** The objective corner: on unless the player turned it off. Anything but a real boolean keeps the default. */
 if(typeof data.objectiveHints==='boolean')result.objectiveHints=data.objectiveHints;
 if(typeof data.perfOverlay==='boolean')result.perfOverlay=data.perfOverlay;
 if(data.bindings){
 const actions=Object.keys(defaultBindings) as Action[],codes=new Set<string>();
 // Old saves have no drop action. Preserve all valid existing assignments, then
 // choose an unused key for newly introduced actions instead of resetting them.
 const provided=actions.filter(a=>Object.hasOwn(data.bindings,a));
 if(provided.length&&provided.every(a=>{const c=data.bindings[a];if(!validKey(c)||codes.has(c))return false;codes.add(c);return true;})){
  for(const a of provided)result.bindings[a]=data.bindings[a];
  for(const a of actions.filter(a=>!provided.includes(a))){const code=[defaultBindings[a],'KeyQ','KeyG','KeyR',...Array.from({length:26},(_,i)=>'Key'+String.fromCharCode(65+i))].find(c=>!codes.has(c))!;result.bindings[a]=code;codes.add(code);}
 }
 }
 }catch{}return result;}
export const keyLabel=(code:string)=>code.replace('Key','').replace('Digit','').replace('Left',' left').replace('Right',' right').replace('Arrow','Arrow ');
