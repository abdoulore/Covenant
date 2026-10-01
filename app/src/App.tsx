import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api, type AppState, type Policy } from "./api";
import { agoIso } from "./lib";
import { Cards, DepegPanel, PoliciesTable, Receipts, UnsettledPanel } from "./components/Read";
import { Login } from "./components/Login";
import { CreatePolicy } from "./components/CreatePolicy";
import { PolicyDetail } from "./components/PolicyDetail";
import { Approvals } from "./components/Approvals";
import { System } from "./components/System";
import { Icon } from "./components/Icon";
import { WalletButton } from "./components/WalletButton";
import { IS_MAINNET, resolveV5Vault, V5_VAULT } from "./v5/chain";

type Tab = "overview" | "policies" | "approvals" | "settlements" | "system";
type Modal = null | "login" | "create" | "v5create";

/**
 * Where the landing page lives, and the mirror of the landing page's own APP_URL.
 *
 * Root-relative, because the two deploy together to one host: the page at the root, this bundle
 * under /app. The dev server serves only the app, so following it locally just reloads the app —
 * the honest path in production beats a guess that is right in neither place.
 */
const LANDING_URL = "/";

// The v5 screens carry the vault's ABI and viem's contract machinery, which the read-only views never
// need, so they load when first opened.
const V5CreatePolicy = lazy(() => import("./components/V5CreatePolicy").then((m) => ({ default: m.V5CreatePolicy })));
const V5PolicyDetail = lazy(() => import("./components/V5PolicyDetail").then((m) => ({ default: m.V5PolicyDetail })));

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "overview", icon: "grid", label: "Overview" },
  { id: "policies", icon: "lock", label: "Policies" },
  { id: "approvals", icon: "check", label: "Approvals" },
  { id: "settlements", icon: "receipt", label: "Settlements" },
  { id: "system", icon: "cpu", label: "System" },
];

// The mainnet build is its own screen, loaded only in that build (see src/v5/chain.ts).
const MainnetApp = lazy(() => import("./components/MainnetApp").then((m) => ({ default: m.MainnetApp })));

export function App() {
  return IS_MAINNET ? <Suspense fallback={null}><MainnetApp /></Suspense> : <TestnetApp />;
}

