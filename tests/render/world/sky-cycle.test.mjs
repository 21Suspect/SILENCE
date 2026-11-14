import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const { solarDirection, starCatalog, SUN_TURN, elevationKeyframes, keyStep } = await import('../../../game/render/world/sky.ts');
const { createStableSunShadow, installSunBlend, SUN_BLEND_MARK } = await import('../../../game/render/world/shadows.ts');

test('the solar orbit rises in the east, passes south-west over the sea (-z) and sets in the west',()=>{
  const dawn=solarDirection(6),noon=solarDirection(12),dusk=solarDirection(18),night=solarDirection(0);
  assert.ok(dawn.x>.8&&dusk.x<-.7);
  // Turned SUN_TURN west of south, so it rakes across the range (+z) instead of lighting it head-on from behind the lake.
  assert.ok(noon.y>.7&&noon.z<0&&noon.x<0);
  assert.ok(Math.abs(Math.atan2(-noon.x,-noon.z)-SUN_TURN)<1e-8);
  assert.ok(night.y<0);
  assert.ok(solarDirection(0).distanceTo(solarDirection(24))<1e-10);
  for(let hour=0;hour<24;hour+=.125)assert.ok(Math.abs(solarDirection(hour).length()-1)<1e-10);
});

test('a stationary player receives new shadows when the sun rotates',()=>{
  const sun=new THREE.DirectionalLight(),shadows=createStableSunShadow(sun,4096),position=new THREE.Vector3(7,1,2);
  assert.equal(shadows.update(position,solarDirection(7)),true);
  const lightDirection=new THREE.Vector3().subVectors(sun.position,sun.target.position).normalize();
  assert.ok(lightDirection.distanceTo(solarDirection(7))<1e-10);
  assert.equal(shadows.update(position,solarDirection(7)),false);
  assert.equal(shadows.update(position,solarDirection(7.1)),true);
  assert.ok(new THREE.Vector3().subVectors(sun.position,sun.target.position).normalize().distanceTo(solarDirection(7.1))<1e-10);
});

test('contact shadow offsets stay below a centimetre without enlarging the 4K map',()=>{
  const sun=new THREE.DirectionalLight(),shadow=createStableSunShadow(sun,8192);
  const depthRange=sun.shadow.camera.far-sun.shadow.camera.near;
  const offset=Math.abs(sun.shadow.bias)*depthRange+sun.shadow.normalBias;
  assert.ok(offset<.01,'boulder contact shadow can detach visibly from its surface');
  assert.equal(shadow.size,4096);assert.ok(shadow.texel<.018);
});


test('stellar points cover a sphere without pole streaks and have a restrained brightness hierarchy',()=>{
  const {positions,colors,flux,size}=starCatalog();let yMean=0,bright=0;
  assert.equal(flux.length,4200);assert.equal(size.length,4200);
  for(let i=0;i<flux.length;i++){
    const x=positions[i*3],y=positions[i*3+1],z=positions[i*3+2];
    assert.ok(Math.abs(Math.hypot(x,y,z)-1)<1e-6);yMean+=y;
    assert.ok(size[i]>=.29&&size[i]<=.55,'stars became large discs');
    if(flux[i]>.8)bright++;
    for(let c=0;c<3;c++)assert.ok(colors[i*3+c]>.5&&colors[i*3+c]<=1,'exaggerated colored star');
  }
  assert.ok(Math.abs(yMean/flux.length)<.035,'stars cluster at one pole');
  assert.ok(bright>80&&bright<500,'brightness hierarchy is too uniform');
});


test('sampled sun light moves continuously with the sun: a blend of two samples, within .1 % of the model, a few evaluations a second',()=>{
  // A stand-in with the model's shape: an exponential in 1/elevation, as the sun's colour at dusk is.
  const exact=el=>Math.exp(-.12/Math.max(el+.01,.004));
  const keys=elevationKeyframes(1,(el,out)=>{out[0]=exact(el);}),out=new Float64Array(1);
  let worst=0,previous=NaN,biggest=0;const frames=60*60;
  for(let k=0;k<frames;k++){
    const hours=17+k*.016/60,el=solarDirection(hours).y;
    keys.sample(el,out,0);
    worst=Math.max(worst,Math.abs(out[0]-exact(el))/exact(el));
    if(Number.isFinite(previous))biggest=Math.max(biggest,Math.abs(out[0]-previous)/Math.max(exact(el),1e-9));
    previous=out[0];
  }
  assert.ok(worst<.001,`blend strays ${(worst*100).toFixed(3)} % from the model`);
  // No step: the largest change in one frame is what the sun's own motion makes of it (about .25 % here), never a sample's jump.
  assert.ok(biggest<.01,`a frame changed the light by ${(biggest*100).toFixed(2)} %`);
  assert.ok(keys.evaluations<3*60,`${keys.evaluations} evaluations in a minute of dusk`);
  // The grid is finer where the light changes faster, and never over a sample step of .012.
  assert.ok(keyStep(.003)<keyStep(.1)&&keyStep(.1)<keyStep(.7)&&keyStep(.7)<=.012&&keyStep(0)>=1e-4);
});

