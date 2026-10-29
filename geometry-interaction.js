import * as THREE from 'three';
import {worldPoint} from './geometry-editor-model.js';

export const architecturalCoordinates=p=>[p.x,-p.z,p.y];
export const dragAxes={x:new THREE.Vector3(1,0,0),y:new THREE.Vector3(0,0,-1),z:new THREE.Vector3(0,1,0)};
export function rectangleScreenDirections(camera,frame,anchor){
  const origin=new THREE.Vector3(...worldPoint(frame,anchor)),p=origin.clone().project(camera);
  const u=origin.clone().add(new THREE.Vector3(...frame.u)).project(camera).sub(p);
  const v=origin.clone().add(new THREE.Vector3(...frame.v)).project(camera).sub(p);
  // Screen Y is inverted: a negative NDC delta goes down on the canvas.
  return [Math.sign(Math.abs(u.x)>1e-7?u.x:-u.y)||1,Math.sign(Math.abs(v.y)>1e-7?-v.y:v.x)||1];
}
export function surfaceSnapPoints(meta){
  const result=[],seen=new Set();
  for(const ring of [meta.points,...(meta.holes??[])])for(let i=0;i<ring.length;i++){
    const a=new THREE.Vector3(...worldPoint(meta.frame,ring[i])),b=new THREE.Vector3(...worldPoint(meta.frame,ring[(i+1)%ring.length]));
    for(const [kind,point] of [['Endpoint',a],['Midpoint',a.clone().lerp(b,.5)]]){
      const key=point.toArray().map(v=>v.toFixed(7)).join(',');if(seen.has(key))continue;seen.add(key);result.push({kind,point});
    }
  }return result;
}
export function constrainedDragDelta(ray,anchor,normal,axis,step){
  let delta;
  if(axis){
    // Intersect a plane that contains the axis and faces the camera ray.
    const planeNormal=ray.direction.clone().addScaledVector(axis,-ray.direction.dot(axis));
    if(planeNormal.lengthSq()<1e-10)return null;
    const p=ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal.normalize(),anchor),new THREE.Vector3());
    if(!p)return null;delta=axis.clone().multiplyScalar(Math.round(p.sub(anchor).dot(axis)/step)*step);
  }else{
    const p=ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal,anchor),new THREE.Vector3());if(!p)return null;
    delta=p.sub(anchor);
    // Quantize in the drawing plane, preserving the host wall constraint.
    const u=new THREE.Vector3().crossVectors(normal,Math.abs(normal.y)<.9?new THREE.Vector3(0,1,0):new THREE.Vector3(0,0,1)).normalize(),v=new THREE.Vector3().crossVectors(normal,u).normalize();
    delta=u.clone().multiplyScalar(Math.round(delta.dot(u)/step)*step).addScaledVector(v,Math.round(delta.dot(v)/step)*step);
  }return delta;
}
