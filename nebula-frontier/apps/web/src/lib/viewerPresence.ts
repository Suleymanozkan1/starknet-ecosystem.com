/**
 * Count of live 3D viewers on the page. The animated menu starfield pauses while one is shown so the
 * phone GPU is not compositing two per-frame canvases (the WebGL hangar flickered under that load).
 */
let live = 0;

export function viewerMounted(): () => void {
  live++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    live = Math.max(0, live - 1);
  };
}

export function liveViewers(): number {
  return live;
}
