import type { ActionFunctionArgs } from "react-router";
import { inventoryWebhookAction } from "../utils/inventory-webhook-handler.server";

// Only framework server exports belong in this route; trusted replay stays server-only.
export const action = (args: ActionFunctionArgs) => inventoryWebhookAction(args);
