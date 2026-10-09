/**
 * Shopify inventory activate / setQuantities の生メッセージを
 * POS 向けに読みやすくする（空・Unknown 固定を避ける）。
 */

/** 表示用: 「ロケーションに在庫レベルがない」系（広め） */
export function isNotStockedAtLocationError(errorSummary: string | undefined): boolean {
  if (!errorSummary) return false;
  const s = errorSummary.toLowerCase();
  return (
    s.includes("not stocked") ||
    s.includes("is not stocked at the location") ||
    (s.includes("在庫レベル") && (s.includes("ない") || s.includes("未"))) ||
    /not stocked at the location/i.test(errorSummary)
  );
}

/**
 * 再 setQuantities してよい not-stocked / 伝播エラーか（厳格）。
 * 曖昧な "inventory level"+"not" は含めない（誤再 set 防止・独立レビュー B3）。
 */
export function isNotStockedRetryableError(errorSummary: string | undefined): boolean {
  if (!errorSummary) return false;
  if (/not stocked at the location/i.test(errorSummary)) return true;
  if (/is not stocked/i.test(errorSummary)) return true;
  if (/伝播待ち/.test(errorSummary)) return true;
  if (/反映を確認できません/.test(errorSummary)) return true;
  if (/ロケーション未反映/.test(errorSummary)) return true;
  return false;
}

/** activate 直後の伝播遅れメッセージか（表示・分類用） */
export function isActivatePropagationError(errorSummary: string | undefined): boolean {
  if (!errorSummary) return false;
  if (isNotStockedAtLocationError(errorSummary)) return true;
  if (isNotStockedRetryableError(errorSummary)) return true;
  const s = errorSummary.toLowerCase();
  return (
    s.includes("inventorylevel が返されません") ||
    s.includes("inventorylevel was not") ||
    s.includes("まだ反映") ||
    s.includes("伝播") ||
    s.includes("反映を確認できません") ||
    s.includes("propagation")
  );
}

/**
 * POS toast / errorSummary 用。Shopify の具体文は残しつつ、既知パターンを日本語化する。
 * 空文字は "Unknown error" にせず、再試行可能な案内にする。
 */
export function formatInventoryApiError(raw: string | undefined | null): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || /^unknown(\s+error)?$/i.test(trimmed)) {
    return (
      "在庫APIでエラーが発生しました。通信状況を確認し、画面を再読み込みしてから再度確定してください。"
    );
  }

  if (isNotStockedAtLocationError(trimmed) || isNotStockedRetryableError(trimmed)) {
    return (
      "一部商品がこのロケーションに在庫登録されていません（有効化の反映待ちの可能性あり）。" +
      "しばらく待ってから再度確定してください。繰り返す場合は管理画面で在庫追跡を確認してください。" +
      `（詳細: ${truncate(trimmed, 180)}）`
    );
  }

  if (/throttl|rate limit|429/i.test(trimmed)) {
    return (
      "Shopifyの在庫APIが混み合っています。しばらく待ってから再度確定してください。" +
      `（詳細: ${truncate(trimmed, 120)}）`
    );
  }

  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|fetch failed/i.test(trimmed)) {
    return (
      "在庫APIへの通信がタイムアウトまたは中断しました。通信状況を確認して再度確定してください。" +
      `（詳細: ${truncate(trimmed, 120)}）`
    );
  }

  if (/tracked|在庫追跡/i.test(trimmed) && /fail|失敗|false|無効/i.test(trimmed)) {
    return (
      "在庫追跡の有効化に失敗した商品があります。管理画面で対象バリアントの在庫追跡を確認してください。" +
      `（詳細: ${truncate(trimmed, 180)}）`
    );
  }

  if (/partial|一部|ロールバック/i.test(trimmed) && /手動|manual|復旧/i.test(trimmed)) {
    return (
      "在庫の一部だけ更新された可能性があります。管理画面で数量を確認し、必要なら手動で直してください。" +
      `（詳細: ${truncate(trimmed, 180)}）`
    );
  }

  // 既に日本語の案内文ならそのまま
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(trimmed) && trimmed.length >= 12) {
    return trimmed;
  }

  return `在庫APIエラー: ${truncate(trimmed, 280)}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
