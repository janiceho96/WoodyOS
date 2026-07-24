import { Activity, ArrowRight, Bot, BrainCircuit, ChevronRight, CircleAlert, Database, FileOutput, GitBranch, Play, Send, ShieldCheck, Sparkles, Workflow } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState, Status } from '../../components/ui';
import { compact, duration, relative, taskCost } from '../../lib/format';
import { useWorkspace } from '../../app/workspace';
import { AgentAvatar } from '../../components/agents/AgentAvatar';
import type { Task } from '../../api';

const taskAgent = (task: Task) => ({ id: task.agent_id, name: task.agent_name ?? 'AI agent', role: task.agent_role ?? 'AI agent', avatar_config: task.agent_avatar ?? {}, updated_at: task.updated_at });

const goalExamples = [
  'Build a research team',
  'Create a presentation',
  'Analyze my documents',
  'Automate a weekly report',
];

export function DashboardPage({ openTask, openAgent }: { openTask: () => void; openAgent: () => void }) {
  const { data } = useWorkspace();
  const navigate = useNavigate();
  const [goal, setGoal] = useState('');
  const analytics = data.analytics;
  const quota = data.quota;
  const tokenTotal = Number(analytics?.usage.token_input ?? 0) + Number(analytics?.usage.token_output ?? 0);
  const cost = taskCost(data.tasks);
  const active = data.tasks.filter((task) => ['queued', 'running'].includes(task.status));
  const failed = data.tasks.filter((task) => task.status === 'failed');
  const completed = data.tasks.filter((task) => task.status === 'completed');
  const submitGoal = (event: FormEvent) => {
    event.preventDefault();
    const clean = goal.trim();
    if (!clean) return;
    navigate(`/agents/library?tab=generate&prompt=${encodeURIComponent(clean)}`);
  };
  const metrics = [
    { label: 'Active agents', value: analytics?.agents.active_agents ?? '0', Icon: Bot, tone: 'indigo' },
    { label: 'Running now', value: analytics?.tasks.running_tasks ?? '0', Icon: Workflow, tone: 'cyan' },
    { label: 'Success rate', value: `${analytics?.tasks.success_rate ?? '0'}%`, Icon: ShieldCheck, tone: 'emerald' },
    { label: 'Tokens used', value: compact(tokenTotal), Icon: BrainCircuit, tone: 'amber' },
  ];

  return <div className="dashboard-page dashboard-home">
    <section className="goal-command panel">
      <div className="goal-command-copy"><span className="status-badge active"><i/>Woody is ready</span><h1>What would you like to accomplish?</h1><p>Describe an outcome. Woody will turn it into an editable agent and workflow proposal before anything runs.</p></div>
      <form className="goal-composer" onSubmit={submitGoal}>
        <Sparkles size={20}/><textarea aria-label="Describe your goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Describe a goal, paste a prompt, or explain a repeatable job…" rows={2}/><button className="button primary" type="submit" disabled={goal.trim().length < 10}><Send size={16}/>Plan it</button>
      </form>
      <div className="goal-examples">{goalExamples.map((example) => <button key={example} onClick={() => setGoal(example)}>{example}</button>)}</div>
      <div className="goal-boundary"><ShieldCheck size={15}/><span>Woody drafts first. You review agents, permissions, workflow and estimated usage before installation.</span></div>
    </section>

    <section className="home-focus-grid">
      <article className="panel attention-card">
        <div className="panel-header"><div><span className="eyebrow">Your workspace</span><h2>{failed.length ? 'Work needs attention' : active.length ? 'Work in progress' : 'Ready for your next goal'}</h2></div>{failed.length ? <CircleAlert className="danger-text" size={20}/> : <Activity className="primary-text" size={20}/>}</div>
        {failed.length ? <div className="focus-list">{failed.slice(0, 3).map((task) => <button key={task.id} onClick={() => navigate(`/agents/${task.agent_id}?section=workspace&task=${task.id}`)}><AgentAvatar agent={taskAgent(task)} size="sm" status="error" decorative/><span><strong>{task.title}</strong><small>{task.agent_name ?? 'AI agent'} · {relative(task.updated_at)}</small></span><ChevronRight size={16}/></button>)}</div> : active.length ? <div className="focus-list">{active.slice(0, 3).map((task) => <button key={task.id} onClick={() => navigate(`/agents/${task.agent_id}?section=workspace&task=${task.id}`)}><AgentAvatar agent={taskAgent(task)} size="sm" status="busy" decorative/><span><strong>{task.title}</strong><small>{task.agent_name ?? 'AI agent'} · started {relative(task.created_at)}</small></span><ChevronRight size={16}/></button>)}</div> : <div className="focus-empty"><p>Create from a goal, run an existing agent, or start with a proven template.</p><div><button className="button primary" onClick={openTask}><Play size={15}/>Run a task</button><button className="button" onClick={() => navigate('/agents/library')}><Sparkles size={15}/>Browse Agent Library</button></div></div>}
      </article>
      <article className="panel workspace-summary">
        <div className="panel-header"><div><span className="eyebrow">System summary</span><h2>Healthy and ready</h2></div><Status value={failed.length ? 'monitoring' : 'active'}/></div>
        <div className="summary-grid">{metrics.map(({ label, value, Icon, tone }) => <span className={tone} key={label}><Icon size={16}/><small>{label}</small><strong>{value}</strong></span>)}</div>
        <div className="summary-foot"><span>Estimated spend <strong>{cost.label}</strong></span><span>Budget <strong>{quota?.state === 'unconfigured' ? 'Not set' : `${Math.min(999, quota?.maximumPercent ?? 0).toFixed(0)}% used`}</strong></span></div>
      </article>
    </section>

    <section className="dashboard-lower home-lower">
      <article className="panel activity-panel">
        <div className="panel-header"><div><span className="eyebrow">Recent work</span><h2>Outputs</h2></div><button className="text-button" onClick={() => navigate('/executions')}>View all <ArrowRight size={14}/></button></div>
        {data.tasks.length ? <div className="activity-list">{data.tasks.slice(0, 6).map((task) => <button key={task.id} onClick={() => navigate(`/executions?task=${task.id}`)}>
          <AgentAvatar agent={taskAgent(task)} size="sm" status={task.status === 'failed' ? 'error' : task.status === 'running' ? 'busy' : undefined} decorative/>
          <span><strong>{task.title}</strong><small>{task.agent_name ?? 'AI agent'} · {relative(task.created_at)}</small></span>
          <span className="mono">{task.duration_ms ? duration(task.duration_ms) : task.status}</span><ChevronRight size={16}/>
        </button>)}</div> : <EmptyState Icon={Activity} title="No outputs yet" text="Give an agent its first focused task." action={<button className="button primary" onClick={openTask}>Run first task</button>}/>}
      </article>
      <article className="panel next-actions">
        <div className="panel-header"><div><span className="eyebrow">Next steps</span><h2>Build with context</h2></div></div>
        {[{ title: 'Create an agent', text: 'Define one specialist', Icon: Bot, action: openAgent }, { title: 'Add knowledge', text: 'Ground work in trusted context', Icon: Database, action: () => navigate('/knowledge') }, { title: 'Design a workflow', text: 'Connect repeatable steps', Icon: GitBranch, action: () => navigate('/workflows') }, { title: 'Review outputs', text: `${completed.length} completed outputs`, Icon: FileOutput, action: () => navigate('/executions') }].map(({ title, text, Icon, action }) => <button key={title} onClick={action}><span><Icon size={17}/></span><div><strong>{title}</strong><small>{text}</small></div><ChevronRight size={15}/></button>)}
      </article>
    </section>
  </div>;
}
