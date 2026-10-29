import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import './geometry-editor.css';
import {createGeometryNavigation} from './geometry-navigation.js';
import {surfaceSnapPoints,architecturalCoordinates,dragAxes,constrainedDragDelta,rectangleScreenDirections} from './geometry-interaction.js';
import {buildDesign,emptyDesign,rectangle,circle,footprintOnPlane,validateDesign,polygonArea,worldPoint,wallFrame,deleteSelection,transformSelection,shadeLayout,EDITOR_COLORS,DIRECTIONS} from './geometry-editor-model.js';

const $=id=>document.getElementById(id),copy=x=>JSON.parse(JSON.stringify(x));
const names={WALL:'Wall',WINDOW:'Window / glazing',SHADING_H:'Horizontal shading',SHADING_V:'Vertical shading',ROOF:'Roof',FLOOR:'Floor',REFERENCE:'Unextruded footprint'};
const ground=elevation=>({origin:[0,elevation,0],u:[1,0,0],v:[0,0,1],normal:[0,1,0]});
const storageKey='facadescan-editor-v1';
export function createGeometryEditor({onAssess,onBack}){
  let design=emptyDesign(),built=null,selected=null,tool='select',points=[],cursor=null,plane=ground(0),host=null;
  let history=[],future=[],drag=null,down=null,active=false,preview=new THREE.Group(),dimensionPoints=[],numericRectangle=false,rectangleDirections=[1,1];
  const sizeForm=$('geometry-rectangle-size'),lengthInput=$('geometry-rectangle-length'),widthInput=$('geometry-rectangle-width');
  const transformForm=$('geometry-transform');let transformMode=null,transformTarget=null;
  const view=$('geometry-editor-canvas'),scene=new THREE.Scene();scene.background=new THREE.Color('#101c2c');
  const markers=document.createElement('div'),coordinatePopup=document.createElement('div');markers.className='geometry-snap-markers';coordinatePopup.className='geometry-coordinate-popup';coordinatePopup.hidden=true;view.append(markers,coordinatePopup);
  let snapCandidates=[],hovered=null,popupPoint=null,translation=null,lockedAxis=null;
  const guides=new THREE.Group();scene.add(guides);
  const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.domElement.tabIndex=0;renderer.domElement.setAttribute('aria-label','Geometry viewport. Drag surfaces to move; right-drag to orbit.');view.prepend(renderer.domElement);
  const camera=new THREE.PerspectiveCamera(45,1,.05,5000);camera.position.set(24,22,28);
  const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,0,0);controls.enableDamping=false;
  controls.mouseButtons.RIGHT=THREE.MOUSE.ROTATE;
  controls.touches.TWO=THREE.TOUCH.DOLLY_ROTATE;
  const updateNavigation=createGeometryNavigation($('geometry-navigation'),camera,controls,fit);
  const grid=new THREE.GridHelper(100,100,'#436077','#24394e');grid.position.y=-.02;scene.add(grid,preview);
  const axes=new THREE.AxesHelper(6);axes.rotation.x=-Math.PI/2;scene.add(axes);
  const north=new THREE.ArrowHelper(new THREE.Vector3(0,0,-1),new THREE.Vector3(-8,.05,0),5,0x68e1dd);scene.add(north);
  const ray=new THREE.Raycaster(),pointer=new THREE.Vector2();
  const id=()=>`e${crypto.randomUUID().replaceAll('-','').slice(0,16)}`;
  function message(text,error=false){$('geometry-editor-status').textContent=text;$('geometry-editor-status').classList.toggle('error',error);}
  function dispose(group){group.traverse(o=>{o.geometry?.dispose();if(o.material){for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});}
  function persist(){try{localStorage.setItem(storageKey,JSON.stringify(design));$('geometry-save-status').textContent='Draft saved in this browser';}catch{$('geometry-save-status').textContent='Browser storage unavailable. Download your design to keep it.';}}
  function commit(next,label){
    try{validateDesign(next);history.push(copy(design));if(history.length>60)history.shift();future=[];design=next;rebuild();persist();message(label);return true;}catch(e){message(e.message,true);return false;}
  }
  function selectedMeta(){return built?.faces.find(m=>m.name===selected)?.userData.editor;}
  function rebuild(){
    if(built){scene.remove(built.group);dispose(built.group);}
    built=buildDesign(design);scene.add(built.group);
    for(const mesh of built.faces){
      const edges=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),new THREE.LineBasicMaterial({color:'#20394a',transparent:true,opacity:.8}));mesh.add(edges);
    }
    if(!built.faces.some(f=>f.name===selected))selected=null;
    showSelection();renderLayers();
    $('geometry-undo').disabled=!history.length;$('geometry-redo').disabled=!future.length;
    $('geometry-assess').disabled=!design.masses.some(m=>m.height>=.1);
  }
  function showSelection(){
    dimensionPoints=[];
    for(const mesh of built.faces){
      mesh.material.color.set(EDITOR_COLORS[mesh.userData.editor.category]);
      if(mesh.name===selected){mesh.material.color.lerp(new THREE.Color('white'),.3);const meta=mesh.userData.editor;
        const p=meta.points;
        if(p.length<=12)for(let i=0;i<p.length;i++){const a=worldPoint(meta.frame,p[i]),b=worldPoint(meta.frame,p[(i+1)%p.length]);dimensionPoints.push({point:new THREE.Vector3(...a).lerp(new THREE.Vector3(...b),.5),label:`${new THREE.Vector3(...a).distanceTo(new THREE.Vector3(...b)).toFixed(2)} m`});}
        const r=mesh.userData.record;$('geometry-selected').textContent=`${names[r.category]}${r.orientation?' · '+r.orientation:''} · ${r.exact_area_m2.toFixed(2)} m²`;
        const xs=p.map(p=>p[0]),ys=p.map(p=>p[1]);$('geometry-live-dimensions').textContent=`Face width ${(Math.max(...xs)-Math.min(...xs)).toFixed(2)} m · Height/depth ${(Math.max(...ys)-Math.min(...ys)).toFixed(2)} m · Net area ${r.exact_area_m2.toFixed(2)} m²`;
        const mass=design.masses.find(m=>m.id===meta.massId);if(mass)$('geometry-height').value=mass.height||3;
        if(r.orientation)$('geometry-orientation').value=r.orientation;
      }
    }
    if(!selected)$('geometry-selected').textContent='Select a surface to inspect dimensions or edit it.';
    $('geometry-delete').disabled=!selected;$('geometry-copy').disabled=!selected;$('geometry-move').disabled=!selected;$('geometry-update-orientation').disabled=!selected;
    const selectedShade=design.shades.find(s=>s.id===selectedMeta()?.shadeId);
    if(selectedShade){$('geometry-shade-depth').value=Number((selectedShade.depth/Math.cos((selectedShade.inclination??0)*Math.PI/180)).toFixed(6));$('geometry-shade-inclination').value=selectedShade.inclination??0;$('geometry-shade-count').value=selectedShade.count??1;$('geometry-shade-spacing').value=selectedShade.spacing??'';}
    updateShadeSummary();
    $('geometry-add-shade').disabled=!selectedMeta()?.openingId;
    $('geometry-dimensions').replaceChildren(...dimensionPoints.map(d=>{const span=document.createElement('span');span.textContent=d.label;d.element=span;return span;}));
    refreshMarkers(selected);
  }
  function refreshMarkers(name){
    const face=built?.faces.find(f=>f.name===name);snapCandidates=face?surfaceSnapPoints(face.userData.editor).map(s=>({...s,mesh:face})):[];
    markers.replaceChildren(...snapCandidates.map(s=>{const dot=document.createElement('span');dot.className=s.kind==='Endpoint'?'endpoint':'midpoint';s.element=dot;return dot;}));
  }
  function screenPoint(point){const p=point.clone().project(camera);return {x:(p.x*.5+.5)*view.clientWidth,y:(-.5*p.y+.5)*view.clientHeight,visible:p.z>=-1&&p.z<=1};}
  function nearSnap(e){
    const r=renderer.domElement.getBoundingClientRect();let best=null,distance=13;
    for(const s of snapCandidates){const p=screenPoint(s.point),d=Math.hypot(e.clientX-r.left-p.x,e.clientY-r.top-p.y);if(p.visible&&d<distance){best=s;distance=d;}}
    return best;
  }
  function showCoordinates(s){popupPoint=s.point.clone();const values=architecturalCoordinates(s.point).map(n=>(Math.abs(n)<.0005?0:n).toFixed(3));coordinatePopup.textContent=`${s.kind} · X ${values[0]} · Y ${values[1]} · Z ${values[2]} m`;coordinatePopup.hidden=false;}
  function clearGuides(){for(const child of [...guides.children]){guides.remove(child);dispose(child);}}
  function endTranslation(){translation=null;lockedAxis=null;clearGuides();controls.enabled=true;}
  function beginTranslation(e,mesh,snap){
    coordinatePopup.hidden=true;popupPoint=null;
    const meta=copy(mesh.userData.editor);rayAt(e);const hit=ray.intersectObject(mesh,false)[0];if(!hit&&!snap)return;
    const anchor=snap?snap.point.clone():hit.point.clone();
    const normal=meta.openingId&&!meta.shadeId?new THREE.Vector3(...meta.frame.normal):camera.getWorldDirection(new THREE.Vector3());
    translation={before:copy(design),meta,anchor,normal,start:{x:e.clientX,y:e.clientY},delta:new THREE.Vector3(),moved:false,duplicate:tool==='copy'||e.altKey,original:selected};
    controls.enabled=false;renderer.domElement.setPointerCapture(e.pointerId);
  }
  function updateTranslation(e){
    const t=translation;if(!t)return;if(Math.hypot(e.clientX-t.start.x,e.clientY-t.start.y)<4&&!t.moved)return;t.moved=true;
    rayAt(e);let axis=lockedAxis?dragAxes[lockedAxis]:null,axisName=lockedAxis;
    const windowPlane=t.meta.openingId&&!t.meta.shadeId;
    if(axis&&windowPlane&&Math.abs(axis.dot(t.normal))>1e-6){message('That axis leaves the window’s host wall. Choose an axis along the wall.',true);return;}
    if(!axis){
      const r=renderer.domElement.getBoundingClientRect(),a=screenPoint(t.anchor),mouse=new THREE.Vector2(e.clientX-r.left-a.x,e.clientY-r.top-a.y);let best=10;
      for(const [name,direction] of Object.entries(dragAxes)){
        if(windowPlane&&Math.abs(direction.dot(t.normal))>1e-6)continue;
        const b=screenPoint(t.anchor.clone().add(direction)),v=new THREE.Vector2(b.x-a.x,b.y-a.y);if(v.length()<1)continue;v.normalize();const distance=Math.abs(mouse.x*v.y-mouse.y*v.x);
        if(distance<best){axis=direction;axisName=name;best=distance;}
      }
    }
    const delta=constrainedDragDelta(ray.ray,t.anchor,t.normal,axis,Number($('geometry-snap').value)||.1);if(!delta)return;t.delta=delta;
    clearGuides();const end=t.anchor.clone().add(delta),extent=Math.max(12,delta.length()*1.4),colors={x:'#ef7777',y:'#80d69a',z:'#78afff'};
    for(const [name,direction] of Object.entries(dragAxes)){
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([t.anchor.clone().addScaledVector(direction,-extent),t.anchor.clone().addScaledVector(direction,extent)]),new THREE.LineDashedMaterial({color:colors[name],dashSize:.25,gapSize:.15,depthTest:false,transparent:true,opacity:name===axisName?1:.4}));line.computeLineDistances();guides.add(line);
    }
    const path=[t.anchor.clone(),t.anchor.clone().add(new THREE.Vector3(delta.x,0,0)),t.anchor.clone().add(new THREE.Vector3(delta.x,0,delta.z)),end];
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(path),new THREE.LineDashedMaterial({color:'#f4e9a4',dashSize:.18,gapSize:.12,depthTest:false}));line.computeLineDistances();guides.add(line);
    for(const face of built.faces){const m=face.userData.editor,s=t.meta;const belongs=s.shadeId?m.shadeId===s.shadeId:s.surfaceId?m.surfaceId===s.surfaceId:s.openingId?m.openingId===s.openingId:m.massId===s.massId;if(!belongs)continue;
      const ghost=new THREE.LineSegments(new THREE.EdgesGeometry(face.geometry),new THREE.LineBasicMaterial({color:t.duplicate?'#a3ffbd':'#ffe0a2',depthTest:false,transparent:true,opacity:.85}));ghost.position.copy(delta);guides.add(ghost);
    }
    const values=architecturalCoordinates(delta).map(v=>v.toFixed(2));$('geometry-live-dimensions').textContent=`${t.duplicate?'Copy':'Move'} preview · ΔX ${values[0]} · ΔY ${values[1]} · ΔZ ${values[2]} m · ${axisName?axisName.toUpperCase()+' parallel':'Free plane'} · X/Y/Z to lock, Esc to cancel`;
  }
  function renderLayers(){
    const list=$('geometry-layers');list.replaceChildren();
    for(const category of Object.keys(names)){
      const members=built.faces.filter(m=>m.userData.record.category===category);if(category==='REFERENCE'&&!members.length)continue;
      const details=document.createElement('details');details.open=category===$('geometry-layer').value;
      const summary=document.createElement('summary');const swatch=document.createElement('i');swatch.style.background=EDITOR_COLORS[category];summary.append(swatch,`${names[category]} (${members.length})`);details.append(summary);
      const dirs=['WALL','WINDOW','SHADING_H','SHADING_V'].includes(category)?DIRECTIONS:[null];
      for(const dir of dirs){const group=members.filter(m=>m.userData.record.orientation===dir);if(!group.length)continue;
        const button=document.createElement('button');button.type='button';button.className='geometry-layer-row';button.textContent=`${dir??'Surfaces'} · ${group.length} · ${group.reduce((s,m)=>s+m.userData.record.exact_area_m2,0).toFixed(2)} m²`;
        button.onclick=()=>{setTool('select');selected=group[0].name;showSelection();};details.append(button);
      }list.append(details);
    }
  }
  function resize(){const w=view.clientWidth,h=view.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
  new ResizeObserver(resize).observe(view);
  function fit(){
    const box=built?.faces.length?new THREE.Box3().setFromObject(built.group):new THREE.Box3(new THREE.Vector3(-8,0,-8),new THREE.Vector3(8,5,8));
    const center=box.getCenter(new THREE.Vector3()),radius=Math.max(8,box.getSize(new THREE.Vector3()).length());controls.target.copy(center);camera.up.set(0,1,0);camera.position.copy(center).add(new THREE.Vector3(1,.85,1.2).normalize().multiplyScalar(radius*1.5));controls.update();
  }
  function choosePlane(event){
    host=null;const layer=$('geometry-layer').value,mode=$('geometry-plane').value;
    const hit=event?hitAt(event):null;
    const meta=event&&(mode==='auto'||layer==='WINDOW')?hit?.userData.editor:selectedMeta();
    if(layer==='WINDOW'){
      if(!meta?.massId||!Number.isInteger(meta.face)||!['wall','window'].includes(meta.kind))throw Error('Click a wall face to start the window. Orbit with right-drag or XYZ to see the wall.');
      const mass=design.masses.find(m=>m.id===meta.massId);plane=wallFrame(mass,meta.face);host={id:mass.id,face:meta.face};
      if(hit){selected=hit.name;showSelection();}
    }else if(layer==='WALL'){
      if(mode==='ground')plane=ground(Number($('geometry-elevation').value));
      else if(meta){
        if(Math.abs(meta.frame.normal[1])<1-1e-6)throw Error('Start a building footprint on a roof or another horizontal surface. For a window, choose Window / glazing.');
        plane=ground(meta.frame.origin[1]);
      }else if(mode==='selected')throw Error('Select a roof or horizontal surface first.');
      else plane=ground(Number($('geometry-elevation').value));
    }else if(mode==='ground')plane=ground(Number($('geometry-elevation').value));
    else if(meta)plane=copy(meta.frame);
    else if(mode==='auto')plane=ground(Number($('geometry-elevation').value));
    else throw Error('Select a surface first, or use Surface under cursor.');
    if(layer==='SHADING_H'&&Math.abs(plane.normal[1])<.95)throw Error('Draw horizontal shading on the ground plane at its elevation, or select a window and use Add shade.');
    if(layer==='SHADING_V'&&Math.abs(plane.normal[1])>.1)throw Error('Vertical shading needs a vertical drawing plane. Select a window and use Add shade for an outward fin.');
  }
  function clearPreview(){for(const child of [...preview.children]){preview.remove(child);dispose(child);}}
  function cancel(){endTranslation();coordinatePopup.hidden=true;popupPoint=null;if(drag){design=drag.before;drag=null;rebuild();}down=null;points=[];cursor=null;host=null;numericRectangle=false;sizeForm.hidden=true;sizeForm.reset();transformForm.hidden=true;transformTarget=null;clearPreview();$('geometry-finish').disabled=true;}
  function setTool(next){
    cancel();tool=next;
    controls.enabled=true;controls.mouseButtons.LEFT=null;
    controls.touches.ONE=null;
    renderer.domElement.style.cursor=tool==='select'?'grab':tool==='push'?'ns-resize':'crosshair';
    document.querySelectorAll('[data-geometry-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.geometryTool===tool)));
    for(const mode of ['copy','move'])$('geometry-'+mode).setAttribute('aria-pressed',String(tool===mode));
    if(tool===next)message(tool==='select'?'Click a surface or endpoint. Drag a surface to move; right-drag to orbit. Alt-drag copies.':['copy','move'].includes(tool)?'Drag the selected surface. X / Y / Z locks an axis; press again to release. Or enter offsets below.':tool==='push'?'Drag a footprint or roof up/down, or enter a height and choose Apply height.':tool==='polyline'?'Click vertices. Click the first point or press Enter to close. Escape cancels.':'Click the first point, then click the opposite corner or circle edge. Dimensions update while drawing.');
  }
  function rayAt(event){const r=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-r.left)/r.width*2-1,-(event.clientY-r.top)/r.height*2+1);ray.setFromCamera(pointer,camera);}
  function hitAt(event){rayAt(event);const hits=ray.intersectObjects(built.faces,false);if(!hits.length)return null;return (hits.find(h=>Math.abs(h.distance-hits[0].distance)<1e-5&&h.object.userData.editor.kind==='footprint')??hits[0]).object;}
  function positionAt(event){rayAt(event);const p=ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...plane.normal),new THREE.Vector3(...plane.origin)),new THREE.Vector3());if(!p)return null;
    const snap=nearSnap(event);if(snap&&Math.abs(snap.point.clone().sub(new THREE.Vector3(...plane.origin)).dot(new THREE.Vector3(...plane.normal)))<1e-5){const q=snap.point.clone().sub(new THREE.Vector3(...plane.origin));return [q.dot(new THREE.Vector3(...plane.u)),q.dot(new THREE.Vector3(...plane.v))];}
    p.sub(new THREE.Vector3(...plane.origin));const step=Number($('geometry-snap').value)||.1;return [p.dot(new THREE.Vector3(...plane.u)),p.dot(new THREE.Vector3(...plane.v))].map(x=>Math.round(x/step)*step);
  }
  function previewPoints(){if(!points.length)return[];if(tool==='rectangle'&&cursor)return rectangle(points[0],cursor);if(tool==='circle'&&cursor)return circle(points[0],cursor);return cursor?[...points,cursor]:points;}
  function drawPreview(){clearPreview();const p=previewPoints();if(p.length<2)return;const world=p.map(x=>new THREE.Vector3(...worldPoint(plane,x)));if(tool!=='polyline')world.push(world[0]);
    preview.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(world),new THREE.LineBasicMaterial({color:EDITOR_COLORS[$('geometry-layer').value],depthTest:false})));
    const xs=p.map(p=>p[0]),ys=p.map(p=>p[1]);$('geometry-live-dimensions').textContent=`Width ${(Math.max(...xs)-Math.min(...xs)).toFixed(2)} m · Height/depth ${(Math.max(...ys)-Math.min(...ys)).toFixed(2)} m${p.length>2?' · Area '+polygonArea(p).toFixed(2)+' m²':''}${tool==='circle'?' · 48 segments':''}`;
  }
  function finish(shape){
    const next=copy(design),layer=$('geometry-layer').value,newId=id();
    if(layer==='WALL')next.masses.push(footprintOnPlane(newId,shape,plane));
    else if(layer==='WINDOW')next.openings.push({id:newId,host:host.id,face:host.face,points:shape});
    else next.surfaces.push({id:newId,category:layer,orientation:['SHADING_H','SHADING_V'].includes(layer)?$('geometry-orientation').value:null,frame:copy(plane),points:shape});
    if(commit(next,layer==='WALL'?'Footprint created. Use Push / Pull to create the building height.':'Surface created. Window area is subtracted from its host wall.')){
      selected=layer==='WALL'?`${newId}_SKETCH`:layer==='WINDOW'?`${newId}_WIN`:newId;setTool('select');showSelection();
      if(layer==='WALL')message('Footprint created. Set a height and click Apply height, or use Push / Pull.');
    }
  }
  renderer.domElement.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;renderer.domElement.focus({preventScroll:true});down={x:e.clientX,y:e.clientY};
    if(['select','copy','move'].includes(tool)){
      const snap=nearSnap(e),mesh=snap?.mesh??hitAt(e);
      if(mesh){selected=mesh.name;showSelection();beginTranslation(e,mesh,snap);if(snap)showCoordinates(snap);}else{coordinatePopup.hidden=true;popupPoint=null;}
      return;
    }
    if(tool==='push'){const mesh=hitAt(e),meta=mesh?.userData.editor;if(!meta?.massId||meta.openingId){message('Select a building footprint, wall, or roof to push/pull.',true);return;}
      const mass=design.masses.find(m=>m.id===meta.massId);selected=mesh.name;drag={startY:e.clientY,before:copy(design),massId:mass.id,height:mass.height};renderer.domElement.setPointerCapture(e.pointerId);
    }
  });
  renderer.domElement.addEventListener('pointermove',e=>{
    if(translation){updateTranslation(e);return;}
    if(drag){const next=copy(drag.before),mass=next.masses.find(m=>m.id===drag.massId);mass.height=Math.max(.1,Math.round((drag.height+(drag.startY-e.clientY)*.05)*10)/10);
      try{validateDesign(next);design=next;selected=`${mass.id}_ROOF`;rebuild();$('geometry-live-dimensions').textContent=`Push / pull height: ${mass.height.toFixed(2)} m`;}catch(err){message(err.message,true);}return;
    }
    const hoverFace=hitAt(e);const markerName=hoverFace?.name??selected;if(markerName!==hovered){hovered=markerName;refreshMarkers(markerName);}const near=nearSnap(e);for(const s of snapCandidates)s.element.classList.toggle('snap-active',s===near);
    if(numericRectangle&&tool==='rectangle')return;
    if(['rectangle','circle','polyline'].includes(tool)){if(!points.length){try{choosePlane(e);}catch{cursor=null;return;}}cursor=positionAt(e);if(cursor){$('geometry-coordinates').textContent=`${host?'Wall face':'Drawing plane'}: ${cursor[0].toFixed(2)}, ${cursor[1].toFixed(2)} m`;drawPreview();}}
  });
  renderer.domElement.addEventListener('pointerup',e=>{
    if(translation){
      const t=translation;endTranslation();down=null;
      if(t.moved&&t.delta.lengthSq()>1e-10){try{
        const result=transformSelection(t.before,t.meta,architecturalCoordinates(t.delta),t.duplicate,id);
        if(commit(result.design,t.duplicate?'Selection copied by dragging.':'Selection moved by dragging.')){selected=result.key;setTool('select');showSelection();}
      }catch(err){message(err.message,true);}}
      else {const snap=nearSnap(e);if(snap)showCoordinates(snap);}
      return;
    }
    if(drag){if(JSON.stringify(design)!==JSON.stringify(drag.before)){history.push(drag.before);if(history.length>60)history.shift();future=[];persist();}drag=null;down=null;rebuild();message('Height updated. Select a wall to draw windows.');return;}
    if(e.button!==0||!down||Math.hypot(e.clientX-down.x,e.clientY-down.y)>5){down=null;return;}down=null;
    if(tool==='select'){selected=hitAt(e)?.name??null;showSelection();return;}
    if(!['rectangle','circle','polyline'].includes(tool))return;
    if(!points.length){try{choosePlane(e);}catch(err){message(err.message,true);return;}}
    const p=positionAt(e);if(!p){message('Drawing plane is edge-on. Orbit slightly to draw on it.',true);return;}
    if(tool==='polyline'){
      if(points.length>=3&&Math.hypot(p[0]-points[0][0],p[1]-points[0][1])<Math.max(.2,Number($('geometry-snap').value))){finish(points);return;}
      points.push(p);$('geometry-finish').disabled=points.length<3;
    }else if(!points.length){
      points=[p];
      if(tool==='rectangle'){rectangleDirections=rectangleScreenDirections(camera,plane,p);sizeForm.hidden=false;lengthInput.focus({preventScroll:true});message('Enter length, Tab, then width/height, and Enter. Dimensions extend right and down in this view. Flip either direction if needed.');}
    }else if(tool==='rectangle'&&numericRectangle)sizeForm.requestSubmit();
    else finish(tool==='rectangle'?rectangle(points[0],p):circle(points[0],p));
  });
  function sizedRectangle(){
    const length=Number(lengthInput.value),width=Number(widthInput.value);
    if(tool!=='rectangle'||!points.length||!Number.isFinite(length)||!Number.isFinite(width)||length<.001||width<.001)return null;
    return rectangle(points[0],[points[0][0]+length*rectangleDirections[0],points[0][1]+width*rectangleDirections[1]]);
  }
  function updateSizedPreview(){numericRectangle=!!(lengthInput.value||widthInput.value);const shape=sizedRectangle();clearPreview();if(shape){cursor=[points[0][0]+Number(lengthInput.value)*rectangleDirections[0],points[0][1]+Number(widthInput.value)*rectangleDirections[1]];drawPreview();}}
  for(const input of [lengthInput,widthInput]){
    input.addEventListener('input',updateSizedPreview);
    input.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();input.blur();setTool('select');}});
  }
  $('geometry-flip-length').onclick=()=>{rectangleDirections[0]*=-1;updateSizedPreview();};
  $('geometry-flip-width').onclick=()=>{rectangleDirections[1]*=-1;updateSizedPreview();};
  sizeForm.addEventListener('submit',e=>{e.preventDefault();const shape=sizedRectangle();if(!shape){message('Enter a positive length and width in metres.',true);return;}finish(shape);if(sizeForm.hidden)document.activeElement?.blur();});
  renderer.domElement.addEventListener('pointercancel',()=>{endTranslation();if(drag){design=drag.before;drag=null;rebuild();}down=null;});
  document.querySelectorAll('[data-geometry-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.geometryTool));
  $('geometry-finish').onclick=()=>{if(points.length>=3)finish(points);};
  $('geometry-layer').onchange=()=>{setTool('select');renderLayers();message($('geometry-layer').value==='WINDOW'?'Select a wall, then draw a rectangle, polyline, or circle for glazing.':['SHADING_H','SHADING_V'].includes($('geometry-layer').value)?'Select a window, set projection depth, then Add shade. Or draw a separate shading surface on a suitable plane.':'Choose a drawing tool to create this layer.');};
  $('geometry-plane').onchange=()=>setTool('select');$('geometry-elevation').onchange=()=>setTool('select');
  $('geometry-apply-height').onclick=()=>{
    const meta=selectedMeta(),next=copy(design),m=next.masses.find(m=>m.id===meta?.massId);if(!m){message('Select a footprint, wall or roof first.',true);return;}
    const height=Number($('geometry-height').value);if(height<.1){message('Height must be at least 0.1 m.',true);return;}m.height=height;selected=`${m.id}_ROOF`;if(commit(next,'Building height updated.')){setTool('select');fit();}
  };
  $('geometry-add-shade').onclick=()=>{
    const meta=selectedMeta(),o=meta?.openingId,category=meta?.shadeId?meta.category:$('geometry-layer').value;
    if(!o||!['SHADING_H','SHADING_V'].includes(category)){message('Select a window and choose Horizontal shading or Vertical shading.',true);return;}
    const next=copy(design),existing=next.shades.find(s=>s.host===o&&s.category===category),inclination=Number($('geometry-shade-inclination').value),length=Number($('geometry-shade-depth').value),depth=length*Math.cos(inclination*Math.PI/180),count=Number($('geometry-shade-count').value),spacing=$('geometry-shade-spacing').value===''?null:Number($('geometry-shade-spacing').value);
    if(!Number.isFinite(length)||length<.04||length>3){message('Blade length must be between 0.04 and 3 m.',true);return;}
    if(existing)Object.assign(existing,{depth,inclination,count,spacing});else next.shades.push({id:id(),host:o,category,depth,inclination,count,spacing});commit(next,'Blade array updated. SC will use each glazing interval separately.');
  };
  function updateShadeSummary(){
    const count=Number($('geometry-shade-count').value);$('geometry-shade-spacing').disabled=count===1;
    const meta=selectedMeta(),o=design.openings.find(o=>o.id===meta?.openingId),category=meta?.shadeId?meta.category:$('geometry-layer').value;
    if(!o||!['SHADING_H','SHADING_V'].includes(category)){$('geometry-shade-summary').textContent='Select a window and a shading layer.';return;}
    try{const layout=shadeLayout({category,count,spacing:$('geometry-shade-spacing').value===''?null:Number($('geometry-shade-spacing').value)},o),length=Number($('geometry-shade-depth').value),ratios=layout.intervals.map(b=>length/(b.to-b.from)),last=layout.intervals.at(-1);
      $('geometry-shade-summary').textContent=`${layout.count} blade(s) · spacing ${layout.spacing.toFixed(3)} m · final interval ${(last.to-last.from).toFixed(3)} m · P/interval ${Math.min(...ratios).toFixed(3)}–${Math.max(...ratios).toFixed(3)}. SC table limits are checked during assessment.`;
    }catch(err){$('geometry-shade-summary').textContent=err.message;}
  }
  for(const field of ['depth','inclination','count','spacing'])$('geometry-shade-'+field).addEventListener('input',updateShadeSummary);
  for(const mode of ['copy','move'])$('geometry-'+mode).onclick=()=>{
    const meta=selectedMeta();if(!meta)return;setTool(mode);transformMode=mode;transformTarget=copy(meta);transformForm.reset();transformForm.hidden=false;$('geometry-transform-title').textContent=mode==='copy'?'Copy: drag or enter offsets':'Move: drag or enter offsets';
  };
  $('geometry-transform-cancel').onclick=()=>setTool('select');
  transformForm.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setTool('select');document.activeElement?.blur();}});
  transformForm.addEventListener('submit',e=>{e.preventDefault();try{
    const offset=['x','y','z'].map(axis=>Number($('geometry-offset-'+axis).value));
    if(offset.every(v=>v===0))throw Error('Enter a non-zero offset.');
    const result=transformSelection(design,transformTarget,offset,transformMode==='copy',id);
    if(commit(result.design,transformMode==='copy'?'Selection copied.':'Selection moved.')){selected=result.key;setTool('select');showSelection();document.activeElement?.blur();}
  }catch(err){message(err.message,true);}});
  $('geometry-update-orientation').onclick=()=>{
    const meta=selectedMeta(),next=copy(design),dir=$('geometry-orientation').value;
    if(meta?.massId&&Number.isInteger(meta.face)){const m=next.masses.find(m=>m.id===meta.massId);m.orientations??={};m.orientations[meta.face]=dir;commit(next,'Wall, windows and attached shading orientation updated.');}
    else if(meta?.surfaceId&&['SHADING_H','SHADING_V'].includes(meta.category)){next.surfaces.find(s=>s.id===meta.surfaceId).orientation=dir;commit(next,'Shading orientation updated.');}
    else message('Orientations apply to wall faces, glazing and shading.',true);
  };
  $('geometry-delete').onclick=()=>{if(!selected)return;const next=copy(design);deleteSelection(next,selectedMeta());if(commit(next,'Selection deleted. Undo is available.')){selected=null;showSelection();}};
  function undo(redo=false){cancel();if(drag){design=drag.before;drag=null;}const from=redo?future:history,to=redo?history:future;if(!from.length)return;to.push(copy(design));design=from.pop();selected=null;rebuild();persist();}
  $('geometry-undo').onclick=()=>undo();$('geometry-redo').onclick=()=>undo(true);
  $('geometry-new').onclick=()=>{setTool('select');selected=null;if(commit(emptyDesign(),'New empty design. Undo restores the previous design.'))fit();};
  $('geometry-download').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(design,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='facadescan-design.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  $('geometry-load').onchange=async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;try{if(file.size>2e6)throw Error('Design file exceeds 2 MB.');const next=JSON.parse(await file.text());if(commit(next,'Design loaded.')){setTool('select');fit();}}catch(err){message(err.message,true);}};
  $('geometry-assess').onclick=()=>{try{const result=buildDesign(design,{assessment:true});onAssess(result);active=false;}catch(e){message(e.message,true);}};
  $('geometry-back').onclick=()=>{active=false;onBack();};
  document.addEventListener('keydown',e=>{
    if(!active||['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName))return;
    if(translation&&!e.ctrlKey&&!e.metaKey&&['x','y','z'].includes(e.key.toLowerCase())){e.preventDefault();const axis=e.key.toLowerCase();lockedAxis=lockedAxis===axis?null:axis;message(lockedAxis?`Drag locked to ${lockedAxis.toUpperCase()}. Press the same key to unlock.`:'Axis lock released.');return;}
    if(e.key==='Escape'){if(drag){design=drag.before;drag=null;rebuild();}setTool('select');}
    if(e.key==='Enter'&&tool==='polyline'&&points.length>=3){e.preventDefault();finish(points);}
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();$('geometry-delete').click();}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey);}
  });
  function loop(){requestAnimationFrame(loop);if(!active)return;controls.update();updateNavigation();renderer.render(scene,camera);for(const d of dimensionPoints){const p=d.point.clone().project(camera);d.element.hidden=p.z>1||p.z<-1;d.element.style.left=`${(p.x*.5+.5)*view.clientWidth}px`;d.element.style.top=`${(-p.y*.5+.5)*view.clientHeight}px`;}
    for(const s of snapCandidates){const p=screenPoint(s.point);s.element.hidden=!p.visible;s.element.style.left=`${p.x}px`;s.element.style.top=`${p.y}px`;}
    if(popupPoint){const p=screenPoint(popupPoint);coordinatePopup.hidden=!p.visible;coordinatePopup.style.left=`${Math.max(8,Math.min(view.clientWidth-coordinatePopup.offsetWidth-8,p.x+14))}px`;coordinatePopup.style.top=`${Math.max(8,Math.min(view.clientHeight-coordinatePopup.offsetHeight-8,p.y-36))}px`;}
  }
  try{const saved=localStorage.getItem(storageKey);if(saved){design=validateDesign(JSON.parse(saved));message('Saved draft restored.');}}catch{design=emptyDesign();message('Saved draft could not be restored. Load a downloaded design or start a new one.',true);}
  rebuild();fit();loop();
  return {show(){active=true;resize();setTool('select');},hide(){active=false;cancel();}};
}
