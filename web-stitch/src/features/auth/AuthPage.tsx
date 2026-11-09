import { AlertTriangle, ArrowRight, LoaderCircle, Moon, ShieldCheck, Sun } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, type Session } from '../../api';
import type { Theme } from '../../app/theme';
import { BrandMark } from '../../components/BrandMark';

type AuthMode = 'login' | 'register';

function AuthVisual() {
  return <section className="auth-visual"><div className="auth-core"><i/><i/><i/><BrandMark className="hero-brand-mark"/></div><span className="eyebrow">Woody agent operating system</span><h1>Command your<br/>intelligent workforce.</h1><p>Deploy agents, ground them in trusted knowledge, connect tools, and inspect every execution.</p><div className="auth-signals"><span><i/>Live observability</span><span><i/>Secure by design</span><span><i/>Real workflow orchestration</span></div></section>;
}

function AuthFormPanel({ mode, setMode, error, submitting, submit }: {
  mode: AuthMode;
  setMode: (mode: AuthMode) => void;
  error: string;
  submitting: boolean;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const registering = mode === 'register';
  return <section className="auth-form-panel"><div className="auth-brand"><BrandMark/><div><strong>Woody</strong><small>Agent OS</small></div></div><span className="eyebrow">{registering ? 'Initialize workspace' : 'Secure access'}</span><h2>{registering ? 'Build your command center' : 'Welcome back'}</h2><p>{registering ? 'Create an account and private workspace.' : 'Sign in to continue operating.'}</p><div className="auth-tabs"><button className={registering ? 'active' : ''} onClick={() => setMode('register')}>Create account</button><button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Sign in</button></div>
    <form className="form-grid" onSubmit={submit}>{registering && <div className="form-columns"><label>Your name<input required name="displayName" placeholder="Alex Morgan"/></label><label>Workspace<input required name="workspaceName" placeholder="Acme AI"/></label></div>}<label>Email<input required type="email" name="email" autoComplete="email" placeholder="you@company.com"/></label><label>Password<input required type="password" minLength={12} name="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="At least 12 characters"/></label>{error && <div className="inline-error"><AlertTriangle size={15}/>{error}</div>}<button className="button primary auth-submit" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16}/> : <ShieldCheck size={16}/>} {registering ? 'Create secure workspace' : 'Sign in'}<ArrowRight size={16}/></button></form>
  </section>;
}

export function AuthPage({ onSession, theme, toggleTheme }: { onSession: (session: Session) => void; theme: Theme; toggleTheme: () => void }) {
  const [mode, setMode] = useState<AuthMode>('register');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const session = mode === 'login'
        ? await api.login({ email: String(form.get('email')), password: String(form.get('password')) })
        : await api.register({ email: String(form.get('email')), password: String(form.get('password')), displayName: String(form.get('displayName')), workspaceName: String(form.get('workspaceName')) });
      onSession(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in');
    } finally {
      setSubmitting(false);
    }
  };
  return <main className="auth-page">
    <button className="icon-button auth-theme" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button>
    <AuthVisual/>
    <AuthFormPanel mode={mode} setMode={setMode} error={error} submitting={submitting} submit={submit}/>
  </main>;
}
