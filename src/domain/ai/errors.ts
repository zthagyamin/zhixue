import type {StudyAIProvider} from './types';

export const STUDY_AI_ERRORS:Record<string,string>={
 'ai-model-name':'模型名称不是 API 标识。请从下拉列表选择模型，再保存。',
 'ai-provider-model':'提供商不支持此模型，或当前密钥无权使用它。请重新读取并选择模型。',
 'ai-provider-auth':'API 密钥无效或已失效，请检查密钥所属的提供商。',
 'ai-provider-balance':'提供商余额或额度不足，请到提供商账户检查。',
 'ai-provider-permission':'提供商拒绝了请求，请检查模型权限或地区限制。',
 'ai-provider-endpoint':'找不到 API 接口，请核对接口地址。',
 'ai-provider-rate-limit':'提供商暂时限流，请稍后重试。',
 'ai-provider-bad-request':'提供商不接受当前请求，请检查模型与接口是否兼容。',
 'ai-provider-unavailable':'提供商暂时不可用，请稍后重试。',
 'ai-provider-redirect':'接口地址发生重定向，已停止请求。请填写提供商的最终 API 基础地址。',
 'ai-provider-network':'无法连接提供商，请检查接口地址或网络。',
 'ai-provider-timeout':'提供商响应超时，请稍后重试。',
 'ai-provider-output-limit':'模型输出额度用尽。可在用量限制中提高单次输出上限。',
 'ai-model-list-empty':'此接口未返回可选择的聊天模型，请核对接口或联系提供商。',
 'ai-model-list-key-required':'读取新接口的模型前，请填写该接口的密钥。',
 'ai-companion-upgrade-required':'本机 Companion 尚不支持读取模型列表，请更新；已保存的模型仍可选择。',
 'account-ai-key-required':'尚未保存此提供商的密钥。',
 'account-ai-disabled':'当前提供商尚未启用，请在设置中启用并保存。',
 'cloud-ai-unconfigured':'请先选择模型并保存 API 配置。',
 'ai-unconfigured':'请先选择模型并保存 API 配置。',
 'ai-key-required':'尚未保存此提供商的密钥。',
 'invalid-ai-budget':'用量限制超出允许范围，请检查各项上限。',
 'invalid-ai-model':'请从列表选择有效模型。',
 'invalid-ai-base-url':'API 地址格式不正确，请核对基础地址。',
 'ai-cost-confirmation-required':'请先确认 API 传输内容及费用。',
 'cloud-ai-unavailable':'站点云端 AI 当前不可用，已保留配置，请联系站点维护者。',
 'account-ai-daily-limit':'已达到网站设置的每日请求次数，可在用量限制中调整，或明天再试。',
 'account-ai-token-limit':'已达到网站设置的每日用量额度，可在用量限制中调整，或明天再试。',
 'account-ai-concurrency-limit':'还有请求正在处理，请结束后重试。',
 'ai-settings-stale':'配置已更新，请重新读取后再试。',
 'ai-request-pending':'上一次请求仍在处理中，请稍候。',
 'ai-request-indeterminate':'上一次请求结果暂不明确，请稍后再试，避免重复调用。',
 'cloud-ai-base-url':'API 地址格式不正确，请填写兼容接口的基础地址。',
 'ai-provider-error':'回答未完成，请先运行连接测试查看原因。',
 'cloud-ai-provider-error':'回答未完成，请先运行连接测试查看原因。',
};
export function studyAIErrorCode(error:unknown):string{
 const code=typeof error==='string'?error:error instanceof Error?error.message:'';
 if(Object.hasOwn(STUDY_AI_ERRORS,code))return code;
 if(error instanceof Error&&['AbortError','TimeoutError'].includes(error.name))return 'ai-provider-timeout';
 return 'ai-provider-error';
}
export function studyAIErrorMessage(error:unknown){return STUDY_AI_ERRORS[studyAIErrorCode(error)];}
export function providerFailureCode(status:number,raw:unknown):string{
 const body=raw&&typeof raw==='object'?raw as {error?:{code?:unknown;type?:unknown}}:{},code=String(body.error?.code??body.error?.type??'').toLowerCase();
 if(['model_not_found','invalid_model','model_not_exist'].includes(code))return 'ai-provider-model';
 if(['insufficient_quota','insufficient_balance'].includes(code)||status===402)return 'ai-provider-balance';
 if(status===401)return 'ai-provider-auth';if(status===403)return 'ai-provider-permission';if(status===404)return 'ai-provider-endpoint';if(status===429)return 'ai-provider-rate-limit';if(status>=500)return 'ai-provider-unavailable';
 return status===400||status===422?'ai-provider-bad-request':'ai-provider-error';
}
export function suggestedStudyAIModel(provider:StudyAIProvider,model:string,baseUrl?:string):string|undefined{
 if(provider!=='deepseek')return;
 try{if(new URL(baseUrl||'https://api.deepseek.com').hostname!=='api.deepseek.com')return;}catch{return;}
 const id=model.trim().toLowerCase().replace(/[\s_]+/g,'-');
 return ['deepseek-v4-flash','deepseek-v4-pro','deepseek-v4-flash-vision-exp'].includes(id)&&id!==model?id:undefined;
}
export function assertStudyAIModel(provider:StudyAIProvider,model:string,baseUrl?:string){if(suggestedStudyAIModel(provider,model,baseUrl))throw new Error('ai-model-name');}
