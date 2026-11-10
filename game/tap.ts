/** A tap is one short, stationary contact. Dragging out and back is not a tap. */
export function createTapTracker(){
  let start=0,travel=0,valid=false;
  return {begin(now:number){start=now;travel=0;valid=true;},move(distance:number){travel+=Math.abs(distance);},cancel(){valid=false;},end(now:number){const result=valid&&now-start<=280&&travel<7;valid=false;return result;}};
}
