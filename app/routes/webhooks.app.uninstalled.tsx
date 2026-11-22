import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhook } from "../utils/webhook-auth-safe.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticateWebhook(request);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  // 期限付きのトークンでは、外した店のトークンを更新できずに session が無いことがある。そのときも消す。
  if (shop) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
