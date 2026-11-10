/** Static solid primitives in world coordinates. Water never enters this index. */
export type SolidCollider = ({kind:'capsule'; ax:number; az:number; bx:number; bz:number; radius:number} |
  {kind:'box'; x:number; z:number; halfX:number; halfZ:number; yaw:number}) & {minY:number; maxY:number; tag?:string;
    /** Visible mesh surface, rather than the conservative collision envelope. */
    surfaceHeight?:(x:number,z:number)=>number|undefined;
    /** Optional exact bark contact supplied by a streamed vegetation batch. */
    barkContact?:(angle:number,y:number)=>{x:number;y:number;z:number}|undefined;
    /** A tree's lowest bough, world y: below it the bole is bare, above it the crown hides whatever is on the trunk. */
    crownBase?:number;
    /** Optional center-line height for articulated/diagonal capsules. */
    heightAt?:(x:number,z:number)=>number|undefined};
export type CharacterPosition = {x:number;y:number;z:number};

export function createCollisionWorld(cellSize=8) {
  const groups=new Map<string,SolidCollider[]>();
  const cells=new Map<string,Set<SolidCollider>>();
  const keysFor=(c:SolidCollider)=>{
    let x0:number,x1:number,z0:number,z1:number;
    if(c.kind==='capsule'){x0=Math.min(c.ax,c.bx)-c.radius;x1=Math.max(c.ax,c.bx)+c.radius;z0=Math.min(c.az,c.bz)-c.radius;z1=Math.max(c.az,c.bz)+c.radius;}
    else {const co=Math.abs(Math.cos(c.yaw)),si=Math.abs(Math.sin(c.yaw)),rx=co*c.halfX+si*c.halfZ,rz=si*c.halfX+co*c.halfZ;x0=c.x-rx;x1=c.x+rx;z0=c.z-rz;z1=c.z+rz;}
    const keys:string[]=[];for(let z=Math.floor(z0/cellSize);z<=Math.floor(z1/cellSize);z++)for(let x=Math.floor(x0/cellSize);x<=Math.floor(x1/cellSize);x++)keys.push(`${x},${z}`);return keys;
  };
  return {
    replace(name:string,colliders:SolidCollider[]){
      for(const c of groups.get(name)??[])for(const key of keysFor(c)){const bucket=cells.get(key);bucket?.delete(c);if(!bucket?.size)cells.delete(key);}
      groups.set(name,colliders.slice());
      for(const c of colliders)for(const key of keysFor(c)){let bucket=cells.get(key);if(!bucket){bucket=new Set();cells.set(key,bucket);}bucket.add(c);}
    },
    nearby(x:number,z:number,radius=.45){const result=new Set<SolidCollider>();for(let iz=Math.floor((z-radius)/cellSize);iz<=Math.floor((z+radius)/cellSize);iz++)for(let ix=Math.floor((x-radius)/cellSize);ix<=Math.floor((x+radius)/cellSize);ix++)for(const c of cells.get(`${ix},${iz}`)??[])result.add(c);return [...result];},
    stats(){let solids=0;for(const g of groups.values())solids+=g.length;return {solids,cells:cells.size};},
  };
}

/** Signed horizontal clearance and outward normal for a vertical character capsule. */
export function solidContact(c:SolidCollider,x:number,z:number,radius:number){
  if(c.kind==='capsule'){
    const sx=c.bx-c.ax,sz=c.bz-c.az,l=sx*sx+sz*sz,t=l>0?Math.max(0,Math.min(1,((x-c.ax)*sx+(z-c.az)*sz)/l)):0;
    const dx=x-c.ax-sx*t,dz=z-c.az-sz*t,d=Math.hypot(dx,dz);
    return {depth:c.radius+radius-d,nx:d>1e-9?dx/d:l>0?-sz/Math.sqrt(l):1,nz:d>1e-9?dz/d:l>0?sx/Math.sqrt(l):0};
  }
  const co=Math.cos(c.yaw),si=Math.sin(c.yaw),dx=x-c.x,dz=z-c.z,lx=dx*co-dz*si,lz=dx*si+dz*co;
  const qx=Math.max(-c.halfX,Math.min(c.halfX,lx)),qz=Math.max(-c.halfZ,Math.min(c.halfZ,lz));
  const ox=lx-qx,oz=lz-qz,d=Math.hypot(ox,oz);let nx:number,nz:number,depth:number;
  if(d>1e-9){nx=ox/d;nz=oz/d;depth=radius-d;}
  else if(c.halfX-Math.abs(lx)<c.halfZ-Math.abs(lz)){nx=lx>=0?1:-1;nz=0;depth=radius+c.halfX-Math.abs(lx);}
  else{nx=0;nz=lz>=0?1:-1;depth=radius+c.halfZ-Math.abs(lz);}
  return {depth,nx:nx*co+nz*si,nz:-nx*si+nz*co};
}

