// Retry only this read when fetch fails before a response arrives.
export async function readWebhookShopTimezone(admin) {
  const request = { data: "query GetShopTimezone { shop { ianaTimezone } }" };
  let response;
  try {
    response = await admin.request(request);
  } catch (error) {
    if (!(error instanceof TypeError) || error.message !== "fetch failed") throw error;
    response = await admin.request(request);
  }
  const result = await response.json();
  if (response.ok === false || result.errors?.length || !result.data?.shop?.ianaTimezone) {
    throw new Error("Shop timezone unavailable");
  }
  return result.data.shop.ianaTimezone;
}
