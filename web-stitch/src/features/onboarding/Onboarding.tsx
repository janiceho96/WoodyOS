import { Activity, ArrowRight, BookOpen, Bot, Check, CheckCircle2, ChevronLeft, ChevronRight, Command, Database, LayoutDashboard, Lightbulb, Network, Rocket, Sparkles, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Agent, type Onboarding, type Task } from '../../api';

export function OnboardingFlow({ state, storageKey, agents, tasks, onUpdate, onPage, onPause, onCreateAgent }: {
  state: Onboarding; storageKey: string; agents: Agent[]; tasks: Task[]; onUpdate: (state: Onboarding) => void;
  onPage: (path: string) => void; onPause: () => void; onCreateAgent: () => void;
}) {
  const [step, setStep] = useState(() => Math.max(state.lastStep, Number(localStorage.getItem(storageKey)) || 1));
  const [error, setError] = useState('');
  const save = async (action: 'progress' | 'complete' | 'skip', next = step) => {
    try { const updated = await api.onboarding({ lastStep: next, action }); localStorage.removeItem(storageKey); onUpdate(updated); setError(''); return updated; }
    catch { localStorage.setItem(storageKey, String(next)); setError('Your place is saved on this device. Reconnect to sync progress.'); return null; }
  };
  const move = (next: number) => { setStep(next); void save('progress', next); };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onPause(); if (event.key === 'ArrowRight' && step < 6) move(step + 1); if (event.key === 'ArrowLeft' && step > 1) move(step - 1); };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [step]);
  const completed = { agent: agents.some((agent) => agent.status === 'active'), task: tasks.length > 0 };
  const content = [
    { Icon: Network, title: 'Welcome to Woody', text: 'One command center for agents, knowledge, tools, workflows, and auditable execution.', body: <div className="onboarding-signals"><span><Bot size={17}/>Agent operations</span><span><Database size={17}/>Trusted knowledge</span><span><Activity size={17}/>Live observability</span></div> },
    { Icon: Command, title: 'From intent to execution', text: 'Define an outcome, select an active agent, then follow every event, cost, and final result.', body: <div className="onboarding-flowline"><span>Intent</span><ArrowRight/><span>Agent</span><ArrowRight/><span>Tools</span><ArrowRight/><span>Result</span></div> },
    { Icon: LayoutDashboard, title: 'Your operating workspace', text: 'The sidebar keeps every core system within reach.', body: <div className="onboarding-cards"><span><Bot/><strong>Agents</strong><small>Specialists with roles and guardrails.</small></span><span><BookOpen/><strong>Knowledge</strong><small>Searchable, grounded context.</small></span><span><Workflow/><strong>Workflows</strong><small>Validated repeatable automation.</small></span></div> },
    { Icon: Lightbulb, title: 'Smart, visible guidance', text: 'Loading, empty, error, and completion states explain what is happening and what to do next.', body: <div className="smart-tip-demo"><Sparkles/><span><strong>Smart tip</strong>Use focused agent goals for clearer outputs and lower cost.</span></div> },
    { Icon: Rocket, title: 'Complete your first mission', text: 'Create a deployed agent, give it one focused task, then review the result in Logs.', body: <div className="onboarding-checklist"><span className={completed.agent ? 'done' : ''}><Check/>{completed.agent ? 'Active agent created' : 'Create an active agent'}</span><span className={completed.task ? 'done' : ''}><Check/>{completed.task ? 'Task queued' : 'Give it a focused task'}</span><button className="button primary" onClick={() => { void save('progress', 5); onCreateAgent(); }}>{completed.agent ? 'Create another agent' : 'Create your first agent'}</button></div> },
    { Icon: CheckCircle2, title: 'Command center ready', text: 'Your guided setup is complete. You can restart it at any time from Settings.', body: <div className="onboarding-complete"><CheckCircle2/><span>System initialized</span></div> },
  ][step - 1];
  const Icon = content.Icon;
  return <div className="modal-backdrop onboarding-backdrop"><section className="onboarding-modal" role="dialog" aria-modal="true" aria-label={`Onboarding step ${step} of 6`}>
    <div className="onboarding-progress"><span style={{ width: `${step / 6 * 100}%` }}/></div><div className="onboarding-top"><span className="eyebrow">System orientation · v{state.version}</span><span className="mono">{step}/6</span></div><span className="onboarding-icon"><Icon size={26}/></span><h1>{content.title}</h1><p>{content.text}</p>{content.body}{error && <div className="inline-error">{error}</div>}
    <div className="onboarding-actions"><button className="button" onClick={() => { void save('skip', step); onPause(); }}>Skip for now</button><div>{step > 1 && <button className="button" onClick={() => move(step - 1)}><ChevronLeft size={15}/>Back</button>}<button className="button primary" onClick={() => { if (step === 6) { onPage('/dashboard'); void save('complete', 6); } else move(step + 1); }}>{step === 6 ? 'Open Dashboard' : 'Continue'}{step < 6 && <ChevronRight size={15}/>}</button></div></div>
  </section></div>;
}
