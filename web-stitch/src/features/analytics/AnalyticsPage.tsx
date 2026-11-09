import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, BarChart3, Bot, CheckCircle2, Clock3, Coins, Gauge, Settings2, ShieldCheck, TimerReset, WalletCards } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type AiQuotaStatus, type Analytics } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader, Status } from '../../components/ui';
import { compact, duration, money, relative } from '../../lib/format';
import { AgentAvatar } from '../../components/agents/AgentAvatar';

type Range = 1 | 7 | 30;

function analyticsSummary(analytics: Analytics | undefined, range: Range) {
  const completed = Number(analytics?.tasks.completed_tasks ?? 0);
  const failed = Number(analytics?.tasks.failed_tasks ?? 0);
  const running = Number(analytics?.tasks.running_tasks ?? 0);
  const outcomes = completed + failed;
  const successRate = outcomes ? Number(analytics?.tasks.success_rate ?? 0) : null;
  const averageDuration = Number(analytics?.tasks.average_duration_ms ?? 0);
  const inputTokens = Number(analytics?.usage.token_input ?? 0);
  const outputTokens = Number(analytics?.usage.token_output ?? 0);
  const tokens = inputTokens + outputTokens;
  const cost = Number(analytics?.usage.api_cost_usd ?? 0);
  const pricingAvailable = cost > 0 || tokens === 0;
  const days = fillDaily(range, analytics?.daily ?? []);
  const chartMode: 'cost' | 'tokens' = pricingAvailable ? 'cost' : 'tokens';
  const maximumTrend = Math.max(...days.map((day) => chartMode === 'cost' ? day.cost : day.tokens), 0);
  return { completed, failed, running, outcomes, successRate, averageDuration, inputTokens, outputTokens, tokens, cost, pricingAvailable, days, chartMode, maximumTrend };
}

