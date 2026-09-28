import { Icon } from "@nebula/game-ui";

const STEPS = ["Account", "Faction", "Starter ship", "Deploy"];

export function OnboardingSteps({ step }: { step: number }) {
  return (
    <nav aria-label="Onboarding progress" className="mx-auto flex max-w-2xl items-center justify-center gap-2 sm:gap-3">
      <span className="nf-logo mr-2 hidden text-[13px] sm:inline">NEBULA <b>FRONTIER</b></span>
      {STEPS.map((s, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <div key={s} className="flex items-center gap-2 sm:gap-3">
            {i > 0 && <span className="h-px w-5 sm:w-10" style={{ background: done || current ? "var(--nf-accent)" : "var(--nf-line-strong)" }} />}
            <span className="nf-ui flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.16em]" style={{ color: current ? "var(--nf-accent)" : done ? "var(--nf-text)" : "var(--nf-text-mute)" }} aria-current={current ? "step" : undefined}>
              <span className="grid h-5 w-5 place-items-center rounded-full border text-[10px]" style={{ borderColor: "currentColor", background: current ? "color-mix(in oklab, var(--nf-accent) 20%, transparent)" : undefined }}>
                {done ? <Icon name="check" size={11} /> : i + 1}
              </span>
              <span className="hidden whitespace-nowrap sm:inline">{s}</span>
            </span>
          </div>
        );
      })}
    </nav>
  );
}
