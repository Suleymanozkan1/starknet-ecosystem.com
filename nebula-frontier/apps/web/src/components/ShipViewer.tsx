import { useEffect, useRef, useState } from "react";
import type { ShipDef } from "@nebula/shared";
import type { HangarViewer } from "@nebula/game-renderer";
import { useGraphicsTier } from "../hooks/useGraphicsTier.js";
import { ShipBlueprint } from "./ShipBlueprint.js";
import { useT } from "../lib/i18n.js";

export type PreviewMode = "idle" | "engine" | "fire" | "shield" | "damage";

export interface ShipViewerProps {
  def: ShipDef;
  /** Ship cosmetics map (slot → item id) as returned by the API. */
  cosmetics?: Record<string, string>;
  preview?: PreviewMode;
  autoRotate?: boolean;
  /** Second ship shown side by side for comparison. */
  compare?: ShipDef | null;
  className?: string;
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * Interactive 3D hangar preview via @nebula/game-renderer `createHangarViewer` (loaded lazily so three.js
 * stays out of the main bundle). Orbit controls handle rotate / zoom / pinch. Falls back to a 2D blueprint
 * when WebGL is unavailable. Rendering uses requestAnimationFrame, which the browser / Capacitor webview
 * suspends while the app is backgrounded.
 */
export function ShipViewer({ def, cosmetics = {}, preview = "idle", autoRotate = true, compare = null, className }: ShipViewerProps) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewer, setViewer] = useState<HangarViewer | null>(null);
  const [failed, setFailed] = useState(false);
  const tier = useGraphicsTier();
  const initial = useRef({ def, cosmetics, autoRotate });
  initial.current = { def, cosmetics, autoRotate };

  // Create once per canvas + graphics tier.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    if (!hasWebGL()) {
      setFailed(true);
      return undefined;
    }
    let disposed = false;
    let instance: HangarViewer | null = null;
    setFailed(false);
    void import("@nebula/game-renderer")
      .then(({ createHangarViewer }) =>
        createHangarViewer(canvas, {
          shipDef: initial.current.def,
          cosmetics: Object.values(initial.current.cosmetics),
          tier,
          autoRotate: initial.current.autoRotate,
          transparent: true,
        }),
      )
      .then((v) => {
        if (disposed) {
          v.dispose();
          return;
        }
        instance = v;
        setViewer(v);
      })
      .catch((e: unknown) => {
        console.warn("3D hangar unavailable, using blueprint view", e);
        if (!disposed) setFailed(true);
      });
    const ro = new ResizeObserver(() => instance?.resize());
    ro.observe(canvas);
    return () => {
      disposed = true;
      ro.disconnect();
      instance?.dispose();
      setViewer(null);
    };
  }, [tier]);

  useEffect(() => {
    viewer?.setShip(def);
  }, [viewer, def]);
  const cosmeticKey = Object.values(cosmetics).sort().join("|");
  useEffect(() => {
    viewer?.setCosmetics(cosmeticKey ? cosmeticKey.split("|") : []);
  }, [viewer, cosmeticKey]);
  useEffect(() => {
    viewer?.setAutoRotate(autoRotate);
  }, [viewer, autoRotate]);
  useEffect(() => {
    viewer?.setCompare(compare);
  }, [viewer, compare]);
  useEffect(() => {
    if (!viewer) return undefined;
    viewer.previewEngines(preview === "engine" || preview === "fire");
    viewer.previewDamage(preview === "damage" ? 0.65 : 0);
    if (preview === "fire" || preview === "shield") {
      const tick = (): void => (preview === "fire" ? viewer.fireWeapons() : viewer.previewShield());
      tick();
      const t = window.setInterval(tick, preview === "fire" ? 900 : 1600);
      return () => window.clearInterval(t);
    }
    return undefined;
  }, [viewer, preview]);

  return (
    <div className={className} style={{ position: "absolute", inset: 0 }}>
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none"
        style={{ display: failed ? "none" : "block", opacity: viewer ? 1 : 0, transition: "opacity .6s" }}
        aria-label={t("ship.previewAria", { name: def.name })}
      />
      {failed && <ShipBlueprint def={def} />}
      {!viewer && !failed && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="nf-ui text-[12px] uppercase tracking-[0.3em] text-mute">{t("ship.rendering")}</div>
        </div>
      )}
    </div>
  );
}
