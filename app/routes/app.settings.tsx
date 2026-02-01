// app/routes/app.settings.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { authenticate } from "../shopify.server";

export type LocationNode = { id: string; name: string };

export type DestinationGroup = {
  id: string;
  name: string;
  locationIds: string[]; // ✅ origin も必ず含める（POS側で所属グループ判定に使う）
};

export type CarrierOption = {
  id: string;
  label: string; // POSに出す表示名（例：ヤマト運輸）
  company: string; // Shopifyプリセットの company（例：Yamato (JA)）
  sortOrder?: number; // 表示順（小さい順、デフォルト: 999）
};

export type SettingsV1 = {
  version: 1;
  destinationGroups?: DestinationGroup[]; // 非推奨（後方互換性のため残す）
  carriers: CarrierOption[];
  // 追加設定項目
  visibleLocationIds?: string[]; // 表示ロケーション選択設定（空配列=全ロケーション表示）
  outbound?: {
    allowForceCancel?: boolean; // 強制キャンセル処理許可（デフォルト: true）
    historyInitialLimit?: number; // 出庫履歴（Transfer）初回件数。API上限250、推奨100
  };
  inbound?: {
    allowOverReceive?: boolean; // 過剰入庫許可（デフォルト: true）
    allowExtraReceive?: boolean; // 予定外入庫許可（デフォルト: true）
    listInitialLimit?: number; // 入庫リスト（Transfer）初回件数。API上限250、推奨100
  };
  productList?: {
    initialLimit?: number; // 商品リスト（追加行表示）初回件数。lineItems上限250、推奨250
  };
  searchList?: {
    initialLimit?: number; // 検索リスト（検索結果表示）初回件数。productVariants上限50、推奨50
  };
};

const NS = "stock_transfer_pos";
const KEY = "settings_v1";

// 日本の配送会社のデフォルト設定
const DEFAULT_CARRIERS_JP: CarrierOption[] = [
  { id: "car_yamato", label: "ヤマト運輸", company: "Yamato (JA)", sortOrder: 1 },
  { id: "car_sagawa", label: "佐川急便", company: "Sagawa (JA)", sortOrder: 2 },
  { id: "car_japanpost", label: "日本郵便", company: "Japan Post (JA)", sortOrder: 3 },
  { id: "car_ecohai", label: "エコ配", company: "エコ配", sortOrder: 4 },
];

function defaultSettings(): SettingsV1 {
  return {
    version: 1,
    destinationGroups: [], // 後方互換性のため残す（非推奨）
    carriers: DEFAULT_CARRIERS_JP.map((c) => ({ ...c })), // デフォルトで日本の配送会社を設定
    visibleLocationIds: [], // 空配列=全ロケーション表示
    outbound: {
      allowForceCancel: true, // デフォルト: 許可
      historyInitialLimit: 100, // 出庫履歴 初回表示件数
    },
    inbound: {
      allowOverReceive: true,
      allowExtraReceive: true,
      listInitialLimit: 100, // 入庫リスト 初回。API上限250、推奨100
    },
    productList: { initialLimit: 250 }, // 商品リスト 初回。上限250、推奨250
    searchList: { initialLimit: 50 },  // 検索リスト 初回。API上限50、推奨50
  };
}

function safeParseSettings(raw: unknown): SettingsV1 {
  if (typeof raw !== "string" || !raw) return defaultSettings();
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1) return parsed as SettingsV1;
  } catch {
    // ignore
  }
  return defaultSettings();
}

