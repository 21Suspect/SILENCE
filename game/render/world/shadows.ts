import * as THREE from 'three';

/** The tallest thing that casts a shadow here, a full-grown tree, in metres. */
const TALLEST = 33;
/**
 * How far (radians) the sun may turn before a shadow map drawn for the old direction is visibly stale. The far end of the longest
 * shadow, from the top of the tallest tree, moves by (turn x its distance along the light); the map is as good as new while that stays
 * under half a texel. At normal day speed the sun turns .25 degrees a second, so this redraws about 20 times a second instead of at every frame.
 */
export function sunTurnLimit(texel: number, sinElevation: number) {
  return .5 * texel / (TALLEST / Math.max(sinElevation, .18));
}

// three.js does not export the class, only its type: take it from a light.
const DirectionalShadow = new THREE.DirectionalLight().shadow.constructor as new () => THREE.DirectionalLightShadow;

/**
 * The sun's shadow as two maps side by side in one texture (slot 0 left, slot 1 right), each with the camera where its own pose says
 * instead of where the light is: the sun must point where the sun is at every frame (it shades with that) while a map is drawn for the
 * sun as it will be a moment later. One sampler serves both: the near ground's shader has no unit to spare (WebGL's sixteen), so the
 * second map is never a second sampler, nor a second shadow light (that would make the shadow sampler array two long, and two units).
 * The matrix that finds the other slot from the coordinate three.js computes for the sun's slot is carried to the shader in a light
 * probe (see `installSunBlend`); three.js copies the probe's numbers before it draws the maps, so a draw must not change the matrix
 * they were made for: it never goes to the slot the sun's matrix carries. With
 * `follow` on (one map, drawn where the light is) it is the plain shadow in slot 0, for the one-map path and for tests.
 */
export class SlotShadow extends DirectionalShadow {
  follow = true;
  /** The slot the next draw goes to. */
  slot = 0;
  /** The slot the sun's own matrix carries (the one in use; a draw goes to the other, so the matrix three.js has already handed out stays right). */
  primary = 0;
  readonly poses = [0, 1].map(() => ({ matrixWorld: new THREE.Matrix4(), target: { matrixWorld: new THREE.Matrix4() } }));
  /** Each slot's matrix to its own [0,1] square, and to the texture. */
  readonly locals = [new THREE.Matrix4(), new THREE.Matrix4()];
  readonly atlas = [new THREE.Matrix4(), new THREE.Matrix4()];
  private readonly rect = new THREE.Vector4(0, 0, 1, 1);
  private readonly place = new THREE.Matrix4();
  override getFrameExtents() { return new THREE.Vector2(2, 1); }
  override getViewportCount() { return 1; }
  override getViewport() { return this.rect.set(this.slot, 0, 1, 1); }
  override updateMatrices(light: THREE.Light) {
    const slot = this.follow ? 0 : this.slot;
    super.updateMatrices(this.follow ? light : this.poses[slot] as unknown as THREE.Light);
    this.locals[slot].copy(this.matrix);
    this.matrix.premultiply(this.place.set(.5, 0, 0, slot * .5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1));
    this.atlas[slot].copy(this.matrix);
    this.matrix.copy(this.atlas[this.follow ? 0 : this.primary]);
  }
}

/**
 * The sun's shadow maps are texel grids sampled at points: as the sun turns, a shadow edge does not move, it jumps a whole texel (1.8 cm
 * at 72 m over 4096) each time it crosses a texel centre, and every redraw lands the grid on a new phase. Redrawing the map every frame
 * does not smooth that (measured, 1280x800, normal day speed: each frame's change was 2.5 times the sun's own motion, the rest
 * re-quantisation noise), and it costs 3.7 ms a frame. What does is blending in time: two maps, drawn a short turn of the sun apart,
 * shaded together with weights that follow the sun between them, so an edge slides from one texel position to the next. The lighting
 * chunk (`installSunBlend`) finds slot 1 from the coordinate three.js already computes for slot 0 (one matrix, `transfer`) and takes
 * that and the weight from a light probe, which three.js uploads to every lit shader every frame and which carries no light here (the
 * chunk drops its irradiance): its nine coefficients are free to carry data. The weight is the sun's own progress along the arc
 * between the two maps' directions, so it needs no clock and follows a paused, scrubbed or fast-running day.
 */
