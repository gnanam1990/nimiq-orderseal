import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, FileCheck2, GitFork, LockKeyhole, Menu, ShieldCheck, X } from 'lucide-react';
import { MerchantPage } from './MerchantPage';
import { PaymentPage } from './PaymentPage';

function route() {
  const path = window.location.pathname;
  if (path.startsWith('/pay/')) return { page: 'pay' as const, token: path.split('/')[2] ?? '' };
  if (path === '/merchant' || path.startsWith('/merchant/')) return { page: 'merchant' as const };
  return { page: 'home' as const };
}

export function App() {
  const current = useMemo(route, []);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const close = () => setMenuOpen(false);
    window.addEventListener('popstate', close);
    return () => window.removeEventListener('popstate', close);
  }, []);

  return (
    <>
      <header className="site-header">
        <a className="brand" href="/" aria-label="OrderSeal home">
          <span className="brand__mark"><ShieldCheck aria-hidden="true" /></span>
          <span>OrderSeal</span>
        </a>
        <button className="icon-button mobile-only" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="primary-navigation" onClick={() => setMenuOpen(!menuOpen)}>
          {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
        <nav id="primary-navigation" className={menuOpen ? 'nav nav--open' : 'nav'} aria-label="Primary navigation">
          <a href="/#how">How it works</a>
          <a href="/merchant">Merchant console</a>
          <a href="https://github.com/gnanam1990/nimiq-orderseal" target="_blank" rel="noreferrer"><GitFork aria-hidden="true" size={17} />Source</a>
        </nav>
      </header>
      <main id="main">
        {current.page === 'pay' ? <PaymentPage token={current.token} /> : current.page === 'merchant' ? <MerchantPage /> : <Home />}
      </main>
      <footer className="site-footer">
        <div><strong>OrderSeal</strong><span>Settlement evidence before fulfilment.</span></div>
        <p>Open source · MIT · NIM mainnet · Refund execution is observation-only.</p>
      </footer>
    </>
  );
}

function Home() {
  return (
    <>
      <section className="hero">
        <div className="eyebrow"><span className="pulse-dot" />Built for Nimiq Pay</div>
        <h1>A transaction hash is not a paid order.</h1>
        <p className="hero__lede">OrderSeal binds an integrity-sealed order to the exact NIM recipient, amount, network and on-chain operation reference—then releases fulfilment only after server-side mainnet verification.</p>
        <div className="hero__actions">
          <a className="button button--primary" href="/merchant">Open merchant console <ArrowRight aria-hidden="true" /></a>
          <a className="button button--secondary" href="#how">Inspect the control loop</a>
        </div>
        <div className="trust-row" aria-label="Product guarantees">
          <span><LockKeyhole aria-hidden="true" />Wallet keeps the keys</span>
          <span><FileCheck2 aria-hidden="true" />Exact tuple verification</span>
          <span><ShieldCheck aria-hidden="true" />One fulfilment authority</span>
        </div>
      </section>

      <section className="section" id="how">
        <div className="section-heading"><span>Control loop</span><h2>Four states. One honest release.</h2><p>The browser proposes. The chain proves. The backend decides.</p></div>
        <div className="steps">
          {[
            ['01', 'Seal the terms', 'The server authenticates an order revision with recipient, amount, expiry, fulfilment digest and a compact public operation reference.'],
            ['02', 'Approve in Nimiq Pay', 'The wallet selects the sender and shows the native confirmation. Private keys never enter OrderSeal.'],
            ['03', 'Observe through RPC', 'The backend reads one configured mainnet RPC and checks recipient, amount, memo, execution result and confirmations.'],
            ['04', 'Release once', 'A unique database fence creates one fulfilment authorization. Unknown outcomes stay blocked and recoverable.'],
          ].map(([number, title, body]) => <article className="step" key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></article>)}
        </div>
      </section>

      <section className="section section--split">
        <div><span className="kicker">Designed for failure</span><h2>Timeout is not failure. A callback is not proof.</h2></div>
        <div className="principles">
          <p><strong>Operation identity</strong><span>Every payment observation and fulfilment release has a durable semantic key.</span></p>
          <p><strong>Explicit uncertainty</strong><span>RPC loss becomes “observation uncertain,” never “unpaid” or automatic retry.</span></p>
          <p><strong>Support evidence</strong><span>Wrong, late and duplicate payments remain visible instead of disappearing.</span></p>
        </div>
      </section>
    </>
  );
}
