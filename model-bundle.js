const DIRECTIONS = new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
const CATEGORIES = new Set(['WALL', 'WINDOW', 'SHADING_H', 'SHADING_V', 'ROOF', 'FLOOR', 'REFERENCE']);

function readGlbJson(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 20) {
    throw new Error('The GLB file is empty or too small.');
  }

  const view = new DataView(arrayBuffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) {
    throw new Error('Expected a binary glTF 2.0 (.glb) model.');
  }
  if (view.getUint32(8, true) !== arrayBuffer.byteLength) {
    throw new Error('The GLB header length does not match the uploaded file.');
  }

  const jsonLength = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== 0x4e4f534a || 20 + jsonLength > arrayBuffer.byteLength) {
    throw new Error('The GLB file has an invalid JSON chunk.');
  }

  try {
    const jsonText = new TextDecoder().decode(new Uint8Array(arrayBuffer, 20, jsonLength));
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Could not read the GLB model metadata: ${error.message}`);
  }
}

export function validateModelBundle(manifest, audit, glbArrayBuffer) {
  if (!manifest || typeof manifest !== 'object' || !manifest.objects || typeof manifest.objects !== 'object') {
    throw new Error('The manifest JSON must contain an "objects" map.');
  }
  if (!audit || typeof audit !== 'object') {
    throw new Error('The audit JSON file is missing or invalid.');
  }

  const gltf = readGlbJson(glbArrayBuffer);
  if (!Array.isArray(gltf.nodes) || !Array.isArray(gltf.meshes)) {
    throw new Error('The GLB model has no valid nodes or meshes.');
  }

  const meshNames = new Set(gltf.nodes.filter((node) => node.mesh !== undefined).map((node) => node.name).filter(Boolean));
  if (meshNames.size === 0) {
    throw new Error('The GLB file contains no named mesh nodes. Export object names from Rhino.');
  }

  const records = Object.values(manifest.objects);
  const measured = records.filter((record) => record && Number.isFinite(record.exact_area_m2) && record.exact_area_m2 > 0);
  const matched = measured.filter((record) => meshNames.has(record.name));
  const envelope = matched.filter((record) => ['WALL', 'WINDOW'].includes(record.category));
  if (envelope.length === 0) {
    throw new Error('No named wall or glazing surfaces in the manifest match the GLB mesh nodes.');
  }

  for (const record of matched) {
    if (!CATEGORIES.has(record.category)) record.category = 'REFERENCE';
    if (!DIRECTIONS.has(record.orientation)) record.orientation = 'N';
    record.in_glb = true;
  }
  for (const record of measured) {
    if (!meshNames.has(record.name)) record.in_glb = false;
  }

  return {
    manifest: {
      ...manifest,
      model: manifest.model || 'Rhino model.glb',
      objects: manifest.objects
    },
    audit: {
      ...audit,
      csv_measured: measured.length,
      glb_mesh_nodes: meshNames.size,
      matched_manifest_objects: matched.length,
      unmatched_manifest_names: measured.filter((record) => !meshNames.has(record.name)).map((record) => record.name)
    },
    gltf,
    meshNames,
    measuredCount: measured.length,
    matchedCount: matched.length
  };
}
