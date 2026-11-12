import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

type ChoiceControl = "checkbox" | "radio";

/**
 * 設定・履歴の絞り込み行。クリックに加え Enter / Space で切り替える。
 * 未選択の枠は transparent（一覧）か neutral（#e1e3e5、並べ替え）。
 */
export function AdminChoiceRow({
  selected,
  onSelect,
  label,
  control = "checkbox",
  idleBorder = "transparent",
  style,
}: {
  selected: boolean;
  onSelect: () => void;
  label: ReactNode;
  control?: ChoiceControl;
  idleBorder?: "transparent" | "neutral";
  style?: CSSProperties;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  };

  return (
    <div
      role={control}
      aria-checked={selected}
      tabIndex={0}
      className="admin-choice"
      data-idle-border={idleBorder}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      style={style}
    >
      <input
        type={control}
        checked={selected}
        tabIndex={-1}
        aria-hidden="true"
        className="admin-choice-input"
        onChange={() => onSelect()}
        onClick={(event) => event.stopPropagation()}
      />
      <span className="admin-choice-label">{label}</span>
    </div>
  );
}

export function AdminNotice({
  children,
  tone = "warning",
  style,
}: {
  children: ReactNode;
  tone?: "warning" | "success" | "critical";
  style?: CSSProperties;
}) {
  return (
    <div className={`admin-notice admin-notice--${tone}`} style={style}>
      {children}
    </div>
  );
}

export function AdminSaveBar({
  status,
  onSave,
  onDiscard,
  saveDisabled,
  discardDisabled,
  saving,
}: {
  status: string;
  onSave: () => void;
  onDiscard: () => void;
  saveDisabled: boolean;
  discardDisabled: boolean;
  saving: boolean;
}) {
  return (
    <div className="admin-save-bar">
      <span className="admin-save-bar-status">{status}</span>
      <div className="admin-save-bar-actions">
        <button type="button" className="admin-secondary" onClick={onDiscard} disabled={discardDisabled}>
          破棄
        </button>
        <button type="button" className="admin-primary" onClick={onSave} disabled={saveDisabled}>
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}
