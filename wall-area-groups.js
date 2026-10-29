// Sum net opaque areas once per manifest record, independent of viewer filters.
export function wallAreaGroups(records,orientation){
  const groups=new Map();
  for(const r of Object.values(records??{})){
    if(!r.in_glb||r.category!=='WALL'||r.orientation!==orientation||!Number.isFinite(r.exact_area_m2)||r.exact_area_m2<0)continue;
    const level=r.level==null?'Unassigned':String(r.level);
    if(!groups.has(level))groups.set(level,{level,area:0,count:0});
    const g=groups.get(level);g.area+=r.exact_area_m2;g.count++;
  }
  return [...groups.values()].sort((a,b)=>a.level.localeCompare(b.level,undefined,{numeric:true}));
}
