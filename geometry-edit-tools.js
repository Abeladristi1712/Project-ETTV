import * as THREE from 'three';
import {buildDesign,validateDesign,wallFrame,rectangle,worldPoint} from './geometry-editor-model.js';

export function arcThrough(a,b,c){
  const d=2*(a[0]*(b[1]-c[1])+b[0]*(c[1]-a[1])+c[0]*(a[1]-b[1]));
  if(Math.abs(d)<1e-8)throw Error('Arc points must not be collinear. Choose a point on the curve, then its end.');
  const q=p=>p[0]**2+p[1]**2;
  const center=[(q(a)*(b[1]-c[1])+q(b)*(c[1]-a[1])+q(c)*(a[1]-b[1]))/d,(q(a)*(c[0]-b[0])+q(b)*(a[0]-c[0])+q(c)*(b[0]-a[0]))/d];
  const angle=p=>Math.atan2(p[1]-center[1],p[0]-center[0]),tau=2*Math.PI,positive=x=>(x%tau+tau)%tau;
  const start=angle(a),end=positive(angle(c)-start),mid=positive(angle(b)-start),sweep=mid<=end?end:end-tau;
  const radius=Math.hypot(a[0]-center[0],a[1]-center[1]),steps=Math.max(2,Math.ceil(Math.abs(sweep)/(Math.PI/36)));
  const points=Array.from({length:steps+1},(_,i)=>[center[0]+radius*Math.cos(start+sweep*i/steps),center[1]+radius*Math.sin(start+sweep*i/steps)]);
  points[0]=[...a];points[steps]=[...c];return points;
}

export function rotateScaleSelection(source,meta,{kind,value,axis='z'},id){
  if(!meta||!Number.isFinite(value))throw Error('Select an object and enter a finite value.');
  if(kind==='scale'&&(value<=0||value>100))throw Error('Scale must be greater than 0 and at most 100.');
  const d=structuredClone(source),scale=kind==='scale'?value:1,theta=kind==='rotate'?value*Math.PI/180:0;
  const avg=points=>points[0].map((_,i)=>points.reduce((s,p)=>s+p[i],0)/points.length);
  const rotate2=(p,c)=>{const x=(p[0]-c[0])*scale,y=(p[1]-c[1])*scale;return [c[0]+x*Math.cos(theta)-y*Math.sin(theta),c[1]+x*Math.sin(theta)+y*Math.cos(theta)];};
  let key;
  if(meta.shadeId||meta.surfaceId){
    let surfaces;
    if(meta.shadeId){
      const built=buildDesign(source);surfaces=built.faces.filter(f=>f.userData.editor.shadeId===meta.shadeId).map(f=>({id:id(),category:f.userData.editor.category,orientation:f.userData.record.orientation,frame:structuredClone(f.userData.editor.frame),points:structuredClone(f.userData.editor.points)}));
      built.faces.forEach(f=>{f.geometry.dispose();f.material.dispose();});d.shades=d.shades.filter(s=>s.id!==meta.shadeId);d.surfaces.push(...surfaces);
    }else surfaces=[d.surfaces.find(s=>s.id===meta.surfaceId)];
    const center=new THREE.Vector3(...avg(surfaces.flatMap(s=>s.points.map(p=>worldPoint(s.frame,p)))));
    const vector={x:[1,0,0],y:[0,0,-1],z:[0,1,0]}[axis];if(!vector)throw Error('Choose X, Y or Z.');
    const rotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...vector),theta);
    for(const s of surfaces){s.frame.origin=new THREE.Vector3(...s.frame.origin).sub(center).multiplyScalar(scale).applyQuaternion(rotation).add(center).toArray();for(const k of ['u','v','normal'])s.frame[k]=new THREE.Vector3(...s.frame[k]).applyQuaternion(rotation).toArray();s.points=s.points.map(p=>p.map(x=>x*scale));}
    key=surfaces[0].id;
  }else if(meta.openingId){
    const o=d.openings.find(o=>o.id===meta.openingId),center=avg(o.points);o.points=o.points.map(p=>rotate2(p,center));key=`${o.id}_WIN`;
  }else if(meta.massId){
    if(kind==='rotate'&&axis!=='z')throw Error('Buildings rotate around vertical Z to retain vertical walls for ETTV.');
    const m=d.masses.find(m=>m.id===meta.massId),center=avg(m.footprint);
    // Architectural XY = renderer X,-Z; positive rotation is CCW viewed from above.
    m.footprint=m.footprint.map(p=>{const q=rotate2([p[0],-p[1]],[center[0],-center[1]]);return [q[0],-q[1]];});m.height*=scale;
    if(kind==='rotate')delete m.orientations;
    const openings=d.openings.filter(o=>o.host===m.id);for(const o of openings)o.points=o.points.map(p=>p.map(x=>x*scale));
    for(const s of d.shades.filter(s=>openings.some(o=>o.id===s.host))){s.depth*=scale;if(s.spacing!=null)s.spacing*=scale;}
    key=`${m.id}_${m.height<.1?'SKETCH':'ROOF'}`;
  }else throw Error('Select a building, window, or surface.');
  validateDesign(d);return {design:d,key};
}

export function addGlazingStrip(source,meta,{offset,length,height,sill},id){
  const d=structuredClone(source),m=d.masses.find(m=>m.id===meta?.massId);
  if(!m||!Number.isInteger(meta.face))throw Error('Select a wall segment first.');
  if([offset,length,height,sill].some(v=>!Number.isFinite(v))||offset<.01||length<=0||height<=0||sill<.01||sill+height>m.height-.01)throw Error('Enter positive dimensions and keep the sill/head at least 0.01 m inside the wall.');
  const first=wallFrame(m,meta.face),perimeter=m.footprint.reduce((s,_,i)=>s+wallFrame(m,i).width,0);
  if(offset>=first.width||length>perimeter-offset-.01)throw Error('Start offset must be inside the selected segment; length must be less than one perimeter.');
  let remaining=length,face=meta.face,start=offset,key;const group=id();
  for(let i=0;i<=m.footprint.length&&remaining>1e-8;i++){
    const width=wallFrame(m,face).width,span=Math.min(remaining,width-start);
    if(span*height<.01)throw Error('A strip segment is too small. Adjust length or starting offset slightly.');
    const opening={id:id(),host:m.id,face,stripGroup:group,points:rectangle([start,sill],[start+span,sill+height])};d.openings.push(opening);key??=`${opening.id}_WIN`;
    remaining-=span;face=(face+1)%m.footprint.length;start=0;
  }
  validateDesign(d);return {design:d,key};
}
