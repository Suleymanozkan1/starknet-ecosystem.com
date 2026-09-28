import { useEffect, useRef, useState } from "react";
import type { ShipDef } from "@nebula/shared";
import { onAppActiveChange } from "../native/lifecycle.js";
import { useGraphicsTier } from "../hooks/useGraphicsTier.js";
import { ShipBlueprint } from "./ShipBlueprint.js";

export type PreviewMode = "idle" | "engine" | "fire" | "shield" | "damage";

/** The subset of the game-renderer hangar handle used by the web UI. */
interface HangarHandle {
  dispose(): void;
  setShip?(def: ShipDef, cosmetics?: Record<string, string>): void | Promise<void>;
  setCosmetics?(cosmetics: Record<string, string>): void;
  setPreview?(mode: PreviewMode): void;
  setAutoRotate?(on: boolean): void;
  setPaused?(paused: boolean): void;
  pause?(): void;
  resume?(): void;
  resize?(): void;
}
type CreateHangarViewer = (canvas: HTMLCanvasElement, opts: { shipDef: ShipDef; cosmetics: Record<string, string>; tier: string }) => HangarHandle | Promise<HangarHandle>;

export interface ShipViewerProps {
  def: ShipDef;
  cosmetics?: Record<string, string>;
  preview?: PreviewMode;
  autoRotate?: boolean;
  className?: string;
}

/**
 * Interactive 3D hangar preview (Three.js via @nebula/game-renderer `createHangarViewer`).
 * Rotation/zoom are handled by the renderer's orbit controls. Falls back to a 2D blueprint
 * when WebGL is unavailable. Rendering pauses while the app is in the background.
 */
export function ShipViewer({ def, cosmetics = {}, preview = "idle", autoRotate = true, className }: ShipViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<HangarHandle | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "fallback">("loading");
  const tier = useGraphicsTier();
  const cosmeticsKey = JSON.stringify(cosmetics);
  // Cosmetics are applied live (below); only ship/tier changes recreate the scene.
  const cosmeticsRef = useRef(cosmetics);
  cosmeticsRef.current = cosmetics;

  // (Re)create the viewer when the ship or tier changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let disposed = false;
    setState("loading");
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2") && !probe.getContext("webgl")) {
      setState("fallback");
      return undefined;
    }
    void import("@nebula/game-renderer")
      .then(async (mod) => {
        const create = (mod as unknown as { createHangarViewer?: CreateHangarViewer }).createHangarViewer;
        if (typeof create !== "function") throw new Error("hangar viewer unavailable");
        const h = await create(canvas, { shipDef: def, cosmetics: cosmeticsRef.current, tier });
        if (disposed) {
          h.dispose();
          return;
        }
        handleRef.current = h;
        setState("ready");
      })
      .catch((e: unknown) => {
        console.warn("3D hangar unavailable, using blueprint view", e);
        if (!disposed) setState("fallback");
      });
    return () => {
      disposed = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [def, tier]);

  useEffect(() => {
    handleRef.current?.setCosmetics?.(JSON.parse(cosmeticsKey) as Record<string, string>);
  }, [cosmeticsKey, state]);
  useEffect(() => {
    handleRef.current?.setPreview?.(preview);
  }, [preview, state]);
  useEffect(() => {
    handleRef.current?.setAutoRotate?.(autoRotate);
  }, [autoRotate, state]);
  useEffect(
    () =>
      onAppActiveChange((active) => {
        const h = handleRef.current;
        if (!h) return;
        if (h.setPaused) h.setPaused(!active);
        else if (active) h.resume?.();
        else h.pause?.();
      }),
    [],
  );

  return (
    <div className={className} style={{ position: "absolute", inset: 0 }}>
      <canvas ref={canvasRef} className="h-full w-full touch-none" style={{ display: state === "fallback" ? "none" : "block", opacity: state === "ready" ? 1 : 0, transition: "opacity .6s" }} aria-label={`${def.name} 3D preview`} />
      {state === "fallback" && <ShipBlueprint def={def} />}
      {state === "loading" && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="nf-ui text-[12px] uppercase tracking-[0.3em] text-mute">Rendering hull…</div>
        </div>
      )}
    </div>
  );
}
