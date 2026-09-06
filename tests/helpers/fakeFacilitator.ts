import express from "express";
import type { Server } from "node:http";

/**
 * syncFacilitatorOnStart 預設為 true(第 5 個位置參數),
 * middleware 啟動時會呼叫 /supported —— 未實作此端點則 server 起不來。
 */
export async function startFakeFacilitator(port = 0): Promise<{ url: string; close(): Promise<void>; settleCount(): number }> {
  let settles = 0;
  const app = express();
  app.use(express.json());

  app.get("/supported", (_req, res) => {
    res.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:43113" }],
    });
  });

  app.post("/verify", (_req, res) => {
    res.json({ isValid: true, payer: undefined });
  });

  app.post("/settle", (_req, res) => {
    settles += 1;
    res.json({
      success: true,
      transaction: `0xfaketx${settles}`,
      network: "eip155:43113",
      // payer 刻意不回填 —— 驗證我們不依賴這個 optional 欄位(spec §2.6)
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    url: `http://localhost:${actualPort}`,
    settleCount: () => settles,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
