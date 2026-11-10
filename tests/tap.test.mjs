import test from 'node:test';
import assert from 'node:assert/strict';
import {createTapTracker} from '../game/tap.ts';
test('short stationary contact is one tap; holds, drag-return and cancelled gestures are not',()=>{
 const t=createTapTracker();t.begin(0);t.move(2);assert.equal(t.end(120),true);assert.equal(t.end(130),false);
 t.begin(0);assert.equal(t.end(400),false);
 t.begin(0);t.move(12);t.move(12);assert.equal(t.end(200),false);
 t.begin(0);t.cancel();assert.equal(t.end(100),false);
});