test('sampled sun light follows a clock set backwards and a tuning change',()=>{
  let calls=0;const keys=elevationKeyframes(1,(el,out)=>{calls++;out[0]=el*2;}),out=new Float64Array(1);
  for(const el of [.5,.5004,.4996,.3,.31,.2,.5]){keys.sample(el,out,0);assert.ok(Math.abs(out[0]-el*2)<1e-9,`wrong at ${el}`);}
  const before=calls;keys.sample(.5,out,0);assert.equal(calls,before,'a still sun evaluates nothing');
  keys.sample(.5,out,1);assert.ok(calls>before,'a changed tuning is not resampled');
});

test('the sun shadow chunk names one sampler only: the near ground has no texture unit to spare',()=>{
  installSunBlend();
  const chunk=THREE.ShaderChunk.lights_fragment_begin;
  assert.ok(chunk.includes(SUN_BLEND_MARK));
  assert.ok(!chunk.includes('directionalShadowMap[ 1 ]'));
  // The probe carries data, not light.
  assert.ok(!chunk.includes('irradiance += getLightProbeIrradiance'));
  assert.equal(installSunBlend(),true,'installing twice is harmless');
  assert.equal(THREE.ShaderChunk.lights_fragment_begin.split(SUN_BLEND_MARK).length,chunk.split(SUN_BLEND_MARK).length);
});

test('two sun maps: one draw each time the sun has turned a texel at 12 m, weights that follow the sun between them',()=>{
  const sun=new THREE.DirectionalLight(),probe=new THREE.LightProbe(),shadows=createStableSunShadow(sun,16384,()=>true,probe),weightOf=()=>{const c=probe.sh.coefficients[4];return c.y>0?1-c.x:c.x;};   // the weight of slot 1
  assert.ok(shadows.blendable&&shadows.size===4096);
  const position=new THREE.Vector3(7,1,2);let draws=0,hours=15,weightSteps=0,lastWeight=0,now=0;const limit=shadows.texel/12;
  const run=frames=>{
    for(let k=0;k<frames;k++){
      hours+=.016/60;now+=16.7;
      const flagged=shadows.frame({position,direction:solarDirection(hours),casters:false,animated:false,active:true,now});
      if(flagged){draws++;sun.shadow.needsUpdate=false;}
      const weight=weightOf();
      assert.ok(weight>=0&&weight<=1,'weight out of range');
      // The second slot's weight rises and falls by turns as the two maps swap roles, but it never jumps.
      if(k>3&&Math.abs(weight-lastWeight)>.3){weightSteps++;}
      lastWeight=weight;
    }
  };
  run(60*60);   // a minute at normal day speed (.25 degrees a second)
  const turnPerSecond=.25*Math.PI/180;
  const expected=60*turnPerSecond/limit;
  assert.ok(Math.abs(draws-expected)<expected*.2+3,`${draws} draws, about ${expected.toFixed(0)} expected`);
  assert.equal(weightSteps,0,'the weight jumped');
  assert.ok(draws/60<8,'no cheaper than the old 8 a second');
  // Standing still: nothing is drawn, the weight settles at 0 or 1 of one map.
  const before=draws;for(let k=0;k<120;k++){now+=16.7;if(shadows.frame({position,direction:solarDirection(hours),casters:false,animated:false,active:true,now}))draws++;}
  assert.ok(draws-before<=1,'a paused sun redrew');
  assert.ok(weightOf()===0||weightOf()===1);
});

test('two sun maps: a changed caster, a moving creature and the night',()=>{
  const sun=new THREE.DirectionalLight(),probe=new THREE.LightProbe(),shadows=createStableSunShadow(sun,16384,()=>true,probe),weightOf=()=>{const c=probe.sh.coefficients[4];return c.y>0?1-c.x:c.x;};   // the weight of slot 1
  const position=new THREE.Vector3(),direction=solarDirection(14);let now=0;
  const frame=o=>{now+=16.7;return shadows.frame({position,direction,casters:false,animated:false,active:true,now,...o});};
  assert.equal(frame({}),true,'the first map');
  for(let k=0;k<10;k++)frame({});
  assert.equal(frame({casters:true}),true,'a door opened: redrawn at once');
  assert.equal(frame({active:false}),false,'night draws nothing');
  let animatedDraws=0;for(let k=0;k<60;k++)if(frame({animated:true}))animatedDraws++;
  assert.ok(animatedDraws>=28&&animatedDraws<=32,`${animatedDraws} draws a second for a moving caster`);
  assert.equal(weightOf(),0,'a moving caster is not blended');
  const jump=solarDirection(20);assert.equal(shadows.frame({position,direction:jump,casters:false,animated:false,active:true,now:now+16}),true,'the clock was set: one map for the new sun');
});

