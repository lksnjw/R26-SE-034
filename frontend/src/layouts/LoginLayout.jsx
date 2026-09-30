import BrandLogo from "../components/brand/BrandLogo";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import "../styles/login.css";

function WorkflowIllustration() {
  return (
    <figure className="login-flow">
      <svg viewBox="0 0 500 238" fill="none" role="img" aria-labelledby="login-flow-title">
        <title id="login-flow-title">An example workflow: a request is validated, reviewed when needed, then run.</title>
        <defs><pattern id="login-flow-dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle className="login-flow-dot" cx="1" cy="1" r="1" fill="#DBD5DB" /></pattern></defs>
        <rect width="500" height="238" fill="url(#login-flow-dots)" />
        <g className="login-flow-path" stroke="#C9B5C6" strokeWidth="1.5">
          <path d="M140 83h48M306 83h46" />
          <path d="M247 110v49a14 14 0 0 0 14 14h91" strokeDasharray="4 5" />
        </g>
        <g className="login-flow-nodes" fill="white" stroke="#E3DDE3">
          <rect x="16" y="55" width="124" height="56" rx="12" /><rect x="188" y="55" width="118" height="56" rx="12" />
          <rect x="352" y="55" width="132" height="56" rx="12" /><rect x="352" y="150" width="132" height="46" rx="10" />
        </g>
        <g className="login-flow-icons" stroke="#84006A" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M33 73h16a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-9l-6 4v-4h-1a3 3 0 0 1-3-3V76a3 3 0 0 1 3-3Z" />
          <path d="m207 82 5 5 9-10m149-3 13 9-13 9V74Zm-1 97h13m-6-5 6 5-6 5" />
        </g>
        <g className="login-flow-labels" fill="#3E3540" fontFamily="Arial, sans-serif" fontSize="12" fontWeight="600">
          <text x="63" y="87">Request</text><text x="232" y="87">Validate</text><text x="396" y="87">Run tools</text><text x="394" y="176">Review</text>
        </g>
        <text className="login-flow-hint" x="265" y="144" fill="#87738A" fontFamily="Arial, sans-serif" fontSize="10">If needed</text>
        <g className="login-flow-ports" fill="#84006A"><circle cx="140" cy="83" r="3" /><circle cx="188" cy="83" r="3" /><circle cx="306" cy="83" r="3" /><circle cx="352" cy="83" r="3" /></g>
      </svg>
      <figcaption>An example of how your work connects.</figcaption>
    </figure>
  );
}

export default function LoginLayout({ children }) {
  const { isDarkMode, toggleTheme } = useTheme();
  return (
    <div className="login-screen" data-theme={isDarkMode ? "dark" : "light"}>
      <header className="login-header">
        <BrandLogo />
        <div className="login-header-actions">
          <span className="login-header-note">Your connected workspace</span>
          <button type="button" className="login-theme-toggle" onClick={toggleTheme}
            aria-label={isDarkMode ? "Switch to light theme" : "Switch to dark theme"}>
            {isDarkMode ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </button>
        </div>
      </header>
      <main className="login-main">
        <section className="login-introduction" aria-label="About Agentic">
          <span className="login-eyebrow"><span /> From intent to action</span>
          <h2>Your work.<br />A clearer way to flow<span className="login-accent">.</span></h2>
          <p>Chat with your agent, shape your workflows,<br className="login-desktop-break" /> and keep every step in view.</p>
          <WorkflowIllustration />
          <div className="login-capabilities"><span>Chat</span><i /><span>Build</span><i /><span>Run</span></div>
        </section>
        <section className="login-form-region" aria-labelledby="login-title">
          <div className="login-form-content">
            <div className="login-form-heading">
              <span className="login-form-eyebrow">LET’S GET TO WORK</span>
              <h1 id="login-title">Welcome back</h1><p>Sign in to your workspace to continue.</p>
            </div>
            {children}
          </div>
        </section>
      </main>
      <footer className="login-footer"><span>© {new Date().getFullYear()} Agentic Workflow Engine</span><span>A workspace for connected work.</span></footer>
    </div>
  );
}
