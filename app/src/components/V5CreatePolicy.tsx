import { useMemo, useState } from "react";
import { getAddress } from "viem";
import { localStamp, localZone, toBaseUnits, usdc, utcStamp } from "../lib";
import { ARC_DOMAIN, V5_DESTINATIONS } from "../v5/chain";
import { useWallet } from "../v5/wallet";
import { signerFor } from "../v5/signer";
import { createPolicy, pullFor, quoteMaxFee, TxError, usdcBalance, type CreateSpec, type Sent } from "../v5/vault";

type Kind = "timelock" | "approval" | "attestation" | "recurring" | "sweep";
type Step = "form" | "review" | "result";

const KINDS: Kind[] = ["timelock", "approval", "attestation", "recurring", "sweep"];
const KIND_LABEL: Record<Kind, string> = { timelock: "timelock", approval: "approval", attestation: "attestation", recurring: "payroll", sweep: "sweep" };
const ONE_OFF = new Set<Kind>(["timelock", "approval", "attestation"]);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86_400;
/** The vault's MIN_WINDOW: a deadline at least this long after the policy can first pay. */
const MIN_WINDOW = 7 * DAY;
/** The deadline offered when the user does not pick one: a month after the policy can first pay. */
const DEFAULT_WINDOW = 30 * DAY;

const unixOf = (local: string) => (local ? Math.floor(new Date(local).getTime() / 1000) : NaN);

/**
 * Create a v5 policy from the user's own wallet. The user is its owner: their USDC funds it, and only
 * they can cancel, stop, or reclaim it. Nothing here goes through the API.
 *
 * Oracle policies are not offered yet: a pull-oracle policy is released with a signed price the
 * keeper fetches, and choosing an adapter and feed is a separate piece of work.
 */
