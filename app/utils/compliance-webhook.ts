// 必須コンプライアンス Webhook（customers/data_request, customers/redact, shop/redact）の処理。
// https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
//
// authenticate.webhook() が返す topic は "SHOP_REDACT" のような大文字＋アンダースコアの形
// （https://shopify.dev/docs/api/shopify-app-remix/latest/guide-webhooks の switch 例）。
// ヘッダーそのままの "shop/redact" の形が来ても同じに扱えるよう、両方を受ける。

export const COMPLIANCE_TOPICS = {
  CUSTOMERS_DATA_REQUEST: "CUSTOMERS_DATA_REQUEST",
  CUSTOMERS_REDACT: "CUSTOMERS_REDACT",
  SHOP_REDACT: "SHOP_REDACT",
} as const;

/** "shop/redact" / "SHOP_REDACT" / " Shop/Redact " などを "SHOP_REDACT" にそろえる */
export function normalizeWebhookTopic(topic: unknown): string {
  return String(topic ?? "")
    .trim()
    .toUpperCase()
    .replace(/[/.\s-]+/g, "_");
}

type DeleteMany = (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;

/** この処理で使う Prisma のテーブルだけを持つ型（テストでは偽物を渡す） */
export type ComplianceDb = {
  session: { deleteMany: DeleteMany };
  inventoryChangeLog: { deleteMany: DeleteMany };
  inventoryChangeEvent: { deleteMany: DeleteMany };
  inventoryCountDocument: { deleteMany: DeleteMany };
  orderPendingLocation: { deleteMany: DeleteMany };
  refundPendingLocation: { deleteMany: DeleteMany };
  appUsageReport: { deleteMany: DeleteMany };
};

export type ComplianceResult = {
  status: number;
  handled: string | null;
  deleted: Record<string, number>;
  /** 消さなかった理由（no_shop / inhouse / reinstalled） */
  skipped?: string;
};

type CustomersRedactPayload = {
  shop_domain?: string;
  orders_to_redact?: Array<number | string>;
};

type ShopRedactPayload = { shop_domain?: string };

export async function handleComplianceWebhook(args: {
  topic: unknown;
  shop?: string | null;
  payload?: unknown;
  db: ComplianceDb;
  /** 消す店について、サーバーが公開用か自社用か。shop/redact は public のときだけ消す（消す店と同じ値で呼ぶ） */
  getDistribution: (shop: string) => "public" | "inhouse";
  /** true = 店にまだアプリが入っている（shop/redact で消さない）。確かめられないときは投げる */
  isShopStillInstalled: (shop: string) => Promise<boolean>;
  log?: (...items: unknown[]) => void;
}): Promise<ComplianceResult> {
  const { shop, db } = args;
  const log = args.log ?? console.log;
  const normalized = normalizeWebhookTopic(args.topic);
  const deleted: Record<string, number> = {};

  switch (normalized) {
    case COMPLIANCE_TOPICS.CUSTOMERS_DATA_REQUEST: {
      // 顧客のメール・電話・氏名などは保存していない。店に渡すデータはない。
      log(`[compliance] customers/data_request for ${shop}`);
      return { status: 200, handled: normalized, deleted };
    }

    case COMPLIANCE_TOPICS.CUSTOMERS_REDACT: {
      // 顧客の削除依頼: その顧客の注文につながる一時データ（売上・返品の候補）を消す。
      const body = (args.payload ?? {}) as CustomersRedactPayload;
      const shopDomain = body.shop_domain || shop || "";
      const orderIds = (body.orders_to_redact ?? []).map((id) => String(id)).filter(Boolean);
      if (shopDomain && orderIds.length > 0) {
        const where = { shop: shopDomain, orderId: { in: orderIds } };
        deleted.orderPendingLocation = (await db.orderPendingLocation.deleteMany({ where })).count;
        deleted.refundPendingLocation = (await db.refundPendingLocation.deleteMany({ where })).count;
      }
      log(`[compliance] customers/redact for ${shopDomain}`, deleted);
      return { status: 200, handled: normalized, deleted };
    }

    case COMPLIANCE_TOPICS.SHOP_REDACT: {
      // アンインストールの 48 時間後に届く。この店の行をすべてのテーブルから消す。
      // 明細（InventoryChangeEventLine / InventoryCountDocumentChunk）は DB の ON DELETE CASCADE で一緒に消える。
      // 何度届いても同じ結果になる（消すだけなので）。
      const body = (args.payload ?? {}) as ShopRedactPayload;
      const shopDomain = body.shop_domain || shop || "";
      if (!shopDomain) {
        log("[compliance] shop/redact without shop domain; nothing deleted");
        return { status: 200, handled: normalized, deleted, skipped: "no_shop" };
      }
      // 自社用（Ciara）のアプリでは消さない（T が決めるまでの既定）。必須 webhook が要るのは App Store のアプリ。
      if (args.getDistribution(shopDomain) !== "public") {
        log(`[compliance] shop/redact for ${shopDomain}: in-house app; skipped delete`);
        return { status: 200, handled: normalized, deleted, skipped: "inhouse" };
      }
      // 48 時間のうちに入れ直した店なら、入れ直したあとのデータを消さない。
      if (await args.isShopStillInstalled(shopDomain)) {
        log(`[compliance] shop/redact for ${shopDomain}: app is installed again; skipped delete`);
        return { status: 200, handled: normalized, deleted, skipped: "reinstalled" };
      }
      const where = { shop: shopDomain };
      deleted.inventoryChangeEvent = (await db.inventoryChangeEvent.deleteMany({ where })).count;
      deleted.inventoryCountDocument = (await db.inventoryCountDocument.deleteMany({ where })).count;
      deleted.inventoryChangeLog = (await db.inventoryChangeLog.deleteMany({ where })).count;
      deleted.orderPendingLocation = (await db.orderPendingLocation.deleteMany({ where })).count;
      deleted.refundPendingLocation = (await db.refundPendingLocation.deleteMany({ where })).count;
      // 10 か所を超えた分の報告の記録（D15）。個人の情報は無いが、この店のデータなので一緒に消す（D19【案】）。
      // app/uninstalled では消さない（48 時間のうちに入れ直すと同じ期間の記録が要る）。
      // 消したあとに入れ直しても、Shopify 側の idempotency_key は永久に重複を止めるので 2 回は請求されない。
      deleted.appUsageReport = (await db.appUsageReport.deleteMany({ where })).count;
      deleted.session = (await db.session.deleteMany({ where })).count;
      log(`[compliance] shop/redact for ${shopDomain}`, deleted);
      return { status: 200, handled: normalized, deleted };
    }

    default: {
      log(`[compliance] unexpected topic ${String(args.topic)} for ${shop}`);
      return { status: 200, handled: null, deleted };
    }
  }
}
