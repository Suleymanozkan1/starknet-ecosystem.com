/** In-app notifications (push delivery is performed by the notification worker via Device.pushToken). */
import type { DbOrTx } from "@nebula/database";
import { toJsonValue } from "./json.js";

export async function notify(
  db: DbOrTx,
  userId: string,
  type: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.notification.create({ data: { userId, type, title, body, data: toJsonValue(data) } });
}
