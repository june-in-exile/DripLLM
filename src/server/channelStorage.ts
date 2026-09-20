import type { ChannelStorage } from "@x402/evm/batch-settlement/server";
import { FileChannelStorage } from "@x402/evm/batch-settlement/server/file-storage";

export function createServerChannelStorage(rootDir: string): ChannelStorage {
  return new FileChannelStorage({ directory: rootDir });
}
