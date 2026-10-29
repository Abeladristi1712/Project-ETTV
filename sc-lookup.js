/** Single source of SC/CF truth: cell-by-cell extraction from the supplied 2026 workbook. */
import workbook from './data/bca_ettv_tables.json' with {type: 'json'};

export const sourceWorkbook = workbook;
export const directionCodes = ['N','NE','E','SE','S','SW','W','NW'];
const longToShort = {North:'N',NorthEast:'NE',Northeast:'NE',East:'E',SouthEast:'SE',Southeast:'SE',South:'S',SouthWest:'SW',Southwest:'SW',West:'W',NorthWest:'NW',Northwest:'NW'};
const EPS=1e-8;
const keyDir = d => directionCodes.includes(d) ? d : longToShort[d];
const tableByDir = (type, d) => Object.entries(workbook.tables).find(([,t])=>t.type===type && t.orientations.includes(keyDir(d)));
function interval(axis,x){
  if(!Number.isFinite(x)||x<axis[0]-EPS||x>axis.at(-1)+EPS)return null;
  if(Math.abs(x-axis[0])<EPS)return [0,0,0];
  for(let i=1;i<axis.length;i++){
    if(Math.abs(x-axis[i])<EPS)return [i,i,0];
    if(x<axis[i])return [i-1,i,(x-axis[i-1])/(axis[i]-axis[i-1])];
  }
  return null;
}
function weightedCells(axes,vals,cells,coordinates){
  const bounds=axes.map((a,i)=>interval(a,coordinates[i]));
  if(bounds.some(x=>!x))return null;
  const cornerRows = [];
  function visit(depth,indices,weight){
    if(depth===bounds.length){
      const get=(a,ids)=>ids.reduce((acc,i)=>acc[i],a);
      cornerRows.push({value:get(vals,indices),cell:get(cells,indices),weight});return;
    }
    const [lo,hi,t]=bounds[depth];
    if(lo===hi)visit(depth+1,[...indices,lo],weight);
    else {visit(depth+1,[...indices,lo],weight*(1-t));visit(depth+1,[...indices,hi],weight*t);}
  }
  visit(0,[],1);
  return {projection:cornerRows.reduce((s,v)=>s+v.value*v.weight,0),
    sourceCells:[...new Set(cornerRows.map(x=>x.cell))],
    exact:bounds.every(([i,j])=>i===j),
    interpolation:bounds.reduce((s,[i,j])=>s+(i!==j?1:0),0),
    corners:cornerRows};
}
/** type: horizontal, vertical, or eggcrate. Returns null for unavailable/outside tabulated ratios. */
export function lookupSC(type,orientation,{ratio,r1,r2,angle=0}={}){
  if(!['horizontal','vertical','eggcrate'].includes(type))return null;
  const found=tableByDir(type,orientation);if(!found)return null;
  const [id,t]=found;
  const result=type==='eggcrate'
    ?weightedCells([t.r1_ratios,t.r2_ratios,t.angles_deg],t.values,t.source_cells,[r1,r2,angle])
    :weightedCells([t.ratios,t.angles_deg],t.values,t.source_cells,[ratio,angle]);
  if(!result)return null;
  return {...result,table:id,kind:type,angle,estimated:false,
    note:`Workbook ${id} ${result.exact?'exact':'interpolated'} at ${angle}°; ${result.sourceCells.join(', ')}`};
}
export function lookupCF(orientation,pitch=90){
  const j=directionCodes.indexOf(keyDir(orientation));if(j<0)return null;
  const t=workbook.cf;
  const axis=interval(t.pitch_angles_deg,pitch);if(!axis)return null;
  const [a,b,f]=axis;
  const v=t.values[a][j]*(1-f)+t.values[b][j]*f;
  return {value:v,pitch,orientation:keyDir(orientation),sourceCells:a===b?[t.source_cells[a][j]]:[t.source_cells[a][j],t.source_cells[b][j]],exact:a===b,table:'C1'};
}
/** Below egg-crate table minima: an explicitly disclosed DESIGN-ONLY linear extension.
 * Uses same-angle H-only at R2=0 and table R2=.2. This is NOT a tabulated BCA SC. */
export function lookupEggcrateWithEstimate(orientation,r1,r2,angle=0,verticalAngle=0){
  if(!Number.isFinite(r1)||!Number.isFinite(r2)||r1<0||r2<0)return null;
  if(r1===0&&r2===0)return {projection:1,estimated:false,table:'none',sourceCells:[],note:'No shading'};
  if(r1===0)return lookupSC('vertical',orientation,{ratio:r2,angle:verticalAngle});
  if(r2===0)return lookupSC('horizontal',orientation,{ratio:r1,angle});
  // BCA B2.3.3: only the horizontal component may be inclined.
  if(!Number.isFinite(verticalAngle)||Math.abs(verticalAngle)>1e-7)return null;
  const tabulated=lookupSC('eggcrate',orientation,{r1,r2,angle});if(tabulated)return tabulated;
  if(!tableByDir('eggcrate',orientation)||r1>1.8||r2>1.8||r1<0||r2<0||angle<0||angle>40)return null;
  if(r1>=.2 && r2<.2){
    const h=lookupSC('horizontal',orientation,{ratio:r1,angle});
    const edge=lookupSC('eggcrate',orientation,{r1,r2:.2,angle});
    if(!h||!edge)return null;
    return {projection:h.projection+(edge.projection-h.projection)*(r2/.2),estimated:true,table:edge.table,angle,
      sourceCells:[...new Set([...h.sourceCells,...edge.sourceCells])],exact:false,
      note:'DESIGN ESTIMATE ONLY: linear extension below egg-crate R2=0.2. NOT a BCA tabulated/compliance result.'};
  }
  if(r1<.2&&r2>=.2){
    const v=lookupSC('vertical',orientation,{ratio:r2,angle:verticalAngle});
    const edge=lookupSC('eggcrate',orientation,{r1:.2,r2,angle});
    if(!v||!edge)return null;
    return {projection:v.projection+(edge.projection-v.projection)*(r1/.2),estimated:true,table:edge.table,angle,
      sourceCells:[...new Set([...v.sourceCells,...edge.sourceCells])],exact:false,
      note:'DESIGN ESTIMATE ONLY: linear extension below egg-crate R1=0.2. NOT a BCA tabulated/compliance result.'};
  }
  return null;
}
