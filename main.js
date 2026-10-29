import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';
import {wallAreaGroups} from './wall-area-groups.js';
import {createDesignWorkspace} from './design-workspace.js';
let designWorkspace=null;
import { aggregateEnvelope, calculateBuilding, facadeDirections, directionNames, opaquePresets, glazingPresets } from './ettv-engine.js';
import { analyzeShadingGeometry } from './shading-geometry.js';
import { evaluateMeasuredShading } from './shading-calculation.js';
import { validateModelBundle } from './model-bundle.js';
import { findMaterialRecommendations } from './material-recommendations.js';

const base = import.meta.env?.BASE_URL || './';
const ettvTarget = 45; // Singapore non-residential preliminary design target (W/m²)
const eightDirections = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const modelOptions = {
  default: {
    modelFile: 'building.glb',
    manifestFile: 'area_manifest.json',
    auditFile: 'audit_report.json'
  },
  onefloor: {
    modelFile: 'FacadeScan_1Floor_WWR70_VerticalPR020.glb',
    manifestFile: 'FacadeScan_1Floor_WWR70_VerticalPR020_manifest.json',
    auditFile: 'FacadeScan_1Floor_WWR70_VerticalPR020_audit.json'
  }
};
const query = new URLSearchParams(window.location.search);
const activeModelKey = query.get('model') === 'onefloor' ? 'onefloor' : 'default';
const activeModel = modelOptions[activeModelKey];
const requestedStep = Number(query.get('step'));
let workflowMode = query.get('mode') === 'recommend' ? 'recommend' : query.get('mode') === 'calculate' || requestedStep > 1 ? 'calculate' : null;
const elementCategories = ['WALL', 'WINDOW', 'SHADING_H', 'SHADING_V', 'ROOF', 'FLOOR', 'REFERENCE'];
const orientedCategories = new Set(['WALL', 'WINDOW', 'SHADING_H', 'SHADING_V']);
const palette = {
  WALL: { name: 'Opaque wall', color: '#ef943d' },
  WINDOW: { name: 'Glazing', color: '#45a9ef' },
  SHADING_H: { name: 'Horizontal shading', color: '#9964e8' },
  SHADING_V: { name: 'Vertical shading', color: '#ed77ba' },
  FLOOR: { name: 'Floor', color: '#596c7b' },
  ROOF: { name: 'Roof / Terrace', color: '#8094a2' },
  REFERENCE: { name: 'Reference', color: '#687f8c' }
};
const cats = Object.keys(palette);
const state = {
  category: Object.fromEntries(cats.map((c) => [c, c !== 'REFERENCE'])),
  direction: 'ALL', floor: 'ALL', search: '', selected: null, highlight: null
};
const el = (id) => document.getElementById(id);
const ettvWorkspace = el('ettv-analysis');
el('results-workspace').append(ettvWorkspace);
const modelContainer = el('scene');
const scene = new THREE.Scene();
scene.background = null;
scene.fog = new THREE.Fog('#122132', 80, 160);
const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.65;
modelContainer.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 3;
controls.maxDistance = 150;
controls.maxPolarAngle = Math.PI * 0.94;
scene.add(new THREE.HemisphereLight('#d5edff', '#324459', 2.25));
const sun = new THREE.DirectionalLight('#fff0d9', 3.1);
sun.position.set(-12, 30, 24);scene.add(sun);
const fill = new THREE.DirectionalLight('#9ed9ff', 1.4);
fill.position.set(20, 14, -19);scene.add(fill);
let root = null;
let allRecords = {};
let audit = null;
let meshes = [];
let geometryItems = [];
let homeCamera = null;
let ettvGeometry = null;
let ettvResults = null;
let measuredShading = null;
let shadingEvaluations = {};
let recommendationCandidates = [];
const shadingModes = Object.fromEntries(facadeDirections.map(d => [d,'auto-both']));
const ettvSettings = Object.fromEntries(facadeDirections.map((dir) => [dir, {
  uw: 1.517, uf: 2.72, scGlass: 0.8, hpr: 0, vpr: 0, bladeAngle: 0, verticalBladeAngle: 0
}]));
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tip = el('tooltip');
const formatArea = (a) => a == null ? '—' : Number(a).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' m²';
const num = (a) => Number(a).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (a) => Number.isFinite(a) ? (a * 100).toFixed(2) + '%' : '—';
const escapeHtml = (v) => String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
let activeStep = 1;
const stepPanels = [...document.querySelectorAll('[data-step-panel]')];
const stepButtons = [...document.querySelectorAll('.workflow-step')];
let geometryEditor = null;
let editorLoading = null;
let editorAssessed = false;
function showWorkflowChoice() {
  geometryEditor?.hide();
  workflowMode = null;
  el('workflow-stepper').hidden = true;
  el('top-actions').hidden = true;
  el('mode-choice').hidden = false;
  for (const panel of stepPanels) panel.hidden = true;
}
async function openGeometryEditor() {
  workflowMode = 'create';activeStep = 1;editorAssessed = false;
  el('mode-choice').hidden = true;
  el('workflow-stepper').hidden = false;
  el('top-actions').hidden = true;
  for(const panel of stepPanels)panel.hidden=panel.id!=='step-create';
  stepButtons.forEach(button=>{const first=button.dataset.goStep==='1';button.classList.toggle('active',first);button.classList.remove('complete');button.setAttribute('aria-current',first?'step':'false');});
  stepButtons[0].querySelector('b').textContent='Create Geometry';
  try {
    if(!geometryEditor){
      editorLoading??=import('./geometry-editor.js');
      const {createGeometryEditor}=await editorLoading;
      geometryEditor??=createGeometryEditor({onBack:showWorkflowChoice,onAssess:({manifest,audit,group})=>{
        for(const dir of facadeDirections)shadingModes[dir]='auto-both';
        installModel(manifest,audit,{scene:group});editorAssessed=true;workflowMode='create';
        el('edit-own-geometry').hidden=false;
        goToStep(3);
      }});
    }
    if(workflowMode==='create'&&activeStep===1)geometryEditor.show();
  }catch(error){el('geometry-editor-status').textContent=`Could not open the geometry editor: ${error.message}`;}
}
let materialsApplied=false;
function resetMaterialChoice(){
  materialsApplied=false;ettvResults=null;
  for(const dir of facadeDirections)shadingModes[dir]='auto-both';
  el('material-wall-preset').value='';el('material-glass-preset').value='';
  recommendationCandidates=[];el('recommendation-results').innerHTML='<p>Search to compare material combinations for this geometry. No materials have been applied yet.</p>';
  el('material-apply-status').textContent='Choose both wall and glazing materials to continue.';
}
function presentWorkflow(){
  const search=workflowMode==='recommend',page=el('step-results');page.dataset.mode=search?'recommend':'calculate';
  page.querySelector('.results-heading h1').textContent=search?'Find the right materials':'Calculate your ETTV';
  page.querySelector('.results-heading .eyebrow').textContent=search?'COMPARE & SELECT':'ETTV CALCULATOR';
  page.querySelector('.results-heading p').textContent=search?'Explore combinations for the 45 W/m² target, then apply a choice to assess your building.':'Enter your wall and glazing materials, then calculate the building’s ETTV.';
  el('material-controls-title').textContent=search?'Your material selection':'Calculation inputs';
  el('apply-materials').textContent=search?'Apply selected materials':'Calculate ETTV';
  el('material-controls').querySelector('.ettv-help').textContent=search?'Choose materials manually or apply a combination from the search results.':'Select the materials used in your building. These inputs apply to all façade orientations.';
  const panel=el('recommendation-panel');page.insertBefore(panel,page.querySelector('.results-design-grid'));panel.hidden=!search||activeStep!==3;
  stepButtons.filter(b=>Number(b.dataset.goStep)===3).forEach(b=>{const label=b.querySelector('b');if(label)label.textContent=search?'Find Material':'Calculate ETTV';});
  presentMaterialState();
}
function presentMaterialState(){
  designWorkspace?.render();
  const ready=materialsApplied;
  el('apply-materials').disabled=!el('material-wall-preset').value||!el('material-glass-preset').value||!ettvGeometry;
  el('results-export-csv').disabled=!ready||!ettvResults||ettvResults.overall===null;
  el('results-materials').hidden=!ready;
  document.querySelector('.results-chart-card').hidden=!ready;
  el('ettv-alert').hidden=!ready;ettvWorkspace.hidden=!ready;
  el('result-material-summary').hidden=!ready;
  document.querySelector('.result-primary').classList.toggle('awaiting-materials',!ready);
  if(!ready){
    el('result-overall').textContent='Not calculated';el('ettv-status').textContent='Select materials to begin';el('ettv-status').dataset.state='pending';
    el('result-material-summary').textContent='';el('ettv-chart').replaceChildren();
    if(ettvGeometry)el('ettv-envelope').textContent=formatArea(Object.values(ettvGeometry).reduce((sum,f)=>sum+(f.wall??0)+(f.window??0),0));
  }
}
function goToStep(step) {
  if(workflowMode==='create'&&(step===1||!editorAssessed)){openGeometryEditor();return;}
  geometryEditor?.hide();
  el('mode-choice').hidden = true;
  el('workflow-stepper').hidden = false;
  el('top-actions').hidden = false;
  activeStep = step;
  for (const panel of stepPanels) panel.hidden = Number(panel.dataset.stepPanel) !== step;
  el('recommendation-panel').hidden = workflowMode !== 'recommend' || step !== 3;
  presentWorkflow();
  stepButtons.forEach((button) => {
    const buttonStep = Number(button.dataset.goStep);
    button.classList.toggle('active', buttonStep === step);
    button.classList.toggle('complete', buttonStep < step);
    button.setAttribute('aria-current', buttonStep === step ? 'step' : 'false');
  });
  designWorkspace?.show(step);
  if (step === 2 || step === 3) requestAnimationFrame(setResize);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function selectWorkflow(mode) {
  workflowMode = mode;
  resetMaterialChoice();
  stepButtons[0].querySelector('b').textContent='Import Model';
  el('import-title').innerHTML = mode === 'recommend'
    ? 'Find Material &amp; Shading <em>Combinations</em>'
    : 'Analyze Your <em>Building Envelope</em>';
  el('import-description').textContent = mode === 'recommend'
    ? 'Import or choose a model. We will use its façade areas and measured shading to search combinations for the 45 W/m² target.'
    : 'Import a model, map its geometry, then review materials and ETTV results.';
  goToStep(1);
  if(!ettvGeometry)init();
}
el('choose-calculate').addEventListener('click', () => selectWorkflow('calculate'));
el('choose-recommend').addEventListener('click', () => selectWorkflow('recommend'));
el('choose-create').addEventListener('click', openGeometryEditor);
el('edit-own-geometry').addEventListener('click', openGeometryEditor);
el('change-workflow').addEventListener('click', showWorkflowChoice);
el('back-main-menu').addEventListener('click', () => {
  showWorkflowChoice();
  window.scrollTo({top:0,behavior:'smooth'});
  const heading=el('mode-choice').querySelector('h1');
  heading.tabIndex=-1;heading.focus({preventScroll:true});
});

document.querySelectorAll('[data-go-step]').forEach((button) => {
  button.addEventListener('click', () => goToStep(Number(button.dataset.goStep)));
});
el('go-results').addEventListener('click', () => goToStep(3));
el('results-back').addEventListener('click', () => goToStep(2));
el('results-export-csv').addEventListener('click', saveEttvCsv);
el('use-sample-model').addEventListener('click', () => {
  if (!ettvGeometry) {
    el('file-import-status').textContent = 'The sample model is still loading. Wait until the geometry viewer finishes loading, then try again.';
    return;
  }
  selectBundledModel('default');
});
el('use-benchmark-model').addEventListener('click', () => selectBundledModel('onefloor'));
function selectBundledModel(modelKey) {
  const url = new URL(window.location.href);
  url.searchParams.set('model', modelKey);
  url.searchParams.set('step', '2');
  if (workflowMode === 'recommend') url.searchParams.set('mode', 'recommend');
  else url.searchParams.delete('mode');
  window.location.assign(url);
}
el('model-file').addEventListener('change', (event) => {
  const files = [...(event.target.files ?? [])];
  if (!files.length) return;
  event.target.value = '';
  loadUploadedModel(files).catch((error) => {
    console.error('FacadeScan model import failed:', error);
    el('file-import-status').textContent = `Import failed: ${error.message}`;
  });
});

async function loadUploadedModel(files) {
  const glbFile = files.find((file) => file.name.toLowerCase().endsWith('.glb'));
  const jsonFiles = files.filter((file) => file.name.toLowerCase().endsWith('.json'));
  if (!glbFile || jsonFiles.length < 1) {
    throw new Error('Select the Rhino export .glb and its manifest JSON together. The audit JSON is recommended.');
  }
  el('file-import-status').textContent = `Reading ${glbFile.name} and validating its export data…`;
  const jsonEntries = await Promise.all(jsonFiles.map(async (file) => ({
    file,
    data: await file.text().then((contents) => {
      try {
        return JSON.parse(contents);
      } catch (error) {
        throw new Error(`Invalid JSON in "${file.name}": ${error.message}`);
      }
    })
  })));
  const manifestEntry = jsonEntries.find(({ data }) => data && data.objects && typeof data.objects === 'object');
  const auditEntry = jsonEntries.find(({ data }) => data && !data.objects && typeof data === 'object');
  if (!manifestEntry) throw new Error('Could not find a manifest JSON containing an "objects" map.');
  const audit = auditEntry?.data ?? {
    warning: 'No audit JSON was supplied. Confirm mesh-to-manifest matching before using results.'
  };
  const glbBuffer = await glbFile.arrayBuffer();
  const bundle = validateModelBundle(manifestEntry.data, audit, glbBuffer);
  const gltf = await new GLTFLoader().parseAsync(glbBuffer, '');
  installModel(bundle.manifest, bundle.audit, gltf);
  el('file-import-status').textContent = `Imported ${glbFile.name}: ${bundle.matchedCount}/${bundle.measuredCount} measured objects match named GLB mesh nodes. Review layer and direction mapping before trusting the ETTV.`;
  const url = new URL(window.location.href);
  url.searchParams.delete('model');
  url.searchParams.delete('step');
  if (workflowMode === 'recommend') url.searchParams.set('mode', 'recommend');
  else url.searchParams.delete('mode');
  window.history.replaceState({}, '', url);
  goToStep(2);
}

function categoryFor(mesh) { return mesh.userData.record?.category || 'REFERENCE'; }
function recordFor(mesh) { return mesh.userData.record || null; }
function computedColor(cat) { return palette[cat]?.color || palette.REFERENCE.color; }
function configureMesh(mesh) {
  const category = categoryFor(mesh);
  // Unlit diagnostic material: show layer/category colors even when the
  // imported Rhino/GLB normal data or lighting makes lit materials look black.
  // This affects only the 3D viewer; ETTV calculations use numeric metadata.
  const mat = new THREE.MeshBasicMaterial({
    color: computedColor(category),
    vertexColors: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    transparent: category === 'WINDOW',
    opacity: category === 'WINDOW' ? 0.82 : 1,
    depthWrite: category !== 'WINDOW'
  });
  mesh.material = mat;
  mesh.userData.originalColor = new THREE.Color(computedColor(category));
}
function allowed(rec) {
  if (!state.category[rec?.category || 'REFERENCE']) return false;
  if (state.direction !== 'ALL' && rec?.orientation !== state.direction) return false;
  if (state.floor !== 'ALL' && String(rec?.level ?? '') !== state.floor) return false;
  if (state.search && !(rec?.name || '').toLowerCase().includes(state.search)) return false;
  return true;
}
function applyFilters() {
  let visible = 0;
  for (const mesh of meshes) {
    mesh.visible = allowed(recordFor(mesh));
    if (mesh.visible) visible += 1;
  }
  el('visible-count').textContent = `${visible} / ${meshes.length} objects visible`;
  if (state.selected && !state.selected.visible) selectMesh(null);
}
function selectMesh(mesh) {
  if (state.selected) {
    state.selected.material.color.copy(state.selected.userData.originalColor);
    if (state.selected.material.emissive) state.selected.material.emissive.set('#000000');
  }
  if (state.highlight) { scene.remove(state.highlight);state.highlight.geometry.dispose();state.highlight.material.dispose();state.highlight = null; }
  state.selected = mesh;
  if (mesh) {
    // MeshBasicMaterial has no emissive property. Brighten the selected
    // material instead and keep the bounding-box highlight.
    mesh.material.color.lerp(new THREE.Color('#ffffff'), 0.38);
    if (mesh.material.emissive) {
      mesh.material.emissive.set('#0f8291');
      mesh.material.emissiveIntensity = 0.38;
    }
    state.highlight = new THREE.BoxHelper(mesh, '#fbf8d0');
    state.highlight.material.transparent = true;
    state.highlight.material.opacity = 0.9;
    scene.add(state.highlight);
  }
  renderInspector(mesh && recordFor(mesh));
  if(mesh&&activeStep===3)designWorkspace?.select(recordFor(mesh)?.orientation);
}
function valueRow(key, value) { return `<div class="keyval"><span>${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>`; }
function renderInspector(rec) {
  el('element-inspector').hidden = !rec;
  if (!rec) {
    el('details-inner').innerHTML = '';
    return;
  }
  const isEnvelope = rec.category === 'WALL' || rec.category === 'WINDOW';
  const wallGroups=rec.category==='WALL'?wallAreaGroups(allRecords,rec.orientation):[];
  const wallGroup=wallGroups.find(g=>g.level===(rec.level==null?'Unassigned':String(rec.level)));
  el('details-inner').innerHTML = `
    <div class="selected-badge">${escapeHtml(palette[rec.category]?.name || rec.category)}</div>
    <div class="selection-name">${escapeHtml(rec.name)}</div>
    <div class="selection-layer">${escapeHtml(rec.layer)}</div>
    <div class="area-card"><label>${wallGroup?`TOTAL WALL · LEVEL ${escapeHtml(wallGroup.level)} · ${escapeHtml(directionNames[rec.orientation]||rec.orientation)}`:rec.source==='browser-editor'?'EDITOR SURFACE AREA':'RHINO EXACT SURFACE AREA'}</label><b>${formatArea(wallGroup?.area??rec.exact_area_m2)}</b><small>${wallGroup?`${wallGroup.count} wall panels · net opaque area; glazing excluded`:rec.source==='browser-editor'?'Triangulated polygon; glazing subtracted from wall':'Trimmed Brep face / RhinoCommon'}</small></div>
    ${wallGroup?wallGroups.map(g=>valueRow(`Level ${g.level} · ${directionNames[rec.orientation]||rec.orientation}`,formatArea(g.area))).join('')+valueRow('Clicked panel only',formatArea(rec.exact_area_m2)):''}
    ${valueRow('Orientation (layer)', rec.orientation || '—')}
    ${valueRow('Orientation (normal)', rec.geometric_orientation || 'Not applicable')}
    ${valueRow('Azimuth (normal)', rec.geometric_azimuth_deg == null ? 'Not applicable' : rec.geometric_azimuth_deg + '°')}
    ${valueRow('Level', rec.level == null ? '—' : `Level ${rec.level}`)}
    ${valueRow('Façade segment', rec.segment == null ? '—' : `B${String(rec.segment).padStart(2, '0')}`)}
    ${valueRow('Mesh area', formatArea(rec.mesh_area_m2))}
    ${valueRow('Area difference', rec.mesh_minus_exact_m2 == null ? '—' : rec.mesh_minus_exact_m2.toFixed(5) + ' m²')}
    ${valueRow('Visual material', rec.visual_material || '—')}
    ${isEnvelope ? valueRow('Thermal U-value (current ETTV input)', rec.category === 'WALL' ? ettvSettings[rec.orientation]?.uw ?? '—' : ettvSettings[rec.orientation]?.uf ?? '—') : ''}
    ${rec.category === 'WINDOW' ? valueRow('Glass SC (current ETTV input)', ettvSettings[rec.orientation]?.scGlass ?? '—') : ''}
    ${rec.category === 'WINDOW' ? (()=>{const w=measuredShading?.windows.find(x=>x.window===rec.name);return w ? valueRow('Auto H projection depth / PR', w.h?.ratio==null ? w.h?.status : `${w.h.depth_m.toFixed(3)} m / ${w.h.ratio.toFixed(3)}`)+valueRow('Auto V projection depth / PR', w.v?.ratio==null ? w.v?.status : `${w.v.depth_m.toFixed(3)} m / ${w.v.ratio.toFixed(3)}`)+valueRow('Shading matching status',w.status) : '';})() : ''}
    ${isEnvelope ? valueRow('Façade ETTV (current calculation)', ettvResults?.facades?.find((f) => f.orientation === rec.orientation)?.ettv?.toFixed(2) ?? 'N/A') : ''}
    ${valueRow('Geometry type', rec.geometry_type)}
    ${valueRow('Object ID', rec.id.slice(0, 13) + '…')}
    <div class="selection-note">${isEnvelope ? 'Verify that this object belongs to the conditioned exterior envelope before using it in an ETTV calculation.' : 'This is a supporting element and is not directly included in the wall/window area for ETTV.'} U-value and SC/SHGC data are not included in these area measurements.</div>`;
}
function renderFilters() {
  el('category-filters').innerHTML = cats.map((key) => {
    const category = palette[key];
    const qty = Object.values(allRecords).filter((r) => r.category === key && r.in_glb).length;
    return `<button class="cat-btn ${state.category[key] ? '' : 'muted'}" data-category="${key}" aria-pressed="${state.category[key]}"><i class="cat-color" style="background:${category.color}"></i><span>${category.name}</span><span class="count">${qty}</span><span>${state.category[key] ? '✓' : '○'}</span></button>`;
  }).join('');
  el('category-filters').querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => {
    const cat = button.dataset.category;
    state.category[cat] = !state.category[cat];
    renderFilters();applyFilters();
  }));
  el('orientation-filters').innerHTML = ['ALL', ...eightDirections].map((dir) => `<button class="chip ${state.direction === dir ? 'active' : ''}" data-dir="${dir}" aria-pressed="${state.direction === dir}">${dir === 'ALL' ? 'All' : dir}</button>`).join('');
  el('orientation-filters').querySelectorAll('[data-dir]').forEach((button) => button.addEventListener('click', () => {
    state.direction = button.dataset.dir;
    renderFilters();applyFilters();
  }));
}
function renderLayerMapping() {
  const grouped = new Map();
  for (const rec of Object.values(allRecords)) {
    if (!rec.in_glb || rec.exact_area_m2 == null) continue;
    const isWall = rec.category === 'WALL';
    const key = isWall ? `WALL\u0000${rec.orientation}` : `${rec.layer}\u0000${rec.orientation}`;
    const layer = isWall ? `Opaque wall · ${directionNames[rec.orientation] || rec.orientation}` : rec.layer;
    if (!grouped.has(key)) grouped.set(key, { layer, orientation: rec.orientation, category: rec.category, names: [], area: 0 });
    const group = grouped.get(key);
    group.names.push(rec.name);
    group.area += rec.exact_area_m2;
  }
  const groups = [...grouped.values()].sort((a, b) => a.layer.localeCompare(b.layer) || String(a.orientation).localeCompare(String(b.orientation)));
  el('layer-group-count').textContent = String(groups.length);
  el('layer-mapping-list').innerHTML = groups.map((group, index) => `
    <div class="layer-map-row" data-map-index="${index}">
      <div class="layer-map-meta"><b title="${escapeHtml(group.layer)}">${escapeHtml(group.layer || 'Unlabelled layer')}</b><small>${group.names.length} surfaces · ${formatArea(group.area)}</small></div>
      <select data-map-category aria-label="Map ${escapeHtml(group.layer)} to element type">
        ${elementCategories.map((category) => `<option value="${category}" ${category === group.category ? 'selected' : ''}>${escapeHtml(palette[category].name)}</option>`).join('')}
      </select>
      <select class="direction-select" data-map-direction aria-label="Assign ${escapeHtml(group.layer)} orientation" ${orientedCategories.has(group.category) ? '' : 'disabled'}>
        ${orientedCategories.has(group.category)
          ? eightDirections.map((direction) => `<option value="${direction}" ${direction === group.orientation ? 'selected' : ''}>${directionNames[direction]}</option>`).join('')
          : '<option value="" selected>Not applicable</option>'}
      </select>
    </div>`).join('');
  el('layer-mapping-list').onchange = (event) => {
    const row = event.target.closest('[data-map-index]');
    if (!row) return;
    const group = groups[Number(row.dataset.mapIndex)];
    if (!group) return;
    const category = row.querySelector('[data-map-category]').value;
    const selectedOrientation = row.querySelector('[data-map-direction]').value;
    const orientation = orientedCategories.has(category) && selectedOrientation ? selectedOrientation : group.orientation;
    const names = new Set(group.names);
    for (const rec of Object.values(allRecords)) {
      if (!names.has(rec.name)) continue;
      rec.category = category;
      rec.orientation = orientation;
      const mesh = meshes.find((item) => item.name === rec.name);
      if (mesh) {
        mesh.material.dispose();
        configureMesh(mesh);
      }
    }
    measuredShading = analyzeShadingGeometry(geometryItems);
    ettvGeometry = aggregateEnvelope(allRecords);
    renderLayerMapping();
    renderFilters();
    applyFilters();
    summary();
    recalculateEttv();
  };
  el('layer-mapping-list').insertAdjacentHTML('beforeend', '<p class="mapping-note">Wall surfaces are combined by orientation, regardless of layer labels such as head or sill. Orientation applies to walls, glazing, and shading. Roofs, floors, and reference objects do not use façade orientation. Directional values are inferred from surface normals and can be corrected per group.</p>');
}
function summary() {
  const out = { WALL: 0, WINDOW: 0 };
  const orientations = Object.fromEntries(eightDirections.map((d) => [d, { wall: 0, window: 0 }]));
  let measured = 0;
  for (const rec of Object.values(allRecords)) {
    if (!rec.in_glb || rec.exact_area_m2 == null) continue;
    measured++;
    if (rec.category === 'WALL' || rec.category === 'WINDOW') {
      out[rec.category] += rec.exact_area_m2;
      if (orientations[rec.orientation]) orientations[rec.orientation][rec.category.toLowerCase()] += rec.exact_area_m2;
    }
  }
  const gross = out.WALL + out.WINDOW;
  el('metric-objects').textContent = num(measured);
  el('metric-wall').textContent = num(out.WALL);
  el('metric-window').textContent = num(out.WINDOW);
  el('metric-wwr').textContent = pct(out.WINDOW / gross);
  el('orientation-rows').innerHTML = Object.entries(orientations).filter(([, value]) => value.wall + value.window > 0).map(([dir, value]) => {
    const total = value.wall + value.window;
    const wallP = value.wall / total * 100;
    const glassP = value.window / total * 100;
    return `<div class="direction-row"><strong>${dir}</strong><div class="bar-track" title="Opaque ${formatArea(value.wall)}; glazing ${formatArea(value.window)}"><span class="bar-wall" style="width:${wallP}%"></span><span class="bar-window" style="width:${glassP}%"></span></div><span class="num area-values"><b>${num(total)} m²</b><small>Glass: ${formatArea(value.window)}</small></span><span class="percent">${pct(value.window / total)}</span></div>`;
  }).join('') || '<p class="overview-note">No wall or glazing area detected for the eight façade orientations.</p>';
  el('result-wall-area').textContent = formatArea(out.WALL);
  el('result-glazing-area').textContent = formatArea(out.WINDOW);
  el('result-wwr').textContent = pct(out.WINDOW / gross);
}

