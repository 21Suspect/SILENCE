"""Original SILENCE creature: continuous voxel sculpt, weighted rig and baked skin.
Run with Blender 5.x in background mode. No third-party model content.
"""
import bpy, bmesh, math, json, os, random
from mathutils import Vector, Quaternion
from mathutils.noise import noise_vector
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'../..'))
OUT=os.path.join(ROOT,'public/creature');SOURCE=os.path.join(ROOT,'assets/creature');os.makedirs(OUT,exist_ok=True);os.makedirs(SOURCE,exist_ok=True)
random.seed(192821)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
def B(p):return Vector((p[0],-p[2],p[1]))
def W(p):return [p.x,p.z,-p.y]
parts=[];cuts=[];bones=[];toothCenters=[]
def mesh(name,vertices,faces):
    data=bpy.data.meshes.new(name);data.from_pydata(vertices,[],faces);data.update();ob=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(ob);parts.append(ob);return ob

def cat(values,t):
    k=min(len(values)-2,int(t*(len(values)-1)));f=t*(len(values)-1)-k
    a,b,c,d=values[max(0,k-1)],values[k],values[k+1],values[min(len(values)-1,k+2)]
    return (b*2+(c-a)*f+(a*2-b*5+c*4-d)*f*f+(-a+b*3-c*3+d)*f*f*f)*.5

def loft(name,points,radii,aspect=1.,rings=40,sides=18,seed=1,texture=True):
    points=[B(p) for p in points];vertices=[];faces=[]
    for j in range(rings+1):
        t=j/rings;p=cat(points,t);derivative=cat(points,min(1,t+.002))-cat(points,max(0,t-.002));derivative.normalize()
        n=derivative.cross(Vector((0,0,1)))
        if n.length<.01:n=derivative.cross(Vector((0,1,0)))
        n.normalize();v=derivative.cross(n).normalized();r=cat(radii,t)
        for i in range(sides):
            a=i/sides*math.tau
            # Long uneven tendon planes, skin creases and sinews are baked into
            # the actual silhouette before union; no cylindrical pieces remain.
            ridge=1+.12*math.cos(a*3+seed*.4)+.06*math.sin(a*5+t*19+seed)
            fold=1+(.05*math.sin(t*53+math.cos(a)*2)+.025*math.sin(t*107+a*4)) if texture else 1
            vertices.append(p+n*(math.cos(a)*r*ridge*fold)+v*(math.sin(a)*r*aspect*ridge*fold))
    for j in range(rings):
        for i in range(sides):
            a=j*sides+i;b=j*sides+(i+1)%sides;c=(j+1)*sides+(i+1)%sides;d=(j+1)*sides+i;faces.append((a,b,c,d))
    faces.append(tuple(reversed(range(sides))));faces.append(tuple(rings*sides+i for i in range(sides)))
    return mesh(name,vertices,faces)

def organ(name,center,scale,seed=0,rib=False):
    vertices=[];faces=[];lat=36;lon=56
    for j in range(lat+1):
        t=j/lat*math.pi
        for i in range(lon):
            a=i/lon*math.tau;x=math.sin(t)*math.cos(a);y=math.cos(t);z=math.sin(t)*math.sin(a)
            # Human rib contours are one wrinkled skin surface, not stacked rings.
            contour=1+.025*math.sin(x*9+y*7+z*13+seed)+.018*math.sin(x*29-y*18+z*14)
            if rib:contour+=.065*math.cos((z+1)*22)*max(0,abs(x)-.2)*max(0,1-y*y)
            p=(center[0]+x*scale[0]*contour,center[1]+y*scale[1]*contour,center[2]+z*scale[2]*contour)
            vertices.append(B(p))
    for j in range(lat):
        for i in range(lon):faces.append((j*lon+i,j*lon+(i+1)%lon,(j+1)*lon+(i+1)%lon,(j+1)*lon+i))
    return mesh(name,vertices,faces)

