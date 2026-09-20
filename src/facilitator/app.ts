import express, { type Express, type Request, type Response } from "express";

export type FacilitatorHttpApi = Readonly<{
  getSupported(): unknown;
  verify(paymentPayload: never, paymentRequirements: never): Promise<unknown>;
  settle(paymentPayload: never, paymentRequirements: never): Promise<unknown>;
}>;

type FacilitatorBody = {
  paymentPayload?: unknown;
  paymentRequirements?: unknown;
};

function requirePaymentBody(req: Request, res: Response): FacilitatorBody | null {
  const body = req.body as FacilitatorBody;
  if (!body?.paymentPayload || !body.paymentRequirements) {
    res.status(400).json({ error: "paymentPayload 與 paymentRequirements 為必填" });
    return null;
  }
  return body;
}

export function createFacilitatorApp(facilitator: FacilitatorHttpApi): Express {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));

  app.post("/verify", async (req, res) => {
    const body = requirePaymentBody(req, res);
    if (!body) return;
    try {
      res.json(
        await facilitator.verify(
          body.paymentPayload as never,
          body.paymentRequirements as never,
        ),
      );
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/settle", async (req, res) => {
    const body = requirePaymentBody(req, res);
    if (!body) return;
    try {
      res.json(
        await facilitator.settle(
          body.paymentPayload as never,
          body.paymentRequirements as never,
        ),
      );
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return app;
}
