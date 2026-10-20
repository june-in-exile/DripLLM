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
 * Token data may contain newlines (\n\n would end the frame early) or lines starting with "event: " (forged events).
 * Standard SSE multi-line encoding: split on \n and emit one data: field per line; the agent-side parser rejoins them with \n.
 * credit/cut go through JSON.stringify (single line) and still use frame(), unaffected.
 */
function tokenFrame(token: string): string {
  return `event: token\n${token.split("\n").map((l) => `data: ${l}`).join("\n")}\n\n`;
}

/** Side table of Response objects — deliberately kept out of the Session record (spec §2.4). */
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
