import { Hono } from "hono";
import { platformBrand } from "@dravonix/config";

export interface HealthDeps {
  checkDatabase: () => Promise<boolean>;
}

export function healthRoutes(deps: HealthDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", product: platformBrand.productName }));

  app.get("/ready", async (c) => {
    const databaseOk = await deps.checkDatabase();
    if (!databaseOk) {
      return c.json({ status: "not_ready", database: false }, 503);
    }
    return c.json({ status: "ready", database: true });
  });

  return app;
}
