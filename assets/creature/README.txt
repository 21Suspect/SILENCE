SILENCE — The Listener

Original creature model authored for this game in Blender 5.1, guided by the
user's spider-humanoid reference. No third-party model or texture data.

The continuous skin is voxel-remeshed from anatomical lofts and sculpted with
an open recessed mouth, irregular pointed teeth, gaunt cheeks, asymmetric
vertebral/elbow/shin splinters and hanging torn fascia. Anatomical color zones
separate pale bone crests, dark mottled rot and warm exposed tendon strips.
Baked micro-normal and roughness maps vary texture and specularity. Deep-set
cold ivory eyes use a separate emissive surface; no dynamic point lights.

Source: silence-creature.blend (packed images)
Rebuild: /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/assets/sculpt-creature.py
Runtime asset: public/creature/silence-creature.glb
Runtime budget: below 80,000 triangles, two material draws, 50 bones.
Skin maps: 2048 x 2048 baked color/cavity shading and tangent normals,
plus a 1024 x 1024 roughness map.

The foot contact region is rigidly weighted to its toe bone. Runtime toe
orientation is fixed in world space during stance, and the hierarchy uses
unit scales to avoid parent shear. Tests inspect actual GLB toe vertices,
normalized weights, bounded geometry, closed skin surfaces and PBR materials.
The procedural world-space gait supplies hip, knee and foot poses at runtime.

Articulation update: weighted neck, head, jaw, forearms, wrists and two
joints per finger. Rebuild only the rig (retaining mesh/UVs/textures) with:
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/assets/articulate-creature.py
The full sculpt generator calls this same rigging helper before export.
Runtime head direction follows a clamped local attention target, with sparse
listening tilts; jaw breathing and asynchronous grips deform actual skin.
