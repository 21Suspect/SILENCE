export type ViewVector={x:number;y:number;z:number};
export type EncounterView={position:ViewVector;forward:ViewVector;right:ViewVector;up:ViewVector;verticalFov:number;aspect:number;reflected?:EncounterView};
export const CREATURE_VIEW_RADIUS=6;
export const OFFSCREEN_GRACE=.65;
const dot=(a:ViewVector,b:ViewVector)=>a.x*b.x+a.y*b.y+a.z*b.z;

/** Four angular frustum planes, with no distance/fog/far-clip exemption.
 * A generous sphere includes outstretched limbs, spines and turning poses.
 * The extra peripheral angle protects objects just beyond the screen edge. */
function sphereInView(view:EncounterView,center:ViewVector,radius:number){
  const delta={x:center.x-view.position.x,y:center.y-view.position.y,z:center.z-view.position.z};
  if(dot(delta,delta)<=radius*radius)return true;
  const forward=dot(delta,view.forward),horizontal=Math.abs(dot(delta,view.right)),vertical=Math.abs(dot(delta,view.up));
  if(forward+radius<0)return false;
  const halfV=view.verticalFov*Math.PI/360,margin=7*Math.PI/180;
  const tanV=Math.tan(Math.min(Math.PI*.49,halfV+margin));
  const tanH=Math.tan(Math.min(Math.PI*.49,Math.atan(Math.tan(halfV)*view.aspect)+margin));
  return forward*tanH-horizontal>=-radius*Math.sqrt(1+tanH*tanH)
    &&forward*tanV-vertical>=-radius*Math.sqrt(1+tanV*tanV);
}

export function creatureInView(view:EncounterView,center:ViewVector,radius=CREATURE_VIEW_RADIUS):boolean{
  return sphereInView(view,center,radius)||(view.reflected!==undefined&&sphereInView(view.reflected,center,radius));
}

/** Each sighting resets the full grace period. A timeout never overrides view. */
export function createOffscreenLatch(grace=OFFSCREEN_GRACE){
  let outside=0;
  return {
    reset(){outside=0;},
    update(visible:boolean,dt:number){outside=visible?0:outside+Math.max(0,Math.min(dt,.1));return !visible&&outside>=grace;},
    get outsideSeconds(){return outside;},
  };
}