function populateMaterialPresets() {
  const wall = el('material-wall-preset');
  const glass = el('material-glass-preset');
  wall.innerHTML = '<option value="" disabled selected>Select wall construction…</option>'+opaquePresets.filter((o) => o.value !== 'custom').map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  glass.innerHTML = '<option value="" disabled selected>Select glazing…</option>'+glazingPresets.filter((o) => o.value !== 'custom').map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
}
function renderEttvRows() {
  el('ettv-rows').innerHTML = facadeDirections.map((d) => {
    const label = directionNames[d];
    const getInput = (key, min, max, step) => `<input type="number" data-et-dir="${d}" data-et-key="${key}" min="${min}" max="${max}" step="${step}" value="${ettvSettings[d][key]}" aria-label="${label} ${key}">`;
    return `<tr data-ettv-row="${d}"><td><b>${label}</b></td><td data-et-output="area">—</td><td data-et-output="wall">—</td><td data-et-output="window">—</td><td data-et-output="wwr">—</td><td data-et-output="cf">—</td>
      <td>${getInput('uw', 0.01, 10, 0.01)}</td><td>${getInput('uf', 0.01, 10, 0.01)}</td><td>${getInput('scGlass', 0.01, 1 / 0.87, 0.001)}</td>
      <td><select class="shading-mode" data-mode-dir="${d}" aria-label="${label} shading scenario"><option value="auto-both">Auto / actual H+V</option><option value="auto-horizontal">Auto / H-only scenario</option><option value="auto-vertical">Auto / V-only scenario</option><option value="manual">Manual override</option></select></td>
      <td title="Horizontal-blade inclination is measured from Rhino geometry when available; otherwise enter it manually.">${getInput('bladeAngle', 0, 50, 1)}</td><td title="Vertical-fin inclination is measured from Rhino geometry when available; otherwise enter it manually.">${getInput('verticalBladeAngle', 0, 50, 1)}</td><td>${getInput('hpr', 0, 3, 0.01)}</td><td>${getInput('vpr', 0, 3, 0.01)}</td>
      <td data-et-output="scProjection">—</td><td data-et-output="scTotal">—</td><td data-et-output="ettv">—</td></tr>`;
  }).join('');
}
function displayGeometryShading(){
  for(const dir of facadeDirections){
    const info=measuredShading?.byOrientation[dir];
    const tr=el('ettv-rows').querySelector(`[data-ettv-row="${dir}"]`);
    const mode=shadingModes[dir];
    tr.querySelector('select[data-mode-dir]').value=mode;
    for(const [key,val] of [['hpr',info?.horizontalRatio],['vpr',info?.verticalRatio]]){
      const input=tr.querySelector(`[data-et-key="${key}"]`);
      input.readOnly=mode!=='manual';
      input.title=mode==='manual'?'User override': val==null?'Different ratios detected across individual windows; see panel report': 'Measured from Rhino surface geometry';
      if(mode!=='manual') {
        input.value=Number.isFinite(val)?Number(val.toFixed(4)):'';
        input.placeholder=info?.total?'varies':'—';
      } else input.value=ettvSettings[dir][key];
    }
    const angleInput=tr.querySelector('[data-et-key="bladeAngle"]');
    const verticalAngleInput=tr.querySelector('[data-et-key="verticalBladeAngle"]');
    if(mode==='manual'){
      angleInput.readOnly=false;
      angleInput.value=ettvSettings[dir].bladeAngle;
      angleInput.placeholder='';
      angleInput.title='Manual horizontal-blade inclination';
      verticalAngleInput.readOnly=false;
      verticalAngleInput.value=ettvSettings[dir].verticalBladeAngle;
      verticalAngleInput.placeholder='';
      verticalAngleInput.title='Manual vertical-fin inclination';
    }else if(Number.isFinite(info?.horizontalInclinationDeg)){
      angleInput.readOnly=true;
      angleInput.value=Number(info.horizontalInclinationDeg.toFixed(1));
      angleInput.placeholder='';
      angleInput.title='Measured from the horizontal shading surface normal in Rhino geometry';
    }else if(info?.horizontalInclinationVaries){
      angleInput.readOnly=true;
      angleInput.value='';
      angleInput.placeholder='per-panel';
      angleInput.title='Varies by glazing panel; the calculation uses each measured panel angle';
    }else{
      angleInput.readOnly=false;
      angleInput.value=ettvSettings[dir].bladeAngle;
      angleInput.title='No horizontal-blade inclination was measured; this manual angle is used as fallback';
    }
    if(mode!=='manual'){
      if(Number.isFinite(info?.verticalInclinationDeg)){
        verticalAngleInput.readOnly=true;
        verticalAngleInput.value=Number(info.verticalInclinationDeg.toFixed(1));
        verticalAngleInput.placeholder='';
        verticalAngleInput.title='Measured from the vertical shading surface geometry';
      }else if(info?.verticalInclinationVaries){
        verticalAngleInput.readOnly=true;
        verticalAngleInput.value='';
        verticalAngleInput.placeholder='per-panel';
        verticalAngleInput.title='Varies by glazing panel; the calculation uses each measured panel angle';
      }else{
        verticalAngleInput.readOnly=false;
        verticalAngleInput.value=ettvSettings[dir].verticalBladeAngle;
        verticalAngleInput.title='No vertical-fin inclination was measured; this manual angle is used as fallback';
      }
    }
  }
}
function recalculateEttv() {
  if (!ettvGeometry) return;
  if(!materialsApplied){ettvResults=null;presentMaterialState();return;}
  shadingEvaluations={};
  const settings={};
  for(const dir of facadeDirections){
    const mode=shadingModes[dir];
    const current=ettvSettings[dir];
    if(mode==='manual'){settings[dir]={...current};continue;}
    const measurement=evaluateMeasuredShading(measuredShading,dir,mode,ettvGeometry[dir]?.window,current.bladeAngle,current.verticalBladeAngle);
    shadingEvaluations[dir]=measurement;
    settings[dir]={...current};
    if(measurement.ok){
      settings[dir].effectiveSCProjection=measurement.weightedSC;
      settings[dir].estimatedSCProjection=measurement.estimated;
      settings[dir].shadingMethod=measurement.note;
      settings[dir].hpr=0;
      settings[dir].vpr=0;
    }else{
      // Explicitly fail rather than silently assume 'no shading' or average the two SC values.
      settings[dir].unsupportedCombined=true;
    }
  }
  ettvResults = calculateBuilding(ettvGeometry, settings);
  const r = ettvResults;
  const usedEstimated = r.facades.some(f => f.estimated && f.area > 0);
  el('result-overall').textContent = r.overall === null ? 'N/A' : `${usedEstimated ? '≈ ' : ''}${r.overall.toFixed(2)} W/m²`;
  el('ettv-envelope').textContent = formatArea(r.totalArea);
  el('ettv-status').textContent = r.overall === null ? 'INCOMPLETE'
    : usedEstimated ? 'ESTIMATE · not compliance'
    : r.overall <= ettvTarget ? `≤ ${ettvTarget} · target met` : `> ${ettvTarget} · target exceeded`;
  el('ettv-status').dataset.state = r.overall === null || usedEstimated ? 'review' : r.overall <= ettvTarget ? 'met' : 'exceeded';
  const chartMaximum = Math.max(55, ...r.facades.filter((facade) => facade.area > 0 && facade.ettv !== null).map((facade) => facade.ettv));
  const activeFacades = r.facades.filter((facade) => facade.area > 0);
  el('ettv-chart').style.gridTemplateColumns = `repeat(${Math.max(1,activeFacades.length)}, minmax(0,1fr))`;
  el('ettv-chart').innerHTML = `<i class="chart-target" style="bottom:${ettvTarget / chartMaximum * 100}%" aria-hidden="true"></i>` + activeFacades.map((facade) => {
    const value = facade.ettv;
    const height = value === null ? 0 : Math.max(3, value / chartMaximum * 100);
    return `<div class="chart-column ${value !== null && value > ettvTarget ? 'over-target' : ''}" title="${directionNames[facade.orientation]}: ${value === null ? 'unavailable' : value.toFixed(2) + ' W/m²'}"><strong style="bottom:calc(${height}% + 5px)">${value === null ? 'N/A' : value.toFixed(1)}</strong><i class="chart-bar" style="height:${height}%"></i><span>${facade.orientation}</span></div>`;
  }).join('');
  el('ettv-alert').textContent = r.overall === null
      ? 'ETTV cannot be aggregated: unsupported shading geometry, missing matching, or invalid inputs. Inspect façade notes.'
      : usedEstimated
        ? 'DESIGN ESTIMATE — At least one projection ratio is outside the egg-crate table range; a clearly labelled linear extension is used for this preview. NOT a regulatory compliance result. Confirm source-table limits and shading geometry.'
        : 'Preliminary ETTV using values from your uploaded workbook (SC and CF). Horizontal-blade inclination is read from Rhino geometry when available; verify envelope, shading pairing and measured geometry before any compliance use.';
  el('ettv-alert').classList.toggle('ok', r.overall !== null && !usedEstimated);
  const measured=measuredShading?.summary;
  el('shading-extraction-status').textContent=measured
    ? `Auto-matched ${measured.matched}/${measured.windows} glazing panels, ${measured.review} need review, ${measured.unmatchedShades} unpaired shading surfaces. Window-level SC is area-weighted; PR is never averaged for calculation.`
    : 'Waiting for Rhino shading surface extraction...';
  el('shading-scenario-message').textContent=facadeDirections.map(dir=>{
    const mode=shadingModes[dir];const m=shadingEvaluations[dir];
    return `${directionNames[dir]}: ${mode==='manual'?'Manual':m?.ok?m.note:m?.reason||'Waiting for geometry'}`;
  }).join(' | ');
  displayGeometryShading();
  for (const f of r.facades) {
    const tr = el('ettv-rows').querySelector(`[data-ettv-row="${f.orientation}"]`);
    if (!tr) continue;
    tr.hidden = f.area <= 0;
    const out = (key, value, title = '') => { const n = tr.querySelector(`[data-et-output="${key}"]`); n.textContent = value; n.title = title; };
    out('area', Number(f.area).toFixed(2));out('wall', Number(f.wall).toFixed(2));out('window', Number(f.window).toFixed(2));
    out('wwr', f.wwr == null ? '—' : (f.wwr * 100).toFixed(2) + '%');
    out('cf', f.cf?.toFixed(2) ?? '—');
    out('scProjection', f.scProjection == null ? 'N/A' : (f.estimated ? '≈ ' : '') + f.scProjection.toFixed(4), [f.lookup?.note,shadingEvaluations[f.orientation]?.tableIds?.join('/'),shadingEvaluations[f.orientation]?.sourceCells?.slice(0,12).join(', ')].filter(Boolean).join(' | ') || f.reason || '');
    out('scTotal', f.scTotal == null ? 'N/A' : (f.estimated ? '≈ ' : '') + f.scTotal.toFixed(4));
    out('ettv', f.ettv == null ? 'N/A' : (f.estimated ? '≈ ' : '') + f.ettv.toFixed(2), f.lookup?.note || f.reason || '');
    tr.querySelector('[data-et-output="ettv"]').className = f.ettv == null ? 'value-error' : f.estimated ? 'value-estimate' : 'value-good';
  }
  renderResultsMaterials();
  if (state.selected) renderInspector(recordFor(state.selected));
  presentMaterialState();
}

