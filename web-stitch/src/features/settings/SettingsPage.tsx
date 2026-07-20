import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, CircleHelp, Gauge, LoaderCircle, Moon, Palette, RefreshCw, Save, Sun, WalletCards } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type AiQuotaStatus, type Onboarding } from '../../api';
import type { Theme } from '../../app/theme';
import { useWorkspace } from '../../app/workspace';
import { PageHeader, Status } from '../../components/ui';
import { compact } from '../../lib/format';

type BudgetForm = {
  monthlyRequestLimit: string;
  monthlyTokenLimit: string;
  monthlyCostLimitUsd: string;
  inputCostPerMillionUsd: string;
  outputCostPerMillionUsd: string;
  warningPercent: string;
  hardLimit: boolean;
};

const emptyBudget: BudgetForm = {
  monthlyRequestLimit: '', monthlyTokenLimit: '', monthlyCostLimitUsd: '',
  inputCostPerMillionUsd: '', outputCostPerMillionUsd: '', warningPercent: '80', hardLimit: false,
};

const defaultDesignMarkdown = `# Woody Presentation Design System

## Brand personality
Premium, intelligent, calm, modern, and slightly futuristic.

## Deck style
- Style: premium-dark

## Colors
- Background: #0B1020
- Surface: #121A30
- Primary: #7C5CFF
- Accent: #4DE1FF
- Success: #4EE3A3
- Primary text: #F5F7FF
- Secondary text: #AAB3CC

## Typography
- Headings: Aptos Display
- Body font: Aptos
- Maximum 35 words on a normal content slide.

## Visual direction
Use generous whitespace, subtle cards, thin borders, clear hierarchy, and diagrams over long bullet lists.`;

function formFromStatus(status?: AiQuotaStatus): BudgetForm {
  if (!status) return emptyBudget;
  const value = (number: number | null) => number === null ? '' : String(number);
  return {
    monthlyRequestLimit: value(status.budget.monthlyRequestLimit),
    monthlyTokenLimit: value(status.budget.monthlyTokenLimit),
    monthlyCostLimitUsd: value(status.budget.monthlyCostLimitUsd),
    inputCostPerMillionUsd: value(status.budget.inputCostPerMillionUsd),
    outputCostPerMillionUsd: value(status.budget.outputCostPerMillionUsd),
    warningPercent: String(status.budget.warningPercent),
    hardLimit: status.budget.hardLimit,
  };
}

function optionalNumber(value: string) {
  return value.trim() ? Number(value) : null;
}

