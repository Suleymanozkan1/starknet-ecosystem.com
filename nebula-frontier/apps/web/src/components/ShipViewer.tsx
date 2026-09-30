import { useEffect, useRef, useState } from "react";
import type { ShipDef } from "@nebula/shared";
import type { HangarPreviewMode, HangarViewer } from "@nebula/game-renderer";
import { useGraphicsTier } from "../hooks/useGraphicsTier.js";
import { ShipBlueprint } from "./ShipBlueprint.js";
import { useT } from "../lib/i18n.js";
import { viewerMounted } from "../lib/viewerPresence.js";

export type PreviewMode = HangarPreviewMode;

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

let webglProbe: boolean | null = null;

/**
 * One-off WebGL probe. The probe context is released right away: browsers cap live WebGL contexts
 * (~8 on mobile, 16 on desktop) and evict the oldest — i.e. the visible hangar — when a leaked probe
 * pushes the page over the limit, which blanks the viewer until its context is restored.
 */
function hasWebGL(): boolean {
  if (webglProbe !== null) return webglProbe;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    webglProbe = Boolean(gl);
  } catch {
    webglProbe = false;
  }
  return webglProbe;
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

  // Pause the animated starfield behind the page while this viewer is on screen.
  useEffect(() => viewerMounted(), []);

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
          // Only automated pixel tests need the last frame kept readable.
          preserveDrawingBuffer: navigator.webdriver === true,
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
    // The viewer observes its own canvas size (and redraws in the same frame), so no second observer here.
    return () => {
      disposed = true;
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
    viewer?.setPreview(preview);
  }, [viewer, preview]);

  return (
    <div className={className} style={{ position: "absolute", inset: 0 }} data-nf-3d="">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none"
        style={{ display: failed ? "none" : "block", opacity: viewer ? 1 : 0, transition: "opacity .6s" }}
        aria-label={t("ship.previewAria", { name: def.name })}
        data-testid="ship-viewer-canvas"
        data-ready={viewer ? "true" : "false"}
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
