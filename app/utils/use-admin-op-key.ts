/**
 * 管理画面で在庫を書く操作に付ける opKey・opRound を、**対象ごと**に持つフック（docs/IDEMPOTENT_MIGRATION.md 4.6）。
 * 決まりは admin-op-key.ts（成功で作り直す・はっきり断られたら回を増やす・分からないときは変えない）。
 *
 * 使い方:
 *   const opKey = useAdminOpKey(fetcher.data);
 *   const fd = new FormData(); ...; opKey.append(fd, entryId); fetcher.submit(fd, …);
 * 答えに入っている opKey（サーバーが送られてきたものをそのまま返す）で、どの対象の答えかを見分ける。
 */
import { useEffect, useRef } from "react";
import {
  adminOpKeyStateFor,
  appendAdminOpKey,
  applyAdminOpKeyResult,
  type AdminOpKeyState,
} from "./admin-op-key";

export function useAdminOpKey(fetcherData: unknown): { append: (formData: FormData, target: string) => FormData } {
  // ref に持つ（押した瞬間に最新の値を読む。画面の描き直しは要らない）
  const statesRef = useRef<Map<string, AdminOpKeyState>>(new Map());
  const seenRef = useRef<unknown>(null);

  useEffect(() => {
    if (!fetcherData || seenRef.current === fetcherData) return;
    seenRef.current = fetcherData;
    applyAdminOpKeyResult(statesRef.current, fetcherData);
  }, [fetcherData]);

  return {
    append: (formData: FormData, target: string) => appendAdminOpKey(formData, adminOpKeyStateFor(statesRef.current, target)),
  };
}
