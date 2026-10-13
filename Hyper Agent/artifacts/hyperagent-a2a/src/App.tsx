import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { useForm } from 'react-hook-form';
import {
  Activity, ArrowDownLeft, ArrowUpRight, Bot, Boxes, BriefcaseBusiness, Check, ChevronRight,
  CircleHelp, Coins, Command, Gauge, Handshake, LockKeyhole, LogOut, Radio, RefreshCw, Send,
  Settings2, ShieldCheck, Sparkles, Zap,
} from 'lucide-react';
import {
  getGetA2aDashboardQueryKey, getGetA2aSettingsQueryKey, getHealthCheckQueryKey,
  getA2aAuthSession, loginA2aOwner, logoutA2aOwner,
  getListA2aActivityQueryKey, getListA2aServicesQueryKey, useCreateA2aQuote,
  useExecuteA2aTask, useGetA2aDashboard,
  useGetA2aSettings, useHealthCheck, useListA2aActivity, useListA2aServices,
  useUpdateA2aSettings, setAuthTokenGetter,
} from '@workspace/api-client-react';
import type { A2aQuote } from '@workspace/api-client-react';
import Outreach from '@/pages/outreach';
import { Form, FormControl, FormField, FormItem } from '@/components/ui/form';
import NotFound from '@/pages/not-found';

const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });
let ownerAccessToken: string | null = null;
setAuthTokenGetter(() => ownerAccessToken);

function setOwnerAccessToken(token: string | null) {
  ownerAccessToken = token;
}

const navItems = [
  { href: '/', label: 'Overview', icon: Gauge },
  { href: '/services', label: 'Capabilities', icon: Boxes },
  { href: '/tasks', label: 'Task desk', icon: BriefcaseBusiness },
  { href: '/outreach', label: 'Outbound A2A', icon: Radio },
  { href: '/settings', label: 'Controls', icon: Settings2 },
];

function money(amount?: number | null) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(amount ?? 0);
}
function when(date?: string) {
  if (!date) return '—';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function useNotice() {
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 3800);
    return () => window.clearTimeout(id);
  }, [notice]);
  return { notice, show: (text: string, error = false) => setNotice({ text, error }) };
}
function Notice({ value }: { value: { text: string; error?: boolean } | null }) {
  return value ? <div className={`toast-line${value.error ? ' error' : ''}`} role="status" data-testid="status-toast">{value.text}</div> : null;
}
function Shell({ children, username, onLogout, logoutError }: {
  children: ReactNode;
  username: string;
  onLogout: () => void;
  logoutError: string | null;
}) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 45000 } });
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Command size={19} strokeWidth={2.5} /></div><div><div className="brand-name">HyperAgent</div><div className="brand-sub">A2A / operator</div></div></div>
      <div className="side-label">WORKSPACE</div>
      <nav className="nav" aria-label="Primary navigation">
        {navItems.map(item => <Link key={item.href} href={item.href} className={`nav-link${location === item.href ? ' active' : ''}`} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><item.icon size={16} /><span>{item.label}</span></Link>)}
      </nav>
      <div className="side-bottom">
        <div className="side-label">TRUST BOUNDARY</div>
         <div className="trust-card"><div className="trust-top"><ShieldCheck size={14} /> Owner-gated workspace</div><p>Private routes require an owner session. Outbound A2A requests are available only when enabled in Controls and are sent to the agent you select. Withdrawals are disabled; verified Whop receipts stay in the internal ledger.</p></div>
         <div className="owner"><div className="owner-avatar">{username.split(/\s+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase()}</div><div><div className="owner-name">{username}</div><div className="owner-meta">OWNER SIGNED IN</div></div></div>
      </div>
    </aside>
    <div className="main-area">
      <header className="topbar"><div className="crumb">HyperAgent <span style={{ padding: '0 8px', color: '#b5b8aa' }}>/</span><strong>{navItems.find(item => item.href === location)?.label ?? 'Workspace'}</strong></div><div className="top-meta"><span className="top-live"><i className="live-dot" />{health?.status ? 'API CONNECTED' : 'CHECKING API'}</span><span>MODE · SANDBOX</span><button className="signout-button" onClick={onLogout} data-testid="button-sign-out"><LogOut size={14} /> Sign out</button></div></header>
      <main className="main-content">{children}</main>
      {logoutError && <div className="auth-inline-error" role="alert">{logoutError}</div>}
    </div>
    <nav className="mobile-nav" aria-label="Mobile navigation">{navItems.map(item => <Link key={item.href} href={item.href} className={location === item.href ? 'active' : ''} data-testid={`mobile-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><item.icon size={17} /><span>{item.label}</span></Link>)}</nav>
  </div>;
}
function Heading({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="page-subtitle">{subtitle}</p></div>{action}</div>;
}
function LoadingPanel({ rows = 4 }: { rows?: number }) {
  return <div className="panel panel-body" aria-label="Loading"><div style={{ display: 'grid', gap: 15 }}>{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${92 - (i % 3) * 13}%` }} />)}</div></div>;
}
function QueryError({ label, retry }: { label: string; retry: () => void }) {
  return <div className="alert" role="alert" data-testid="status-query-error"><span>{label} could not be loaded. The service may be unavailable.</span><button className="secondary-btn" onClick={retry} data-testid="button-retry"><RefreshCw size={14} /> Retry</button></div>;
}

