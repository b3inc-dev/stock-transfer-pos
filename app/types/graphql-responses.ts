/**
 * GraphQL レスポンス用の共通型（any 削減のため）
 * Shopify Admin API の戻り値の data / errors を型安全に扱う
 */

/** GraphQL の userErrors / errors の要素 */
export interface GraphQLUserError {
  field?: string;
  message?: string;
}

/** トップレベルの errors 配列の要素 */
export interface GraphQLErrorItem {
  message?: string;
}

/** data と errors を持つ一般的な GraphQL レスポンス */
export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: GraphQLErrorItem[];
}

/** nodes クエリの InventoryItem ノード（ensure-inventory-activated 用） */
export interface InventoryItemNode {
  id?: string;
  tracked?: boolean;
  inventoryLevel?: { id?: string };
}

/** CheckInventoryItems / CheckLevel の data の形 */
export interface NodesQueryData {
  nodes?: InventoryItemNode[];
}

/** inventoryItemUpdate の戻り値 */
export interface InventoryItemUpdatePayload {
  inventoryItem?: { id?: string; tracked?: boolean };
  userErrors?: GraphQLUserError[];
}

/** inventoryActivate の戻り値 */
export interface InventoryActivatePayload {
  inventoryLevel?: { id?: string };
  userErrors?: GraphQLUserError[];
}

/** inventorySetQuantities / inventoryAdjustQuantities の data 内の戻り値 */
export interface InventoryMutationPayload {
  inventoryAdjustmentGroup?: { id?: string };
  userErrors?: GraphQLUserError[];
}

/** 数量取得用: quantities 配列の要素 */
export interface QuantityNameValue {
  name?: string;
  quantity?: number;
}

/** inventoryItem.inventoryLevel.quantities の型 */
export interface InventoryLevelQuantitiesData {
  data?: {
    inventoryItem?: {
      inventoryLevel?: {
        quantities?: QuantityNameValue[];
      };
      inventoryLevels?: {
        edges?: Array<{
          node?: {
            location?: { id?: string };
            quantities?: QuantityNameValue[];
          };
        }>;
      };
    };
  };
  errors?: GraphQLErrorItem[];
}

/** inventorySetQuantities の json レスポンスの型 */
export interface InventorySetQuantitiesJson {
  data?: {
    inventorySetQuantities?: InventoryMutationPayload;
  };
  errors?: GraphQLErrorItem[];
}

/** inventoryAdjustQuantities の json レスポンスの型 */
export interface InventoryAdjustQuantitiesJson {
  data?: {
    inventoryAdjustQuantities?: InventoryMutationPayload;
  };
  errors?: GraphQLErrorItem[];
}
