/** Prefer a stable refresh cadence. Downshift quickly, restore cautiously,
 * and ignore focus pauses without ignoring genuinely slow devices. */
export function createRenderBudget(deviceRatio:number){
  // Frame delivery alone cannot tell a display change from a missed refresh.
  // Budget for 60 FPS while letting rendering follow the display's cadence.
  const targetMs=1000/60;
  let ceiling=1,scale=1,average=targetMs;
  let overloaded=0,headroom=0,lastChange=-Infinity,recoveryAfter=0,warmup=0;
  return {
    resize(width:number,height:number,ratio=deviceRatio){
      ceiling=Math.min(ratio,1.4,Math.sqrt(2_000_000/Math.max(1,width*height)));
      return ceiling*scale;
    },
    pause(){overloaded=headroom=warmup=0;average=targetMs;},
    inspect(){return {scale,targetFps:60,averageMs:average};},
    update(frameMs:number,now:number){
      if(!Number.isFinite(frameMs)||frameMs<1||frameMs>500){this.pause();return undefined;}
      const dt=Math.min(frameMs,100);
      average+=(Math.min(frameMs,150)-average)*(1-Math.exp(-dt/450));
      warmup+=dt;if(warmup<1500)return undefined;
      const slow=average>targetMs*1.13;
      overloaded=slow?overloaded+dt:Math.max(0,overloaded-dt*2);
      headroom=average<targetMs*1.035?headroom+dt:0;
      if(overloaded>1000&&now-lastChange>2200&&scale>.45){
        scale=Math.max(.45,scale*(average>targetMs*1.8?.82:.91));
        lastChange=now;recoveryAfter=now+14000;overloaded=headroom=0;
        return ceiling*scale;
      }
      // Vsync hides spare GPU time. Probe one small step, then back off if it
      // misses the target. The long retry delay prevents quality pumping.
      if(headroom>9000&&now>recoveryAfter&&now-lastChange>9000&&scale<1){
        scale=Math.min(1,scale+.04);lastChange=now;headroom=0;
        return ceiling*scale;
      }
      return undefined;
    },
  };
}
