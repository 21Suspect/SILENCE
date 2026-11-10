"""Add weighted facial/hand articulation to SILENCE's packed sculpt without rebaking.
The full sculpt generator calls configure_articulation before exporting too.
"""
import bpy, math, json, os
from mathutils import Vector
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),'../..'))
def B(p):return Vector((p[0],-p[2],p[1]))
def W(p):return Vector((p.x,p.z,-p.y))
def smooth(v):
    v=max(0.,min(1.,v));return v*v*(3-2*v)
def configure_articulation(rig,skin,bones):
    definitions=[
        {'name':'neck','a':[0,1.89,.44],'b':[0,1.66,.67],'parent':'spine'},
        {'name':'jaw','a':[0,1.225,.815],'b':[0,.935,.90],'parent':'head'},
    ]
    fingers={}
    for side in [-1,1]:
        label='L' if side<0 else 'R';wr=[side*.29,.66,.65];palm=[side*.28,.50,.68]
        definitions.append({'name':'wrist_'+label,'a':wr,'b':palm,'parent':'hand_'+label})
        for i in range(4):
            x=side*.28+(i-1.5)*.031;a=[x,.52,.68];tip=[x+side*.018,.28-math.sin(i)*.04,.76];mid=[(a[0]+tip[0])*.5,.38,.73]
            definitions.extend([
                {'name':f'finger_{label}{i}','a':a,'b':mid,'parent':'wrist_'+label},
                {'name':f'tip_{label}{i}','a':mid,'b':tip,'parent':f'finger_{label}{i}'},
            ])
            fingers[(label,i)]=(Vector(a),Vector(mid),Vector(tip))
    bpy.ops.object.select_all(action='DESELECT');rig.select_set(True);bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='EDIT')
    for d in definitions:
        e=rig.data.edit_bones.get(d['name']) or rig.data.edit_bones.new(d['name']);e.head=B(d['a']);e.tail=B(d['b'])
    for d in definitions:rig.data.edit_bones[d['name']].parent=rig.data.edit_bones[d['parent']]
    rig.data.edit_bones['head'].parent=rig.data.edit_bones['neck']
    for side in [-1,1]:
        label='L' if side<0 else 'R';rig.data.edit_bones['hand_'+label].tail=B([side*.29,.66,.65])
    bpy.ops.object.mode_set(mode='OBJECT')
    groups={n:skin.vertex_groups.get(n) or skin.vertex_groups.new(name=n) for n in ['spine','neck','head','jaw']+[d['name'] for d in definitions]+['hand_L','hand_R']}
    def assign(v,weights):
        pairs=[(n,w) for n,w in weights.items() if w>1e-5];total=sum(w for n,w in pairs)
        for group_index in [g.group for g in v.groups]:skin.vertex_groups[group_index].remove([v.index])
        for n,w in pairs:groups[n].add([v.index],w/total,'REPLACE')
    def distance(p,a,b):
        d=b-a;t=max(0,min(1,(p-a).dot(d)/d.length_squared));return (p-a-d*t).length
    for v in skin.data.vertices:
        p=W(v.co);x,y,z=p
        if abs(x)<.245 and z>.51 and y<1.95:
            neck=smooth((1.94-y)/.22);head=smooth((1.73-y)/.17)
            jaw=smooth((1.19-y)/.15) if z>.73 else 0
            # The upper needles hang down into the mouth: keep them on the skull.
            if z>.946 and y>1.075:jaw=0
            assign(v,{'spine':1-neck,'neck':neck*(1-head),'head':neck*head*(1-jaw),'jaw':neck*head*jaw})
        if .18<abs(x)<.55 and y<.95 and .42<z<.91:
            label='L' if x<0 else 'R';wrist=smooth((.80-y)/.20)
            finger=smooth((.57-y)/.07);which=min(range(4),key=lambda i:min(distance(p,*fingers[(label,i)][:2]),distance(p,*fingers[(label,i)][1:])))
            distal=smooth((.435-y)/.105)
            assign(v,{'hand_'+label:1-wrist,'wrist_'+label:wrist*(1-finger),f'finger_{label}{which}':wrist*finger*(1-distal),f'tip_{label}{which}':wrist*finger*distal})
    # Metadata is regenerated even when this is called on an already patched file.
    byname={d['name']:d for d in bones}
    for d in definitions:byname[d['name']]=d
    byname['head']['parent']='neck'
    for side in [-1,1]:byname['hand_'+('L' if side<0 else 'R')]['b']=[side*.29,.66,.65]
    bones[:]=list(byname.values());rig.data.pose_position='POSE'
    for p in rig.pose.bones:p.rotation_mode='QUATERNION';p.rotation_quaternion=(1,0,0,0)
    return {'bones':len(rig.data.bones),'new_bones':len(definitions)}

if __name__=='__main__':
    path=os.path.join(ROOT,'assets/creature');bpy.ops.wm.open_mainfile(filepath=os.path.join(path,'silence-creature.blend'))
    rig=bpy.data.objects['CreatureRig'];skin=bpy.data.objects['SILENCE continuous sculpt'];meta=json.load(open(os.path.join(path,'rig.json')))
    print('ARTICULATION',configure_articulation(rig,skin,meta['bones']))
    bpy.ops.object.select_all(action='DESELECT')
    for obj in [rig,skin,bpy.data.objects['Deep-set luminous eyes']]:obj.select_set(True)
    bpy.context.view_layer.objects.active=rig
    bpy.ops.export_scene.gltf(filepath=os.path.join(ROOT,'public/creature/silence-creature.glb'),export_format='GLB',use_selection=True,export_apply=False,export_animations=False,export_yup=True,export_normals=True,export_texcoords=True,export_materials='EXPORT')
    with open(os.path.join(path,'rig.json'),'w') as f:json.dump(meta,f,indent=2)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(path,'silence-creature.blend'))
