import * as THREE from 'three';

export type VegetationBatchDefinition = {
  id: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  capacity: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  customDepthMaterial?: THREE.Material;
  customDistanceMaterial?: THREE.Material;
  layer?: number;
  name?: string;
  radius?: number;
  spatial?: boolean;
  sectorSize?: number;
};

export type VegetationBatchHandle = { mesh: THREE.InstancedMesh; index: number };

type Sector = {
  mesh: THREE.InstancedMesh;
  sourceGeometry: THREE.BufferGeometry;
  count: number;
  bounds: THREE.Box3;
  lastUsed: number;
};

type BatchState = { count: number; sx: number; sz: number; sector?: Sector };

/** Keep instance transforms in world space for wind and root deformation.
 * Each mesh has its own bounds for the view, shadow and reflection cameras. */
export function createVegetationBatcher(group: THREE.Group, sectorSize = 192) {
  const sectors = new Map<string, Sector>();
  const states = new Map<VegetationBatchDefinition, BatchState>();
  const point = new THREE.Vector3();
  let generation = 0;

  function createSector(definition: VegetationBatchDefinition) {
    const {geometry: source, material, capacity, name, layer} = definition;
    const size = definition.spatial === false ? capacity : Math.ceil(capacity / 2);
    // R180 releases attribute buffers when their geometry is disposed. Share
    // one geometry for ordinary batches and give custom instance attributes
    // their own geometry so evicting a sector cannot invalidate sibling VAOs.
    const geometry = Object.values(source.attributes).some(attribute => attribute instanceof THREE.InstancedBufferAttribute)
      ? source.clone() : source;
    const mesh = new THREE.InstancedMesh(geometry, material, size);
    mesh.count = 0;
    mesh.name = name ?? '';
    mesh.castShadow = definition.castShadow ?? false;
    mesh.receiveShadow = definition.receiveShadow ?? true;
    mesh.customDepthMaterial = definition.customDepthMaterial;
    mesh.customDistanceMaterial = definition.customDistanceMaterial;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.boundingSphere = new THREE.Sphere();
    if (layer !== undefined) mesh.layers.set(layer);
    group.add(mesh);
    return {mesh, sourceGeometry: source, count: 0, bounds: new THREE.Box3(), lastUsed: generation};
  }

  function allocate(definition: VegetationBatchDefinition, x: number, z: number, radius = definition.radius ?? 1, y = 0, verticalRadius = radius): VegetationBatchHandle | undefined {
    let state = states.get(definition);
    if (!state) { state = {count: 0, sx: 0, sz: 0}; states.set(definition, state); }
    if (state.count >= definition.capacity) return;
    const extent = definition.sectorSize ?? sectorSize;
    const sx = definition.spatial === false ? 0 : Math.floor(x / extent + .5);
    const sz = definition.spatial === false ? 0 : Math.floor(z / extent + .5);
    let sector = state.sector;
    // A single tree or grass patch contributes many consecutive instances to
    // the same sector. Reuse that lookup until the sector or LOD changes.
    if (!sector || sx !== state.sx || sz !== state.sz || sector.count >= sector.mesh.instanceMatrix.count) {
      const base = `${definition.id}|${sx},${sz}`;
      let key = base;
      sector = sectors.get(key);
      if (sector && sector.count >= sector.mesh.instanceMatrix.count) {
        key = base + '|overflow';
        sector = sectors.get(key);
      }
      if (!sector) {
        sector = createSector(definition);
        sectors.set(key, sector);
      }
      // Both the sector and its overflow are full: drop the instance rather than write past the end of the buffers.
      if (sector.count >= sector.mesh.instanceMatrix.count) return;
      state.sector = sector;
      state.sx = sx;
      state.sz = sz;
    }
    state.count++;
    sector.bounds.expandByPoint(point.set(x - radius, y - verticalRadius, z - radius));
    sector.bounds.expandByPoint(point.set(x + radius, y + verticalRadius, z + radius));
    return {mesh: sector.mesh, index: sector.count++};
  }

  function upload(attribute: THREE.BufferAttribute, count: number) {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, count * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  function release({mesh, sourceGeometry}: Sector) {
    group.remove(mesh);
    mesh.dispose();
    if (mesh.geometry !== sourceGeometry) mesh.geometry.dispose();
  }

  return {
    begin() {
      generation++;
      for (const state of states.values()) { state.count = 0; state.sector = undefined; }
      for (const sector of sectors.values()) {
        sector.count = 0;
        sector.bounds.makeEmpty();
      }
    },
    allocate,
    place(definition: VegetationBatchDefinition, matrix: THREE.Matrix4, radius = definition.radius ?? 1) {
      const e = matrix.elements;
      const handle = allocate(definition, e[12], e[14], radius, e[13]);
      if (handle) handle.mesh.setMatrixAt(handle.index, matrix);
      return handle;
    },
    count(definition: VegetationBatchDefinition) {
      return states.get(definition)?.count ?? 0;
    },
    end() {
      for (const [key, sector] of sectors) {
        const {mesh, count} = sector;
        mesh.count = count;
        mesh.visible = count > 0;
        if (!count) {
          if (generation - sector.lastUsed > 8) {
            release(sector);
            sectors.delete(key);
          }
          continue;
        }
        sector.lastUsed = generation;
        sector.bounds.getBoundingSphere(mesh.boundingSphere!);
        upload(mesh.instanceMatrix, count);
        if (mesh.instanceColor) upload(mesh.instanceColor, count);
        for (const attribute of Object.values(mesh.geometry.attributes)) {
          if (attribute instanceof THREE.InstancedBufferAttribute) upload(attribute, count);
        }
      }
    },
    dispose() {
      for (const sector of sectors.values()) release(sector);
      sectors.clear();
      states.clear();
    },
  };
}
