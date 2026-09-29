import { Link } from "react-router-dom";
import { useT } from "../lib/i18n.js";

export default function NotFoundPage() {
  const t = useT();
  return (
    <div className="relative z-10 grid min-h-screen place-items-center p-6 text-center">
      <div className="grid justify-items-center gap-3">
        <div className="nf-eyebrow">{t("notFound.eyebrow")}</div>
        <h1 className="nf-h1 text-[64px]">404</h1>
        <p className="m-0 text-dim">{t("notFound.body")}</p>
        <Link to="/" className="nf-btn nf-btn--primary no-underline">{t("notFound.back")}</Link>
      </div>
    </div>
  );
}