function TestnetApp() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [signedIn, setSignedIn] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [selected, setSelected] = useState<Policy | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.getState());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  /**
   * Recover the session across a reload.
   *
   * `signedIn` is component state and the session itself is an HttpOnly cookie, so on a fresh mount
   * the app knows nothing about a session the browser is still holding perfectly well. Left alone
   * it renders "read only", hides every action, and asks an already-signed-in operator to sign in
   * again. Asked once here; login and sign-out set the flag directly from their own outcome.
   *
   * A failure leaves it false, which is the safe way to be wrong: the actions stay hidden and the
   * API refuses the write anyway. The unreachable-API case is already reported by the state load.
   */
  useEffect(() => {
    let live = true;
    api.session()
      .then(({ signedIn }) => { if (live) setSignedIn(signedIn); })
      .catch(() => { /* stays signed out */ });
    return () => { live = false; };
  }, []);

  const v5 = resolveV5Vault(state?.vaults);
  /**
   * Newest first: the current vault before older ones (the API lists vaults in that order), and within
   * a vault the highest id first. The API returns each vault oldest first, so taking the tail as
   * "recent" showed only the last vault's policies and buried a policy just created on the newest.
   */
  const policies = state
    ? [...state.policies].sort((a, b) => {
        const va = state.vaults.findIndex((v) => v.label === a.vault);
        const vb = state.vaults.findIndex((v) => v.label === b.vault);
        return va !== vb ? va - vb : Number(b.id) - Number(a.id);
      })
    : [];
  const requireOperator = () => (signedIn ? setModal("create") : setModal("login"));

  async function signOut() {
    try { await api.logout(); } catch { /* ignore */ }
    setSignedIn(false);
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={LANDING_URL} aria-label="Covenant home">
          <span className="accent">Covenant</span><span className="sub">treasury operator</span>
        </a>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="opstatus">
          {V5_VAULT && <WalletButton />}
          <span><span className={`dot ${signedIn ? "on" : "off"}`} /> {signedIn ? "operator" : "read only"}</span>
          {signedIn
            ? <button className="btn ghost small" onClick={signOut}>Sign out</button>
            : <button className="btn ghost small" onClick={() => setModal("login")}><Icon name="key" /> Sign in</button>}
        </div>
      </header>

      <main>
        {error && <div className="notice err">Cannot reach the API: {error}</div>}
        {!state && !error && <div className="state-msg">Loading…</div>}

        {state && tab === "overview" && (
          <>
            <section><div className="grid-label"><Icon name="grid" /> Treasury at a glance</div><Cards state={state} /></section>
            <section><div className="grid-label"><Icon name="activity" /> Depeg protection, live</div><DepegPanel o={state.oracle} /></section>
            <section>
              <div className="grid-label"><Icon name="lock" /> Recent policies</div>
              <PoliciesTable policies={policies.slice(0, 6)} onSelect={setSelected} />
            </section>
            <section>
              <div className="grid-label"><Icon name="receipt" /> Recent settlements</div>
              <Receipts settlements={state.settlements.slice(-4)} />
            </section>
          </>
        )}

        {state && tab === "policies" && (
          <section>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <div className="grid-label" style={{ margin: 0 }}><Icon name="lock" /> All policies</div>
              <div className="row" style={{ gap: 8 }}>
                {v5.vault && <button className="btn small" onClick={() => setModal("v5create")}><Icon name="wallet" /> New policy from your wallet</button>}
                <button className={`btn small${v5.vault ? " ghost" : ""}`} onClick={requireOperator}><Icon name="plus" /> Create policy (operator)</button>
              </div>
            </div>
            <div style={{ marginTop: 14 }}><PoliciesTable policies={policies} onSelect={setSelected} /></div>
          </section>
        )}

        {state && tab === "approvals" && (
          <section>
            <div className="grid-label"><Icon name="check" /> Approvals queue</div>
            <Approvals policies={state.policies} signedIn={signedIn} onChanged={load} onRequireLogin={() => setModal("login")} />
          </section>
        )}

        {state && tab === "settlements" && (
          <section><UnsettledPanel unsettled={state.unsettled} vaults={state.vaults} /><div className="grid-label"><Icon name="receipt" /> Settlement receipts, custody measured per transaction</div><Receipts settlements={state.settlements} /></section>
        )}

        {state && tab === "system" && <System state={state} />}
      </main>

      <footer style={{ maxWidth: 1160, margin: "0 auto", padding: "16px 22px 40px", borderTop: "1px solid var(--line)", color: "var(--dim)", fontSize: 12, width: "100%" }}>
        {state && <>Reading {state.vaults.map((v) => v.label).join(" and ")} · updated {agoIso(state.generatedAt)} · testnet only</>}
      </footer>

      {modal === "create" && <CreatePolicy onClose={() => setModal(null)} onCreated={load} oraclePrice={state?.oracle?.price ?? null} />}
      <Suspense fallback={null}>
        {modal === "v5create" && v5.vault && <V5CreatePolicy vault={v5.vault} onClose={() => setModal(null)} onCreated={load} />}
        {selected?.selfCustody && (
          <V5PolicyDetail
            policy={state?.policies.find((p) => p.vault === selected.vault && p.id === selected.id) ?? selected}
            vault={v5.vault}
            problem={v5.problem}
            onClose={() => setSelected(null)}
            onChanged={load}
          />
        )}
      </Suspense>
      {selected && !selected.selfCustody && (
        <PolicyDetail
          policy={state?.policies.find((p) => p.vault === selected.vault && p.id === selected.id) ?? selected}
          signedIn={signedIn}
          onClose={() => setSelected(null)}
          onChanged={load}
          onRequireLogin={() => setModal("login")}
        />
      )}

      {/* Last, and on its own layer. Sign-in is raised from inside the policy detail, so it has to
          paint over it; the .interrupt class is what guarantees that, and this order agrees. */}
      {modal === "login" && <Login onClose={() => setModal(null)} onDone={() => setSignedIn(true)} />}
    </div>
  );
}
