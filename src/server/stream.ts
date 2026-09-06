import type { Response } from "express";

export type CutPayload = Readonly<{
  sessionId: string;
  reason: "payment_lapsed";
  tickCount: number;
  spentAtomic: string;
}>;

export type CreditPayload = Readonly<{
  remainingMs: number;
  grace: boolean;
  tickCount: number;
  spentAtomic: string;
}>;

export type StreamHub = Readonly<{
  attach(sessionId: string, res: Response): boolean;
  detach(sessionId: string): void;
  has(sessionId: string): boolean;
  size(): number;
  sendToken(sessionId: string, token: string): void;
  sendCredit(sessionId: string, payload: CreditPayload): void;
  cut(sessionId: string, payload: CutPayload): void;
}>;

function frame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/**
 * token 資料可能含換行(\n\n 會提前終止 frame),或以 "event: " 開頭的行(偽造事件)。
 * 標準 SSE 多行編碼:以 \n 切分,每行發出一個 data: 欄位;agent 端 parser 以 \n 接合還原。
 * credit/cut 走 JSON.stringify(單行),仍用 frame(),不受影響。
 */
function tokenFrame(token: string): string {
  return `event: token\n${token.split("\n").map((l) => `data: ${l}`).join("\n")}\n\n`;
}

/** Response 物件的副表 —— 刻意不放進 Session 記錄(spec §2.4)。 */
export function createStreamHub(): StreamHub {
  const connections = new Map<string, Response>();

  const send = (sessionId: string, event: string, data: string): void => {
    connections.get(sessionId)?.write(frame(event, data));
  };

  return Object.freeze({
    attach(sessionId: string, res: Response): boolean {
      if (connections.has(sessionId)) return false;
      connections.set(sessionId, res);
      return true;
    },
    detach(sessionId: string): void {
      connections.delete(sessionId);
    },
    has: (sessionId: string) => connections.has(sessionId),
    size: () => connections.size,
    sendToken: (sessionId: string, token: string) => {
      connections.get(sessionId)?.write(tokenFrame(token));
    },
    sendCredit: (sessionId: string, payload: CreditPayload) =>
      send(sessionId, "credit", JSON.stringify(payload)),
    cut(sessionId: string, payload: CutPayload): void {
      const res = connections.get(sessionId);
      if (!res) return;
      res.write(frame("cut", JSON.stringify(payload)));
      res.end();
      connections.delete(sessionId);
    },
  });
}
