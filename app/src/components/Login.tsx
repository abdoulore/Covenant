import { useState } from "react";
import { api, ApiError } from "../api";

/** Operator login. Exchanges the operator secret for a session cookie; the secret never persists. */
export function Login({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.login(secret);
      setSecret("");
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 401 ? "That operator secret was not accepted." : String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <h3>Operator sign in</h3>
        <p className="muted" style={{ marginTop: 4 }}>Writes are gated by the operator session. Reads stay open.</p>
        <form onSubmit={submit}>
          <label className="field">
            <span className="lab">Operator secret</span>
            <input type="password" autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="•••••••••" />
          </label>
          {err && <div className="notice err">{err}</div>}
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={busy || !secret}>{busy ? "Signing in…" : "Sign in"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
