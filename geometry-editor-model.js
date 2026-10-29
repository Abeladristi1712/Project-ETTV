import * as THREE from 'three';

export const EDITOR_COLORS={WALL:'#ef943d',WINDOW:'#45a9ef',SHADING_H:'#9964e8',SHADING_V:'#ed77ba',ROOF:'#8d9baa',FLOOR:'#64798b',REFERENCE:'#94a3b8'};
export const DIRECTIONS=['N','NE','E','SE','S','SW','W','NW'];
export const emptyDesign=()=>({version:1,masses:[],openings:[],shades:[],surfaces:[]});
export const polygonArea=p=>Math.abs(signedArea(p));
const signedArea=p=>p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a[0]*b[1]-b[0]*a[1];},0)/2;
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const onSegment=(p,a,b)=>Math.abs(cross(a,b,p))<1e-8 && p[0]>=Math.min(a[0],b[0])-1e-8 && p[0]<=Math.max(a[0],b[0])+1e-8 && p[1]>=Math.min(a[1],b[1])-1e-8 && p[1]<=Math.max(a[1],b[1])+1e-8;
function intersects(a,b,c,d){
  if([cross(a,b,c)*cross(a,b,d),cross(c,d,a)*cross(c,d,b)].every(x=>x<0))return true;
  return onSegment(a,c,d)||onSegment(b,c,d)||onSegment(c,a,b)||onSegment(d,a,b);
}
function inside(p,poly){
  let yes=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const a=poly[i],b=poly[j];if(onSegment(p,a,b))return true;
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])yes=!yes;
  }return yes;
}
function overlap(a,b){return a.some((p,i)=>b.some((q,j)=>intersects(p,a[(i+1)%a.length],q,b[(j+1)%b.length])))||inside(a[0],b)||inside(b[0],a);}
export function validatePolygon(points){
  if(!Array.isArray(points)||points.length<3||points.length>128||points.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v)||Math.abs(v)>1000)))throw Error('Draw a closed polygon with 3–128 points within 1,000 m.');
  for(let i=0;i<points.length;i++){
    if(Math.hypot(points[i][0]-points[(i+1)%points.length][0],points[i][1]-points[(i+1)%points.length][1])<.001)throw Error('Remove duplicate or zero-length edges.');
    for(let j=i+1;j<points.length;j++){
      if(j===i+1||(i===0&&j===points.length-1))continue;
      if(intersects(points[i],points[(i+1)%points.length],points[j],points[(j+1)%points.length]))throw Error('Polygon edges must not cross or touch each other.');
    }
  }
  if(polygonArea(points)<.01)throw Error('The face must have at least 0.01 m² of area.');
}
export function rectangle(a,b){return [[Math.min(a[0],b[0]),Math.min(a[1],b[1])],[Math.max(a[0],b[0]),Math.min(a[1],b[1])],[Math.max(a[0],b[0]),Math.max(a[1],b[1])],[Math.min(a[0],b[0]),Math.max(a[1],b[1])]];}
export function circle(a,b){const r=Math.hypot(b[0]-a[0],b[1]-a[1]);return Array.from({length:48},(_,i)=>[a[0]+r*Math.cos(i*Math.PI/24),a[1]+r*Math.sin(i*Math.PI/24)]);}
export function orientationFor(normal){const a=(Math.atan2(normal[0],-normal[2])*180/Math.PI+360)%360;return DIRECTIONS[Math.round(a/45)%8];}
export function wallFrame(mass,index){
  const p=mass.footprint[index],q=mass.footprint[(index+1)%mass.footprint.length];
  const width=Math.hypot(q[0]-p[0],q[1]-p[1]),u=[(q[0]-p[0])/width,0,(q[1]-p[1])/width];
  return {origin:[p[0],mass.base,p[1]],u,v:[0,1,0],normal:[u[2],0,-u[0]],width,height:mass.height};
}
export function worldPoint(frame,p){return frame.origin.map((v,i)=>v+frame.u[i]*p[0]+frame.v[i]*p[1]);}
export function normalizeMass(m){return {...m,footprint:signedArea(m.footprint)<0?[...m.footprint].reverse():m.footprint};}
export function footprintOnPlane(id,points,frame){
  if(Math.abs(frame.normal[1])<1-1e-6)throw Error('Building footprints need a horizontal surface. Draw on a roof, floor, or ground plane.');
  const world=points.map(p=>worldPoint(frame,p));
  return normalizeMass({id,footprint:world.map(p=>[p[0],p[2]]),base:world[0][1],height:0});
}
export function shadeLayout(shade,opening){
  const h=shade.category==='SHADING_H',axis=h?1:0,values=opening.points.map(p=>p[axis]),span=Math.max(...values)-Math.min(...values),count=shade.count??1;
  if(!Number.isInteger(count)||count<1||count>30)throw Error('Blade count must be an integer from 1 to 30.');
  const spacing=count===1?span:shade.spacing??span/count;
  if(!Number.isFinite(spacing)||spacing<.01||(count-1)*spacing>=span-.009)throw Error('Blade spacing must leave at least 0.01 m of glazing after the last blade.');
  if(count>1){const xs=opening.points.map(p=>p[0]),ys=opening.points.map(p=>p[1]);if(opening.points.length!==4||Math.abs(polygonArea(opening.points)-(Math.max(...xs)-Math.min(...xs))*(Math.max(...ys)-Math.min(...ys)))>1e-6)throw Error('Multiple blades currently require a rectangular window.');}
  return {count,spacing,intervals:Array.from({length:count},(_,i)=>({from:i*spacing,to:i===count-1?span:(i+1)*spacing}))};
}
function validFrame(f){
  if(!f||['origin','u','v','normal'].some(k=>!Array.isArray(f[k])||f[k].length!==3||f[k].some(x=>!Number.isFinite(x)||Math.abs(x)>1000)))throw Error('Invalid drawing plane.');
  const u=new THREE.Vector3(...f.u),v=new THREE.Vector3(...f.v),n=new THREE.Vector3(...f.normal);
  if(Math.abs(u.length()-1)>1e-6||Math.abs(v.length()-1)>1e-6||Math.abs(n.length()-1)>1e-6||Math.abs(u.dot(v))>1e-6||Math.abs(n.dot(u))>1e-6||Math.abs(n.dot(v))>1e-6)throw Error('Drawing plane axes must be orthonormal.');
}
export function validateDesign(d,{assessment=false}={}){
  if(d?.version!==1||['masses','openings','shades','surfaces'].some(k=>!Array.isArray(d[k])||d[k].length>300))throw Error('Invalid or oversized FacadeScan design file.');
  const ids=new Set();for(const item of [...d.masses,...d.openings,...d.shades,...d.surfaces]){
    if(typeof item.id!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(item.id)||ids.has(item.id))throw Error('Invalid or duplicate object ID.');ids.add(item.id);
  }
  for(const m of d.masses){
    validatePolygon(m.footprint);
    if(signedArea(m.footprint)<=0)throw Error('Footprint winding must be counterclockwise.');
    if(!Number.isFinite(m.base)||m.base<0||m.base>200||!Number.isFinite(m.height)||m.height<0||m.height>200)throw Error('Elevation and height must be between 0 and 200 m.');
    if(assessment&&m.height<.1)throw Error('Push/pull every wall footprint to a height of at least 0.1 m before assessing materials.');
    for(const dir of Object.values(m.orientations??{}))if(!DIRECTIONS.includes(dir))throw Error('Unknown wall orientation.');
  }
  for(let i=0;i<d.masses.length;i++)for(let j=i+1;j<d.masses.length;j++){
    const a=d.masses[i],b=d.masses[j];
    const stacked=(a.height>=.1&&Math.abs(a.base+a.height-b.base)<1e-7)||(b.height>=.1&&Math.abs(b.base+b.height-a.base)<1e-7);
    if(!stacked&&Math.min(a.base+a.height,b.base+b.height)>=Math.max(a.base,b.base)&&overlap(a.footprint,b.footprint))throw Error('Building volumes must not touch or overlap sideways or intersect. Stack on a roof, or use one polyline footprint for connected volumes at the same elevation.');
  }
  for(const o of d.openings){
    const m=d.masses.find(m=>m.id===o.host);
    if(!m||!Number.isInteger(o.face)||o.face<0||o.face>=m.footprint.length)throw Error('Window needs an existing wall face.');
    validatePolygon(o.points);const f=wallFrame(m,o.face);
    const sideMargin=o.stripGroup? -1e-8:.01;
    if(o.points.some(([x,y])=>x<sideMargin||y<.01||x>f.width-sideMargin||y>f.height-.01))throw Error('Keep windows inside the wall, at least 0.01 m from its edges.');
    for(const b of d.openings)if(b!==o&&b.host===o.host&&b.face===o.face&&overlap(o.points,b.points))throw Error('Windows must not overlap or touch.');
  }
  for(const s of d.shades){
    if(!Number.isFinite(s.inclination??0)||(s.inclination??0)<0||(s.inclination??0)>50)throw Error('Shading inclination must be between 0 and 50 degrees.');
    if(!d.openings.some(o=>o.id===s.host)||!['SHADING_H','SHADING_V'].includes(s.category)||!Number.isFinite(s.depth)||s.depth<.025||s.depth>3)throw Error('Shades need a window and a projection between 0.025 and 3 m.');
    shadeLayout(s,d.openings.find(o=>o.id===s.host));
    if(d.shades.some(b=>b!==s&&b.host===s.host&&b.category===s.category))throw Error('Use one horizontal and one vertical shade per window.');
  }
  for(const s of d.surfaces){
    validatePolygon(s.points);validFrame(s.frame);
    if(!['ROOF','FLOOR','SHADING_H','SHADING_V'].includes(s.category))throw Error('Unsupported surface layer.');
    if(['SHADING_H','SHADING_V'].includes(s.category)&&!DIRECTIONS.includes(s.orientation))throw Error('Assign a shading orientation.');
  }
  if(assessment&&!d.masses.some(m=>m.height>=.1))throw Error('Create and push/pull a wall footprint before assessing materials.');
  return d;
}
function surfaceGeometry(points,holes,frame){
  const outer=points.map(p=>new THREE.Vector2(...p)),inner=holes.map(h=>h.map(p=>new THREE.Vector2(...p)));
  const faces=THREE.ShapeUtils.triangulateShape(outer,inner),all=[...outer,...inner.flat()];
  const coordinates=all.flatMap(p=>worldPoint(frame,[p.x,p.y]));
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(coordinates,3));geometry.setIndex(faces.flat());geometry.computeVertexNormals();return geometry;
}
export function buildDesign(d,{assessment=false}={}){
  validateDesign(d,{assessment});const group=new THREE.Group(),objects={},faces=[];
  const add=(name,category,points,frame,meta={},holes=[])=>{
    const orientation=['WALL','WINDOW','SHADING_H','SHADING_V'].includes(category)?meta.orientation??orientationFor(frame.normal):null;
    const area=polygonArea(points)-holes.reduce((s,p)=>s+polygonArea(p),0);
    const rec={id:name,name,category,orientation,layer:orientation?`${category}::${orientation}`:category,exact_area_m2:area,mesh_area_m2:area,mesh_minus_exact_m2:0,in_glb:true,normal_glb:frame.normal,geometric_orientation:orientation,level:1,segment:meta.segment??null,geometry_type:'Browser editor triangulated planar surface',source:'browser-editor',...meta};
    const mesh=new THREE.Mesh(surfaceGeometry(points,holes,frame),new THREE.MeshBasicMaterial({color:EDITOR_COLORS[category],side:THREE.DoubleSide,transparent:category==='WINDOW',opacity:category==='WINDOW'?.75:1}));
    mesh.name=name;mesh.userData={record:rec,editor:{...meta,key:name,category,frame,points,holes}};group.add(mesh);objects[name]=rec;faces.push(mesh);return mesh;
  };
  for(const m of d.masses){
    const horizontal={origin:[0,m.base,0],u:[1,0,0],v:[0,0,1],normal:[0,-1,0]};
    if(m.height<.1){const sketch=add(`${m.id}_SKETCH`,'REFERENCE',m.footprint,horizontal,{massId:m.id,kind:'footprint'});sketch.material.polygonOffset=true;sketch.material.polygonOffsetFactor=-2;sketch.material.polygonOffsetUnits=-2;continue;}
    add(`${m.id}_FLOOR`,'FLOOR',m.footprint,horizontal,{massId:m.id,kind:'floor'});
    add(`${m.id}_ROOF`,'ROOF',m.footprint,{...horizontal,origin:[0,m.base+m.height,0],normal:[0,1,0]},{massId:m.id,kind:'roof'});
    m.footprint.forEach((_,i)=>{
      const frame=wallFrame(m,i),orientation=m.orientations?.[i]??orientationFor(frame.normal),segment=`${m.id}_${i}`;
      const openings=d.openings.filter(o=>o.host===m.id&&o.face===i);
      add(`${segment}_WALL`,'WALL',rectangle([0,0],[frame.width,frame.height]),frame,{massId:m.id,face:i,kind:'wall',orientation,segment},openings.map(o=>o.points));
      for(const o of openings){
        const prefix=`${o.id}`,meta={massId:m.id,face:i,openingId:o.id,kind:'window',orientation,segment};
        const windowMesh=add(`${prefix}_WIN`,'WINDOW',o.points,frame,meta);
        const xs=o.points.map(p=>p[0]),ys=o.points.map(p=>p[1]),left=Math.min(...xs),right=Math.max(...xs),bottom=Math.min(...ys),top=Math.max(...ys);
        const attached=d.shades.filter(s=>s.host===o.id),bands={};
        for(const shade of attached){
          const h=shade.category==='SHADING_H';
          const layout=shadeLayout(shade,o);bands[h?'h':'v']=[];
          for(const [index,interval] of layout.intervals.entries()){
          const origin=worldPoint(frame,[h?left:left+interval.from,h?top-interval.from:bottom]);
          const angle=(shade.inclination??0)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
          const outward=frame.normal.map((n,i)=>n*c+(h?-frame.v[i]:frame.u[i])*s);
          const sf=h?{origin,u:frame.u,v:outward,normal:frame.v.map((v,i)=>v*c+frame.normal[i]*s)}:{origin,u:outward,v:frame.v,normal:frame.u.map((v,i)=>v*c-frame.normal[i]*s)};
          const length=shade.depth/c;
          const name=`${prefix}_${h?'H':'V'}${index?'_'+(index+1):''}`;
          add(name,shade.category,rectangle([0,0],[h?right-left:length,h?length:top-bottom]),sf,{...meta,kind:'shade',shadeId:shade.id,bladeIndex:index});
          bands[h?'h':'v'].push({...interval,shade:name});
          }
        }
        if(attached.some(s=>(s.count??1)>1)){
          const horizontal=bands.h??[{from:0,to:top-bottom,shade:null}],vertical=bands.v??[{from:0,to:right-left,shade:null}];
          windowMesh.userData.record.shading_cells=horizontal.flatMap((h,hi)=>vertical.map((v,vi)=>({id:`${hi}_${vi}`,area_m2:(h.to-h.from)*(v.to-v.from),hShade:h.shade,vShade:v.shade,vertices:rectangle([left+v.from,top-h.to],[left+v.to,top-h.from]).map(p=>worldPoint(frame,p))})));
        }
      }
    });
  }
  for(const s of d.surfaces)add(s.id,s.category,s.points,s.frame,{surfaceId:s.id,kind:'surface',orientation:s.orientation});
  return {group,faces,manifest:{source:'browser-editor',objects},audit:{source:'browser-editor',total_objects:faces.length,notes:['Areas are computed from editor polygons in metres; circular faces use 48 straight segments.','Window polygons are subtracted from host walls. Stacked volumes may meet at horizontal floor/roof planes; intersecting or side-touching volumes are rejected.']}};
}
export function deleteSelection(d,selection){
  if(selection.shadeId)d.shades=d.shades.filter(s=>s.id!==selection.shadeId);
  else if(selection.openingId){d.openings=d.openings.filter(o=>o.id!==selection.openingId);d.shades=d.shades.filter(s=>s.host!==selection.openingId);}
  else if(selection.surfaceId)d.surfaces=d.surfaces.filter(s=>s.id!==selection.surfaceId);
  else if(selection.massId){const removed=d.openings.filter(o=>o.host===selection.massId).map(o=>o.id);d.shades=d.shades.filter(s=>!removed.includes(s.host));d.openings=d.openings.filter(o=>o.host!==selection.massId);d.masses=d.masses.filter(m=>m.id!==selection.massId);}
}

