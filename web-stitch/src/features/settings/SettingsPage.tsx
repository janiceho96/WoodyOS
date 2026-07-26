import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, BrainCircuit, Building2, CircleHelp, Code2, ExternalLink, Gauge, KeyRound, LoaderCircle, Moon, Palette, RefreshCw, Save, ShieldCheck, SlidersHorizontal, Sun, WalletCards } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type AiQuotaStatus, type Onboarding } from '../../api';
import { DEFAULT_ACCENT_COLOR, type Theme } from '../../app/theme';
import { useWorkspace } from '../../app/workspace';
import { PageHeader, Status } from '../../components/ui';
import { compact } from '../../lib/format';
import { ProviderSettingsPanel } from './ProviderSettingsPanel';

type SettingsSection = 'workspace' | 'providers' | 'budget' | 'security' | 'presentation' | 'appearance' | 'developer';

const settingsSections: Array<{ id: SettingsSection; label: string; description: string; Icon: typeof Building2 }> = [
  { id: 'workspace', label: 'Workspace', description: 'Identity and onboarding', Icon: Building2 },
  { id: 'providers', label: 'AI Providers', description: 'Models and encrypted keys', Icon: BrainCircuit },
  { id: 'budget', label: 'Budget', description: 'Usage and hard limits', Icon: Gauge },
  { id: 'security', label: 'Security', description: 'Permissions and confirmation', Icon: ShieldCheck },
  { id: 'presentation', label: 'Output design', description: 'PowerPoint and safe HTML', Icon: Palette },
  { id: 'appearance', label: 'Appearance', description: 'Theme and mascot', Icon: Sun },
  { id: 'developer', label: 'Developer', description: 'API and runtime details', Icon: Code2 },
];

const appAccentPresets = [
  { name: 'Violet', value: DEFAULT_ACCENT_COLOR },
  { name: 'Blue', value: '#3478f6' },
  { name: 'Teal', value: '#008f86' },
  { name: 'Rose', value: '#d44d7e' },
  { name: 'Orange', value: '#c86625' },
] as const;

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

const defaultHtmlDesignMarkdown = `# Woody Safe HTML Design

## Colors
- Background: #0B1020
- Surface: #121A30
- Primary text: #F5F7FF
- Secondary text: #AAB3CC
- Accent: #8B7CFF
- Border: #2B3657

## Typography
- Headings: system
- Body font: system

## Layout
- Density: comfortable

Generated pages remain self-contained, script-free, and safe to preview inside a sandbox.`;

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

