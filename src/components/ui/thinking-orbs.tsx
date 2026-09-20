/**
 * thinking-orbs
 *
 * ported verbatim from hp635738-pro/compo (thinking-orbs). Changes for HPOS/Vite: removed the RSC "use client" directive.
 */

import React from "react";

export type ThinkingOrbState =
  | "composing"
  | "working"
  | "searching"
  | "listening"
  | "shaping";

interface ThinkingOrbProps {
  state?: ThinkingOrbState;
  size?: number;
  theme?: "dark" | "light";
  className?: string;
}

const STATE_CONFIG: Record<
  ThinkingOrbState,
  { hues: [string, string]; orbs: number; speed: number }
> = {
  composing: { hues: ["#a78bfa", "#f97316"], orbs: 5, speed: 1 },
  working: { hues: ["#38bdf8", "#a78bfa"], orbs: 6, speed: 1.4 },
  searching: { hues: ["#34d399", "#38bdf8"], orbs: 7, speed: 1.8 },
  listening: { hues: ["#f97316", "#facc15"], orbs: 4, speed: 0.8 },
  shaping: { hues: ["#f472b6", "#a78bfa"], orbs: 6, speed: 1.2 },
};

export const ThinkingOrb = React.forwardRef<
  HTMLCanvasElement,
  ThinkingOrbProps
>(({ state = "composing", size = 64, theme = "dark", className }, ref) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const cfg = STATE_CONFIG[state];
    let raf = 0;
    const t0 = performance.now();

    const draw = (now: number) => {
      const t = ((now - t0) / 1000) * cfg.speed;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const R = canvas.width * 0.32;

      // Pulsing core glow
      const pulse = 0.75 + Math.sin(t * 2.2) * 0.25;
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.9);
      core.addColorStop(0, `${cfg.hues[0]}cc`);
      core.addColorStop(0.5, `${cfg.hues[1]}55`);
      core.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = pulse;
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Orbiting glowing orbs
      for (let i = 0; i < cfg.orbs; i++) {
        const a = t * (1 + i * 0.13) + (i * Math.PI * 2) / cfg.orbs;
        const r = R * (0.55 + 0.35 * Math.sin(t * 0.9 + i));
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r * 0.85;
        const orbR = canvas.width * (0.05 + 0.02 * Math.sin(t * 3 + i));
        const g = ctx.createRadialGradient(x, y, 0, x, y, orbR * 2.2);
        const hue = i % 2 ? cfg.hues[1] : cfg.hues[0];
        g.addColorStop(0, hue);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, orbR * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [state, size]);

  return (
    <canvas
      ref={(node) => {
        canvasRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      className={className}
      style={{
        width: size,
        height: size,
        filter: theme === "light" ? "saturate(0.9)" : undefined,
      }}
      role="img"
      aria-label={`AI ${state}`}
    />
  );
});
ThinkingOrb.displayName = "ThinkingOrb";
