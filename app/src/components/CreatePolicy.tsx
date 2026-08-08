import { useMemo, useState } from "react";
import { api, ApiError, type WriteResult } from "../api";
import { toBaseUnits, usdc } from "../lib";

type Kind = "timelock" | "approval" | "attestation" | "oracle" | "recurring" | "sweep";
type Step = "form" | "review" | "result";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const KINDS: Kind[] = ["timelock", "approval", "attestation", "oracle", "recurring", "sweep"];
const HAS_AMOUNT = new Set<Kind>(["timelock", "approval", "attestation", "oracle"]);

const DEST = [
  { domain: 26, name: "Arc (same chain)" },
  { domain: 6, name: "Base Sepolia (cross-chain)" },
];

/** Buffer may legitimately be zero (sweep everything above 0); other amounts must be positive. */
function bufferBase(s: string): string | null {
  const t = s.trim();
  if (t === "" || t === "0") return "0";
  return toBaseUnits(t);
}

export function CreatePolicy({ onClose, onCreated, oraclePrice }: { onClose: () => void; onCreated: () => void; oraclePrice?: number | null }) {
  const [kind, setKind] = useState<Kind>("timelock");
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; reason?: string } | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [advanced, setAdvanced] = useState(false);

  // shared
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USDC");
  const [destination, setDestination] = useState(26);
  // timelock
  const [releaseAt, setReleaseAt] = useState("");
  // approval
  const [approversText, setApproversText] = useState("");
  const [threshold, setThreshold] = useState(1);
  // attestation
  const [attester, setAttester] = useState("");
  // oracle
  const [comparator, setComparator] = useState<"Gte" | "Lte">("Gte");
  const [thresholdPrice, setThresholdPrice] = useState("0.995");
  const [maxStale, setMaxStale] = useState(120);
  // recurring / sweep
  const [amountPerPeriod, setAmountPerPeriod] = useState("");
  const [buffer, setBuffer] = useState("");
  const [minSweep, setMinSweep] = useState("");
  const [interval, setInterval] = useState(86400);
  const [periods, setPeriods] = useState(0);
  const [startAt, setStartAt] = useState("");
  const [maxCatchUp, setMaxCatchUp] = useState(3600);

  const base = useMemo(() => toBaseUnits(amount), [amount]);
  const approvers = useMemo(() => approversText.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean), [approversText]);
  const releaseUnix = releaseAt ? Math.floor(new Date(releaseAt).getTime() / 1000) : NaN;
  const startUnix = startAt ? Math.floor(new Date(startAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const perBase = useMemo(() => toBaseUnits(amountPerPeriod), [amountPerPeriod]);
  const bufBase = useMemo(() => bufferBase(buffer), [buffer]);
  const minBase = useMemo(() => toBaseUnits(minSweep), [minSweep]);
  const thrE8 = /^\d+(\.\d{1,8})?$/.test(thresholdPrice.trim()) ? Math.round(parseFloat(thresholdPrice) * 1e8).toString() : null;

  const problems: string[] = [];
  if (!ADDR.test(recipient)) problems.push("Recipient must be a 0x address.");
  if (HAS_AMOUNT.has(kind) && !base) problems.push("Amount must be a positive number with up to 6 decimals.");
  if (currency === "EURC" && destination !== 26) problems.push("EURC can only be paid on Arc (no cross-chain EURC route).");
  if (kind === "timelock" && !Number.isFinite(releaseUnix)) problems.push("Pick a release time.");
  if (kind === "approval") {
    if (approvers.length === 0 || !approvers.every((a) => ADDR.test(a))) problems.push("Approvers must be one or more 0x addresses.");
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > approvers.length) problems.push("Threshold must be between 1 and the number of approvers.");
  }
  if (kind === "attestation" && !ADDR.test(attester)) problems.push("Attester must be a 0x address.");
  if (kind === "oracle") {
    if (!thrE8) problems.push("Threshold must be a price like 0.995.");
    if (!Number.isInteger(maxStale) || maxStale <= 0) problems.push("Staleness window must be a positive number of seconds.");
  }
  if (kind === "recurring") {
    if (!perBase) problems.push("Amount per period must be positive.");
    if (!Number.isInteger(interval) || interval <= 0) problems.push("Interval must be a positive number of seconds.");
    if (!Number.isInteger(periods) || periods < 0) problems.push("Periods must be 0 (open-ended) or more.");
  }
  if (kind === "sweep") {
    if (bufBase == null) problems.push("Buffer must be 0 or a positive amount.");
    if (!minBase) problems.push("Minimum sweep must be positive.");
    if (!Number.isInteger(interval) || interval <= 0) problems.push("Interval must be a positive number of seconds.");
  }
  const valid = problems.length === 0;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      let r: WriteResult;
      const common = { recipient, payoutCurrency: currency, destinationDomain: destination };
      if (kind === "timelock") r = await api.createTimelock({ ...common, amount: base!, releaseTime: releaseUnix });
      else if (kind === "approval") r = await api.createApproval({ ...common, amount: base!, approvers, threshold });
      else if (kind === "attestation") r = await api.createAttestation({ ...common, amount: base!, attester });
      else if (kind === "oracle") r = await api.createOracle({ ...common, amount: base!, feedKey: "USDC/USD", comparator, threshold: thrE8!, maxStaleSeconds: maxStale });
      else if (kind === "recurring") r = await api.createRecurring({ ...common, amountPerPeriod: perBase!, interval, startTime: startUnix, periods, maxCatchUp });
      else r = await api.createSweep({ ...common, buffer: bufBase!, minSweep: minBase!, interval, startTime: startUnix, maxCatchUp });
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
            <div className="row" style={{ margin: "14px 0", gap: 6 }}>
              {KINDS.map((k) => (
                <button key={k} className={`btn ${kind === k ? "" : "ghost"} small`} onClick={() => setKind(k)}>{k}</button>
              ))}
            </div>

            <label className="field"><span className="lab">Recipient address</span>
              <input className="mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" /></label>

            {HAS_AMOUNT.has(kind) && (
              <div className="row">
                <label className="field" style={{ flex: 1 }}><span className="lab">Amount</span>
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.50" />
                  <div className="hint">{base ? `${usdc(base)} (${base} base units)` : "USDC, up to 6 decimals"}</div></label>
                <label className="field" style={{ width: 120 }}><span className="lab">Currency</span>
                  <select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>USDC</option><option>EURC</option></select></label>
              </div>
            )}

            {!HAS_AMOUNT.has(kind) && (
              <label className="field" style={{ width: 140 }}><span className="lab">Currency</span>
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>USDC</option><option>EURC</option></select></label>
            )}

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
                <label className="field" style={{ width: 170 }}><span className="lab">Threshold (N of {approvers.length || "M"})</span>
                  <input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(Number(e.target.value) || 0)} /></label>
              </>
            )}

            {kind === "attestation" && (
              <label className="field"><span className="lab">Attester address</span>
                <input className="mono" value={attester} onChange={(e) => setAttester(e.target.value)} placeholder="0x…" />
                <div className="hint">Releasable when this address signs the policy's EIP-712 statement.</div></label>
            )}

            {kind === "oracle" && (
              <>
                <div className="hint" style={{ margin: "4px 0 10px" }}>Feed: USDC/USD via Pyth{oraclePrice != null ? <>, live now <span className="mono">{oraclePrice.toFixed(6)}</span></> : ""} (the only supported feed in v1).</div>
                <div className="row">
                  <label className="field" style={{ width: 150 }}><span className="lab">Release when price</span>
                    <select value={comparator} onChange={(e) => setComparator(e.target.value as "Gte" | "Lte")}>
                      <option value="Gte">at or above ≥</option><option value="Lte">at or below ≤</option>
                    </select></label>
                  <label className="field" style={{ flex: 1 }}><span className="lab">Threshold price</span>
                    <input inputMode="decimal" value={thresholdPrice} onChange={(e) => setThresholdPrice(e.target.value)} placeholder="0.995" />
                    <div className="hint">{oraclePrice != null && thrE8 ? `${comparator === "Gte" ? "met" : "unmet"} at the live price ${(oraclePrice >= parseFloat(thresholdPrice)) === (comparator === "Gte") ? "(condition would release)" : "(condition would hold)"}` : "in USD, e.g. 0.995"}</div></label>
                </div>
                <label className="field" style={{ width: 200 }}><span className="lab">Staleness window (seconds)</span>
                  <input inputMode="numeric" value={maxStale} onChange={(e) => setMaxStale(Number(e.target.value) || 0)} />
                  <div className="hint">A price older than this fails closed.</div></label>
              </>
            )}

            {kind === "recurring" && (
              <>
                <div className="row">
                  <label className="field" style={{ flex: 1 }}><span className="lab">Amount per period</span>
                    <input inputMode="decimal" value={amountPerPeriod} onChange={(e) => setAmountPerPeriod(e.target.value)} placeholder="0.01" />
                    <div className="hint">{perBase ? usdc(perBase) : "USDC each interval"}</div></label>
                  <label className="field" style={{ width: 150 }}><span className="lab">Interval (seconds)</span>
                    <input inputMode="numeric" value={interval} onChange={(e) => setInterval(Number(e.target.value) || 0)} /></label>
                </div>
                <label className="field" style={{ width: 200 }}><span className="lab">Periods (0 = open-ended)</span>
                  <input inputMode="numeric" value={periods} onChange={(e) => setPeriods(Number(e.target.value) || 0)} /></label>
              </>
            )}

            {kind === "sweep" && (
              <>
                <div className="row">
                  <label className="field" style={{ flex: 1 }}><span className="lab">Keep buffer</span>
                    <input inputMode="decimal" value={buffer} onChange={(e) => setBuffer(e.target.value)} placeholder="0.05" />
                    <div className="hint">{bufBase != null ? usdc(bufBase) : "kept in the policy"}</div></label>
                  <label className="field" style={{ flex: 1 }}><span className="lab">Minimum sweep</span>
                    <input inputMode="decimal" value={minSweep} onChange={(e) => setMinSweep(e.target.value)} placeholder="0.02" />
                    <div className="hint">{minBase ? usdc(minBase) : "dust floor"}</div></label>
                </div>
                <label className="field" style={{ width: 170 }}><span className="lab">Interval (seconds)</span>
                  <input inputMode="numeric" value={interval} onChange={(e) => setInterval(Number(e.target.value) || 0)} /></label>
              </>
            )}

            {(kind === "recurring" || kind === "sweep") && (
              <>
                <button className="btn ghost small" style={{ marginTop: 4 }} onClick={() => setAdvanced((a) => !a)}>{advanced ? "Hide advanced" : "Advanced"}</button>
                {advanced && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <label className="field" style={{ flex: 1 }}><span className="lab">First period at</span>
                      <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
                      <div className="hint">Defaults to now.</div></label>
                    <label className="field" style={{ width: 190 }}><span className="lab">Max catch-up (seconds)</span>
                      <input inputMode="numeric" value={maxCatchUp} onChange={(e) => setMaxCatchUp(Number(e.target.value) || 0)} />
                      <div className="hint">Overdue beyond this holds for owner approval.</div></label>
                  </div>
                )}
              </>
            )}

            {!valid && <div className="notice err" style={{ marginTop: 12 }}>{problems[0]}</div>}
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
              {HAS_AMOUNT.has(kind) && <KV k="Amount" v={usdc(base)} />}
              <KV k="Payout" v={`${currency} · ${DEST.find((d) => d.domain === destination)?.name ?? destination}`} />
              {kind === "timelock" && <KV k="Releasable at" v={new Date(releaseUnix * 1000).toLocaleString()} />}
              {kind === "approval" && <KV k="Approvals" v={`${threshold} of ${approvers.length}`} />}
              {kind === "attestation" && <KV k="Attester" v={attester} />}
              {kind === "oracle" && <KV k="Rule" v={`USDC/USD ${comparator === "Gte" ? "≥" : "≤"} ${thresholdPrice}, stale > ${maxStale}s fails closed`} />}
              {kind === "recurring" && <KV k="Schedule" v={`${usdc(perBase)} every ${interval}s, ${periods ? `${periods} periods` : "open-ended"}`} />}
              {kind === "sweep" && <KV k="Sweep" v={`keep ${usdc(bufBase)}, min ${usdc(minBase)}, every ${interval}s`} />}
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
