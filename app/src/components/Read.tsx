/** The read views, ported from the monitor to React. Read-only: they render API state only. */
import type { AppState, Oracle, Policy, Settlement, Unsettled } from "../api";
import { agoUnix, ARC_DOMAIN, relUnix, shortAddr, shortHash, usdc } from "../lib";
import { Icon } from "./Icon";

const CONDITION_ICON: Record<string, string> = {
  Timelock: "clock", Approval: "check", Attestation: "shield", Oracle: "activity", OraclePull: "activity",
  Schedule: "repeat", Recurring: "repeat", Sweep: "swap",
};

export function DepegPanel({ o }: { o: Oracle | null }) {
  if (!o) return <div className="panel muted">Pyth price unavailable right now.</div>;
  const pegFloor = 0.995, depegTrig = 0.99, lo = 0.98, hi = 1.005, span = hi - lo;
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  const met = o.price >= pegFloor;
  return (
    <div className="panel">
      <div className="depeg-head">
        <div>
          <div className="depeg-price">{o.price.toFixed(6)}</div>
          <div className="depeg-pair">{o.pair} via Pyth, pull oracle</div>
        </div>
        <div className={`verdict ${met ? "ok" : "warn"}`}>{met ? "Holding peg, releasable" : "Below peg floor, held"}</div>
      </div>
      <div className="gauge">
        <div className="track" />
        <div className="tick trg" style={{ left: `${pos(depegTrig)}%` }}><span className="lab">0.990 trigger</span></div>
        <div className="tick thr" style={{ left: `${pos(pegFloor)}%` }}><span className="lab">0.995 floor</span></div>
        <div className="marker" style={{ left: `${pos(o.price)}%`, background: met ? "var(--good)" : "var(--bad)" }} />
      </div>
      <div className="row" style={{ marginTop: 16, gap: 28 }}>
        <Readout k="RELEASE RULE" v="price ≥ 0.995" />
        <Readout k="CONFIDENCE" v={`±${o.conf.toFixed(6)}`} />
        <Readout k="STATE" v={met ? "condition met" : "condition unmet"} color={met ? "var(--good)" : "var(--bad)"} />
        <Readout k="UPDATED" v={agoUnix(o.publishTime)} />
      </div>
    </div>
  );
}

function Readout({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div>
      <div className="dim" style={{ fontSize: 11, letterSpacing: "0.04em" }}>{k}</div>
      <div className="mono" style={{ fontSize: 15, marginTop: 2, color }}>{v}</div>
    </div>
  );
}

export function Cards({ state }: { state: AppState }) {
  const active = state.policies.filter((p) => p.effectiveStatus === "Pending" || p.effectiveStatus === "Releasable").length;
  const settled = state.settlements.filter((s) => s.status === "settled").length;
  const funded = state.policies.reduce((n, p) => n + Number(p.funded || 0), 0);
  /**
   * Named from the state, not from a number written into the copy.
   *
   * This card said "across both vaults" until the app stopped surfacing v3, at which point it was
   * simply wrong on the first line of the first screen. Which deployments the app reads is a
   * deployment decision that has already changed three times; the label has to follow it.
   */
  const vaults = state.vaults.map((v) => v.label);
  const scope = vaults.length === 1 ? `policies on ${vaults[0]}` : `policies across ${vaults.join(" and ")}`;
  return (
    <div className="cards">
      <div className="card"><div className="v">{state.policies.length}</div><div className="k">{scope}</div></div>
      <div className="card"><div className="v">{active}</div><div className="k">active (pending or releasable)</div></div>
      <div className="card"><div className="v">{settled}</div><div className="k">settlements completed</div></div>
      <div className="card"><div className="v">{(funded / 1e6).toFixed(2)}</div><div className="k">USDC locked in vaults</div></div>
    </div>
  );
}

function detail(p: Policy) {
  switch (p.conditionType) {
    case "Timelock": return <>releases <span className="num">{relUnix(p.releaseTime)}</span></>;
    case "Approval": return <><span className="num">{p.approvalCount}</span> of <span className="num">{p.threshold}</span> approvals</>;
    case "Attestation": return <>attester <span className="mono">{shortAddr(p.attester)}</span>, {p.attested ? "signed" : "awaiting signature"}</>;
    // The threshold's scale depends on the path: the feed's own decimals for a pushed Oracle feed,
    // and 1e18 for OraclePull, because the adapter normalizes before the vault compares.
    case "Oracle": return <>USDC/USD {p.comparator === "Lte" ? "≤" : "≥"} <span className="num">{(Number(p.oracleThreshold) / 1e8).toFixed(3)}</span></>;
    case "OraclePull": return (
      <>USDC/USD {p.comparator === "Lte" ? "≤" : "≥"} <span className="num">{(Number(p.oracleThreshold) / 1e18).toFixed(3)}</span>
        {p.maxConfBps ? <>, conf ≤ <span className="num">{(p.maxConfBps / 100).toFixed(2)}%</span></> : null}</>
    );
    case "Recurring": return <><span className="num">{usdc(p.amountPerPeriod)}</span> every <span className="num">{p.interval}</span>s, <span className="num">{p.periodsReleased}</span>{p.periods ? ` of ${p.periods}` : ""} released</>;
    case "Sweep": return <>sweep above <span className="num">{usdc(p.buffer)}</span>, min <span className="num">{usdc(p.minSweep)}</span></>;
    default: return null;
  }
}

