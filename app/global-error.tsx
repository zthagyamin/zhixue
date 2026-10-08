'use client';
export default function GlobalError({reset}:{reset:()=>void}){return <html lang="zh-CN"><body style={{fontFamily:'system-ui',maxWidth:720,margin:'60px auto',padding:24}}><h1>知学暂时无法打开</h1><p>请保留尚未确认保存的输入，再尝试重试。不要删除浏览器网站数据。</p><button type="button" onClick={reset}>重试</button><p><a href="/help" target="_blank" rel="noreferrer">打开使用帮助</a></p></body></html>;}
