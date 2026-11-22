/**
 * 管理画面で在庫を書く操作に付ける opKey・opRound を持つフック（docs/IDEMPOTENT_MIGRATION.md 4.6）。
 * 決まりは admin-op-key.ts（成功で作り直す・はっきり断られたら回を増やす・分からないときは変えない）。
 *
 * 使い方:
 *   const opKey = useAdminOpKey(fetcher.data);
 *   const fd = new FormData(); ...; opKey.append(fd); fetcher.submit(fd, …);
 */
import { useEffect, useRef } from "react";
import {
  appendAdminOpKey,
  initialAdminOpKeyState,
  nextAdminOpKeyState,
  readAdminOpKeyResult,
  type AdminOpKeyState,
} from "./admin-op-key";

export function useAdminOpKey(fetcherData: unknown): { append: (formData: FormData) => FormData } {
  // ref に持つ（押した瞬間に最新の値を読む。画面の描き直しは要らない）
  const stateRef = useRef<AdminOpKeyState | null>(null);
  if (stateRef.current === null) stateRef.current = initialAdminOpKeyState();
  const seenRef = useRef<unknown>(null);

  useEffect(() => {
    if (!fetcherData || seenRef.current === fetcherData) return;
    seenRef.current = fetcherData;
    const result = readAdminOpKeyResult(fetcherData);
    if (result) stateRef.current = nextAdminOpKeyState(stateRef.current ?? initialAdminOpKeyState(), result);
  }, [fetcherData]);

  return {
    append: (formData: FormData) => appendAdminOpKey(formData, stateRef.current ?? initialAdminOpKeyState()),
  };
}
