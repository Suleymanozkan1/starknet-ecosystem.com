import type { CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FACTIONS, MAPS, SHIPS } from "@nebula/config";
import { FactionEmblem, Icon, NeonButton } from "@nebula/game-ui";
import type { IconName } from "@nebula/game-ui";
import { useT } from "../lib/i18n.js";
import { useMe } from "../lib/queries.js";
import { postLoginRoute } from "../routes/guards.js";
import { useSettings } from "../store/settings.js";

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: "sword", title: "Server-authoritative combat", body: "Every shot, shield hit and loot drop is decided on the server. Skill wins, not scripts." },
  { icon: "galaxy", title: "A living galaxy", body: `${MAPS.length} hand-built maps: faction homeworlds, mining belts, pirate rifts, gates and raid vaults.` },
  { icon: "clan", title: "Clans & territory", body: "Found a clan, raise a station, declare war and hold sectors for your faction." },
  { icon: "crypto", title: "Season Rewards", body: "Top competitive play can earn capped Battle Rewards settled on Solana devnet — transparent rules, no pay-to-earn." },
];

function Planet() {
  return (
    <div aria-hidden className="pointer-events-none absolute right-[-12vw] top-[8vh] hidden aspect-square w-[min(62vw,820px)] md:block">
      <div
        className="absolute inset-[12%] rounded-full"
        style={{
          background: "radial-gradient(circle at 32% 30%, color-mix(in oklab, var(--nf-accent) 55%, white 10%) 0%, color-mix(in oklab, var(--nf-accent) 30%, #0b1a3a) 28%, #060b1a 62%, #02040a 78%)",
          boxShadow: "inset -60px -40px 120px rgba(0,0,0,0.85), 0 0 120px -20px var(--nf-accent)",
        }}
      />
      <div className="absolute inset-[12%] rounded-full opacity-40 mix-blend-screen" style={{ background: "repeating-linear-gradient(-18deg, transparent 0 22px, rgba(255,255,255,0.06) 22px 26px)", maskImage: "radial-gradient(circle at 35% 35%, black 30%, transparent 70%)" }} />
      <div className="absolute left-[-6%] right-[-6%] top-[44%] h-[18%] rounded-[50%] border-[2px] opacity-70" style={{ borderColor: "color-mix(in oklab, var(--nf-accent) 60%, transparent)", transform: "rotate(-14deg)", boxShadow: "0 0 30px -6px var(--nf-accent)" }} />
      <div className="absolute left-[2%] right-[2%] top-[47%] h-[12%] rounded-[50%] border opacity-40" style={{ borderColor: "var(--nf-accent-2)", transform: "rotate(-14deg)" }} />
    </div>
  );
}

export function LandingPage() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const lang = useSettings((s) => s.language);
  const setSetting = useSettings((s) => s.set);
  const signedIn = Boolean(me.data);
  const enter = (): void => {
    void navigate(me.data ? postLoginRoute(me.data) : "/register");
  };

  return (
    <div className="relative z-10 min-h-screen overflow-x-hidden">
      <Planet />
      <header className="relative z-10 flex items-center justify-between gap-3 px-[max(16px,4vw)] pt-[calc(18px+var(--safe-top))]">
        <div className="nf-logo text-[16px]">NEBULA <b>FRONTIER</b></div>
        <div className="flex items-center gap-2">
          <button type="button" className="nf-chip cursor-pointer" onClick={() => setSetting("language", lang === "en" ? "tr" : "en")} aria-label="Switch language">
            <Icon name="globe" size={13} /> {lang.toUpperCase()}
          </button>
          {signedIn ? (
            <NeonButton size="sm" onClick={enter}>Continue</NeonButton>
          ) : (
            <Link to="/login" className="nf-btn nf-btn--sm nf-btn--ghost no-underline">{t("landing.login")}</Link>
          )}
        </div>
      </header>

      <section className="relative z-10 grid min-h-[78vh] content-center gap-7 px-[max(16px,6vw)] py-16 md:max-w-[62vw]">
        <div className="nf-eyebrow">Season 1 · The Vanta Rift is open</div>
        <h1 className="m-0 font-display text-[clamp(44px,8.2vw,112px)] font-black leading-[0.92] tracking-[0.04em]">
          <span className="block bg-gradient-to-b from-white to-[#9fb7d9] bg-clip-text text-transparent">NEBULA</span>
          <span className="nf-glow-text block bg-clip-text text-transparent" style={{ backgroundImage: "linear-gradient(90deg, var(--nf-accent), var(--nf-accent-2))" }}>FRONTIER</span>
        </h1>
        <p className="m-0 max-w-[560px] text-[clamp(15px,1.4vw,19px)] leading-relaxed text-dim">{t("landing.tagline")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <NeonButton variant="primary" size="lg" onClick={enter} icon={<Icon name="play" size={18} />} data-testid="cta-enter">
            {signedIn ? "Continue" : t("landing.enter")}
          </NeonButton>
          {!signedIn && (
            <Link to="/login" className="nf-btn nf-btn--lg no-underline">
              <Icon name="wallet" size={18} /> {t("auth.wallet")}
            </Link>
          )}
        </div>
        <div className="nf-ui flex flex-wrap gap-x-8 gap-y-2 text-[13px] uppercase tracking-[0.2em] text-mute">
          <span><b className="text-ink">{FACTIONS.length}</b> factions</span>
          <span><b className="text-ink">{SHIPS.length}</b> ships</span>
          <span><b className="text-ink">{MAPS.length}</b> maps</span>
          <span>Browser · Android · iOS</span>
        </div>
      </section>

      <section className="relative z-10 px-[max(16px,6vw)] pb-16" aria-labelledby="factions-h">
        <div className="mb-5 flex items-end justify-between gap-3">
          <div>
            <div className="nf-eyebrow">Three powers</div>
            <h2 id="factions-h" className="nf-h1 mt-1">Choose your allegiance</h2>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {FACTIONS.map((f) => (
            <article key={f.id} className="nf-panel nf-panel--interactive nf-panel--cut p-5" style={{ "--nf-accent": f.color } as CSSProperties} onClick={enter}>
              <div className="flex items-center gap-4">
                <FactionEmblem path={f.emblem} color={f.color} secondaryColor={f.secondaryColor} size={64} />
                <div className="min-w-0">
                  <div className="nf-display text-[15px] font-bold tracking-[0.14em]" style={{ color: f.color }}>{f.name}</div>
                  <div className="text-[13px] italic text-dim">“{f.motto}”</div>
                </div>
              </div>
              <p className="mb-0 mt-4 line-clamp-3 text-[13.5px] leading-relaxed text-dim">{f.lore}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="relative z-10 grid gap-4 px-[max(16px,6vw)] pb-20 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="nf-panel p-5">
            <span className="text-accent"><Icon name={f.icon} size={26} /></span>
            <div className="nf-ui mt-3 text-[17px] font-bold uppercase tracking-[0.08em]">{f.title}</div>
            <p className="mb-0 mt-1.5 text-[13.5px] leading-relaxed text-dim">{f.body}</p>
          </div>
        ))}
      </section>

      <footer className="relative z-10 border-t border-line px-[max(16px,6vw)] py-6 pb-[calc(24px+var(--safe-bottom))] text-[12px] text-mute">
        Nebula Frontier is an original work. Blockchain features run on Solana devnet only. Battle Rewards are promotional, capped and never guaranteed.
      </footer>
    </div>
  );
}