type OwnerAuthState =
  | { status: 'checking' }
  | { status: 'unavailable' }
  | { status: 'signed-out'; configured: boolean }
  | { status: 'authenticated'; username: string };

function authErrorMessage(error: unknown, fallback: string) {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
    return data.error;
  }
  return fallback;
}

function OwnerLogin({ configured, onAuthenticated }: {
  configured: boolean;
  onAuthenticated: (username: string, accessToken: string) => void;
}) {
  const [username, setUsername] = useState('owner');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!configured || pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await loginA2aOwner(
        { username: username.trim(), password },
        { credentials: 'same-origin', cache: 'no-store' },
      );
      setPassword('');
      onAuthenticated(result.username, result.accessToken);
    } catch (loginError) {
      setError(authErrorMessage(loginError, 'Sign-in failed. Check your credentials and try again.'));
    } finally {
      setPending(false);
    }
  };

  return <main className="owner-auth-screen">
    <section className="owner-auth-card" aria-labelledby="owner-auth-title">
      <div className="owner-auth-brand"><div className="brand-mark"><Command size={19} strokeWidth={2.5} /></div><span>HyperAgent <small>A2A / operator</small></span></div>
      <div className="owner-auth-eyebrow"><LockKeyhole size={13} /> PRIVATE OWNER CONSOLE</div>
      <h1 id="owner-auth-title">Sign in to HyperAgent.</h1>
      <p className="owner-auth-copy">Owner authentication protects the dashboard, task desk, settings, and every A2A API route.</p>
      {!configured && <div className="owner-auth-setup" role="status"><ShieldCheck size={16} /><span>Owner sign-in is not configured. Set <strong>A2A_OWNER_PASSWORD</strong> in Replit Secrets to enable sign-in.</span></div>}
      {error && <div className="owner-auth-error" role="alert">{error}</div>}
      <form onSubmit={submit} className="owner-auth-form">
        <label htmlFor="owner-username">Username</label>
        <input id="owner-username" className="owner-auth-input" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={128} value={username} onChange={event => setUsername(event.target.value)} required />
        <label htmlFor="owner-password">Password</label>
        <input id="owner-password" className="owner-auth-input" name="password" type="password" autoComplete="current-password" maxLength={256} value={password} onChange={event => setPassword(event.target.value)} required />
        <button className="primary-btn owner-auth-submit" type="submit" disabled={!configured || pending || !username.trim() || !password} data-testid="button-owner-sign-in">
          {pending ? <><RefreshCw size={14} className="owner-auth-spin" /> Signing in…</> : <><LockKeyhole size={14} /> Sign in securely</>}
        </button>
      </form>
      <div className="owner-auth-foot"><ShieldCheck size={14} /> Owner token stays in this tab only · Expires after 8 hours</div>
    </section>
  </main>;
}

