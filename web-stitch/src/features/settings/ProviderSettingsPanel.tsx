import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, KeyRound, LoaderCircle, Save, TestTube2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type RuntimeConfig } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { Status } from '../../components/ui';

type ProviderForm = {
  provider: 'anthropic' | 'openai-compatible';
  defaultModel: string;
  baseUrl: string;
  apiKey: string;
};

const emptyForm: ProviderForm = { provider: 'openai-compatible', defaultModel: '', baseUrl: '', apiKey: '' };

function fromConfig(config?: RuntimeConfig): ProviderForm {
  return {
    provider: config?.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
    defaultModel: config?.defaultModel ?? '',
    baseUrl: config?.baseUrl ?? '',
    apiKey: '',
  };
}

function comparable(form: ProviderForm) {
  return JSON.stringify({ provider: form.provider, defaultModel: form.defaultModel.trim(), baseUrl: form.provider === 'openai-compatible' ? form.baseUrl.trim().replace(/\/$/, '') : '' });
}

export function ProviderSettingsPanel({ canEdit, onDirtyChange }: { canEdit: boolean; onDirtyChange: (dirty: boolean) => void }) {
  const { report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ['runtime-config'], queryFn: api.runtimeConfig });
  const [form, setForm] = useState<ProviderForm>(emptyForm);
  const [baseline, setBaseline] = useState(comparable(emptyForm));
  useEffect(() => {
    if (!config.data) return;
    const next = fromConfig(config.data); setForm(next); setBaseline(comparable(next));
  }, [config.data]);
  const dirty = useMemo(() => comparable(form) !== baseline || Boolean(form.apiKey.trim()), [baseline, form]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useMutation({
    mutationFn: () => api.updateRuntimeConfig({
      provider: form.provider,
      defaultModel: form.defaultModel.trim(),
      baseUrl: form.provider === 'openai-compatible' ? form.baseUrl.trim() : null,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    }),
    onSuccess: async (result) => {
      const next = fromConfig(result); setForm(next); setBaseline(comparable(next));
      queryClient.setQueryData(['runtime-config'], result);
      report('AI provider saved securely. Test the connection before running important work.');
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not save AI provider'),
  });
  const test = useMutation({
    mutationFn: api.testRuntimeConfig,
    onSuccess: async () => { report('AI provider connection is healthy'); await config.refetch(); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: async (cause) => { reportError(cause instanceof Error ? cause.message : 'Provider test failed'); await config.refetch(); },
  });
  const current = config.data;
  const needsNewKey = !current || current.source !== 'workspace' || current.provider !== form.provider;
  const valid = form.defaultModel.trim().length > 0
    && (form.provider === 'anthropic' || form.baseUrl.trim().length > 0)
    && (!needsNewKey || form.apiKey.trim().length >= 8);

  return <section className="panel settings-section-card provider-settings">
    <div className="panel-header"><div><span className="eyebrow">AI provider</span><h2>Model connection</h2><p>One encrypted workspace connection powers agents, workflows, Prompt-to-Agent, and Woody chat.</p></div><div className="provider-state"><Status value={current?.status ?? 'loading'}/>{current?.apiKeyHint && <small><KeyRound size={11}/>{current.apiKeyHint}</small>}</div></div>
    {config.isLoading ? <div className="quota-loading"><LoaderCircle className="spin" size={18}/>Loading provider configuration…</div> : config.error ? <div className="inline-error"><AlertTriangle size={15}/>{config.error instanceof Error ? config.error.message : 'Could not load provider settings'}</div> : <>
      <div className="provider-summary">
        <span><small>Configuration source</small><strong>{current?.source === 'workspace' ? 'Encrypted workspace setting' : current?.source === 'environment' ? 'Server environment fallback' : 'Not configured'}</strong></span>
        <span><small>Connection status</small><strong>{current?.status === 'healthy' ? 'Tested and healthy' : current?.status === 'error' ? 'Needs attention' : current?.status === 'environment' ? 'Available · not tested here' : 'Save and test'}</strong></span>
        <span><small>Last test</small><strong>{current?.lastTestedAt ? new Date(current.lastTestedAt).toLocaleString() : 'Not tested'}</strong></span>
      </div>
      {current?.lastErrorMessage && <div className="inline-error"><AlertTriangle size={15}/>{current.lastErrorMessage}</div>}
      <div className="provider-form">
        <label>Provider<select value={form.provider} disabled={!canEdit} onChange={(event) => setForm((value) => ({ ...value, provider: event.target.value as ProviderForm['provider'], apiKey: '' }))}><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select><small>OpenRouter, Silra, and similar services use OpenAI-compatible.</small></label>
        <label>Default model<input value={form.defaultModel} disabled={!canEdit} maxLength={200} onChange={(event) => setForm((value) => ({ ...value, defaultModel: event.target.value }))} placeholder={form.provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'provider model name'}/><small>Used by Woody chat and Prompt-to-Agent. Existing agents keep their selected model.</small></label>
        {form.provider === 'openai-compatible' && <label className="provider-wide-field">Compatible API URL<input type="url" value={form.baseUrl} disabled={!canEdit} maxLength={2000} onChange={(event) => setForm((value) => ({ ...value, baseUrl: event.target.value }))} placeholder="https://openrouter.ai/api/v1"/><small>You may paste a full <code>/chat/completions</code> URL; Woody stores the normalized base URL. HTTPS public endpoints only.</small></label>}
        <label className="provider-wide-field">API key<input type="password" value={form.apiKey} disabled={!canEdit} autoComplete="new-password" maxLength={20000} onChange={(event) => setForm((value) => ({ ...value, apiKey: event.target.value }))} placeholder={needsNewKey ? 'Required for this provider' : `Leave blank to keep ${current?.apiKeyHint ?? 'the saved key'}`}/><small>The key is encrypted on the backend, never returned to this browser, and never stored in agents or workflows.</small></label>
      </div>
      {dirty && <div className="inline-warning"><AlertTriangle size={15}/>Unsaved provider changes. Save before leaving or testing.</div>}
      <div className="provider-actions"><p>{canEdit ? 'Testing sends a minimal one-token request and may consume a very small amount of provider credit.' : 'Only workspace owners and administrators can change or test providers.'}</p>{canEdit && <><button className="button" disabled={dirty || !current?.configured || test.isPending} onClick={() => test.mutate()}>{test.isPending ? <LoaderCircle className="spin" size={14}/> : current?.status === 'healthy' ? <CheckCircle2 size={14}/> : <TestTube2 size={14}/>}Test saved connection</button><button className="button primary" disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" size={14}/> : <Save size={14}/>}Save provider</button></>}</div>
    </>}
  </section>;
}
