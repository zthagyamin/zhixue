import type {CloudFSRSData} from '../evidence';
import type {LongTermInventoryItem,LongTermScheduleOptions,LongTermPlanSnapshot} from './long-term-plan-types';
export type LongTermReviewForecaster={
  assumptions:LongTermPlanSnapshot['forecastAssumptions'];
  snapshot:()=>Record<string,CloudFSRSData>;
  pending:(date:string)=>LongTermInventoryItem[];
  review:(key:string,date:string)=>void;learn:(key:string,date:string)=>void;
};
export type LongTermReviewFactory=(inventory:LongTermInventoryItem[],cards:Record<string,CloudFSRSData>,options:LongTermScheduleOptions)=>LongTermReviewForecaster;
