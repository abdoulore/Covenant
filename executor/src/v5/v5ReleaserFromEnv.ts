/**
 * Real wiring for the v5 releaser: viem against Arc, a dedicated keeper key, Hermes for prices.
 *
 * The key is its own, V5_KEEPER_PRIVATE_KEY, not the treasury's or the deployer's. Releasing a v5
 * policy needs no authority at all, only gas, so the key should hold a little USDC for gas and
 * nothing else: losing it costs that and no more.
 */
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, http, parseAbi,
  type PublicClient, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor, ARC_DOMAIN } from "../config.js";
import { V5_ABI, V5_ERRORS } from "../chain/policyVaultV5.js";
import { HermesPythClient } from "../oracle/HermesPythClient.js";
import { V5Reader } from "./V5Reader.js";
import { V5Releaser, type SendOutcome, type V5Call, type V5Chain } from "./V5Releaser.js";

const ABI = [...V5_ABI, ...V5_ERRORS];
const ADAPTER_ABI = parseAbi(["function quoteFee(bytes proof) view returns (uint256)"]);

export class ViemV5Chain implements V5Chain {
  constructor(
    private readonly client: PublicClient,
    private readonly wallet: WalletClient,
    private readonly vault: `0x${string}`,
  ) {}

  async trySend(call: V5Call): Promise<SendOutcome> {
    try {
      const { request } = await this.client.simulateContract({
        account: this.wallet.account!,
        address: this.vault,
        abi: ABI,
        functionName: call.functionName,
        args: call.args as any,
        ...("value" in call ? { value: call.value } : {}),
      } as any);
      const hash = await this.wallet.writeContract(request as any);
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") return { sent: false, reason: `reverted onchain in ${hash}` };
      return { sent: true, hash };
    } catch (err) {
      // A contract refusal is an answer; anything else (network, RPC) is a failure for the caller.
      const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
      const name = (revert as ContractFunctionRevertedError | null)?.data?.errorName;
      if (name) return { sent: false, reason: name };
      throw err;
    }
  }

  async proofFee(adapter: `0x${string}`, proof: `0x${string}`): Promise<bigint> {
    return (await this.client.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "quoteFee", args: [proof] })) as bigint;
  }
}

export interface V5ReleaserEnv {
  rpcUrl: string;
  vault: `0x${string}`;
  keeperKey: `0x${string}`;
  log?: (message: string) => void;
}

export function v5ReleaserFromEnv(opts: V5ReleaserEnv): { releaser: V5Releaser; keeper: `0x${string}` } {
  const arc = chainFor(ARC_DOMAIN);
  const chain = {
    id: arc.chainId, name: arc.name, nativeCurrency: arc.nativeCurrency,
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  };
  const client = createPublicClient({ chain, transport: http(opts.rpcUrl, { retryCount: 3, retryDelay: 1_500, timeout: 30_000 }) }) as PublicClient;
  const account = privateKeyToAccount(opts.keeperKey);
  const wallet = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });
  const hermes = new HermesPythClient();
  const releaser = new V5Releaser({
    reader: new V5Reader(client, opts.vault),
    chain: new ViemV5Chain(client, wallet, opts.vault),
    proofs: {
      proof: async (feedId) => {
        const { updateData } = await hermes.fetch(feedId);
        if (!updateData[0]) throw new Error("Hermes returned no update blob");
        return updateData[0];
      },
    },
    ...(opts.log ? { log: opts.log } : {}),
  });
  return { releaser, keeper: account.address };
}