export function SettingsPage({ theme, setTheme, onboarding, resume, restart }: { theme: Theme; setTheme: (theme: Theme) => void; onboarding: Onboarding | null; resume: () => void; restart: () => void }) {
  const { session, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const quota = useQuery({ queryKey: ['ai-quota'], queryFn: api.aiQuota, refetchInterval: 15_000 });
  const themes = useQuery({ queryKey: ['presentation-themes'], queryFn: api.presentationThemes });
  const [budget, setBudget] = useState<BudgetForm>(emptyBudget);
  const [themeName, setThemeName] = useState('Woody Dark Premium');
  const [designMarkdown, setDesignMarkdown] = useState(defaultDesignMarkdown);
  useEffect(() => { if (quota.data) setBudget(formFromStatus(quota.data)); }, [quota.data]);
  const canEdit = !session.workspace.role || session.workspace.role === 'owner' || session.workspace.role === 'admin';
  const save = useMutation({
    mutationFn: () => api.updateAiBudget({
      monthlyRequestLimit: optionalNumber(budget.monthlyRequestLimit),
      monthlyTokenLimit: optionalNumber(budget.monthlyTokenLimit),
      monthlyCostLimitUsd: optionalNumber(budget.monthlyCostLimitUsd),
      inputCostPerMillionUsd: optionalNumber(budget.inputCostPerMillionUsd),
      outputCostPerMillionUsd: optionalNumber(budget.outputCostPerMillionUsd),
      warningPercent: Number(budget.warningPercent),
      hardLimit: budget.hardLimit,
    }),
    onSuccess: async (result) => {
      report('AI usage budget saved');
      queryClient.setQueryData(['ai-quota'], result);
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not save AI budget'),
  });
  const update = (field: keyof BudgetForm, value: string | boolean) => setBudget((current) => ({ ...current, [field]: value }));
  const saveTheme = useMutation({
    mutationFn: () => api.createPresentationTheme({ name: themeName, designMarkdown, isDefault: true }),
    onSuccess: async () => { report('Presentation theme saved as the default for new PowerPoint files'); await queryClient.invalidateQueries({ queryKey: ['presentation-themes'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not save presentation theme'),
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) => api.updatePresentationTheme(id, { isDefault: true }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['presentation-themes'] }),
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not set default presentation theme'),
  });
  const status = quota.data;
  const provider = status?.provider;

  return <div className="settings-page">
    <PageHeader eyebrow="Workspace" title="Settings" description="Display preferences, onboarding, and enforceable AI usage limits."/>
    <section className="panel settings-card"><div><span className="setting-icon"><Sun size={18}/></span><span><strong>Appearance</strong><small>Applied across every Woody screen.</small></span></div><div className="theme-switch"><button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}><Moon size={15}/>Dark</button><button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}><Sun size={15}/>Light</button></div></section>

    <section className="panel quota-settings">
      <div className="panel-header"><div><span className="eyebrow">Usage guardrail</span><h2>AI budget and provider limits</h2><p>Local limits are enforced by Woody. Provider values appear only when the API reports safe rate-limit headers.</p></div><div className="quota-header-actions"><Status value={status?.state ?? 'loading'}/><button className="icon-button" aria-label="Refresh AI quota" disabled={quota.isFetching} onClick={() => void quota.refetch()}><RefreshCw className={quota.isFetching ? 'spin' : ''} size={16}/></button></div></div>
      {quota.error ? <div className="inline-error"><AlertTriangle size={15}/>{quota.error instanceof Error ? quota.error.message : 'Could not load AI quota'}</div> : !status ? <div className="quota-loading"><LoaderCircle className="spin" size={18}/>Loading AI usage…</div> : <>
        <div className="quota-overview">
          <article><span><Gauge size={15}/>This month</span><strong>{compact(status.usage.tokensUsed)} tokens</strong><small>{status.usage.requestsUsed.toLocaleString()} model calls · ${status.usage.costUsedUsd.toFixed(4)} estimated</small></article>
          <article><span><WalletCards size={15}/>Provider credit</span><strong>{provider?.creditRemainingUsd !== null && provider?.creditRemainingUsd !== undefined ? `$${provider.creditRemainingUsd.toFixed(2)} left` : 'Not reported'}</strong><small>{provider ? `Last checked ${new Date(provider.capturedAt).toLocaleString()}` : 'No rate-limit headers received yet'}</small></article>
          <article><span><Gauge size={15}/>Provider rate limit</span><strong>{provider?.requestsRemaining !== null && provider?.requestsRemaining !== undefined ? `${provider.requestsRemaining.toLocaleString()} requests left` : 'Not reported'}</strong><small>{provider?.tokensRemaining !== null && provider?.tokensRemaining !== undefined ? `${compact(provider.tokensRemaining)} tokens left in current window` : 'The compatible provider did not report token capacity'}</small></article>
        </div>
        <div className="quota-progress"><div><span>Highest configured usage</span><strong>{status.budget.monthlyRequestLimit || status.budget.monthlyTokenLimit || status.budget.monthlyCostLimitUsd ? `${status.maximumPercent.toFixed(1)}%` : 'No local budget set'}</strong></div><span><i style={{ width: `${Math.min(100, status.maximumPercent)}%` }}/></span></div>
        <div className="budget-form">
          <label>Monthly model-call limit<input type="number" min="1" value={budget.monthlyRequestLimit} onChange={(event) => update('monthlyRequestLimit', event.target.value)} placeholder="Unlimited" disabled={!canEdit}/><small>Counts every provider request, including compiler calls.</small></label>
          <label>Monthly token limit<input type="number" min="1" value={budget.monthlyTokenLimit} onChange={(event) => update('monthlyTokenLimit', event.target.value)} placeholder="Unlimited" disabled={!canEdit}/><small>Combined input and output tokens.</small></label>
          <label>Monthly cost limit (USD)<input type="number" min="0.01" step="0.01" value={budget.monthlyCostLimitUsd} onChange={(event) => update('monthlyCostLimitUsd', event.target.value)} placeholder="Unlimited" disabled={!canEdit}/><small>Uses provider pricing below or known built-in pricing.</small></label>
          <label>Warning threshold (%)<input type="number" min="1" max="100" value={budget.warningPercent} onChange={(event) => update('warningPercent', event.target.value)} disabled={!canEdit}/><small>Changes status to warning at this level.</small></label>
          <label>Input price / 1M tokens<input type="number" min="0" step="0.000001" value={budget.inputCostPerMillionUsd} onChange={(event) => update('inputCostPerMillionUsd', event.target.value)} placeholder="Use built-in pricing" disabled={!canEdit}/><small>For Silra or another compatible provider.</small></label>
          <label>Output price / 1M tokens<input type="number" min="0" step="0.000001" value={budget.outputCostPerMillionUsd} onChange={(event) => update('outputCostPerMillionUsd', event.target.value)} placeholder="Use built-in pricing" disabled={!canEdit}/><small>Both pricing fields must be set together.</small></label>
        </div>
        <label className="hard-limit-control"><input type="checkbox" checked={budget.hardLimit} onChange={(event) => update('hardLimit', event.target.checked)} disabled={!canEdit}/><span><strong>Enforce a hard local limit</strong><small>When any configured monthly limit reaches 100%, new tasks, workflows, solution tests, and prompt compilation are blocked.</small></span></label>
        <div className="quota-footer"><p>Rate limits can reset within seconds or minutes. Account credit cannot be inferred when your provider does not expose it.</p>{canEdit ? <button className="button primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}Save AI budget</button> : <small>Only workspace owners and administrators can change limits.</small>}</div>
      </>}
    </section>

    <section className="panel quota-settings">
      <div className="panel-header"><div><span className="eyebrow">Presentation output</span><h2>PowerPoint design theme</h2><p>Paste a <code>DESIGN.md</code> specification. Woody validates its safe visual tokens and applies the default theme to generated PPTX files.</p></div><Palette size={20}/></div>
      {!canEdit ? <p className="inline-warning">Only workspace owners and administrators can change the default presentation theme.</p> : <div className="budget-form"><label>Theme name<input value={themeName} onChange={(event) => setThemeName(event.target.value)} maxLength={120}/></label><label className="theme-markdown-field">DESIGN.md<textarea value={designMarkdown} onChange={(event) => setDesignMarkdown(event.target.value)} maxLength={30000} spellCheck={false}/><small>Colours, fonts, visual direction, and maximum words per slide are applied deterministically. The generator does not execute Markdown.</small></label></div>}
      {canEdit && <div className="quota-footer"><p>Saving a theme makes it the default for all newly generated PowerPoint files in this workspace.</p><button className="button primary" disabled={saveTheme.isPending || designMarkdown.trim().length < 20 || themeName.trim().length < 2} onClick={() => saveTheme.mutate()}>{saveTheme.isPending ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}Save as default theme</button></div>}
      {themes.data?.data.length ? <div className="workflow-artifacts">{themes.data.data.map((item) => {
        const style = item.theme?.style ?? 'premium-dark';
        return <article key={item.id}><Palette size={16}/><span><strong>{item.name}</strong><small>Style: {style.replaceAll('-', ' ')} · {item.theme?.headingFont ?? 'Aptos Display'} · {item.theme?.primary ?? '#7C5CFF'} · {item.theme?.maxWordsPerSlide ?? 35} words per slide</small></span><Status value={item.is_default ? 'active' : 'draft'}/>{canEdit && !item.is_default && <button className="button" disabled={makeDefault.isPending} onClick={() => makeDefault.mutate(item.id)}>Make default</button>}</article>;
      })}</div> : null}
    </section>

    <section className="panel settings-card"><div><span className="setting-icon"><CircleHelp size={18}/></span><span><strong>Product onboarding</strong><small>Version {onboarding?.version ?? 1} · {onboarding?.completed ? 'completed' : `paused at step ${onboarding?.lastStep ?? 1}`}</small></span></div><div className="page-actions">{onboarding && !onboarding.completed && <button className="button" onClick={resume}>Resume onboarding</button>}<button className="button primary" onClick={restart}>Restart onboarding</button></div></section>
    <section className="panel settings-card"><div><span className="setting-icon"><Bot size={18}/></span><span><strong>Woody mascot system</strong><small>Inspect expressions, animation flags, skins, and vector sizes.</small></span></div><a className="button" href="/mascot-lab">Open mascot lab</a></section>
  </div>;
}
