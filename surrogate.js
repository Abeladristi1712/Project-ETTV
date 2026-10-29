// Browser-compatible hybrid surrogate. No workbook lookups at prediction time.
export const directions = ['N','NE','E','SE','S','SW','W','NW'];
export const domains = {
  none: [], horizontal: [[0.1,3],[0,50]], vertical: [[0.1,3],[0,50]],
  eggcrate: [[0.2,1.8],[0.2,1.8],[0,40]]
};
export function powers(dim, degree) {
  const out=[];
  function visit(prefix, remaining) {
    if(prefix.length===dim) { out.push(prefix); return; }
    for(let n=0;n<=remaining;n++) visit([...prefix,n],remaining-n);
  }
  visit([],degree); return out;
}
export function basis(values, ranges, exponents) {
  const x=values.map((v,i)=>2*(v-ranges[i][0])/(ranges[i][1]-ranges[i][0])-1);
  // Legendre basis is better conditioned than raw powers.
  const p=x.map(v=>{const a=[1,v]; for(let n=2;n<=8;n++) a[n]=((2*n-1)*v*a[n-1]-(n-1)*a[n-2])/n; return a;});
  return exponents.map(e=>e.reduce((v,n,i)=>v*p[i][n],1));
}
export function predictFacade(model, f) {
  if(!directions.includes(f.orientation)) throw new Error('Unknown orientation');
  for(const [key,range] of Object.entries(model.materialDomain)) {
    if(!Number.isFinite(f[key]) || f[key]<range[0] || f[key]>range[1]) throw new Error(`${key} outside model domain`);
  }
  if(!Object.hasOwn(domains,f.shade)) throw new Error('Unknown shade');
  if(f.pitch!==undefined && f.pitch!==90) throw new Error('Only vertical walls supported');
  if(f.effectiveSCProjection!==undefined) throw new Error('Panel SC overrides are not surrogate inputs');
  const vals=f.shade==='none'?[]:f.shade==='eggcrate'?[f.r1,f.r2,f.angle]:[f.shade==='horizontal'?f.r1:f.r2,f.angle];
  if((f.shade==='none' && ((f.r1??0)!==0 || (f.r2??0)!==0)) ||
    (f.shade==='horizontal' && (f.r2??0)!==0) || (f.shade==='vertical' && (f.r1??0)!==0)) throw new Error('Inconsistent shading parameters');
  const ranges=domains[f.shade];
  if(vals.some((v,i)=>!Number.isFinite(v)||v<ranges[i][0]||v>ranges[i][1])) throw new Error('Shading outside model domain');
  let sc=1;
  if(f.shade!=='none') {
    const m=model.models[`${f.orientation}/${f.shade}`];
    sc=basis(vals,ranges,m.powers).reduce((s,v,i)=>s+v*m.weights[i],0);
    sc=Math.max(0,Math.min(1,sc));
  }
  return {sc,ettv:12*(1-f.wwr)*f.uw+3.4*f.wwr*f.uf+211*f.wwr*model.cf[f.orientation]*f.scGlass*sc};
}
export function predictBuilding(model, facades) {
  if(!Array.isArray(facades)||!facades.length) throw new Error('Provide active facade segments');
  let area=0,total=0;
  const results=facades.map(f=>{
    if(!Number.isFinite(f.area)||f.area<=0) throw new Error('Area must be positive');
    const result=predictFacade(model,f); area+=f.area;total+=f.area*result.ettv;
    return {...result,orientation:f.orientation,area:f.area};
  });
  return {overall:total/area,facades:results,status:'experimental surrogate; verify decisions with exact calculator'};
}