def bone(name,a,b,parent=None):bones.append({'name':name,'a':list(a),'b':list(b),'parent':parent})
# Anatomical bind pose matches the existing six-foot IK geometry.
bone('spine',[0,1.82,-.6],[0,1.85,.45])
organ('Ribcage',[0,1.85,-.04],[.38,.29,.69],7,True)
organ('Wasted abdomen',[0,1.78,-.62],[.235,.19,.37],8)
organ('Shoulder girdle',[0,1.89,.4],[.39,.21,.28],3)
# Raised scapula ridges taper into fascia and join the continuous remeshed body.
for side in [-1,1]:
    loft('Scapula',[[side*.06,2.02,-.55],[side*.25,2.12,-.25],[side*.35,2.05,.24],[side*.20,1.92,.50]],[.025,.075,.105,.04],.42,36,16,4)
    loft('Neck sinew',[[side*.21,1.98,.40],[side*.13,1.67,.66],[side*.07,1.44,.82]],[.06,.04,.035],.7,32,12,9)
loft('Neck',[[0,1.9,.40],[0,1.76,.61],[0,1.47,.72],[0,1.31,.80]],[.15,.14,.11,.12],.9,45,24,3)
# A deformed facial loft has cheek hollows, jaw planes, brows and nose. The face
# points forward (+Z), and hangs below the thorax.
head=[];faces=[];N=64;M=48
for j in range(M+1):
    t=j/M;yy=.84+t*.79
    # Chin, jaw, cheekbone, temple, cranium.
    w=cat([.045,.115,.175,.205,.215,.175,.014],t)
    depth=cat([.07,.095,.14,.19,.20,.17,.014],t)
    for i in range(N):
        a=i/N*math.tau;x=math.sin(a)*w;z=.80+math.cos(a)*depth
        front=max(0,math.cos(a))**8
        cheek=math.exp(-((t-.42)/.16)**2)*math.exp(-((abs(math.sin(a))-.6)/.22)**2)
        z+=front*(.035*math.exp(-((t-.58)/.18)**2)-.024*math.exp(-((t-.22)/.08)**2))
        x*=1+.16*cheek
        z+=.008*math.sin(t*57+a*5)*front
        head.append(B((x,yy,z)))
for j in range(M):
    for i in range(N):faces.append((j*N+i,j*N+(i+1)%N,(j+1)*N+(i+1)%N,(j+1)*N+i))
faces.extend([tuple(reversed(range(N))),tuple(M*N+i for i in range(N))]);mesh('Hanging human face',head,faces)
# Bridge and septum project from the face and fuse during remeshing.
loft('Nose bridge',[[0,1.44,.94],[.006,1.35,.994],[.008,1.27,1.015],[0,1.23,.978]],[.033,.035,.041,.025],.65,25,16,2)
for side in [-1,1]:
    loft('Brow',[[side*.025,1.48,.986],[side*.106,1.49,1.0],[side*.186,1.45,.965]],[.027,.035,.018],.7,25,12,3)
    loft('Sunken cheekbone',[[side*.20,1.37,.96],[side*.19,1.25,.99],[side*.13,1.06,.94]],[.031,.029,.015],.6,25,12,7)
# Human arms underneath the thorax: sagging elbows, wrists, palms, four unequal digits.
for side in [-1,1]:
    label='L' if side<0 else 'R';a=[side*.27,1.85,.35];el=[side*.43,1.12,.30];wr=[side*.29,.66,.65];tip=[side*.28,.50,.68]
    bone('arm_'+label,a,el,'spine');bone('hand_'+label,el,tip,'arm_'+label)
    loft('Vestigial arm', [a,[side*.42,1.48,.26],el,[side*.33,.86,.51],wr,tip],[.102,.064,.062,.042,.035,.055],.67,70,20,6)
    for finger in range(4):
        x=side*.28+(finger-1.5)*.031;start=[x,.52,.68];end=[x+side*.018,.28-math.sin(finger)*.04,.76]
        loft('Long fingers',[start,[(start[0]+end[0])*.5,.38,.73],end],[.019,.013,.005],.65,18,10,finger)
