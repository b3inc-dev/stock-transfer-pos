import { applyPrinterProfile, printerGeometry, PRINTER_PROFILE_OPTIONS, type ReceiptPrinterProfile } from "../services/receiptPrinterProfile";
/**
 * レシートのブロックエディタ＋コード編集＋印字と同じプレビュー
 * （Shopify の POS レシートのブロックエディタを手本にした形）
 *
 * 左: ブロックの一覧（並べ替え・表示切替・削除・設定）／見た目／コード
 * 右: プレビュー（receiptLayoutRender.ts の印字と同じ関数で描く。見本のデータ）
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIconButton, MoveIconButton, SectionTabs, markFormDirty } from "./admin-ui";
import {
  blockDefsForKind,
  defaultSettings,
  getBlockDef,
  type SettingDef,
} from "../services/receiptLayoutBlocks";
import { sampleTemplateData } from "../services/receiptLayoutData";
import { presetsForKind } from "../services/receiptLayoutPresets";
import {
  blocksToCode,
  isSafeImageUrl,
  paperWidthPx,
  previewViewportPx,
  renderReceiptLayout,
  textSettingProblem,
} from "../services/receiptLayoutRender";
import {
  LAYOUT_LIMITS,
  PAPER_STYLE_LIMITS,
  defaultPaperPrintStyle,
  resolvePaperPrintStyle,
  type PaperPrintStyle,
  type BlockSettingValue,
  type LayoutBlock,
  type ReceiptKind,
  type ReceiptLayout,
} from "../services/receiptLayoutSchema";
import { ReceiptLayoutPreview } from "./ReceiptLayoutPreview";
import { readableSummaryText, TEMPLATE_VARIABLES } from "../services/receiptLayoutVariables";

type Tab = "blocks" | "style" | "code";

function newBlockId(type: string, blocks: LayoutBlock[]): string {
  let n = blocks.length + 1;
  let id = `${type}-${n}`.replace(/[^A-Za-z0-9_-]/g, "");
  while (blocks.some((b) => b.id === id)) id = `${type}-${++n}`;
  return id;
}

/** 表示・非表示の切り替え（目のアイコン）。隠しているときは目に斜線 */
function VisibilityIconButton({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  const id = "vis-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const label = hidden ? "表示する（今は隠している）" : "隠す（今は表示している）";
  return (
    <>
      <s-button
        variant="tertiary"
        icon={hidden ? "hide" : "view"}
        accessibilityLabel={label}
        interestFor={id}
        onClick={onClick}
      />
      <s-tooltip id={id}>{hidden ? "表示する" : "隠す"}</s-tooltip>
    </>
  );
}

function blockSummary(block: LayoutBlock): string {
  const def = getBlockDef(block.type);
  if (!def?.summaryKey) return "";
  const v = readableSummaryText(String(block.settings[def.summaryKey] ?? "")).replace(/\s+/g, " ").trim();
  return v.length > 24 ? `${v.slice(0, 24)}…` : v;
}

/**
 * 数の欄。打っている途中（空・「1.」など）は文字のまま持ち、数として読めたときだけ親へ渡す。
 * 範囲の外・空は欄の下に赤い文字で出す（保存の前の確認でも止まる）。
 */
export function NumField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  helpText,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number | "any";
  suffix?: string;
  helpText?: string;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // 外から値が変わったとき（ひな形・破棄）は欄も合わせる
  useEffect(() => {
    if (Number(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const n = draft.trim() === "" ? NaN : Number(draft);
  const error = !Number.isFinite(n) ? "数を入れてください" : n < min || n > max ? `${min}〜${max} にしてください` : undefined;
  return (
    <TextField
      label={label}
      type="number"
      autoComplete="off"
      value={draft}
      min={min}
      max={max}
      // Polarisの型はnumberのみだが、HTML inputは小数精度を保持するstep="any"を受け取る。
      step={step as number}
      suffix={suffix}
      helpText={helpText}
      error={error}
      onChange={(v) => {
        setDraft(v);
        const parsed = v.trim() === "" ? NaN : Number(v);
        if (Number.isFinite(parsed) && !v.endsWith(".")) onChange(parsed);
      }}
    />
  );
}

function SettingField({ def, value, onChange }: { def: SettingDef; value: BlockSettingValue; onChange: (v: BlockSettingValue) => void }) {
  switch (def.type) {
    case "checkbox":
      return <Checkbox label={def.label} checked={value === true} onChange={(v) => onChange(v)} helpText={def.help} />;
    case "select":
      if (def.options.length <= 5) {
        return (
          <ChoiceList
            title={def.label}
            choices={def.options.map((o) => ({ label: o.label, value: o.value }))}
            selected={[String(value)]}
            onChange={(v) => onChange(v[0] ?? def.default)}
          />
        );
      }
      return <Select label={def.label} options={def.options} value={String(value)} onChange={(v) => onChange(v)} helpText={def.help} />;
    case "number":
      return (
        <NumField
          label={def.label}
          value={Number(value)}
          min={def.min}
          max={def.max}
          suffix={def.unit}
          helpText={def.help}
          onChange={(v) => onChange(v)}
        />
      );
    case "url":
      return (
        <TextField
          label={def.label}
          type="url"
          autoComplete="off"
          value={String(value)}
          helpText={def.help}
          onChange={(v) => onChange(v.trim())}
          error={isSafeImageUrl(String(value)) ? undefined : "https:// で始まる画像の URL にしてください"}
        />
      );
    case "textarea":
    case "text": {
      const v = String(value);
      const error = textSettingProblem(v)
        ? textSettingProblem(v)!
        : v.length > LAYOUT_LIMITS.maxTextLength
          ? `${LAYOUT_LIMITS.maxTextLength} 文字までです`
          : undefined;
      return (
        <TextField
          label={def.label}
          autoComplete="off"
          value={v}
          multiline={def.type === "textarea" ? 3 : undefined}
          placeholder={"placeholder" in def ? def.placeholder : undefined}
          helpText={def.help}
          onChange={(nv) => onChange(nv)}
          error={error}
        />
      );
    }
  }
}


const EDITOR_CSS = `
.RL-grid{display:grid;grid-template-columns:minmax(320px,420px) minmax(0,1fr);gap:16px;align-items:start}
.RL-preview{position:sticky;top:16px;display:flex;flex-direction:column;align-items:center;gap:8px;background:#f1f1f1;border-radius:12px;padding:16px;overflow:auto;max-height:calc(100vh - 32px)}
.RL-preview-box{width:100%;min-width:0}
.RL-preview-paper{box-shadow:0 1px 4px rgba(0,0,0,.18);background:#fff}
.RL-jump{display:none}
.RL-row{display:flex;align-items:center;gap:4px;padding:6px 8px;border-radius:8px;cursor:pointer}
.RL-row:hover{background:#f6f6f6}
.RL-row[aria-current=true]{background:#ebebeb}
.RL-row-title{flex:1;min-width:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.RL-row[data-hidden=true] .RL-row-title{color:#8a8a8a;text-decoration:line-through}
.RL-settings{padding:8px 8px 16px 16px;border-left:2px solid #e3e3e3;margin:0 0 8px 12px}
.RL-code{width:100%;min-height:480px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;border:1px solid #8a8a8a;border-radius:8px;padding:8px;resize:vertical;tab-size:2;white-space:pre;overflow:auto}
.RL-vars{font-size:12px}
.RL-vars code{font-size:12px}
@media (max-width: 900px){.RL-grid{grid-template-columns:minmax(0,1fr)}.RL-preview{position:static;max-height:none;padding:8px}.RL-jump{display:block;padding:0 16px}.RL-code{font-size:16px}}
`;

export function ReceiptLayoutEditor({
  kind,
  initial,
  onLayoutChange,
  sampleData,
  printerProfile = "standard",
  paperWidthMm,
  active = true,
}: {
  kind: ReceiptKind;
  printerProfile?: ReceiptPrinterProfile;
  paperWidthMm?: 58 | 80;
  active?: boolean;
  /** プレビューの見本のデータ。無ければ receiptLayoutData.ts の見本（精算は店の並び順の設定を入れたもの） */
  sampleData?: ReturnType<typeof sampleTemplateData>;
  /** 開いた時点（保存した時点）のレイアウト。「破棄」でここに戻す */
  initial: ReceiptLayout;
  /** 今の値を親のフォームへ（保存の帯の判定と送信用） */
  onLayoutChange: (layout: ReceiptLayout) => void;
}) {
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const previewId = `rl-preview-${instanceId}`;
  const codeId = `rl-code-${instanceId}`;
  const [layout, setLayout] = useState<ReceiptLayout>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initial.mode === "code" ? "code" : "blocks");
  const [addType, setAddType] = useState<string>(blockDefsForKind(kind)[0]?.type ?? "");
  const [presetId, setPresetId] = useState<string>(presetsForKind(kind)[0]?.id ?? "standard");
  const root = useRef<HTMLDivElement | null>(null);

  // 「破棄」などで親が initial を差し替えたら、編集中の値も戻す
  useEffect(() => {
    setLayout(paperWidthMm ? { ...initial, paperWidthMm } : initial);
  }, [initial, paperWidthMm]);

  useEffect(() => {
    if (paperWidthMm) setLayout((prev) => prev.paperWidthMm === paperWidthMm ? prev : { ...prev, paperWidthMm });
  }, [paperWidthMm]);

  const update = (next: ReceiptLayout) => {
    setLayout(next);
    onLayoutChange(next);
  };
  // 親の hidden の値が変わったあとで、保存の帯に知らせる
  useEffect(() => {
    markFormDirty(root.current);
  }, [layout]);

  // コードは打つたびに描かず、少し待ってから描く
  const [renderTarget, setRenderTarget] = useState(layout);
  useEffect(() => {
    const t = window.setTimeout(() => setRenderTarget(layout), layout.mode === "code" ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [layout]);
  const rendered = useMemo(() => renderReceiptLayout(renderTarget, sampleData ?? sampleTemplateData(kind)), [renderTarget, kind, sampleData]);

  const geometry = printerGeometry(printerProfile, layout.paperWidthMm);
  const previewHtml = applyPrinterProfile(rendered.html, printerProfile, layout.paperWidthMm);
  const paperStyle = resolvePaperPrintStyle(layout);
  const updatePaperStyle = (key: keyof PaperPrintStyle, value: number) => {
    const next = { ...paperStyle, [key]: value };
    update({ ...layout, paperStyles: { ...layout.paperStyles, [layout.paperWidthMm]: next } });
  };
  const defs = blockDefsForKind(kind);
  const setBlocks = (blocks: LayoutBlock[]) => update({ ...layout, blocks });
  const move = (i: number, d: -1 | 1) => {
    const blocks = [...layout.blocks];
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    setBlocks(blocks);
  };
  const addBlock = () => {
    const def = getBlockDef(addType);
    if (!def || layout.blocks.length >= LAYOUT_LIMITS.maxBlocks) return;
    const block: LayoutBlock = { id: newBlockId(def.type, layout.blocks), type: def.type, hidden: false, settings: defaultSettings(def) };
    const at = selected ? layout.blocks.findIndex((b) => b.id === selected) + 1 : layout.blocks.length;
    const blocks = [...layout.blocks];
    blocks.splice(at, 0, block);
    setBlocks(blocks);
    setSelected(block.id);
  };
  const applyPreset = () => {
    const preset = presetsForKind(kind).find((p) => p.id === presetId);
    if (!preset) return;
    // 用紙の幅は今の値を残す（ひな形は見た目だけ）
    update({ ...preset.build(kind), paperWidthMm: layout.paperWidthMm });
    setSelected(null);
    setTab("blocks");
  };

  const onCodeKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value } = el;
    const next = `${value.slice(0, s)}  ${value.slice(en)}`;
    update({ ...layout, code: next });
    window.requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  };

  return (
    <div ref={root}>
      <style>{EDITOR_CSS}</style>
      <div className="RL-grid">
        <BlockStack gap="400">
          <div className="RL-jump">
            <Button
              variant="tertiary"
              onClick={() => document.getElementById(previewId)?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              プレビューを見る
            </Button>
          </div>
          <SectionTabs
            label="編集すること"
            items={[
              { key: "blocks", label: "ブロック" },
              { key: "style", label: "見た目" },
              { key: "code", label: "コード" },
            ]}
            selected={tab}
            onSelect={(v: string) => setTab(v as Tab)}
          />

          {tab === "blocks" ? (
            <Card>
              <BlockStack gap="300">
                {layout.mode === "code" ? (
                  <Text as="p" tone="caution">
                    今はコードで印字しています。ブロックの変更は「コード」の「ブロックに戻す」を押すまで印字に出ません。
                  </Text>
                ) : null}
                <div role="list" aria-label="ブロックの一覧">
                  {layout.blocks.map((block, i) => {
                    const def = getBlockDef(block.type);
                    if (!def) return null;
                    const open = selected === block.id;
                    const summary = blockSummary(block);
                    return (
                      <div role="listitem" key={block.id}>
                        <div
                          className="RL-row"
                          aria-current={open}
                          data-hidden={block.hidden === true}
                        >
                          <button
                            type="button"
                            className="RL-row-title"
                            aria-expanded={open}
                            onClick={() => setSelected(open ? null : block.id)}
                            style={{ textAlign: "left", background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer" }}
                          >
                            {def.label}
                            {summary ? <Text as="span" tone="subdued">{` ${summary}`}</Text> : null}
                          </button>
                          <span style={{ display: "inline-flex", gap: 2 }}>
                            <MoveIconButton label="上へ" direction="up" onClick={() => move(i, -1)} disabled={i === 0 || (kind === "reservation" && ["reservation_info", "reservation_items"].includes(block.type))} />
                            <MoveIconButton label="下へ" direction="down" onClick={() => move(i, 1)} disabled={i === layout.blocks.length - 1 || (kind === "reservation" && ["reservation_info", "reservation_items"].includes(block.type))} />
                            {kind === "reservation" && ["reservation_info", "reservation_items"].includes(block.type) ? null : <><VisibilityIconButton
                              hidden={block.hidden === true}
                              onClick={() => setBlocks(layout.blocks.map((b) => (b.id === block.id ? { ...b, hidden: !b.hidden } : b)))}
                            />
                            <DeleteIconButton
                              label="削除"
                              onClick={() => {
                                setBlocks(layout.blocks.filter((b) => b.id !== block.id));
                                if (open) setSelected(null);
                              }}
                            /></>}
                          </span>
                        </div>
                        {open ? (
                          <div className="RL-settings">
                            <BlockStack gap="300">
                              <Text as="p" tone="subdued">{def.description}</Text>
                              {def.settings.map((s) => (
                                <SettingField
                                  key={s.key}
                                  def={s}
                                  value={block.settings[s.key] ?? s.default}
                                  onChange={(v) =>
                                    setBlocks(layout.blocks.map((b) => (b.id === block.id ? { ...b, settings: { ...b.settings, [s.key]: v } } : b)))
                                  }
                                />
                              ))}
                            </BlockStack>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <InlineStack gap="200" blockAlign="end" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <Select
                      label="ブロックを追加"
                      options={defs.map((d) => ({ label: d.label, value: d.type }))}
                      value={addType}
                      onChange={setAddType}
                      helpText={getBlockDef(addType)?.description}
                    />
                  </div>
                  <Button onClick={addBlock} disabled={layout.blocks.length >= LAYOUT_LIMITS.maxBlocks}>追加</Button>
                </InlineStack>
                <InlineStack gap="200" blockAlign="end" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <Select
                      label="ひな形から作り直す"
                      options={presetsForKind(kind).map((p) => ({ label: p.label, value: p.id }))}
                      value={presetId}
                      onChange={setPresetId}
                      helpText="今のブロックを置きかえます。保存するまでは「破棄」で戻せます。"
                    />
                  </div>
                  <Button onClick={applyPreset}>置きかえる</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          ) : null}

          {tab === "style" ? (
            <Card>
              <BlockStack gap="300">
                {paperWidthMm ? <Text as="p" tone="subdued">用紙幅は上の基本設定で変更します。</Text> : <>
                <ChoiceList
                  title="用紙の幅"
                  choices={[
                    { label: "80mm", value: "80" },
                    { label: "58mm", value: "58" },
                  ]}
                  selected={[String(layout.paperWidthMm)]}
                  onChange={(v) => update({ ...layout, paperWidthMm: v[0] === "58" ? 58 : 80 })}
                />
                <Text as="p" tone="subdued">58mm・80mmごとの設定を保存できます。ここで選んだ幅で、この控えを印字します。</Text>
                </>}
                {layout.mode === "code" && !layout.code.includes("/* receipt-managed-paper-start */") ? (
                  <Text as="p" tone="caution">コードの固定値には下の設定は反映されません。paper変数を参照する項目だけに反映されます。既存コードは自動で上書きしません。</Text>
                ) : null}
                {([
                  ["fontSizePt", "本文の文字サイズ", "pt", 0.5],
                  ["amountFontSizePt", "金額・件数の文字サイズ", "pt", 0.5],
                  ["marginXMm", "左右の余白（片側）", "mm", 0.5],
                  ["marginYMm", "上下の余白（片側）", "mm", 0.5],
                  ["lineHeight", "行間", "倍", 0.05],
                ] as const).map(([key, label, suffix, step]) => (
                  <NumField key={layout.paperWidthMm + key} label={label} suffix={suffix} step={step}
                    min={PAPER_STYLE_LIMITS[key].min} max={PAPER_STYLE_LIMITS[key].max}
                    value={paperStyle[key]} onChange={(v) => updatePaperStyle(key, v)} />
                ))}
                <NumField label="ロゴの最大幅" suffix="%" min={15 / (layout.paperWidthMm === 58 ? 48 : 72) * 100}
                  max={42 / (layout.paperWidthMm === 58 ? 48 : 72) * 100} step="any"
                  value={paperStyle.logoWidthMm / (layout.paperWidthMm === 58 ? 48 : 72) * 100}
                  onChange={(v) => updatePaperStyle("logoWidthMm", v / 100 * (layout.paperWidthMm === 58 ? 48 : 72))}
                  helpText="印字領域に対する割合です。ブロックの「画像の幅」がこれより小さい場合は、ブロックの値を使います。" />
                <Text as="p" tone="subdued">プリンター補正：{PRINTER_PROFILE_OPTIONS.find((p) => p.value === printerProfile)?.label}。選択は上の「プリンター補正」で変更します。</Text>
                <details><summary>プレビューの個別調整</summary>
                <Text as="p" tone="subdued">共通のプリンター補正が有効な58mmでは、以下の個別値より共通設定を優先します。</Text>
                <Checkbox label="実測値でプレビューを補正する"
                  checked={layout.previewCalibration?.[layout.paperWidthMm] !== undefined}
                  onChange={(checked) => {
                    const next = { ...layout.previewCalibration };
                    if (checked) next[layout.paperWidthMm] = 100 * 25.4 / 96;
                    else delete next[layout.paperWidthMm];
                    update({ ...layout, previewCalibration: next });
                  }} />
                {layout.previewCalibration?.[layout.paperWidthMm] !== undefined ? (
                  <NumField label="100px診断線の実測長" suffix="mm" min={5} max={60} step="any"
                    value={layout.previewCalibration[layout.paperWidthMm]!}
                    onChange={(v) => update({ ...layout, previewCalibration: { ...layout.previewCalibration, [layout.paperWidthMm]: v } })}
                    helpText="診断印字の100pxの線を定規で測って入力します。この用紙幅のプレビューだけを補正し、印字サイズは変えません。" />
                ) : null}
                {layout.paperWidthMm === 58 ? (
                  <Button onClick={() => update({ ...layout, previewCalibration: { ...layout.previewCalibration, 58: 12 } })}>
                    mPOP・58mmの実測値でプレビューを補正
                  </Button>
                ) : null}
                </details>
                <Button onClick={() => update({ ...layout, paperStyles: {
                  ...layout.paperStyles, [layout.paperWidthMm]: defaultPaperPrintStyle(layout.paperWidthMm),
                } })}>この用紙を推奨設定に戻す</Button>
                <ChoiceList
                  title="文字の太さ"
                  choices={[
                    { label: "標準", value: "400" },
                    { label: "やや太い", value: "600" },
                    { label: "太い", value: "700" },
                  ]}
                  selected={[String(layout.style.fontWeight)]}
                  onChange={(v) => update({ ...layout, style: { ...layout.style, fontWeight: Number(v[0]) as 400 | 600 | 700 } })}
                />
                <ChoiceList
                  title="書体"
                  choices={[
                    { label: "ゴシック", value: "sans" },
                    { label: "明朝", value: "serif" },
                    { label: "等幅", value: "mono" },
                  ]}
                  selected={[layout.style.fontFamily]}
                  onChange={(v) => update({ ...layout, style: { ...layout.style, fontFamily: v[0] as ReceiptLayout["style"]["fontFamily"] } })}
                />
                <TextField
                  label="追加の CSS"
                  autoComplete="off"
                  multiline={4}
                  monospaced
                  value={layout.style.customCss}
                  helpText="ブロックの見た目を細かく変えるときに使います（例: .logo-text{font-size:3em}）。"
                  onChange={(v) => update({ ...layout, style: { ...layout.style, customCss: v } })}
                />
              </BlockStack>
            </Card>
          ) : null}

          {tab === "code" ? (
            <Card>
              <BlockStack gap="300">
                {layout.mode === "blocks" ? (
                  <>
                    <Text as="p">
                      今のブロックからテンプレート（Liquid）のコードを作り、コードで細かく作り込めます。コードで保存すると、印字はコードを使います。
                    </Text>
                    <InlineStack>
                      <Button onClick={() => update({ ...layout, mode: "code", code: blocksToCode(layout) })}>コードで編集を始める</Button>
                    </InlineStack>
                  </>
                ) : (
                  <>
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" tone="subdued">{`${layout.code.length.toLocaleString()} / ${LAYOUT_LIMITS.maxCodeLength.toLocaleString()} 文字`}</Text>
                      <InlineStack gap="200">
                        <Button onClick={() => update({ ...layout, code: blocksToCode(layout) })}>ブロックから作り直す</Button>
                        <Button onClick={() => update({ ...layout, mode: "blocks" })}>ブロックに戻す</Button>
                      </InlineStack>
                    </InlineStack>
                    <label htmlFor={codeId} className="Admin-note">テンプレートのコード（Liquid）</label>
                    <textarea
                      id={codeId}
                      className="RL-code"
                      spellCheck={false}
                      value={layout.code}
                      maxLength={LAYOUT_LIMITS.maxCodeLength}
                      onChange={(e) => update({ ...layout, code: e.target.value })}
                      onKeyDown={onCodeKey}
                    />
                  </>
                )}
                <details className="RL-vars">
                  <summary>使える値（変数）</summary>
                  <Box paddingBlockStart="200">
                    <BlockStack gap="100">
                      {TEMPLATE_VARIABLES[kind].map((v) => (
                        <div key={v.name}>
                          <code>{`{{ ${v.name} }}`}</code> {v.label}
                        </div>
                      ))}
                      <div>
                        フィルター: <code>{"| money"}</code>（¥1,234）、<code>{"| number"}</code>（1,234）、<code>{"| qrcode | raw"}</code>（QR コード）、<code>{"| business_day_label: 4, \"2026-01-01,2026-01-12\""}</code>（土日と休みを除いた 4 営業日後）、ほか Liquid の標準のフィルター。値は自動で HTML エスケープされます。<code>{"| raw"}</code> はそのまま出すので、お客様が入れた値（メモ・宛名・属性）には使わないでください。
                      </div>
                    </BlockStack>
                  </Box>
                </details>
              </BlockStack>
            </Card>
          ) : null}
        </BlockStack>

        <div className="RL-preview" id={previewId} aria-label="プレビュー">
          <Text as="p" tone="subdued">{`プレビュー（見本のデータ・${layout.paperWidthMm}mm）`}</Text>
          <Text as="p" tone="subdued">{geometry.viewportPx !== undefined
            ? "プリンター共通設定で印字後の縦横比・折り返しを再現しています。画面上の実寸・書体は実紙面で確認してください。"
            : layout.previewCalibration?.[layout.paperWidthMm] !== undefined
            ? "実測値で文字の比率・折り返しを補正しています。画面上の実寸や書体・機種差は実紙面で確認してください。"
            : "未補正の見本です。実印字と文字の比率・折り返しが違う場合は実測値で補正してください。"}</Text>
          {rendered.ok ? null : (
            <div role="alert" style={{ color: "#8e1f0b", maxWidth: paperWidthPx(layout.paperWidthMm) }}>
              {rendered.error}
            </div>
          )}
          <ReceiptLayoutPreview html={previewHtml} widthPx={paperWidthPx(layout.paperWidthMm)} viewportPx={geometry.viewportPx ?? previewViewportPx(layout)} horizontalScale={geometry.horizontalScale} refreshKey={active} />
        </div>
      </div>
    </div>
  );
}