test('two sun maps: the probe carries the matrix from the sun\'s slot to the other, and each slot lies in its half of the texture',()=>{
  const sun=new THREE.DirectionalLight(),probe=new THREE.LightProbe(),shadows=createStableSunShadow(sun,16384,()=>true,probe);
  const position=new THREE.Vector3(12,3,-9);let hours=15,now=0,checked=0;
  for(let k=0;k<900;k++){
    hours+=.016/60;now+=16.7;
    const flagged=shadows.frame({position,direction:solarDirection(hours),casters:false,animated:false,active:true,now});
    // What three.js does when the light's shadow is flagged: it draws, which updates the matrices for the slot.
    if(flagged){sun.shadow.updateMatrices(sun);sun.shadow.needsUpdate=false;}
    const c=probe.sh.coefficients,weight=c[4].x,current=c[4].y>0?1:0;
    if(weight<=0||weight>=1)continue;
    const f=[...c[0].toArray(),...c[1].toArray(),...c[2].toArray(),...c[3].toArray()];
    // Rows 0 to 2 of the 4 x 4, row by row: from the sun's slot to the other.
    const t=new THREE.Matrix4().set(f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],f[10],f[11],0,0,0,1);
    assert.ok(sun.shadow.matrix.equals(sun.shadow.atlas[current]),'the sun\'s matrix is not its own slot\'s');
    assert.equal(c[4].z,(1-current)*.5);
    for(const point of [new THREE.Vector3(12,3,-9),new THREE.Vector3(20,8,-2),new THREE.Vector3(-4,1,-30)]){
      const mine=sun.shadow.atlas[current],other=sun.shadow.atlas[1-current];
      const a=point.clone().applyMatrix4(mine).applyMatrix4(t),b=point.clone().applyMatrix4(other);
      assert.ok(a.distanceTo(b)<1e-5,`transfer is off by ${a.distanceTo(b)}`);
      // Slot 0 is the left half of the texture, slot 1 the right.
      const inMine=point.clone().applyMatrix4(mine),inOther=point.clone().applyMatrix4(other);
      if(Math.abs(inMine.y-.5)<.4)assert.ok(inMine.x>=current*.5&&inMine.x<=current*.5+.5,'the sun\'s slot is not in its half');
      if(Math.abs(inOther.y-.5)<.4)assert.ok(inOther.x>=(1-current)*.5&&inOther.x<=(1-current)*.5+.5,'the other slot is not in its half');
    }
    checked++;
  }
  assert.ok(checked>100,'never saw a blend');
});

test('the map ahead drawn over three frames: three flagged frames in a row, counting for nothing until the last, and no jump after',()=>{
  const sun=new THREE.DirectionalLight(),probe=new THREE.LightProbe(),scene=new THREE.Scene(),shadows=createStableSunShadow(sun,16384,()=>true,probe);
  // Casters for the shares: six meshes of different sizes, dealt so that each share carries about the same number of triangles.
  scene.add(sun);
  const casters=[900,700,400,300,200,100].map(n=>{const mesh=new THREE.Mesh(new THREE.PlaneGeometry(1,1,n,1));mesh.castShadow=true;scene.add(mesh);return mesh;});
  const position=new THREE.Vector3(7,1,2),otherWeight=()=>probe.sh.coefficients[4].x;let hours=15,now=0,run=0,runs=0,last=0;
  for(let k=0;k<60*20;k++){
    hours+=.016/60;now+=16.7;
    const flagged=shadows.frame({position,direction:solarDirection(hours),casters:k===0,animated:false,active:true,now,spread:3});
    if(k<5){sun.shadow.needsUpdate=false;continue;}   // the first map is drawn whole, at once, and the first map ahead straight after it
    if(flagged){
      run++;sun.shadow.needsUpdate=false;
      assert.equal(sun.userData.shadowPart,run-1,'shares come in order');
      assert.equal(otherWeight(),0,'a map still coming in was given weight');
    }else{
      if(run){assert.equal(run,3,`a map came in over ${run} frames`);runs++;run=0;}
      assert.equal(sun.userData.shadowPart,-1);
      assert.ok(Math.abs(otherWeight()-last)<.35,'the weight jumped');
    }
    last=otherWeight();
  }
  assert.ok(runs>10,`${runs} maps in twenty seconds`);
  const loads=[0,0,0];for(const mesh of casters)loads[mesh.userData.sunShare]+=mesh.geometry.index.count/3;
  assert.ok(Math.max(...loads)-Math.min(...loads)<=400,`shares of ${loads.join(', ')} triangles`);
  // A caster that changes mid-way starts a whole map at once.
  let k=0;while(!shadows.frame({position,direction:solarDirection(hours+=.016/60),casters:false,animated:false,active:true,now:now+=16.7,spread:3})&&k++<200);
  assert.equal(sun.userData.shadowPart,0);
  assert.ok(shadows.frame({position,direction:solarDirection(hours+=.016/60),casters:true,animated:false,active:true,now:now+=16.7,spread:3}));
  assert.equal(sun.userData.shadowPart,-1,'a changed caster did not restart the map whole');
});