legs=[]
def solve(start,end,pole,upper,lower):
    s=Vector(start);e=Vector(end);axis=e-s;d=axis.length;axis.normalize();bend=Vector(pole)-s;bend-=axis*bend.dot(axis);bend.normalize()
    along=(upper*upper-lower*lower+d*d)/(2*d);h=math.sqrt(max(0,upper*upper-along*along));return list(s+axis*along+bend*h)
for side in [-1,1]:
    for i in range(3):
        label=('L' if side<0 else 'R')+str(i)
        base=[side*.25,1.88,.38-i*.52];shoulder=[side*(.85+i*.1),2.43+(.38 if i==1 else 0),.8-i*.85];foot=[side*(2.22+i*.16),.035,1.85-i*1.8]
        knee=solve(shoulder,foot,[side*3,4.6,foot[2]*.5],1.5,3.1);toe=[foot[0]+side*.10,.017,foot[2]+.13]
        bone('hip_'+label,base,shoulder,'spine');bone('upper_'+label,shoulder,knee,'hip_'+label);bone('lower_'+label,knee,foot,'upper_'+label);bone('toe_'+label,foot,toe,'lower_'+label)
        # Each limb is one continuous sculpted path with a swept elbow. Wide,
        # blade-like shins and asymmetrical tendons break the stick-figure look.
        def lerp(a,b,t):return list(Vector(a).lerp(Vector(b),t))
        p=[base,lerp(base,shoulder,.42),shoulder,lerp(shoulder,knee,.42),knee,lerp(knee,foot,.20),lerp(knee,foot,.55),lerp(knee,foot,.84),foot,toe]
        r=[.15,.17,.115,.107,.126,.10,.067,.038,.022,.006]
        loft('Continuous leg '+label,p,r,.58,130,22,23+i*7+side)
        # Raised longitudinal fascia joins the main surface; these are fused
        # rather than separately shaded cylinder tendons.
        off=Vector([side*.025,.018,.025]);p2=[list(Vector(v)+off) for v in [shoulder,lerp(shoulder,knee,.5),knee,lerp(knee,foot,.48),lerp(knee,foot,.8)]]
        loft('Fascia '+label,p2,[.035,.038,.042,.025,.006],.65,60,12,7)
        spur=[knee[0]+side*.14,knee[1]+.26,knee[2]-.08]
        loft('Elbow spur',[lerp(shoulder,knee,.85),knee,spur],[.052,.07,.004],.5,24,14,9)
        # Splintered bony crests sweep backwards from the elbows and shins.
        # Unequal spacing, bent tips and torn tendrils make each limb distinct.
        for j in range(6+i%2):
            t=.05+j*.13;anchor=Vector(lerp(knee,foot,t));length=random.uniform(.13,.34)*(1-t*.65)
            tip=anchor+Vector((side*length,random.uniform(.11,.29),random.uniform(-.17,.08)))
            mid=anchor.lerp(tip,.52)+Vector((0,.035,.035))
            loft('Shin splinter '+label,[list(anchor),list(mid),list(tip)],[.048*(1-t*.5),.025,.0018],.48,17,12,30+j+i)
        for j in range(7):
            t=.12+j*.13;anchor=Vector(lerp(shoulder,knee,t));tip=anchor+Vector((side*random.uniform(.03,.18),random.uniform(.16,.36),-.13))
            loft('Raking upper crest',[list(anchor),list(anchor.lerp(tip,.63)+Vector((0,.02,.02))),list(tip)],[.052,.026,.002],.42,19,12,j+9)
        for j in range(3):
            anchor=Vector(lerp(shoulder,knee,.30+j*.25));anchor.y-=.02
            end=anchor+Vector((side*random.uniform(-.08,.10),-random.uniform(.16,.46),random.uniform(-.06,.10)))
            loft('Hanging torn fascia',[list(anchor),list(anchor.lerp(end,.5)+Vector((.03,-.03,.025))),list(end)],[.034,.013,.002],.40,22,12,j+13)
        for j in range(2):
            anchor=Vector(lerp(knee,foot,.58+j*.17));end=anchor+Vector((side*.08,-random.uniform(.18,.31),.09))
            loft('Torn ankle sheath',[list(anchor),list(anchor.lerp(end,.55)+Vector((side*.025,0,.025))),list(end)],[.035,.017,.002],.45,20,12,j+5)
        legs.append({'name':label,'base':base,'shoulder':shoulder,'rest':foot,'knee':knee,'toe':toe,'side':side,'index':i})
