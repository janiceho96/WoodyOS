import { Activity, ArrowRight, Bot, BrainCircuit, ChevronRight, Database, GitBranch, Network, Play, Plus, ShieldCheck, Workflow } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { EmptyState, Status } from '../../components/ui';
import { compact, duration, relative, taskCost } from '../../lib/format';
import { useWorkspace } from '../../app/workspace';

export function DashboardPage({ openTask, openAgent }: { openTask: () => void; openAgent: () => void }) {
  const { data } = useWorkspace();
  const navigate = useNavigate();
  const analytics = data.analytics;
  const quota = data.quota;
  const tokenTotal = Number(analytics?.usage.token_input ?? 0) + Number(analytics?.usage.token_output ?? 0);
  const cost = taskCost(data.tasks);
  const metrics = [
    { label: 'Active agents', value: analytics?.agents.active_agents ?? '0', hint: 'Deployed now', Icon: Bot, tone: 'indigo' },
    { label: 'Running tasks', value: analytics?.tasks.running_tasks ?? '0', hint: 'Live queue', Icon: Workflow, tone: 'cyan' },
    { label: 'Success rate', value: `${analytics?.tasks.success_rate ?? '0'}%`, hint: 'Completed vs failed', Icon: ShieldCheck, tone: 'emerald' },
    { label: 'Token usage', value: compact(tokenTotal), hint: cost.available ? `${cost.label} estimated` : 'Pricing unavailable', Icon: BrainCircuit, tone: 'amber' },
  ];
  const systemState = Number(analytics?.tasks.failed_tasks ?? 0) > 0 ? 'Monitoring exceptions' : 'Optimal performance';
  return <div className="dashboard-page">
    <section className="neural-hero panel">
      <div className="hero-grid"/>
      <div className="neural-core" aria-hidden="true"><i/><i/><i/><span><Network size={34}/></span></div>
      <div className="hero-copy"><span className="status-badge active"><i/>System core online</span><h1>Command intelligence<br/>at operational speed.</h1><p>{systemState}. Live data from your agents, tasks, and connected services.</p></div>
      <div className="hero-actions"><button className="button primary" onClick={openTask}><Play size={16}/>Run a task</button><button className="button" onClick={openAgent}><Plus size={16}/>Create agent</button></div>
    </section>
    <section className="metric-grid">
      {metrics.map(({ label, value, hint, Icon, tone }) => <article className={`metric-card panel ${tone}`} key={label}>
        <div><span className="metric-icon"><Icon size={19}/></span><span className="eyebrow">{label}</span></div><strong>{value}</strong><small>{hint}</small>
      </article>)}
    </section>
    <section className="dashboard-lower">
      <article className="panel activity-panel">
        <div className="panel-header"><div><span className="eyebrow">Live activity</span><h2>Execution stream</h2></div><button className="text-button" onClick={() => navigate('/executions')}>View all <ArrowRight size={14}/></button></div>
        {data.tasks.length ? <div className="activity-list">{data.tasks.slice(0, 6).map((task) => <button key={task.id} onClick={() => navigate(`/executions?task=${task.id}`)}>
          <Status value={task.status}/><span><strong>{task.title}</strong><small>{task.agent_name ?? 'AI agent'} · {relative(task.created_at)}</small></span><span className="mono">{task.duration_ms ? duration(task.duration_ms) : task.status}</span><ChevronRight size={16}/>
        </button>)}</div> : <EmptyState Icon={Activity} title="No task activity yet" text="Deploy an agent and give it a focused first task." action={<button className="button primary" onClick={openTask}>Run first task</button>}/>}
      </article>
      <article className="panel core-health">
        <div className="panel-header"><div><span className="eyebrow">System health</span><h2>Neural core</h2></div><Status value="active"/></div>
        <div className="health-orbit"><span><strong>{analytics?.agents.active_agents ?? '0'}</strong><small>active nodes</small></span></div>
        <div className="health-row"><span>Task throughput</span><strong>{Number(analytics?.tasks.completed_tasks ?? 0) + Number(analytics?.tasks.failed_tasks ?? 0)}</strong></div>
        <div className="health-row"><span>Average runtime</span><strong>{analytics?.tasks.average_duration_ms ? duration(Number(analytics.tasks.average_duration_ms)) : '—'}</strong></div>
        <div className="health-row"><span>API spend</span><strong>{cost.label}</strong></div>
        <div className="health-row"><span>Monthly AI budget</span><strong>{quota?.state === 'unconfigured' ? 'Not set' : `${Math.min(999, quota?.maximumPercent ?? 0).toFixed(0)}% · ${quota?.state ?? 'loading'}`}</strong></div>
        <div className="health-row"><span>Provider rate limit</span><strong>{quota?.provider?.requestsRemaining !== null && quota?.provider?.requestsRemaining !== undefined ? `${compact(quota.provider.requestsRemaining)} requests left` : 'Not reported'}</strong></div>
      </article>
    </section>
    <section className="panel quick-actions">
      <div className="panel-header"><div><span className="eyebrow">Quick commands</span><h2>Build your operating system</h2></div></div>
      <div>{[
        { title: 'Create an agent', text: 'Define a focused AI specialist', Icon: Bot, action: openAgent },
        { title: 'Add knowledge', text: 'Ground agents in trusted context', Icon: Database, action: () => navigate('/knowledge') },
        { title: 'Design a workflow', text: 'Automate a repeatable process', Icon: GitBranch, action: () => navigate('/workflows') },
      ].map(({ title, text, Icon, action }) => <button key={title} onClick={action}><span><Icon size={19}/></span><div><strong>{title}</strong><small>{text}</small></div><ChevronRight size={17}/></button>)}</div>
    </section>
  </div>;
}