export function PoliciesTable({ policies, onSelect }: { policies: Policy[]; onSelect?: (p: Policy) => void }) {
  if (!policies.length) return <div className="state-msg">No policies found on the configured vaults.</div>;
  return (
    <table>
      <thead><tr><th>Vault</th><th>#</th><th>Condition</th><th>Status</th><th className="r">Funded</th></tr></thead>
      <tbody>
        {policies.map((p) => (
          <tr key={`${p.vault}-${p.id}`} className={onSelect ? "click" : ""} onClick={() => onSelect?.(p)}>
            <td><span className="vbadge">{p.vault}</span></td>
            <td className="num">{p.id}</td>
            <td><div className="ptype"><Icon name={CONDITION_ICON[p.conditionType] ?? "lock"} /> {p.conditionType}</div><div className="pdetail">{detail(p)}</div></td>
            <td><span className={`pill ${p.effectiveStatus}`}>{p.effectiveStatus}</span></td>
            <td className="r num">{usdc(p.funded)}{p.amount && p.amount !== "0" && !p.recurring ? <div className="dim" style={{ fontSize: 11 }}>of {usdc(p.amount)}</div> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TxLink({ url, hash }: { url?: string; hash?: string }) {
  if (!hash) return <span className="dim">not settled</span>;
  return url ? <a className="mono" href={url} target="_blank" rel="noopener">{shortHash(hash)}</a> : <span className="mono dim">{shortHash(hash)}</span>;
}

const UNSETTLED_TEXT: Record<Unsettled["kind"], string> = {
  unpaid: "released, never paid",
  stuck: "settlement started, not finished",
  failed: "settlement failed, waiting on a person",
};

/**
 * Releases nobody settled, above the receipts that went well.
 *
 * Receipts alone only ever show success, which is how four unpaid releases went unnoticed on v4 for
 * six weeks. This is the other half of the picture, and it is shown first because it is the half
 * that needs someone to act. An unreadable ledger says so, rather than showing an empty list that
 * would read as "nothing owed".
 */
export function UnsettledPanel({ unsettled, vaults }: { unsettled: Unsettled[] | null | undefined; vaults: AppState["vaults"] }) {
  if (unsettled === undefined) return null;
  if (unsettled === null) {
    return <div className="notice err">Could not read the release ledger, so unpaid releases cannot be shown right now.</div>;
  }
  if (!unsettled.length) return null;
  const label = (v: string) => vaults.find((x) => x.address.toLowerCase() === v.toLowerCase())?.label ?? shortAddr(v);
  const owed = unsettled.reduce((n, u) => n + Number(u.amount), 0) / 1e6;
  return (
    <div className="notice err" style={{ marginBottom: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        {unsettled.length} release{unsettled.length === 1 ? "" : "s"} need attention, {owed.toFixed(2)} USDC in total
      </div>
      {unsettled.map((u) => (
        <div key={`${u.vault}-${u.policyId}-${u.periodIndex}`} className="mono" style={{ fontSize: 12.5, marginTop: 4 }}>
          policy {u.policyId}{u.periodIndex ? ` p${u.periodIndex}` : ""} on {label(u.vault)} · {usdc(u.amount)} to {shortAddr(u.recipient)} · {UNSETTLED_TEXT[u.kind]}{" "}
          · <a href={u.release.url} target="_blank" rel="noopener">release</a>
        </div>
      ))}
      <div style={{ fontSize: 12, marginTop: 10, opacity: 0.85 }}>
        Pay one with <span className="mono">npm run settle-release -- &lt;release tx&gt;</span>, or record how it was paid with <span className="mono">npm run reconcile -- resolve</span>.
      </div>
    </div>
  );
}

export function Receipts({ settlements }: { settlements: Settlement[] }) {
  if (!settlements.length) return <div className="state-msg">No settlements recorded yet.</div>;
  return (
    <div className="receipts">
      {settlements.slice().reverse().map((s) => {
        const held = s.custodyGapMs != null ? `${(s.custodyGapMs / 1000).toFixed(1)}s` : "n/a";
        const xchain = s.destinationDomain != null && Number(s.destinationDomain) !== ARC_DOMAIN;
        const label = `policy ${s.policyId}${s.periodIndex ? `, period ${s.periodIndex}` : ""}`;
        return (
          <div className="receipt" key={s.key}>
            <div className="receipt-head">
              <span style={{ fontWeight: 600, fontSize: 13 }}>{s.source} <span className="dim">/ {label}</span></span>
              <span className="mono muted" style={{ fontSize: 12.5 }}>{usdc(s.amount)} <span className={`pill ${s.status}`} style={{ marginLeft: 6 }}>{s.status}</span></span>
            </div>
            <div className="flow">
              <div className="stop"><div className="k">FUNDS LEFT VAULT</div><div className="h"><TxLink url={s.release.url} hash={s.release.txHash} /></div></div>
              <div className="held"><div className="arrow" /><div className="n">held {held}</div><div className="cap">{xchain ? "cross-chain, incl. bridge" : "custody gap"}</div></div>
              <div className="stop r"><div className="k">RECIPIENT PAID</div><div className="h"><TxLink url={s.payout?.url} hash={s.payout?.txHash} /></div></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
