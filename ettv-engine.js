import glazingCatalog from './data/glazing-materials.json' with {type:'json'};
/* ETTV results sourced from exact Rhino areas and the user workbook SC / CF tables. */
import { lookupSC,lookupCF,lookupEggcrateWithEstimate } from './sc-lookup.js';
const correctionFactors={North:0.80,East:1.13,South:0.83,West:1.23};

const opaquePresets = [
      { label: 'Concrete · 100 mm · Uw 4.286', value: 4.286 },
      { label: 'Concrete · 150 mm · Uw 3.731', value: 3.731 },
      { label: 'Concrete · 200 mm · Uw 3.304', value: 3.304 },
      { label: 'Concrete · 250 mm · Uw 2.964', value: 2.964 },
      { label: 'Concrete · 300 mm · Uw 2.688', value: 2.688 },
      { label: 'Sand/cement plaster + concrete + sand/cement plaster · 15/100/15 · Uw 3.453', value: 3.453 },
      { label: 'Sand/cement plaster + concrete + sand/cement plaster · 15/150/15 · Uw 3.084', value: 3.084 },
      { label: 'Sand/cement plaster + concrete + sand/cement plaster · 15/200/15 · Uw 2.786', value: 2.786 },
      { label: 'Sand/cement plaster + dry brick + sand/cement plaster · 15/100/15 · Uw 2.905', value: 2.905 },
      { label: 'Sand/cement plaster + dry brick + sand/cement plaster · 15/150/15 · Uw 2.462', value: 2.462 },
      { label: 'Sand/cement plaster + dry brick + sand/cement plaster · 15/200/15 · Uw 2.137', value: 2.137 },
      { label: 'Sand/cement plaster + dry brick + sand/cement plaster · 15/230/15 · Uw 1.979', value: 1.979 },
      { label: 'Lightweight concrete · density 960 kg/m³ · 100 mm · Uw 2.024', value: 2.024 },
      { label: 'Lightweight concrete · density 960 kg/m³ · 150 mm · Uw 1.517', value: 1.517 },
      { label: 'Lightweight concrete · density 960 kg/m³ · 200 mm · Uw 1.214', value: 1.214 },
      { label: 'Lightweight concrete · density 1120 kg/m³ · 100 mm · Uw 2.208', value: 2.208 },
      { label: 'Lightweight concrete · density 1120 kg/m³ · 150 mm · Uw 1.674', value: 1.674 },
      { label: 'Lightweight concrete · density 1120 kg/m³ · 200 mm · Uw 1.348', value: 1.348 },
      { label: 'Lightweight concrete · density 1280 kg/m³ · 100 mm · Uw 2.673', value: 2.673 },
      { label: 'Lightweight concrete · density 1280 kg/m³ · 150 mm · Uw 2.088', value: 2.088 },
      { label: 'Lightweight concrete · density 1280 kg/m³ · 200 mm · Uw 1.712', value: 1.712 },
      { label: 'Sand/cement plaster + concrete + EPS insulation + gypsum plasterboard · 15/150/25/12.5 · Uw 0.922', value: 0.922 },
      { label: 'Sand/cement plaster + concrete + EPS insulation + gypsum plasterboard · 15/150/50/12.5 · Uw 0.556', value: 0.556 },
      { label: 'Sand/cement plaster + concrete + EPS insulation + gypsum plasterboard · 15/150/75/12.5 · Uw 0.398', value: 0.398 },
      { label: 'Sand/cement plaster + concrete + EPS insulation + gypsum plasterboard · 15/150/100/12.5 · Uw 0.310', value: 0.31 },
      { label: 'Sand/cement plaster + concrete + polyurethane foam + gypsum plasterboard · 15/150/25/12.5 · Uw 0.709', value: 0.709 },
      { label: 'Sand/cement plaster + concrete + polyurethane foam + gypsum plasterboard · 15/150/50/12.5 · Uw 0.408', value: 0.408 },
      { label: 'Sand/cement plaster + dry brick + glass wool + gypsum plasterboard · 15/100/50/12.5 · Uw 0.550', value: 0.55 },
      { label: 'Custom value', value: 'custom' }
    ];

const glazingPresets = glazingCatalog.materials.map(m => ({
  ...m,
  label: `${m.name} ? U ${m.uValue.toFixed(3)} / SC ${m.sc.toFixed(3)}`,
  value: `${m.uValue}|${m.sc}|${m.id}`
})).concat({label:'Custom values',value:'custom'});


export { correctionFactors, opaquePresets, glazingPresets };
export const facadeDirections = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const directionNames = {
  N: 'North', NE: 'Northeast', E: 'East', SE: 'Southeast',
  S: 'South', SW: 'Southwest', W: 'West', NW: 'Northwest'
};
export const ettvTarget = 45;

