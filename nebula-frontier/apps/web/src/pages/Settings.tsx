import type { ReactNode } from "react";
import { HoloPanel, Icon } from "@nebula/game-ui";
import { useT } from "../lib/i18n.js";
import { useSettings } from "../store/settings.js";
import type { GraphicsSetting, Language } from "../store/settings.js";
import { PageHeader } from "../components/PageHeader.js";
import { isNative, platform } from "../native/platform.js";
import { haptic } from "../native/haptics.js";

const TIERS: { key: GraphicsSetting; label: string; hint: string }[] = [
  { key: "AUTO", label: "Auto", hint: "Detects your GPU and adapts resolution to hold frame rate." },
  { key: "ULTRA", label: "Ultra", hint: "Shadows, bloom, physical materials, max particles." },
  { key: "HIGH", label: "High", hint: "Bloom and rich effects; best for gaming laptops." },
  { key: "MEDIUM", label: "Medium", hint: "Balanced visuals for most devices." },
  { key: "LOW", label: "Low", hint: "Battery saver: minimal effects, lower resolution." },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 py-3 last:border-0">
      <div className="grid gap-0.5"><span className="nf-ui text-[15px] font-bold">{label}</span>{hint && <span className="text-[12px] text-mute">{hint}</span>}</div>
      {children}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => { haptic("selection"); onChange(!on); }}
      className="relative h-7 w-12 rounded-full border transition-colors" style={{ borderColor: on ? "var(--nf-accent)" : "var(--nf-line-strong)", background: on ? "color-mix(in oklab, var(--nf-accent) 30%, transparent)" : "rgba(0,0,0,0.3)" }}>
      <span className="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full transition-all" style={{ left: on ? 24 : 3, background: on ? "var(--nf-accent)" : "var(--nf-text-mute)", boxShadow: on ? "0 0 10px var(--nf-accent)" : undefined }} />
    </button>
  );
}

function Slider({ value, onChange, label, min = 0, max = 1, step = 0.05 }: { value: number; onChange: (v: number) => void; label: string; min?: number; max?: number; step?: number }) {
  return (
    <div className="flex items-center gap-3">
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} className="w-44 accent-[var(--nf-accent)]" />
      <span className="nf-ui w-10 text-right tabular-nums text-dim">{Math.round(((value - min) / (max - min)) * 100)}%</span>
    </div>
  );
}

export default function SettingsPage() {
  const t = useT();
  const s = useSettings();
  return (
    <div>
      <PageHeader eyebrow="Systems" title={t("nav.settings")} subtitle="Preferences are stored on this device (secure storage on mobile)." />
      <div className="grid gap-5 lg:grid-cols-2">
        <HoloPanel title={t("settings.graphics")}>
          <div className="grid gap-2" role="radiogroup" aria-label={t("settings.graphics")}>
            {TIERS.map((tier) => (
              <button key={tier.key} type="button" role="radio" aria-checked={s.graphics === tier.key} onClick={() => s.set("graphics", tier.key)}
                className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors" style={{ borderColor: s.graphics === tier.key ? "var(--nf-accent)" : "var(--nf-line)", background: s.graphics === tier.key ? "color-mix(in oklab, var(--nf-accent) 12%, transparent)" : undefined }}>
                <span className="grid h-4 w-4 place-items-center rounded-full border" style={{ borderColor: s.graphics === tier.key ? "var(--nf-accent)" : "var(--nf-line-strong)" }}>{s.graphics === tier.key && <span className="h-2 w-2 rounded-full bg-accent" />}</span>
                <span className="grid"><span className="nf-ui text-[15px] font-bold uppercase tracking-[0.1em]">{tier.label}</span><span className="text-[12px] text-mute">{tier.hint}</span></span>
              </button>
            ))}
          </div>
          <Row label="Reduced motion" hint="Disables background animation and screen effects."><Toggle label="Reduced motion" on={s.reducedMotion} onChange={(v) => s.set("reducedMotion", v)} /></Row>
        </HoloPanel>
        <div className="grid content-start gap-5">
          <HoloPanel title={t("settings.audio")}>
            <Row label="Mute all"><Toggle label="Mute" on={s.muted} onChange={(v) => s.set("muted", v)} /></Row>
            <Row label="Master"><Slider label="Master volume" value={s.masterVolume} onChange={(v) => s.set("masterVolume", v)} /></Row>
            <Row label="Music"><Slider label="Music volume" value={s.musicVolume} onChange={(v) => s.set("musicVolume", v)} /></Row>
            <Row label="Effects"><Slider label="Effects volume" value={s.sfxVolume} onChange={(v) => s.set("sfxVolume", v)} /></Row>
          </HoloPanel>
          <HoloPanel title={t("settings.language")}>
            <div className="flex gap-2">
              {(["en", "tr"] as Language[]).map((l) => (
                <button key={l} type="button" className="nf-chip cursor-pointer px-4 py-1.5 text-[13px]" style={s.language === l ? { color: "var(--nf-accent)", borderColor: "var(--nf-accent)" } : undefined} onClick={() => s.set("language", l)}>
                  <Icon name="globe" size={13} />{l === "en" ? "English" : "Türkçe"}
                </button>
              ))}
            </div>
          </HoloPanel>
        </div>
        <HoloPanel title={t("settings.controls")}>
          <Row label="Damage numbers" hint="Floating combat text over targets."><Toggle label="Damage numbers" on={s.showDamageNumbers} onChange={(v) => s.set("showDamageNumbers", v)} /></Row>
          <Row label="Haptic feedback" hint="Vibration on hits and buttons (mobile)."><Toggle label="Haptics" on={s.haptics} onChange={(v) => s.set("haptics", v)} /></Row>
          <Row label="Left-handed layout" hint="Swap joystick and action buttons on touch screens."><Toggle label="Left-handed" on={s.leftHandedControls} onChange={(v) => s.set("leftHandedControls", v)} /></Row>
          <Row label="Invert joystick Y"><Toggle label="Invert joystick" on={s.invertJoystick} onChange={(v) => s.set("invertJoystick", v)} /></Row>
          <Row label="Joystick dead zone"><Slider label="Dead zone" value={s.joystickDeadZone} min={0} max={0.4} step={0.02} onChange={(v) => s.set("joystickDeadZone", v)} /></Row>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px] text-dim">
            {[["Move", "W A S D"], ["Aim / target", "Mouse · click"], ["Fire", "Space / hold LMB"], ["Skills", "1 – 9"], ["Dash", "Shift"], ["Dock", "F"], ["Map", "M"], ["Chat", "Enter"]].map(([a, k]) => (
              <div key={a} className="flex justify-between"><span>{a}</span><span className="nf-kbd">{k}</span></div>
            ))}
          </div>
        </HoloPanel>
        <HoloPanel title="Device">
          <Row label="Platform"><span className="nf-chip">{isNative ? platform : "browser"}</span></Row>
          <Row label="Build"><span className="nf-mono text-dim">{import.meta.env.MODE}</span></Row>
        </HoloPanel>
      </div>
    </div>
  );
}
