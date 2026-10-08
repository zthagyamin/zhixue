// Explicit fixture opt-in. Same pinned runtime as the app, never a general network proxy.
const upstream='https://cdn.jsdelivr.net/pyodide/v314.0.5/full/',prefix='/__fixture/python-runtime/';
export function runtimeAssetUrl(path,method){
  if(method!=='GET'||!path.startsWith(prefix))throw new Error('runtime-preview-path-blocked');
  const name=path.slice(prefix.length);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:mjs|js|wasm|json|zip|whl)$/.test(name))throw new Error('runtime-preview-path-blocked');
  return upstream+name;
}
export function rewriteRuntimeUrls(source,origin){return source.replaceAll(upstream,origin+prefix);}
export function createPythonPreviewAssets(fetcher=fetch){
  const cache=new Map();let bytesLoaded=0;
  return {
    async load(path,method){
      const url=runtimeAssetUrl(path,method);
      if(!cache.has(url)){
        const pending=(async()=>{
          const response=await fetcher(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(120000)});
          if(!response.ok||!response.body)throw new Error('runtime-preview-download-failed');
          const reader=response.body.getReader(),chunks=[];let size=0;
          try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>64*1024*1024){await reader.cancel();throw new Error('runtime-preview-size-limit');}chunks.push(value);}}
          finally{reader.releaseLock();}
          const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}bytesLoaded+=size;
          return {bytes,type:response.headers.get('content-type')||'application/octet-stream'};
        })();cache.set(url,pending);pending.catch(()=>cache.delete(url));
      }
      return cache.get(url);
    },
    status:()=>({files:cache.size,bytesLoaded}),
  };
}