/** Exact Rhino surface area, aggregated by named layer only. The data needs envelope verification. */
export function aggregateEnvelope(objects) {
  const areas = Object.fromEntries(facadeDirections.map((orientation) => [orientation, { orientation, wall: 0, window: 0, count: 0 }]));
  for (const rec of Object.values(objects ?? {})) {
    if (!rec?.in_glb || !Number.isFinite(rec.exact_area_m2) || rec.exact_area_m2 < 0) continue;
    if (!facadeDirections.includes(rec.orientation)) continue;
    const d = areas[rec.orientation];
    if (rec.category === 'WALL') { d.wall += rec.exact_area_m2; d.count++; }
    if (rec.category === 'WINDOW') { d.window += rec.exact_area_m2; d.count++; }
  }
  return areas;
}

export function projectionCoefficient(type,ratio,orientation,angle=0) {
  if(ratio===0)return {projection:1,estimated:false,sourceCells:[],table:'none',note:'No external shading'};
  if(!Number.isFinite(ratio)||ratio<0)return null;
  return lookupSC(type,orientation,{ratio,angle});
}

/** Return null ETTV for invalid inputs or unsupported simultaneous H+V shading. */
export function calculateFacade(geometry, settings) {
  const { orientation, wall = 0, window = 0 } = geometry;
  const area = wall + window;
  const wwr = area > 0 ? window / area : null;
  const cf = lookupCF(orientation, settings.pitchAngle ?? 90)?.value;
  const uw = Number(settings.uw), uf = Number(settings.uf), scGlass = Number(settings.scGlass);
  const hpr = Number(settings.hpr), vpr = Number(settings.vpr);
  const valid = Number.isFinite(area) && area > 0 && Number.isFinite(wall) && wall >= 0 && Number.isFinite(window) && window >= 0 &&
    Number.isFinite(cf) && Number.isFinite(uw) && uw > 0 && Number.isFinite(uf) && uf > 0 && Number.isFinite(scGlass) && scGlass > 0 && scGlass <= 1 / 0.87 &&
    Number.isFinite(hpr) && hpr >= 0 && hpr <= 3 && Number.isFinite(vpr) && vpr >= 0 && vpr <= 3;
  const base = { orientation, wall, window, area, wwr, cf, uw, uf, scGlass, hpr, vpr };
  if (!valid) return { ...base, ettv: null, reason: 'Invalid or missing area/material/shading inputs', scProjection: null, scTotal: null };
  if (settings.unsupportedCombined) return { ...base, ettv: null, reason: 'Shading pairing/geometry is unsupported or incomplete; review panel-level matching and ratio ranges', scProjection: null, scTotal: null };
  const hasOverride = Number.isFinite(settings.effectiveSCProjection) && settings.effectiveSCProjection > 0 && settings.effectiveSCProjection <= 1;
  
  const activeType = hpr>0 && vpr>0 ? 'eggcrate' : hpr > 0 ? 'horizontal' : vpr > 0 ? 'vertical' : 'none';
  const activeRatio = hpr > 0 ? hpr : vpr;
  const lookup = hasOverride ? {projection: settings.effectiveSCProjection, estimated:!!settings.estimatedSCProjection, note: settings.shadingMethod || 'Area-weighted from individual Rhino glazing panels; check shading scenario'} : activeType === 'none' ? { projection: 1, note: 'No external shading' } : activeType==='eggcrate' ? lookupEggcrateWithEstimate(directionNames[orientation],hpr,vpr,settings.bladeAngle ?? 0,settings.verticalBladeAngle ?? 0) : projectionCoefficient(activeType, activeRatio, directionNames[orientation],activeType==='vertical' ? settings.verticalBladeAngle ?? 0 : settings.bladeAngle ?? 0);
  if (!lookup) return { ...base, ettv: null, reason: 'SC lookup not available', scProjection: null, scTotal: null };
  const scProjection = lookup.projection;
  const scTotal = scGlass * scProjection;
  const opaqueGain = 12 * (1 - wwr) * uw;
  const glazingConduction = 3.4 * wwr * uf;
  const solarGain = 211 * wwr * cf * scTotal;
  const ettv = opaqueGain + glazingConduction + solarGain;
  return { ...base, scProjection, scTotal, ettv, estimated:!!lookup.estimated, reason: null, activeType, lookup, opaqueGain, glazingConduction, solarGain };
}

export function calculateBuilding(geometry, settingsByOrientation) {
  const facades = facadeDirections.map((dir) => calculateFacade(geometry[dir] ?? { orientation: dir }, settingsByOrientation[dir] ?? {}));
  const totalArea = facades.reduce((sum, f) => sum + f.area, 0);
  const active = facades.filter((f) => f.area > 0);
  const canAggregate = active.length > 0 && active.every((f) => f.ettv !== null) && totalArea > 0;
  const overall = canAggregate ? active.reduce((sum, f) => sum + f.area * f.ettv, 0) / totalArea : null;
  return { facades, overall, totalArea, canAggregate };
}
