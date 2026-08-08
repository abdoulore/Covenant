import { useMemo, useState } from "react";
import { api, ApiError, type WriteResult } from "../api";
import { usdc } from "../lib";

type Kind = "timelock" | "approval";
type Step = "form" | "review" | "result";

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Decimal USDC to 6-decimal base units, or null if malformed or not positive. */
function toBaseUnits(decimal: string): string | null {
  const s = decimal.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const base = BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  return base > 0n ? base.toString() : null;
}

const DEST = [
  { domain: 26, name: "Arc (same chain)" },
  { domain: 6, name: "Base Sepolia (cross-chain)" },
];

export function CreatePolicy({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<Kind>("timelock");
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; reason?: string } | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USDC");
  const [destination, setDestination] = useState(26);
  const [releaseAt, setReleaseAt] = useState("");
  const [approversText, setApproversText] = useState("");
  const [threshold, setThreshold] = useState(1);

  const base = useMemo(() => toBaseUnits(amount), [amount]);
  const approvers = useMemo(
    () => approversText.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean),
    [approversText],
  );
  const releaseUnix = releaseAt ? Math.floor(new Date(releaseAt).getTime() / 1000) : NaN;

  const problems: string[] = [];
  if (!ADDR.test(recipient)) problems.push("Recipient must be a 0x address.");
  if (!base) problems.push("Amount must be a positive number with up to 6 decimals.");
  if (currency === "EURC" && destination !== 26) problems.push("EURC can only be paid on Arc (no cross-chain EURC route).");
  if (kind === "timelock" && !Number.isFinite(releaseUnix)) problems.push("Pick a release time.");
  if (kind === "approval") {
    if (approvers.length === 0 || !approvers.every((a) => ADDR.test(a))) problems.push("Approvers must be one or more 0x addresses.");
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > approvers.length) problems.push("Threshold must be between 1 and the number of approvers.");
  }
  const valid = problems.length === 0;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = kind === "timelock"
        ? await api.createTimelock({ recipient, amount: base!, payoutCurrency: currency, destinationDomain: destination, releaseTime: releaseUnix })
        : await api.createApproval({ recipient, amount: base!, payoutCurrency: currency, destinationDomain: destination, approvers, threshold });
      setResult(r);
      setStep("result");
      onCreated();
    } catch (e) {
      if (e instanceof ApiError) setErr({ message: e.message, reason: e.reason });
      else setErr({ message: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>

        {step === "form" && (
          <>
            <h3>Create a policy</h3>
            <p className="muted" style={{ marginTop: 4 }}>Timelock and approval are live. Attestation, oracle, recurring, and sweep land next.</p>
            <div className="row" style={{ margin: "14px 0" }}>
              {(["timelock", "approval"] as Kind[]).map((k) => (
                <button key={k} className={`btn ${kind === k ? "" : "ghost"} small`} onClick={() => setKind(k)}>{k}</button>
              ))}
            </div>

            <label className="field"><span className="lab">Recipient address</span>
              <input className="mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" /></label>

            <div className="row">
              <label className="field" style={{ flex: 1 }}><span className="lab">Amount</span>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.50" />
                <div className="hint">{base ? `${usdc(base)} (${base} base units)` : "USDC, up to 6 decimals"}</div></label>
              <label className="field" style={{ width: 130 }}><span className="lab">Payout currency</span>
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>USDC</option><option>EURC</option></select></label>
            </div>

            <label className="field"><span className="lab">Destination</span>
              <select value={destination} onChange={(e) => setDestination(Number(e.target.value))}>
                {DEST.map((d) => <option key={d.domain} value={d.domain}>{d.name}</option>)}
              </select></label>

            {kind === "timelock" && (
              <label className="field"><span className="lab">Release time</span>
                <input type="datetime-local" value={releaseAt} onChange={(e) => setReleaseAt(e.target.value)} />
                <div className="hint">Releasable only at or after this time.</div></label>
            )}

            {kind === "approval" && (
              <>
                <label className="field"><span className="lab">Approvers (one per line or comma separated)</span>
                  <textarea className="mono" rows={3} value={approversText} onChange={(e) => setApproversText(e.target.value)} placeholder="0x…" /></label>
                <label className="field" style={{ width: 160 }}><span className="lab">Threshold (N of {approvers.length || "M"})</span>
                  <input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(Number(e.target.value) || 0)} /></label>
              </>
            )}

            {!valid && amount !== "" && <div className="notice err">{problems[0]}</div>}
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn" disabled={!valid} onClick={() => setStep("review")}>Review</button>
            </div>
          </>
        )}

        {step === "review" && (
          <>
            <h3>Review</h3>
            <p className="muted" style={{ marginTop: 4 }}>This is exactly what the contract will enforce.</p>
            <div className="review">
              <KV k="Condition" v={kind} />
              <KV k="Recipient" v={recipient} />
              <KV k="Amount" v={usdc(base)} />
              <KV k="Payout currency" v={currency} />
              <KV k="Destination" v={DEST.find((d) => d.domain === destination)?.name ?? String(destination)} />
              {kind === "timelock" && <KV k="Releasable at" v={new Date(releaseUnix * 1000).toLocaleString()} />}
              {kind === "approval" && <KV k="Approvers" v={`${threshold} of ${approvers.length}`} />}
            </div>
            {err && <div className="notice err">{err.message}{err.reason && <div className="reason">{err.reason}</div>}</div>}
            <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <button className="btn ghost" onClick={() => setStep("form")}>Back</button>
              <button className="btn" disabled={busy} onClick={submit}>{busy ? "Submitting…" : "Create policy"}</button>
            </div>
          </>
        )}

        {step === "result" && result && (
          <>
            <h3>Policy created</h3>
            <div className="notice ok">Policy {result.policyId} created on chain.</div>
            <div className="review">
              <KV k="Policy id" v={result.policyId ?? "?"} />
              <KV k="Transaction" v={result.txHash} />
            </div>
            <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <a className="btn ghost" href={result.explorerUrl} target="_blank" rel="noopener">View on explorer</a>
              <button className="btn" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v}</span></div>;
}
