/** Spider-like secondary behavior: watchful stillness, precise reorientation,
 * one-sided sensory probes and delayed digit closure. No walking arm pendulum. */
export type GazeAngles={yaw:number;pitch:number};
export type CreatureAttention={lookTarget?:{x:number;y:number;z:number};turnRate?:number;speed?:number;gazeAngles?:GazeAngles};
export type JointAngles={x:number;y:number;z:number};
export type ArticulationPose=Record<string,JointAngles>;
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const ease=(v:number)=>{const t=clamp(v,0,1);return t*t*t*(t*(t*6-15)+10);};
const hash=(n:number)=>{const v=Math.sin(n*127.1+311.7)*43758.5453;return(v-Math.floor(v))*2-1;};
function hold(time:number,interval:number,seed:number){const t=(time+seed*.417)/interval,n=Math.floor(t),blend=ease((t-n-.84)/.16);return hash(n+seed)*(1-blend)+hash(n+1+seed)*blend;}
/** A short acquisition, a motionless hold, then a slower release. Event onset,
 * duration and strength vary per interval; every transition has zero velocity. */
function event(time:number,interval:number,seed:number,attack:number,dwell:number,release:number){
  const shifted=time+seed*.139,n=Math.floor(shifted/interval),phase=shifted-n*interval;
  const onset=.7+(hash(n+seed)*.5+.5)*Math.max(.1,interval-attack-dwell-release-1.6);
  const t=phase-onset,linger=dwell*(.75+(hash(n+seed+31)*.5+.5)*.5);
  if(t<0||t>attack+linger+release)return 0;
  const amplitude=.78+(hash(n+seed+71)*.5+.5)*.22;
  return amplitude*(t<attack?ease(t/attack):t<attack+linger?1:1-ease((t-attack-linger)/release));
}
export function gazeAngles(target:{x:number;y:number;z:number}):GazeAngles{
  const x=target.x,y=target.y-1.43,z=target.z-.82;
  return {yaw:clamp(Math.atan2(x,Math.max(.12,z)),-.48,.48),pitch:clamp(-Math.atan2(y,Math.max(.25,Math.hypot(x,z))),-.23,.19)};
}
export type SpiderGazeState=GazeAngles&{ready:boolean;targetYaw:number;targetPitch:number;lastTime:number;acquired:number;nextSample:number;sequence:number};
export function createSpiderGaze():SpiderGazeState{return{ready:false,yaw:0,pitch:0,targetYaw:0,targetPitch:0,lastTime:0,acquired:0,nextSample:0,sequence:0};}
/** Fixate between deliberate reacquisitions. Counter-rotation keeps a held gaze
 * steady in the world while the body changes heading. Large target movement
 * remains responsive; small movements do not make the head continually sway. */
