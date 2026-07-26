import { useState } from 'react';
import { Mascot } from '../../components/Mascot';
import { ThinkingOrbIndicator, type ThinkingOrbState } from '../../components/ThinkingOrbIndicator';
import { mascotExpressionNames } from '../../components/Expressions';
import type { MascotExpression, MascotSkin } from '../../components/Types';
import { PageHeader } from '../../components/ui';

const sampleSizes = [32, 48, 64, 128, 256, 512];
const orbStates: Array<{ state: ThinkingOrbState; title: string; use: string; recommended?: string }> = [
  { state: 'working', title: 'Working', use: 'General agent execution and workflow activity.', recommended: 'Agent activity' },
  { state: 'searching', title: 'Searching', use: 'Web research, workspace knowledge, and retrieval.', recommended: 'Research steps' },
  { state: 'solving', title: 'Solving', use: 'Woody thinking or an agent reasoning through a request.', recommended: 'Woody chat' },
  { state: 'composing', title: 'Composing', use: 'Writing the final response or generating an artifact.', recommended: 'Output generation' },
  { state: 'listening', title: 'Listening', use: 'Reserve for a future voice or live-input experience.' },
  { state: 'shaping', title: 'Shaping', use: 'Reserve for workflow or artifact design previews.' },
];

export function MascotLabPage() {
  const [expression, setExpression] = useState<MascotExpression>('happy');
  const [skin, setSkin] = useState<MascotSkin>('classic');
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [waving, setWaving] = useState(false);
  const [floating, setFloating] = useState(true);
  const [blink, setBlink] = useState(true);

  return <div className="mascot-lab-page">
    <PageHeader eyebrow="Design system" title="Woody Mascot Lab" description="Inspect every expression, animation state, skin, and supported production size."/>
    <section className="panel mascot-lab-stage">
      <Mascot expression={expression} skin={skin} size={300} speaking={speaking} thinking={thinking} loading={loading} waving={waving} floating={floating} blink={blink}/>
      <div className="mascot-lab-controls">
        <label>Expression<select value={expression} onChange={(event) => setExpression(event.target.value as MascotExpression)}>{mascotExpressionNames.map((name) => <option value={name} key={name}>{name}</option>)}</select></label>
        <label>Skin<select value={skin} onChange={(event) => setSkin(event.target.value as MascotSkin)}><option value="classic">Classic</option><option value="midnight">Midnight</option><option value="rose">Rose</option></select></label>
        <div className="mascot-toggle-grid">
          {[
            ['Speaking', speaking, setSpeaking], ['Thinking', thinking, setThinking], ['Loading', loading, setLoading], ['Waving', waving, setWaving],
            ['Floating', floating, setFloating], ['Blinking', blink, setBlink],
          ].map(([label, value, setValue]) => <label key={String(label)}><input type="checkbox" checked={Boolean(value)} onChange={(event) => (setValue as (next: boolean) => void)(event.target.checked)}/>{String(label)}</label>)}
        </div>
      </div>
    </section>
    <section className="panel thinking-orb-gallery">
      <div className="panel-header"><div><span className="eyebrow">Agent motion system</span><h2>Thinking orb states</h2><p>Use motion only while work is active. The 20px preset is best inside status rows; 64px is best for a focused AI response state.</p></div></div>
      <div>{orbStates.map((item) => <article key={item.state}><span className="orb-preview"><ThinkingOrbIndicator state={item.state} size={64} label={`${item.title} orb preview`}/></span><span><small>{item.recommended ?? 'Future use'}</small><strong>{item.title}</strong><p>{item.use}</p></span><span className="orb-inline-preview"><ThinkingOrbIndicator state={item.state} size={20} label={`${item.title} inline orb preview`}/><code>20px</code></span></article>)}</div>
    </section>
    <section className="panel mascot-expression-gallery"><div className="panel-header"><div><span className="eyebrow">Expression registry</span><h2>All {mascotExpressionNames.length} states</h2></div></div><div>{mascotExpressionNames.map((name) => <button className={name === expression ? 'active' : ''} onClick={() => setExpression(name)} key={name}><Mascot expression={name} skin={skin} size={88} floating={false}/><span>{name}</span></button>)}</div></section>
    <section className="panel mascot-size-gallery"><div className="panel-header"><div><span className="eyebrow">Vector scaling</span><h2>Supported sizes</h2></div></div><div>{sampleSizes.map((size) => <article key={size}><Mascot expression={expression} skin={skin} size={size} floating={false}/><span>{size}px</span></article>)}</div></section>
  </div>;
}
