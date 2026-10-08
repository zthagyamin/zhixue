import type {StudyAIProvider} from './types';
export function providerEndpoint(options:{provider?:StudyAIProvider;baseUrl?:string}):string{
 const base=options.baseUrl?.trim()||(options.provider==='chatgpt'?'https://api.openai.com/v1':'https://api.deepseek.com');
 let url:URL;try{url=new URL(base);}catch{throw new Error('cloud-ai-base-url');}
 if(url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname==='[::1]'||/^127\./.test(url.hostname)||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^\/[A-Za-z0-9/_-]*$/.test(url.pathname))throw new Error('cloud-ai-base-url');
 return `${url.href.replace(/\/$/,'')}/chat/completions`;
}