function findOpaquePreset(value) {
  return opaquePresets.find((preset) => Number.isFinite(preset.value) && Math.abs(preset.value - value) < 0.0005)?.label ?? 'Custom / manual value';
}

function findGlazingPreset(uf, scGlass) {
  return glazingPresets.find((preset) => {
    if (typeof preset.value !== 'string') return false;
    const [presetUf, presetSc] = preset.value.split('|').map(Number);
    return Math.abs(presetUf - uf) < 0.0005 && Math.abs(presetSc - scGlass) < 0.0005;
  })?.label ?? 'Custom / manual values';
}

function renderResultsMaterials() {
  const activeDirections = facadeDirections
    .filter((dir) => (ettvGeometry?.[dir]?.wall ?? 0) + (ettvGeometry?.[dir]?.window ?? 0) > 0);
  const rows = activeDirections
    .map((dir) => {
      const settings = ettvSettings[dir];
      const geometry = ettvGeometry[dir];
      const wallLabel = geometry.wall > 0 ? findOpaquePreset(settings.uw) : '—';
      const glassLabel = geometry.window > 0 ? findGlazingPreset(settings.uf, settings.scGlass) : '—';
      return `<tr>
        <td><b>${directionNames[dir]}</b></td>
        <td>${escapeHtml(wallLabel)}</td>
        <td>${Number.isFinite(settings.uw) ? settings.uw.toFixed(3) : '—'}</td>
        <td>${escapeHtml(glassLabel)}</td>
        <td>${Number.isFinite(settings.uf) ? settings.uf.toFixed(3) : '—'}</td>
        <td>${Number.isFinite(settings.scGlass) ? settings.scGlass.toFixed(3) : '—'}</td>
      </tr>`;
    });
  el('results-material-rows').innerHTML = rows.join('');

  const uniqueMaterial = (predicate, format) => {
    const values = [...new Set(activeDirections.filter(predicate).map((dir) => format(dir)))];
    return values.length === 1 ? values[0] : values.length > 1 ? 'Varies by orientation — expand the applied materials table' : 'No mapped area';
  };
  const wallSummary = uniqueMaterial(
    (dir) => ettvGeometry[dir].wall > 0,
    (dir) => `Uw ${Number(ettvSettings[dir].uw).toFixed(3)} W/m²K`
  );
  const glazingSummary = uniqueMaterial(
    (dir) => ettvGeometry[dir].window > 0,
    (dir) => `Uf ${Number(ettvSettings[dir].uf).toFixed(3)} W/m²K · Glass SC ${Number(ettvSettings[dir].scGlass).toFixed(3)}`
  );
  el('result-material-summary').innerHTML = `<span><b>Applied wall:</b> ${escapeHtml(wallSummary)}</span><span><b>Applied glazing:</b> ${escapeHtml(glazingSummary)}</span>`;
}