function OwnerAuthMessage({ title, description, onRetry }: {
  title: string;
  description: string;
  onRetry?: () => void;
}) {
  return <main className="owner-auth-screen">
    <section className="owner-auth-card owner-auth-status-card">
      <div className="owner-auth-brand"><div className="brand-mark"><Command size={19} strokeWidth={2.5} /></div><span>HyperAgent <small>A2A / operator</small></span></div>
      <div className="owner-auth-eyebrow"><LockKeyhole size={13} /> PRIVATE OWNER CONSOLE</div>
      <h1>{title}</h1>
      <p className="owner-auth-copy">{description}</p>
      {onRetry && <button className="secondary-btn owner-auth-retry" onClick={onRetry} data-testid="button-retry-auth"><RefreshCw size={14} /> Try again</button>}
    </section>
  </main>;
}

function Overview() {
  const dashboard = useGetA2aDashboard({ query: { queryKey: getGetA2aDashboardQueryKey(), refetchInterval: 30000 } });
  const activity = useListA2aActivity({ query: { queryKey: getListA2aActivityQueryKey() } });
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 45000 } });
  const d = dashboard.data;
  const events = activity.data ?? [];
  return <div>
    <Heading eyebrow="OPERATOR CONSOLE / 01" title="Good work starts with visibility." subtitle="Track local task runs, owner-approved A2A requests, and verified Whop receipts." action={<span className="safe-badge"><ShieldCheck size={13} /> SANDBOX TASK EXECUTION</span>} />
    {(dashboard.isError || activity.isError || health.isError) && <QueryError label="Workspace status" retry={() => { void dashboard.refetch(); void activity.refetch(); void health.refetch(); }} />}
    <div className="stats-grid">
       <div className="panel stat-card"><div className="stat-label"><Coins size={13} /> Available verified balance</div><div className="stat-value" data-testid="value-virtual-earnings">{dashboard.isLoading ? '—' : money(d?.availableBalance)}</div><div className="stat-note">Whop receipts {money(d?.totalEarned)} · net balance is reduced by refunds</div><ArrowUpRight className="stat-accent" size={16} /></div>
      <div className="panel stat-card"><div className="stat-label"><Check size={13} /> Tasks completed</div><div className="stat-value" data-testid="value-completed-count">{dashboard.isLoading ? '—' : d?.completedCount ?? 0}</div><div className="stat-note">Recorded sandbox runs</div><Activity className="stat-accent" size={16} /></div>
      <div className="panel stat-card"><div className="stat-label"><Handshake size={13} /> Active quotes</div><div className="stat-value" data-testid="value-active-quotes">{dashboard.isLoading ? '—' : d?.activeQuotes ?? 0}</div><div className="stat-note">Awaiting owner review</div><CircleHelp className="stat-accent" size={16} /></div>
      <div className="panel stat-card"><div className="stat-label"><Zap size={13} /> Agent status</div><div className="stat-value" style={{ fontSize: 19, marginTop: 21 }} data-testid="status-agent">{dashboard.isLoading ? 'Loading' : d?.status ?? 'Unavailable'}</div><div className="stat-note">Mode: {d?.mode ?? '—'}</div><span className="stat-accent"><i className="status-dot" /></span></div>
    </div>
    <div className="dashboard-grid">
      <section className="panel">
        <div className="panel-head"><div><div className="panel-title">Recent activity</div><div className="panel-kicker">Latest changes across your task desk</div></div><span className="pill">ACTIVITY LOG</span></div>
        <div className="panel-body">
          {activity.isLoading ? <div style={{ display: 'grid', gap: 15 }}><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> :
              events.length === 0 ? <div className="quote-empty"><div className="empty-mark"><Activity size={19} /></div><strong>No activity yet</strong><p>Local task activity and verified Whop payment changes will appear here.</p></div> :
              events.slice(0, 6).map(item => <div className="activity-row" key={item.id} data-testid={`row-activity-${item.id}`}><div className="activity-icon">{item.type.toLowerCase().includes('earning') ? <ArrowDownLeft size={15} /> : <Bot size={15} />}</div><div><div className="activity-title" data-testid={`text-activity-title-${item.id}`}>{item.title}</div><div className="activity-detail">{item.detail}</div></div><div><div className="activity-date">{when(item.createdAt)}</div>{item.amount != null && <div className="activity-amount">{money(item.amount)}</div>}</div></div>)}
        </div>
      </section>
      <section className="panel runtime-panel">
        <div className="panel-head"><div><div className="panel-title">Runtime telemetry</div><div className="panel-kicker">Agent / environment / heartbeat</div></div><Activity size={17} /></div>
        <div className="panel-body">
          <div className="runtime-label">Inference provider</div><div className="runtime-value" data-testid="value-ai-provider">{dashboard.isLoading ? 'Loading' : d?.aiProvider ?? 'Unavailable'}</div>
          <div className="runtime-divider" />
          <div className="runtime-label">Last heartbeat</div><div className="runtime-value" style={{ fontSize: 15 }} data-testid="value-heartbeat">{dashboard.isLoading ? '—' : when(d?.lastHeartbeat)}</div>
          <div className="runtime-label">Service health</div><div className="runtime-value" style={{ fontSize: 15 }} data-testid="status-api-health">{health.isLoading ? 'Checking…' : health.data?.status ?? 'Unavailable'}</div>
           <div className="runtime-note">Local task execution remains sandboxed. Whop sync credits only paid, succeeded USD receipts net of provider fees; refunds reduce the internal balance. Payout details are not collected.</div>
        </div>
      </section>
    </div>
    <div className="section-label">Operator shortcuts</div>
    <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
      <Link href="/tasks" className="secondary-btn" data-testid="link-start-task"><Send size={14} /> Prepare a task <ChevronRight size={13} /></Link>
      <Link href="/services" className="secondary-btn" data-testid="link-view-services"><Boxes size={14} /> Browse capabilities <ChevronRight size={13} /></Link>
      <Link href="/settings" className="secondary-btn" data-testid="link-open-controls"><LockKeyhole size={14} /> Review controls <ChevronRight size={13} /></Link>
    </div>
  </div>;
}

