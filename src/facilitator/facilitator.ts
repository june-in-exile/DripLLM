import { x402Facilitator } from "@x402/core/facilitator";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import type { AppConfig } from "../config.js";
import { FUJI_USDC } from "../shared/usdc.js";

/**
 * Assembles the self-hosted facilitator (spec §2.7).
 *
 * Split out as its own function so the shape of `/supported` can be tested — it doesn't touch the network,
 * but if it's wrong the resource server deems the whole payload invalid during startup sync, and every payment becomes a 502.
 */
export function buildFacilitator(config: AppConfig): x402Facilitator {
  const account = privateKeyToAccount(config.facilitatorPrivateKey as `0x${string}`);
  const client = createWalletClient({
    account,
    chain: avalancheFuji,
    // viem's default polling interval on Fuji is 2000ms (the chain has no blockTime, so it falls back to 4000ms and halves it).
    pollingInterval: config.facilitatorPollingMs,
    transport: http(config.fujiRpcUrl),
  }).extend(publicActions);

  // toFacilitatorEvmSigner's getAddresses() reads the flat client.address,
  // but viem's WalletClient only has client.account.address — without this line,
  // the signers in /supported become [null].
  const signerClient = { ...client, address: account.address };
  // viem 2.56's signTypedData generics are narrower than x402's structural signer interface; the runtime method set is the same.
  // The cast only bridges that gap; address is already filled in explicitly above.
  const signer = toFacilitatorEvmSigner(
    signerClient as unknown as Parameters<typeof toFacilitatorEvmSigner>[0],
    { confirmationTimeoutMs: config.facilitatorConfirmationTimeoutMs },
  );

  return new x402Facilitator().register(
    FUJI_USDC.network,
    new BatchSettlementEvmScheme(signer, account),
  );
}
