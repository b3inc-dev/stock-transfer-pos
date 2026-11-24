/** Display only: never rewrite Shopify's customer master or stored contact values. */
export function japaneseCustomerName(customer) {
  const last = String(customer?.lastName || "").trim();
  const first = String(customer?.firstName || "").trim();
  return [last, first].filter(Boolean).join(" ") || String(customer?.displayName || "").trim();
}
export function japanesePhoneDisplay(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/[\s()-]/g, "");
  let national = digits;
  if (/^\+81[1-9]\d{8,9}$/.test(digits)) national = `0${digits.slice(3)}`;
  if (/^0[789]0\d{8}$/.test(national)) return `${national.slice(0, 3)}-${national.slice(3, 7)}-${national.slice(7)}`;
  if (/^0[36]\d{8}$/.test(national)) return `${national.slice(0, 2)}-${national.slice(2, 6)}-${national.slice(6)}`;
  return /^0\d{9,10}$/.test(national) ? national : raw;
}
