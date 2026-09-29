import type { ReactNode } from "react";
import { HoloPanel, Icon } from "@nebula/game-ui";
import { useT } from "../lib/i18n.js";
import type { TKey } from "../lib/i18n.js";
import { useSettings } from "../store/settings.js";
import type { GraphicsSetting, Language } from "../store/settings.js";
import { PageHeader } from "../components/PageHeader.js";
import { isNative, platform } from "../native/platform.js";
import { haptic } from "../native/haptics.js";

const TIERS: { key: GraphicsSetting; label: TKey; hint: TKey }[] = [
  { key: "AUTO", label: "settings.tier.AUTO", hint: "settings.hint.AUTO" },
  { key: "ULTRA", label: "settings.tier.ULTRA", hint: "settings.hint.ULTRA" },
  { key: "HIGH", label: "settings.tier.HIGH", hint: "settings.hint.HIGH" },
  { key: "MEDIUM", label: "settings.tier.MEDIUM", hint: "settings.hint.MEDIUM" },
  { key: "LOW", label: "settings.tier.LOW", hint: "settings.hint.LOW" },
];

const KEYBINDS: readonly (readonly [TKey, string | TKey])[] = [
  ["settings.key.move", "W A S D"],
  ["settings.key.aim", "settings.kbd.mouse"],
  ["settings.key.fire", "settings.kbd.fire"],
  ["settings.key.skills", "1 – 9"],
  ["settings.key.dash", "Shift"],
  ["settings.key.dock", "F"],
  ["settings.key.map", "M"],
  ["settings.key.chat", "settings.kbd.enter"],
];

function isKey(k: string): k is TKey {
  return k.startsWith("settings.");
}

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
  const t = useT();
  return (
    <div className="flex items-center gap-3">
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} className="w-44 accent-[var(--nf-accent)]" />
      <span className="nf-ui w-10 text-right tabular-nums text-dim">{t("common.pct", { n: Math.round(((value - min) / (max - min)) * 100) })}</span>
    </div>
  );
}

export default function SettingsPage() {
  const t = useT();
  const s = useSettings();
  return (
    <div>
      <PageHeader eyebrow={t("settings.eyebrow")} title={t("nav.settings")} subtitle={t("settings.subtitle")} />
      <div className="grid gap-5 lg:grid-cols-2">
        <HoloPanel title={t("settings.graphics")}>
          <div className="grid gap-2" role="radiogroup" aria-label={t("settings.graphics")}>
            {TIERS.map((tier) => (
              <button key={tier.key} type="button" role="radio" aria-checked={s.graphics === tier.key} onClick={() => s.set("graphics", tier.key)}
                className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors" style={{ borderColor: s.graphics === tier.key ? "var(--nf-accent)" : "var(--nf-line)", background: s.graphics === tier.key ? "color-mix(in oklab, var(--nf-accent) 12%, transparent)" : undefined }}>
                <span className="grid h-4 w-4 place-items-center rounded-full border" style={{ borderColor: s.graphics === tier.key ? "var(--nf-accent)" : "var(--nf-line-strong)" }}>{s.graphics === tier.key && <span className="h-2 w-2 rounded-full bg-accent" />}</span>
                <span className="grid"><span className="nf-ui text-[15px] font-bold uppercase tracking-[0.1em]">{t(tier.label)}</span><span className="text-[12px] text-mute">{t(tier.hint)}</span></span>
              </button>
            ))}
          </div>
          <Row label={t("settings.reducedMotion")} hint={t("settings.reducedMotionHint")}><Toggle label={t("settings.reducedMotion")} on={s.reducedMotion} onChange={(v) => s.set("reducedMotion", v)} /></Row>
        </HoloPanel>
        <div className="grid content-start gap-5">
          <HoloPanel title={t("settings.audio")}>
            <Row label={t("settings.muteAll")}><Toggle label={t("settings.mute")} on={s.muted} onChange={(v) => s.set("muted", v)} /></Row>
            <Row label={t("settings.master")}><Slider label={t("settings.masterVolume")} value={s.masterVolume} onChange={(v) => s.set("masterVolume", v)} /></Row>
            <Row label={t("settings.music")}><Slider label={t("settings.musicVolume")} value={s.musicVolume} onChange={(v) => s.set("musicVolume", v)} /></Row>
            <Row label={t("settings.effects")}><Slider label={t("settings.effectsVolume")} value={s.sfxVolume} onChange={(v) => s.set("sfxVolume", v)} /></Row>
          </HoloPanel>
          <HoloPanel title={t("settings.language")}>
            <div className="flex gap-2">
              {(["en", "tr"] as Language[]).map((l) => (
                <button key={l} type="button" className="nf-chip cursor-pointer px-4 py-1.5 text-[13px]" style={s.language === l ? { color: "var(--nf-accent)", borderColor: "var(--nf-accent)" } : undefined} onClick={() => s.set("language", l)}>
                  <Icon name="globe" size={13} /><span lang={l}>{l === "en" ? "English" : "Türkçe"}</span>
                </button>
              ))}
            </div>
          </HoloPanel>
        </div>
        <HoloPanel title={t("settings.controls")}>
          <Row label={t("settings.damageNumbers")} hint={t("settings.damageNumbersHint")}><Toggle label={t("settings.damageNumbers")} on={s.showDamageNumbers} onChange={(v) => s.set("showDamageNumbers", v)} /></Row>
          <Row label={t("settings.haptics")} hint={t("settings.hapticsHint")}><Toggle label={t("settings.hapticsShort")} on={s.haptics} onChange={(v) => s.set("haptics", v)} /></Row>
          <Row label={t("settings.leftHanded")} hint={t("settings.leftHandedHint")}><Toggle label={t("settings.leftHandedShort")} on={s.leftHandedControls} onChange={(v) => s.set("leftHandedControls", v)} /></Row>
          <Row label={t("settings.invertY")}><Toggle label={t("settings.invertShort")} on={s.invertJoystick} onChange={(v) => s.set("invertJoystick", v)} /></Row>
          <Row label={t("settings.deadZone")}><Slider label={t("settings.deadZoneShort")} value={s.joystickDeadZone} min={0} max={0.4} step={0.02} onChange={(v) => s.set("joystickDeadZone", v)} /></Row>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px] text-dim">
            {KEYBINDS.map(([a, k]) => (
              <div key={a} className="flex justify-between"><span>{t(a)}</span><span className="nf-kbd">{isKey(k) ? t(k) : k}</span></div>
            ))}
          </div>
        </HoloPanel>
        <HoloPanel title={t("settings.device")}>
          <Row label={t("settings.platform")}><span className="nf-chip">{isNative ? platform : t("settings.browser")}</span></Row>
          <Row label={t("settings.build")}><span className="nf-mono text-dim">{import.meta.env.MODE}</span></Row>
        </HoloPanel>
      </div>
    </div>
  );
}
