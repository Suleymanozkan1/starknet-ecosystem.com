import { useMemo } from "react";
import { useT } from "../lib/i18n.js";
import { DEMO_MODE } from "../lib/demoMode.js";
import { AriaDialog } from "./AriaDialog.js";
import type { AriaStep } from "./AriaDialog.js";
import { BRIEFING_KEY, briefingSteps } from "./briefing.js";
import { useTutorial } from "./store.js";

/** The full ARIA briefing (landing page "Meet ARIA", Settings → "Open the full briefing"). */
export function AriaBriefing({ onClose, finalAction }: { onClose: () => void; finalAction?: { label: string; onClick: () => void } }) {
  const t = useT();
  const markSeen = useTutorial((s) => s.markSeen);
  const steps = useMemo<AriaStep[]>(
    () => briefingSteps(DEMO_MODE).map((s) => ({
      id: s.id,
      icon: s.icon,
      title: t(s.title),
      body: t(s.body, s.vars),
      ...(DEMO_MODE && s.demoNote ? { note: t(s.demoNote) } : {}),
    })),
    [t],
  );
  return (
    <AriaDialog
      steps={steps}
      label={t("aria.briefingLabel")}
      keyboard
      {...(finalAction ? { finalAction: { label: finalAction.label, onClick: () => { markSeen(BRIEFING_KEY); finalAction.onClick(); } } } : {})}
      onClose={() => {
        markSeen(BRIEFING_KEY);
        onClose();
      }}
    />
  );
}

/** Number of briefing topics in this build (shown on the landing "Meet ARIA" card). */
export const BRIEFING_TOPICS = briefingSteps(DEMO_MODE).length;
