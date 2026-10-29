import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';
import { aggregateEnvelope, calculateBuilding, facadeDirections, directionNames, opaquePresets, glazingPresets, ettvTarget } from './ettv-engine.js';
import { analyzeShadingGeometry } from './shading-geometry.js';
import { evaluateMeasuredShading } from './shading-calculation.js';
import {lookupSC, lookupCF,lookupEggcrateWithEstimate,sourceWorkbook} from './sc-lookup.js';

const base = import.meta.env?.BASE_URL || './';
const palette = {
  WALL: { name: 'Opaque wall', color: '#c1a68a' },
  WINDOW: { name: 'Glazing', color: '#4fbbeb' },
  SHADING_H: { name: 'Horizontal shading', color: '#f8ae62' },
  SHADING_V: { name: 'Vertical shading', color: '#a58bf6' },
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
let homeCamera = null;
let ettvGeometry = null;
let ettvResults = null;
let measuredShading = null;
let shadingEvaluations = {};
const shadingModes = Object.fromEntries(facadeDirections.map(d => [d,'auto-both']));
const ettvSettings = Object.fromEntries(facadeDirections.map((dir) => [dir, {
  uw: 1.517, uf: 2.72, scGlass: 0.8, hpr: 0, vpr: 0, bladeAngle: 0
}]));
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tip = el('tooltip');
const formatArea = (a) => a == null ? '—' : Number(a).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' m²';
const num = (a) => Number(a).toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (a) => Number.isFinite(a) ? (a * 100).toFixed(2) + '%' : '—';
const escapeHtml = (v) => String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);

