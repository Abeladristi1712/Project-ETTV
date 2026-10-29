import {projectionCoefficient, directionNames} from './ettv-engine.js';
import {eggCrateCoefficient} from './eggcrate.js';
/**
 * Never average projection ratios to calculate SC. Resolve shading per-window,
 * look up its SC, then area-weight the window-specific SC Projection values.
 * All values are in metres and unitless SC / PR.
 */
export function evaluateMeasuredShading(report, direction, mode, expectedGlazingArea=null,bladeAngle=0,verticalBladeAngle=0) {
  const group=report?.windows?.filter(w=>w.orientation===direction) ?? [];
  if(!group.length) return {ok:false,reason:'No glazing surfaces found for this orientation'};
  if(report?.byOrientation?.[direction]?.unpairedShades > 0) return {ok:false,reason:`${report.byOrientation[direction].unpairedShades} shading surfaces cannot be paired with glazing; manual review required`};
  if(group.some(w=>w.status!=='matched')) return {ok:false,reason:`${group.filter(w=>w.status!=='matched').length} glazing objects need geometry/pairing review`};
  const totalArea=group.reduce((s,w)=>s+w.area_m2,0);
  if(!Number.isFinite(totalArea)||totalArea<=0) return {ok:false,reason:'Invalid window areas'};
  if(Number.isFinite(expectedGlazingArea) && Math.abs(expectedGlazingArea-totalArea)>Math.max(0.05,expectedGlazingArea*.005))
    return {ok:false,reason:'GLB glazing panels do not match the Rhino exact window-area manifest'};
  let weighted=0, combined=0, hCount=0,vCount=0,estimatedCount=0;const sourceCells=new Set(),tables=new Set(),horizontalAngles=new Set(),verticalAngles=new Set();
  const recordAngle=(angles,value)=>{if(Number.isFinite(value))angles.add(Number(value.toFixed(1)));};
  for(const w of group){
    const h=w.h?.ratio ?? 0, v=w.v?.ratio ?? 0;
    if(!Number.isFinite(h)||!Number.isFinite(v)||h<0||v<0||h>3||v>3) return {ok:false,reason:`Invalid or out-of-range projection geometry: ${w.window}`};
    if(h>0) hCount++;
    if(v>0) vCount++;
    if(mode==='auto-both'&&h>0&&v>0){
      const angle=Number.isFinite(w.h?.inclination_deg)?w.h.inclination_deg:bladeAngle;
      const verticalAngle=Number.isFinite(w.v?.inclination_deg)?w.v.inclination_deg:verticalBladeAngle;
      if(Math.abs(verticalAngle)>1e-7)return {ok:false,reason:`${w.window}: BCA egg-crate tables do not support inclined vertical fins. Use straight vertical fins or assess the vertical-only scenario.`};
      if(Math.abs(w.h?.head_gap_m??0)>1e-6)return {ok:false,reason:`${w.window}: combined shading with an offset overhang requires a separate shading assessment.`};
      recordAngle(horizontalAngles,angle);
      recordAngle(verticalAngles,verticalAngle);
      const combo=eggCrateCoefficient(h,v,directionNames[direction],angle,verticalAngle);
      if(!combo||!Number.isFinite(combo.projection)) return {ok:false,reason:`Egg-crate SC unavailable for ${w.window}: outside supported C20-C23 ratio/angle grid`};
      combined++;if(combo.estimated)estimatedCount++;(combo.sourceCells??[]).forEach(c=>sourceCells.add(c));if(combo.table)tables.add(combo.table);
      weighted+=w.area_m2*combo.projection;
      continue;
    }
    const type=mode==='auto-horizontal'?'horizontal':mode==='auto-vertical'?'vertical':h>0?'horizontal':v>0?'vertical':null;
    const ratio=type==='horizontal'?h:type==='vertical'?v:0;
    const angle=type==='horizontal'
      ? Number.isFinite(w.h?.inclination_deg)?w.h.inclination_deg:bladeAngle
      : type==='vertical'&&Number.isFinite(w.v?.inclination_deg)?w.v.inclination_deg:verticalBladeAngle;
    if(ratio>0)recordAngle(type==='horizontal'?horizontalAngles:verticalAngles,angle);
    let cf=ratio>0?projectionCoefficient(type,ratio,directionNames[direction],angle):{projection:1};
    const gap=w.h?.head_gap_m??0;
    if(type==='horizontal'&&ratio>0&&Math.abs(gap)>1e-6){
      // B5.2: subtract the shaded opaque strip above the glazing.
      // Restrict to the published flat-overhang configuration; do not silently
      // extend the method to sloped/offset combinations or beyond table limits.
      if(gap<0||Math.abs(angle)>1e-7)return {ok:false,reason:`${w.window}: offset/sloped overhang geometry needs a separate shading assessment`};
      const height=w.h.reference_m, length=w.h.blade_length_m;
      const full=projectionCoefficient('horizontal',length/(height+gap),directionNames[direction],0);
      const strip=projectionCoefficient('horizontal',length/gap,directionNames[direction],0);
      if(!full||!strip)return {ok:false,reason:`${w.window}: B5.2 gap correction is outside the SC table range`};
      const corrected=(full.projection*(height+gap)-strip.projection*gap)/height;
      if(!Number.isFinite(corrected)||corrected<0||corrected>1)return {ok:false,reason:`${w.window}: invalid B5.2 corrected shading coefficient`};
      cf={projection:corrected,table:full.table,sourceCells:[...new Set([...full.sourceCells,...strip.sourceCells])]};
    }
    if(!cf||!Number.isFinite(cf.projection))return {ok:false,reason:`SC table lookup failed for ${w.window}`};
    (cf.sourceCells??[]).forEach(c=>sourceCells.add(c));if(cf.table)tables.add(cf.table);weighted+=w.area_m2*cf.projection;
  }

  const angleLabel=(angles,fallback,property)=>angles.size===1
    ? `${[...angles][0]}°${group.some(w=>Number.isFinite(w[property]?.inclination_deg))?' measured':' manual'}`
    : angles.size>1?'per-panel measured':`${fallback}° manual`;
  const horizontalAngleLabel=angleLabel(horizontalAngles,bladeAngle,'h');
  const verticalAngleLabel=angleLabel(verticalAngles,verticalBladeAngle,'v');
  const note=mode==='auto-both'
    ? estimatedCount
      ? `DESIGN ESTIMATE: ${estimatedCount} of ${combined} combination-fin panels are below the egg-crate table limits; linear extension only, not compliance.`
      : `Workbook ${[...tables].join('/')}; ${combined} combined-fin panels; horizontal blade ${horizontalAngleLabel}. Vertical-fin inclination ${verticalAngleLabel} is measured, but the egg-crate workbook table has no separate vertical angle axis.`
    : mode==='auto-horizontal'
      ? `Horizontal-only scenario; horizontal blade ${horizontalAngleLabel}; vertical fins intentionally excluded`
      : mode==='auto-vertical'
        ? `Vertical-only scenario; vertical fin ${verticalAngleLabel}; horizontal shades intentionally excluded`
        : 'Full detected geometry';
  return {ok:true,weightedSC:weighted/totalArea,hCount,vCount,combinedCount:combined,estimatedCount,estimated:estimatedCount>0,windowCount:group.length,windowArea:totalArea,
    sourceCells:[...sourceCells],tableIds:[...tables],
    bladeAngle:horizontalAngles.size===1?[...horizontalAngles][0]:null,
    verticalBladeAngle:verticalAngles.size===1?[...verticalAngles][0]:null,
    horizontalInclinationVaries:horizontalAngles.size>1,verticalInclinationVaries:verticalAngles.size>1,note};
}
