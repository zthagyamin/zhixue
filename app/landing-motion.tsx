"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface LandingMotionProps {
  children: ReactNode;
  className?: string;
}

export function LandingMotion({ children, className = "" }: LandingMotionProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (media.matches) return;

    let rafId: number | null = null;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const rect = el.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      targetX = x * 10;
      targetY = -y * 10;

      if (rafId === null) {
        rafId = requestAnimationFrame(update);
      }
    };

    const update = () => {
      currentX += (targetX - currentX) * 0.1;
      currentY += (targetY - currentY) * 0.1;
      el.style.transform = `perspective(1000px) rotateX(${currentY.toFixed(2)}deg) rotateY(${currentX.toFixed(2)}deg)`;

      if (Math.abs(targetX - currentX) > 0.05 || Math.abs(targetY - currentY) > 0.05) {
        rafId = requestAnimationFrame(update);
      } else {
        rafId = null;
      }
    };

    const onPointerLeave = () => {
      targetX = 0;
      targetY = 0;
      if (rafId === null) {
        rafId = requestAnimationFrame(update);
      }
    };

    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerleave", onPointerLeave);

    return () => {
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerleave", onPointerLeave);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div ref={containerRef} className={`landing-motion-card ${className}`}>
      {children}
    </div>
  );
}
