import type { AppState } from "../api";

const ADDR_URL = (a: string) => `https://testnet.arcscan.app/address/${a}`;

/**
 * The system page: what is deployed, who holds which authority, and what work is outstanding. The
 * keeper runs as its own process and does not report into this app, so rather than show a fabricated
 * "last run", the outstanding work is derived honestly from chain state: any policy the vault reports
 * as Releasable is a period or release the keeper (or the operator) can act on now.
 */
export function System({ state }: { state: AppState }) {
  const releasable = state.policies.filter((p) => p.effectiveStatus === "Releasable");

  return (
    <>
      <section>
        <div className="grid-label">Deployed contracts</div>
        <table>
          <thead><tr><th>Vault</th><th>Carries</th><th className="r">Address</th></tr></thead>
          <tbody>
            {state.vaults.map((v) => (
              <tr key={v.label}>
                <td><span className="vbadge">{v.label}</span></td>
                <td className="muted">{v.label === "v3" ? "recurring and sweep, plus the four base conditions and oracle" : "four base conditions and oracle"}</td>
                <td className="r"><a className="mono" href={ADDR_URL(v.address)} target="_blank" rel="noopener">{v.address}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <div className="grid-label">Outstanding work, derived from chain</div>
        {releasable.length === 0
          ? <div className="state-msg">Nothing is releasable right now.</div>
          : (
            <table>
              <thead><tr><th>Vault</th><th>#</th><th>Condition</th><th>Clears with</th></tr></thead>
              <tbody>
                {releasable.map((p) => (
                  <tr key={`${p.vault}-${p.id}`}>
                    <td><span className="vbadge">{p.vault}</span></td>
                    <td className="num">{p.id}</td>
                    <td>{p.conditionType}</td>
                    <td className="mono muted">{p.recurring ? "releasePeriod" : "release"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        <p className="hint" style={{ marginTop: 10 }}>The keeper runs as a separate process and triggers these permissionlessly. This list is what it would act on now, read live from the vault.</p>
      </section>

      <section>
        <div className="grid-label">Key authority, who can do what</div>
        <table>
          <thead><tr><th>Holder</th><th>Authority</th></tr></thead>
          <tbody>
            <AuthRow who="Treasury wallet (Circle)" what="Owner-only writes: create, fund, cancel, approveStalePeriod. Holds the entity secret, never the browser." />
            <AuthRow who="Executor wallet (Circle)" what="Settlement payouts after release. Never decides whether funds move." />
            <AuthRow who="Deployer EOA" what="Permissionless keeper calls: release and releasePeriod. Cannot move funds the vault would not." />
            <AuthRow who="Gateway delegate (dedicated EOA)" what="Signs Gateway burn intents only. Never doubles as the deployer." />
            <AuthRow who="Operator session" what="Gates every API write route. Reads stay public." />
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 10 }}>The contract is the source of truth: it enforces the condition onchain regardless of which key calls it.</p>
      </section>
    </>
  );
}

function AuthRow({ who, what }: { who: string; what: string }) {
  return <tr><td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{who}</td><td className="muted">{what}</td></tr>;
}