function sanitizeSettings(input: any): SettingsV1 {
  const s: SettingsV1 = {
    version: 1,
    destinationGroups: [], // 後方互換性のため残す（非推奨）
    carriers: [],
    visibleLocationIds: [],
    outbound: {
      allowForceCancel: true,
      historyInitialLimit: 100,
    },
    inbound: {
      allowOverReceive: true,
      allowExtraReceive: true,
      listInitialLimit: 100,
    },
    productList: { initialLimit: 250 },
    searchList: { initialLimit: 50 },
  };

  // 後方互換性のため、destinationGroupsは読み込むが表示しない
  const groups = Array.isArray(input?.destinationGroups) ? input.destinationGroups : [];
  s.destinationGroups = groups
    .map((g: any) => ({
      id: String(g?.id ?? "").trim(),
      name: String(g?.name ?? "").trim(),
      locationIds: Array.isArray(g?.locationIds) ? g.locationIds.map((x: any) => String(x)) : [],
    }))
    .filter((g: DestinationGroup) => g.id && g.name);

  const carriers = Array.isArray(input?.carriers) ? input.carriers : [];
  s.carriers = carriers
    .map((c: any) => ({
      id: String(c?.id ?? "").trim(),
      label: String(c?.label ?? "").trim(),
      company: String(c?.company ?? "").trim(),
      sortOrder: Number.isFinite(Number(c?.sortOrder)) ? Number(c.sortOrder) : 999,
    }))
    .filter((c: CarrierOption) => c.id && c.label && c.company)
    .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)); // 表示順でソート

  // 表示ロケーション選択設定
  if (Array.isArray(input?.visibleLocationIds)) {
    s.visibleLocationIds = input.visibleLocationIds.map((id: any) => String(id)).filter(Boolean);
  }

  // 出庫設定
  if (input?.outbound && typeof input.outbound === "object") {
    s.outbound = {
      allowForceCancel:
        typeof input.outbound.allowForceCancel === "boolean"
          ? input.outbound.allowForceCancel
          : true,
      historyInitialLimit: clampInt(
        input.outbound.historyInitialLimit,
        1,
        250,
        100
      ),
    };
  }

  // 入庫設定
  if (input?.inbound && typeof input.inbound === "object") {
    s.inbound = {
      allowOverReceive:
        typeof input.inbound.allowOverReceive === "boolean"
          ? input.inbound.allowOverReceive
          : true,
      allowExtraReceive:
        typeof input.inbound.allowExtraReceive === "boolean"
          ? input.inbound.allowExtraReceive
          : true,
      listInitialLimit: clampInt(
        input.inbound.listInitialLimit,
        1,
        250,
        100
      ),
    };
  }

  // 商品リスト表示件数（初期）。lineItems API 上限250
  if (input?.productList && typeof input.productList === "object") {
    s.productList = {
      initialLimit: clampInt(input.productList.initialLimit, 1, 250, 250),
    };
  }

  // 検索リスト表示件数（初期）。productVariants 検索 API 上限50
  if (input?.searchList && typeof input.searchList === "object") {
    s.searchList = {
      initialLimit: clampInt(input.searchList.initialLimit, 1, 50, 50),
    };
  }

  return s;
}

/** 文字列を半角数字に変換（全角数字→半角、空白除去） */
function normalizeToHalfWidthDigits(s: unknown): string {
  const str = String(s ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s/g, "")
    .trim();
  return str.replace(/\D/g, ""); // 数字以外を除去
}

