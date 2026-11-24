/** Literal, bounded Shopify customer search. Never interpret staff input as query syntax. */
export function normalizeCustomerSearch(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 100);
}
const quoted = value => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export function buildCustomerSearchQuery(value) {
  const text = normalizeCustomerSearch(value);
  if (!text) return "";
  if (/^[+\d\s()ー-]+$/.test(text)) {
    const compact = text.replace(/[\s()ー-]/g, "");
    const terms = new Set([compact]);
    if (/^0[1-9]\d*$/.test(compact)) terms.add(`+81${compact.slice(1)}`);
    if (/^\+81[1-9]\d*$/.test(compact)) terms.add(`0${compact.slice(3)}`);
    return [...terms].map(term => `phone:${quoted(term)}*`).join(" OR ");
  }
  const terms = text.split(" ").slice(0, 4);
  const nameTerm = term => `(first_name:${quoted(term)}* OR last_name:${quoted(term)}*)`;
  const parts = [terms.map(nameTerm).join(" AND "), quoted(text)];
  // Japanese full names are often entered without a space between surname and given name.
  if (terms.length === 1 && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,12}$/u.test(text)) {
    for (let split = 1; split < text.length; split++) parts.push(`(last_name:${quoted(text.slice(0, split))}* AND first_name:${quoted(text.slice(split))}*)`);
  }
  return `(${parts.join(" OR ")})`;
}
