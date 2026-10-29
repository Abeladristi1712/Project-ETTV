/**
 * Geometry-based shading measurement for vertical, planar glazing.
 * Input points are WORLD coordinates from the GLB (metres; glTF Y is up).
 * Project window/shading geometry onto the window outward normal, vertical,
 * and facade tangent. No bounding-box or area-only PR inference is used.
 *
 * A pair is accepted only if identity, orientation, floor, plan position,
 * and geometric placement are consistent. Unsupported/ambiguous objects are
 * marked for review rather than assigned a spurious projection ratio.
 */
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const mean = (a) => a.reduce((s,x)=>s+x,0)/a.length;
const span = (numbers) => [Math.min(...numbers), Math.max(...numbers)];
const width = (p) => p[1] - p[0];
const near = (a,b,t=0.2) => Math.abs(a-b) <= t;
const overlap = (a,b) => Math.max(0,Math.min(a[1],b[1]) - Math.max(a[0],b[0]));
const rel = (s)=> s.replace(/_(WIN|H|V)$/i,'');
const assocKey = (r)=> r?.name ? rel(r.name) : null;
const flatNormal = (r)=> {
  const n=r?.normal_glb;
  if(!Array.isArray(n)||n.length<3) return null;
  const mag=Math.hypot(n[0],n[2]);
  if(mag < 0.95 || Math.abs(n[1]) > 0.12) return null;
  return [n[0]/mag,0,n[2]/mag];
};
const dataFor=(entry,n)=> {
  const pts=entry.vertices;
  if (!pts || pts.length<3) return null;
  const tangent=[n[2],0,-n[0]];
  return {
    u:span(pts.map(p=>dot(p,tangent))),
    y:span(pts.map(p=>p[1])),
    d:span(pts.map(p=>dot(p,n))),
  };
};
function measurePair(windowItem, shadeItem, type, w) {
  if (!shadeItem) return {ratio:0,depth_m:0,shade:null,status:'none'};
  const wr=windowItem.record, sr=shadeItem.record;
  if(sr.orientation!==wr.orientation || sr.level!==wr.level || (sr.segment != null && wr.segment != null && sr.segment!==wr.segment)) return {ratio:null,status:'mismatched metadata'};
  let normal=w.n;
  let windowBounds=w;
  let s=dataFor(shadeItem,normal);
  if(!s) return {ratio:null,status:'missing shading vertices'};
  if(s.d[1]-w.face < 0){
    normal=normal.map(value=>-value);
    const bounds=dataFor(windowItem,normal);
    windowBounds={...bounds,n:normal,face:mean(bounds.d),height:w.height,width:w.width};
    s=dataFor(shadeItem,normal);
  }
  const inner=s.d[0]-windowBounds.face;
  const depth=s.d[1]-windowBounds.face;
  const pointsOut=depth>=0.025 && depth<=8;
  const windowTop=windowBounds.y[1];
  const verticalEdgeDistance=Math.max(0,s.y[0]-windowTop,windowTop-s.y[1]);
  const verticalNearTop=verticalEdgeDistance < Math.max(0.25,windowBounds.height*0.2);
  const touchesFacade=inner>=-0.12 && inner<=0.12;
  const horizontalOverlap=overlap(s.u,windowBounds.u)/windowBounds.width>0.50;
  const coplanar=type==='horizontal'
    ? touchesFacade && verticalNearTop && horizontalOverlap
    : touchesFacade && width(s.y)>0.4*windowBounds.height
      && (near(s.u[0],windowBounds.u[0],Math.max(0.25,windowBounds.width*0.15)) || near(s.u[0],windowBounds.u[1],Math.max(0.25,windowBounds.width*0.15))
        || near(s.u[1],windowBounds.u[0],Math.max(0.25,windowBounds.width*0.15)) || near(s.u[1],windowBounds.u[1],Math.max(0.25,windowBounds.width*0.15)))
      && overlap(s.y,windowBounds.y)/windowBounds.height>0.5;
  if(!pointsOut || !coplanar) return {ratio:null,depth_m:depth,shade:sr.name,status:'geometry placement needs review'};
  const denominator=type==='horizontal'?windowBounds.height:windowBounds.width;
  const inclination=type==='horizontal' && width(s.d)>0.025
    ? Math.atan2(width(s.y),width(s.d))*180/Math.PI
    : type==='vertical' && width(s.d)>0.025
      ? Math.atan2(width(s.u),width(s.d))*180/Math.PI
      : null;
  // BCA Appendix B: P is actual blade length, including its inclination.
  const bladeLength=Number.isFinite(inclination)?width(s.d)/Math.cos(inclination*Math.PI/180):depth;
  const ratio=bladeLength/denominator;
  const attachment=shadeItem.vertices.filter(p=>Math.abs(dot(p,normal)-s.d[0])<1e-6);
  const headGap=type==='horizontal'?mean(attachment.map(p=>p[1]))-windowTop:0;
  return {
    head_gap_m:Math.abs(headGap)<1e-6?0:headGap,
    ratio,depth_m:depth,blade_length_m:bladeLength,reference_m:denominator,shade:sr.name,
    inclination_deg:inclination,
    ...(type==='horizontal'?{horizontalInclination_deg:inclination}:{verticalInclination_deg:inclination}),
    status:ratio>3?'outside SC table range':'matched'
  };
}
export function analyzeShadingGeometry(items) {
  const records=items.filter(x=>x.record && x.vertices?.length);
  const byName=new Map(records.map(x=>[x.record.name,x]));
  const physicalWindows=records.filter(x=>x.record.category==='WINDOW');
  const windows=physicalWindows.flatMap(item=>{
    const cells=item.record.shading_cells;if(!cells)return [item];
    const valid=item.record.source==='browser-editor'&&Array.isArray(cells)&&cells.length>0&&cells.length<=900&&cells.every(c=>Number.isFinite(c.area_m2)&&c.area_m2>0&&Array.isArray(c.vertices)&&c.vertices.length===4&&c.vertices.every(p=>p.length===3&&p.every(Number.isFinite)))&&Math.abs(cells.reduce((s,c)=>s+c.area_m2,0)-item.record.exact_area_m2)<1e-5;
    if(!valid)return [{...item,arrayError:true}];
    return cells.map(c=>({record:{...item.record,name:`${item.record.name}__cell_${c.id}`,exact_area_m2:c.area_m2},vertices:c.vertices,arrayCell:c,parentWindow:item.record.name}));
  });
  const shades=records.filter(x=>x.record.category==='SHADING_H'||x.record.category==='SHADING_V');
  const paired=new Set();
  const results=[];
  for(const item of windows){
    const r=item.record,n=flatNormal(r);
    if(item.arrayError){results.push({window:r.name,orientation:r.orientation,area_m2:r.exact_area_m2,status:'invalid shading array partition',h:null,v:null});continue;}
    if(!n){results.push({window:r.name,orientation:r.orientation,level:r.level,area_m2:r.exact_area_m2,status:'window normal unsupported',h:null,v:null});continue;}
    const bounds=dataFor(item,n);
    const height=width(bounds.y),winWidth=width(bounds.u);
    if(height<=0.01||winWidth<=0.01||width(bounds.d)>0.06){results.push({window:r.name,orientation:r.orientation,level:r.level,area_m2:r.exact_area_m2,status:'glazing must be planar and vertical',h:null,v:null});continue;}
    const w={...bounds,n,face:mean(bounds.d),height,width:winWidth};
    // Explicit Rhino naming convention is essential for one-to-one pairing.
    // Never attach the nearest shading from an unrelated room/level.
    const findShade=(type)=>{
      const category=type==='horizontal'?'SHADING_H':'SHADING_V';
      if(item.arrayCell){
        const name=item.arrayCell[type==='horizontal'?'hShade':'vShade'];if(!name)return {ratio:0,depth_m:0,shade:null,status:'none'};
        const shade=byName.get(name);if(!shade||shade.record.category!==category)return {ratio:null,status:'missing array blade'};
        const measured=measurePair(item,shade,type,w);if(measured.status==='matched'||measured.status==='outside SC table range')paired.add(name);return measured;
      }
      const exact=byName.get(`${assocKey(r)}_${type==='horizontal'?'H':'V'}`);
      if(exact){
        const measured=measurePair(item,exact,type,w);
        if(measured.status==='matched'||measured.status==='outside SC table range'){
          paired.add(exact.record.name);
          return measured;
        }
      }
      const candidates=shades.filter(shade=>shade.record.category===category
        && shade.record.orientation===r.orientation && shade.record.level===r.level
        && (shade.record.segment==null || r.segment==null || shade.record.segment===r.segment));
      const matches=candidates.map(shade=>({shade,measurement:measurePair(item,shade,type,w)}))
        .filter(candidate=>candidate.measurement.status==='matched'||candidate.measurement.status==='outside SC table range');
      if(matches.length===1){
        paired.add(matches[0].shade.record.name);
        return matches[0].measurement;
      }
      if(matches.length>1) return {ratio:null,status:'multiple shading surfaces match this glazing panel'};
      if(exact) return measurePair(item,exact,type,w);
      return candidates.length ? {ratio:null,status:'same-level shading geometry needs review'} : {ratio:0,depth_m:0,shade:null,status:'none'};
    };
    const h=findShade('horizontal');
    const v=findShade('vertical');
    const good=(p)=>p.status==='matched'||p.status==='none';
    results.push({window:r.name,parentWindow:item.parentWindow,orientation:r.orientation,level:r.level,segment:r.segment,
      area_m2:r.exact_area_m2,width_m:winWidth,height_m:height,
      h,v,status:good(h)&&good(v)?'matched':'review'});
  }
  const unmatchedEntries=shades.filter(x=>!paired.has(x.record.name));
  const unmatchedShades=unmatchedEntries.map(x=>x.record.name);
  const byOrientation={};
  for(const dir of ['N','NE','E','SE','S','SW','W','NW']){
    const group=results.filter(x=>x.orientation===dir);
    const good=group.filter(x=>x.status==='matched');
    const vals=(kind)=> good.map(x=>x[kind].ratio).filter(x=>Number.isFinite(x));
    const horizontalAngles=good.map(x=>x.h.inclination_deg).filter(Number.isFinite);
    const verticalAngles=good.map(x=>x.v.inclination_deg).filter(Number.isFinite);
    const commonAngle=(angles)=>angles.length&&angles.every(value=>Math.abs(value-angles[0])<0.1)?angles[0]:null;
    const horizontalAngle=commonAngle(horizontalAngles);
    const verticalAngle=commonAngle(verticalAngles);
    const meanRatio=(kind)=> {
      const arr=vals(kind);
      return arr.length && arr.every(v=>Math.abs(v-arr[0])<1e-4) ? arr[0] : null;
    };
    byOrientation[dir]={total:group.length,matched:good.length,needsReview:group.length-good.length,
      horizontalRatio:meanRatio('h'),verticalRatio:meanRatio('v'),
      horizontalInclinationDeg:horizontalAngle,
      horizontalInclinationVaries:horizontalAngles.length>1&&horizontalAngle===null,
      verticalInclinationDeg:verticalAngle,
      verticalInclinationVaries:verticalAngles.length>1&&verticalAngle===null,
      unpairedShades:unmatchedEntries.filter(x=>x.record.orientation===dir).length,
      shadesH:good.filter(x=>x.h.ratio>0).length,shadesV:good.filter(x=>x.v.ratio>0).length};
  }
  return {windows:results,byOrientation,unmatchedShades,
    summary:{windows:results.length,physicalWindows:physicalWindows.length,matched:results.filter(w=>w.status==='matched').length,
      review:results.filter(w=>w.status!=='matched').length,unmatchedShades:unmatchedShades.length}};
}
