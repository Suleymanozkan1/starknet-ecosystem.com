import { useEffect, useRef } from "react";
import { onAppActiveChange, isAppActive } from "../native/lifecycle.js";
import { useSettings } from "../store/settings.js";

interface Star { x: number; y: number; z: number; tw: number; hue: number }

/**
 * Cinematic menu backdrop: parallax starfield on a canvas + CSS nebula layers.
 * Pauses when the app is backgrounded; draws a single static frame with reduced motion.
 */
export function SpaceBackdrop({ density = 1 }: { density?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useSettings((s) => s.reducedMotion);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return undefined;
    const prefersReduced = reduced || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    let stars: Star[] = [];
    let raf = 0;
    let running = isAppActive();
    let mx = 0;
    let my = 0;

    const resize = (): void => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(420, (w * h) / 4200) * density);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w, y: Math.random() * h, z: Math.random() ** 2, tw: Math.random() * Math.PI * 2, hue: Math.random(),
      }));
    };

    const draw = (t: number): void => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        const depth = 0.15 + s.z;
        if (!prefersReduced) {
          s.y += depth * 0.06;
          if (s.y > h + 2) { s.y = -2; s.x = Math.random() * w; }
        }
        const px = s.x + mx * depth * 14;
        const py = s.y + my * depth * 10;
        const a = 0.35 + 0.65 * s.z * (0.75 + 0.25 * Math.sin(t * 0.002 + s.tw));
        const r = 0.35 + s.z * 1.35;
        ctx.fillStyle = s.hue > 0.86 ? `rgba(255,214,170,${a})` : s.hue > 0.7 ? `rgba(170,200,255,${a})` : `rgba(235,242,255,${a})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        if (s.z > 0.82) {
          ctx.fillStyle = `rgba(160,220,255,${a * 0.12})`;
          ctx.beginPath();
          ctx.arc(px, py, r * 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    const loop = (t: number): void => {
      draw(t);
      if (running && !prefersReduced) raf = requestAnimationFrame(loop);
    };
    const onMove = (e: PointerEvent): void => {
      mx = (e.clientX / window.innerWidth - 0.5) * 2;
      my = (e.clientY / window.innerHeight - 0.5) * 2;
    };

    resize();
    draw(0);
    if (!prefersReduced && running) raf = requestAnimationFrame(loop);
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    const off = onAppActiveChange((active) => {
      running = active;
      cancelAnimationFrame(raf);
      if (active && !prefersReduced) raf = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      off();
    };
  }, [density, reduced]);

  return (
    <div className="nf-backdrop" aria-hidden>
      <div className="nf-backdrop__nebula" />
      <canvas ref={ref} />
      <div className="nf-backdrop__grid" />
      <div className="nf-backdrop__vignette" />
    </div>
  );
}
