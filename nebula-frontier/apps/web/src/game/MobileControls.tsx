import { useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Icon } from "@nebula/game-ui";
import type { IconName } from "@nebula/game-ui";
import type { HudSkill, HudView } from "./hudModel.js";
import type { GameActions } from "./adapter.js";
import { haptic } from "../native/haptics.js";
import { useSettings } from "../store/settings.js";
import { useT } from "../lib/i18n.js";

/** Left virtual joystick → actions.setJoystick(x, y) with dead zone; y is screen-down positive unless inverted. */
function Joystick({ actions, side }: { actions: GameActions; side: "left" | "right" }) {
  const t = useT();
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const pointer = useRef<number | null>(null);
  const dead = useSettings((s) => s.joystickDeadZone);
  const invert = useSettings((s) => s.invertJoystick);

  const update = (e: ReactPointerEvent): void => {
    const el = base.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = (e.clientX - (r.left + radius)) / radius;
    let dy = (e.clientY - (r.top + radius)) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    setKnob({ x: dx * radius * 0.62, y: dy * radius * 0.62 });
    const mag = Math.min(1, len);
    if (mag < dead) actions.setJoystick(0, 0);
    else {
      const k = (mag - dead) / (1 - dead) / (mag || 1);
      actions.setJoystick(dx * k, (invert ? -dy : dy) * k);
    }
  };
  const end = (): void => {
    pointer.current = null;
    setKnob({ x: 0, y: 0 });
    actions.setJoystick(0, 0);
  };
  return (
    <div
      ref={base}
      className="nf-joystick"
      style={{ [side]: "calc(24px + var(--safe-left))", bottom: "calc(28px + var(--safe-bottom))" } as CSSProperties}
      onPointerDown={(e) => { pointer.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); haptic("selection"); update(e); }}
      onPointerMove={(e) => { if (pointer.current === e.pointerId) update(e); }}
      onPointerUp={end}
      onPointerCancel={end}
      role="application"
      aria-label={t("mc.joystick")}
    >
      <div className="nf-joystick__knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}

function TouchButton({ size, icon, label, color, onPress, onRelease, disabled, cooldown, children }: {
  size: number; icon: IconName; label: string; color?: string; onPress: () => void; onRelease?: () => void; disabled?: boolean; cooldown?: number; children?: ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      className="nf-touchbtn"
      data-pressed={pressed}
      disabled={disabled}
      style={{ width: size, height: size, "--tc": color, opacity: disabled ? 0.4 : 1 } as CSSProperties}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setPressed(true); haptic("light"); onPress(); }}
      onPointerUp={() => { setPressed(false); onRelease?.(); }}
      onPointerCancel={() => { setPressed(false); onRelease?.(); }}
      aria-label={label}
    >
      <Icon name={icon} size={size * 0.38} />
      {size >= 60 && <span className="mt-0.5">{label}</span>}
      {cooldown !== undefined && cooldown > 0 && (
        <span className="absolute inset-0 grid place-items-center rounded-full bg-black/60 font-display text-[14px]">{Math.ceil(cooldown / 1000)}</span>
      )}
      {children}
    </button>
  );
}

function pick(skills: HudSkill[], pred: (s: HudSkill) => boolean): HudSkill | undefined {
  return skills.find(pred);
}

/**
 * Touch combat layout: only critical controls. Left: joystick. Right cluster: Fire (hold), Ability 1/2,
 * Ultimate, EMP, Shield, Dash. Target row: nearest enemy / player / objective and manual lock.
 */
export function MobileControls({ hud, actions }: { hud: HudView; actions: GameActions }) {
  const t = useT();
  const left = useSettings((s) => s.leftHandedControls);
  const abilities = hud.skills.filter((s) => s.kind === "ABILITY");
  const ult = pick(hud.skills, (s) => s.kind === "ULTIMATE");
  const emp = pick(hud.skills, (s) => /emp/i.test(s.name));
  const shield = pick(hud.skills, (s) => s.kind === "MODULE" && /shield/i.test(s.name));
  const use = (s: HudSkill | undefined) => () => { if (s) { actions.useSkill(s.slot); haptic("medium"); } };
  const actionSide = left ? "left" : "right";
  const joySide = left ? "right" : "left";
  return (
    <>
      <Joystick actions={actions} side={joySide} />
      <div className="absolute grid gap-3" style={{ [actionSide]: "calc(18px + var(--safe-right))", bottom: "calc(22px + var(--safe-bottom))" } as CSSProperties}>
        <div className="flex items-end gap-3" style={{ flexDirection: left ? "row-reverse" : "row" }}>
          <div className="grid gap-2.5">
            <TouchButton size={52} icon="ultimate" label={t("mc.ultimate")} color="var(--nf-credits)" disabled={!ult} cooldown={ult?.remainingMs} onPress={use(ult)} />
            <TouchButton size={52} icon="zap" label={t("mc.ability2")} disabled={!abilities[1]} cooldown={abilities[1]?.remainingMs} onPress={use(abilities[1])} />
            <TouchButton size={52} icon="zap" label={t("mc.ability1")} disabled={!abilities[0]} cooldown={abilities[0]?.remainingMs} onPress={use(abilities[0])} />
          </div>
          <div className="grid justify-items-center gap-2.5">
            <div className="flex gap-2.5">
              <TouchButton size={48} icon="emp" label={t("mc.emp")} color="#a78bfa" disabled={!emp} cooldown={emp?.remainingMs} onPress={use(emp)} />
              <TouchButton size={48} icon="shield" label={t("stat.shield")} color="#60a5fa" disabled={!shield} cooldown={shield?.remainingMs} onPress={use(shield)} />
            </div>
            <TouchButton size={96} icon="fire" label={t("mc.fire")} color="var(--nf-bad)" onPress={() => actions.setFiring(true)} onRelease={() => actions.setFiring(false)} />
            <TouchButton size={52} icon="dash" label={t("mc.dash")} onPress={() => actions.dash()} />
          </div>
        </div>
      </div>
      <div className="absolute flex gap-2" style={{ [actionSide]: "calc(18px + var(--safe-right))", bottom: "calc(300px + var(--safe-bottom))" } as CSSProperties}>
        {([["NEAREST_ENEMY", "target", "mc.enemy"], ["NEAREST_PLAYER", "user", "mc.player"], ["NEAREST_OBJECTIVE", "missions", "hud.objective"]] as const).map(([mode, icon, label]) => (
          <TouchButton key={mode} size={42} icon={icon} label={t(label)} onPress={() => { actions.target(mode); haptic("selection"); }} />
        ))}
        <TouchButton size={42} icon="lock" label={t("mc.manualLock")} color={hud.target ? "var(--nf-good)" : undefined} onPress={() => actions.toggleManualLock()} />
      </div>
    </>
  );
}
