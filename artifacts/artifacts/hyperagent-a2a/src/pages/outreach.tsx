import { useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import {
  ArrowUpRight, Bot, Check, CircleAlert, Compass,
  Fingerprint, Globe2, LoaderCircle, LockKeyhole, Radio,
  ShieldCheck, Target,
} from 'lucide-react';
import {
  getGetA2aRegistryAgentsQueryKey,
  useDiscoverA2aAgent,
  useGetA2aRegistryAgents,
  useGetA2aSettings,
  usePingA2aAgent,
} from '@workspace/api-client-react';
import type {
  A2aAgentCard,
  A2aAgentPing,
  A2aRegistryAgent,
} from '@workspace/api-client-react';

function errorText(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function dateLabel(value?: string | Date) {
  if (!value) return 'Time not provided';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? typeof value === 'string' ? value : 'Time not provided'
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function registryConnectionLabel(agent: A2aRegistryAgent) {
  switch (agent.connectionStatus) {
    case 'connected': return 'CARD CONNECTED · READ ONLY';
    case 'opt-in-required': return 'CONTACT OPT-IN NOT LISTED';
    case 'waiting': return 'WAITING FOR RATE LIMIT';
    case 'connection-failed': return 'CARD LOOKUP FAILED';
  }
}

export default function Outreach() {
  const settings = useGetA2aSettings();
  const registry = useGetA2aRegistryAgents({
    query: {
      queryKey: getGetA2aRegistryAgentsQueryKey(),
      refetchInterval: 60_000,
    },
  });
  const discoverMutation = useDiscoverA2aAgent();
  const pingMutation = usePingA2aAgent();
  const [url, setUrl] = useState('');
  const [agent, setAgent] = useState<A2aAgentCard | null>(null);
  const [pingResult, setPingResult] = useState<A2aAgentPing | null>(null);

  const outreachEnabled = settings.data?.outreachEnabled === true;
  const settingsReady = !settings.isLoading && !settings.isError;
  const canContact = settingsReady && outreachEnabled && !!agent;

  const submitDiscovery = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!outreachEnabled || !url.trim() || discoverMutation.isPending) return;
    setAgent(null);
    setPingResult(null);
    discoverMutation.mutate({ data: { url: url.trim() } }, {
      onSuccess: card => {
        setAgent(card);
        setUrl(card.url);
      },
    });
  };

  const pingAgent = () => {
    if (!canContact || !agent || pingMutation.isPending) return;
    setPingResult(null);
    pingMutation.mutate({ data: { agentUrl: agent.url } }, {
      onSuccess: result => setPingResult(result),
    });
  };

  return <div className="outreach-page">
    <style>{`
      .outreach-page{--outreach-ink:#263f34;--outreach-muted:#78867c;--outreach-line:#e4e1d6;--outreach-card:#fbfaf4;--outreach-wash:#f1f0e7;color:var(--outreach-ink)}
      .outreach-page *{box-sizing:border-box}
      .outreach-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:25px}
      .outreach-heading h1{max-width:680px}
      .outreach-heading .page-subtitle{max-width:610px}
      .outreach-intro-mark{width:43px;height:43px;border-radius:13px;background:#e8ede4;color:#45684f;display:grid;place-items:center;flex:0 0 auto}
      .outreach-heading-side{display:flex;align-items:center;gap:11px;padding:10px 13px;border:1px solid #e3e2d7;border-radius:9px;background:#f9f8f1;color:#69796e;font:10px var(--app-font-mono);letter-spacing:.04em;white-space:nowrap}
      .outreach-heading-side svg{color:#71866f}
      .outreach-gate{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;margin-bottom:18px;border:1px solid #e6dcb9;border-radius:9px;background:#f7f1df;color:#6e6548;font-size:11px;line-height:1.6}
      .outreach-gate strong{color:#514b34}
      .outreach-gate a{color:#385d46;font-weight:800;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}
      .outreach-gate-error{border-color:#e7cbc3;background:#f7eae5;color:#8a5146}
      .outreach-grid{display:grid;grid-template-columns:minmax(0,1.02fr) minmax(340px,.98fr);gap:15px;align-items:start}
      .outreach-panel{overflow:hidden}
      .outreach-panel-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:17px 19px;border-bottom:1px solid #ebe8dd}
      .outreach-panel-title{font-size:13px;font-weight:800;letter-spacing:-.02em}
      .outreach-panel-kicker{color:#8a968d;font:9px var(--app-font-mono);letter-spacing:.1em;text-transform:uppercase;margin-top:5px}
      .outreach-number{color:#8b978e;font:10px var(--app-font-mono)}
      .outreach-panel-body{padding:19px}
      .outreach-form{display:flex;gap:8px}
      .outreach-input,.outreach-textarea{width:100%;border:1px solid #dcd9cd;background:#fffef9;border-radius:7px;color:#263e33;padding:11px 12px;outline:none;font-size:12px;transition:border-color .15s,box-shadow .15s}
      .outreach-input:focus-visible,.outreach-textarea:focus-visible{border-color:#79967d;box-shadow:0 0 0 3px rgba(104,143,111,.14)}
      .outreach-input:disabled,.outreach-textarea:disabled{opacity:.58;cursor:not-allowed}
      .outreach-input{min-width:0}
      .outreach-btn{min-height:40px;white-space:nowrap}
      .outreach-help{font-size:10px;color:#89948c;line-height:1.55;margin:9px 0 0}
      .outreach-form-error{margin-top:12px;padding:10px 11px;border:1px solid #e6cbc3;border-radius:7px;background:#f7eae5;color:#8e4d42;font-size:11px;line-height:1.5}
      .outreach-agent{margin-top:15px;border:1px solid #dfe5d9;border-radius:9px;background:linear-gradient(120deg,#f5f6ed,#fbfaf4 65%);overflow:hidden}
      .outreach-agent-top{display:flex;gap:13px;padding:17px 17px 14px}
      .outreach-agent-icon{width:40px;height:40px;display:grid;place-items:center;flex:0 0 auto;border-radius:11px;background:#315545;color:#f4e4a9}
      .outreach-agent-name{margin:1px 0 5px;font-size:16px;font-weight:800;letter-spacing:-.04em;overflow-wrap:anywhere}
      .outreach-agent-url{display:flex;align-items:center;gap:5px;color:#849087;font:9px var(--app-font-mono);overflow-wrap:anywhere}
      .outreach-agent-desc{padding:0 17px 15px 70px;color:#6e7b71;font-size:11px;line-height:1.65;white-space:pre-wrap}
      .outreach-agent-meta{display:flex;flex-wrap:wrap;gap:7px;padding:0 17px 15px 70px}
      .outreach-meta-chip{padding:5px 8px;border:1px solid #e1e4d9;border-radius:20px;color:#718075;background:#f9f9f3;font:9px var(--app-font-mono)}
      .outreach-skills{padding:13px 17px 16px;border-top:1px solid #e7e9df}
      .outreach-skills-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;color:#829087;font:9px var(--app-font-mono);letter-spacing:.09em;text-transform:uppercase}
      .outreach-skill{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:10px 0;border-top:1px solid #efefe7}
      .outreach-skill:first-of-type{border-top:0}
      .outreach-skill-name{font-size:11px;font-weight:800}
      .outreach-skill-id{color:#9aa39b;font:9px var(--app-font-mono);margin-top:4px;overflow-wrap:anywhere}
      .outreach-skill-desc{margin-top:5px;color:#78847b;font-size:10px;line-height:1.55}
      .outreach-tags{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;align-content:start}
      .outreach-tag{background:#e9eee5;color:#637661;padding:4px 6px;border-radius:4px;font:8px var(--app-font-mono)}
      .outreach-empty{min-height:212px;display:grid;place-items:center;padding:28px 18px;text-align:center;color:#879288}
      .outreach-empty-icon{width:44px;height:44px;margin:0 auto 12px;border-radius:14px;background:#eff0e8;color:#899788;display:grid;place-items:center}
      .outreach-empty strong{display:block;color:#596c60;font-size:12px;margin-bottom:6px}
      .outreach-empty p{max-width:255px;margin:0 auto;font-size:10px;line-height:1.6}
      .outreach-skeleton{height:12px;border-radius:5px;background:linear-gradient(90deg,#e9e7de,#f4f2ea,#e9e7de);background-size:200% 100%;animation:outreach-shimmer 1.5s infinite}
      @keyframes outreach-shimmer{to{background-position:-200% 0}}
      .outreach-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}
      .outreach-action-btn{width:100%;min-height:42px}
      .outreach-action-note{display:flex;gap:8px;align-items:flex-start;color:#89948b;font-size:10px;line-height:1.55;margin-top:11px}
      .outreach-action-note svg{flex:0 0 auto;color:#819180}
      .outreach-divider{height:1px;background:#ebe8dd;margin:18px 0}
      .outreach-label{display:block;margin:0 0 8px;color:#64746a;font:9px var(--app-font-mono);letter-spacing:.09em;text-transform:uppercase}
      .outreach-textarea{min-height:118px;resize:vertical;line-height:1.6}
      .outreach-task-footer{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px}
      .outreach-count{color:#98a096;font:9px var(--app-font-mono)}
      .outreach-result{margin-top:14px;border:1px solid #e3e5db;border-radius:8px;background:#f7f7f0;overflow:hidden}
      .outreach-result-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px;border-bottom:1px solid #e8e9e0}
      .outreach-result-label{display:flex;align-items:center;gap:7px;color:#58705d;font:9px var(--app-font-mono);letter-spacing:.06em;text-transform:uppercase}
      .outreach-result-time{color:#909b91;font:9px var(--app-font-mono);text-align:right}
      .outreach-result-copy{padding:13px;color:#596b60;font-size:11px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
      .outreach-status-success{color:#4f7b54}.outreach-status-working{color:#877342}.outreach-status-caution{color:#a15a4d}
      .outreach-loading{display:flex;align-items:center;gap:8px;margin-top:12px;color:#748278;font-size:10px}
      .outreach-spin{animation:outreach-spin 1s linear infinite}
      @keyframes outreach-spin{to{transform:rotate(360deg)}}
      .outreach-bottom-note{display:flex;gap:10px;align-items:flex-start;margin-top:15px;padding:13px 15px;border:1px solid #e4e1d6;border-radius:8px;background:#f7f6ef;color:#79857b;font-size:10px;line-height:1.6}
      .outreach-bottom-note svg{flex:0 0 auto;color:#788b75}
      .outreach-bottom-note strong{color:#546b59}
      @media(max-width:850px){.outreach-grid{grid-template-columns:1fr}.outreach-heading-side{align-self:flex-start}}
      @media(max-width:650px){.outreach-heading{align-items:flex-start;flex-direction:column}.outreach-heading-side{white-space:normal}.outreach-panel-body{padding:15px}.outreach-form{flex-direction:column}.outreach-form .outreach-btn{width:100%}.outreach-actions{grid-template-columns:1fr}.outreach-agent-desc,.outreach-agent-meta{padding-left:17px}.outreach-agent-desc{padding-top:0}.outreach-task-footer{align-items:flex-start;flex-direction:column}.outreach-task-footer .outreach-btn{width:100%}.outreach-result-head{align-items:flex-start;flex-direction:column}.outreach-result-time{text-align:left}}
    `}</style>

    <div className="page-heading outreach-heading">
      <div>
        <div className="eyebrow">EXTERNAL AGENTS / OUTBOUND</div>
        <h1>Choose who gets the next brief.</h1>
        <p className="page-subtitle">Inspect a registry-verified agent with explicit outreach opt-in, then make a deliberate connectivity check. External task delegation stays paused until a verified upfront payment can be tied to the task.</p>
      </div>
      <div className="outreach-heading-side"><Fingerprint size={17} /> OWNER-INITIATED · BOUNDED</div>
    </div>

    {settings.isLoading && <div className="outreach-gate" role="status"><LoaderCircle className="outreach-spin" size={16} /><span>Checking the workspace outreach control. Contact actions remain unavailable until its state is confirmed.</span></div>}
    {settings.isError && <div className="outreach-gate outreach-gate-error" role="alert"><CircleAlert size={16} /><span>Outreach controls could not be read, so external requests are blocked for now. <button className="secondary-btn" type="button" onClick={() => void settings.refetch()} style={{ marginLeft: 8, padding: '6px 9px' }}>Retry controls</button></span></div>}
    {settings.data && !outreachEnabled && <div className="outreach-gate" role="status">
      <LockKeyhole size={16} />
      <span><strong>Outbound outreach is off.</strong> Discovery, ping, and delegation are disabled until you enable it in <Link href="/settings">Controls <ArrowUpRight size={11} /></Link>.</span>
    </div>}
    {settings.data && outreachEnabled && <div className="outreach-gate" role="status" style={{ borderColor: '#dfe6d8', background: '#f0f3e9', color: '#637564' }}>
      <ShieldCheck size={16} />
      <span><strong>Outreach is enabled.</strong> Each request below is sent only when you choose an action. Review the returned card and response before proceeding.</span>
    </div>}

    <div className="outreach-grid">
      <section className="panel outreach-panel" aria-labelledby="discover-heading">
        <div className="outreach-panel-head">
          <div><div className="outreach-panel-title" id="discover-heading">Discover an agent</div><div className="outreach-panel-kicker">A2A agent card lookup</div></div>
          <span className="outreach-number">01 / INSPECT</span>
        </div>
        <div className="outreach-panel-body">
          <form className="outreach-form" onSubmit={submitDiscovery}>
            <label className="sr-only" htmlFor="outreach-agent-url">Agent endpoint URL</label>
            <input
              id="outreach-agent-url"
              className="outreach-input"
              type="url"
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="https://agent.example/.well-known/agent.json"
              autoComplete="url"
              required
              disabled={!outreachEnabled || settings.isLoading || settings.isError || discoverMutation.isPending}
              aria-describedby="outreach-url-help"
              data-testid="input-agent-url"
            />
            <button className="primary-btn outreach-btn" type="submit" disabled={!outreachEnabled || settings.isLoading || settings.isError || !url.trim() || discoverMutation.isPending} data-testid="button-discover-agent">
              {discoverMutation.isPending ? <><LoaderCircle size={14} className="outreach-spin" /> Looking up</> : <><Compass size={14} /> Discover</>}
            </button>
          </form>
          <p className="outreach-help" id="outreach-url-help">The URL must match a registry-verified agent that explicitly opted in. Discovery requests its card; it does not send a task.</p>
          {discoverMutation.isError && <div className="outreach-form-error" role="alert" data-testid="error-agent-discovery">{errorText(discoverMutation.error, 'The agent card could not be retrieved. Check the URL and try again.')}</div>}
          {discoverMutation.isPending && <div className="outreach-agent" aria-label="Discovering agent"><div className="outreach-panel-body" style={{ display: 'grid', gap: 11 }}><div className="outreach-skeleton" style={{ width: '44%', height: 16 }} /><div className="outreach-skeleton" /><div className="outreach-skeleton" style={{ width: '78%' }} /><div className="outreach-skeleton" style={{ width: '63%', height: 32, marginTop: 8 }} /></div></div>}
          {!discoverMutation.isPending && agent && <article className="outreach-agent" aria-label={`Discovered agent: ${agent.name}`} data-testid="card-discovered-agent">
            <div className="outreach-agent-top">
              <div className="outreach-agent-icon"><Bot size={19} /></div>
              <div style={{ minWidth: 0 }}>
                <div className="outreach-agent-name" data-testid="text-agent-name">{agent.name}</div>
                <div className="outreach-agent-url"><Globe2 size={11} /><span>{agent.url}</span></div>
              </div>
            </div>
            <div className="outreach-agent-desc">{agent.description || 'No description was included in this agent card.'}</div>
            <div className="outreach-agent-meta">
              {agent.version && <span className="outreach-meta-chip">VERSION {agent.version}</span>}
              <span className="outreach-meta-chip">{agent.skills?.length ?? 0} SKILLS</span>
              <span className="outreach-meta-chip">CARD RECEIVED</span>
            </div>
            <div className="outreach-skills">
              <div className="outreach-skills-head"><span>Published skills</span><span>{agent.skills?.length ?? 0}</span></div>
              {(agent.skills ?? []).length === 0
                ? <div className="outreach-help">No skills were listed in the returned card.</div>
                : agent.skills.map(skill => <div className="outreach-skill" key={skill.id} data-testid={`row-agent-skill-${skill.id}`}>
                  <div><div className="outreach-skill-name">{skill.name}</div><div className="outreach-skill-id">{skill.id}</div><div className="outreach-skill-desc">{skill.description}</div></div>
                  <div className="outreach-tags">{skill.tags?.map(tag => <span key={tag} className="outreach-tag">{tag}</span>)}</div>
                </div>)}
            </div>
          </article>}
          {!discoverMutation.isPending && !agent && !discoverMutation.isError && <div className="outreach-empty">
            <div><div className="outreach-empty-icon"><Globe2 size={19} /></div><strong>No agent selected</strong><p>Enter an endpoint above to retrieve its card. The returned details stay here while you decide what to do next.</p></div>
          </div>}
        </div>
      </section>

      <section className="panel outreach-panel" aria-labelledby="contact-heading">
        <div className="outreach-panel-head">
          <div><div className="outreach-panel-title" id="contact-heading">Contact with intent</div><div className="outreach-panel-kicker">{agent ? `Selected · ${agent.name}` : 'Select an agent card first'}</div></div>
          <span className="outreach-number">02 / ACT</span>
        </div>
        <div className="outreach-panel-body">
          {!agent ? <div className="outreach-empty">
            <div><div className="outreach-empty-icon"><Target size={19} /></div><strong>Waiting for an agent card</strong><p>After discovery, the selected agent’s endpoint will be used for your ping or task.</p></div>
          </div> : <>
            <div className="outreach-actions">
              <button className="secondary-btn outreach-action-btn" type="button" onClick={pingAgent} disabled={!canContact || pingMutation.isPending} aria-label={`Ping ${agent.name}`} data-testid="button-ping-agent">
                {pingMutation.isPending ? <><LoaderCircle size={14} className="outreach-spin" /> Checking response</> : <><Radio size={14} /> Ping agent</>}
              </button>
              <button className="secondary-btn outreach-action-btn" type="button" disabled aria-label="External task delegation is paused">
                <LockKeyhole size={14} /> Task delegation paused
              </button>
            </div>
            <div className="outreach-action-note"><ShieldCheck size={14} /><span>Ping asks for a connectivity response only. No task is included.</span></div>
            {pingMutation.isError && <div className="outreach-form-error" role="alert" data-testid="error-agent-ping">{errorText(pingMutation.error, 'The agent did not return a ping response. You can retry.')}</div>}
            {pingResult && <div className="outreach-result" aria-live="polite" data-testid="result-agent-ping">
              <div className="outreach-result-head"><div className="outreach-result-label"><Check size={13} /> Ping · {pingResult.status}</div><div className="outreach-result-time">{dateLabel(pingResult.completedAt)}</div></div>
              <div className="outreach-result-copy"><strong>{pingResult.agentName}</strong><br />{pingResult.response || 'The agent responded without a message.'}</div>
            </div>}

            <div className="outreach-divider" />
            <div className="outreach-action-note" style={{ marginTop: 13 }}><LockKeyhole size={14} /><span>No task is sent to an external agent until the system can bind a verified upfront Whop payment to the task and define the settlement terms. Connectivity pings remain separate and owner-initiated.</span></div>
          </>}
        </div>
      </section>
    </div>

    <section className="panel outreach-panel" aria-labelledby="registry-heading" style={{ marginTop: 16 }}>
      <div className="outreach-panel-head">
        <div>
          <div className="outreach-panel-title" id="registry-heading">Worldwide public agent registry</div>
          <div className="outreach-panel-kicker">Read-only directory · no region filter · refreshes automatically</div>
        </div>
        <button
          className="secondary-btn"
          type="button"
          onClick={() => void registry.refetch()}
          disabled={registry.isFetching}
          data-testid="button-refresh-registry"
        >
          {registry.isFetching ? <><LoaderCircle size={13} className="outreach-spin" /> Loading</> : <><Globe2 size={13} /> Refresh view</>}
        </button>
      </div>
      <div className="outreach-panel-body">
        {registry.isError && <div className="outreach-form-error" role="alert" data-testid="error-global-registry">
          {errorText(registry.error, 'The global registry feed could not be loaded.')}
        </div>}
        {registry.isLoading ? <div className="outreach-loading" role="status"><LoaderCircle size={13} className="outreach-spin" /> Loading the registry snapshot…</div> : registry.data && <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <span className="outreach-meta-chip" data-testid="status-registry-feed">{registry.data.status.toUpperCase()}</span>
            <span className="outreach-meta-chip" data-testid="count-registry-total">{registry.data.totalListings} GLOBAL LISTINGS</span>
            <span className="outreach-meta-chip" data-testid="count-registry-verified">{registry.data.verifiedListings} REGISTRY-VERIFIED LISTINGS</span>
            <span className="outreach-meta-chip" data-testid="count-registry-opt-in">{registry.data.eligibleListings} EXPLICITLY OPTED IN</span>
            <span className="outreach-meta-chip" data-testid="count-registry-connected">{registry.data.connectedListings} CARDS CONNECTED</span>
            <span className="outreach-meta-chip" data-testid="text-registry-last-check">LAST CHECK · {dateLabel(registry.data.lastSyncedAt ?? undefined)}</span>
          </div>
          {registry.data.error && <div className="outreach-gate outreach-gate-error" role="status"><CircleAlert size={15} /><span>{registry.data.error}</span></div>}
          {registry.data.agents.length === 0 ? <div className="outreach-empty" style={{ minHeight: 150 }}>
            <div><div className="outreach-empty-icon"><Globe2 size={19} /></div><strong>No verified listings available</strong><p>Unverified listings are excluded. Agent cards are fetched only when a verified listing explicitly opts in to outreach.</p></div>
          </div> : <div style={{ display: 'grid', gap: 9 }}>
            {registry.data.agents.map(agent => <article
              className="outreach-agent"
              key={agent.registryId}
              data-testid={`card-registry-agent-${agent.registryId}`}
              style={{ marginTop: 0 }}
            >
              <div className="outreach-agent-top">
                <div className="outreach-agent-icon"><Bot size={18} /></div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="outreach-agent-name">{agent.name}</div>
                  <div className="outreach-agent-url"><Globe2 size={11} /><span>{agent.agentUrl ?? 'No public HTTPS agent card URL'}</span></div>
                </div>
                <span className="outreach-meta-chip">{registryConnectionLabel(agent)}</span>
              </div>
              {agent.description && <div className="outreach-agent-desc">{agent.description}</div>}
              <div className="outreach-agent-meta">
                <span className="outreach-meta-chip">REGISTRY VERIFIED</span>
                <span className="outreach-meta-chip">{agent.outreachOptIn ? 'OUTREACH OPT-IN · YES' : 'OUTREACH OPT-IN · NOT PROVIDED'}</span>
                {agent.lastCheckedAt && <span className="outreach-meta-chip">CARD CHECK · {dateLabel(agent.lastCheckedAt)}</span>}
              </div>
              {agent.connectionError && <div className="outreach-form-error" style={{ margin: '0 17px 14px' }}>{agent.connectionError}</div>}
              {agent.skills.length > 0 && <div className="outreach-skills">
                <div className="outreach-skills-head"><span>Read-only card skills</span><span>{agent.skills.length}</span></div>
                {agent.skills.map(skill => <div className="outreach-skill" key={`${agent.registryId}-${skill.id}`}>
                  <div><div className="outreach-skill-name">{skill.name}</div><div className="outreach-skill-desc">{skill.description}</div></div>
                  <div className="outreach-tags">{skill.tags?.map(tag => <span key={tag} className="outreach-tag">{tag}</span>)}</div>
                </div>)}
              </div>}
            </article>)}
          </div>}
          <div className="outreach-bottom-note" style={{ marginTop: 13 }}>
            <ShieldCheck size={15} />
            <span><strong>Read-only boundary.</strong> The feed never sends A2A messages, accepts or executes tasks, or changes the internal ledger. Unverified listings are not shown. A card is fetched only for a verified listing with a positive explicit outreach opt-in flag. Wallet setup and real withdrawals remain disabled.</span>
          </div>
        </>}
      </div>
    </section>

    <div className="outreach-bottom-note"><ShieldCheck size={15} /><span><strong>Contact boundary.</strong> The global feed reads registry listings and only fetches cards for verified, opted-in agents. Connectivity pings require the owner’s action. External task delegation is disabled until upfront payment and settlement can be verified.</span></div>
  </div>;
}