// Public offsets use architectural X east, Y north, Z up.
export function transformSelection(source,selection,offset,duplicate,newId){
  if(!selection||offset.length!==3||offset.some(v=>!Number.isFinite(v)))throw Error('Select an object and enter finite X, Y and Z distances.');
  const d=structuredClone(source),delta=[offset[0],offset[2],-offset[1]],clone=x=>structuredClone(x);
  let key;
  if(selection.shadeId&&(source.shades.find(s=>s.id===selection.shadeId)?.count??1)>1){
    const built=buildDesign(source);
    for(const face of built.faces.filter(f=>f.userData.editor.shadeId===selection.shadeId)){
      const m=face.userData.editor,surface={id:newId(),category:m.category,orientation:face.userData.record.orientation,frame:clone(m.frame),points:clone(m.points)};
      surface.frame.origin=surface.frame.origin.map((v,i)=>v+delta[i]);d.surfaces.push(surface);key??=surface.id;
    }
    for(const face of built.faces){face.geometry.dispose();face.material.dispose();}
    if(!duplicate)d.shades=d.shades.filter(s=>s.id!==selection.shadeId);
    validateDesign(d);return {design:d,key};
  }
  if(selection.shadeId||selection.surfaceId){
    // A separately moved/copied attached shade becomes an independent surface.
    let surface=selection.surfaceId?d.surfaces.find(s=>s.id===selection.surfaceId):{id:newId(),category:selection.category,orientation:buildDesign(source).manifest.objects[selection.key].orientation,frame:clone(selection.frame),points:clone(selection.points)};
    if(duplicate){surface=clone(surface);surface.id=newId();d.surfaces.push(surface);}
    else if(selection.shadeId){d.shades=d.shades.filter(s=>s.id!==selection.shadeId);d.surfaces.push(surface);}
    surface.frame.origin=surface.frame.origin.map((v,i)=>v+delta[i]);key=surface.id;
  }else if(selection.openingId){
    let o=d.openings.find(o=>o.id===selection.openingId),f=wallFrame(d.masses.find(m=>m.id===o.host),o.face);
    const dot=a=>a.reduce((s,v,i)=>s+v*delta[i],0);
    if(Math.abs(dot(f.normal))>1e-6)throw Error('Move windows along their host wall only; the offset cannot leave the wall plane.');
    if(duplicate){const old=o.id;o=clone(o);o.id=newId();d.openings.push(o);d.shades.push(...d.shades.filter(s=>s.host===old).map(s=>({...clone(s),id:newId(),host:o.id})));}
    o.points=o.points.map(p=>[p[0]+dot(f.u),p[1]+dot(f.v)]);key=`${o.id}_WIN`;
  }else if(selection.massId){
    let m=d.masses.find(m=>m.id===selection.massId);
    if(duplicate){const old=m.id;m=clone(m);m.id=newId();d.masses.push(m);const windows=d.openings.filter(o=>o.host===old);for(const o of windows){const next={...clone(o),id:newId(),host:m.id};d.openings.push(next);d.shades.push(...d.shades.filter(s=>s.host===o.id).map(s=>({...clone(s),id:newId(),host:next.id})));}}
    m.footprint=m.footprint.map(p=>[p[0]+delta[0],p[1]+delta[2]]);m.base+=delta[1];key=`${m.id}_${m.height<.1?'SKETCH':'ROOF'}`;
  }else throw Error('Select a building, window or surface first.');
  validateDesign(d);return {design:d,key};
}