/** Highest reachable visible support. A bridge deck is a layer above the
 * channel, never an unconditional terrain height: feet below it stay below. */
export function characterSupportAt(x:number,z:number,referenceY:number,terrain:(x:number,z:number)=>number,
  world:Pick<ReturnType<typeof createCollisionWorld>,'nearby'>,radius=.16,maxStep=.28){
  let support=terrain(x,z);
  for(const c of world.nearby(x,z,radius)){
    // A moving creature is never a support layer.  Trees, rocks, logs and
    // bridge decks retain their physical support semantics below.
    if(c.tag?.startsWith('creature'))continue;
    if(solidContact(c,x,z,radius).depth<=0)continue;
    let top=c.surfaceHeight?c.surfaceHeight(x,z):c.maxY;
    if(top===undefined&&c.surfaceHeight){
      // A finite sole may straddle a missing board. Every sample must hit a
      // real neighbouring mesh; this adds no invisible deck across the opening.
      for(let i=0;i<8;i++){const angle=i*Math.PI/4,sample=c.surfaceHeight(x+Math.cos(angle)*radius*.96,z+Math.sin(angle)*radius*.96);if(sample!==undefined&&sample<=referenceY+maxStep)top=Math.max(top??-Infinity,sample);}
    }
    if(top===undefined||top>referenceY+maxStep||top<=support)continue;
    support=top;
  }
  return support;
}

/** Substeps prevent tunnelling through thin posts. Ground/bridge selection
 * follows the character's current layer, permitting real underpasses. */
export function moveCharacter(position:CharacterPosition,dx:number,dz:number,height:number,
  terrain:(x:number,z:number)=>number,world:ReturnType<typeof createCollisionWorld>,radius=.24){
  const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.10));let x=position.x,z=position.z,y=position.y;
  for(let step=0;step<steps;step++){
    const oldX=x,oldZ=z,oldY=Math.max(y,terrain(x,z));let sx=dx/steps,sz=dz/steps;
    const ground=(px:number,pz:number)=>characterSupportAt(px,pz,oldY,terrain,world,radius*.90);
    // The deck's actual slope is used while on it; the channel below must not
    // block walking across a bridge with an unrelated steep riverbank normal.
    const elevated=oldY-terrain(x,z)>.35;
    const slopeSample=(px:number,pz:number)=>{const sample=ground(px,pz);return elevated&&oldY-sample>.35?oldY:sample;};
    const gx=(slopeSample(x+.35,z)-slopeSample(x-.35,z))/.7,gz=(slopeSample(x,z+.35)-slopeSample(x,z-.35))/.7;
    const gradient=Math.hypot(gx,gz),uphill=sx*gx+sz*gz;
    if(gradient>.95&&uphill>0){sx-=gx*uphill/(gradient*gradient);sz-=gz*uphill/(gradient*gradient);}
    x+=sx;z+=sz;
    if(ground(x,z)-ground(oldX,oldZ)>.38){x=oldX;z=oldZ;}
    for(let iteration=0;iteration<3;iteration++){
      let moved=false;
      for(const c of world.nearby(x,z,radius+.1)){
        if(c.minY>oldY+height+.025||c.maxY<oldY-.12)continue;
        const centerY=c.heightAt?.(x,z),verticalRadius=c.kind==='capsule'?c.radius:Math.max(c.halfX,c.halfZ);
        if(centerY!==undefined&&(centerY-verticalRadius>oldY+height+.025||centerY+verticalRadius<oldY-.12))continue;
        const contact=solidContact(c,x,z,radius);if(contact.depth<=0)continue;
        const top=c.surfaceHeight?.(x,z)??c.maxY;
        if(top<=oldY+.28)continue;
        x+=contact.nx*(contact.depth+.001);z+=contact.nz*(contact.depth+.001);moved=true;
      }
      if(!moved)break;
    }
    y=characterSupportAt(x,z,oldY,terrain,world,radius*.90);
  }
  return {x,y,z};
}
