// app/routes/app.settings.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { authenticate } from "../shopify.server";

type LocationNode = { id: string; name: string };

type DestinationGroup = {
  id: string;
  name: string;
  locationIds: string[]; // ✅ origin も必ず含める（POS側で所属グループ判定に使う）
};

type CarrierOption = {
  id: string;
  label: string; // POSに出す表示名（例：ヤマト運輸）
  company: string; // APIに渡す company（例：Yamato (JA)）
};

type SettingsV1 = {
  version: 1;
  destinationGroups: DestinationGroup[];
  carriers: CarrierOption[];
};

const NS = "stock_transfer_pos";
const KEY = "settings_v1";

function defaultSettings(): SettingsV1 {
  return { version: 1, destinationGroups: [], carriers: [] };
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
  const s: SettingsV1 = { version: 1, destinationGroups: [], carriers: [] };

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
    }))
    .filter((c: CarrierOption) => c.id && c.label && c.company);

  return s;
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

  const settings = safeParseSettings(raw);

  // ✅ React Router template: json() を使わず、そのまま返す
  return { locations, settings };
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
  const { locations, settings: initial } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [settings, setSettings] = useState<SettingsV1>(initial);

  // group creation UI
  const [groupName, setGroupName] = useState("");
  const [groupSelection, setGroupSelection] = useState<Record<string, boolean>>({});

  // carrier presets UI
  const [showCarrierPresets, setShowCarrierPresets] = useState(false);

  const readValue = (e: any) => String(e?.currentTarget?.value ?? e?.currentValue?.value ?? "");

  useEffect(() => setSettings(initial), [initial]);

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

  const locById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of locations) m.set(l.id, l.name);
    return m;
  }, [locations]);

  // どのロケがどのグループに所属してるか（診断用）
  const groupMembership = useMemo(() => {
    const map = new Map<string, string[]>(); // locationId -> group names
    for (const g of settings.destinationGroups) {
      for (const id of g.locationIds) {
        const arr = map.get(id) ?? [];
        arr.push(g.name);
        map.set(id, arr);
      }
    }
    return map;
  }, [settings.destinationGroups]);

  const toggleSelection = (id: string) => {
    setGroupSelection((s) => ({ ...s, [id]: !s[id] }));
  };

  const addGroup = () => {
    const name = groupName.trim();
    if (!name) return;

    const locationIds = Object.entries(groupSelection)
      .filter(([, v]) => v)
      .map(([k]) => k);

    const id = `grp_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    setSettings((s) => ({
      ...s,
      destinationGroups: [...s.destinationGroups, { id, name, locationIds }],
    }));

    setGroupName("");
    setGroupSelection({});
  };

  const removeGroup = (id: string) => {
    setSettings((s) => ({
      ...s,
      destinationGroups: s.destinationGroups.filter((g) => g.id !== id),
    }));
  };

  const addCarrier = () => {
    const id = `car_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setSettings((s) => ({
      ...s,
      carriers: [...s.carriers, { id, label: "例）ヤマト運輸", company: "Yamato (JA)" }],
    }));
  };

  const updateCarrier = (id: string, patch: Partial<CarrierOption>) => {
    setSettings((s) => ({
      ...s,
      carriers: s.carriers.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  };

  const removeCarrier = (id: string) => {
    setSettings((s) => ({
      ...s,
      carriers: s.carriers.filter((c) => c.id !== id),
    }));
  };

  const save = () => {
    const fd = new FormData();
    fd.set("settings", JSON.stringify(settings));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <s-page heading="在庫移管（POS）設定">
      <s-scroll-box padding="base">
        <s-stack gap="base">
          {saveOk ? <s-text tone="success">保存しました</s-text> : null}
          {saveErr ? <s-text tone="critical">保存エラー: {saveErr}</s-text> : null}

          <s-section heading="店舗グループ（宛先ロケーションの絞り込み）">
            <s-text tone="subdued" size="small">
              POS側ではグループ選択UIは出しません。
              <br />
              「現在の店舗（origin）が所属するグループ」を自動判定し、そのグループ内のロケーションだけを宛先候補にします。
              <br />
              ✅ ただし origin がどのグループにも入っていない場合は <b>全ロケーション表示（制限なし）</b> にフォールバックします。
            </s-text>

            <s-divider />

            <s-text-field
              label="新しいグループ名"
              value={groupName}
              onInput={(e: any) => setGroupName(readValue(e))}
              onChange={(e: any) => setGroupName(readValue(e))}
            />

            <s-box padding="base">
              <s-stack gap="base">
                <s-text emphasis="bold">
                  グループに含めるロケーション（origin 店舗も必ず含めてください）
                </s-text>

                {locations.length === 0 ? (
                  <s-text tone="critical">ロケーションが取得できませんでした</s-text>
                ) : (
                  <s-stack gap="base">
                    {locations.map((l) => {
                      const on = !!groupSelection[l.id];
                      const belong = groupMembership.get(l.id) ?? [];
                      const warnMulti = belong.length >= 2;

                      return (
                        <s-button
                          key={l.id} // ✅ index は使わない（ReferenceError回避）
                          tone={warnMulti ? "critical" : on ? "success" : undefined}
                          onClick={() => toggleSelection(l.id)}
                        >
                          {l.name}
                          {on ? " ✅" : ""}
                          {warnMulti ? "（※複数グループ所属）" : ""}
                        </s-button>
                      );
                    })}
                  </s-stack>
                )}

                <s-button onClick={addGroup} disabled={!groupName.trim()}>
                  グループ追加
                </s-button>
              </s-stack>
            </s-box>

            <s-divider />

            <s-text emphasis="bold">作成済みグループ</s-text>
            {settings.destinationGroups.length === 0 ? (
              <s-text tone="subdued">まだありません</s-text>
            ) : (
              <s-stack gap="base">
                {settings.destinationGroups.map((g) => (
                  <s-box padding="base" key={g.id}>
                    <s-stack gap="base">
                      <s-stack direction="inline" gap="base" inlineAlignment="center">
                        <s-text emphasis="bold">{g.name}</s-text>
                        <s-button tone="critical" onClick={() => removeGroup(g.id)}>
                          削除
                        </s-button>
                      </s-stack>

                      <s-text tone="subdued" size="small">
                        {g.locationIds.map((id) => locById.get(id) ?? id).join(" / ") || "（空）"}
                      </s-text>
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-section>

          <s-divider />

          <s-section heading="配送会社（選択式：POS側で表記ゆれ防止）">
            <s-text tone="subdued" size="small">
              POS側では “ここで登録した配送会社” を選ぶだけにします。
              <br />
              company は Shopify が認識できる文字列を入れてください（例：Yamato (JA)）。
              <br />
              ※「国→配送会社一覧をShopify公式からAPI取得」は、一般公開APIでの取得口が無い想定のため、まずはプリセット＋手動追加方式にします。
            </s-text>

            <s-divider />

            <s-stack direction="inline" gap="base" inlineAlignment="center">
              <s-button onClick={() => setShowCarrierPresets((v) => !v)}>
                {showCarrierPresets ? "プリセットを閉じる" : "プリセットを表示"}
              </s-button>
            </s-stack>

            {showCarrierPresets ? (
              <s-box padding="base">
                <s-stack gap="base">
                  <s-text emphasis="bold">グローバル（代表）</s-text>
                  <s-stack gap="base">
                    {COMPANY_PRESETS_GLOBAL.map((name) => (
                      <s-text key={name} tone="subdued" size="small">
                        {name}
                      </s-text>
                    ))}
                  </s-stack>

                  <s-divider />

                  <s-text emphasis="bold">日本（追加分）</s-text>
                  <s-stack gap="base">
                    {COMPANY_PRESETS_JP_EXTRA.map((name) => (
                      <s-text key={name} tone="subdued" size="small">
                        {name}
                      </s-text>
                    ))}
                  </s-stack>
                </s-stack>
              </s-box>
            ) : null}

            <s-divider />

            {settings.carriers.length === 0 ? (
              <s-text tone="subdued">まだありません</s-text>
            ) : (
              <s-stack gap="base">
                {settings.carriers.map((c) => (
                  <s-box padding="base" key={c.id}>
                    <s-stack gap="base">
                      <s-text-field
                        label="表示名（POSに出す）"
                        value={c.label}
                        onInput={(e: any) => updateCarrier(c.id, { label: readValue(e) })}
                        onChange={(e: any) => updateCarrier(c.id, { label: readValue(e) })}
                      />

                      <s-text-field
                        label="company（APIに渡す）"
                        value={c.company}
                        onInput={(e: any) => updateCarrier(c.id, { company: readValue(e) })}
                        onChange={(e: any) => updateCarrier(c.id, { company: readValue(e) })}
                        helpText="例：Yamato (JA) / Sagawa (JA) / Japan Post (JA)"
                      />

                      <s-text tone="subdued" size="small">
                        ワンタップ候補（クリックで上書き）
                      </s-text>
                      <s-stack direction="inline" gap="base" inlineAlignment="center">
                        <s-button onClick={() => updateCarrier(c.id, { company: "Yamato (JA)" })}>
                          Yamato (JA)
                        </s-button>
                        <s-button onClick={() => updateCarrier(c.id, { company: "Sagawa (JA)" })}>
                          Sagawa (JA)
                        </s-button>
                        <s-button onClick={() => updateCarrier(c.id, { company: "Japan Post (JA)" })}>
                          Japan Post (JA)
                        </s-button>
                      </s-stack>

                      <s-button tone="critical" onClick={() => removeCarrier(c.id)}>
                        削除
                      </s-button>
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}

            <s-button onClick={addCarrier}>配送会社を追加</s-button>
          </s-section>

          <s-divider />

          <s-stack direction="inline" gap="base" inlineAlignment="center">
            <s-button tone="critical" onClick={() => setSettings(initial)} disabled={saving}>
              破棄して戻す
            </s-button>
            <s-button tone="success" onClick={save} disabled={saving}>
              {saving ? "保存中..." : "保存"}
            </s-button>
          </s-stack>
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}