export function advanceSpiderGaze(state:SpiderGazeState,target:{x:number;y:number;z:number},turnRate:number,running:number,time:number,dt:number):GazeAngles{
  const desired=gazeAngles(target);dt=clamp(dt,0,.1);running=clamp(running,0,1);
  if(!state.ready||time<state.lastTime||time-state.lastTime>1){state.ready=true;state.yaw=state.targetYaw=desired.yaw;state.pitch=state.targetPitch=desired.pitch;state.acquired=time;state.nextSample=time+.85;state.sequence=0;}
  else{
    const counter=clamp(turnRate,-1.8,1.8)*dt;state.yaw=clamp(state.yaw-counter,-.48,.48);state.targetYaw=clamp(state.targetYaw-counter,-.48,.48);
    const error=Math.hypot(desired.yaw-state.targetYaw,desired.pitch-state.targetPitch);
    if(time>=state.nextSample||(error>.13&&time-state.acquired>.24)){
      state.targetYaw=desired.yaw;state.targetPitch=desired.pitch;state.acquired=time;
      state.nextSample=time+(.64+(hash(++state.sequence+149)*.5+.5)*.77)*(1-running*.45);
    }
    const alpha=1-Math.exp(-dt*(time-state.acquired<.25?18:6));
    state.yaw+=(state.targetYaw-state.yaw)*alpha;state.pitch+=(state.targetPitch-state.pitch)*alpha;
  }
  state.lastTime=time;return state;
}
export function createArticulationPose():ArticulationPose{
  const pose:ArticulationPose={};for(const name of ['neck','head','jaw','arm_L','arm_R','hand_L','hand_R','wrist_L','wrist_R'])pose[name]={x:0,y:0,z:0};
  for(const side of ['L','R'])for(let i=0;i<4;i++){pose[`finger_${side}${i}`]={x:0,y:0,z:0};pose[`tip_${side}${i}`]={x:0,y:0,z:0};}return pose;
}
export function updateArticulationPose(pose:ArticulationPose,time:number,running:number,attention:CreatureAttention={}){
  running=clamp(running,0,1);const turn=clamp(attention.turnRate??0,-1.8,1.8),speed=Math.max(0,attention.speed??running*5.5);
  const brace=clamp(speed/4.5,0,1),quiet=1-brace*.78;
  const listening=event(time,12.9,23,.16,.76,.9)*quiet;
  const listenSide=hash(Math.floor((time+23*.139)/12.9)+79)>0?1:-1;
  let yaw=hold(time,6.1,17)*.29,pitch=hold(time,8.3,41)*.085;
  const gaze=attention.gazeAngles??(attention.lookTarget?gazeAngles(attention.lookTarget):undefined);if(gaze){yaw=gaze.yaw;pitch=gaze.pitch;}
  const roll=listening*.19*listenSide-turn*.018;
  // Head leads a precise reorientation; neck follows with a slower muscle lag.
  pose.neck.x=pitch*.29+brace*.035;pose.neck.y=yaw*.29-turn*.03;pose.neck.z=roll*.27;
  pose.head.x=pitch*.71-brace*.045-listening*.025;pose.head.y=yaw*.71;pose.head.z=roll*.73;
  // A quiet held maw, with a sparse tension/release rather than periodic chomping.
  const jawTension=event(time,15.1,61,.12,.28,.72);
  pose.jaw.x=.018+brace*.019+jawTension*.052;pose.jaw.y=0;pose.jaw.z=jawTension*.009*(hash(Math.floor((time+61*.139)/15.1)+197)>0?1:-1);
  for(let side=0;side<2;side++){
    const label=side===0?'L':'R',sign=side===0?-1:1,interval=side===0?8.7:11.3,seed=side===0?37:83;
    // Palp-like probing: one hand unfolds to investigate, then its digits close
    // in sequence. The opposite hand retains its defensive curled posture.
    const probe=event(time,interval,seed,.24,.64,.68)*quiet;
    const retract=event(time-.82,interval,seed,.13,.34,.56)*quiet;
    const fingerSearch=event(time,17.9,seed+113,.07,.06,.24)*quiet;
    const searchDigit=(Math.floor((time+(seed+113)*.139)/17.9)+side)%4;
    pose[`arm_${label}`].x=.022+brace*.035-probe*.09;
    pose[`arm_${label}`].y=sign*probe*.026;pose[`arm_${label}`].z=sign*(.018+probe*.032)+turn*.018;
    pose[`hand_${label}`].x=.045+brace*.12-probe*.14+retract*.045;
    pose[`hand_${label}`].y=sign*probe*.04;pose[`hand_${label}`].z=sign*(.012+retract*.025);
    pose[`wrist_${label}`].x=.11+brace*.09-probe*.15+retract*.09;
    pose[`wrist_${label}`].y=sign*(.035+probe*.07-retract*.025);
    pose[`wrist_${label}`].z=sign*(.025+probe*.055)-turn*.045;
    for(let finger=0;finger<4;finger++){
      // Adjacent fingers close with a short delay; the middle pair search first.
      const close=event(time-.82-finger*.075,interval,seed,.13,.34,.56)*quiet;
      const opening=event(time-finger*.035,interval,seed,.24,.64,.68)*quiet;
      const sensory=finger===1||finger===2?1:.42,twitch=finger===searchDigit?fingerSearch:0;
      const resting=.22+finger*.038+side*.045;
      pose[`finger_${label}${finger}`].x=resting+brace*.16-opening*.23*sensory+close*.27+twitch*.14;
      pose[`finger_${label}${finger}`].y=0;pose[`finger_${label}${finger}`].z=(finger-1.5)*(.022+opening*.018-close*.012);
      pose[`tip_${label}${finger}`].x=.24+finger*.025+side*.036+brace*.20-opening*.23*sensory+close*.37+twitch*.21;
      pose[`tip_${label}${finger}`].y=0;pose[`tip_${label}${finger}`].z=0;
    }
  }
  return pose;
}
