/**
 * 固定フッター（棚卸用・ロス拡張と同じ構成）
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
  middleCommand,
  middleCommandFor,
  centerAlignWithButtons = false,
}) {
  const hasCenter =
    summaryCenter !== undefined && summaryCenter !== null && String(summaryCenter).trim() !== "";
  const hasMiddle = !!middleLabel && (typeof onMiddle === "function" || middleCommand);

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
            <s-button tone={middleTone} disabled={middleDisabled} onClick={onMiddle} command={middleCommand} commandFor={middleCommandFor}>
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
        <s-stack gap="base">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-box style={{ flex: "1 1 0", minInlineSize: 0 }}>
              <s-text size="small" tone="subdued">
                {summaryLeft ?? ""}
              </s-text>
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
              <s-text size="small" tone="subdued">
                {summaryRight ?? ""}
              </s-text>
            </s-box>
          </s-stack>

          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-button tone={leftTone} disabled={leftDisabled} onClick={onLeft}>
              {leftLabel}
            </s-button>

            {hasMiddle ? (
              <s-button tone={middleTone} disabled={middleDisabled} onClick={onMiddle} command={middleCommand} commandFor={middleCommandFor}>
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
