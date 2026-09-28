import { useState } from "react";
import { connect, forget, switchToArc, useWallet } from "../v5/wallet";
import { ARC } from "../v5/chain";
import { shortAddr } from "../lib";
import { Icon } from "./Icon";

/**
 * The user's own wallet, in the top bar next to operator sign-in and separate from it. Operator
 * sign-in acts on the operator's vault through the API; a wallet acts on v5 policies directly, as
 * whoever the wallet says it is.
 */
export function WalletButton() {
  const w = useWallet();
  const [choosing, setChoosing] = useState(false);

  if (w.wallet && w.account) {
    return (
      <span className="walletbox">
        {w.chainId === ARC.id
          ? <span title={w.account}><span className="dot on" /> <span className="mono">{shortAddr(w.account)}</span></span>
          : <button className="btn small" onClick={switchToArc}>Switch to {ARC.name}</button>}
        <button className="btn ghost small" onClick={forget}>Disconnect</button>
        {w.error && <span className="wallet-err">{w.error}</span>}
      </span>
    );
  }

  if (!w.wallets.length) {
    return <span className="dim" title="Install a browser wallet such as MetaMask or Rabby to sign from your own account">No wallet found</span>;
  }

  const pick = (i: number) => { setChoosing(false); void connect(w.wallets[i]!); };
  return (
    <span className="walletbox">
      <button className="btn ghost small" disabled={w.connecting}
        onClick={() => (w.wallets.length === 1 ? pick(0) : setChoosing((c) => !c))}>
        <Icon name="wallet" /> {w.connecting ? "Check your wallet…" : "Connect wallet"}
      </button>
      {choosing && (
        <span className="wallet-menu" role="menu">
          {w.wallets.map((x, i) => (
            <button key={x.id} role="menuitem" onClick={() => pick(i)}>
              {x.icon && <img src={x.icon} alt="" width={16} height={16} />} {x.name}
            </button>
          ))}
        </span>
      )}
      {w.error && <span className="wallet-err">{w.error}</span>}
    </span>
  );
}
