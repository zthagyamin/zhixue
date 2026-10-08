import Link from 'next/link';
import './release-support.css';
export default function NotFound(){return <main className="support-page"><h1>没有找到这个页面</h1><p>链接可能已经更改，请从首页重新进入。</p><nav><Link href="/">返回首页</Link><a href="/study">进入学习工作台</a><a href="/help">使用帮助</a></nav></main>;}
