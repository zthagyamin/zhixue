import {gradeCalculationReference} from './calculation-grade';
self.onmessage=(event:MessageEvent)=>{self.postMessage(gradeCalculationReference(event.data.item,event.data.answer));};
