/** Egg-crate calculation delegated to the actual user-supplied Excel data. */
import {lookupEggcrateWithEstimate,sourceWorkbook} from './sc-lookup.js';
export function eggCrateCoefficient(r1,r2,orientation,angle=0,verticalAngle=0){return lookupEggcrateWithEstimate(orientation,r1,r2,angle,verticalAngle);}
export const eggcrateTablesForTesting={
 ns:sourceWorkbook.tables.C20.values.map(r=>r.map(a=>a[0])),
 ew:sourceWorkbook.tables.C21.values.map(r=>r.map(a=>a[0])),
 nenw:sourceWorkbook.tables.C22.values.map(r=>r.map(a=>a[0])),
 sesw:sourceWorkbook.tables.C23.values.map(r=>r.map(a=>a[0]))
};
