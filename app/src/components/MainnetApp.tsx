import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Policy } from "../api";
import { agoIso, usdc } from "../lib";
import { ARC, V5_VAULT } from "../v5/chain";
import { readVault, type VaultView } from "../v5/reader";
import { useWallet } from "../v5/wallet";
import { PoliciesTable } from "./Read";
import { WalletButton } from "./WalletButton";
import { Icon } from "./Icon";

const V5CreatePolicy = lazy(() => import("./V5CreatePolicy").then((m) => ({ default: m.V5CreatePolicy })));
const V5PolicyDetail = lazy(() => import("./V5PolicyDetail").then((m) => ({ default: m.V5PolicyDetail })));

/**
 * The mainnet build: v5 only, read straight from the vault on Arc mainnet (src/v5/reader.ts), with no
 * Covenant server in between. The testnet operator screens (v4, settlements, the live price) do not
 * exist here, because nothing they show is on mainnet.
 *
 * The vault is an unaudited beta with a hard cap on everything it may hold, so the banner says so on
 * every screen, with the cap and how much of it is in use read live from the contract.
 */
export function MainnetApp() {
  const w = useWallet();
  const [view, setView] = useState<VaultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Policy | null>(null);
  const [mine, setMine] = useState(false);
  const vault = V5_VAULT;

  // Only the newest read may change the screen. A read started before the wallet reconnected can
  // finish after a newer one through the wallet, and its stale failure must not overwrite that.
  const latest = useRef(0);
  const load = useCallback(async () => {
    if (!vault) return;
    const ticket = ++latest.current;
    try {
      const v = await readVault(vault, "mainnet", w.chainId === ARC.id ? w.wallet?.provider : undefined);
      if (ticket !== latest.current) return;
      setView(v);
      setError(null);
    } catch (e) {
      if (ticket !== latest.current) return;
      setError((e as Error).message);
    }
  }, [vault, w.wallet, w.chainId]);

  // Both builds share index.html, whose title names the testnet operator app.
  useEffect(() => { document.title = "Covenant · app"; }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const account = w.account?.toLowerCase();
  const involves = (p: Policy) =>
    !!account && [p.owner, p.recipient, p.attester].some((a) => a?.toLowerCase() === account);
  const policies = (view?.policies ?? []).filter((p) => !mine || involves(p));
  const current = selected && view?.policies.find((p) => p.id === selected.id);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Covenant home">
          <span className="accent">Covenant</span><span className="sub">on {ARC.name} mainnet</span>
        </a>
        <div className="opstatus"><WalletButton /></div>
      </header>

      <main>
        <div className="notice beta" role="note">
          <strong>Unaudited beta.</strong> The vault contract can only pay a policy's recipient or return the money to its owner,
          but it has not been audited yet. It can hold at most{" "}
          <span className="mono">{view ? usdc(view.fundsCap.toString()) : "…"}</span> across everyone
          {view && <> (<span className="mono">{usdc(view.totalHeld.toString())}</span> in use now)</>}. Use small amounts.
          Its guardian can pause payouts for up to 7 days but can never move anyone's funds.
        </div>
        {view?.paused && (
          <div className="notice err">The guardian has paused payouts. You can still cancel unmet policies and take your money back.</div>
        )}
        {!vault && <div className="notice err">This build has no mainnet vault configured.</div>}
        {error && (
          <div className="notice err">
            Cannot read the vault from {ARC.name}: every public connection failed{w.wallet ? "" : ", and no wallet is connected to try instead"}.
            If your browser blocks trackers (Brave Shields, for example), allow this site or connect your wallet.
            <div className="reason">{error.split("\n")[0]}</div>
          </div>
        )}

        <section>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <div className="grid-label" style={{ margin: 0 }}><Icon name="lock" /> Policies</div>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              {w.account && (
                <label className="dim" style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={mine} onChange={(e) => setMine(e.target.checked)} /> only mine
                </label>
              )}
              {vault && <button className="btn small" onClick={() => setCreating(true)}><Icon name="wallet" /> New policy from your wallet</button>}
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            {!view && !error ? <div className="state-msg">Reading the vault…</div>
              : view && !policies.length ? <div className="state-msg">{mine ? "No policies involve your wallet yet." : "No policies yet. Be the first: create one from your wallet."}</div>
              : <PoliciesTable policies={policies} onSelect={setSelected} />}
          </div>
        </section>
      </main>

      <footer style={{ maxWidth: 1160, margin: "0 auto", padding: "16px 22px 40px", borderTop: "1px solid var(--line)", color: "var(--dim)", fontSize: 12, width: "100%" }}>
        {vault && <>Vault <a className="mono" href={`${ARC.blockExplorers.default.url}/address/${vault}`} target="_blank" rel="noopener">{vault}</a> · </>}
        read directly from {ARC.name} {view && <>· updated {agoIso(new Date(view.readAt).toISOString())}</>}
      </footer>

      <Suspense fallback={null}>
        {creating && vault && <V5CreatePolicy vault={vault} onClose={() => setCreating(false)} onCreated={load} />}
        {selected && (
          <V5PolicyDetail policy={current ?? selected} vault={vault} problem={null} onClose={() => setSelected(null)} onChanged={load} />
        )}
      </Suspense>
    </div>
  );
}
