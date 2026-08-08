import { useState } from "react";
import { api, ApiError, type Policy, type WriteResult } from "../api";
import { relUnix, shortAddr, toBaseUnits, usdc } from "../lib";

type Notice = { kind: "ok" | "err"; message: string; reason?: string; url?: string } | null;

/**
 * Policy detail with the lifecycle actions. Fund, approve, and release each go through the gated API;
 * a revert is surfaced verbatim. Actions appear only when the policy's state allows them, and only to
 * a signed-in operator.
 */
export function PolicyDetail({
  policy, signedIn, onClose, onChanged, onRequireLogin,
}: {
  policy: Policy; signedIn: boolean; onClose: () => void; onChanged: () => void; onRequireLogin: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [amount, setAmount] = useState("");

  const p = policy;
  const terminal = p.status === "Executed" || p.status === "Cancelled";
  const canFund = !terminal;
  const canApprove = p.conditionType === "Approval" && p.status === "Pending";
  const canRelease = p.effectiveStatus === "Releasable" && !p.recurring;

  async function run(action: string, fn: () => Promise<WriteResult>) {
    if (!signedIn) { onRequireLogin(); return; }
    setBusy(action);
    setNotice(null);
    try {
      const r = await fn();
      setNotice({ kind: "ok", message: `${action} sent.`, url: r.explorerUrl });
      onChanged();
    } catch (e) {
      if (e instanceof ApiError) setNotice({ kind: "err", message: e.message, reason: e.reason });
      else setNotice({ kind: "err", message: String((e as Error).message) });
    } finally {
      setBusy(null);
    }
  }

  const fundBase = toBaseUnits(amount);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <h3>{p.conditionType} policy {p.id} <span className="dim" style={{ fontSize: 13 }}>on {p.vault}</span></h3>
        <div style={{ margin: "4px 0 12px" }}><span className={`pill ${p.effectiveStatus}`}>{p.effectiveStatus}</span></div>

        <div className="review">
          <KV k="Recipient" v={shortAddr(p.recipient)} />
          <KV k="Amount" v={usdc(p.amount)} />
          <KV k="Funded" v={usdc(p.funded)} />
          <KV k="Payout" v={`${p.payoutCurrency}${Number(p.destinationDomain) !== 26 ? `, domain ${p.destinationDomain}` : " on Arc"}`} />
          {p.conditionType === "Timelock" && <KV k="Releasable" v={relUnix(p.releaseTime)} />}
          {p.conditionType === "Approval" && <KV k="Approvals" v={`${p.approvalCount} of ${p.threshold}`} />}
          {p.conditionType === "Attestation" && <KV k="Attester" v={`${shortAddr(p.attester)}, ${p.attested ? "signed" : "awaiting"}`} />}
          {p.conditionType === "Oracle" && <KV k="Rule" v={`USDC/USD ${p.comparator === "Lte" ? "≤" : "≥"} ${(Number(p.oracleThreshold) / 1e8).toFixed(3)}`} />}
        </div>

        {notice && (
          <div className={`notice ${notice.kind}`}>
            {notice.message}
            {notice.url && <> <a href={notice.url} target="_blank" rel="noopener">view tx</a></>}
            {notice.reason && <div className="reason">{notice.reason}</div>}
          </div>
        )}

        {terminal ? (
          <p className="muted" style={{ fontSize: 13 }}>This policy is {p.status.toLowerCase()}. No actions remain.</p>
        ) : (
          <>
            {canFund && (
              <div className="row" style={{ alignItems: "flex-end", gap: 10 }}>
                <label className="field" style={{ flex: 1, margin: "10px 0" }}>
                  <span className="lab">Fund amount</span>
                  <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.50" />
                </label>
                <button className="btn" style={{ marginBottom: 10 }} disabled={busy != null || !fundBase}
                  onClick={() => run("Fund", () => api.fund(p.id, fundBase!))}>
                  {busy === "Fund" ? "Funding…" : "Fund"}
                </button>
              </div>
            )}
            <div className="row" style={{ marginTop: 6 }}>
              {canApprove && (
                <button className="btn ghost" disabled={busy != null}
                  onClick={() => run("Approve", () => api.approve(p.id))}>
                  {busy === "Approve" ? "Approving…" : "Approve"}
                </button>
              )}
              {canRelease && (
                <button className="btn" disabled={busy != null}
                  onClick={() => run("Release", () => api.release(p.id))}>
                  {busy === "Release" ? "Releasing…" : "Release"}
                </button>
              )}
            </div>
            {!signedIn && <p className="hint" style={{ marginTop: 10 }}>Sign in as the operator to fund, approve, or release.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return <div className="kv"><span className="k">{k}</span><span className="v">{v}</span></div>;
}
