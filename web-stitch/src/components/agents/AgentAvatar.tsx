import { useQuery } from '@tanstack/react-query';
import {
  BarChart3, BrainCircuit, Check, Coins, Code2, GitBranch, Megaphone,
  Network, Palette, PenLine, Search, ShieldCheck, Sparkles, Users, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { api, type Agent, type AgentAvatarConfig, type AgentAvatarIcon } from '../../api';
import './agent-avatar.css';

const icons: Record<AgentAvatarIcon, LucideIcon> = {
  network: Network, search: Search, route: GitBranch, code: Code2, pen: PenLine,
  megaphone: Megaphone, chart: BarChart3, check: Check, brain: BrainCircuit,
  zap: Zap, users: Users, coins: Coins, palette: Palette, shield: ShieldCheck, sparkles: Sparkles,
};

const palettes = [
  ['#312e81', '#a5b4fc'], ['#164e63', '#67e8f9'], ['#064e3b', '#6ee7b7'],
  ['#4c1d95', '#d8b4fe'], ['#7c2d12', '#fdba74'], ['#1e3a8a', '#93c5fd'],
] as const;

const roleIcons: Array<[RegExp, AgentAvatarIcon]> = [
  [/research|search|analyst/i, 'search'], [/develop|engineer|code|technical/i, 'code'],
  [/write|content|editor/i, 'pen'], [/market|social|growth/i, 'megaphone'],
  [/data|finance|metric/i, 'chart'], [/quality|review|compliance|legal/i, 'check'],
  [/design|creative/i, 'palette'], [/security|risk/i, 'shield'], [/team|manager|coordinator/i, 'users'],
];

function hash(value: string) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) result = ((result << 5) - result + value.charCodeAt(index)) | 0;
  return Math.abs(result);
}

export function initialsFor(name = 'Agent') {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'A';
}

export function defaultAgentAvatar(name = 'Agent', role = ''): Extract<AgentAvatarConfig, { type: 'icon' }> {
  const [backgroundColor, accentColor] = palettes[hash(`${name}:${role}`) % palettes.length];
  return { type: 'icon', value: roleIcons.find(([pattern]) => pattern.test(role))?.[1] ?? 'sparkles', backgroundColor, accentColor };
}

export function resolvedAgentAvatar(agent: Pick<Agent, 'name' | 'role' | 'avatar_config'>): AgentAvatarConfig {
  const value = agent.avatar_config as Partial<AgentAvatarConfig> | undefined;
  if (value?.type === 'image' && value.value === 'uploaded') return value as AgentAvatarConfig;
  if (value?.type === 'initials' && typeof value.value === 'string' && value.value) return value as AgentAvatarConfig;
  if (value?.type === 'icon' && typeof value.value === 'string' && value.value in icons) return value as AgentAvatarConfig;
  return defaultAgentAvatar(agent.name, agent.role);
}

export const agentAvatarIcons = icons;
export const agentAvatarPalettes = palettes;

type AvatarAgent = Pick<Agent, 'name' | 'role' | 'avatar_config'> & Partial<Pick<Agent, 'id' | 'updated_at'>>;

export const AgentAvatar = memo(function AgentAvatar({ agent, size = 'md', status, decorative = false, className = '' }: {
  agent: AvatarAgent;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  status?: 'active' | 'idle' | 'busy' | 'error' | 'offline' | string;
  decorative?: boolean;
  className?: string;
}) {
  const config = resolvedAgentAvatar(agent);
  const wantsImage = config.type === 'image' && Boolean(agent.id);
  const image = useQuery({
    queryKey: ['agent-avatar-image', agent.id, agent.updated_at],
    queryFn: () => api.agentAvatarImage(agent.id!),
    enabled: wantsImage,
    staleTime: Infinity,
    retry: 1,
  });
  const imageUrl = useMemo(() => image.data ? URL.createObjectURL(image.data) : '', [image.data]);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);
  useEffect(() => setImageFailed(false), [imageUrl, agent.id]);

  const fallback = defaultAgentAvatar(agent.name, agent.role);
  const visible = config.type === 'image' && (!imageUrl || imageFailed) ? fallback : config;
  const backgroundColor = visible.type === 'image' ? '#312e81' : visible.backgroundColor ?? fallback.backgroundColor;
  const accentColor = visible.type === 'image' ? '#c4b5fd' : visible.accentColor ?? fallback.accentColor;
  const Icon = visible.type === 'icon' ? icons[visible.value] : null;
  const label = config.alt || `${agent.name} avatar`;
  return <span
    className={`agent-avatar agent-avatar-${size} ${className}`.trim()}
    style={{ '--avatar-bg': backgroundColor, '--avatar-accent': accentColor } as React.CSSProperties}
    role={decorative ? undefined : 'img'} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined}
  >
    {config.type === 'image' && imageUrl && !imageFailed ? <img src={imageUrl} alt="" onError={() => setImageFailed(true)}/> :
      visible.type === 'initials' ? <b>{visible.value || initialsFor(agent.name)}</b> : Icon ? <Icon aria-hidden="true"/> : <Sparkles aria-hidden="true"/>}
    {status && <i className={`agent-avatar-status ${status}`} aria-hidden="true"/>}
  </span>;
});