function Services() {
  const services = useListA2aServices({ query: { queryKey: getListA2aServicesQueryKey() } });
  return <div>
    <Heading eyebrow="CAPABILITY REGISTRY / 02" title="What this agent can take on." subtitle="Service definitions and starting rates returned by the workspace API. Availability does not imply external registry reach." />
    {services.isError && <QueryError label="Capabilities" retry={() => void services.refetch()} />}
    <div className="panel" style={{ padding: '15px 19px', marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', color: '#6c796f', fontSize: 11, lineHeight: 1.6 }}><ShieldCheck size={17} color="#587c5b" /> These are local capability listings. External agents are contacted only from Outbound A2A after you enable outreach and select an endpoint.</div>
    <div className="section-label" style={{ marginTop: 0 }}>Published capability set · {services.data?.length ?? (services.isLoading ? '…' : 0)} definitions</div>
    {services.isLoading ? <LoadingPanel rows={5} /> : (services.data?.length ?? 0) === 0 ? <div className="panel quote-empty"><div className="empty-mark"><Boxes size={20} /></div><strong>No capabilities returned</strong><p>The service registry is empty or unavailable. Try reloading the list.</p><button className="secondary-btn" onClick={() => void services.refetch()} data-testid="button-reload-services"><RefreshCw size={14} /> Reload</button></div> :
      <div className="service-list">{services.data?.map(service => <article className="panel service-row" key={service.id} data-testid={`card-service-${service.id}`}><div className="service-icon"><Sparkles size={18} /></div><div><div className="service-name" data-testid={`text-service-name-${service.id}`}>{service.name}</div><div className="service-category">{service.category}</div></div><div className="service-description">{service.description}</div><div className="price">{money(service.startingAmount)} <small>/ {service.unit}</small></div><span className={`pill${service.active ? '' : ' off'}`}>{service.active ? 'ACTIVE' : 'PAUSED'}</span></article>)}</div>}
    <div className="section-label">Pricing note</div><div className="settings-note"><strong>Starting amount is a reference, not an accepted quote.</strong> For every task, HyperAgent returns a quote or counteroffer. Work can execute only after you explicitly accept a positive amount.</div>
  </div>;
}

function Tasks() {
  const cache = useQueryClient();
  const quoteMutation = useCreateA2aQuote();
  const executeMutation = useExecuteA2aTask();
  const taskForm = useForm<{ taskText: string; offeredAmount: string }>({
    defaultValues: { taskText: '', offeredAmount: '5' },
  });
  const taskText = taskForm.watch('taskText');
  const offer = taskForm.watch('offeredAmount');
  const [whopPaymentId, setWhopPaymentId] = useState('');
  const [quote, setQuote] = useState<A2aQuote | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [execution, setExecution] = useState<{ result: string; amount: number; executionMode: string; createdAt: string } | null>(null);
  const notice = useNotice();
  const getError = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Please try again.';
  const requestQuote = (values: { taskText: string; offeredAmount: string }) => {
    setQuote(null); setExecution(null); setAccepted(false);
    setWhopPaymentId('');
    quoteMutation.mutate({ data: { taskText: values.taskText.trim(), offeredAmount: Number(values.offeredAmount) } }, {
      onSuccess: result => { setQuote(result); void cache.invalidateQueries({ queryKey: getGetA2aDashboardQueryKey() }); notice.show('Quote received. Review the proposed amount before accepting.'); },
      onError: error => notice.show(getError(error), true),
    });
  };
  const acceptAndExecute = () => {
    if (!quote || !accepted || quote.proposedAmount <= 0 || !whopPaymentId.trim()) return;
    executeMutation.mutate({ data: { quoteId: quote.id, acceptedAmount: quote.proposedAmount, whopPaymentId: whopPaymentId.trim() } }, {
      onSuccess: result => {
        setExecution(result);
        void cache.invalidateQueries({ queryKey: getGetA2aDashboardQueryKey() });
        void cache.invalidateQueries({ queryKey: getListA2aActivityQueryKey() });
        notice.show('Whop payment verified. The paid task completed in sandbox mode.');
      },
      onError: error => notice.show(getError(error), true),
    });
  };
  return <div>
    <Heading eyebrow="NEGOTIATION DESK / 03" title="Scope it. Price it. You decide." subtitle="Request a quote, accept a positive amount, and provide a verified upfront Whop payment before local execution." />
    <div className="task-layout">
      <Form {...taskForm}><form className="panel form-panel" onSubmit={taskForm.handleSubmit(requestQuote)}>
        <div className="form-title">Describe the work</div><p className="form-description">Be precise about the deliverable, source material, and constraints. The quote endpoint prices the request; it does not execute it.</p>
        <label className="field-label" htmlFor="task-text">Task brief</label>
        <FormField control={taskForm.control} name="taskText" rules={{ required: true, minLength: 1, maxLength: 12000 }} render={({ field }) => <FormItem><FormControl><textarea id="task-text" className="text-area" {...field} maxLength={12000} placeholder="Example: Review these product descriptions for factual inconsistencies. Return a numbered list with the sentence, issue, and suggested correction." data-testid="input-task-brief" /></FormControl></FormItem>} />
        <div style={{ textAlign: 'right', color: '#98a096', font: '10px var(--app-font-mono)', marginTop: 5 }}>{taskText.length.toLocaleString()} / 12,000</div>
        <label className="field-label" htmlFor="offered-amount">Your offered amount</label><div className="input-affix"><span>$</span><FormField control={taskForm.control} name="offeredAmount" rules={{ required: true, min: 0, max: 100000 }} render={({ field }) => <FormItem><FormControl><input id="offered-amount" className="text-input" type="number" min="0" max="100000" step="0.01" {...field} data-testid="input-offered-amount" /></FormControl></FormItem>} /></div>
        <div className="form-footer"><span className="micro-note">Your offer is not a commitment. You can accept only a positive proposed amount after reviewing the quote.</span><button className="primary-btn" type="submit" disabled={quoteMutation.isPending || !taskText.trim()} data-testid="button-request-quote">{quoteMutation.isPending ? <><RefreshCw size={14} /> Pricing request…</> : <><Coins size={14} /> Request a quote</>}</button></div>
        <div className="warning-box"><ShieldCheck size={15} /><span>Tasks still run in the local sandbox, not through external agents. The server requires a paid, succeeded USD Whop payment that covers the quoted amount after fees and refunds. No mock result is credited as earnings.</span></div>
      </form></Form>
      <section className="panel quote-card" aria-live="polite">
        <div className="panel-head" style={{ padding: '0 0 15px' }}><div><div className="panel-title">Quote review</div><div className="panel-kicker">Acceptance + verified payment are required</div></div><Handshake size={17} color="#7d8d80" /></div>
        {quoteMutation.isPending ? <div style={{ paddingTop: 25, display: 'grid', gap: 14 }}><div className="skeleton" /><div className="skeleton" style={{ height: 50 }} /><div className="skeleton" style={{ width: '70%' }} /></div> :
             execution ? <div style={{ paddingTop: 21 }}><div className="quote-status"><i className="status-dot" /> PAID SANDBOX EXECUTION COMPLETE</div><div className="quote-message" data-testid="text-execution-result">{execution.result}</div><div className="quote-details"><div className="quote-detail"><span>Accepted task amount</span><strong data-testid="value-execution-amount">{money(execution.amount)}</strong></div><div className="quote-detail"><span>Execution mode</span><strong data-testid="value-execution-mode">{execution.executionMode}</strong></div></div><div className="runtime-note" style={{ background: '#edf0e7', color: '#64766a' }}>The verified payment is recorded separately in the Whop ledger. This result is still sandbox work, not external-agent execution.</div></div> :
            quote ? <div style={{ paddingTop: 19 }}>
              <div className="quote-status"><i className="status-dot" /> {quote.status.replace('-', ' ')} · REVIEW REQUIRED</div>
              <div className="quote-price" data-testid="value-proposed-amount">{money(quote.proposedAmount)} <small>proposed</small></div>
              <div className="quote-meter"><span style={{ width: `${Math.max(1, Math.min(100, quote.scopePercent))}%` }} /></div><div className="quote-foot"><span>Proposed scope</span><span>{quote.scopePercent}%</span></div>
              <div className="quote-message" data-testid="text-quote-message">{quote.message}</div>
              <div className="quote-details"><div className="quote-detail"><span>Your offer</span><strong>{money(quote.offeredAmount)}</strong></div><div className="quote-detail"><span>Minimum amount</span><strong>{money(quote.minimumAmount)}</strong></div></div>
              {quote.proposedAmount <= 0 && <div className="warning-box"><LockKeyhole size={14} /><span>This quote is zero-priced. A positive amount is required before execution can be enabled.</span></div>}
              <label className="accept-check"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} disabled={quote.proposedAmount <= 0} data-testid="checkbox-accept-quote" /><span>I reviewed this quote and explicitly accept <strong>{money(quote.proposedAmount)}</strong> for sandbox execution.</span></label>
              <label className="field-label" htmlFor="whop-payment-id">Verified upfront Whop payment ID</label>
              <input id="whop-payment-id" className="text-input" type="text" value={whopPaymentId} onChange={event => setWhopPaymentId(event.target.value)} placeholder="Paste the Whop payment ID" maxLength={200} autoComplete="off" data-testid="input-whop-payment-id" />
              <div className="runtime-note" style={{ marginTop: 8, background: '#f2f1e9', color: '#69786d' }}>Only a paid, succeeded USD receipt already synced to the internal ledger is accepted. Sync runs every five minutes; payment is not reserved until the server validates it.</div>
              <div className="quote-actions"><button className="secondary-btn" onClick={() => { setQuote(null); setAccepted(false); setWhopPaymentId(''); }} data-testid="button-dismiss-quote">Decline / clear</button><button className="primary-btn" onClick={acceptAndExecute} disabled={!accepted || quote.proposedAmount <= 0 || !whopPaymentId.trim() || executeMutation.isPending} data-testid="button-accept-execute">{executeMutation.isPending ? 'Verifying payment & executing…' : <><Check size={14} /> Verify payment &amp; execute locally</>}</button></div>
              {executeMutation.isError && <div className="warning-box" role="alert">{getError(executeMutation.error)}</div>}
            </div> :
            <div className="quote-empty"><div className="empty-mark"><Coins size={20} /></div><strong>Nothing has been priced yet</strong><p>Your quote will appear here, with its amount and scope, before any execution can begin.</p></div>}
      </section>
    </div>
    <Notice value={notice.notice} />
  </div>;
}

function Settings() {
  const queryClient = useQueryClient();
  const query = useGetA2aSettings({ query: { queryKey: getGetA2aSettingsQueryKey() } });
  const mutation = useUpdateA2aSettings();
  const notice = useNotice();
  const [outreach, setOutreach] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (query.data && !dirty) setOutreach(query.data.outreachEnabled);
  }, [query.data, dirty]);
  const save = () => mutation.mutate({ data: { outreachEnabled: outreach, payoutsEnabled: false } }, {
    onSuccess: result => { setDirty(false); void queryClient.invalidateQueries({ queryKey: getGetA2aSettingsQueryKey() }); notice.show(result.outreachEnabled ? 'Controls saved. Outbound A2A actions are enabled.' : 'Controls saved. New outbound A2A actions are blocked.'); },
    onError: error => notice.show(error instanceof Error ? error.message : 'Could not save controls.', true),
  });
  const updateOutreach = (value: boolean) => { setOutreach(value); setDirty(true); };
  return <div>
    <Heading eyebrow="OWNER CONTROLS / 04" title="Boundaries before throughput." subtitle="Tune the local control plane. Whop receipt sync is read-only; external A2A actions still require owner approval." action={<span className="safe-badge"><ShieldCheck size={13} /> SAFE MODE LOCKED</span>} />
    {query.isError && <QueryError label="Owner controls" retry={() => void query.refetch()} />}
    {query.isLoading ? <LoadingPanel rows={4} /> : <>
      <div className="settings-stack">
        <div className="panel setting-card"><div><div className="setting-title">Outbound agent outreach</div><div className="setting-copy">Allows explicit discovery, connectivity pings, and task delegation to the public HTTPS agent endpoint you choose. Saving this switch does not contact anyone; each network request requires a separate action on Outbound A2A.</div><div className="settings-state" data-testid="status-outreach">{outreach ? 'OUTBOUND REQUESTS · ENABLED' : 'OUTBOUND REQUESTS · DISABLED'}</div></div><button className={`switch${outreach ? ' on' : ''}`} role="switch" aria-checked={outreach} aria-label="Outbound agent outreach" onClick={() => updateOutreach(!outreach)} data-testid="switch-outreach" /></div>
         <div className="panel setting-card"><div><div className="setting-title">Safe mode</div><div className="setting-copy">A2A task execution is contained to the sandbox. Positive-price quote acceptance is required before any provider call; without keys, a local mock result is returned. Provider API usage may be billed by Google/OpenAI.</div><div className="settings-state">EXECUTION · OWNER ACCEPTANCE REQUIRED</div></div><span className="safe-badge"><LockKeyhole size={12} /> ON · FIXED</span></div>
          <div className="panel setting-card"><div><div className="setting-title">Withdrawals deferred</div><div className="setting-copy">Verified Whop receipts stay in the internal ledger. No bank, card, wallet, or payout details are requested or stored. Withdrawal setup remains deferred until the verified balance reaches the owner's $50–$100 target.</div><div className="settings-state" data-testid="status-payouts">WITHDRAWALS · DISABLED / DETAILS NOT COLLECTED</div></div><span className="safe-badge"><LockKeyhole size={12} /> DEFERRED</span></div>
          <div className="settings-note" data-testid="text-payout-note"><strong>Ledger policy:</strong> {query.data?.payoutNote || 'Verified Whop receipts are tracked internally. Withdrawals remain disabled.'}</div>
        <div className="settings-save"><button className="primary-btn" onClick={save} disabled={!dirty || mutation.isPending || query.isError} data-testid="button-save-settings">{mutation.isPending ? 'Saving controls…' : <><Check size={14} /> Save controls</>}</button>{dirty && <span className="inline-message">Unsaved preference changes</span>}</div>
      </div>
    </>}
      <div style={{ marginTop: 28 }}><div className="section-label">Integration boundary</div><div className="panel" style={{ padding: 18, display: 'flex', gap: 13, alignItems: 'flex-start' }}><ShieldCheck size={17} color="#5c805f" /><div><div className="setting-title">Owner sign-in protects this console.</div><div className="setting-copy">Private operations require an owner session. The outreach switch gates new external requests; discovery and task delegation run only for URLs you explicitly submit. Whop receipts are verified read-only; no payout details or withdrawal actions are enabled.</div></div></div></div>
    <Notice value={notice.notice} />
  </div>;
}

