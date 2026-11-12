import '../helpers/register-ts-hooks.mjs';import test from 'node:test';import assert from 'node:assert/strict';const{defaults,bindKey,readSettings,volumeGain,volumeKeys}=await import('../../game/core/settings.ts');
test('rebinding swaps conflicts and reserves menu keys',()=>{const s=defaults();assert.ok(bindKey(s,'forward','KeyS'));assert.equal(s.bindings.forward,'KeyS');assert.equal(s.bindings.back,'KeyW');assert.equal(bindKey(s,'forward','Escape'),false);assert.equal(bindKey(s,'forward','F2'),false);});
test('saved settings validate malformed preferences and round-trip bindings',()=>{assert.deepEqual(readSettings('{'),defaults());const s=defaults();s.quality='low';s.sensitivity=1.5;bindKey(s,'forward','ArrowUp');assert.deepEqual(readSettings(JSON.stringify(s)),s);assert.equal(readSettings('{"sensitivity":900,"quality":"bad"}').sensitivity,2.5);const corrupt=defaults();corrupt.bindings.back='KeyW';assert.deepEqual(readSettings(JSON.stringify(corrupt)).bindings,defaults().bindings);});

test('custom graphics survive reload and invalid GPU settings use supported defaults',()=>{const s=defaults();Object.assign(s,{quality:'custom',resolution:1440,shadows:1024,fog:.5,reflections:256,aa:0,anisotropy:2,fov:82,perfOverlay:true});assert.deepEqual(readSettings(JSON.stringify(s)),s);const invalid=readSettings(JSON.stringify({resolution:900,fov:1,shadows:8192,aa:8,anisotropy:3,fog:0,perfOverlay:'yes'}));assert.equal(invalid.resolution,1080);assert.equal(invalid.fov,55);assert.equal(invalid.perfOverlay,false);for(const key of ['shadows','aa','anisotropy','fog'])assert.equal(invalid[key],defaults()[key]);});

test('the resolution is a fixed choice: 1080p by default, Native kept as 0, and the old automatic preset becomes High',()=>{assert.equal(defaults().resolution,1080);assert.equal(defaults().quality,'high');assert.equal(defaults().perfOverlay,false);assert.equal(readSettings('{"resolution":0}').resolution,0);for(const r of [720,1080,1440])assert.equal(readSettings(JSON.stringify({resolution:r})).resolution,r);const old=readSettings('{"quality":"auto","renderScale":60}');assert.equal(old.quality,'high');assert.equal('renderScale' in old,false);});

test('old binding saves preserve custom keys when adding the drop action',()=>{const old=defaults();delete old.bindings.drop;old.bindings.forward='KeyQ';const migrated=readSettings(JSON.stringify(old));assert.equal(migrated.bindings.forward,'KeyQ');assert.equal(migrated.bindings.drop,'KeyG');assert.equal(new Set(Object.values(migrated.bindings)).size,Object.keys(defaults().bindings).length);});

test('volume sliders default to the game\'s own mix, so existing players hear no change',()=>{for(const key of volumeKeys)assert.equal(defaults()[key],100);const old=defaults();for(const key of volumeKeys)delete old[key];const migrated=readSettings(JSON.stringify(old));for(const key of volumeKeys)assert.equal(migrated[key],100);assert.equal(readSettings('{"fov":80}').masterVolume,100);});

test('saved volumes round-trip and malformed ones are clamped or ignored',()=>{const s=defaults();Object.assign(s,{masterVolume:60,ambienceVolume:0,creatureVolume:35});assert.deepEqual(readSettings(JSON.stringify(s)),s);const bad=readSettings(JSON.stringify({masterVolume:250,ambienceVolume:-20,creatureVolume:'loud'}));assert.equal(bad.masterVolume,100);assert.equal(bad.ambienceVolume,0);assert.equal(bad.creatureVolume,100);assert.equal(readSettings('{"masterVolume":42.6}').masterVolume,43);});

test('volume curve is silent at 0, untouched at 100, perceptual in between, and monotonic',()=>{assert.equal(volumeGain(0),0);assert.equal(volumeGain(100),1);assert.equal(volumeGain(50),.25);assert.equal(volumeGain(-5),0);assert.equal(volumeGain(140),1);let last=-1;for(let v=0;v<=100;v+=5){const g=volumeGain(v);assert.ok(g>last);last=g;}});

test('the objective hint is on by default, including for saves from before it existed',()=>{assert.equal(defaults().objectiveHints,true);const old=defaults();delete old.objectiveHints;assert.equal(readSettings(JSON.stringify(old)).objectiveHints,true);assert.equal(readSettings('{"fov":80}').objectiveHints,true);assert.equal(readSettings(null).objectiveHints,true);assert.equal(readSettings('{').objectiveHints,true);});

test('turning the objective hint off survives a reload, and only a real boolean counts',()=>{const s=defaults();s.objectiveHints=false;assert.equal(readSettings(JSON.stringify(s)).objectiveHints,false);assert.deepEqual(readSettings(JSON.stringify(s)),s);s.objectiveHints=true;assert.deepEqual(readSettings(JSON.stringify(s)),s);for(const bad of ['false',0,1,null,'no',[],{}])assert.equal(readSettings(JSON.stringify({objectiveHints:bad})).objectiveHints,true,JSON.stringify(bad));assert.equal(readSettings('{"objectiveHints":false,"fov":80}').fov,80);});

test('the objective key is not one of the rebindable actions, and rebinding does not disturb the hint setting',()=>{assert.ok(!Object.values(defaults().bindings).includes('KeyO'));const s=defaults();s.objectiveHints=false;bindKey(s,'forward','ArrowUp');assert.equal(s.objectiveHints,false);assert.equal(readSettings(JSON.stringify(s)).bindings.forward,'ArrowUp');});

test('the frame rate limit defaults to 60, keeps 60, 120 or off, and ignores anything else', async () => {
  const { readSettings, defaults } = await import('../../game/core/settings.ts');
  assert.equal(defaults().frameCap, 60);
  for (const cap of [0, 60, 120]) assert.equal(readSettings(JSON.stringify({ frameCap: cap })).frameCap, cap);
  for (const bad of [30, 144, -1, 'fast', null]) assert.equal(readSettings(JSON.stringify({ frameCap: bad })).frameCap, 60);
});

test('ambient occlusion defaults to high, keeps off, medium or high, and ignores anything else', async () => {
  const { readSettings, defaults } = await import('../../game/core/settings.ts');
  assert.equal(defaults().ambientOcclusion, 2);
  assert.equal(readSettings('{"fov":80}').ambientOcclusion, 2);
  for (const level of [0, 1, 2]) assert.equal(readSettings(JSON.stringify({ ambientOcclusion: level })).ambientOcclusion, level);
  for (const bad of [3, -1, '2', null, true, 1.5]) assert.equal(readSettings(JSON.stringify({ ambientOcclusion: bad })).ambientOcclusion, 2);
});