export function AnalyticsPage() {
  const { data } = useWorkspace();
  const [range, setRange] = useState<Range>(7);
  const analyticsQuery = useQuery({
    queryKey: ['operations-analytics', range],
    queryFn: () => api.analytics(range),
    placeholderData: (previous) => previous,
  });
  const analytics = analyticsQuery.data ?? data.analytics;
  const { completed, failed, running, outcomes, successRate, averageDuration, inputTokens, outputTokens, tokens, cost, pricingAvailable, days, chartMode, maximumTrend } = analyticsSummary(analytics, range);

  return <div className="analytics-page analytics-redesign">
    <PageHeader eyebrow="Operations" title="Analytics" description="Understand what Woody costs, how reliably work finishes, which agents are effective, and how much provider capacity remains." actions={<div className="range-switch" role="group" aria-label="Analytics date range">{([1, 7, 30] as const).map((value) => <button type="button" key={value} className={range === value ? 'active' : ''} aria-pressed={range === value} onClick={() => setRange(value)}>{value === 1 ? '24h' : `${value}d`}</button>)}</div>}/>

    {analyticsQuery.isError && <section className="analytics-warning" role="alert"><AlertTriangle size={18}/><span><strong>Analytics could not refresh</strong><small>{analyticsQuery.error instanceof Error ? analyticsQuery.error.message : 'The latest metrics are unavailable.'}</small></span><button className="button" onClick={() => void analyticsQuery.refetch()}>Try again</button></section>}

    <nav className="analytics-section-nav" aria-label="Analytics sections"><a href="#spend"><Coins size={14}/>Spend</a><a href="#reliability"><ShieldCheck size={14}/>Reliability</a><a href="#effectiveness"><Bot size={14}/>Agent effectiveness</a><a href="#capacity"><Gauge size={14}/>Provider capacity</a>{analyticsQuery.isFetching && <span><i/>Refreshing real data</span>}</nav>

    <section className="analytics-metrics" aria-label="Analytics summary">
      <Metric eyebrow="Spend" value={pricingAvailable ? `$${money(cost)}` : 'Not priced'} detail={pricingAvailable ? `${compact(tokens)} tokens in range` : `${compact(tokens)} tokens · add model pricing`} Icon={WalletCards}/>
      <Metric eyebrow="Reliability" value={successRate === null ? '—' : `${successRate.toFixed(1)}%`} detail={outcomes ? `${completed} completed · ${failed} failed` : 'No finished outcomes yet'} Icon={ShieldCheck}/>
      <Metric eyebrow="Finished work" value={compact(completed)} detail={`${running} currently active`} Icon={CheckCircle2}/>
      <Metric eyebrow="Average runtime" value={averageDuration ? duration(averageDuration) : '—'} detail="Completed agent tasks" Icon={Clock3}/>
    </section>

    <section className="analytics-outcome-grid" id="spend">
      <article className="panel analytics-section-card spend-card">
        <SectionTitle eyebrow="Spend" title={chartMode === 'cost' ? 'Cost trend' : 'Token volume'} description={chartMode === 'cost' ? 'Recorded model cost by UTC day.' : 'The provider has not supplied usable pricing, so Woody shows real token volume instead.'} trailing={<span className="real-data-label"><i/>Database totals</span>}/>
        {completed + failed + running > 0 ? <div className="analytics-trend" aria-label={`${chartMode === 'cost' ? 'Cost' : 'Token'} trend`}>
          {days.map((day) => { const value = chartMode === 'cost' ? day.cost : day.tokens; return <div key={day.day}><span className="trend-value">{chartMode === 'cost' ? `$${money(day.cost)}` : compact(day.tokens)}</span><i><b style={{ height: `${maximumTrend ? Math.max(value > 0 ? 5 : 0, value / maximumTrend * 100) : 0}%` }}/></i><small>{day.label}</small></div>; })}
        </div> : <EmptyState Icon={BarChart3} title="No activity in this range" text="Run an agent task and its real usage will appear here."/>}
        <div className="spend-breakdown"><span><small>Input tokens</small><strong>{compact(inputTokens)}</strong></span><span><small>Output tokens</small><strong>{compact(outputTokens)}</strong></span><span><small>Requests</small><strong>{compact(completed + failed + running)}</strong></span><span><small>Recorded cost</small><strong>{pricingAvailable ? `$${money(cost)}` : 'Pricing unavailable'}</strong></span></div>
      </article>

      <ProviderCapacity quota={data.quota} runtime={data.runtime} id="capacity"/>
    </section>

    <section className="analytics-outcome-grid" id="reliability">
      <article className="panel analytics-section-card reliability-card">
        <SectionTitle eyebrow="Reliability" title="Completion health" description="Only completed and failed outcomes count toward success rate." trailing={failed > 0 ? <Link className="button" to="/executions?status=failed">Review failed tasks</Link> : undefined}/>
        {outcomes > 0 ? <>
          <div className="reliability-score"><span><strong>{successRate?.toFixed(1)}%</strong><small>success rate</small></span><i aria-label={`${completed} completed and ${failed} failed`}><b style={{ width: `${successRate ?? 0}%` }}/></i></div>
          <div className="reliability-counts"><span className="complete"><CheckCircle2 size={17}/><strong>{completed}</strong><small>Completed</small></span><span className="failed"><AlertTriangle size={17}/><strong>{failed}</strong><small>Failed</small></span><span><Activity size={17}/><strong>{running}</strong><small>Active</small></span><span><TimerReset size={17}/><strong>{averageDuration ? duration(averageDuration) : '—'}</strong><small>Average runtime</small></span></div>
        </> : <EmptyState Icon={ShieldCheck} title="No finished outcomes yet" text="Reliability becomes meaningful after tasks complete or fail."/>}
      </article>

      <article className="panel analytics-section-card activity-card">
        <SectionTitle eyebrow="Recent signals" title="What changed" description="Latest task events inside the selected range."/>
        {analytics?.activity?.length ? <div className="analytics-activity-list">{analytics.activity.slice(0, 7).map((event, index) => <article key={`${event.created_at}-${event.event_type}-${index}`}><AgentAvatar agent={{ id: event.agent_id, name: event.agent_name, role: event.agent_role, avatar_config: event.agent_avatar ?? {} }} size="xs" decorative/><span><strong>{event.message}</strong><small>{event.agent_name} · {event.title}</small></span><time>{relative(event.created_at)}</time></article>)}</div> : <EmptyState Icon={Activity} title="No recent task events" text="Woody will surface starts, completions, approvals, and failures here."/>}
      </article>
    </section>

    <section className="panel analytics-section-card effectiveness-card" id="effectiveness">
      <SectionTitle eyebrow="Agent effectiveness" title="Compare real outcomes" description={`All agents measured across the selected ${range === 1 ? '24 hours' : `${range} days`}. Agents with no work remain visible.`}/>
      {analytics?.agent_effectiveness?.length ? <div className="effectiveness-table" role="region" aria-label="Agent effectiveness table" tabIndex={0}><table><thead><tr><th>Agent</th><th>Tasks</th><th>Success</th><th>Average runtime</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>{analytics.agent_effectiveness.map((item) => {
        const terminal = Number(item.completed_tasks) + Number(item.failed_tasks);
        const itemTokens = Number(item.token_input) + Number(item.token_output);
        const itemCost = Number(item.api_cost_usd);
        return <tr key={item.agent_id}><td><span className="agent-effectiveness-name"><AgentAvatar agent={{ id: item.agent_id, name: item.agent_name, role: item.agent_role, avatar_config: item.agent_avatar ?? {} }} size="sm" status={item.agent_status}/><span><strong>{item.agent_name}</strong><small><Status value={item.agent_status}/></small></span></span></td><td>{item.total_tasks}</td><td>{terminal ? `${Number(item.success_rate).toFixed(1)}%` : '—'}</td><td>{item.average_duration_ms ? duration(Number(item.average_duration_ms)) : '—'}</td><td>{compact(itemTokens)}</td><td>{itemCost > 0 || itemTokens === 0 ? `$${money(itemCost)}` : 'Not priced'}</td></tr>;
      })}</tbody></table></div> : <EmptyState Icon={Bot} title="No agents to compare" text="Create an agent and run a task to begin measuring effectiveness."/>}
      <p className="analytics-method-note"><ShieldCheck size={14}/>Success uses finished task outcomes only. The Outputs index opens each record inside its agent workflow context.</p>
    </section>
  </div>;
}

