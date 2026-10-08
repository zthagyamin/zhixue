'use client';
import Link from 'next/link';
import {ReleaseSupport} from './release-support';
export default function ErrorPage({error,reset}:{error:Error&{digest?:string};reset:()=>void}){return <main className="support-page"><h1>这个页面暂时无法显示</h1><p>请先保留尚未确认保存的输入，再尝试重新打开。重试不会主动清除本机记录。</p><button type="button" onClick={reset}>重试页面</button><p><a href="/help" target="_blank" rel="noreferrer">在新页面打开帮助</a> · <Link href="/">返回首页</Link></p><ReleaseSupport digest={error.digest}/></main>;}
