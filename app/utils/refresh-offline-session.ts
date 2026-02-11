// app/utils/refresh-offline-session.ts
// オフラインアクセストークンの期限切れ時にリフレッシュする共通処理（Cron・api/log-inventory-change で使用）
import db from "../db.server";

/** 期限切れの約5分前も「更新する」とみなす（単位: ミリ秒） */
const WITHIN_MS_OF_EXPIRY = 5 * 60 * 1000;

/**
 * オフラインアクセストークンが期限切れ（またはまもなく期限切れ）の場合、
 * リフレッシュトークンで更新して DB に保存する。
 * 更新に成功したら true、不要または失敗時は false。
 */
export async function refreshOfflineSessionIfNeeded(
  sessionId: string,
  shop: string,
  expires: Date | null,
  refreshTokenValue: string | null
): Promise<boolean> {
  if (!refreshTokenValue) return false;
  const now = Date.now();
  const expiresMs = expires ? expires.getTime() : 0;
  if (expiresMs > now + WITHIN_MS_OF_EXPIRY) return false;

  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) return false;

  const body = new URLSearchParams({
    client_id: apiKey,
    client_secret: apiSecret,
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
  });

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    console.error(`[refresh-offline-session] Token refresh failed for ${shop}:`, json);
    return false;
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  };

  const newExpires = new Date(now + data.expires_in * 1000);
  const newRefreshExpires = data.refresh_token_expires_in
    ? new Date(now + data.refresh_token_expires_in * 1000)
    : null;

  await db.session.update({
    where: { id: sessionId },
    data: {
      accessToken: data.access_token,
      expires: newExpires,
      refreshToken: data.refresh_token ?? refreshTokenValue,
      refreshTokenExpires: newRefreshExpires,
    },
  });

  return true;
}
