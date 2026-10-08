export type StudyAIProvider='chatgpt'|'deepseek';

export type StudyAIScope={ownerId:string;libraryId:string;mode:'account'|'local'};

export type StudyAIContext={id:string;title:string;question?:string;learnerAnswer?:string;code?:string;errors?:string[];pageText?:string;selection?:string;pageKind?:string;truncated?:boolean};

export type StudyAIMessage={id:string;role:'user'|'assistant';content:string;model?:string;provider?:StudyAIProvider;contextId?:string;contextTitle?:string};

export type StudyAIProviderConfig={model:string;baseUrl:string;configured:boolean};

export type StudyAISettings={provider:StudyAIProvider;model:string;baseUrl:string;enabled:boolean;configured:boolean;revision:number;providers:Record<StudyAIProvider,StudyAIProviderConfig>;unlimitedDailyUsage?:boolean;dailyRequestLimit:number;dailyTokenLimit:number;concurrentLimit:number;maxOutputTokens:number;serverAvailable?:boolean};

export type StudyAISettingsInput={provider:StudyAIProvider;model:string;baseUrl:string;enabled:boolean;expectedRevision:number;confirmCosts:boolean;providerKey?:string;clearProviderKey?:boolean;unlimitedDailyUsage?:boolean;dailyRequestLimit:number;dailyTokenLimit:number;concurrentLimit:number;maxOutputTokens:number};

export type StudyAIChatRequest={requestId:string;provider:StudyAIProvider;model:string;settingsRevision:number;context:StudyAIContext;messages:Pick<StudyAIMessage,'role'|'content'>[]};

export type StudyAIStreamEvent={type:'delta';text:string}|{type:'done';model?:string;provider?:StudyAIProvider;usageTokens?:number};

export type StudyAIModelSelection={provider:StudyAIProvider;baseUrl:string;expectedRevision:number;providerKey?:string};

export type StudyAIConnectionResult={provider:StudyAIProvider;model:string;latencyMs:number};
