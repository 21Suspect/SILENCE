/** The first two natural encounters follow local solar time, including admin
 * time changes. Placement may retry within the window, never force a visible spawn. */
export function createEncounterSchedule(random:()=>number=Math.random){
 const times=[17.5+random(),19.5+random()*2.5];
 const ends=[18.5,22];
 return {times,due(completed:number,hours:number){return completed>=2||(hours>=times[completed]&&hours<=ends[completed]);}};
}