# Broken vertebrae and shoulder spurs emerging through the dorsal skin.
for j in range(11):
    z=-.73+j*.115;x=random.uniform(-.055,.055);a=[x,2.02,z];tip=[x+random.uniform(-.055,.055),2.14+random.uniform(.05,.20),z-.08]
    loft('Dorsal vertebral spine',[a,[x,2.12,z-.025],tip],[.063,.042,.002],.7,20,12,j+35)
# Union everything to a single connected skin surface; then preserve detail with
# a controlled triangle budget and baked micro-normal map.
bpy.ops.object.select_all(action='DESELECT')
for o in parts:o.select_set(True)
bpy.context.view_layer.objects.active=parts[0];bpy.ops.object.join();skin=bpy.context.object;skin.name='SILENCE continuous sculpt'
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
remesh=skin.modifiers.new('Unified living tissue','REMESH');remesh.mode='VOXEL';remesh.voxel_size=.010;remesh.use_smooth_shade=True;bpy.ops.object.modifier_apply(modifier=remesh.name)
smooth=skin.modifiers.new('Skin relaxation','SMOOTH');smooth.factor=.46;smooth.iterations=3;bpy.ops.object.modifier_apply(modifier=smooth.name)
# Eye sockets and a compressed mouth are actual recesses in the face.
for name,center,scale in [('eyeL',[-.103,1.405,1.0],[.067,.052,.075]),('eyeR',[.103,1.405,1.0],[.067,.052,.075]),('mouth',[0,1.10,.991],[.125,.215,.145])]:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=16,location=B(center));cutter=bpy.context.object;cutter.scale=(scale[0],scale[2],scale[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    bpy.context.view_layer.objects.active=skin;mod=skin.modifiers.new(name,'BOOLEAN');mod.operation='DIFFERENCE';mod.solver='EXACT';mod.object=cutter;bpy.ops.object.modifier_apply(modifier=mod.name);bpy.data.objects.remove(cutter,do_unlink=True)
# Teeth grow from the lip rim around a genuinely recessed mouth; their roots
# are unioned to the face, so the jaw never reads as a separate attached prop.
parts=[]
for row in [-1,1]:
    for j in range(7):
        x=(j-3)*.030+random.uniform(-.004,.004);z=.926+random.uniform(-.005,.005)
        # Roots sit on the actual carved rim; pointed tips curve out of the maw.
        y=1.10+row*(.223*math.sqrt(max(.12,1-(x/.125)**2-((z-.991)/.145)**2)))
        length=.047+random.random()*.063
        anchor=[x,y,z];tip=[x*.90,y-row*length,z+.068]
        loft('Irregular tooth',[anchor,[x,y-row*length*.42,z+.052],tip],[.015,.011,.0015],.60,18,12,j+row,False)
        toothCenters.append([x,y-row*length*.43,z+.052])
# Join a few root-thread strands underneath the mandible.
for j in range(5):
    x=(j-2)*.043
    loft('Mandible root thread',[[x,.90,.81],[x+.018,.75,.83],[x-.01,.58+random.random()*.13,.84]],[.026,.012,.0015],.5,22,12,j+11)
bpy.ops.object.select_all(action='DESELECT');skin.select_set(True)
for ob in parts:ob.select_set(True)
bpy.context.view_layer.objects.active=skin;bpy.ops.object.join()
remesh=skin.modifiers.new('Fused enamel and torn skin','REMESH');remesh.mode='VOXEL';remesh.voxel_size=.0065;remesh.use_smooth_shade=True;bpy.ops.object.modifier_apply(modifier=remesh.name)
# Mild sculpt noise creates nonuniform tendons and pores in the silhouette.
tex=bpy.data.textures.new('Tissue irregularity',type='CLOUDS');tex.noise_scale=.09;tex.noise_depth=2
mod=skin.modifiers.new('Sculpted asymmetry','DISPLACE');mod.texture=tex;mod.strength=.011;mod.mid_level=.5;bpy.context.view_layer.objects.active=skin;bpy.ops.object.modifier_apply(modifier=mod.name)
mod=skin.modifiers.new('Runtime topology','DECIMATE');mod.ratio=min(1,34000/max(1,len(skin.data.polygons)));bpy.ops.object.modifier_apply(modifier=mod.name)
# Delete only sub-voxel debris, weld duplicate vertices and close numerical holes.
bm=bmesh.new();bm.from_mesh(skin.data);seen=set();islands=[]
for v in bm.verts:
    if v in seen:continue
    stack=[v];seen.add(v);island=[]
    while stack:
        q=stack.pop();island.append(q)
        for edge in q.link_edges:
            n=edge.other_vert(q)
            if n not in seen:seen.add(n);stack.append(n)
    islands.append(island)
for island in islands:
    if len(island)<150:bmesh.ops.delete(bm,geom=island,context='VERTS')
bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00005)
boundaries=[e for e in bm.edges if e.is_boundary]
if boundaries:bmesh.ops.holes_fill(bm,edges=boundaries,sides=0)
# A few decimated quads fold around an existing diagonal edge. glTF's implicit
# triangulation would make that edge non-manifold; fan only those tiny patches.
folded=[f for f in bm.faces if len(f.verts)==4 and (bm.edges.get((f.verts[0],f.verts[2])) or bm.edges.get((f.verts[1],f.verts[3])))]
if folded:bmesh.ops.poke(bm,faces=folded)
bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(skin.data);bm.free();skin.data.validate(verbose=True);skin.data.update()
for p in skin.data.polygons:p.use_smooth=True
# UV atlas for game-ready baked PBR maps.
bpy.ops.object.select_all(action='DESELECT');skin.select_set(True);bpy.context.view_layer.objects.active=skin;bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project(angle_limit=1.05,island_margin=.008);bpy.ops.object.mode_set(mode='OBJECT')
# Surface anatomy colors: exposed ivory ridges, warm sinews and deep gray rot
# occupy different regions instead of tinting the entire creature brown.
attribute=skin.data.color_attributes.new(name='Anatomy',type='FLOAT_COLOR',domain='POINT')
boneColor=Vector((.42,.39,.29));rotColor=Vector((.025,.033,.027));tissueColor=Vector((.19,.061,.042))
for vertex in skin.data.vertices:
    x,y,z=W(vertex.co);n=noise_vector(Vector((x*3.4,y*5.1,z*4.8)));macro=n.x*.5+.5
    exposed=max(0,min(1,(macro-.26)*1.85))
    # Light ridges and dark valleys alternate along stretched limb anatomy.
    band=.5+.5*math.sin(y*8.3+x*2.2+z*3.1+n.y*3)
    if abs(x)>.7:exposed=max(exposed*.55,band*.7)
    color=rotColor.lerp(boneColor,exposed)
    tendon=max(0,min(1,(n.z-.15)*2.0))
    color=color.lerp(tissueColor,tendon*.77)
    # The long upper limbs expose lengthwise tendon strips below a pale crest.
    # This is tied to anatomy, not a uniform noise layer sprayed over the model.
    if abs(x)>.62 and y>2.06:
        pp=Vector((x,y,z));best=99;radial=None;along=0
        for leg in legs:
            aa=Vector(leg['shoulder']);bb=Vector(leg['knee']);dd=bb-aa;t=max(0,min(1,(pp-aa).dot(dd)/dd.length_squared));rr=pp-aa-dd*t
            if rr.length<best:best=rr.length;radial=rr;along=t
        if radial is not None and best<.24:
            ridge=max(0,min(1,(radial.y+.018)*11))
            flesh=max(0,min(1,(radial.z-.008)*15))*(.55+.45*macro)
            color=color.lerp(boneColor,ridge*.82)
            color=color.lerp(tissueColor,flesh*.85)
    if abs(x)<.42 and y>1.93:
        color=color.lerp(boneColor,(.30+.45*macro)*min(1,(y-1.93)*5))
    if abs(x)<.23 and z>.80 and y<1.62:
        color=rotColor.lerp(boneColor,.45+macro*.42)
        # Mouth floor and recessed eye sockets remain dark, not beige enamel.
        cavity=max(0,1-((x/.17)**2+((y-1.12)/.20)**2)) if z<.965 else 0
        color=color.lerp(Vector((.034,.011,.009)),cavity*.90)
    if any((Vector((x,y,z))-Vector(t)).length<.026 for t in toothCenters):color=Vector((.62,.55,.36))
    attribute.data[vertex.index].color=(*color,1)
material=bpy.data.materials.new('Weathered bone, torn tendon and mottled skin');material.use_nodes=True;skin.data.materials.clear();skin.data.materials.append(material)
nodes=material.node_tree.nodes;links=material.node_tree.links;nodes.clear()
out=nodes.new('ShaderNodeOutputMaterial');bsdf=nodes.new('ShaderNodeBsdfPrincipled');links.new(bsdf.outputs['BSDF'],out.inputs['Surface'])
coord=nodes.new('ShaderNodeTexCoord');anatomy=nodes.new('ShaderNodeVertexColor');anatomy.layer_name='Anatomy'
noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=36;noise.inputs['Detail'].default_value=5;noise.inputs['Roughness'].default_value=.78;links.new(coord.outputs['Object'],noise.inputs['Vector'])
ramp=nodes.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].position=.29;ramp.color_ramp.elements[0].color=(.13,.15,.12,1);ramp.color_ramp.elements[1].position=.72;ramp.color_ramp.elements[1].color=(.92,.90,.79,1);links.new(noise.outputs['Fac'],ramp.inputs['Fac'])
colorMix=nodes.new('ShaderNodeMixRGB');colorMix.blend_type='MULTIPLY';colorMix.inputs[0].default_value=.70;links.new(anatomy.outputs['Color'],colorMix.inputs[1]);links.new(ramp.outputs['Color'],colorMix.inputs[2]);links.new(colorMix.outputs['Color'],bsdf.inputs['Base Color'])
rough=nodes.new('ShaderNodeMapRange');rough.inputs['From Min'].default_value=.18;rough.inputs['From Max'].default_value=.82;rough.inputs['To Min'].default_value=.39;rough.inputs['To Max'].default_value=.93;links.new(noise.outputs['Fac'],rough.inputs['Value']);links.new(rough.outputs['Result'],bsdf.inputs['Roughness'])
fine=nodes.new('ShaderNodeTexNoise');fine.inputs['Scale'].default_value=180;fine.inputs['Detail'].default_value=3;links.new(coord.outputs['Object'],fine.inputs['Vector'])
wave=nodes.new('ShaderNodeTexWave');wave.wave_type='BANDS';wave.bands_direction='Z';wave.inputs['Scale'].default_value=38;wave.inputs['Distortion'].default_value=7;wave.inputs['Detail'].default_value=4;links.new(coord.outputs['Object'],wave.inputs['Vector'])
crease=nodes.new('ShaderNodeMixRGB');crease.blend_type='MULTIPLY';crease.inputs[0].default_value=.45;links.new(wave.outputs['Color'],crease.inputs[1]);links.new(fine.outputs['Fac'],crease.inputs[2])
bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.42;bump.inputs['Distance'].default_value=.022;links.new(crease.outputs['Color'],bump.inputs['Height']);links.new(bump.outputs['Normal'],bsdf.inputs['Normal'])
# Bake diffuse through emission: independent of scene lights and consistent on all surfaces.
bpy.context.scene.render.engine='CYCLES';bpy.context.scene.cycles.samples=8;bpy.context.scene.render.bake.margin=12
image=bpy.data.images.new('creature-skin',width=2048,height=2048,alpha=False);image.filepath_raw=os.path.join(SOURCE,'skin-color.png');image.file_format='PNG'
target=nodes.new('ShaderNodeTexImage');target.image=image;nodes.active=target
emit=nodes.new('ShaderNodeEmission');ao=nodes.new('ShaderNodeAmbientOcclusion');ao.inputs['Distance'].default_value=.28;ao.samples=32;mix=nodes.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=.88;links.new(colorMix.outputs['Color'],mix.inputs[1]);links.new(ao.outputs['Color'],mix.inputs[2]);links.new(mix.outputs['Color'],emit.inputs['Color']);links.new(emit.outputs[0],out.inputs['Surface']);bpy.ops.object.bake(type='EMIT');image.save();links.new(bsdf.outputs['BSDF'],out.inputs['Surface']);nodes.remove(emit)
normal=bpy.data.images.new('creature-normal',width=2048,height=2048,alpha=False);normal.colorspace_settings.name='Non-Color';normal.filepath_raw=os.path.join(SOURCE,'skin-normal.png');normal.file_format='PNG';target.image=normal;bpy.ops.object.bake(type='NORMAL');normal.save()
roughness=bpy.data.images.new('creature-roughness',width=1024,height=1024,alpha=False);roughness.colorspace_settings.name='Non-Color';roughness.filepath_raw=os.path.join(SOURCE,'skin-roughness.png');roughness.file_format='PNG';target.image=roughness
emit=nodes.new('ShaderNodeEmission');links.new(rough.outputs['Result'],emit.inputs['Color']);links.new(emit.outputs[0],out.inputs['Surface']);bpy.ops.object.bake(type='EMIT');roughness.save()
# Replace authoring graph by the actual two-texture PBR material used in GLB.
nodes.clear();out=nodes.new('ShaderNodeOutputMaterial');bsdf=nodes.new('ShaderNodeBsdfPrincipled');links.new(bsdf.outputs['BSDF'],out.inputs['Surface']);bsdf.inputs['Roughness'].default_value=.79
colorNode=nodes.new('ShaderNodeTexImage');colorNode.image=image;links.new(colorNode.outputs['Color'],bsdf.inputs['Base Color']);normalNode=nodes.new('ShaderNodeTexImage');normalNode.image=normal;nmap=nodes.new('ShaderNodeNormalMap');nmap.inputs['Strength'].default_value=.65;links.new(normalNode.outputs['Color'],nmap.inputs['Color']);links.new(nmap.outputs['Normal'],bsdf.inputs['Normal']);roughNode=nodes.new('ShaderNodeTexImage');roughNode.image=roughness;links.new(roughNode.outputs['Color'],bsdf.inputs['Roughness'])
# Surface-derived armature weights. Nearby joint influences blend smoothly;
# the foot tip stays rigidly attached to the actual IK contact bone.
arm=bpy.data.armatures.new('SILENCE anatomy');rig=bpy.data.objects.new('CreatureRig',arm);bpy.context.collection.objects.link(rig);bpy.context.view_layer.objects.active=rig;skin.select_set(False);rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
for b in bones:
    e=arm.edit_bones.new(b['name']);e.head=B(b['a']);e.tail=B(b['b']);
    if b['parent']:e.parent=arm.edit_bones[b['parent']]
