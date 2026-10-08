export const DEFAULT_COMPANION_URL='http://127.0.0.1:43121';
export function companionEndpointFromSearch(search:string):string{
  const port=new URLSearchParams(search).get('companionPort');
  return port&&/^\d{4,5}$/.test(port)&&Number(port)>=1024&&Number(port)<=65535?`http://127.0.0.1:${Number(port)}`:DEFAULT_COMPANION_URL;
}
export function sessionForEndpoint<T extends {baseUrl?:string}>(session:T|null,endpoint:string):T|null{
  return session&&(session.baseUrl??DEFAULT_COMPANION_URL)===endpoint?session:null;
}
export function companionSignInLink(endpoint:string):string{
  const back='/study?pair=1&companionPort='+new URL(endpoint).port;
  return '/signin-with-chatgpt?return_to='+encodeURIComponent(back);
}
export function companionSessionRecordKey(endpoint:string):`companion-session:${string}`{
  return `companion-session:${new URL(endpoint).port}`;
}