export const SUN_BLEND_MARK = 'silence-sun-blend';
export function installSunBlend() {
  const source = THREE.ShaderChunk.lights_fragment_begin;
  if (source.includes(SUN_BLEND_MARK)) return true;
  // The sun's shadow term (light 0), as three.js writes it, with or without the unlit-light guard in front (render/gpu/light-guards.ts).
  const pattern = /directLight\.color \*= \( directLight\.visible && receiveShadow( && dot\( directLight\.color, vec3\( 1\.0 \) \) > 0\.0)? \) \? getShadow\( directionalShadowMap\[ i \], directionalLightShadow\.shadowMapSize, directionalLightShadow\.shadowIntensity, directionalLightShadow\.shadowBias, directionalLightShadow\.shadowRadius, vDirectionalShadowCoord\[ i \] \) : 1\.0;/;
  const found = pattern.exec(source);
  if (!found) { console.warn('SILENCE: three.js words the sun shadow lookup differently: the sun blends nothing (shadows.ts installSunBlend).'); return false; }
  const guard = `directLight.visible && receiveShadow${found[1] ?? ''}`;
  // Probe coefficients 0 to 3 hold the twelve numbers of the transfer matrix (rows 0 to 2 of the 4 x 4, row by row); 4 holds the weight of
  // the other slot, where the sun's slot lies in the texture (0 left, .5 right) and where the other does.
  const blended = `#if defined( USE_LIGHT_PROBES ) && UNROLLED_LOOP_INDEX == 0
		// ${SUN_BLEND_MARK}: both slots are in map 0, the sun's matrix finds one and the light probe carries the way to the other
		if ( ${guard} ) {
			float sunWeight = lightProbe[ 4 ].x, sunShadow = 0.0;
			vec2 sunMapSize = vec2( textureSize( directionalShadowMap[ 0 ], 0 ) );
			vec4 sunCoord0 = vDirectionalShadowCoord[ 0 ];
			if ( sunWeight < 1.0 ) sunShadow += ( 1.0 - sunWeight ) * ( sunCoord0.x >= lightProbe[ 4 ].y && sunCoord0.x <= lightProbe[ 4 ].y + 0.5 ? getShadow( directionalShadowMap[ 0 ], sunMapSize, 1.0, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, sunCoord0 ) : 1.0 );
			if ( sunWeight > 0.0 ) {
				mat4 sunTransfer = mat4(
					lightProbe[ 0 ].x, lightProbe[ 1 ].y, lightProbe[ 2 ].z, 0.0,
					lightProbe[ 0 ].y, lightProbe[ 1 ].z, lightProbe[ 3 ].x, 0.0,
					lightProbe[ 0 ].z, lightProbe[ 2 ].x, lightProbe[ 3 ].y, 0.0,
					lightProbe[ 1 ].x, lightProbe[ 2 ].y, lightProbe[ 3 ].z, 1.0 );
				vec4 sunCoord1 = sunTransfer * vec4( sunCoord0.xyz / sunCoord0.w, 1.0 );
				sunShadow += sunWeight * ( sunCoord1.x >= lightProbe[ 4 ].z && sunCoord1.x <= lightProbe[ 4 ].z + 0.5 ? getShadow( directionalShadowMap[ 0 ], sunMapSize, 1.0, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, sunCoord1 ) : 1.0 );
			}
			directLight.color *= sunShadow;
		}
		#else
		${found[0]}
		#endif`;
  // The probe's own job, light from a sphere of colour, is dropped: here it carries numbers.
  const irradiance = 'irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );';
  if (!source.includes(irradiance)) { console.warn('SILENCE: three.js words the light probe differently: the sun blends nothing (shadows.ts installSunBlend).'); return false; }
  THREE.ShaderChunk.lights_fragment_begin = source.replace(found[0], blended).replace(irradiance, `// ${SUN_BLEND_MARK}: the light probe carries data`);
  return true;
}

/** Snap the moving light's projection to whole shadow texels. A fixed time of
 * day retains an identical sampling phase even across hilly terrain. */
