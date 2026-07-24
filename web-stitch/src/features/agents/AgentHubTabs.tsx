import { Bot, Library } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export function AgentHubTabs({ active }: { active: 'agents' | 'library' }) {
  const navigate = useNavigate();
  return <nav className="agent-hub-tabs" aria-label="Agent sections">
    <button className={active === 'agents' ? 'active' : ''} aria-current={active === 'agents' ? 'page' : undefined} onClick={() => navigate('/agents')}><Bot size={16}/><span><strong>My Agents</strong><small>Your created and installed agents</small></span></button>
    <button className={active === 'library' ? 'active' : ''} aria-current={active === 'library' ? 'page' : undefined} onClick={() => navigate('/agents/library')}><Library size={16}/><span><strong>Agent Library</strong><small>Ready-made agents and systems</small></span></button>
  </nav>;
}