bpy.ops.object.mode_set(mode='OBJECT')
segments=[(b['name'],B(b['a']),B(b['b'])) for b in bones]
groups={name:skin.vertex_groups.new(name=name) for name,a,b in segments}
def segment_distance(p,a,b):
    d=b-a;t=max(0,min(1,(p-a).dot(d)/max(d.length_squared,1e-8)));return (p-a-d*t).length
for vertex in skin.data.vertices:
    p=vertex.co;wp=W(p);dist=[]
    for name,a,b in segments:
        d=segment_distance(p,a,b)
        # Keep the thorax/head anchored; limb weights become dominant only beyond
        # their attachment, preventing nearby folded legs deforming the face.
        if name.startswith(('hip','upper','lower','toe')) and abs(wp[0])<.37:d+=.32
        if name.startswith('arm') and wp[1]>1.65:d+=.25
        dist.append((d,name))
    dist.sort();chosen=dist[:4];weights=[math.exp(-(d-chosen[0][0])*30) for d,name in chosen];total=sum(weights)
    for (d,name),w in zip(chosen,weights):
        if w/total>.004:groups[name].add([vertex.index],w/total,'REPLACE')
# Head bone is separate from the spine, with a smooth neck transition.
bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='EDIT');e=arm.edit_bones.new('head');e.head=B([0,1.66,.67]);e.tail=B([0,1.1,.85]);e.parent=arm.edit_bones['spine'];bpy.ops.object.mode_set(mode='OBJECT')
hg=skin.vertex_groups.new(name='head')
for v in skin.data.vertices:
    x,y,z=W(v.co)
    if z>.63 and abs(x)<.22 and y<1.67:
        weight=max(0,min(1,(1.67-y)/.20))
        for group_index in [g.group for g in v.groups]:skin.vertex_groups[group_index].remove([v.index])
        hg.add([v.index],weight,'REPLACE');groups['spine'].add([v.index],1-weight,'REPLACE')