/** `throttle` says whether the map may be left alone while it is only slightly stale (the engine ties it to a dev switch); tests and scrubbing tools get the default, on.
 * `probe`: the light probe that carries the blend to the shaders (see above), and `renderer`: its clear is told to spare the slot not being drawn; without them, one plain map, as before. */
export function createStableSunShadow(sun: THREE.DirectionalLight, maxTextureSize: number, throttle: () => boolean = () => true, probe?: THREE.LightProbe, renderer?: THREE.WebGLRenderer) {
  // Concentrate the same 4K budget around the player. The renderer uses
  // PCFSoftShadowMap: its sub-texel interpolation removes the old 17-level
  // staircase without adding a larger depth texture or another render pass.
  // With a probe the texture holds two maps side by side, so each may be up to half the largest texture wide.
  const cap = () => probe ? Math.floor(maxTextureSize / 2) : maxTextureSize;
  let size = Math.min(4096, cap());const span=72;let texel=span/size;
  const offset=new THREE.Vector3(25,37,-68),backward=offset.clone().normalize();
  const right=new THREE.Vector3(),up=new THREE.Vector3(),center=new THREE.Vector3();
  const lastAnchor=new THREE.Vector3(Infinity,Infinity,Infinity),lastDirection=new THREE.Vector3();
  // What the shadow map was last drawn for: where the player stood and which way the light pointed.
  const drawnAnchor=new THREE.Vector3(Infinity,Infinity,Infinity),drawnDirection=new THREE.Vector3();let drawn=false;
  let directionReady=false;
  const basis=(towards:THREE.Vector3)=>{right.crossVectors(THREE.Object3D.DEFAULT_UP,towards);if(right.lengthSq()<.0001)right.set(1,0,0);else right.normalize();up.crossVectors(towards,right).normalize();};basis(backward);
  const slotShadow=probe?new SlotShadow():undefined;
  if(slotShadow)sun.shadow=slotShadow;
  sun.shadow.mapSize.set(size,size);
  Object.assign(sun.shadow.camera,{left:-span/2,right:span/2,top:span/2,bottom:-span/2,near:.5,far:230});sun.shadow.camera.updateProjectionMatrix();
  // Bias is in shadow-camera depth units. The former values detached contact
  // shadows by centimetres, especially at low sun angles and boulder edges.
  sun.shadow.bias=-.000012;sun.shadow.normalBias=.004;sun.shadow.radius=1;
  // The probe lights nothing (the lighting chunk drops its irradiance): its coefficients are the blend's numbers, and it is seen from every layer the sun is.
  const coefficients=probe?.sh.coefficients;
  if(probe){probe.intensity=1;probe.layers.mask=sun.layers.mask;for(const c of coefficients!)c.set(0,0,0);}
  // three.js clears the whole target before it draws a map into it, which would wipe the slot that is still in use: the sun's clear
  // is limited to the slot being drawn.
  let clearSlot=-1;
  if(renderer&&slotShadow){
    const clear=renderer.clear.bind(renderer);
    renderer.clear=(color?:boolean,depth?:boolean,stencil?:boolean)=>{
      // A later share of a map drawn over several frames (see `deal`): what the earlier shares drew stays.
      if(clearSlot===-2&&sun.shadow.map&&renderer.getRenderTarget()===sun.shadow.map){clearSlot=-1;return;}
      if(clearSlot<0||!sun.shadow.map||renderer.getRenderTarget()!==sun.shadow.map)return clear(color,depth,stencil);
      const state=renderer.state,slot=clearSlot;clearSlot=-1;
      state.setScissorTest(true);state.scissor(new THREE.Vector4(slot*size,0,size,size));clear(color,depth,stencil);state.setScissorTest(false);
    };
  }
  /** Where a map for `direction` is drawn from, round the player: the same texel snapping as the one-map path. */
  const place=(slot:number,direction:THREE.Vector3,position:THREE.Vector3)=>{
    basis(direction);
    const x=Math.round(position.dot(right)/texel)*texel,y=Math.round(position.dot(up)/texel)*texel,z=Math.round(position.dot(direction)/.5)*.5;
    center.copy(right).multiplyScalar(x).addScaledVector(up,y).addScaledVector(direction,z);
    slotShadow!.poses[slot].target.matrixWorld.makeTranslation(center.x,center.y,center.z);
    slotShadow!.poses[slot].matrixWorld.makeTranslation(center.x+direction.x*105,center.y+direction.y*105,center.z+direction.z*105);
  };
  // The blended path. Each slot is a map with what it was drawn for. `current` holds the sun as it is; a cycle draws the other one for
  // the sun a short turn ahead, and the weight of that one rises from 0 to 1 as the sun gets there.
  type Slot={direction:THREE.Vector3,anchor:THREE.Vector3,valid:boolean};
  const slots:Slot[]=[0,1].map(()=>({direction:new THREE.Vector3(),anchor:new THREE.Vector3(Infinity,Infinity,Infinity),valid:false}));
  let current=0,blending=false,weight=0,lastDraw=-Infinity,stillFor=0;
  /** What the fog and the ambient occlusion read: the texture, the map's own [0,1] matrix and where in the texture it lies. */
  const info={map:null as THREE.Texture|null,matrix:new THREE.Matrix4(),offset:0};
  sun.userData.shadowSlot=info;
  const previous=new THREE.Vector3(),step=new THREE.Vector3(),ahead=new THREE.Vector3(),chord=new THREE.Vector3(),along=new THREE.Vector3();
  /** The turn of the sun (radians) between a map and the next one: a shadow's far end, at 12 m from what casts it, moves by one texel. */
  const turn=()=>texel/12;
  const transfer=new THREE.Matrix4(),inverse=new THREE.Matrix4();
  /** The probe's numbers: the matrix that takes a coordinate in the sun's slot (`current`) to the same point's coordinate in the other,
   * row by row, then the other's weight and the two slots' places in the texture. */
  const write=(weightOfOther:number)=>{
    slotShadow!.primary=current;
    // The sun's matrix is the primary slot's (three.js holds the object, so a draw that moves the other slot cannot disturb it).
    sun.shadow.matrix.copy(slotShadow!.atlas[current]);
    if(!coefficients)return;
    // Only needed while the other slot counts, and only then is it a valid matrix.
    if(weightOfOther>0){
      transfer.multiplyMatrices(slotShadow!.atlas[1-current],inverse.copy(slotShadow!.atlas[current]).invert());
      const e=transfer.elements,f=[0,1,2,3,4,5,6,7,8,9,10,11].map(i=>e[(i%4)*4+Math.floor(i/4)]);
      for(let k=0;k<4;k++)coefficients[k].set(f[k*3],f[k*3+1],f[k*3+2]);
    }
    coefficients[4].set(weightOfOther,current*.5,(1-current)*.5);
  };
  const draw=(index:number,direction:THREE.Vector3,position:THREE.Vector3,now:number)=>{
    const slot=slots[index];
    place(index,direction,position);slot.direction.copy(direction);slot.anchor.copy(position);slot.valid=true;
    slotShadow!.slot=index;clearSlot=index;sun.shadow.needsUpdate=true;lastDraw=now;
  };
  // The map for the sun a turn ahead is drawn about three times a second, and all of it landed in one frame: 2.6 million triangles,
  // 3.6 ms on top of a 21 ms frame at 2560 x 1440, a dropped frame each time it crossed a refresh. It is not needed at once (its
  // weight starts at nothing), so it can be drawn in shares over as many frames: the casters are dealt into shares of about equal
  // triangle counts, each frame's shadow pass draws one share (the others draw nothing: onBeforeShadow, for the sun's camera only,
  // so the torch's shadow in the same frame is whole), and the map counts for nothing until the last share is in.
  let part=-1,parts=1;
  sun.userData.shadowPart=-1;
  const hooked=new WeakSet<THREE.Object3D>();
  const deal=(shares:number)=>{
    let root:THREE.Object3D=sun;while(root.parent)root=root.parent;
    const casters:{mesh:THREE.Mesh,load:number}[]=[];
    root.traverseVisible(o=>{
      const mesh=o as THREE.Mesh;if(!mesh.isMesh||!mesh.castShadow||!mesh.geometry)return;
      const g=mesh.geometry,instances=(mesh as THREE.InstancedMesh).isInstancedMesh?(mesh as THREE.InstancedMesh).count:1;
      casters.push({mesh,load:(g.index?g.index.count:g.attributes.position?.count??0)/3*instances});
      if(hooked.has(mesh))return;hooked.add(mesh);
      const before=mesh.onBeforeShadow,after=mesh.onAfterShadow;let held=-1;
      mesh.onBeforeShadow=function(renderer,scene,camera,shadowCamera,geometry,depthMaterial,group){
        before.call(this,renderer,scene,camera,shadowCamera,geometry,depthMaterial,group);
        const share=sun.userData.shadowPart as number,own=mesh.userData.sunShare as number|undefined;
        if(share<0||own===undefined||own===share||shadowCamera!==sun.shadow.camera)return;
        const instanced=mesh as THREE.InstancedMesh;
        if(instanced.isInstancedMesh){held=instanced.count;instanced.count=0;}else{held=geometry.drawRange.count;geometry.drawRange.count=0;}
      };
      mesh.onAfterShadow=function(renderer,scene,camera,shadowCamera,geometry,depthMaterial,group){
        if(held>=0){const instanced=mesh as THREE.InstancedMesh;if(instanced.isInstancedMesh)instanced.count=held;else geometry.drawRange.count=held;held=-1;}
        after.call(this,renderer,scene,camera,shadowCamera,geometry,depthMaterial,group);
      };
    });
    // Heaviest first into whichever share is lightest so far.
    const loads=new Array<number>(shares).fill(0);
    for(const {mesh,load} of casters.sort((a,b)=>b.load-a.load)){let least=0;for(let k=1;k<shares;k++)if(loads[k]<loads[least])least=k;mesh.userData.sunShare=least;loads[least]+=load;}
  };
  const publish=()=>{
    // The weight of slot 1 and the matrix from slot 0's coordinate to slot 1's go to the probe; the fog and the ambient occlusion read
    // whichever map counts more.
    write(weight);
    const shown=weight<.5?current:1-current;
    info.map=sun.shadow.map?.texture??null;info.matrix=slotShadow!.locals[shown];info.offset=shown*.5;
  };
  return {
    get size(){return size;},get texel(){return texel;},
    /** True when the blended path is possible: a probe was given. */
    get blendable(){return !!probe;},
    setQuality(requested=4096){
      const wanted=Math.min(cap(),requested,4096);if(wanted===size)return false;size=wanted;texel=span/size;
      sun.shadow.mapSize.set(size,size);sun.shadow.map?.dispose();sun.shadow.map=null;
      lastAnchor.set(Infinity,Infinity,Infinity);drawn=false;for(const s of slots)s.valid=false;blending=false;weight=0;return true;
    },
    dispose(){sun.shadow.dispose();},
    update(position:THREE.Vector3,direction?:THREE.Vector3){
      let rotated=false;
      if(slotShadow){
        // Back from the blended path (a dev switch), or the first call: one map, in slot 0, drawn where the light is.
        if(!slotShadow.follow||slots.some(s=>s.valid)){slotShadow.follow=true;slotShadow.slot=0;for(const s of slots)s.valid=false;drawn=false;blending=false;weight=0;current=0;write(0);}
        info.map=sun.shadow.map?.texture??null;info.matrix=slotShadow.locals[0];info.offset=0;clearSlot=0;
      }
      if(direction){
        // Follow the continuous solar direction every rendered frame; angular
        // quantisation caused the visible ticking during accelerated days.
        if(!directionReady||lastDirection.distanceToSquared(direction)>1e-18){
          directionReady=true;lastDirection.copy(direction);backward.copy(direction).normalize();offset.copy(backward).multiplyScalar(105);basis(backward);rotated=true;
        }
      }
      if(!rotated&&position.distanceToSquared(lastAnchor)<4)return false;
      lastAnchor.copy(position);
      const x=Math.round(position.dot(right)/texel)*texel,y=Math.round(position.dot(up)/texel)*texel,z=Math.round(position.dot(backward)/.5)*.5;
      center.copy(right).multiplyScalar(x).addScaledVector(up,y).addScaledVector(backward,z);
      sun.target.position.copy(center);sun.position.copy(center).add(offset);sun.target.updateMatrixWorld();sun.updateMatrixWorld();
      // The light follows the sun at every call, so lighting is continuous. The shadow map is only redrawn when it has gone stale: the player
      // has walked 2 m, or the sun has turned far enough to move a shadow by half a texel (see sunTurnLimit).
      if(drawn&&throttle()&&position.distanceToSquared(drawnAnchor)<4&&drawnDirection.distanceToSquared(backward)<=sunTurnLimit(texel,backward.y)**2)return false;
      drawn=true;drawnAnchor.copy(position);drawnDirection.copy(backward);
      return true;
    },
    /**
     * One frame of the blended path (needs the probe). Positions the sun's light exactly, decides whether a map is drawn this frame (at most
     * one: it is flagged on the sun's shadow) and sets the weights the lighting chunk reads. `casters`: something that casts changed (a
     * streamed tree, a door); `animated`: something that moves casts (the creature), which takes one map at 30 a second, unblended;
     * `active`: the sun is up; `minGap`: the fewest milliseconds between two draws (the Shadow updates setting). Returns whether a map was flagged.
     */
    frame({position,direction,casters,animated,active,now,minGap=0,spread=1}:{position:THREE.Vector3,direction:THREE.Vector3,casters:boolean,animated:boolean,active:boolean,now:number,minGap?:number,/** Frames to draw the map ahead over (1: all at once). */spread?:number}){
      slotShadow!.follow=false;sun.userData.shadowPart=-1;
      // The light that shades follows the sun exactly, whatever the maps were drawn for.
      backward.copy(direction).normalize();sun.target.position.copy(position);sun.position.copy(position).addScaledVector(backward,105);sun.target.updateMatrixWorld();sun.updateMatrixWorld();
      lastAnchor.set(Infinity,Infinity,Infinity);
      const had=previous.lengthSq()>0,moved=had?previous.distanceTo(backward):0;
      step.copy(backward).sub(previous);previous.copy(backward);
      if(!active){weight=0;blending=false;part=-1;publish();return false;}
      const cur=slots[current],to=slots[1-current];
      stillFor=moved<1e-9?stillFor+1:0;
      // A whole map at once, for the sun as it is; a map ahead that was still being dealt out is dropped.
      const fresh=()=>{part=-1;draw(current,backward,position,now);blending=false;weight=0;publish();return true;};
      // A new sun (the clock was set), a changed caster, a moving one, a map the player has left behind while the sun stands still.
      if(!cur.valid||casters||moved>.02)return fresh();
      if(animated){if(now-lastDraw>=1000/30-1)return fresh();weight=0;blending=false;part=-1;publish();return false;}
      if(part>=0){
        // The map ahead is still coming in: its next share, without clearing what is there; until the last it counts for nothing.
        if(++part<parts){slotShadow!.slot=1-current;clearSlot=-2;sun.shadow.needsUpdate=true;sun.userData.shadowPart=part;lastDraw=now;weight=0;publish();return true;}
        part=-1;
      }
      if(!blending&&stillFor>2){
        if(position.distanceToSquared(cur.anchor)>=4)return fresh();
        weight=0;publish();return false;
      }
      if(blending){
        chord.copy(to.direction).sub(cur.direction);along.copy(backward).sub(cur.direction);
        const length2=chord.lengthSq();weight=length2>0?Math.min(1,along.dot(chord)/length2):1;
        // The sun stopped between the two maps, or turned back: neither is the sun now.
        if(along.dot(chord)<-.25*length2||(stillFor>6&&weight<1))return fresh();
        if(weight>=1){current=1-current;blending=false;weight=0;}
      }
      if(!blending&&moved>0){
        if(minGap>0&&now-lastDraw<minGap){publish();return false;}
        // The next map, for the sun a turn ahead (or the next frame's, when the sun moves more than that in one).
        const reach=Math.max(turn(),moved*1.5);
        ahead.copy(backward).addScaledVector(step,reach/Math.max(moved,1e-12)).normalize();
        draw(1-current,ahead,position,now);blending=true;weight=0;
        if(spread>1){parts=spread;part=0;deal(spread);sun.userData.shadowPart=0;}
        publish();return true;
      }
      publish();return false;
    },
  };
}
