import { useCallback, useEffect, useState } from "react";
import { api, type AppState, type Policy } from "./api";
import { agoIso } from "./lib";
import { Cards, DepegPanel, PoliciesTable, Receipts } from "./components/Read";
import { Login } from "./components/Login";
import { CreatePolicy } from "./components/CreatePolicy";
import { PolicyDetail } from "./components/PolicyDetail";
import { Approvals } from "./components/Approvals";
import { System } from "./components/System";
import { Icon } from "./components/Icon";

type Tab = "overview" | "policies" | "approvals" | "settlements" | "system";
type Modal = null | "login" | "create";

const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: "overview", icon: "grid", label: "Overview" },
  { id: "policies", icon: "lock", label: "Policies" },
  { id: "approvals", icon: "check", label: "Approvals" },
  { id: "settlements", icon: "receipt", label: "Settlements" },
  { id: "system", icon: "cpu", label: "System" },
];

export function App() {
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

  const requireOperator = () => (signedIn ? setModal("create") : setModal("login"));

  async function signOut() {
    try { await api.logout(); } catch { /* ignore */ }
    setSignedIn(false);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="accent">Covenant</span><span className="sub">treasury operator</span></div>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="opstatus">
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
              <PoliciesTable policies={state.policies.slice(-6)} onSelect={setSelected} />
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
              <button className="btn small" onClick={requireOperator}><Icon name="plus" /> Create policy</button>
            </div>
            <div style={{ marginTop: 14 }}><PoliciesTable policies={state.policies} onSelect={setSelected} /></div>
          </section>
        )}

        {state && tab === "approvals" && (
          <section>
            <div className="grid-label"><Icon name="check" /> Approvals queue</div>
            <Approvals policies={state.policies} signedIn={signedIn} onChanged={load} onRequireLogin={() => setModal("login")} />
          </section>
        )}

        {state && tab === "settlements" && (
          <section><div className="grid-label"><Icon name="receipt" /> Settlement receipts, custody measured per transaction</div><Receipts settlements={state.settlements} /></section>
        )}

        {state && tab === "system" && <System state={state} />}
      </main>

      <footer style={{ maxWidth: 1160, margin: "0 auto", padding: "16px 22px 40px", borderTop: "1px solid var(--line)", color: "var(--dim)", fontSize: 12, width: "100%" }}>
        {state && <>Reading {state.vaults.map((v) => v.label).join(" and ")} · updated {agoIso(state.generatedAt)} · testnet only</>}
      </footer>

      {modal === "login" && <Login onClose={() => setModal(null)} onDone={() => setSignedIn(true)} />}
      {modal === "create" && <CreatePolicy onClose={() => setModal(null)} onCreated={load} oraclePrice={state?.oracle?.price ?? null} />}
      {selected && (
        <PolicyDetail
          policy={state?.policies.find((p) => p.vault === selected.vault && p.id === selected.id) ?? selected}
          signedIn={signedIn}
          onClose={() => setSelected(null)}
          onChanged={load}
          onRequireLogin={() => setModal("login")}
        />
      )}
    </div>
  );
}
