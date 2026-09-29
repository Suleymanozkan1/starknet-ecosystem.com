import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <div className="relative z-10 grid min-h-screen place-items-center p-6 text-center">
      <div className="grid justify-items-center gap-3">
        <div className="nf-eyebrow">Signal lost</div>
        <h1 className="nf-h1 text-[64px]">404</h1>
        <p className="m-0 text-dim">These coordinates lead to empty space.</p>
        <Link to="/" className="nf-btn nf-btn--primary no-underline">Return to base</Link>
      </div>
    </div>
  );
}