function searchMaterialCombinations() {
  if (!ettvGeometry) {
    el('recommendation-results').innerHTML = '<p class="value-error">Building area data is not ready. Wait for the model to finish loading.</p>';
    return;
  }
  const scenarios = [{ id: 'none', label: 'No external shading', settingsByOrientation: {} }];
  const shadingModesToTry = [
    ['auto-both', 'Measured H + V'],
    ['auto-horizontal', 'Measured H-only'],
    ['auto-vertical', 'Measured V-only']
  ];

  for (const [mode, label] of shadingModesToTry) {
    const settingsByOrientation = {};
    let usable = true;
    for (const dir of facadeDirections) {
      if (!(ettvGeometry[dir]?.window > 0)) continue;
      const measurement = evaluateMeasuredShading(
        measuredShading,
        dir,
        mode,
        ettvGeometry[dir].window,
        ettvSettings[dir].bladeAngle,
        ettvSettings[dir].verticalBladeAngle
      );
      if (!measurement.ok) {
        usable = false;
        break;
      }
      settingsByOrientation[dir] = {
        effectiveSCProjection: measurement.weightedSC,
        estimatedSCProjection: measurement.estimated,
        shadingMethod: measurement.note
      };
    }
    if (usable) scenarios.push({ id: mode, label, settingsByOrientation });
  }

  const search = findMaterialRecommendations(ettvGeometry, scenarios, ettvTarget);
  if (!search.matches.length) {
    recommendationCandidates = search.closest ? [search.closest] : [];
    const closest = search.closest
      ? `<p>Best exact, tabulated candidate: <b>${search.closest.ettv.toFixed(2)} W/m²</b> using ${escapeHtml(search.closest.wall.label)}, ${escapeHtml(search.closest.glass.label)}, and ${escapeHtml(search.closest.scenario.label)}. <button class="soft-btn" type="button" data-try-recommendation="0">Try this combination below</button></p>`
      : '<p>No complete exact candidate could be calculated. Review façade areas, material inputs, and shading pairing.</p>';
    el('recommendation-results').innerHTML = `<p>No non-estimated combination from the available website presets met ≤ ${ettvTarget} W/m².</p>${closest}<small>Search tested ${search.tested} candidates; ${search.estimated} relied on an estimated SC lookup and were excluded from target-meeting recommendations.</small>`;
    return;
  }

  recommendationCandidates = search.matches;
  const rows = search.matches.map((candidate, index) => `<tr>
    <td>${escapeHtml(candidate.wall.label)}</td>
    <td>${escapeHtml(candidate.glass.label)}</td>
    <td>${candidate.glass.uf.toFixed(2)}</td>
    <td>${candidate.glass.scGlass.toFixed(2)}</td>
    <td>${escapeHtml(candidate.scenario.label)}</td>
    <td><b>${candidate.ettv.toFixed(2)}</b></td>
    <td><button class="soft-btn" type="button" data-try-recommendation="${index}">Try this</button></td>
  </tr>`).join('');
  el('recommendation-results').innerHTML = `<p><b>${search.matches.length} options shown</b> (up to 12), ordered closest to the target; ${search.tested} total combinations tested. The website applies workbook SC, not SHGC.</p>
    <div class="recommendation-table-scroll"><table class="recommendation-table"><thead><tr><th>Opaque wall preset / Uw (W/m²K)</th><th>Glazing preset</th><th>Glazing U (W/m²K)</th><th>Glass SC</th><th>Shading scenario</th><th>ETTV (W/m²)</th><th>Try</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
el('run-recommendations').addEventListener('click', searchMaterialCombinations);
el('recommendation-results').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-try-recommendation]');
  if (!button) return;
  const candidate = recommendationCandidates[Number(button.dataset.tryRecommendation)];
  if (!candidate) return;

  el('material-wall-preset').value = String(candidate.wall.value);
  el('material-glass-preset').value = candidate.glass.value;
  for (const dir of facadeDirections) {
    if (candidate.scenario.id === 'none') {
      shadingModes[dir] = 'manual';
      ettvSettings[dir].hpr = 0;
      ettvSettings[dir].vpr = 0;
    } else {
      shadingModes[dir] = candidate.scenario.id;
    }
  }
  presentMaterialState();
  el('apply-materials').click();
  el('material-controls').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

function saveEttvCsv() {
  if (!materialsApplied||!ettvResults) return;
  const headers = ['Orientation','Wall Area (m2)','Window Area (m2)','Gross Area (m2)','WWR','CF','Uw (W/m2K)','Uf (W/m2K)','Glass SC','Shading Mode','Horizontal blade inclination deg (measured/manual)','Vertical fin inclination deg (measured/manual)','Measured H PR','Measured V PR','Effective SC Projection','SC Total','Opaque Gain (W/m2)','Glazing Conduction (W/m2)','Solar Gain (W/m2)','ETTV (W/m2)','SC Method','Estimated SC (not compliance)','Notes'];
  const value = (v) => (v === null || v === undefined ? '' : String(v).replaceAll('"','""'));
  const quote = (v) => `"${value(v)}"`;
  const rows = ettvResults.facades.map((f) => [directionNames[f.orientation],f.wall,f.window,f.area,f.wwr,f.cf,f.uw,f.uf,f.scGlass,shadingModes[f.orientation],shadingEvaluations[f.orientation]?.bladeAngle ?? (shadingEvaluations[f.orientation]?.horizontalInclinationVaries ? 'per-panel' : ettvSettings[f.orientation].bladeAngle),shadingEvaluations[f.orientation]?.verticalBladeAngle ?? (shadingEvaluations[f.orientation]?.verticalInclinationVaries ? 'per-panel' : ettvSettings[f.orientation].verticalBladeAngle), measuredShading?.byOrientation[f.orientation]?.horizontalRatio, measuredShading?.byOrientation[f.orientation]?.verticalRatio,f.scProjection,f.scTotal,f.opaqueGain,f.glazingConduction,f.solarGain,f.ettv,[f.lookup?.note,shadingEvaluations[f.orientation]?.note,shadingEvaluations[f.orientation]?.tableIds?.join('/'),shadingEvaluations[f.orientation]?.sourceCells?.join(';')].filter(Boolean).join(' | '), f.estimated?'YES':'NO', f.reason ?? 'Preliminary - verify exterior conditioned envelope'].map(quote).join(','));
  rows.push(['TOTAL','','',ettvResults.totalArea,'','','','','','','','','','','','','',ettvResults.overall,'',ettvResults.facades.some(f=>f.estimated)?'YES':'NO','Preliminary area-weighted ETTV'].map(quote).join(','));
  const blob = new Blob(['\ufeff',headers.map(quote).join(','),'\r\n',rows.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url;a.download = 'facadescan_ettv_by_orientation.csv';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
populateMaterialPresets();
renderEttvRows();
el('apply-materials').addEventListener('click', () => {
  if(!el('material-wall-preset').value||!el('material-glass-preset').value||!ettvGeometry)return;
  const uw = Number(el('material-wall-preset').value);
  const [uf, scGlass] = el('material-glass-preset').value.split('|').map(Number);
  for (const d of facadeDirections) {
    Object.assign(ettvSettings[d], { uw, uf, scGlass });
    for (const key of ['uw','uf','scGlass']) el('ettv-rows').querySelector(`[data-et-dir="${d}"][data-et-key="${key}"]`).value = ettvSettings[d][key];
  }
  materialsApplied=true;
  recalculateEttv();
  el('material-apply-status').textContent = 'Applied to all façades. ETTV updated.';
});
for (const id of ['material-wall-preset','material-glass-preset']) {
  el(id).addEventListener('change', () => {
    materialsApplied=false;ettvResults=null;presentMaterialState();
    el('material-apply-status').textContent = 'Selection changed. Apply to update ETTV.';
  });
}
el('ettv-rows').addEventListener('change', (event) => {
  const select=event.target.closest('select[data-mode-dir]');
  if(!select)return;
  shadingModes[select.dataset.modeDir]=select.value;
  recalculateEttv();
});
for(const [id,mode] of [['shading-actual','auto-both'],['shading-h-only','auto-horizontal'],['shading-v-only','auto-vertical'],['shading-manual','manual']]){
  el(id).addEventListener('click',()=>{
    for(const d of facadeDirections) shadingModes[d]=mode;
    if(mode==='manual') ettvWorkspace.open = true;
    recalculateEttv();
  });
}
el('ettv-rows').addEventListener('input', (event) => {
  const input = event.target.closest('input[data-et-dir]');
  if (!input) return;
  if ((input.dataset.etKey==='hpr'||input.dataset.etKey==='vpr') && shadingModes[input.dataset.etDir]!=='manual') return;
  const { etDir: d, etKey: k } = input.dataset;
  // Empty cells / intermediate edits intentionally produce N/A rather than interpreting an empty field as zero.
  ettvSettings[d][k] = input.value.trim() === '' ? NaN : Number(input.value);
  recalculateEttv();
});
el('export-shading').addEventListener('click',()=>{
  if(!measuredShading)return;
  const headers=['Window','Orientation','Level','Segment','Glass area m2','Window width m','Window height m','H shading name','H depth m','H PR','H inclination deg','H status','V shading name','V depth m','V PR','V inclination deg','V status','Matching status'];
  const values=measuredShading.windows.map(w=>[w.window,w.orientation,w.level,w.segment,w.area_m2,w.width_m,w.height_m,w.h?.shade,w.h?.depth_m,w.h?.ratio,w.h?.inclination_deg,w.h?.status,w.v?.shade,w.v?.depth_m,w.v?.ratio,w.v?.inclination_deg,w.v?.status,w.status]);
  const esc=(v)=>'"'+String(v??'').replaceAll('"','""')+'"';
  const rows=[headers,...values].map(row=>row.map(esc).join(','));
  const blob=new Blob(['\ufeff'+rows.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='facadescan_window_shading_geometry.csv';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
});

function saveCsv() {
  const keys = ['name', 'layer', 'category', 'level', 'segment', 'orientation', 'geometric_orientation', 'geometric_azimuth_deg', 'exact_area_m2', 'mesh_area_m2', 'mesh_minus_exact_m2', 'visual_material', 'id'];
  const csvCell = (value) => {
    let s = String(value ?? '');
    if (/^[=+@]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const rows = [keys.map(csvCell).join(',')].concat(Object.values(allRecords).filter((r) => r.in_glb && r.exact_area_m2 != null).map((r) => keys.map((key) => csvCell(r[key])).join(',')));
  const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');a.href = url;a.download = 'facadescan_rhino_exact_areas.csv';a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function resetView() {
  if (!homeCamera) return;
  camera.position.copy(homeCamera.position);
  controls.target.copy(homeCamera.target);
  controls.update();
}
function setResize() {
  const w = modelContainer.clientWidth;
  const h = modelContainer.clientHeight;
  if (w < 1 || h < 1) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;camera.updateProjectionMatrix();
}
new ResizeObserver(setResize).observe(modelContainer);
let down = null;
renderer.domElement.addEventListener('pointerdown', (event) => { down = { x: event.clientX, y: event.clientY }; });
renderer.domElement.addEventListener('pointerup', (event) => {
  if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) { down = null; return; }
  down = null;
  const box = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - box.left) / box.width) * 2 - 1;
  mouse.y = -((event.clientY - box.top) / box.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObjects(meshes.filter((o) => o.visible && recordFor(o)?.exact_area_m2 != null), false)[0];
  selectMesh(hit?.object || null);
});
renderer.domElement.addEventListener('pointermove', (event) => {
  if (event.buttons || !meshes.length) { tip.hidden = true;return; }
  const box = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - box.left) / box.width) * 2 - 1;
  mouse.y = -((event.clientY - box.top) / box.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObjects(meshes.filter((o) => o.visible && recordFor(o)?.exact_area_m2 != null), false)[0];
  renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
  if (!hit) {tip.hidden = true;return;}
  const rec = recordFor(hit.object);
  const wallGroup=rec.category==='WALL'?wallAreaGroups(allRecords,rec.orientation).find(g=>g.level===(rec.level==null?'Unassigned':String(rec.level))):null;
  const label = rec.category === 'WALL'
    ? `Opaque wall · ${directionNames[rec.orientation] || rec.orientation}`
    : rec.name;
  tip.innerHTML = `<b>${escapeHtml(label)}</b><br/>${wallGroup?`Level ${escapeHtml(wallGroup.level)} · Total wall: ${formatArea(wallGroup.area)}<br/>${wallGroup.count} panels · net opaque area`:`Selected surface: ${formatArea(rec.exact_area_m2)}`}`;
  tip.hidden = false;
  tip.style.left = Math.min(box.width - 205, event.clientX - box.left + 18) + 'px';
  tip.style.top = Math.max(0, event.clientY - box.top - 45) + 'px';
});
renderer.domElement.addEventListener('pointerleave', () => {tip.hidden = true;});
el('floor').addEventListener('change', (event) => {state.floor = event.target.value;applyFilters();});
el('search').addEventListener('input', (event) => {state.search = event.target.value.toLowerCase().trim();applyFilters();});
el('show-all').addEventListener('click', () => {
  state.category = Object.fromEntries(cats.map((c) => [c, c !== 'REFERENCE']));
  state.direction = 'ALL';state.floor = 'ALL';state.search = '';
  el('floor').value = 'ALL';el('search').value = '';
  renderFilters();applyFilters();
});
el('reset-camera').addEventListener('click', resetView);
el('download-results').addEventListener('click', saveCsv);

function animate() { requestAnimationFrame(animate);controls.update();renderer.render(scene, camera); }
setResize();animate();

async function init() {
  try {
    if (activeModelKey === 'upload') {
      el('loader').hidden = true;
      el('file-import-status').textContent = 'Select the exported GLB, manifest JSON, and audit JSON together to import your Rhino model.';
      return;
    }
    const [areasResp, auditResp] = await Promise.all([
      fetch(`${base}data/${activeModel.manifestFile}`), fetch(`${base}data/${activeModel.auditFile}`)
    ]);
    if (!areasResp.ok || !auditResp.ok) throw new Error(`Area or audit JSON data is unavailable for ${activeModel.name}.`);
    const manifest = await areasResp.json();
    const report = await auditResp.json();
    const gltf = await new GLTFLoader().loadAsync(`${base}model/${activeModel.modelFile}`);
    if(workflowMode==='create')return;
    installModel(manifest, report, gltf);
    // Both the Rhino export format and supplied benchmarks are checked against loaded GLB nodes.
    const glbNames = new Set(meshes.map(mesh => mesh.name));
    const measuredRecords = Object.values(allRecords).filter(rec => rec?.in_glb && Number.isFinite(rec.exact_area_m2));
    const missingRecords = measuredRecords.filter(rec => !glbNames.has(rec.name));
    const areaDifferences = measuredRecords.filter(rec => rec.mesh_minus_exact_m2 != null && Math.abs(rec.mesh_minus_exact_m2) > 0.01);
    const orientationMismatches = measuredRecords.filter(rec =>
      ['WALL', 'WINDOW'].includes(rec.category) && rec.geometric_orientation &&
      rec.orientation !== rec.geometric_orientation);
    const dirs = [...new Set(measuredRecords.filter(rec => ['WALL','WINDOW'].includes(rec.category))
      .map(rec => rec.orientation).filter(dir => eightDirections.includes(dir)))];
    const loadedCount = measuredRecords.length - missingRecords.length;
    const expectedCount = audit?.total_objects ?? audit?.csv_measured ?? measuredRecords.length;
    const countNote = expectedCount !== measuredRecords.length ? ` · audit count ${expectedCount} vs manifest ${measuredRecords.length}` : '';
    el('audit-status').textContent = `${loadedCount}/${measuredRecords.length} exact-area surfaces matched · ${areaDifferences.length} area differences >0.01 m² · ${orientationMismatches.length} layer/normal mismatches · ${dirs.length}/8 orientations detected${countNote}`;
    if (missingRecords.length || areaDifferences.length || orientationMismatches.length) {
      console.warn('FacadeScan geometry audit requires review:', {missingRecords,areaDifferences,orientationMismatches});
    }
    el('loader').hidden = true;
    el('error-message').hidden = true;
    if (requestedStep === 2 || requestedStep === 3) goToStep(requestedStep);
    else if (workflowMode) goToStep(1);
    else {
      el('workflow-stepper').hidden = true;
      el('mode-choice').hidden = false;
      for (const panel of stepPanels) panel.hidden = true;
    }
  } catch (err) {
    console.error(err);
    el('loader').hidden = true;
    el('error-message').hidden = false;
    el('error-message').textContent = `Unable to load the model: ${err.message}. Run the viewer with npm run dev (do not open index.html via file://).`;
  }
}