export function V5CreatePolicy({ vault, onClose, onCreated }: { vault: `0x${string}`; onClose: () => void; onCreated: () => void }) {
  const w = useWallet();
  const signer = signerFor(w);
  const [kind, setKind] = useState<Kind>("timelock");
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; reason?: string } | null>(null);
  const [result, setResult] = useState<Sent | null>(null);
  const [plan, setPlan] = useState<{ spec: CreateSpec; fee: bigint; balance: bigint } | null>(null);

  const [recipient, setRecipient] = useState("");
  const [destination, setDestination] = useState(ARC_DOMAIN);
  const [amount, setAmount] = useState("");
  const [deadlineAt, setDeadlineAt] = useState("");
  const [releaseAt, setReleaseAt] = useState("");
  const [approversText, setApproversText] = useState("");
  const [threshold, setThreshold] = useState(1);
  const [attester, setAttester] = useState("");
  const [amountPerPeriod, setAmountPerPeriod] = useState("");
  const [buffer, setBuffer] = useState("");
  const [minSweep, setMinSweep] = useState("");
  const [interval, setInterval] = useState(DAY);
  const [periods, setPeriods] = useState(0);
  const [startAt, setStartAt] = useState("");
  const [fundNow, setFundNow] = useState("");
  const [sweepTransfers, setSweepTransfers] = useState(4);

  const base = useMemo(() => toBaseUnits(amount), [amount]);
  const perBase = useMemo(() => toBaseUnits(amountPerPeriod), [amountPerPeriod]);
  const minBase = useMemo(() => toBaseUnits(minSweep), [minSweep]);
  const bufBase = buffer.trim() === "" || buffer.trim() === "0" ? "0" : toBaseUnits(buffer);
  const fundBase = useMemo(() => toBaseUnits(fundNow), [fundNow]);
  const approvers = useMemo(() => approversText.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean), [approversText]);
  const now = Math.floor(Date.now() / 1000);
  const releaseUnix = unixOf(releaseAt);
  const startUnix = startAt ? unixOf(startAt) : now + 60;
  const crossChain = destination !== ARC_DOMAIN;

  /** The moment from which the deadline's minimum window is counted, per the vault's own rule. */
  const earliestPay = kind === "timelock" ? releaseUnix
    : kind === "recurring" ? startUnix + Math.max(0, periods - 1) * interval
    : kind === "sweep" ? startUnix
    : now;
  const deadlineUnix = deadlineAt ? unixOf(deadlineAt) : earliestPay + DEFAULT_WINDOW;

  const problems: string[] = [];
  if (!signer) problems.push("Connect your wallet on Arc to create a policy.");
  if (!ADDR.test(recipient)) problems.push("Recipient must be a 0x address.");
  if (ONE_OFF.has(kind) && !base) problems.push("Amount must be a positive number with up to 6 decimals.");
  if (kind === "timelock" && !(releaseUnix > now)) problems.push("Pick a release time in the future.");
  if (kind === "approval") {
    if (!approvers.length || !approvers.every((a) => ADDR.test(a))) problems.push("Approvers must be one or more 0x addresses.");
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > approvers.length) problems.push("Threshold must be between 1 and the number of approvers.");
  }
  if (kind === "attestation" && !ADDR.test(attester)) problems.push("Attester must be a 0x address.");
  if (kind === "recurring" && !perBase) problems.push("Amount per period must be positive.");
  if (kind === "sweep") {
    if (bufBase == null) problems.push("Buffer must be 0 or a positive amount.");
    if (!minBase) problems.push("Minimum sweep must be positive.");
    if (crossChain && (!Number.isInteger(sweepTransfers) || sweepTransfers < 1)) problems.push("Prepay fees for at least one sweep.");
  }
  if (!ONE_OFF.has(kind)) {
    if (!Number.isInteger(interval) || interval <= 0) problems.push("Interval must be a positive number of seconds.");
    if (!fundBase) problems.push("Fund it with a positive amount now; you can top it up later.");
  }
  if (Number.isFinite(earliestPay) && !(deadlineUnix >= earliestPay + MIN_WINDOW)) {
    problems.push(`The deadline must be at least 7 days after ${kind === "timelock" ? "the release time" : ONE_OFF.has(kind) ? "now" : "the schedule's last period"}.`);
  }
  const valid = problems.length === 0;

  /** Quote the fee, fix every number, and show them before the wallet asks for anything. */
  async function review() {
    setBusy(true);
    setErr(null);
    try {
      const fee = await quoteMaxFee(destination);
      const terms = {
        recipient: getAddress(recipient), amount: ONE_OFF.has(kind) ? BigInt(base!) : 0n, destinationDomain: destination,
        deadline: BigInt(deadlineUnix), maxFeePerTransfer: fee,
      };
      // A schedule prepays a fee for each transfer its first funding covers. More can be added later.
      const transfers = kind === "recurring" ? BigInt(fundBase!) / BigInt(perBase!) : BigInt(sweepTransfers);
      const initialFees = crossChain ? fee * (transfers > 0n ? transfers : 1n) : 0n;
      const spec: CreateSpec =
        kind === "timelock" ? { kind, terms, releaseTime: BigInt(releaseUnix) }
        : kind === "approval" ? { kind, terms, approvers: approvers.map((a) => getAddress(a)), threshold }
        : kind === "attestation" ? { kind, terms, attester: getAddress(attester) }
        : kind === "recurring" ? { kind, terms, amountPerPeriod: BigInt(perBase!), interval: BigInt(interval), startTime: BigInt(startUnix), periods, initialFunding: BigInt(fundBase!), initialFees }
        : { kind, terms, buffer: BigInt(bufBase!), minSweep: BigInt(minBase!), interval: BigInt(interval), startTime: BigInt(startUnix), initialFunding: BigInt(fundBase!), initialFees };
      setPlan({ spec, fee, balance: await usdcBalance(signer!) });
      setStep("review");
    } catch (e) {
      setErr({ message: e instanceof TxError ? e.message : String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!plan || !signer) return;
    setBusy(true);
    setErr(null);
    try {
      setResult(await createPolicy(signer, vault, plan.spec));
      setStep("result");
      onCreated();
    } catch (e) {
      setErr(e instanceof TxError ? { message: e.message, reason: e.reason } : { message: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  const pull = plan ? pullFor(plan.spec) : 0n;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>

        {step === "form" && (
          <>
            <h3>New policy from your wallet</h3>
            <p className="who">{signer ? <>Owner: <b className="mono">{signer.account}</b>. You fund it, and only you can cancel or reclaim it.</> : "Connect your wallet on Arc first."}</p>
            <div className="row" style={{ margin: "10px 0", gap: 6 }}>
              {KINDS.map((k) => (
                <button key={k} className={`btn ${kind === k ? "" : "ghost"} small`} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
              ))}
            </div>

            <label className="field"><span className="lab">Recipient address</span>
              <input className="mono" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" /></label>

            <div className="row">
              {ONE_OFF.has(kind) && (
                <label className="field" style={{ flex: 1 }}><span className="lab">Amount (USDC)</span>
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.50" />
                  <div className="hint">{base ? usdc(base) : "Paid in full from your wallet when you create it."}</div></label>
              )}
              <label className="field" style={{ flex: 1 }}><span className="lab">Destination</span>
                <select value={destination} onChange={(e) => setDestination(Number(e.target.value))}>
                  {V5_DESTINATIONS.map((d) => <option key={d.domain} value={d.domain}>{d.name}</option>)}
                </select>
                {crossChain && <div className="hint">Paid through Circle, which charges a fee per transfer, quoted at review.</div>}</label>
            </div>

            {kind === "timelock" && (
              <label className="field"><span className="lab">Release time</span>
                <input type="datetime-local" value={releaseAt} onChange={(e) => setReleaseAt(e.target.value)} />
                <TimeHint unix={releaseUnix} lead="Payable at or after this time." /></label>
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
                <div className="hint">Payable once this address signs the policy's statement from its own wallet.</div></label>
            )}

            {kind === "recurring" && (
              <div className="row">
                <label className="field" style={{ flex: 1 }}><span className="lab">Amount per period</span>
                  <input inputMode="decimal" value={amountPerPeriod} onChange={(e) => setAmountPerPeriod(e.target.value)} placeholder="0.10" /></label>
                <label className="field" style={{ width: 150 }}><span className="lab">Periods (0 = open-ended)</span>
                  <input inputMode="numeric" value={periods} onChange={(e) => setPeriods(Number(e.target.value) || 0)} /></label>
              </div>
            )}

            {kind === "sweep" && (
              <div className="row">
                <label className="field" style={{ flex: 1 }}><span className="lab">Keep buffer</span>
                  <input inputMode="decimal" value={buffer} onChange={(e) => setBuffer(e.target.value)} placeholder="0" /></label>
                <label className="field" style={{ flex: 1 }}><span className="lab">Minimum sweep</span>
                  <input inputMode="decimal" value={minSweep} onChange={(e) => setMinSweep(e.target.value)} placeholder="0.05" /></label>
              </div>
            )}

            {!ONE_OFF.has(kind) && (
              <>
                <div className="row">
                  <label className="field" style={{ width: 160 }}><span className="lab">Interval (seconds)</span>
                    <input inputMode="numeric" value={interval} onChange={(e) => setInterval(Number(e.target.value) || 0)} /></label>
                  <label className="field" style={{ flex: 1 }}><span className="lab">Fund now (USDC)</span>
                    <input inputMode="decimal" value={fundNow} onChange={(e) => setFundNow(e.target.value)} placeholder="1.00" />
                    <div className="hint">{kind === "recurring" && fundBase && perBase ? `Covers ${BigInt(fundBase) / BigInt(perBase)} periods. Top up any time.` : "Top up any time."}</div></label>
                  {kind === "sweep" && crossChain && (
                    <label className="field" style={{ width: 150 }}><span className="lab">Prepay fees for</span>
                      <input inputMode="numeric" value={sweepTransfers} onChange={(e) => setSweepTransfers(Number(e.target.value) || 0)} />
                      <div className="hint">sweeps</div></label>
                  )}
                </div>
                <label className="field"><span className="lab">First period at</span>
                  <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
                  <TimeHint unix={startAt ? startUnix : NaN} lead="Defaults to a minute from now." /></label>
              </>
            )}

            <label className="field"><span className="lab">Deadline</span>
              <input type="datetime-local" value={deadlineAt} onChange={(e) => setDeadlineAt(e.target.value)} />
              <div className="hint">
                The last moment it can pay. After it, you can take back whatever it still holds.
                {!deadlineAt && Number.isFinite(deadlineUnix) && <> Defaults to <span className="mono">{localStamp(deadlineUnix)}</span>.</>}
              </div></label>

            {!valid && <div className="notice err" style={{ marginTop: 12 }}>{problems[0]}</div>}
            {err && <div className="notice err">{err.message}</div>}
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn" disabled={!valid || busy} onClick={review}>{busy ? "Quoting…" : "Review"}</button>
            </div>
          </>
        )}

        {step === "review" && plan && (
          <>
            <h3>Review</h3>
            <p className="muted" style={{ marginTop: 4 }}>This is exactly what the vault will enforce. You are the owner.</p>
            <div className="review">
              <KV k="Condition" v={KIND_LABEL[kind]} />
              <KV k="Recipient" v={plan.spec.terms.recipient} />
              <KV k="Paid on" v={V5_DESTINATIONS.find((d) => d.domain === destination)?.name ?? String(destination)} />
              {ONE_OFF.has(kind) && <KV k="Amount" v={usdc(String(plan.spec.terms.amount))} />}
              {plan.spec.kind === "timelock" && <KV k="Payable from" v={localStamp(releaseUnix)} />}
              {plan.spec.kind === "approval" && <KV k="Approvals" v={`${plan.spec.threshold} of ${plan.spec.approvers.length}`} />}
              {plan.spec.kind === "attestation" && <KV k="Attester" v={plan.spec.attester} />}
              {plan.spec.kind === "recurring" && <KV k="Schedule" v={`${usdc(String(plan.spec.amountPerPeriod))} every ${interval}s, ${periods ? `${periods} periods` : "open-ended"}`} />}
              {plan.spec.kind === "sweep" && <KV k="Sweep" v={`keep ${usdc(String(plan.spec.buffer))}, min ${usdc(String(plan.spec.minSweep))}, every ${interval}s`} />}
              {!ONE_OFF.has(kind) && <KV k="First period at" v={localStamp(startUnix)} />}
              {crossChain && <KV k="Circle fee per transfer" v={usdc(String(plan.fee))} />}
              <KV k="Deadline" v={localStamp(deadlineUnix)} />
              <KV k="Deadline on chain" v={utcStamp(deadlineUnix)} />
              <KV k="From your wallet now" v={usdc(String(pull))} />
              <KV k="Your wallet holds" v={usdc(String(plan.balance))} />
            </div>
            <p className="hint">
              Your wallet will ask you to confirm one transaction that approves exactly {usdc(String(pull))} for the vault and
              creates the policy, both in the same step. Some wallets ask for a USDC permit signature first instead.
            </p>
            {plan.balance < pull && <div className="notice err">Your wallet holds less USDC than this needs.</div>}
            {err && <div className="notice err">{err.message}{err.reason && <div className="reason">{err.reason}</div>}</div>}
            <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <button className="btn ghost" disabled={busy} onClick={() => setStep("form")}>Back</button>
              <button className="btn" disabled={busy || plan.balance < pull || !signer} onClick={submit}>{busy ? "Check your wallet…" : "Create policy"}</button>
            </div>
          </>
        )}

        {step === "result" && result && (
          <>
            <h3>Policy created</h3>
            <div className="notice ok">Policy {result.policyId ?? "?"} is live on v5, owned by your wallet.</div>
            <div className="review">
              <KV k="Policy id" v={result.policyId ?? "?"} />
              <KV k="Transaction" v={result.hash} />
            </div>
            <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <a className="btn ghost" href={result.url} target="_blank" rel="noopener">View on explorer</a>
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

function TimeHint({ unix, lead }: { unix: number; lead: string }) {
  const pinned = Number.isFinite(unix);
  return (
    <div className="hint">
      {lead} Read on your own clock, {localZone(pinned ? new Date(unix * 1000) : undefined)}.
      {pinned && <> Stored as <span className="mono">{utcStamp(unix)}</span>.</>}
    </div>
  );
}
