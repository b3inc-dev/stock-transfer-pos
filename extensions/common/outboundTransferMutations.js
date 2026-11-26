// Shared with the existing outbound tile. Keep transfer/shipment semantics identical.
export const OUTBOUND_READY_MUTATION = `#graphql
mutation CreateTransferReady($input: InventoryTransferCreateAsReadyToShipInput!) {
 inventoryTransferCreateAsReadyToShip(input: $input) { inventoryTransfer { id status } userErrors { field message } }
}`;
export const OUTBOUND_SHIPMENT_MUTATION = `#graphql
mutation ShipmentCreateDraft($input: InventoryShipmentCreateInput!) {
 inventoryShipmentCreate(input: $input) { inventoryShipment { id status } userErrors { field message } }
}`;
export const OUTBOUND_MARK_MUTATION = `#graphql
mutation MarkShipmentInTransit($id: ID!) {
 inventoryShipmentMarkInTransit(id: $id) { inventoryShipment { id status } userErrors { field message } }
}`;
export const OUTBOUND_TRACKING_MUTATION = `#graphql
mutation InvShpSetTrk($id: ID!, $tracking: InventoryShipmentTrackingInput!) {
 inventoryShipmentSetTracking(id: $id, tracking: $tracking) { inventoryShipment { id status } userErrors { field message } }
}`;
