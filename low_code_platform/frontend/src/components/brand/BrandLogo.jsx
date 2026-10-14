/** A vector master of this mark is available in public/brand. */
export function BrandMark({ className = "", size = 56, label = "Agentic" }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" fill="none" role="img" aria-label={`${label} logo`}>
      <path d="M13 49 28.5 15.5a4 4 0 0 1 7 0L51 49M22 34h20" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <g fill="currentColor"><circle cx="13" cy="49" r="6" /><circle cx="51" cy="49" r="6" /><circle cx="32" cy="14" r="6" /></g>
      <circle className="auth-brand-center" cx="32" cy="34" r="4" fill="#FFF" />
    </svg>
  );
}

export default function BrandLogo() {
  return (
    <div className="auth-brand">
      <BrandMark className="auth-brand-mark" />
      <div className="auth-brand-type">
        <span className="auth-brand-name">agentic</span>
        <span className="auth-brand-description">Workflow Engine</span>
      </div>
    </div>
  );
}
