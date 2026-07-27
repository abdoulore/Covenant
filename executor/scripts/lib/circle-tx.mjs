/**
 * Thin wrapper over Circle developer-controlled wallet contract execution.
 *
 * Circle's transaction API is an async state machine: the create call returns an id, and the
 * transaction reaches a terminal state some time later. Every helper here polls to a terminal
 * state before returning, so callers can write straight-line code and still know that step N
 * landed onchain before step N+1 is submitted. That ordering matters: PolicyVault rejects a
 * deposit before its ERC-20 approval, and a release before its condition.
 */

/**
 * Both COMPLETE and CONFIRMED mean the transaction made it into a block.
 *
 * Circle's docs are explicit that CONFIRMED may be omitted or arrive out of order, and that on
 * instant finality chains such as Arc the state goes straight from SENT to COMPLETE, skipping
 * CONFIRMED entirely. Waiting specifically for COMPLETE would work on Arc and hang elsewhere;
 * waiting specifically for CONFIRMED would hang on Arc. Accept either.
 */
const SUCCESS = new Set(["COMPLETE", "CONFIRMED"]);
const FAILURE = new Set(["FAILED", "DENIED", "CANCELLED"]);

const DEFAULT_FEE = { type: "level", config: { feeLevel: "MEDIUM" } };

/** Poll until the transaction reaches a terminal state. Throws on any non-success terminal. */
export async function waitForTransaction(client, id, { timeoutMs = 180_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let warnedStuck = false;

  for (;;) {
    const res = await client.getTransaction({ id });
    const tx = res.data?.transaction;
    const state = tx?.state;

    if (SUCCESS.has(state)) return tx;

    if (FAILURE.has(state)) {
      // errorReason is the category (ESTIMATION_ERROR); errorDetails carries the actual revert
      // string. Reporting only the former turns every contract revert into the same useless
      // message, so surface both.
      const parts = [tx.errorReason, tx.errorDetails].filter(Boolean);
      throw new Error(
        `Circle transaction ${id} ended ${state}: ${parts.join(" - ") || "no reason given"}`,
      );
    }

    /**
     * STUCK is not terminal. The transaction reached the mempool but could not be included, and
     * Circle allows accelerating it. Keep polling, but say so once, because the default outcome
     * otherwise is a silent wait to timeout with no indication that intervention is possible.
     */
    if (state === "STUCK" && !warnedStuck) {
      warnedStuck = true;
      console.warn(`  Circle transaction ${id} is STUCK. It can be accelerated; continuing to poll.`);
    }

    if (Date.now() > deadline) {
      throw new Error(`Circle transaction ${id} still ${state ?? "unknown"} after ${timeoutMs}ms`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Execute a contract function and wait for it to land.
 *
 * @returns {Promise<{txHash: string, id: string, state: string}>}
 */
export async function executeContract(client, { walletId, contractAddress, signature, params, label }) {
  const created = await client.createContractExecutionTransaction({
    walletId,
    contractAddress,
    abiFunctionSignature: signature,
    abiParameters: params,
    fee: DEFAULT_FEE,
  });

  const id = created.data?.id;
  if (!id) throw new Error(`createContractExecutionTransaction returned no id for ${label ?? signature}`);

  const tx = await waitForTransaction(client, id);
  return { txHash: tx.txHash, id, state: tx.state };
}

/**
 * Execute a call that is expected to revert, and confirm that it did.
 *
 * Needed because the canary must demonstrate the failure path, not just the happy path. A release
 * attempted before its condition is met has to be shown failing onchain. Treating the revert as
 * the success case is the whole point, so a transaction that unexpectedly succeeds is the error.
 */
export async function executeContractExpectingRevert(client, args) {
  try {
    const result = await executeContract(client, args);
    throw new Error(
      `Expected ${args.label ?? args.signature} to revert, but it succeeded in ${result.txHash}. ` +
        `The condition gate is not working.`,
    );
  } catch (err) {
    if (String(err.message).startsWith("Expected ")) throw err;
    return { reverted: true, reason: err.message };
  }
}
