import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./c-study.css";
import "./study-overview.css";
import "./study-interactions.css";
import "./study-core-ui.css";
import "./site-hierarchy.css";
import "./settings-progress-hierarchy.css";
import {StudyLayoutRuntime} from './study-layout-control';
import {OnboardingProvider} from './onboarding';
import {ReleaseNotice} from './release-support';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "知学 · 每日学习系统",
  description: "从 Obsidian 或本地笔记生成每日词汇、测验与差分复习。",
  openGraph: {
    title: "知学 · 每日学习系统",
    description: "连接自己的 Obsidian 或本地笔记，生成词汇、测验与差分复习。",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "知学 · 每日学习系统",
    description: "连接自己的 Obsidian 或本地笔记，生成词汇、测验与差分复习。",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* Public pages never carry an automatic modal. The release announcement is mounted only by
            the signed-in study workspace and by the updates page's explicit recall control. */}
        <OnboardingProvider><StudyLayoutRuntime/><ReleaseNotice/>{children}</OnboardingProvider>
      </body>
    </html>
  );
}