function categoryFor(mesh) { return mesh.userData.record?.category || 'REFERENCE'; }
function recordFor(mesh) { return mesh.userData.record || null; }
function computedColor(cat) { return palette[cat]?.color || palette.REFERENCE.color; }
function configureMesh(mesh) {
  const category = categoryFor(mesh);
  const mat = new THREE.MeshStandardMaterial({
    color: computedColor(category), side: THREE.DoubleSide,
    metalness: category === 'WINDOW' ? 0.15 : 0.02,
    roughness: category === 'WINDOW' ? 0.18 : 0.79,
    transparent: category === 'WINDOW', opacity: category === 'WINDOW' ? 0.78 : 1,
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
    mesh.material.color.lerp(new THREE.Color('#ffffff'), 0.20);
    mesh.material.emissive.set('#0f8291');
    mesh.material.emissiveIntensity = 0.38;
    state.highlight = new THREE.BoxHelper(mesh, '#fbf8d0');
    state.highlight.material.transparent = true;
    state.highlight.material.opacity = 0.9;
    scene.add(state.highlight);
  }
  renderInspector(mesh && recordFor(mesh));
}
function valueRow(key, value) { return `<div class="keyval"><span>${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>`; }
function renderInspector(rec) {
  if (!rec) {
    el('details-inner').innerHTML = '<div class="empty-selection"><div class="empty-icon">▱</div><strong>No element selected</strong><p>Select a wall, window, or shading surface in the 3D model.</p></div>';
    return;
  }
  const isEnvelope = rec.category === 'WALL' || rec.category === 'WINDOW';
  el('details-inner').innerHTML = `
    <div class="selected-badge">${escapeHtml(palette[rec.category]?.name || rec.category)}</div>
    <div class="selection-name">${escapeHtml(rec.name)}</div>
    <div class="selection-layer">${escapeHtml(rec.layer)}</div>
    <div class="area-card"><label>RHINO EXACT SURFACE AREA</label><b>${formatArea(rec.exact_area_m2)}</b><small>Trimmed Brep face / RhinoCommon</small></div>
    ${valueRow('Orientation (layer)', rec.orientation || '—')}
    ${valueRow('Orientation (normal)', rec.geometric_orientation || 'Not applicable')}
    ${valueRow('Azimuth (normal)', rec.geometric_azimuth_deg == null ? 'Not applicable' : rec.geometric_azimuth_deg + '°')}
    ${valueRow('Level', rec.level == null ? '—' : `Level ${rec.level}`)}
    ${valueRow('Façade segment', rec.segment == null ? '—' : `B${String(rec.segment).padStart(2, '0')}`)}
    ${valueRow('GLB mesh area', formatArea(rec.mesh_area_m2))}
    ${valueRow('Area difference', rec.mesh_minus_exact_m2 == null ? '—' : rec.mesh_minus_exact_m2.toFixed(5) + ' m²')}
    ${valueRow('Visual material (GLB)', rec.visual_material || '—')}
    ${isEnvelope ? valueRow('Thermal U-value (current ETTV input)', rec.category === 'WALL' ? ettvSettings[rec.orientation]?.uw ?? '—' : ettvSettings[rec.orientation]?.uf ?? '—') : ''}
    ${rec.category === 'WINDOW' ? valueRow('Glass SC (current ETTV input)', ettvSettings[rec.orientation]?.scGlass ?? '—') : ''}
    ${rec.category === 'WINDOW' ? (()=>{const w=measuredShading?.windows.find(x=>x.window===rec.name);return w ? valueRow('Auto H projection depth / PR', w.h?.ratio==null ? w.h?.status : `${w.h.depth_m.toFixed(3)} m / ${w.h.ratio.toFixed(3)}`)+valueRow('Auto V projection depth / PR', w.v?.ratio==null ? w.v?.status : `${w.v.depth_m.toFixed(3)} m / ${w.v.ratio.toFixed(3)}`)+valueRow('Shading matching status',w.status) : '';})() : ''}
    ${isEnvelope ? valueRow('Façade ETTV (current calculation)', ettvResults?.facades?.find((f) => f.orientation === rec.orientation)?.ettv?.toFixed(2) ?? 'N/A') : ''}
    ${valueRow('Rhino geometry', rec.geometry_type)}
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
  el('orientation-filters').innerHTML = ['ALL', 'N', 'E', 'S', 'W'].map((dir) => `<button class="chip ${state.direction === dir ? 'active' : ''}" data-dir="${dir}" aria-pressed="${state.direction === dir}">${dir === 'ALL' ? 'All' : dir}</button>`).join('');
  el('orientation-filters').querySelectorAll('[data-dir]').forEach((button) => button.addEventListener('click', () => {
    state.direction = button.dataset.dir;
    renderFilters();applyFilters();
  }));
}
function summary() {
  const out = { WALL: 0, WINDOW: 0 };
  const orientations = Object.fromEntries(['N', 'E', 'S', 'W'].map((d) => [d, { wall: 0, window: 0 }]));
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
  el('orientation-rows').innerHTML = Object.entries(orientations).map(([dir, value]) => {
    const total = value.wall + value.window;
    const wallP = value.wall / total * 100;
    const glassP = value.window / total * 100;
    return `<div class="direction-row"><strong>${dir}</strong><div class="bar-track" title="Opaque ${formatArea(value.wall)}; glazing ${formatArea(value.window)}"><span class="bar-wall" style="width:${wallP}%"></span><span class="bar-window" style="width:${glassP}%"></span></div><span class="num">${num(total)} m²</span><span class="percent">${pct(value.window / total)}</span></div>`;
  }).join('');
}

function populateMaterialPresets() {
  const wall = el('material-wall-preset');
  const glass = el('material-glass-preset');
  wall.innerHTML = opaquePresets.filter((o) => o.value !== 'custom').map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  glass.innerHTML = glazingPresets.filter((o) => o.value !== 'custom').map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  wall.value = '1.517';
  glass.value = '2.72|0.8';
}
function renderEttvRows() {
  el('ettv-rows').innerHTML = facadeDirections.map((d) => {
    const label = directionNames[d];
    const getInput = (key, min, max, step) => `<input type="number" data-et-dir="${d}" data-et-key="${key}" min="${min}" max="${max}" step="${step}" value="${ettvSettings[d][key]}" aria-label="${label} ${key}">`;
    return `<tr data-ettv-row="${d}"><td><b>${label}</b></td><td data-et-output="area">—</td><td data-et-output="wall">—</td><td data-et-output="window">—</td><td data-et-output="wwr">—</td><td data-et-output="cf">—</td>
      <td>${getInput('uw', 0.01, 10, 0.01)}</td><td>${getInput('uf', 0.01, 10, 0.01)}</td><td>${getInput('scGlass', 0.01, 1, 0.01)}</td>
      <td><select class="shading-mode" data-mode-dir="${d}" aria-label="${label} shading scenario"><option value="auto-both">Auto / actual H+V</option><option value="auto-horizontal">Auto / H-only scenario</option><option value="auto-vertical">Auto / V-only scenario</option><option value="manual">Manual override</option></select></td>
      <td title="Manual input: fin tilt, not extracted from Rhino geometry. Egg-crate uses horizontal-fin angle (0–40°); single-fin tables support 0–50°.">${getInput('bladeAngle', 0, 50, 1)}</td><td>${getInput('hpr', 0, 3, 0.01)}</td><td>${getInput('vpr', 0, 3, 0.01)}</td>
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
  }
}
function recalculateEttv() {
  if (!ettvGeometry) return;
  shadingEvaluations={};
  const settings={};
  for(const dir of facadeDirections){
    const mode=shadingModes[dir];
    const current=ettvSettings[dir];
    if(mode==='manual'){settings[dir]={...current};continue;}
    const measurement=evaluateMeasuredShading(measuredShading,dir,mode,ettvGeometry[dir]?.window,current.bladeAngle);
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
  el('ettv-overall').textContent = r.overall === null ? 'N/A' : `${usedEstimated ? '≈ ' : ''}${r.overall.toFixed(2)} W/m²`;
  el('ettv-envelope').textContent = formatArea(r.totalArea);
  el('ettv-status').textContent = r.overall === null ? 'INCOMPLETE' : usedEstimated ? 'ESTIMATE · not compliance' : r.overall <= ettvTarget ? `≤ ${ettvTarget} · target met` : `> ${ettvTarget} · target exceeded`;
  el('ettv-alert').textContent = r.overall === null
    ? 'ETTV cannot be aggregated: unsupported shading geometry, missing matching, or invalid inputs. Inspect façade notes.'
    : usedEstimated
      ? 'DESIGN ESTIMATE — At least one projection ratio is outside the egg-crate table range; a clearly labelled linear extension is used for this preview. NOT a regulatory compliance result. Confirm source-table limits and shading geometry.'
      : 'Preliminary ETTV using values from your uploaded workbook (SC and CF); the selected fin tilt is a design input, not extracted from Rhino. Verify envelope, tilt and shading geometry before any compliance use.';
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
    const out = (key, value, title = '') => { const n = tr.querySelector(`[data-et-output="${key}"]`); n.textContent = value; n.title = title; };
    out('area', Number(f.area).toFixed(2));out('wall', Number(f.wall).toFixed(2));out('window', Number(f.window).toFixed(2));
    out('wwr', f.wwr == null ? '—' : (f.wwr * 100).toFixed(2) + '%');
    out('cf', f.cf?.toFixed(2) ?? '—');
    out('scProjection', f.scProjection == null ? 'N/A' : (f.estimated ? '≈ ' : '') + f.scProjection.toFixed(4), [f.lookup?.note,shadingEvaluations[f.orientation]?.tableIds?.join('/'),shadingEvaluations[f.orientation]?.sourceCells?.slice(0,12).join(', ')].filter(Boolean).join(' | ') || f.reason || '');
    out('scTotal', f.scTotal == null ? 'N/A' : (f.estimated ? '≈ ' : '') + f.scTotal.toFixed(4));
    out('ettv', f.ettv == null ? 'N/A' : (f.estimated ? '≈ ' : '') + f.ettv.toFixed(2), f.lookup?.note || f.reason || '');
    tr.querySelector('[data-et-output="ettv"]').className = f.ettv == null ? 'value-error' : f.estimated ? 'value-estimate' : 'value-good';
  }
  if (state.selected) renderInspector(recordFor(state.selected));
}
function saveEttvCsv() {
  if (!ettvResults) return;
  const headers = ['Orientation','Wall Area (m2)','Window Area (m2)','Gross Area (m2)','WWR','CF','Uw (W/m2K)','Uf (W/m2K)','Glass SC','Shading Mode','Horizontal blade angle deg (manual)','Measured H PR','Measured V PR','Effective SC Projection','SC Total','Opaque Gain (W/m2)','Glazing Conduction (W/m2)','Solar Gain (W/m2)','ETTV (W/m2)','SC Method','Estimated SC (not compliance)','Notes'];
  const value = (v) => (v === null || v === undefined ? '' : String(v).replaceAll('"','""'));
  const quote = (v) => `"${value(v)}"`;
  const rows = ettvResults.facades.map((f) => [directionNames[f.orientation],f.wall,f.window,f.area,f.wwr,f.cf,f.uw,f.uf,f.scGlass,shadingModes[f.orientation],ettvSettings[f.orientation].bladeAngle, measuredShading?.byOrientation[f.orientation]?.horizontalRatio, measuredShading?.byOrientation[f.orientation]?.verticalRatio,f.scProjection,f.scTotal,f.opaqueGain,f.glazingConduction,f.solarGain,f.ettv,[f.lookup?.note,shadingEvaluations[f.orientation]?.note,shadingEvaluations[f.orientation]?.tableIds?.join('/'),shadingEvaluations[f.orientation]?.sourceCells?.join(';')].filter(Boolean).join(' | '), f.estimated?'YES':'NO', f.reason ?? 'Preliminary - verify exterior conditioned envelope'].map(quote).join(','));
  rows.push(['TOTAL','','',ettvResults.totalArea,'','','','','','','','','','','','','',ettvResults.overall,'',ettvResults.facades.some(f=>f.estimated)?'YES':'NO','Preliminary area-weighted ETTV'].map(quote).join(','));
  const blob = new Blob(['\ufeff',headers.map(quote).join(','),'\r\n',rows.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url;a.download = 'facadescan_ettv_by_orientation.csv';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}
populateMaterialPresets();
renderEttvRows();
el('apply-materials').addEventListener('click', () => {
  const uw = Number(el('material-wall-preset').value);
  const [uf, scGlass] = el('material-glass-preset').value.split('|').map(Number);
  for (const d of facadeDirections) {
    Object.assign(ettvSettings[d], { uw, uf, scGlass });
    for (const key of ['uw','uf','scGlass']) el('ettv-rows').querySelector(`[data-et-dir="${d}"][data-et-key="${key}"]`).value = ettvSettings[d][key];
  }
  recalculateEttv();
});
el('ettv-rows').addEventListener('change', (event) => {
  const select=event.target.closest('select[data-mode-dir]');
  if(!select)return;
  shadingModes[select.dataset.modeDir]=select.value;
  recalculateEttv();
});
for(const [id,mode] of [['shading-actual','auto-both'],['shading-h-only','auto-horizontal'],['shading-v-only','auto-vertical']]){
  el(id).addEventListener('click',()=>{
    for(const d of facadeDirections) shadingModes[d]=mode;
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
el('export-ettv').addEventListener('click', saveEttvCsv);
el('export-shading').addEventListener('click',()=>{
  if(!measuredShading)return;
  const headers=['Window','Orientation','Level','Segment','Glass area m2','Window width m','Window height m','H shading name','H depth m','H PR','H status','V shading name','V depth m','V PR','V status','Matching status'];
  const values=measuredShading.windows.map(w=>[w.window,w.orientation,w.level,w.segment,w.area_m2,w.width_m,w.height_m,w.h?.shade,w.h?.depth_m,w.h?.ratio,w.h?.status,w.v?.shade,w.v?.depth_m,w.v?.ratio,w.v?.status,w.status]);
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
  tip.innerHTML = `<b>${escapeHtml(rec.name)}</b><br/>${formatArea(rec.exact_area_m2)}`;
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
    const [areasResp, auditResp] = await Promise.all([
      fetch(`${base}data/area_manifest.json`), fetch(`${base}data/audit_report.json`)
    ]);
    if (!areasResp.ok || !auditResp.ok) throw new Error('Area or audit JSON data is unavailable. Run tools/build_manifest.py.');
    const manifest = await areasResp.json();
    allRecords = manifest.objects;
    audit = await auditResp.json();
    const gltf = await new GLTFLoader().loadAsync(`${base}model/building.glb`);
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
    // Extract all vertex positions in GLB world coordinates and match named glazing + shading surfaces.
    const geometryItems=meshes.filter(node => node.userData.record).map(node => {
      const position=node.geometry.getAttribute('position');
      const vertices=[];
      const pt=new THREE.Vector3();
      for(let i=0;i<position.count;i++){
        pt.fromBufferAttribute(position,i).applyMatrix4(node.matrixWorld);
        vertices.push([pt.x,pt.y,pt.z]);
      }
      return {record:node.userData.record,vertices};
    });
    measuredShading=analyzeShadingGeometry(geometryItems);
    // Rhino +Z is up; the export has transformed it to glTF +Y.
    // Rhino North +Y becomes glTF -Z; Rhino East +X remains glTF +X.
    const bounds = new THREE.Box3().setFromObject(root);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z);
    const grid = new THREE.GridHelper(radius * 2.6, 26, '#446179', '#263d52');
    grid.position.y = bounds.min.y - 0.07;grid.material.transparent = true;grid.material.opacity = 0.28;
    scene.add(grid);
    controls.target.copy(center);
    camera.position.set(center.x + radius * 1.25, center.y + radius * 0.78, center.z + radius * 1.45);
    camera.near = 0.03;camera.far = Math.max(radius * 25, 200);
    camera.updateProjectionMatrix();
    controls.minDistance = Math.max(radius * 0.12, 1);
    controls.maxDistance = radius * 7;
    homeCamera = { position: camera.position.clone(), target: controls.target.clone() };
    controls.update();
    renderFilters();applyFilters();summary();
    ettvGeometry = aggregateEnvelope(allRecords);
    recalculateEttv();
    const unmatched = audit.csv_measured_without_glb_match.length;
    const nonmatchAreas = audit.mesh_area_difference_gt_0_01_m2.length;
    const orientFails = audit.orientation_mismatches_wall_window.length;
    el('audit-status').textContent = `${audit.csv_measured - unmatched}/${audit.csv_measured} exact-area objects matched · ${nonmatchAreas} mesh-area differences >0.01 m² · ${orientFails} N/E/S/W mismatches`;
    el('loader').hidden = true;
  } catch (err) {
    console.error(err);
    el('loader').hidden = true;
    el('error-message').hidden = false;
    el('error-message').textContent = `Unable to load the model: ${err.message}. Run the viewer with npm run dev (do not open index.html via file://).`;
  }
}
init();


function refreshSCInspector(){
  const type=el('lookup-type').value,dir=el('lookup-direction').value;
  const angle=Number(el('lookup-angle').value),r1=Number(el('lookup-r1').value),r2=Number(el('lookup-r2').value),pitch=Number(el('lookup-pitch').value);
  const cf=lookupCF(dir,pitch);
  const result=type==='eggcrate' ? lookupEggcrateWithEstimate(dir,r1,r2,angle) :
    lookupSC(type,dir,{ratio:type==='horizontal'?r1:r2,angle});
  const out=el('lookup-result');
  const cfDisplay=cf?`CF = ${cf.value.toFixed(4)} [${cf.sourceCells.join(', ')}]`:'CF outside Reference!C1 range';
  out.textContent=result?`SC Projection: ${result.estimated?'≈ ':''}${result.projection.toFixed(5)} • Table ${result.table} • ${cfDisplay}\n${result.note}\nSource cells: ${(result.sourceCells??[]).join(', ')}`:
    `No workbook SC value for this combination. C22/C23 egg-crate tables are not in the uploaded workbook, or ratio/angle is out of range. ${cfDisplay}`;
  out.classList.toggle('value-error',!result||!!result.estimated);
}
['lookup-type','lookup-direction','lookup-angle','lookup-r1','lookup-r2','lookup-pitch'].forEach(id=>{
  el(id).addEventListener('input',refreshSCInspector);el(id).addEventListener('change',refreshSCInspector);
});
refreshSCInspector();
