import { useState } from "react";
import { api, ApiError, type Policy } from "../api";
import { shortAddr, usdc } from "../lib";

/**
 * The approvals queue: approval-type policies still short of their threshold. The operator approves
 * from here, or, as the app states honestly, any authorized approver can call the contract directly,
 * since approve is permissionless to the named approvers.
 */
export function Approvals({
  policies, signedIn, onChanged, onRequireLogin,
}: {
  policies: Policy[]; signedIn: boolean; onChanged: () => void; onRequireLogin: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; kind: "ok" | "err"; text: string; url?: string } | null>(null);

  const pending = policies.filter(
    (p) => p.conditionType === "Approval" && p.status === "Pending" && Number(p.approvalCount) < Number(p.threshold),
  );

  async function approve(p: Policy) {
    if (!signedIn) { onRequireLogin(); return; }
    setBusy(p.id);
    setNotice(null);
    try {
      const r = await api.approve(p.id);
      setNotice({ id: p.id, kind: "ok", text: "Approval sent.", url: r.explorerUrl });
      onChanged();
    } catch (e) {
      const msg = e instanceof ApiError ? (e.reason ?? e.message) : String((e as Error).message);
      setNotice({ id: p.id, kind: "err", text: msg });
    } finally {
      setBusy(null);
    }
  }

  if (!pending.length) {
    return <div className="state-msg">No approval policies are awaiting signatures.</div>;
  }

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Approve from here, or call the contract directly: <span className="mono">approve(policyId)</span> is permissionless to the named approvers, so the queue is a convenience, not the only path.
      </p>
      <table>
        <thead><tr><th>Vault</th><th>#</th><th>Recipient</th><th>Amount</th><th>Approvals</th><th className="r">Action</th></tr></thead>
        <tbody>
          {pending.map((p) => (
            <tr key={`${p.vault}-${p.id}`}>
              <td><span className="vbadge">{p.vault}</span></td>
              <td className="num">{p.id}</td>
              <td className="mono">{shortAddr(p.recipient)}</td>
              <td className="num">{usdc(p.amount)}</td>
              <td className="num">{p.approvalCount} of {p.threshold}</td>
              <td className="r">
                <button className="btn small" disabled={busy != null} onClick={() => approve(p)}>
                  {busy === p.id ? "Approving…" : "Approve"}
                </button>
                {notice?.id === p.id && (
                  <div className={notice.kind === "ok" ? "dim" : ""} style={{ fontSize: 11.5, marginTop: 4, color: notice.kind === "err" ? "var(--bad)" : undefined }}>
                    {notice.text}{notice.url && <> <a href={notice.url} target="_blank" rel="noopener">tx</a></>}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!signedIn && <p className="hint" style={{ marginTop: 12 }}>Sign in as the operator to approve.</p>}
    </>
  );
}
