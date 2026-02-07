/**
 * 固定フッター（OutboundConditions / OutboundHistoryConditions と同じ構成）
 * summaryLeft, summaryRight, 戻る / 中央オプション / 右ボタン
 */
export function FixedFooterNavBar({
  summaryLeft,
  summaryCenter,
  summaryRight,
  leftLabel,
  onLeft,
  leftDisabled = false,
  leftTone = "default",
  rightLabel,
  onRight,
  rightDisabled = false,
  rightTone = "default",
  rightCommand,
  rightCommandFor,
  middleLabel,
  onMiddle,
  middleDisabled = false,
  middleTone = "default",
  centerAlignWithButtons = false, // ✅ 商品リストのフッターで使用（明細/合計をボタンと上下中央揃え）
}) {
  const hasCenter =
    summaryCenter !== undefined && summaryCenter !== null && String(summaryCenter).trim() !== "";
  const hasMiddle = !!middleLabel && typeof onMiddle === "function";

  return (
    <s-box
      padding="base"
      border="base"
      style={{
        position: "sticky",
        bottom: 0,
        background: "var(--s-color-bg)",
        zIndex: 10,
      }}
    >
      {centerAlignWithButtons ? (
        // ✅ 商品リストのフッター：明細/合計をボタンと上下中央揃え
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-button tone={leftTone} disabled={leftDisabled} onClick={onLeft}>
            {leftLabel}
          </s-button>

          {hasCenter ? (
            typeof summaryCenter === "string" ? (
              <s-text size="small" tone="subdued">
                {summaryCenter}
              </s-text>
            ) : (
              summaryCenter
            )
          ) : hasMiddle ? (
            <s-button tone={middleTone} disabled={middleDisabled} onClick={onMiddle}>
              {middleLabel}
            </s-button>
          ) : (
            <s-box />
          )}

          {rightLabel && typeof onRight === "function" ? (
            <s-button
              tone={rightTone}
              disabled={rightDisabled}
              onClick={onRight}
              command={rightCommand}
              commandFor={rightCommandFor}
            >
              {rightLabel}
            </s-button>
          ) : (
            <s-box />
          )}
        </s-stack>
      ) : (
        // ✅ コンディションのフッター：ボタンのみ（サマリー行は任意）
        <s-stack gap="base">
          {/* 上段：サマリー（左・中央・右）— いずれかが指定されているときのみ表示 */}
          {((summaryLeft != null && (typeof summaryLeft !== "string" ? true : String(summaryLeft).trim() !== "")) || hasCenter || (summaryRight != null && (typeof summaryRight !== "string" ? true : String(summaryRight).trim() !== ""))) ? (
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
              <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
                {typeof summaryLeft === "string" ? (
                  <s-text size="small" tone="subdued">
                    {summaryLeft}
                  </s-text>
                ) : (
                  summaryLeft
                )}
              </s-box>

              {hasCenter ? (
                <s-box style={{ flex: "1 1 0", minInlineSize: 0, textAlign: "center" }}>
                  {typeof summaryCenter === "string" ? (
                    <s-text size="small" tone="subdued">
                      {summaryCenter}
                    </s-text>
                  ) : (
                    summaryCenter
                  )}
                </s-box>
              ) : (
                <s-box style={{ flex: "1 1 0", minInlineSize: 0 }} />
              )}

              <s-box style={{ flex: "1 1 0", minInlineSize: 0, textAlign: "right" }}>
                {typeof summaryRight === "string" ? (
                  <s-text size="small" tone="subdued">
                    {summaryRight}
                  </s-text>
                ) : (
                  summaryRight
                )}
              </s-box>
            </s-stack>
          ) : null}

          {/* 下段：戻る [中央ボタン] 右ボタン */}
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-button tone={leftTone} disabled={leftDisabled} onClick={onLeft}>
              {leftLabel}
            </s-button>

            {hasMiddle ? (
              <s-button tone={middleTone} disabled={middleDisabled} onClick={onMiddle}>
                {middleLabel}
              </s-button>
            ) : (
              <s-box />
            )}

            {rightLabel && typeof onRight === "function" ? (
              <s-button
                tone={rightTone}
                disabled={rightDisabled}
                onClick={onRight}
                command={rightCommand}
                commandFor={rightCommandFor}
              >
                {rightLabel}
              </s-button>
            ) : (
              <s-box />
            )}
          </s-stack>
        </s-stack>
      )}
    </s-box>
  );
}
