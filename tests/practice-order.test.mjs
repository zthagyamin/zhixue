import test from 'node:test';
import assert from 'node:assert/strict';
import {practiceGroup,orderPracticeItems,reorderRemainingPracticeItems} from '../app/practice-order.ts';

const a={itemId:'a',domain:'language',sourceLabel:'IELTS',sourceNote:'IELTS.md',fingerprint:'a'};
const b={itemId:'b',domain:'computing',sourceLabel:'Python',sourceNote:'Python.md',fingerprint:'b'};
const c={...a,itemId:'c',fingerprint:'c'};
const d={...b,itemId:'d',fingerprint:'d'};
test('focus ordering groups actual source metadata without changing identity or within-group order',()=>{
 const items=[a,b,c,d],result=orderPracticeItems(items,'focus');
 assert.deepEqual(result,[a,c,b,d]);assert.deepEqual(items,[a,b,c,d]);
 for(const item of result)assert.equal(item,items.find(candidate=>candidate.itemId===item.itemId));
 assert.notEqual(practiceGroup(a).id,practiceGroup(b).id);
});
test('explicit subject metadata groups notes in one course and keeps missing metadata separate',()=>{
 const first={itemId:'x'},second={itemId:'y'};
 assert.notEqual(practiceGroup(first).id,practiceGroup(second).id);
 const group=item=>({id:item===b?'second':'course',label:'课程'});
 assert.deepEqual(orderPracticeItems([a,b,c],'focus',group),[a,c,b]);
});
test('changing modes preserves the completed prefix and current draft owner',()=>{
 const items=[a,b,c,d],result=reorderRemainingPracticeItems(items,1,'mixed',practiceGroup,()=>0);
 assert.equal(result[0],a);assert.equal(result[1],b);assert.deepEqual(result.slice(2),[d,c]);
 assert.deepEqual(new Set(result),new Set(items));
 assert.deepEqual(reorderRemainingPracticeItems(items,3,'focus'),items);
});
