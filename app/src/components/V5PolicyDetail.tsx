import { useEffect, useState } from "react";
import type { Policy } from "../api";
import { localStamp, relUnix, shortAddr, toBaseUnits, usdc, utcStamp } from "../lib";
import { ARC_DOMAIN, V5_DESTINATIONS } from "../v5/chain";
import { useWallet } from "../v5/wallet";
import { signerFor } from "../v5/signer";
import { actions, pausedState, quoteMaxFee, rolesFor, TxError, type Sent } from "../v5/vault";

type Notice = { kind: "ok" | "err"; message: string; reason?: string; url?: string } | null;

/**
 * A v5 policy and what the connected wallet may do to it.
 *
 * What is offered follows who the wallet is: anyone may release a due policy, the named approvers
 * approve, the attester attests, and the owner alone may cancel, stop, reclaim, extend, and add
 * money. The vault enforces all of it; the screen only avoids offering what the vault would refuse,
 * and every action is simulated before the wallet is asked, so a refusal shows the vault's reason.
 */
export function V5PolicyDetail({
  policy, vault, problem, onClose, onChanged,
}: {
  policy: Policy; vault: `0x${string}` | null; problem: string | null; onClose: () => void; onChanged: () => void;
}) {
  const w = useWallet();
  const signer = vault ? signerFor(w) : null;
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [roles, setRoles] = useState({ approver: false, approved: false });
  const [paused, setPaused] = useState(false);
  const [topUp, setTopUp] = useState("");
  const [fees, setFees] = useState("");
  const [newDeadline, setNewDeadline] = useState("");

  const p = policy;
  const account = signer?.account.toLowerCase();
  useEffect(() => {
    let live = true;
    if (!signer || !vault) return;
    rolesFor(signer, vault, p.id, p.conditionType).then((r) => { if (live) setRoles(r); }).catch(() => {});
    pausedState(signer, vault).then((x) => { if (live) setPaused(x); }).catch(() => {});
    return () => { live = false; };
    // Keyed on the account, not the signer object, which is rebuilt on every render.
  }, [account, vault, p.id, p.conditionType, p.approvalCount]);

  const now = Date.now() / 1000;
  const deadline = Number(p.effectiveDeadline ?? p.deadline ?? 0);
  const open = p.status === "Pending";
  const beforeDeadline = now < deadline;
  const pull = p.conditionType === "OraclePull";
  const crossChain = Number(p.destinationDomain) !== ARC_DOMAIN;
  const stopped = Number(p.stoppedAt ?? 0) > 0;
  const isOwner = !!account && account === p.owner?.toLowerCase();
  const isAttester = !!account && account === p.attester?.toLowerCase();

  const canRelease = open && beforeDeadline && !paused && !p.recurring && !pull && p.effectiveStatus === "Releasable";
  const canReleasePeriod = open && beforeDeadline && !paused && !!p.recurring && Number(p.nextDue) <= now;
  const canApprove = open && p.conditionType === "Approval" && roles.approver && !roles.approved;
  const canAttest = open && p.conditionType === "Attestation" && isAttester && !p.attested;
  const canCancel = isOwner && open && beforeDeadline && !p.recurring && !pull && p.effectiveStatus !== "Releasable";
  const canStop = isOwner && open && beforeDeadline && !!p.recurring && !stopped;
  const canReclaim = isOwner && open && !beforeDeadline;
  const canTopUp = isOwner && open && beforeDeadline && !!p.recurring && !stopped;
  const canAddFees = isOwner && open && beforeDeadline && !!p.recurring && crossChain;
  const canRaiseFee = isOwner && open && beforeDeadline && crossChain;

  async function act(label: string, fn: () => Promise<Sent>) {
    setBusy(label);
    setNotice(null);
    try {
      const r = await fn();
      setNotice({ kind: "ok", message: `${label}: done.`, url: r.url });
      onChanged();
    } catch (e) {
      setNotice(e instanceof TxError
        ? { kind: "err", message: e.message, reason: e.reason }
        : { kind: "err", message: String((e as Error).message) });
    } finally {
      setBusy(null);
    }
  }

  async function raiseFee() {
    setBusy("Raise fee");
    setNotice(null);
    try {
      const quote = await quoteMaxFee(Number(p.destinationDomain));
      const current = BigInt(p.maxFeePerTransfer ?? "0");
      if (quote <= current) {
        setNotice({ kind: "ok", message: `The fee already set, ${usdc(String(current))}, covers Circle's current quote of ${usdc(String(quote))}.` });
        return;
      }
      // A one-off pulls the difference now so its single transfer stays covered.
      const extra = p.recurring ? 0n : quote - BigInt(p.feeAllowance ?? "0");
      setBusy(null);
      await act("Raise fee", () => actions.raiseMaxFee(signer!, vault!, p.id, quote, extra > 0n ? extra : 0n));
    } catch (e) {
      setNotice({ kind: "err", message: e instanceof TxError ? e.message : String((e as Error).message) });
    } finally {
      setBusy(null);
    }
  }

  const topUpBase = toBaseUnits(topUp);
  const feesBase = toBaseUnits(fees);
  const newDeadlineUnix = newDeadline ? Math.floor(new Date(newDeadline).getTime() / 1000) : NaN;
  const dest = V5_DESTINATIONS.find((d) => d.domain === Number(p.destinationDomain))?.name ?? `domain ${p.destinationDomain}`;
  const anyAction = canRelease || canReleasePeriod || canApprove || canAttest || isOwner;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <h3>{p.conditionType} policy {p.id} <span className="dim" style={{ fontSize: 13 }}>on v5, self-custody</span></h3>
        <div style={{ margin: "4px 0 12px" }}><span className={`pill ${p.effectiveStatus}`}>{p.effectiveStatus}</span>{stopped && <span className="pill Pending" style={{ marginLeft: 6 }}>Stopped</span>}</div>

        <div className="review">
          <KV k="Owner" v={`${shortAddr(p.owner)}${isOwner ? " (you)" : ""}`} />
          <KV k="Recipient" v={shortAddr(p.recipient)} />
          {!p.recurring && <KV k="Amount" v={usdc(p.amount)} />}
          {p.recurring && <KV k="Held for payouts" v={usdc(p.funded)} />}
          {p.conditionType === "Recurring" && <KV k="Schedule" v={`${usdc(p.amountPerPeriod)} every ${p.interval}s, ${p.periods ? `${p.periodsReleased} of ${p.periods} paid` : `${p.periodsReleased} paid, open-ended`}`} />}
          {p.conditionType === "Sweep" && <KV k="Sweep" v={`keep ${usdc(p.buffer)}, min ${usdc(p.minSweep)}, every ${p.interval}s`} />}
          {p.recurring && open && <KV k="Next due" v={relUnix(p.nextDue)} />}
          <KV k="Paid on" v={dest} />
          {crossChain && <KV k="Circle fee per transfer" v={usdc(p.maxFeePerTransfer)} />}
          {crossChain && <KV k="Fees held" v={usdc(p.feeAllowance)} />}
          {p.conditionType === "Timelock" && <KV k="Payable" v={relUnix(p.releaseTime)} />}
          {p.conditionType === "Approval" && <KV k="Approvals" v={`${p.approvalCount} of ${p.threshold}${roles.approver ? (roles.approved ? ", yours given" : ", yours needed") : ""}`} />}
          {p.conditionType === "Attestation" && <KV k="Attester" v={`${shortAddr(p.attester)}${isAttester ? " (you)" : ""}, ${p.attested ? "signed" : "awaiting"}`} />}
          {deadline > 0 && <KV k="Deadline" v={`${localStamp(deadline)}, ${relUnix(deadline)}`} />}
          {deadline > 0 && <KV k="Deadline on chain" v={utcStamp(deadline)} />}
        </div>

        {notice && (
          <div className={`notice ${notice.kind}`}>
            {notice.message}
            {notice.url && <> <a href={notice.url} target="_blank" rel="noopener">view tx</a></>}
            {notice.reason && <div className="reason">{notice.reason}</div>}
          </div>
        )}

        {problem && <div className="notice err">{problem}</div>}
        {paused && open && <div className="notice err">The vault's guardian has paused releases. The deadline moves out by the length of the pause.</div>}

        {!open ? (
          <p className="muted" style={{ fontSize: 13 }}>This policy is {p.status.toLowerCase()}. Nothing remains to do.</p>
        ) : !signer ? (
          !problem && <p className="hint">Connect your wallet on Arc to act. Anyone can release a policy once it is due; only its owner can cancel, stop, or reclaim it.</p>
        ) : (
          <div className="actions">
            {(canRelease || canReleasePeriod || canApprove || canAttest) && (
              <div className="row">
                {canRelease && <Btn label="Release" busy={busy} onClick={() => act("Release", () => actions.release(signer, vault!, p.id))} />}
                {canReleasePeriod && <Btn label="Release due period" busy={busy} onClick={() => act("Release due period", () => actions.releasePeriod(signer, vault!, p.id))} />}
                {canApprove && <Btn label="Approve" busy={busy} ghost onClick={() => act("Approve", () => actions.approve(signer, vault!, p.id))} />}
                {canAttest && <Btn label="Sign attestation" busy={busy} ghost onClick={() => act("Sign attestation", () => actions.attest(signer, vault!, p.id))} />}
              </div>
            )}
            {pull && <p className="hint">An oracle policy is released with a signed price, which Covenant's keeper fetches and submits when the rule is met.</p>}

            {isOwner && (
              <div className="group">
                <div className="lab">Yours, as owner</div>
                <div className="row">
                  {canCancel && <Btn label="Cancel and refund" busy={busy} ghost onClick={() => act("Cancel and refund", () => actions.cancel(signer, vault!, p.id))} />}
                  {canStop && <Btn label="Stop" busy={busy} ghost onClick={() => act("Stop", () => actions.stop(signer, vault!, p.id))} />}
                  {canReclaim && <Btn label="Reclaim" busy={busy} onClick={() => act("Reclaim", () => actions.reclaim(signer, vault!, p.id))} />}
                  {canRaiseFee && <Btn label="Raise fee to Circle's quote" busy={busy} ghost onClick={raiseFee} />}
                </div>
                {pull && beforeDeadline && <p className="hint">Cancelling an oracle policy needs a signed price showing its rule unmet; the app cannot do that yet.</p>}
                {canStop && <p className="hint">Stopping keeps the periods already due for the recipient and returns the rest to you now.</p>}

                {canTopUp && (
                  <Inline label="Top up (USDC)" value={topUp} set={setTopUp} placeholder="1.00"
                    action="Top up" busy={busy} disabled={!topUpBase}
                    onClick={() => act("Top up", () => actions.topUp(signer, vault!, p.id, BigInt(topUpBase!)))} />
                )}
                {canAddFees && (
                  <Inline label="Add to fees held (USDC)" value={fees} set={setFees} placeholder="0.25"
                    action="Add fees" busy={busy} disabled={!feesBase}
                    onClick={() => act("Add fees", () => actions.addFeeAllowance(signer, vault!, p.id, BigInt(feesBase!)))} />
                )}
                <div className="row" style={{ alignItems: "flex-end", gap: 10 }}>
                  <label className="field" style={{ flex: 1, margin: "10px 0" }}>
                    <span className="lab">Extend the deadline to</span>
                    <input type="datetime-local" value={newDeadline} onChange={(e) => setNewDeadline(e.target.value)} />
                    <div className="hint">Later only: a later deadline gives the recipient longer to be paid.{Number.isFinite(newDeadlineUnix) && <> Stored as <span className="mono">{utcStamp(newDeadlineUnix)}</span>.</>}</div>
                  </label>
                  <button className="btn ghost" style={{ marginBottom: 32 }} disabled={busy != null || !(newDeadlineUnix > Number(p.deadline ?? 0))}
                    onClick={() => act("Extend deadline", () => actions.extendDeadline(signer, vault!, p.id, BigInt(newDeadlineUnix)))}>
                    {busy === "Extend deadline" ? "Check your wallet…" : "Extend"}
                  </button>
                </div>
              </div>
            )}
            {!anyAction && <p className="hint">Nothing here for {shortAddr(signer.account)} right now. The keeper releases this policy when it is due.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v}</span></div>;
}

function Btn({ label, busy, onClick, ghost }: { label: string; busy: string | null; onClick: () => void; ghost?: boolean }) {
  return (
    <button className={`btn${ghost ? " ghost" : ""}`} disabled={busy != null} onClick={onClick}>
      {busy === label ? "Check your wallet…" : label}
    </button>
  );
}

function Inline({ label, value, set, placeholder, action, busy, disabled, onClick }: {
  label: string; value: string; set: (v: string) => void; placeholder: string; action: string; busy: string | null; disabled: boolean; onClick: () => void;
}) {
  return (
    <div className="row" style={{ alignItems: "flex-end", gap: 10 }}>
      <label className="field" style={{ flex: 1, margin: "10px 0" }}>
        <span className="lab">{label}</span>
        <input inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} />
      </label>
      <button className="btn ghost" style={{ marginBottom: 10 }} disabled={busy != null || disabled} onClick={onClick}>
        {busy === action ? "Check your wallet…" : action}
      </button>
    </div>
  );
}