function clampInt(
  v: number | string,
  min: number,
  max: number,
  defaultVal: number
): number {
  const normalized = normalizeToHalfWidthDigits(v);
  const n = normalized ? parseInt(normalized, 10) : Number(v);
  if (!Number.isFinite(n)) return defaultVal;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * company は Shopify が「追跡リンク生成など」で認識する文字列。
 * “公式一覧をAPIで取得” は一般公開APIに無い想定なので、まずはプリセット方式で運用。
 * ここは運用しながら増やせばOK。
 */
const COMPANY_PRESETS_GLOBAL = [
  "DHL Express",
  "FedEx",
  "UPS",
  "USPS",
  "Japan Post (EN)",
  "Japan Post (JA)",
  "Sagawa (EN)",
  "Sagawa (JA)",
  "Yamato (EN)",
  "Yamato (JA)",
];

const COMPANY_PRESETS_JP_EXTRA = [
  "エコ配",
  "西濃運輸",
  "西濃スーパーエキスプレス",
  "福山通運",
  "日本通運",
  "名鉄運輸",
  "第一貨物",
];

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);

    const resp = await admin.graphql(
      `#graphql
        query SettingsBoot($first: Int!) {
          locations(first: $first) { nodes { id name } }
          currentAppInstallation {
            id
            metafield(namespace: "${NS}", key: "${KEY}") { id value type }
          }
        }
      `,
      { variables: { first: 250 } }
    );

    const data = await resp.json();
    const locations: LocationNode[] = data?.data?.locations?.nodes ?? [];
    const raw = data?.data?.currentAppInstallation?.metafield?.value ?? null;

    let settings = safeParseSettings(raw);

    // 初回インストール時（carriersが空の場合）はデフォルト値を設定
    if (settings.carriers.length === 0) {
      settings = {
        ...settings,
        carriers: DEFAULT_CARRIERS_JP.map((c) => ({ ...c })),
      };
    }

    // ✅ React Router template: json() を使わず、そのまま返す
    return { locations, settings };
  } catch (error) {
    // 認証エラーの場合は、authenticate.admin が自動的にリダイレクトする
    // ここに到達することは通常ないが、念のためエラーハンドリング
    console.error("Settings loader error:", error);
    throw error;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();

  const raw = String(form.get("settings") ?? "");
  let incoming: any;
  try {
    incoming = JSON.parse(raw);
  } catch {
    return { ok: false, error: "settings JSON が不正です" as const };
  }

  if (incoming?.version !== 1) {
    return { ok: false, error: "settings version が不正です" as const };
  }

  const settings = sanitizeSettings(incoming);

  const appInstResp = await admin.graphql(
    `#graphql
      query AppInst {
        currentAppInstallation { id }
      }
    `
  );

  const appInstJson = await appInstResp.json();
  const ownerId = appInstJson?.data?.currentAppInstallation?.id as string;

  if (!ownerId) {
    return { ok: false, error: "currentAppInstallation.id が取得できませんでした" as const };
  }

  const saveResp = await admin.graphql(
    `#graphql
      mutation SaveSettings($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key type }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: NS,
            key: KEY,
            type: "json",
            value: JSON.stringify(settings),
          },
        ],
      },
    }
  );

  const saveJson = await saveResp.json();
  const errs = saveJson?.data?.metafieldsSet?.userErrors ?? [];
  if (errs.length) {
    return { ok: false, error: errs.map((e: any) => e.message).join(" / ") as const };
  }

  return { ok: true, settings };
}

export default function SettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  // loaderDataが存在しない場合（認証エラーなど）のエラーハンドリング
  if (!loaderData) {
    return (
      <s-page heading="設定">
        <s-box padding="base">
          <s-text tone="critical">
            設定を読み込めませんでした。ページをリロードしてください。
          </s-text>
        </s-box>
      </s-page>
    );
  }

  const { locations, settings: initial } = loaderData;
  const [settings, setSettings] = useState<SettingsV1>(initial);

  // carrier presets UI
  const [showCarrierPresets, setShowCarrierPresets] = useState(false);

  // アプリ表示件数の入力検証エラー（半角数字以外など）
  const [displayCountErrors, setDisplayCountErrors] = useState<{
    historyList?: string;
    productList?: string;
    searchList?: string;
  }>({});

  const readValue = (e: any) => String(e?.currentTarget?.value ?? e?.currentValue?.value ?? "");

  const DISPLAY_COUNT_ERROR_MSG = "値を確認してください。半角数字で入力をお願いします。";

  /** 全角数字→半角変換・空白除去し、半角数字のみ抽出。無効・範囲外の場合はエラーを返す。範囲外はclamped値を適用。 */
  const parseDisplayCountInput = (
    raw: string,
    min: number,
    max: number,
    defaultVal: number
  ): { value: number; displayValue: string; error: string | null; shouldUpdate: boolean } => {
    const s = String(raw ?? "")
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/\s/g, "")
      .trim();
    if (!s) return { value: defaultVal, displayValue: String(defaultVal), error: null, shouldUpdate: true };
    const digitsOnly = s.replace(/\D/g, "");
    if (digitsOnly !== s) {
      return { value: defaultVal, displayValue: s, error: DISPLAY_COUNT_ERROR_MSG, shouldUpdate: false };
    }
    const n = parseInt(digitsOnly, 10);
    if (!Number.isFinite(n)) return { value: defaultVal, displayValue: s, error: DISPLAY_COUNT_ERROR_MSG, shouldUpdate: false };
    const clamped = Math.max(min, Math.min(max, n));
    const hasRangeError = clamped !== n;
    return { value: clamped, displayValue: String(clamped), error: hasRangeError ? DISPLAY_COUNT_ERROR_MSG : null, shouldUpdate: true };
  };

  useEffect(() => {
    setSettings(initial);
    setDisplayCountErrors({});
  }, [initial]);

  const saving = fetcher.state !== "idle";
  const saveOk = fetcher.data && (fetcher.data as any).ok === true;
  const saveErr =
    fetcher.data && (fetcher.data as any).ok === false ? (fetcher.data as any).error : null;

  // 保存成功したらサニタイズ後のsettingsでstateを更新
  useEffect(() => {
    if ((fetcher.data as any)?.ok && (fetcher.data as any)?.settings) {
      setSettings((fetcher.data as any).settings);
    }
  }, [fetcher.data]);

  const addCarrier = () => {
    const id = `car_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const maxSortOrder = Math.max(...settings.carriers.map((c) => c.sortOrder ?? 999), 0);
    setSettings((s) => ({
      ...s,
      carriers: [
        ...s.carriers,
        { id, label: "例）ヤマト運輸", company: "Yamato (JA)", sortOrder: maxSortOrder + 1 },
      ].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
    }));
  };

  const updateCarrier = (id: string, patch: Partial<CarrierOption>) => {
    setSettings((s) => {
      const updated = s.carriers.map((c) => (c.id === id ? { ...c, ...patch } : c));
      return {
        ...s,
        carriers: updated.sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
      };
    });
  };

  const removeCarrier = (id: string) => {
    setSettings((s) => ({
      ...s,
      carriers: s.carriers.filter((c) => c.id !== id),
    }));
  };

  const moveCarrierUp = (id: string) => {
    setSettings((s) => {
      const index = s.carriers.findIndex((c) => c.id === id);
      if (index <= 0) return s;
      const carriers = [...s.carriers];
      // 配列の要素を直接入れ替え（新しい配列を作成）
      const newCarriers = [...carriers];
      [newCarriers[index - 1], newCarriers[index]] = [newCarriers[index], newCarriers[index - 1]];
      // sortOrderも更新（新しいオブジェクトを作成）
      const updatedCarriers = newCarriers.map((c, i) => ({
        ...c,
        sortOrder: i + 1,
      }));
      return {
        ...s,
        carriers: updatedCarriers,
      };
    });
  };

  const moveCarrierDown = (id: string) => {
    setSettings((s) => {
      const index = s.carriers.findIndex((c) => c.id === id);
      if (index < 0 || index >= s.carriers.length - 1) return s;
      const carriers = [...s.carriers];
      // 配列の要素を直接入れ替え（新しい配列を作成）
      const newCarriers = [...carriers];
      [newCarriers[index], newCarriers[index + 1]] = [newCarriers[index + 1], newCarriers[index]];
      // sortOrderも更新（新しいオブジェクトを作成）
      const updatedCarriers = newCarriers.map((c, i) => ({
        ...c,
        sortOrder: i + 1,
      }));
      return {
        ...s,
        carriers: updatedCarriers,
      };
    });
  };

  const resetCarriersToDefault = () => {
    if (
      !confirm(
        "配送会社をデフォルト設定に戻しますか？現在の設定は削除されます。"
      )
    )
      return;
    setSettings((s) => ({
      ...s,
      carriers: DEFAULT_CARRIERS_JP.map((c) => ({ ...c })),
    }));
  };

  const save = () => {
    const fd = new FormData();
    fd.set("settings", JSON.stringify(settings));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <s-page heading="設定">
      <s-scroll-box padding="base">
        <s-stack gap="base">
          {/* 保存・破棄ボタン（最上部・右寄せ・上下余白を抑えて浮き感を軽減） */}
          <div style={{ width: "100%", display: "flex", justifyContent: "flex-end", padding: "8px 16px" }}>
            <s-stack direction="inline" gap="base" inlineAlignment="end">
              <s-button tone="critical" onClick={() => setSettings(initial)} disabled={saving}>
                破棄
              </s-button>
              <s-button tone="success" onClick={save} disabled={saving}>
                {saving ? "保存中..." : "保存"}
              </s-button>
            </s-stack>
          </div>

          {/* 成功・エラーメッセージ */}
          {saveOk ? (
            <s-box padding="base" background="subdued">
              <s-text tone="success" emphasis="bold">保存しました</s-text>
            </s-box>
          ) : null}
          {saveErr ? (
            <s-box padding="base" background="subdued">
              <s-text tone="critical" emphasis="bold">保存エラー: {saveErr}</s-text>
            </s-box>
          ) : null}

          {/* 左右2カラム（項目ごとの区切りは各 section で担保） */}
          <div style={{ display: "flex", gap: "24px", flexWrap: "wrap", alignItems: "flex-start" }}>
            {/* 左カラム */}
            <div style={{ flex: "1 1 360px", minWidth: 0 }}>
              <s-stack gap="base">
                {/* 店舗設定（履歴フィルター同様の選択UI） */}
                <s-section heading="店舗設定">
                  <s-text tone="subdued" size="small">
                    POS側で表示するロケーションを選択します。全て表示のまま＝全ロケーション表示。項目を選ぶとそのロケーションのみ表示されます。
                  </s-text>
                  {locations.length === 0 ? (
                    <s-box padding="base">
                      <s-text tone="critical">ロケーションが取得できませんでした</s-text>
                    </s-box>
                  ) : (
                    <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: "8px", padding: "6px", marginTop: "8px" }}>
                      <div
                        onClick={() => setSettings((s) => ({ ...s, visibleLocationIds: [] }))}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "6px",
                          cursor: "pointer",
                          backgroundColor: (settings.visibleLocationIds ?? []).length === 0 ? "#f0f9f7" : "transparent",
                          border: (settings.visibleLocationIds ?? []).length === 0 ? "1px solid #008060" : "1px solid transparent",
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <input type="checkbox" checked={(settings.visibleLocationIds ?? []).length === 0} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                        <span style={{ fontWeight: (settings.visibleLocationIds ?? []).length === 0 ? 600 : 500 }}>全て表示</span>
                      </div>
                      {locations.map((l) => {
                        const isSelected = (settings.visibleLocationIds ?? []).includes(l.id);
                        return (
                          <div
                            key={l.id}
                            onClick={() => {
                              const current = settings.visibleLocationIds ?? [];
                              const newIds = isSelected ? current.filter((id) => id !== l.id) : [...current, l.id];
                              setSettings((s) => ({ ...s, visibleLocationIds: newIds }));
                            }}
                            style={{
                              padding: "10px 12px",
                              borderRadius: "6px",
                              cursor: "pointer",
                              backgroundColor: isSelected ? "#f0f9f7" : "transparent",
                              border: isSelected ? "1px solid #008060" : "1px solid transparent",
                              marginTop: "4px",
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <input type="checkbox" checked={isSelected} readOnly style={{ width: "16px", height: "16px", flexShrink: 0 }} />
                            <span style={{ fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis" }}>{l.name}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </s-section>

                <s-divider />

                {/* アプリ表示件数（初回読み込み） */}
                <s-section heading="アプリ表示件数（初回読み込み）">
                  <s-box padding="base">
                    <s-stack gap="base">
                      <s-text-field
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        label="履歴一覧リスト"
                        value={String(settings.outbound?.historyInitialLimit ?? 100)}
                        helpText={displayCountErrors.historyList}
                        tone={displayCountErrors.historyList ? "critical" : undefined}
                        onInput={(e: any) => {
                          const r = parseDisplayCountInput(readValue(e), 1, 250, 100);
                          setDisplayCountErrors((prev) => ({ ...prev, historyList: r.error ?? undefined }));
                          if (r.shouldUpdate) {
                            setSettings((s) => ({
                              ...s,
                              outbound: { ...(s.outbound ?? {}), historyInitialLimit: r.value },
                              inbound: { ...(s.inbound ?? {}), listInitialLimit: r.value },
                            }));
                          }
                        }}
                        onChange={(e: any) => {
                          const r = parseDisplayCountInput(readValue(e), 1, 250, 100);
                          setDisplayCountErrors((prev) => ({ ...prev, historyList: r.error ?? undefined }));
                          if (r.shouldUpdate) {
                            setSettings((s) => ({
                              ...s,
                              outbound: { ...(s.outbound ?? {}), historyInitialLimit: r.value },
                              inbound: { ...(s.inbound ?? {}), listInitialLimit: r.value },
                            }));
                          }
                        }}
                      />
                      <s-text tone="subdued" size="small">アプリの出庫履歴・入庫履歴・ロス履歴の一覧表示に適用（棚卸履歴は全件取得のため対象外）。最大250件、推奨100件。全角数字・スペースは半角に自動変換されます。</s-text>
                      <s-text-field
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        label="商品リスト"
                        value={String(settings.productList?.initialLimit ?? 250)}
                        helpText={displayCountErrors.productList}
                        tone={displayCountErrors.productList ? "critical" : undefined}
                        onInput={(e: any) => {
                          const r = parseDisplayCountInput(readValue(e), 1, 250, 250);
                          setDisplayCountErrors((prev) => ({ ...prev, productList: r.error ?? undefined }));
                          if (r.shouldUpdate) {
                            setSettings((s) => ({ ...s, productList: { ...(s.productList ?? {}), initialLimit: r.value } }));
                          }
                        }}
                        onChange={(e: any) => {
                          const r = parseDisplayCountInput(readValue(e), 1, 250, 250);
                          setDisplayCountErrors((prev) => ({ ...prev, productList: r.error ?? undefined }));
                          if (r.shouldUpdate) {
                            setSettings((s) => ({ ...s, productList: { ...(s.productList ?? {}), initialLimit: r.value } }));
                          }
                        }}
                      />
                      <s-text tone="subdued" size="small">アプリの出庫・入庫・ロス・棚卸の商品リスト表示に適用。最大250件、推奨250件</s-text>
                      <s-text-field
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        label="検索リスト"
                        value={String(settings.searchList?.initialLimit ?? 50)}
                        helpText={displayCountErrors.searchList}
                        tone={displayCountErrors.searchList ? "critical" : undefined}
                        onInput={(e: any) => {
                          const r = parseDisplayCountInput(readValue(e), 1, 50, 50);
                          setDisplayCountErrors((prev) => ({ ...prev, searchList: r.error ?? undefined }));
                          if (r.shouldUpdate) {
                            setSettings((s) => ({ ...s, searchList: { ...(s.searchList ?? {}), initialLimit: r.value } }));
                          }
                        }}
                        onChange={(e: any) => {
                          const r = parseDisplayCountInput(readValue(e), 1, 50, 50);
                          setDisplayCountErrors((prev) => ({ ...prev, searchList: r.error ?? undefined }));
                          if (r.shouldUpdate) {
                            setSettings((s) => ({ ...s, searchList: { ...(s.searchList ?? {}), initialLimit: r.value } }));
                          }
                        }}
                      />
                      <s-text tone="subdued" size="small">アプリの出庫・入庫・ロス・棚卸の検索結果表示に適用。最大50件、推奨50件</s-text>
                    </s-stack>
                  </s-box>
                </s-section>

                <s-divider />

                {/* 出庫設定 */}
                <s-section heading="出庫設定">
            <s-box padding="base" style={{ width: "100%" }}>
              <s-stack direction="inline" gap="base" inlineAlignment="space-between" style={{ width: "100%" }}>
                <s-box style={{ flex: "1 1 auto", minWidth: 0, paddingRight: "16px" }}>
                  <s-stack gap="tight">
                    <s-text emphasis="bold">強制キャンセル処理許可</s-text>
                    <s-text tone="subdued" size="small">
                      出庫処理で強制キャンセル（在庫を戻す処理）を許可するかどうかを設定します。
                    </s-text>
                  </s-stack>
                </s-box>
                <s-box style={{ flex: "0 0 auto" }}>
                  <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="allowForceCancel"
                        checked={(settings.outbound?.allowForceCancel ?? true) === true}
                        onChange={() => setSettings((s) => ({ ...s, outbound: { ...(s.outbound ?? {}), allowForceCancel: true } }))}
                      />
                      <span>許可</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="allowForceCancel"
                        checked={(settings.outbound?.allowForceCancel ?? true) === false}
                        onChange={() => setSettings((s) => ({ ...s, outbound: { ...(s.outbound ?? {}), allowForceCancel: false } }))}
                      />
                      <span>不許可</span>
                    </label>
                  </div>
                </s-box>
              </s-stack>
            </s-box>
                </s-section>

                <s-divider />

                {/* 入庫設定 */}
                <s-section heading="入庫設定">
            <s-box padding="base" style={{ width: "100%" }}>
              <s-stack direction="inline" gap="base" inlineAlignment="space-between" style={{ width: "100%" }}>
                <s-box style={{ flex: "1 1 auto", minWidth: 0, paddingRight: "16px" }}>
                  <s-stack gap="tight">
                    <s-text emphasis="bold">過剰入庫許可</s-text>
                    <s-text tone="subdued" size="small">
                      予定数量を超える入庫を許可するかどうかを設定します。
                    </s-text>
                  </s-stack>
                </s-box>
                <s-box style={{ flex: "0 0 auto" }}>
                  <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="allowOverReceive"
                        checked={(settings.inbound?.allowOverReceive ?? true) === true}
                        onChange={() => setSettings((s) => ({ ...s, inbound: { ...(s.inbound ?? {}), allowOverReceive: true } }))}
                      />
                      <span>許可</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="allowOverReceive"
                        checked={(settings.inbound?.allowOverReceive ?? true) === false}
                        onChange={() => setSettings((s) => ({ ...s, inbound: { ...(s.inbound ?? {}), allowOverReceive: false } }))}
                      />
                      <span>不許可</span>
                    </label>
                  </div>
                </s-box>
              </s-stack>
            </s-box>

            <s-box padding="base" style={{ width: "100%" }}>
              <s-stack direction="inline" gap="base" inlineAlignment="space-between" style={{ width: "100%" }}>
                <s-box style={{ flex: "1 1 auto", minWidth: 0, paddingRight: "16px" }}>
                  <s-stack gap="tight">
                    <s-text emphasis="bold">予定外入庫許可</s-text>
                    <s-text tone="subdued" size="small">
                      予定にない商品の入庫を許可するかどうかを設定します。
                    </s-text>
                  </s-stack>
                </s-box>
                <s-box style={{ flex: "0 0 auto" }}>
                  <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="allowExtraReceive"
                        checked={(settings.inbound?.allowExtraReceive ?? true) === true}
                        onChange={() => setSettings((s) => ({ ...s, inbound: { ...(s.inbound ?? {}), allowExtraReceive: true } }))}
                      />
                      <span>許可</span>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="allowExtraReceive"
                        checked={(settings.inbound?.allowExtraReceive ?? true) === false}
                        onChange={() => setSettings((s) => ({ ...s, inbound: { ...(s.inbound ?? {}), allowExtraReceive: false } }))}
                      />
                      <span>不許可</span>
                    </label>
                  </div>
                </s-box>
              </s-stack>
            </s-box>
                </s-section>
              </s-stack>
            </div>

            {/* 右カラム */}
            <div style={{ flex: "1 1 360px", minWidth: 0 }}>
              <s-stack gap="base">
                {/* 配送設定 */}
                <s-section heading="配送設定">
            <s-text tone="subdued" size="small">
              アプリ表示名とShopifyのプリセットcompanyを設定してください。
              <br />
              company は プリセットリストより Shopify が認識できる文字列を入れてください。（例：Yamato (JA)）
              <br />
              表示順は矢印で調整をお願いします。
            </s-text>

            <s-box padding="base">
              <s-stack gap="base">
                <s-button onClick={() => setShowCarrierPresets((v) => !v)}>
                  {showCarrierPresets ? "プリセットを閉じる" : "プリセットを表示"}
                </s-button>

                {showCarrierPresets ? (
                  <s-box padding="base" background="subdued">
                    <s-stack gap="base">
                      <s-text emphasis="bold" size="small">グローバル（代表）</s-text>
                      <s-stack gap="tight">
                        {COMPANY_PRESETS_GLOBAL.map((name) => (
                          <s-text key={name} tone="subdued" size="small">
                            • {name}
                          </s-text>
                        ))}
                      </s-stack>
                      <s-divider />
                      <s-text emphasis="bold" size="small">日本（追加分）</s-text>
                      <s-stack gap="tight">
                        {COMPANY_PRESETS_JP_EXTRA.map((name) => (
                          <s-text key={name} tone="subdued" size="small">
                            • {name}
                          </s-text>
                        ))}
                      </s-stack>
                    </s-stack>
                  </s-box>
                ) : null}
              </s-stack>
            </s-box>

            {settings.carriers.length === 0 ? (
              <s-box padding="base">
                <s-text tone="subdued">配送会社が登録されていません</s-text>
              </s-box>
            ) : (
              <s-box padding="base">
                <s-stack gap="base">
                  {settings.carriers.map((c, index) => (
                    <s-box key={c.id} padding="base" background="subdued">
                      <s-stack gap="base">
                        <s-stack direction="inline" gap="base" inlineAlignment="space-between">
                          <s-text emphasis="bold" size="small">
                            表示順: {index + 1}
                          </s-text>
                        </s-stack>
                        <s-text-field
                          label="表示名（POSに出す）"
                          value={c.label}
                          onInput={(e: any) => updateCarrier(c.id, { label: readValue(e) })}
                          onChange={(e: any) => updateCarrier(c.id, { label: readValue(e) })}
                        />
                        <s-text-field
                          label="company（Shopifyプリセット）"
                          value={c.company}
                          onInput={(e: any) => updateCarrier(c.id, { company: readValue(e) })}
                          onChange={(e: any) => updateCarrier(c.id, { company: readValue(e) })}
                          helpText="例：Yamato (JA) / Sagawa (JA) / Japan Post (JA)"
                        />
                        <s-stack direction="inline" gap="base" inlineAlignment="center">
                          <s-button
                            size="small"
                            onClick={() => updateCarrier(c.id, { company: "Yamato (JA)" })}
                          >
                            Yamato
                          </s-button>
                          <s-button
                            size="small"
                            onClick={() => updateCarrier(c.id, { company: "Sagawa (JA)" })}
                          >
                            Sagawa
                          </s-button>
                          <s-button
                            size="small"
                            onClick={() => updateCarrier(c.id, { company: "Japan Post (JA)" })}
                          >
                            Japan Post
                          </s-button>
                          <s-box inlineSize="fill" />
                          <s-button tone="critical" size="small" onClick={() => removeCarrier(c.id)}>
                            削除
                          </s-button>
                          <s-stack direction="inline" gap="tight">
                            <s-button
                              size="small"
                              disabled={index === 0}
                              onClick={() => moveCarrierUp(c.id)}
                            >
                              ↑
                            </s-button>
                            <s-button
                              size="small"
                              disabled={index === settings.carriers.length - 1}
                              onClick={() => moveCarrierDown(c.id)}
                            >
                              ↓
                            </s-button>
                          </s-stack>
                        </s-stack>
                      </s-stack>
                    </s-box>
                  ))}
                </s-stack>
              </s-box>
            )}

            <s-box padding="base">
              <s-stack direction="inline" gap="base" inlineAlignment="start">
                <s-button onClick={addCarrier}>配送会社を追加</s-button>
                <s-button onClick={resetCarriersToDefault}>デフォルトに戻す</s-button>
              </s-stack>
            </s-box>
          </s-section>
              </s-stack>
            </div>
          </div>

          <s-divider />
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}
