import './design-workspace.css';
import {opaquePresets,glazingPresets} from './ettv-engine.js';

export function createDesignWorkspace({getState,edit,editGeometry}){
  const page=document.getElementById('step-results');
  const layout=document.createElement('section');layout.className='facade-workspace';
  layout.innerHTML=`<div class="design-model"></div><aside class="design-panel"><details class="optional-facade"><summary>Customize an orientation (optional)</summary><span class="eyebrow">FAÇADE DESIGN</span><h2>Selected orientation</h2><label>Façade<select id="design-direction"></select></label><p class="design-scope">Changes apply to all surfaces in this orientation.</p><div id="design-controls"></div><details><summary>View heat-gain breakdown</summary><div id="design-gains"></div></details></details><p class="design-scope">Use the building-wide material selection above. Open customization only when an orientation needs different inputs. Closing this panel preserves your changes.</p></aside>`;
  page.querySelector('.results-design-grid').after(layout);
  const comparison=document.createElement('section');comparison.className='design-comparison';
  comparison.innerHTML=`<div><h2>Baseline & current alternative</h2><p>Save the current valid design, then compare your changes.</p></div><button class="soft-btn" id="design-save">Save as baseline</button><div id="design-comparison-values" aria-live="polite"></div>`;
  layout.after(comparison);
  const summary=document.createElement('div');summary.className='design-status';summary.setAttribute('aria-live','polite');
  page.querySelector('.results-heading').after(summary);
  const viewport=document.querySelector('#step-geometry .viewport');
  const home=viewport.parentElement,anchor=document.createComment('viewer home');home.insertBefore(anchor,viewport);
  let direction=null,baseline=null,modelIdentity=null;
  const select=layout.querySelector('#design-direction');
  const num=x=>Number.isFinite(x)?x.toFixed(2):'—';
  const option=(select,label,value)=>{const opt=document.createElement('option');opt.textContent=label;opt.value=value;select.append(opt);};
  select.onchange=()=>{direction=select.value;render();};
  comparison.querySelector('button').onclick=()=>{
    const s=getState();if(!Number.isFinite(s.results?.overall))return;
    baseline={overall:s.results.overall,facades:structuredClone(s.results.facades)};render();
  };
  function render(){
    const s=getState();
    if(modelIdentity!==s.geometry){baseline=null;modelIdentity=s.geometry;}
    const active=Object.keys(s.geometry??{}).filter(d=>(s.geometry[d].wall+s.geometry[d].window)>0);
    if(!active.includes(direction))direction=active[0];
    select.replaceChildren();active.forEach(d=>option(select,d,d));select.value=direction??'';
    const overall=s.results?.overall;
    const estimated=s.results?.facades.some(f=>f.area>0&&f.estimated);
    const method=!s.ready?'Awaiting materials':!Number.isFinite(overall)?'Incomplete — review inputs':estimated?'Design estimate':'Direct ETTV calculation';
    summary.textContent=`Overall ETTV: ${num(overall)} W/m²  ·  Project target: 45 W/m²  ·  Margin (target − ETTV): ${Number.isFinite(overall)?num(45-overall):'—'} W/m²  ·  ${method}`;
    const panel=layout.querySelector('#design-controls');panel.replaceChildren();
    const geometry=s.geometry?.[direction];
    if(!geometry)return;
    const info=document.createElement('p');info.className='design-geometry';
    info.textContent=`Gross ${num(geometry.wall+geometry.window)} m² · Glass ${num(geometry.window)} m² · WWR ${num(100*geometry.window/(geometry.wall+geometry.window))}%`;
    panel.append(info);
    const geometryButton=document.createElement('button');geometryButton.className='soft-btn';geometryButton.textContent='Edit geometry / WWR';geometryButton.onclick=editGeometry;panel.append(geometryButton);
    if(!s.ready){const p=document.createElement('p');p.textContent='Choose and apply starting materials above to edit individual façades.';panel.append(p);}
    else{
      const settings=s.settings[direction];
      for(const [label,presets,keys] of [['Wall construction',opaquePresets,['uw']],['Glazing',glazingPresets,['uf','scGlass']]]){
        const field=document.createElement('label');field.textContent=label;const input=document.createElement('select');
        option(input,'Choose a preset…','');
        presets.filter(p=>p.value!=='custom').forEach(p=>option(input,p.label,String(p.value)));
        input.onchange=()=>{if(!input.value)return;const vals=input.value.split('|').map(Number);edit(direction,Object.fromEntries(keys.map((k,i)=>[k,vals[i]])));};
        field.append(input);panel.append(field);
      }
      const advanced=document.createElement('details');advanced.innerHTML='<summary>Advanced settings</summary>';panel.append(advanced);
      const row=document.querySelector(`[data-ettv-row="${direction}"]`);
      const labels={uw:'Wall U-value (W/m²K)',uf:'Glazing U-value (W/m²K)',scGlass:'Glass SC',bladeAngle:'Horizontal inclination (°)',verticalBladeAngle:'Vertical inclination (°)',hpr:'Horizontal projection ratio',vpr:'Vertical projection ratio'};
      const modeLabel=document.createElement('label');modeLabel.textContent='Shading assessment';const sourceMode=row.querySelector('select');const mode=sourceMode.cloneNode(true);mode.removeAttribute('data-mode-dir');
      mode.value=sourceMode.value;mode.onchange=()=>{sourceMode.value=mode.value;sourceMode.dispatchEvent(new Event('change',{bubbles:true}));};modeLabel.append(mode);advanced.append(modeLabel);
      for(const [key,label] of Object.entries(labels)){
        const original=row.querySelector(`[data-et-key="${key}"]`);const field=document.createElement('label');field.textContent=label;
        const input=original.cloneNode(true);input.removeAttribute('data-et-dir');input.removeAttribute('data-et-key');input.value=original.value;
        input.onchange=()=>edit(direction,{[key]:input.value.trim()===''?NaN:Number(input.value)});
        field.append(input);advanced.append(field);
      }
    }
    const f=s.results?.facades.find(f=>f.orientation===direction);
    const gains=layout.querySelector('#design-gains');gains.replaceChildren();
    const title=document.createElement('h3');title.textContent='Heat-gain breakdown';gains.append(title);
    for(const [label,value] of [['Opaque conduction',f?.opaqueGain],['Glazing conduction',f?.glazingConduction],['Solar gain',f?.solarGain],['Façade ETTV',f?.ettv],['Contribution to overall ETTV',Number.isFinite(f?.ettv)&&s.results?.totalArea>0?f.ettv*f.area/s.results.totalArea:null]]){
      const line=document.createElement('div');line.className='design-metric';const name=document.createElement('span');name.textContent=label;const valueEl=document.createElement('b');valueEl.textContent=`${num(value)} W/m²`;line.append(name,valueEl);gains.append(line);
    }
    const note=document.createElement('p');note.className='design-scope';note.textContent=f?.reason||'Contribution = façade ETTV × façade area / total envelope area. Direct calculations have no surrogate prediction interval.';gains.append(note);
    comparison.querySelector('button').disabled=!Number.isFinite(overall);
    const selectedBaseline=baseline?.facades.find(f=>f.orientation===direction);
    comparison.querySelector('#design-comparison-values').textContent=baseline
      ?`Building baseline ${num(baseline.overall)} → current ${num(overall)} W/m² · Reduction ${Number.isFinite(overall)?num(baseline.overall-overall):'—'} W/m². ${direction} façade: ${num(selectedBaseline?.ettv)} → ${num(f?.ettv)} W/m².`
      :'No baseline saved. Your comparison will remain available while editing this model.';
  }
  return {render,select(d){direction=d;render();},show(step){
    if(step===3)layout.querySelector('.design-model').append(viewport);
    else home.insertBefore(viewport,anchor.nextSibling);
    render();
  }};
}
