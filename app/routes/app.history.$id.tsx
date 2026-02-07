// app/routes/app.history.$id.tsx
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import type { TransferLineItem } from "./app.history";
import { boundary } from "@shopify/shopify-app-react-router/server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);

    const rawId = params?.id || params?.$id || "";
    const transferId = rawId ? decodeURIComponent(rawId) : "";

    if (!transferId) {
      throw new Response("Transfer ID is required", { status: 400 });
    }

    // Transfer IDから商品明細を取得
    // shipments経由でlineItemsを取得（既存の動作コードに準拠）
    const resp = await admin.graphql(
      `#graphql
        query TransferLineItems($id: ID!) {
          inventoryTransfer(id: $id) {
            id
            name
            status
            note
            dateCreated
            totalQuantity
            receivedQuantity
            origin {
              name
              location {
                id
                name
              }
            }
            destination {
              name
              location {
                id
                name
              }
            }
            shipments(first: 10) {
              nodes {
                id
                lineItems(first: 100) {
                  nodes {
                    id
                    quantity
                    inventoryItem {
                      id
                      sku
                      variant {
                        id
                        title
                        barcode
                        selectedOptions {
                          name
                          value
                        }
                        product {
                          title
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { id: transferId } }
    );

    const data = await resp.json();
    const transfer = data?.data?.inventoryTransfer;

    if (!transfer) {
      throw new Response("Transfer not found", { status: 404 });
    }

    // lineItemsを集約（shipments経由で取得 - 既存の動作コードに準拠）
    const lineItems: TransferLineItem[] = [];
    if (Array.isArray(transfer?.shipments?.nodes)) {
      transfer.shipments.nodes.forEach((shipment: any, shipmentIdx: number) => {
        if (Array.isArray(shipment?.lineItems?.nodes)) {
          shipment.lineItems.nodes.forEach((li: any, liIdx: number) => {
            const inventoryItem = li?.inventoryItem;
            const variant = inventoryItem?.variant;
            const product = variant?.product;

            // オプションを取得（selectedOptionsから正しく取得）
            const selectedOptions = Array.isArray(variant?.selectedOptions) ? variant.selectedOptions : [];
            const option1 = selectedOptions[0]?.value || "";
            const option2 = selectedOptions[1]?.value || "";
            const option3 = selectedOptions[2]?.value || "";

            // titleはvariantから取得（既存の動作コードに準拠）
            const productTitle = String(product?.title || "").trim();
            const variantTitle = String(variant?.title || "").trim();
            const title = productTitle && variantTitle
              ? `${productTitle} / ${variantTitle}`
              : (variantTitle || productTitle || variant?.sku || inventoryItem?.id || "(unknown)");

            // skuはvariant.skuを優先、なければinventoryItem.skuを使用
            const sku = variant?.sku || inventoryItem?.sku || "";

            lineItems.push({
              id: li.id || "",
              inventoryItemId: inventoryItem?.id || "",
              variantId: variant?.id || "",
              sku,
              barcode: variant?.barcode || "",
              title,
              option1,
              option2,
              option3,
              quantity: li.quantity ?? 0,
            });
          });
        }
      });
    }

    const type = transfer.origin?.location?.id ? "outbound" : "inbound";
    const locationName = type === "outbound" 
      ? transfer.origin?.location?.name || transfer.origin?.name || ""
      : transfer.destination?.location?.name || transfer.destination?.name || "";

    return {
      transfer: {
        id: transfer.id,
        name: transfer.name || "",
        status: transfer.status || "",
        note: transfer.note || "",
        dateCreated: transfer.dateCreated || "",
        type,
        locationName,
        originLocationName: transfer.origin?.location?.name || transfer.origin?.name || "",
        destinationLocationName: transfer.destination?.location?.name || transfer.destination?.name || "",
      },
      lineItems,
    };
  } catch (error) {
    console.error("History detail loader error:", error);
    // エラーがResponseオブジェクトの場合はそのままthrow
    if (error instanceof Response) {
      throw error;
    }
    // その他のエラーは500エラーとして返す
    throw new Response("Internal server error", { status: 500 });
  }
}

// エラーハンドリング
export function ErrorBoundary() {
  const error = useRouteError();
  console.error("History detail ErrorBoundary - error:", error);
  console.error("History detail ErrorBoundary - error type:", typeof error);
  console.error("History detail ErrorBoundary - error instanceof Response:", error instanceof Response);
  if (error instanceof Response) {
    console.error("History detail ErrorBoundary - Response status:", error.status);
    console.error("History detail ErrorBoundary - Response statusText:", error.statusText);
  }
  return boundary.error(error);
}

export default function HistoryDetailPage() {
  const { transfer, lineItems } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const date = transfer.dateCreated
    ? new Date(transfer.dateCreated).toISOString().split("T")[0]
    : "";

  return (
    <s-page heading={`${transfer.type === "outbound" ? "出庫" : "入庫"}履歴詳細`}>
      <s-scroll-box padding="base">
        <s-stack gap="base">
          {/* 履歴情報 */}
          <s-section heading="履歴情報">
            <s-box padding="base">
              <s-stack gap="tight">
                <s-text emphasis="bold">{transfer.name || transfer.id}</s-text>
                <s-text tone="subdued" size="small">
                  {transfer.type === "outbound" ? "出庫元" : "入庫先"}: {transfer.locationName}
                </s-text>
                <s-text tone="subdued" size="small">
                  日付: {date}
                </s-text>
                <s-text tone="subdued" size="small">
                  ステータス: {transfer.status}
                </s-text>
              </s-stack>
            </s-box>
          </s-section>

          <s-divider />

          {/* 商品明細 */}
          <s-section heading="商品明細">
            {lineItems.length === 0 ? (
              <s-box padding="base">
                <s-text tone="subdued">商品明細がありません</s-text>
              </s-box>
            ) : (
              <s-stack gap="none">
                {lineItems.map((item, idx) => (
                  <div key={item.id || idx}>
                    <div style={{ padding: "12px" }}>
                      <s-stack gap="tight">
                        <s-text emphasis="bold" size="small">
                          {item.title || "(商品名なし)"}
                        </s-text>
                        {item.sku ? (
                          <s-text tone="subdued" size="small">
                            SKU: {item.sku}
                          </s-text>
                        ) : null}
                        {item.barcode ? (
                          <s-text tone="subdued" size="small">
                            JAN: {item.barcode}
                          </s-text>
                        ) : null}
                        {(item.option1 || item.option2 || item.option3) ? (
                          <s-text tone="subdued" size="small">
                            オプション: {[item.option1, item.option2, item.option3].filter(Boolean).join(" / ")}
                          </s-text>
                        ) : null}
                        <s-text tone="subdued" size="small">
                          数量: {item.quantity}
                        </s-text>
                      </s-stack>
                    </div>
                    <s-divider />
                  </div>
                ))}
              </s-stack>
            )}
          </s-section>

          {/* 戻るボタン */}
          <s-box padding="base">
            <s-button onClick={() => navigate("/app/history")}>戻る</s-button>
          </s-box>
        </s-stack>
      </s-scroll-box>
    </s-page>
  );
}
