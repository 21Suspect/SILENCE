/** Exertion depends on actual sprint movement, not a held key or frame count. */
export function createBreathing(){
 let exertion=0,level=0,untilBreath=0;
 return {update(dt:number,sprinting:boolean){
  dt=Math.max(0,Math.min(.1,dt));exertion=Math.max(0,Math.min(25,exertion+dt*(sprinting?1:-.85)));
  const target=Math.max(0,(exertion-7)/18);level+=(target-level)*(1-Math.exp(-dt/1.4));
  untilBreath-=dt;const breathe=level>.025&&untilBreath<=0;
  if(breathe)untilBreath=3.2-level*1.6;
  return {level,breathe,exertion};
 }};
}