function installModel(manifest, report, gltf) {
  resetMaterialChoice();
  el('edit-own-geometry').hidden = manifest.source !== 'browser-editor';
  const generated=manifest.source === 'browser-editor';
  document.querySelector('.overview .data-label').textContent = generated ? 'Surface areas from editor polygons' : 'Surface areas from Rhino';
  document.querySelector('.side-notice p').innerHTML = generated ? '<b>Editor geometry</b><br/>Areas come from drawn polygons. Window openings are subtracted from walls.' : '<b>Verified data</b><br/>Areas are taken from the RhinoCommon export and matched to GLB mesh names.';
  if (root) {
    scene.remove(root);
    root.traverse((node) => {
      if (!node.isMesh) return;
      node.geometry.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => material.dispose());
    });
  }
  const existingGrid = scene.getObjectByName('facadescan-grid');
  if (existingGrid) {
    scene.remove(existingGrid);
    existingGrid.geometry.dispose();
    existingGrid.material.dispose();
  }
  if (state.highlight) {
    scene.remove(state.highlight);
    state.highlight.geometry.dispose();
    state.highlight.material.dispose();
  }

  meshes = [];
  geometryItems = [];
  state.selected = null;
  state.highlight = null;
  renderInspector(null);
  allRecords = manifest.objects;
  audit = report;
  root = gltf.scene;
  scene.add(root);
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (!node.isMesh) return;
    const rec = allRecords[node.name] || null;
    node.userData.record = rec;
    configureMesh(node);
    meshes.push(node);
  });
  geometryItems = meshes.filter((node) => node.userData.record).map((node) => {
    const position = node.geometry.getAttribute('position');
    const vertices = [];
    const point = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld);
      vertices.push([point.x, point.y, point.z]);
    }
    return { record: node.userData.record, vertices };
  });
  measuredShading = analyzeShadingGeometry(geometryItems);

  const bounds = new THREE.Box3().setFromObject(root);
  const envelopeBounds = new THREE.Box3();
  for (const mesh of meshes) {
    const category = recordFor(mesh)?.category;
    if (category === 'WALL' || category === 'WINDOW') envelopeBounds.expandByObject(mesh);
  }
  const framingBounds = envelopeBounds.isEmpty() ? bounds : envelopeBounds;
  const center = framingBounds.getCenter(new THREE.Vector3());
  const size = framingBounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 0.5);
  const gridRadius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.5, radius);
  const grid = new THREE.GridHelper(gridRadius * 2.6, 26, '#446179', '#263d52');
  grid.name = 'facadescan-grid';
  grid.position.y = bounds.min.y - 0.07;
  grid.material.transparent = true;
  grid.material.opacity = 0.28;
  scene.add(grid);
  controls.target.copy(center);
  const viewDirection = new THREE.Vector3(1.25, 0.78, 1.45).normalize();
  const fitDistance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 1.15;
  camera.position.copy(center).addScaledVector(viewDirection, fitDistance);
  camera.near = 0.03;
  camera.far = Math.max(fitDistance + gridRadius * 4, 200);
  camera.updateProjectionMatrix();
  controls.minDistance = Math.max(radius * 0.08, 0.5);
  controls.maxDistance = Math.max(fitDistance * 4, radius * 7);
  homeCamera = { position: camera.position.clone(), target: controls.target.clone() };
  controls.update();

  state.category = Object.fromEntries(cats.map((category) => [category, category !== 'REFERENCE']));
  state.direction = 'ALL';
  state.floor = 'ALL';
  state.search = '';
  el('floor').value = 'ALL';
  el('search').value = '';
  renderFilters();
  applyFilters();
  summary();
  renderLayerMapping();
  ettvGeometry = aggregateEnvelope(allRecords);
  recalculateEttv();

  const glbNames = new Set(meshes.map((mesh) => mesh.name));
  const measuredRecords = Object.values(allRecords).filter((record) =>
    record?.in_glb && Number.isFinite(record.exact_area_m2));
  const missingRecords = measuredRecords.filter((record) => !glbNames.has(record.name));
  const areaDifferences = measuredRecords.filter((record) =>
    record.mesh_minus_exact_m2 != null && Math.abs(record.mesh_minus_exact_m2) > 0.01);
  const orientationMismatches = measuredRecords.filter((record) =>
    ['WALL', 'WINDOW'].includes(record.category) && record.geometric_orientation &&
    record.orientation !== record.geometric_orientation);
  const dirs = [...new Set(measuredRecords.filter((record) => ['WALL', 'WINDOW'].includes(record.category))
    .map((record) => record.orientation).filter((direction) => eightDirections.includes(direction)))];
  const loadedCount = measuredRecords.length - missingRecords.length;
  const expectedCount = audit?.total_objects ?? audit?.csv_measured ?? measuredRecords.length;
  const countNote = expectedCount !== measuredRecords.length
    ? ` · audit count ${expectedCount} vs manifest ${measuredRecords.length}` : '';
  el('audit-status').textContent =
    `${loadedCount}/${measuredRecords.length} exact-area surfaces matched · ${areaDifferences.length} area differences >0.01 m² · ${orientationMismatches.length} layer/normal mismatches · ${dirs.length}/8 orientations detected${countNote}`;
  if (missingRecords.length || areaDifferences.length || orientationMismatches.length) {
    console.warn('FacadeScan geometry audit requires review:', { missingRecords, areaDifferences, orientationMismatches });
  }
  el('loader').hidden = true;
  el('error-message').hidden = true;
  setResize();
}

designWorkspace=createDesignWorkspace({
  getState:()=>({geometry:ettvGeometry,settings:ettvSettings,results:ettvResults,ready:materialsApplied}),
  edit:(direction,values)=>{
    Object.assign(ettvSettings[direction],values);
    for(const [key,value] of Object.entries(values)){
      const input=el('ettv-rows').querySelector(`[data-et-dir="${direction}"][data-et-key="${key}"]`);
      if(input)input.value=value;
    }
    recalculateEttv();
  },
  editGeometry:()=>workflowMode==='create'?openGeometryEditor():goToStep(2)
});
init();
