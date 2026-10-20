import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import {
  BatchSettlementEvmScheme,
  type BatchSettlementDepositStrategy,
  buildChannelConfig,
  computeChannelId,
  refundChannel,
} from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { FUJI_USDC } from "../shared/usdc.js";
import type { AppConfig } from "../config.js";

/**
 * Deposit DEPOSIT_ATOMIC at open; top up by DEPOSIT_TOPUP_ATOMIC mid-stream when short (spec §5.2).
 *
 * "Is this the opening deposit" must not be decided by `currentBalance === 0` -- a refund only returns the unconsumed part,
 * consumed-but-unclaimed funds stay in the channel, so a reused channel would always take the top-up branch
 * and DEPOSIT_ATOMIC would never apply again. Instead, "balance below a single top-up" marks an opening deposit.
 */
function configuredDepositStrategy(config: AppConfig): BatchSettlementDepositStrategy {
  return ({ currentBalance, minimumDepositAmount }) => {
    const minimum = BigInt(minimumDepositAmount);
    const opening = BigInt(currentBalance) < config.depositTopupAtomic;
    const target = opening ? config.depositAtomic : config.depositTopupAtomic;
    return (target > minimum ? target : minimum).toString();
  };
}

/** The package's DEFAULT_SALT. We don't override it, so we can derive the channelId ourselves. */
const DEFAULT_SALT = `0x${"0".repeat(64)}` as const;

/** The minimal requirements shape needed to derive a channelId. */
export type ChannelRequirements = {
  network: string;
  payTo: string;
  asset: string;
  extra?: { receiverAuthorizer?: string; withdrawDelay?: number };
};

export type WalletOverrides = Readonly<{
  /** Swap out the deposit policy. Contract tests use it to simulate "buyer stops topping up" and force the seller's deposit guard. */
  depositStrategy?: BatchSettlementDepositStrategy;
}>;

export function createWallet(config: AppConfig, overrides: WalletOverrides = {}) {
  const account = privateKeyToAccount(config.agentPrivateKey as `0x${string}`);
  // readContract is required: recoverChannel and corrective 402 recovery both rely on it to read on-chain state.
  // With a bare account, once the local channel record drifts from the chain (e.g. after a refund),
  // the buyer is stuck on 402 forever unless someone deletes the channel file by hand (spec §7).
  const publicClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(config.fujiRpcUrl),
  });
  const signer = toClientEvmSigner(account, publicClient as never);
  const storage = new FileClientChannelStorage({ directory: config.channelStorageDir });
  const scheme = new BatchSettlementEvmScheme(signer, {
    storage,
    depositStrategy: overrides.depositStrategy ?? configuredDepositStrategy(config),
  });

  const client = x402Client.fromConfig({
    schemes: [{ network: "eip155:*", client: scheme }],
    spendControls: {
      allowedAssets: [
        {
          network: FUJI_USDC.network,
          asset: FUJI_USDC.address,
          maxAmountPerPayment: config.pricePerTickAtomic.toString(),
        },
      ],
    },
  });

  return {
    account,
    signer,
    scheme,
    storage,
    client,
    httpClient: new x402HTTPClient(client),
    paidFetch: wrapFetchWithPayment(fetch, client),
    refund: () => refundChannel(scheme as any, `${config.serverBaseUrl}/tick`),

    /**
     * Drop the local channel record so the next payment rebuilds it from the chain via recoverChannel.
     *
     * The seller's idle refund (REFUND_IDLE_SECS) does not notify the buyer, and the package's corrective recovery
     * only recognizes two errors, cumulative_amount_mismatch and cumulative_amount_below_claimed --
     * the cumulative_exceeds_balance caused by a refund is not one of them. Without this path the buyer would cling to
     * a stale record saying "balance is still 50000" and stay stuck on 402 forever (spec §7).
     */
    forgetChannel: async (accepted: ChannelRequirements): Promise<void> => {
      const channelConfig = buildChannelConfig(
        { signer, salt: DEFAULT_SALT } as never,
        accepted as never,
      );
      await storage.delete(computeChannelId(channelConfig, accepted.network).toLowerCase());
    },
  };
}
