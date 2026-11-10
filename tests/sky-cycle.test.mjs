import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { solarDirection, nightVisibility, DAY_SKY_HEX, skyDisplayRadiance, starCatalog } from '../game/sky.ts';
import { createStableSunShadow } from '../game/shadows.ts';

test('the solar orbit rises in the east, passes south and sets in the west',()=>{
  const dawn=solarDirection(6),noon=solarDirection(12),dusk=solarDirection(18),night=solarDirection(0);
  assert.ok(dawn.x>.9&&dusk.x<-.9);
  assert.ok(noon.y>.7&&noon.z>0&&Math.abs(noon.x)<1e-8);
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

test('ambient illumination remains usable throughout the entire night cycle',()=>{
  for(let hour=0;hour<24;hour+=.025){
    const elevation=solarDirection(hour).y,daylight=THREE.MathUtils.smoothstep(elevation,-.14,.16);
    const light=nightVisibility(daylight);
    assert.ok(light.hemisphere>=.1&&light.environment>=.025,'ambient light was extinguished');
    assert.ok(light.hemisphere<=1&&light.environment<.2,'night floor changed the day exposure');
  }
  assert.ok(nightVisibility(0).hemisphere<nightVisibility(1).hemisphere*.25);
});

test('contact shadow offsets stay below a centimetre without enlarging the 4K map',()=>{
  const sun=new THREE.DirectionalLight(),shadow=createStableSunShadow(sun,8192);
  const depthRange=sun.shadow.camera.far-sun.shadow.camera.near;
  const offset=Math.abs(sun.shadow.bias)*depthRange+sun.shadow.normalBias;
  assert.ok(offset<.01,'boulder contact shadow can detach visibly from its surface');
  assert.equal(shadow.size,4096);assert.ok(shadow.texel<.018);
});


test('the daytime sky reproduces the exact sampled reference endpoints after exposure',()=>{
  assert.equal(DAY_SKY_HEX[0],0x88b9e6);assert.equal(DAY_SKY_HEX.at(-1),0x185197);
  for(const hex of DAY_SKY_HEX){
    const reference=new THREE.Color(hex),radiance=skyDisplayRadiance(reference);
    const aces=x=>(x*(2.51*x+.03))/(x*(2.43*x+.59)+.14);
    const resolved=new THREE.Color(aces(radiance.r*1.24),aces(radiance.g*1.24),aces(radiance.b*1.24));
    assert.equal(resolved.getHex(),hex,'the exact source color was changed by exposure');
  }
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
