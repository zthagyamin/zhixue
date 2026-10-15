import type {PaperReadingScope} from './ports';
import type {PaperReadingUnitV1,PreparedPaperTask,PreparedPaperTaskPacketV1} from '../../domain/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingUnit,parsePreparedPaperTaskPacket,preparedPaperTask,preparedPaperTaskRecipe,preparedPaperTaskTemplate} from '../../domain/paper-reading/index.ts';

export type PreparedPaperTaskRecord={schemaVersion:1;baseUnit:PaperReadingUnitV1;activeRecipeHash:string;
    recipes:{recipeHash:string;packet:PreparedPaperTaskPacketV1}[]};
export interface PreparedPaperTaskStorePort{
    read(scope:PaperReadingScope,unit:PaperReadingUnitV1):Promise<unknown|null>;
    update(scope:PaperReadingScope,unit:PaperReadingUnitV1,change:(current:unknown|null)=>PreparedPaperTaskRecord):Promise<void>;
}
export type PreparedPaperTaskSaveOptions={expectedRecipeHash?:string|null};

/** Owns validation and hashing; persistence success means the local transaction has committed. */
export function createPreparedPaperTaskService(store:PreparedPaperTaskStorePort,hash:(text:string)=>Promise<string>){
    function bound(scope:PaperReadingScope,raw:PaperReadingUnitV1){
        const unit=paperReadingUnit(raw);
        if(scope.ownerId!==unit.source.ownerId||scope.libraryId!==unit.source.libraryId)throw Error('paper-prepared-scope');
        return unit;
    }
    async function checked(unit:PaperReadingUnitV1,raw:unknown):Promise<PreparedPaperTaskRecord|null>{
        if(raw===null)return null;
        if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('paper-prepared-corrupt');
        const row=raw as PreparedPaperTaskRecord;
        if(Object.keys(row).length!==4||!['schemaVersion','baseUnit','activeRecipeHash','recipes'].every(k=>Object.hasOwn(row,k))
            ||row.schemaVersion!==1||canonicalAttemptJson(row.baseUnit)!==canonicalAttemptJson(unit)
            ||!Array.isArray(row.recipes)||!row.recipes.length
            ||row.recipes.some(r=>!r||typeof r!=='object'||Array.isArray(r))
            ||new Set(row.recipes.map(r=>r.recipeHash)).size!==row.recipes.length
            ||!row.recipes.some(r=>r.recipeHash===row.activeRecipeHash))throw Error('paper-prepared-corrupt');
        for(const recipe of row.recipes){
            if(!recipe||typeof recipe!=='object'||Object.keys(recipe).length!==2
                ||!Object.hasOwn(recipe,'packet')||!Object.hasOwn(recipe,'recipeHash')
                ||await hash(preparedPaperTaskRecipe(unit,recipe.packet))!==recipe.recipeHash)throw Error('paper-prepared-corrupt-hash');
        }
        return structuredClone(row);
    }
    async function load(scope:PaperReadingScope,raw:PaperReadingUnitV1):Promise<PreparedPaperTask|null>{
        const unit=bound(scope,raw),row=await checked(unit,await store.read(scope,unit));
        if(!row)return null;
        const recipe=row.recipes.find(r=>r.recipeHash===row.activeRecipeHash)!;
        return preparedPaperTask(unit,recipe.packet,recipe.recipeHash);
    }
    async function save(scope:PaperReadingScope,raw:PaperReadingUnitV1,packet:unknown,options:PreparedPaperTaskSaveOptions={}):Promise<PreparedPaperTask>{
        const unit=bound(scope,raw),content=parsePreparedPaperTaskPacket(unit,packet);
        const before=await checked(unit,await store.read(scope,unit));
        const recipeHash=await hash(preparedPaperTaskRecipe(unit,content)),task=preparedPaperTask(unit,content,recipeHash);
        if(Object.hasOwn(options,'expectedRecipeHash')&&options.expectedRecipeHash!==(before?.activeRecipeHash??null)
            &&before?.activeRecipeHash!==recipeHash)throw Error('paper-prepared-conflict');
        const recipes=before?structuredClone(before.recipes):[];
        if(!recipes.some(recipe=>recipe.recipeHash===recipeHash))recipes.push({recipeHash,packet:content});
        const next:PreparedPaperTaskRecord={schemaVersion:1,baseUnit:unit,activeRecipeHash:recipeHash,recipes};
        await store.update(scope,unit,current=>{
            const received=canonicalAttemptJson(current);
            if(received!==canonicalAttemptJson(before)&&received!==canonicalAttemptJson(next))throw Error('paper-prepared-conflict');
            return next;
        });
        return task;
    }
    return {load,save,exportTemplate:(unit:PaperReadingUnitV1)=>JSON.stringify(preparedPaperTaskTemplate(unit),null,2)};
}