# The contact toe is rigidly weighted: torso breathing or knee motion cannot
# slide the skin's actual planted point. Blend only above the contact region.
for leg in legs:
    foot=Vector(leg['rest']);group=groups['toe_'+leg['name']]
    for vertex in skin.data.vertices:
        p=Vector(W(vertex.co));distance=(p-foot).length
        if distance<.20:
            for group_index in [g.group for g in vertex.groups]:skin.vertex_groups[group_index].remove([vertex.index])
            group.add([vertex.index],1.0,'REPLACE')
mod=skin.modifiers.new('Living skeleton','ARMATURE');mod.object=rig;skin.parent=rig
bones.append({'name':'head','a':[0,1.66,.67],'b':[0,1.1,.85],'parent':'spine'})
# Two small deep-set eyes are a restrained cold ivory emissive material.
# Same skin skeleton; no dynamic point lights or additional shadow passes.
eyeParts=[]
for side in [-1,1]:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20,ring_count=12,location=B([side*.103,1.405,.995]))
    eye=bpy.context.object;eye.name='Cold ivory eye';eye.scale=(.025,.020,.022);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);eyeParts.append(eye)
bpy.ops.object.select_all(action='DESELECT')
for eye in eyeParts:eye.select_set(True)
bpy.context.view_layer.objects.active=eyeParts[0];bpy.ops.object.join();eyes=bpy.context.object;eyes.name='Deep-set luminous eyes';bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
em=bpy.data.materials.new('Cold ivory eyes');em.use_nodes=True;eb=em.node_tree.nodes.get('Principled BSDF');eb.inputs['Base Color'].default_value=(.65,.72,.66,1);eb.inputs['Emission Color'].default_value=(.58,.72,.67,1);eb.inputs['Emission Strength'].default_value=2.4;eb.inputs['Roughness'].default_value=.24;eyes.data.materials.clear();eyes.data.materials.append(em)
for poly in eyes.data.polygons:poly.use_smooth=True
g=eyes.vertex_groups.new(name='head');g.add(list(range(len(eyes.data.vertices))),1,'REPLACE');mod=eyes.modifiers.new('Head attachment','ARMATURE');mod.object=rig;eyes.parent=rig
import runpy
runpy.run_path(os.path.join(os.path.dirname(__file__),'articulate-creature.py'))['configure_articulation'](rig,skin,bones)
# Export uses the existing Three.js coordinate convention (Y up, face +Z).
bpy.ops.object.select_all(action='DESELECT');rig.select_set(True);skin.select_set(True);eyes.select_set(True);bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT,'silence-creature.glb'),export_format='GLB',use_selection=True,export_apply=False,export_animations=False,export_yup=True,export_normals=True,export_texcoords=True,export_materials='EXPORT')
with open(os.path.join(SOURCE,'rig.json'),'w') as f:json.dump({'bones':bones,'legs':legs,'triangles':sum(len(p.vertices)-2 for p in skin.data.polygons),'vertices':len(skin.data.vertices)},f,indent=2)
# Save source for reproducibility and future manual sculpt refinement.
image.pack();normal.pack();roughness.pack();bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SOURCE,'silence-creature.blend'))
print('CREATURE_COMPLETE',len(skin.data.vertices),sum(len(p.vertices)-2 for p in skin.data.polygons),flush=True)