function Metric({ eyebrow, value, detail, Icon }: { eyebrow: string; value: string; detail: string; Icon: typeof Coins }) {
  return <article className="panel"><span className="analytics-metric-icon"><Icon size={17}/></span><span className="eyebrow">{eyebrow}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function SectionTitle({ eyebrow, title, description, trailing }: { eyebrow: string; title: string; description: string; trailing?: ReactNode }) {
  return <div className="panel-header analytics-section-title"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{trailing}</div>;
}

function ProviderCapacity({ quota, runtime, id }: { quota?: AiQuotaStatus; runtime?: Awaited<ReturnType<typeof api.runtimeConfig>>; id: string }) {
  const budgetConfigured = Boolean(quota && [quota.budget.monthlyRequestLimit, quota.budget.monthlyTokenLimit, quota.budget.monthlyCostLimitUsd].some((value) => value !== null));
  const pricingAvailable = Boolean(quota && (
    quota.usage.tokensUsed === 0
    || quota.usage.costUsedUsd > 0
    || (quota.budget.inputCostPerMillionUsd !== null && quota.budget.outputCostPerMillionUsd !== null)
  ));
  const upstream = quota?.provider;
  return <article className="panel analytics-section-card provider-capacity-card" id={id}>
    <SectionTitle eyebrow="Provider capacity" title="Limits and health" description="Local safety budgets and upstream limits are shown separately." trailing={<Link className="button" to="/settings"><Settings2 size={14}/>Manage</Link>}/>
    <div className="provider-health-row"><span><small>Provider</small><strong>{runtime?.provider === 'openai-compatible' ? 'OpenAI-compatible' : runtime?.provider === 'anthropic' ? 'Anthropic' : 'Not configured'}</strong><em>{runtime?.defaultModel || 'No model selected'}</em></span><Status value={runtime?.status ?? 'unconfigured'}/></div>
    <div className="capacity-group"><div><strong>Local monthly budget</strong><small>{budgetConfigured ? quota?.budget.hardLimit ? 'Hard limit enforced' : `Warning at ${quota?.budget.warningPercent}%` : 'No local cap configured'}</small></div>
      <QuotaMeter label="Requests" used={quota?.usage.requestsUsed ?? 0} limit={quota?.budget.monthlyRequestLimit ?? null} percent={quota?.percentages.requests ?? null}/>
      <QuotaMeter label="Tokens" used={quota?.usage.tokensUsed ?? 0} limit={quota?.budget.monthlyTokenLimit ?? null} percent={quota?.percentages.tokens ?? null}/>
      <QuotaMeter label="Cost" used={quota?.usage.costUsedUsd ?? 0} limit={quota?.budget.monthlyCostLimitUsd ?? null} percent={quota?.percentages.cost ?? null} moneyValue valueAvailable={pricingAvailable}/>
    </div>
    <div className="capacity-group upstream"><div><strong>Provider-reported allowance</strong><small>{upstream ? `Captured ${relative(upstream.capturedAt)}` : 'This provider has not reported remaining allowance'}</small></div>
      {upstream ? <div className="upstream-capacity-grid"><CapacityFact label="Requests remaining" value={upstream.requestsRemaining === null ? 'Not reported' : compact(upstream.requestsRemaining)} detail={upstream.requestLimit === null ? undefined : `of ${compact(upstream.requestLimit)}`}/><CapacityFact label="Tokens remaining" value={upstream.tokensRemaining === null ? 'Not reported' : compact(upstream.tokensRemaining)} detail={upstream.tokenLimit === null ? undefined : `of ${compact(upstream.tokenLimit)}`}/><CapacityFact label="Credit remaining" value={upstream.creditRemainingUsd === null ? 'Not reported' : `$${money(upstream.creditRemainingUsd)}`} detail={upstream.requestsResetAt ? `Requests reset ${relative(upstream.requestsResetAt)}` : upstream.tokensResetAt ? `Tokens reset ${relative(upstream.tokensResetAt)}` : undefined}/></div> : <div className="provider-limit-empty"><Gauge size={20}/><span><strong>No upstream limit signal</strong><small>Woody cannot infer the provider’s private account balance. Local budgets still prevent unexpected usage.</small></span></div>}
    </div>
  </article>;
}

function QuotaMeter({ label, used, limit, percent, moneyValue = false, valueAvailable = true }: { label: string; used: number; limit: number | null; percent: number | null; moneyValue?: boolean; valueAvailable?: boolean }) {
  const format = (value: number) => moneyValue ? `$${money(value)}` : compact(value);
  const value = valueAvailable ? `${format(used)}${limit === null ? '' : ` / ${format(limit)}`}` : 'Pricing unavailable';
  return <div className={`analytics-quota-meter${limit === null ? ' no-limit' : ''}`}><span><small>{label}</small><strong>{value}</strong></span>{limit !== null && <i><b style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}/></i>}<em>{limit === null ? 'No limit configured' : `${Math.round(percent ?? 0)}% used`}</em></div>;
}

function CapacityFact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <span><small>{label}</small><strong>{value}</strong>{detail && <em>{detail}</em>}</span>;
}

function fillDaily(range: Range, records: NonNullable<Analytics['daily']>) {
  const byDay = new Map(records.map((record) => [record.day, record]));
  return Array.from({ length: range }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (range - 1 - index));
    const day = date.toISOString().slice(0, 10);
    const record = byDay.get(day);
    return { day, label: date.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }), cost: Number(record?.api_cost_usd ?? 0), tokens: Number(record?.token_input ?? 0) + Number(record?.token_output ?? 0) };
  });
}
