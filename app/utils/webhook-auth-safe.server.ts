// authenticateWebhookSafely を本物の authenticate.webhook と秘密の値につなぐ。
import { authenticate } from "../shopify.server";
import { authenticateWebhookSafely } from "./webhook-auth-safe";

export function authenticateWebhook(request: Request) {
  return authenticateWebhookSafely(request, {
    authenticateWebhook: (r) => authenticate.webhook(r),
    apiSecret: process.env.SHOPIFY_API_SECRET || "",
  });
}
