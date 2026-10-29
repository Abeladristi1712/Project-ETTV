import * as THREE from 'three';

// The camera and sketch plane are independent: navigation never edits the sketch.
export function createGeometryNavigation(container,camera,controls,fit){
  // Architectural coordinates: X east, Y north, Z up.
  // The renderer stores these as (x, z, -y) so existing models remain compatible.
  const axes=[['X',[1,0,0],'#ed7777'],['−X',[-1,0,0],'#ed7777'],['Y',[0,0,-1],'#80d69a'],['−Y',[0,0,1],'#80d69a'],['Z',[0,1,0],'#78afff'],['−Z',[0,-1,0],'#78afff']];
  container.setAttribute('aria-label','View orientation. Drag to orbit; click an axis to align.');
  const nodes=axes.map(([label,direction,color])=>{
    const button=document.createElement('button');button.type='button';button.textContent=label;button.title=`Look from ${label}`;button.style.setProperty('--axis-color',color);container.append(button);
    button.onclick=()=>{if(moved)return;const distance=camera.position.distanceTo(controls.target);camera.up.set(0,1,0);camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(...direction),distance);controls.update();};
    return {button,direction:new THREE.Vector3(...direction)};
  });
  const home=document.createElement('button');home.type='button';home.className='geometry-axis-home';home.textContent='⌂';home.title='Fit model in 3D';home.setAttribute('aria-label','Fit model in 3D');home.onclick=()=>{if(!moved)fit();};container.append(home);
  let drag=null,moved=false;
  container.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();drag={x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY};moved=false;e.target.setPointerCapture(e.pointerId);});
  container.addEventListener('pointermove',e=>{if(!drag)return;if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>4)moved=true;if(!moved)return;
    const offset=camera.position.clone().sub(controls.target),s=new THREE.Spherical().setFromVector3(offset);s.theta-=(e.clientX-drag.lastX)*.012;s.phi-=(e.clientY-drag.lastY)*.012;s.makeSafe();camera.up.set(0,1,0);camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(s));controls.update();drag.lastX=e.clientX;drag.lastY=e.clientY;
  });
  container.addEventListener('pointerup',()=>{drag=null;});container.addEventListener('pointercancel',()=>{drag=null;moved=true;});
  return ()=>{const inverse=camera.quaternion.clone().invert();for(const {button,direction} of nodes){const p=direction.clone().applyQuaternion(inverse);button.style.left=`${58+p.x*40}px`;button.style.top=`${58-p.y*40}px`;button.style.zIndex=String(Math.round(10+p.z*5));button.style.opacity=p.z<-.1?'.55':'1';}};
}