function Routed({ username, onLogout, logoutError }: {
  username: string;
  onLogout: () => void;
  logoutError: string | null;
}) {
  return <Shell username={username} onLogout={onLogout} logoutError={logoutError}><Switch>
    <Route path="/" component={Overview} />
    <Route path="/services" component={Services} />
    <Route path="/tasks" component={Tasks} />
    <Route path="/outreach" component={Outreach} />
    <Route path="/settings" component={Settings} />
    <Route component={NotFound} />
  </Switch></Shell>;
}

function OwnerAuthGate() {
  const queryClient = useQueryClient();
  const [auth, setAuth] = useState<OwnerAuthState>({ status: 'checking' });
  const authRef = useRef<OwnerAuthState>(auth);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const updateAuth = useCallback((next: OwnerAuthState) => {
    authRef.current = next;
    setAuth(next);
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const session = await getA2aAuthSession({
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (session.authenticated && session.username) {
        updateAuth({ status: 'authenticated', username: session.username });
        return;
      }
      setOwnerAccessToken(null);
      if (authRef.current.status === 'authenticated') queryClient.clear();
      updateAuth({ status: 'signed-out', configured: session.configured });
    } catch {
      if (authRef.current.status !== 'authenticated') {
        updateAuth({ status: 'unavailable' });
      }
    }
  }, [queryClient, updateAuth]);

  useEffect(() => {
    void refreshSession();
    const timer = window.setInterval(() => void refreshSession(), 30_000);
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refreshSession();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshSession]);

  const onAuthenticated = (username: string, accessToken: string) => {
    setOwnerAccessToken(accessToken);
    queryClient.clear();
    setLogoutError(null);
    updateAuth({ status: 'authenticated', username });
  };

  const onLogout = async () => {
    setLogoutError(null);
    try {
      await logoutA2aOwner({ credentials: 'same-origin', cache: 'no-store' });
      setOwnerAccessToken(null);
      queryClient.clear();
      updateAuth({ status: 'signed-out', configured: true });
    } catch {
      setLogoutError('Sign out could not reach the server. Please try again.');
    }
  };

  if (auth.status === 'checking') {
    return <OwnerAuthMessage title="Checking owner session." description="Verifying access before loading the private console." />;
  }
  if (auth.status === 'unavailable') {
    return <OwnerAuthMessage title="Sign-in service unavailable." description="The authentication service could not be reached. The private dashboard remains locked." onRetry={() => void refreshSession()} />;
  }
  if (auth.status === 'signed-out') {
    return <OwnerLogin configured={auth.configured} onAuthenticated={onAuthenticated} />;
  }

  return <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
    <Routed username={auth.username} onLogout={onLogout} logoutError={logoutError} />
  </WouterRouter>;
}

function App() {
  return <QueryClientProvider client={client}><OwnerAuthGate /></QueryClientProvider>;
}

export default App;
