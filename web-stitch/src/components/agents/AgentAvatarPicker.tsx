import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, LoaderCircle, RotateCcw, Type } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, type Agent, type AgentAvatarConfig, type AgentAvatarIcon } from '../../api';
import { AgentAvatar, agentAvatarIcons, agentAvatarPalettes, defaultAgentAvatar, initialsFor } from './AgentAvatar';

export function AgentAvatarPicker({ agent, name, role, value, onChange, onAgentUpdated }: {
  agent?: Agent;
  name: string;
  role: string;
  value: AgentAvatarConfig | null;
  onChange: (value: AgentAvatarConfig | null) => void;
  onAgentUpdated?: (agent: Agent) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const shown = value ?? defaultAgentAvatar(name, role);
  const preview = { id: agent?.id, name: name || 'Untitled agent', role, updated_at: agent?.updated_at, avatar_config: shown };
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    await queryClient.invalidateQueries({ queryKey: ['agent-avatar-image', agent?.id] });
  };
  const upload = useMutation({
    mutationFn: (file: File) => agent ? api.uploadAgentAvatar(agent.id, file) : Promise.reject(new Error('Save the agent before uploading a custom picture.')),
    onSuccess: async (saved) => { setError(''); onChange(saved.avatar_config as AgentAvatarConfig); onAgentUpdated?.(saved); await refresh(); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'Could not upload avatar'),
  });
  const reset = useMutation({
    mutationFn: () => agent ? api.resetAgentAvatar(agent.id) : Promise.resolve(),
    onSuccess: async () => { setError(''); onChange(null); await refresh(); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'Could not reset avatar'),
  });
  const chooseIcon = (icon: AgentAvatarIcon) => onChange({ type: 'icon', value: icon, backgroundColor: shown.type !== 'image' ? shown.backgroundColor : undefined, accentColor: shown.type !== 'image' ? shown.accentColor : undefined });
  const chooseColors = (backgroundColor: string, accentColor: string) => onChange(shown.type === 'image' ? { type: 'icon', value: 'sparkles', backgroundColor, accentColor } : { ...shown, backgroundColor, accentColor });

  return <div className="agent-avatar-picker">
    <div className="avatar-picker-preview"><AgentAvatar agent={preview} size="xl"/><span><strong>Agent picture</strong><small>Used anywhere this agent appears.</small></span></div>
    <div className="avatar-picker-modes">
      <button type="button" className={shown.type === 'initials' ? 'active' : ''} onClick={() => onChange({ type: 'initials', value: initialsFor(name) })}><Type size={15}/>Initials</button>
      <button type="button" onClick={() => input.current?.click()} disabled={!agent || upload.isPending}>{upload.isPending ? <LoaderCircle className="spin" size={15}/> : <ImagePlus size={15}/>}Upload image</button>
      <button type="button" onClick={() => reset.mutate()} disabled={reset.isPending}><RotateCcw size={15}/>Use role default</button>
      <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) upload.mutate(file); event.target.value = ''; }}/>
    </div>
    {!agent && <small className="avatar-picker-help">Save this agent as a draft before uploading a custom image. Icons and initials can be chosen now.</small>}
    {shown.type === 'initials' && <label className="avatar-initials-field">Initials<input value={shown.value} maxLength={3} onChange={(event) => onChange({ ...shown, value: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'A' })}/></label>}
    <div className="avatar-icon-grid" aria-label="Choose an agent icon">{(Object.entries(agentAvatarIcons) as Array<[AgentAvatarIcon, typeof agentAvatarIcons[AgentAvatarIcon]]>).map(([key, Icon]) => <button type="button" aria-label={key} title={key} className={shown.type === 'icon' && shown.value === key ? 'active' : ''} key={key} onClick={() => chooseIcon(key)}><Icon size={18}/></button>)}</div>
    <div className="avatar-palette-row" aria-label="Choose avatar colors">{agentAvatarPalettes.map(([background, accent]) => <button type="button" aria-label={`Use ${background} and ${accent}`} key={background} className={shown.type !== 'image' && shown.backgroundColor === background ? 'active' : ''} style={{ background, color: accent }} onClick={() => chooseColors(background, accent)}><i/></button>)}</div>
    {error && <small className="avatar-picker-error">{error}</small>}
  </div>;
}
