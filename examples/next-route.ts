/**
 * Sketch for Next.js App Router — copy into app/api/orders/route.ts
 */

import { Idempotency, protect } from "oncekey";
import { SqliteStore } from "oncekey/sqlite";

const store = new SqliteStore({ path: "data/oncekey.sqlite" });
const idempotency = new Idempotency({ store });

export const POST = protect(
  {
    idempotency,
    required: true,
    scope: () => "default",
  },
  async (request) => {
    const payload = await request.json();
    void payload;
    return Response.json({ id: "ord_1" }, { status: 201 });
  },
);
