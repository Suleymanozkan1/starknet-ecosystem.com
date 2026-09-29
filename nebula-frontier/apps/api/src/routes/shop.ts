import type { FastifyInstance } from "fastify";
import type { Currency, ShopProductDto } from "@nebula/shared";
import { purchaseRequestSchema } from "@nebula/validation";
import type { ApiMetrics } from "../lib/metrics.js";
import { purchaseProduct } from "../lib/purchase.js";

export default async function shopRoutes(app: FastifyInstance, opts: { metrics: ApiMetrics }): Promise<void> {
  const { db } = app;

  app.get("/api/shop", async () => {
    const rows = await db.shopProduct.findMany({ where: { active: true }, orderBy: [{ category: "asc" }, { price: "asc" }] });
    const products: (ShopProductDto & { stock: number | null; limitPerUser: number | null; purchaseFlow: "LEDGER" | "DEPOSIT" })[] = rows.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      description: p.description,
      currency: p.currency as Currency,
      price: p.price.toString(),
      requiredLevel: p.requiredLevel,
      featured: p.featured,
      grants: p.grants,
      stock: p.stock,
      limitPerUser: p.limitPerUser,
      purchaseFlow: p.currency === "SOL" || p.currency === "NEBX" ? "DEPOSIT" : "LEDGER",
    }));
    return { products };
  });

  app.get("/api/shop/purchases", { preHandler: app.authenticate }, async (req) => {
    const rows = await db.purchase.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: "desc" }, take: 100 });
    return {
      purchases: rows.map((p) => ({
        id: p.id, productId: p.productId, quantity: p.quantity, currency: p.currency, totalPrice: p.totalPrice.toString(),
        status: p.status, createdAt: p.createdAt.toISOString(),
      })),
    };
  });

  app.post("/api/shop/purchase", { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.purchase } }, async (req) => {
    // Any client-supplied price/currency is stripped by the schema and never read.
    const body = app.parse(purchaseRequestSchema, req.body);
    const res = await purchaseProduct(db, req.user.id, body);
    if (!res.duplicate) {
      const p = await db.purchase.findUnique({ where: { id: res.purchaseId }, select: { currency: true } });
      opts.metrics.purchases.inc({ currency: p?.currency ?? "UNKNOWN" });
      app.analytics.track("PURCHASE", req.user.id, { purchaseId: res.purchaseId, productId: body.productId, quantity: body.quantity, currency: p?.currency ?? null });
    }
    return { purchaseId: res.purchaseId, balances: res.balances, duplicate: res.duplicate };
  });
}
