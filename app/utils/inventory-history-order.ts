/**
 * inventory_levels/update の「ひとつ前の在庫数」を、通知の時刻の順で決める。
 *
 * Shopify は Webhook の届く順番を約束していない。届いた順に「いちばん新しい行」を前の行にすると、
 * 10 → A(8) → B(7) が B, A の順に届いたとき A=+1・B=-3 になる（正しくは A=-2・B=-1）。
 *
 * 決まり（docs/BUSINESS_RULES.md §6「在庫履歴の差分と通知の順番」）:
 * 1. 前の行は「その通知の時刻（updated_at）より前」の行だけから選ぶ。
 * 2. 古い通知があとから届いて行を書いたら、そのすぐ後ろの 1 行の差分を計算し直す。
 *    計算し直すのは、差分を「在庫数の差」から出している管理（admin_webhook）の行だけ。
 *    売上・返品・ロス・入出庫などの行の差分は業務の数（注文数・操作の数）なので変えない。
 *    すぐ後ろの行の数量がまだ決まっていない（null）ときも変えない（数量が決まるときに、その行より前の行で計算される）。
 *
 * ここは履歴（アプリの DB）だけを直す。Shopify の在庫数は変えない。
 */

type HistoryRow = {
  id: string;
  timestamp: Date | string;
  activity?: string | null;
  delta?: number | null;
  quantityAfter?: number | null;
};

type HistoryDb = {
  inventoryChangeLog: {
    // Prisma のクライアントをそのまま渡せるよう、メソッドの書き方にしている
    findFirst(args: any): Promise<HistoryRow | null>; // eslint-disable-line @typescript-eslint/no-explicit-any
    update(args: any): Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
};

export type HistoryScope = {
  shop: string;
  /** 数値 ID と GID の両方（売上・返品は GID で保存されているため） */
  inventoryItemIds: string[];
  locationIds: string[];
};

/** 差分を在庫数の差から出している行の種別。この種別の行だけ、前の行が変わったら差分を計算し直す。 */
export const QUANTITY_DERIVED_ACTIVITIES = ["admin_webhook"] as const;

function scopeWhere(scope: HistoryScope) {
  return {
    shop: scope.shop,
    inventoryItemId: { in: scope.inventoryItemIds },
    locationId: { in: scope.locationIds },
  };
}

/**
 * その通知の時刻より前の行から、ひとつ前の在庫数を探す。
 * いちばん近い行の数量が null なら、数量のある行まで遡る（従来どおり）。
 * DB の読み取りの失敗はそのまま投げる（呼び出し側の扱いを変えない）。
 */
export async function findPreviousQuantity(
  db: HistoryDb,
  scope: HistoryScope,
  observedAt: Date
): Promise<{ prevAvailable: number | null; prevLogId: string | null }> {
  const before = { timestamp: { lt: observedAt } };
  const prevLog = await db.inventoryChangeLog.findFirst({
    where: { ...scopeWhere(scope), ...before },
    orderBy: { timestamp: "desc" },
  });
  if (prevLog?.quantityAfter != null) {
    return { prevAvailable: prevLog.quantityAfter, prevLogId: prevLog.id };
  }
  const prevWithQty = await db.inventoryChangeLog.findFirst({
    where: { ...scopeWhere(scope), ...before, quantityAfter: { not: null } },
    orderBy: { timestamp: "desc" },
  });
  if (prevWithQty?.quantityAfter != null) {
    return { prevAvailable: prevWithQty.quantityAfter, prevLogId: prevWithQty.id };
  }
  return { prevAvailable: null, prevLogId: null };
}

/**
 * すぐ後ろの行の差分を、いま書いた数量から出し直すかを決める（純粋関数）。
 * @returns 書き換える delta。書き換えないときは null
 */
export function planSuccessorDelta(successor: HistoryRow | null, anchorQuantity: number | null): number | null {
  if (!successor || anchorQuantity == null) return null;
  if (!(QUANTITY_DERIVED_ACTIVITIES as readonly string[]).includes(String(successor.activity ?? ""))) return null;
  if (successor.quantityAfter == null) return null;
  const next = successor.quantityAfter - anchorQuantity;
  if (successor.delta === next) return null;
  return next;
}

/**
 * 時刻 observedAt に数量 quantity の行を書いた（または数量を決めた）あとに呼ぶ。
 * その時刻より後ろの最初の行が管理の行なら、差分を計算し直す。
 * 後ろに行が無い（ふつうの、順番どおりに届いた通知）なら何もしない。
 * @returns 書き換えた行の id と新しい delta。書き換えないときは null
 */
export async function repairSuccessorDelta(
  db: HistoryDb,
  scope: HistoryScope,
  observedAt: Date,
  quantity: number | null,
  excludeId?: string | null
): Promise<{ id: string; delta: number } | null> {
  if (quantity == null) return null;
  const successor = await db.inventoryChangeLog.findFirst({
    where: {
      ...scopeWhere(scope),
      timestamp: { gt: observedAt },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    orderBy: { timestamp: "asc" },
  });
  const delta = planSuccessorDelta(successor, quantity);
  if (delta == null || !successor) return null;
  await db.inventoryChangeLog.update({ where: { id: successor.id }, data: { delta } });
  return { id: successor.id, delta };
}