export function SettingsPage({ theme, setTheme, accentColor, setAccentColor, onboarding, resume, restart }: { theme: Theme; setTheme: (theme: Theme) => void; accentColor: string; setAccentColor: (color: string) => void; onboarding: Onboarding | null; resume: () => void; restart: () => void }) {
  const { session, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const quota = useQuery({ queryKey: ['ai-quota'], queryFn: api.aiQuota, refetchInterval: 15_000 });
  const themes = useQuery({ queryKey: ['presentation-themes'], queryFn: api.presentationThemes });
  const artifactTemplates = useQuery({ queryKey: ['artifact-templates'], queryFn: api.artifactTemplates });
  const [budget, setBudget] = useState<BudgetForm>(emptyBudget);
  const [themeName, setThemeName] = useState('Woody Dark Premium');
  const [designMarkdown, setDesignMarkdown] = useState(defaultDesignMarkdown);
  const [htmlTemplateName, setHtmlTemplateName] = useState('Woody Safe HTML');
  const [htmlDesignMarkdown, setHtmlDesignMarkdown] = useState(defaultHtmlDesignMarkdown);
  const [section, setSection] = useState<SettingsSection>('workspace');
  const [providerDirty, setProviderDirty] = useState(false);
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
  const saveHtmlTemplate = useMutation({
    mutationFn: () => api.createArtifactTemplate({
      name: htmlTemplateName, format: 'html', designMarkdown: htmlDesignMarkdown, isDefault: true,
    }),
    onSuccess: async () => {
      report('Safe HTML template saved as the workspace default');
      await queryClient.invalidateQueries({ queryKey: ['artifact-templates'] });
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not save HTML output template'),
  });
  const makeHtmlDefault = useMutation({
    mutationFn: (id: string) => api.updateArtifactTemplate(id, { isDefault: true }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['artifact-templates'] }),
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not set the HTML output default'),
  });
  const status = quota.data;
  const provider = status?.provider;
  const budgetConfigured = Boolean(status && [status.budget.monthlyRequestLimit, status.budget.monthlyTokenLimit, status.budget.monthlyCostLimitUsd].some((value) => value !== null));
  const pricingAvailable = Boolean(status && (
    status.usage.tokensUsed === 0
    || status.usage.costUsedUsd > 0
    || (status.budget.inputCostPerMillionUsd !== null && status.budget.outputCostPerMillionUsd !== null)
  ));
  const changeSection = (next: SettingsSection) => {
    if (section === 'providers' && providerDirty && !window.confirm('Discard unsaved AI provider changes?')) return;
    setSection(next);
  };

  return <div className="settings-page">
    <PageHeader eyebrow="Workspace" title="Settings" description="Manage workspace identity, AI providers, budget, security, output design, and developer access."/>
    <div className="settings-layout">
      <nav className="panel settings-nav" aria-label="Settings sections">{settingsSections.map(({ id, label, description, Icon }) => <button key={id} className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => changeSection(id)}><Icon size={16}/><span><strong>{label}</strong><small>{description}</small></span>{id === 'providers' && providerDirty && <i aria-label="Unsaved changes"/>}</button>)}</nav>
      <div className="settings-content">
        <div className="settings-section" hidden={section !== 'workspace'}>
          <section className="panel settings-section-card"><div className="panel-header"><div><span className="eyebrow">Workspace identity</span><h2>{session.workspace.name}</h2><p>Your account and role determine which settings you can change.</p></div><Status value={session.workspace.role ?? 'member'}/></div><div className="workspace-facts"><span><small>Signed in as</small><strong>{session.user.displayName}</strong><code>{session.user.email}</code></span><span><small>Workspace role</small><strong>{session.workspace.role ?? 'member'}</strong><code>{session.workspace.id}</code></span></div></section>
          <section className="panel settings-card"><div><span className="setting-icon"><CircleHelp size={18}/></span><span><strong>Product onboarding</strong><small>Version {onboarding?.version ?? 1} · {onboarding?.completed ? 'completed' : `paused at step ${onboarding?.lastStep ?? 1}`}</small></span></div><div className="page-actions">{onboarding && !onboarding.completed && <button className="button" onClick={resume}>Resume onboarding</button>}<button className="button primary" onClick={restart}>Restart onboarding</button></div></section>
        </div>

        <div className="settings-section" hidden={section !== 'providers'}><ProviderSettingsPanel canEdit={canEdit} onDirtyChange={setProviderDirty}/></div>

        <div className="settings-section" hidden={section !== 'budget'}><section className="panel quota-settings">
      <div className="panel-header"><div><span className="eyebrow">Usage guardrail</span><h2>AI budget and provider limits</h2><p>Local limits are enforced by Woody. Provider values appear only when the API reports safe rate-limit headers.</p></div><div className="quota-header-actions"><Status value={status?.state ?? 'loading'}/><button className="icon-button" aria-label="Refresh AI quota" disabled={quota.isFetching} onClick={() => void quota.refetch()}><RefreshCw className={quota.isFetching ? 'spin' : ''} size={16}/></button></div></div>
      {quota.error ? <div className="inline-error"><AlertTriangle size={15}/>{quota.error instanceof Error ? quota.error.message : 'Could not load AI quota'}</div> : !status ? <div className="quota-loading"><LoaderCircle className="spin" size={18}/>Loading AI usage…</div> : <>
        <div className="quota-overview">
          <article><span><Gauge size={15}/>This month</span><strong>{compact(status.usage.tokensUsed)} tokens</strong><small>{status.usage.requestsUsed.toLocaleString()} model calls · {pricingAvailable ? `$${status.usage.costUsedUsd.toFixed(4)} estimated` : 'pricing unavailable'}</small></article>
          <article><span><WalletCards size={15}/>Provider credit</span><strong>{provider?.creditRemainingUsd !== null && provider?.creditRemainingUsd !== undefined ? `$${provider.creditRemainingUsd.toFixed(2)} left` : 'Not reported'}</strong><small>{provider ? `Last checked ${new Date(provider.capturedAt).toLocaleString()}` : 'No rate-limit headers received yet'}</small></article>
          <article><span><Gauge size={15}/>Provider rate limit</span><strong>{provider?.requestsRemaining !== null && provider?.requestsRemaining !== undefined ? `${provider.requestsRemaining.toLocaleString()} requests left` : 'Not reported'}</strong><small>{provider?.tokensRemaining !== null && provider?.tokensRemaining !== undefined ? `${compact(provider.tokensRemaining)} tokens left in current window` : 'The compatible provider did not report token capacity'}</small></article>
        </div>
        {budgetConfigured ? <div className="quota-progress"><div><span>Highest configured usage</span><strong>{status.maximumPercent.toFixed(1)}%</strong></div><span><i style={{ width: `${Math.min(100, status.maximumPercent)}%` }}/></span></div> : <div className="local-budget-empty"><Gauge size={16}/><span><strong>No local budget configured</strong><small>Add a request, token, or cost limit below to enable usage progress and warnings.</small></span></div>}
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
        </section></div>

        <div className="settings-section" hidden={section !== 'security'}><section className="panel settings-section-card"><div className="panel-header"><div><span className="eyebrow">Security model</span><h2>Least privilege by default</h2><p>These protections are enforced by the backend and cannot be bypassed by a workflow canvas or agent prompt.</p></div><ShieldCheck size={21}/></div><div className="security-settings-grid"><article><KeyRound size={17}/><span><strong>Encrypted credentials</strong><small>Provider, API, OAuth, and MCP credentials remain server-side and are never returned to agents or this browser.</small></span></article><article><ShieldCheck size={17}/><span><strong>Action-bound confirmation</strong><small>Every write-capable or uncertain action is confirmed against its final operation and argument hash. Changed actions must be approved again.</small></span></article><article><SlidersHorizontal size={17}/><span><strong>Per-agent permissions</strong><small>Assigned API tools and MCP allowlists determine what an agent can request before the shared policy gateway makes the final decision.</small></span></article></div><div className="settings-callout"><span>Review connected apps, health, tool access, and audit activity in Advanced MCP.</span><a className="button" href="/mcp">Review integration security <ExternalLink size={13}/></a></div></section></div>

        <div className="settings-section" hidden={section !== 'presentation'}><section className="panel quota-settings">
      <div className="panel-header"><div><span className="eyebrow">Presentation output</span><h2>PowerPoint design theme</h2><p>Paste a <code>DESIGN.md</code> specification. Woody validates its safe visual tokens and applies the default theme to generated PPTX files.</p></div><Palette size={20}/></div>
      {!canEdit ? <p className="inline-warning">Only workspace owners and administrators can change the default presentation theme.</p> : <div className="budget-form"><label>Theme name<input value={themeName} onChange={(event) => setThemeName(event.target.value)} maxLength={120}/></label><label className="theme-markdown-field">DESIGN.md<textarea value={designMarkdown} onChange={(event) => setDesignMarkdown(event.target.value)} maxLength={30000} spellCheck={false}/><small>Colours, fonts, visual direction, and maximum words per slide are applied deterministically. The generator does not execute Markdown.</small></label></div>}
      {canEdit && <div className="quota-footer"><p>Saving a theme makes it the default for all newly generated PowerPoint files in this workspace.</p><button className="button primary" disabled={saveTheme.isPending || designMarkdown.trim().length < 20 || themeName.trim().length < 2} onClick={() => saveTheme.mutate()}>{saveTheme.isPending ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}Save as default theme</button></div>}
      {themes.data?.data.length ? <div className="workflow-artifacts">{themes.data.data.map((item) => {
        const style = item.theme?.style ?? 'premium-dark';
        return <article key={item.id}><Palette size={16}/><span><strong>{item.name}</strong><small>Style: {style.replaceAll('-', ' ')} · {item.theme?.headingFont ?? 'Aptos Display'} · {item.theme?.primary ?? '#7C5CFF'} · {item.theme?.maxWordsPerSlide ?? 35} words per slide</small></span><Status value={item.is_default ? 'active' : 'draft'}/>{canEdit && !item.is_default && <button className="button" disabled={makeDefault.isPending} onClick={() => makeDefault.mutate(item.id)}>Make default</button>}</article>;
      })}</div> : null}
        </section>
        <section className="panel quota-settings">
          <div className="panel-header"><div><span className="eyebrow">Web output</span><h2>Safe HTML template</h2><p>Define reusable colour, font-family, and density tokens. Woody applies the default only to newly generated HTML files; scripts and external requests remain blocked.</p></div><Code2 size={20}/></div>
          {!canEdit ? <p className="inline-warning">Only workspace owners and administrators can change output templates.</p> : <div className="budget-form">
            <label>Template name<input value={htmlTemplateName} onChange={(event) => setHtmlTemplateName(event.target.value)} maxLength={120}/></label>
            <label className="theme-markdown-field">HTML DESIGN.md<textarea value={htmlDesignMarkdown} onChange={(event) => setHtmlDesignMarkdown(event.target.value)} maxLength={30000} spellCheck={false}/><small>Supported tokens: Background, Surface, Primary text, Secondary text, Accent, Border, heading/body family (system, serif, mono), and comfortable/compact density.</small></label>
          </div>}
          {canEdit && <div className="quota-footer"><p>Templates control safe visual tokens, never executable markup or JavaScript.</p><button className="button primary" disabled={saveHtmlTemplate.isPending || htmlDesignMarkdown.trim().length < 20 || htmlTemplateName.trim().length < 2} onClick={() => saveHtmlTemplate.mutate()}>{saveHtmlTemplate.isPending ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}Save HTML default</button></div>}
          {artifactTemplates.data?.data.length ? <div className="workflow-artifacts">{artifactTemplates.data.data.map((item) => <article key={item.id}><Code2 size={16}/><span><strong>{item.name}</strong><small>{item.theme.density} · {item.theme.headingFont} headings · {item.theme.accent} accent</small></span><Status value={item.is_default ? 'active' : 'draft'}/>{canEdit && !item.is_default && <button className="button" disabled={makeHtmlDefault.isPending} onClick={() => makeHtmlDefault.mutate(item.id)}>Make default</button>}</article>)}</div> : null}
        </section></div>

        <div className="settings-section" hidden={section !== 'appearance'}>
          <section className="panel settings-section-card appearance-settings">
            <div className="panel-header"><div><span className="eyebrow">Interface theme</span><h2>Colour and appearance</h2><p>Changes are applied immediately across the app and remembered on this device.</p></div><Palette size={21}/></div>
            <div className="appearance-control">
              <span><strong>Light or dark</strong><small>Icons, agent avatar frames, surfaces, and text adapt together.</small></span>
              <div className="theme-switch" role="group" aria-label="Interface theme"><button className={theme === 'dark' ? 'active' : ''} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><Moon size={15}/>Dark</button><button className={theme === 'light' ? 'active' : ''} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><Sun size={15}/>Light</button></div>
            </div>
            <div className="appearance-control appearance-colour-control">
              <span><strong>App accent colour</strong><small>Tunes navigation, buttons, focus rings, highlights, and decorative glows.</small></span>
              <div className="app-colour-picker">
                <div className="app-colour-presets" role="group" aria-label="Accent colour presets">{appAccentPresets.map((preset) => <button key={preset.value} className={accentColor.toLowerCase() === preset.value ? 'active' : ''} aria-label={preset.name} aria-pressed={accentColor.toLowerCase() === preset.value} title={preset.name} style={{ '--swatch': preset.value } as React.CSSProperties} onClick={() => setAccentColor(preset.value)}/>)}</div>
                <label className="custom-colour"><input type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)}/><span>Custom</span><code>{accentColor.toUpperCase()}</code></label>
                {accentColor.toLowerCase() !== DEFAULT_ACCENT_COLOR && <button className="text-button" onClick={() => setAccentColor(DEFAULT_ACCENT_COLOR)}>Reset colour</button>}
              </div>
            </div>
          </section>
          <section className="panel settings-card"><div><span className="setting-icon"><Bot size={18}/></span><span><strong>Woody mascot system</strong><small>Inspect expressions, animation flags, skins, and vector sizes.</small></span></div><a className="button" href="/mascot-lab">Open mascot lab</a></section>
        </div>

        <div className="settings-section" hidden={section !== 'developer'}><section className="panel settings-section-card"><div className="panel-header"><div><span className="eyebrow">Developer access</span><h2>API and runtime</h2><p>Use the authenticated API documentation for integration and troubleshooting. Secrets are intentionally excluded.</p></div><Code2 size={21}/></div><div className="workspace-facts"><span><small>API proxy</small><strong>Same-origin /v1</strong><code>http://localhost:3002/v1</code></span><span><small>Health check</small><strong>Backend health</strong><code>http://localhost:3002/health</code></span></div><div className="settings-callout"><span>The OpenAPI page documents the real backend routes available to this workspace.</span><a className="button primary" href="/docs">Open API documentation <ExternalLink size={13}/></a></div></section></div>
      </div>
    </div>
  </div>;
}
