import { BarChart3, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader } from '../../components/ui';
import { duration, taskCost } from '../../lib/format';

export function AnalyticsPage() {
  const { data } = useWorkspace();
  const [range, setRange] = useState<1 | 7 | 30>(7);
  const cutoff = Date.now() - range * 24 * 60 * 60 * 1000;
  const tasks = data.tasks.filter((task) => new Date(task.created_at).getTime() >= cutoff);
  const days = Array.from({ length: range }, (_, index) => {
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (range - 1 - index));
    const next = new Date(date); next.setDate(next.getDate() + 1);
    const dayTasks = tasks.filter((task) => { const time = new Date(task.created_at).getTime(); return time >= date.getTime() && time < next.getTime(); });
    return { label: date.toLocaleDateString([], { month: 'short', day: 'numeric' }), cost: dayTasks.reduce((sum, task) => sum + Number(task.estimated_cost_usd ?? 0), 0), count: dayTasks.length };
  });
  const agentStats = data.agents.map((agent) => {
    const agentTasks = tasks.filter((task) => task.agent_id === agent.id);
    const completed = agentTasks.filter((task) => task.status === 'completed').length;
    const failed = agentTasks.filter((task) => task.status === 'failed').length;
    return { agent, total: agentTasks.length, success: completed + failed ? Math.round(completed / (completed + failed) * 100) : 0, failed };
  }).sort((a, b) => b.total - a.total).slice(0, 5);
  const maxCost = Math.max(...days.map((day) => day.cost), 0);
  const maxCount = Math.max(...days.map((day) => day.count), 0);
  const average = Number(data.analytics?.tasks.average_duration_ms ?? 0);
  const cost = taskCost(tasks);
  return <div className="analytics-page">
    <PageHeader eyebrow="Intelligence" title="Operations Analytics" description="Real performance and cost analysis derived from workspace task data." actions={<div className="range-switch">{([1, 7, 30] as const).map((value) => <button key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{value === 1 ? '24h' : `${value}d`}</button>)}</div>}/>
    <section className="analytics-metrics"><article className="panel"><span className="eyebrow">Total executions</span><strong>{tasks.length}</strong><small>Selected range</small></article><article className="panel"><span className="eyebrow">Compute cost</span><strong>{cost.label}</strong><small>{cost.available ? 'Real recorded estimate' : 'Provider pricing is not configured'}</small></article><article className="panel"><span className="eyebrow">Active agents</span><strong>{data.analytics?.agents.active_agents ?? '0'}</strong><small>{data.agents.length} total agents</small></article><article className="panel"><span className="eyebrow">Average runtime</span><strong>{average ? duration(average) : '—'}</strong><small>Completed tasks</small></article></section>
    <section className="analytics-charts">
      <article className="panel cost-chart"><div className="panel-header"><div><span className="eyebrow">Cost trend</span><h2>Compute cost</h2></div><span className="real-data-label"><i/>Real task data</span></div>{tasks.length && cost.available ? <div className="bar-chart">{days.map((day) => <div key={day.label}><span title={`$${day.cost.toFixed(5)}`} style={{ height: `${maxCost ? Math.max(4, day.cost / maxCost * 100) : 4}%` }}/><small>{day.label}</small></div>)}</div> : <EmptyState Icon={BarChart3} title={tasks.length ? 'Provider pricing unavailable' : 'No cost data in this range'} text={tasks.length ? 'Token usage is recorded, but this compatible model has no configured billing rate.' : 'Completed agent work will populate this chart automatically.'}/>}</article>
      <article className="panel success-chart"><div className="panel-header"><div><span className="eyebrow">Reliability</span><h2>Task success rate</h2></div></div>{agentStats.some((item) => item.total) ? <div className="success-bars">{agentStats.map(({ agent, success, failed }) => <div key={agent.id}><span><strong>{agent.name}</strong><small>{success}% success · {failed} failed</small></span><i><b style={{ width: `${success}%` }}/></i></div>)}</div> : <EmptyState Icon={ShieldCheck} title="No completed outcomes yet" text="Success rates appear after tasks complete or fail."/>}</article>
    </section>
    <section className="panel heatmap-panel"><div className="panel-header"><div><span className="eyebrow">Activity distribution</span><h2>Agent activity heatmap</h2><p>Executions by agent and UTC hour from the selected range.</p></div><span className="heat-legend">Low <i/> High</span></div>{agentStats.length ? <div className="heatmap"><div className="heat-hours"><span/><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>{agentStats.map(({ agent }) => { const buckets = Array.from({ length: 24 }, (_, hour) => tasks.filter((task) => task.agent_id === agent.id && new Date(task.created_at).getUTCHours() === hour).length); const max = Math.max(...buckets, 1); return <div key={agent.id}><strong>{agent.name}</strong><span>{buckets.map((count, hour) => <i key={hour} title={`${hour}:00 UTC · ${count} executions`} style={{ opacity: count ? .18 + .82 * count / max : .04 }}/>)}</span></div>; })}</div> : <EmptyState Icon={BarChart3} title="No agent activity" text="Activity buckets will appear when agents run tasks."/>}{tasks.length > 0 && <div className="volume-note">Peak daily volume: {maxCount} task{maxCount === 1 ? '' : 's'}</div>}</section>
  </div>;
}
