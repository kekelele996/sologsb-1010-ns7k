import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  analyzeProject,
  autoBrailleForRange,
  brailleCellCount,
  buildLinePieces,
  effectiveBraille,
  findOccurrences,
  makeCorrection,
  makeRule,
  outputText,
  snapSelection,
  transcribeLine,
  updateRuleInSet,
} from './braille';
import { createInitialProject } from './sample';
import type {
  CorrectionStaleReason,
  HistoryState,
  LocalCorrection,
  ProofIssue,
  ProjectState,
  TextbookLine,
  VersionSnapshot,
} from './types';

const STORAGE_KEY = 'sologsb-1010-braille-project-v1';
const HISTORY_LIMIT = 60;

type HistoryAction =
  | { type: 'commit'; label: string; update: (state: ProjectState) => ProjectState }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'restore'; label: string; state: ProjectState };

function cloneState(state: ProjectState): ProjectState {
  return structuredClone(state);
}

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      lastAction: '撤销',
    };
  }

  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return {
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: next,
      future: state.future.slice(1),
      lastAction: '重做',
    };
  }

  const next = action.type === 'restore' ? cloneState(action.state) : action.update(cloneState(state.present));
  if (next === state.present) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    lastAction: action.label,
  };
}

function loadInitialState(): ProjectState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectState;
      return analyzeProject({ ...parsed, corrections: parsed.corrections ?? [] });
    }
  } catch {
    // 清除损坏草稿并使用内置示例。
  }
  return createInitialProject();
}

function useProject() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: loadInitialState(),
    future: [],
    lastAction: '已恢复本地草稿',
  }));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.present));
  }, [history.present]);

  const commit = (label: string, update: (state: ProjectState) => ProjectState) => dispatch({ type: 'commit', label, update });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const restore = (state: ProjectState) => dispatch({ type: 'restore', label: '恢复版本', state });

  return { state: history.present, history, commit, undo, redo, restore };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function issueLabel(issue: ProofIssue): string {
  if (issue.severity === 'error') return '阻断';
  if (issue.severity === 'warning') return '可疑';
  return '建议';
}

function correctionStatusLabel(correction: LocalCorrection): string {
  if (correction.stale) return '过期';
  if (correction.status === 'approved') return '已保留';
  if (correction.status === 'revoked') return '已撤销';
  return '待确认';
}

const STALE_REASON_TEXT: Record<CorrectionStaleReason, string> = {
  'not-found': '原文中已找不到该片段',
  duplicated: '片段在全文出现多处，无法确定对应位置',
  'braille-changed': '该段自动盲文已因规则变化而不同',
};

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RuleSetPanel({
  state,
  onSelect,
  onUpdateRule,
  onToggleContractions,
  onAddRule,
  onRecheck,
}: {
  state: ProjectState;
  onSelect: (id: string) => void;
  onUpdateRule: (ruleId: string, patch: Record<string, unknown>) => void;
  onToggleContractions: () => void;
  onAddRule: (source: string, output: string, suspicious: boolean) => void;
  onRecheck: () => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const [showAllRules, setShowAllRules] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [suspicious, setSuspicious] = useState(true);
  const visibleRules = showAllRules ? active.rules : active.rules.filter((rule) => rule.kind === 'contraction' || rule.suspicious);

  return (
    <aside class="left-panel scroll-pane" aria-label="规则集与规则编辑">
      <Section title="规则集" subtitle="切换后会自动重转录全部行">
        <div class="stack-sm">
          {state.ruleSets.map((ruleSet) => (
            <button class={`rule-set-card ${ruleSet.id === active.id ? 'active' : ''}`} key={ruleSet.id} onClick={() => onSelect(ruleSet.id)}>
              <span>
                <strong>{ruleSet.name}</strong>
                <small>{ruleSet.rules.filter((rule) => rule.enabled).length} 条启用规则</small>
              </span>
              <span class="radio-dot" aria-hidden="true" />
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="当前规则"
        subtitle={active.description}
        action={<md-text-button onClick={onRecheck}>重新检查</md-text-button>}
      >
        <div class="inline-controls">
          <md-checkbox checked={active.contractions} onInput={onToggleContractions} label="启用缩写" />
          <md-filled-tonal-button onClick={() => setShowAllRules((value) => !value)}>
            {showAllRules ? '只看常用规则' : '查看全部规则'}
          </md-filled-tonal-button>
        </div>
      </Section>

      <Section title="缩写与标点" subtitle="可疑规则会在校对区生成提醒">
        <div class="rule-list">
          {visibleRules.map((rule) => (
            <div class={`rule-row ${rule.suspicious ? 'suspicious' : ''}`} key={rule.id}>
              <md-checkbox checked={rule.enabled} onInput={() => onUpdateRule(rule.id, { enabled: !rule.enabled })} aria-label={`启用 ${rule.source}`} />
              <md-outlined-text-field
                class="rule-source"
                value={rule.source}
                label="原文"
                onInput={(event: any) => onUpdateRule(rule.id, { source: event.currentTarget.value })}
              />
              <md-outlined-text-field
                class="rule-output"
                value={rule.output}
                label="盲文"
                onInput={(event: any) => onUpdateRule(rule.id, { output: event.currentTarget.value })}
              />
              <md-icon-button
                class={rule.suspicious ? 'warning-button active' : 'warning-button'}
                aria-label={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                title={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                onClick={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })}
              >
                {rule.suspicious ? '!' : '○'}
              </md-icon-button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="新增规则" subtitle="可添加缩写、字母组合或自定义符号">
        <div class="stack-sm">
          <md-outlined-text-field value={newSource} label="原文或组合" onInput={(event: any) => setNewSource(event.currentTarget.value)} />
          <md-outlined-text-field value={newOutput} label="盲文单元" onInput={(event: any) => setNewOutput(event.currentTarget.value)} />
          <md-checkbox checked={suspicious} onInput={() => setSuspicious((value) => !value)} label="标记为可疑规则" />
          <md-filled-button
            disabled={!newSource.trim() || !newOutput.trim()}
            onClick={() => {
              onAddRule(newSource.trim(), newOutput.trim(), suspicious);
              setNewSource('');
              setNewOutput('');
            }}
          >
            添加并检查
          </md-filled-button>
        </div>
      </Section>
    </aside>
  );
}

function LineCard({
  line,
  index,
  selected,
  issues,
  corrections,
  lines,
  onSelect,
  onChange,
  onNote,
  onStatus,
  onDelete,
  onCreateCorrection,
  onJumpToCorrection,
}: {
  line: TextbookLine;
  index: number;
  selected: boolean;
  issues: ProofIssue[];
  corrections: LocalCorrection[];
  lines: TextbookLine[];
  onSelect: () => void;
  onChange: (source: string) => void;
  onNote: (note: string) => void;
  onStatus: (status: TextbookLine['status']) => void;
  onDelete: () => void;
  onCreateCorrection: (payload: { lineId: string; fragment: string; start: number; end: number; replacement: string; reason: string }) => void;
  onJumpToCorrection: () => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const lineIssues = unresolved.filter((issue) => issue.lineId === line.id);
  const lineCorrections = corrections
    .filter((correction) => correction.lineId === line.id && correction.status !== 'revoked')
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const pieces = useMemo(() => buildLinePieces(line, corrections), [line, corrections]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState<{ start: number; end: number } | null>(null);
  const [replacement, setReplacement] = useState('');
  const [reason, setReason] = useState('');

  const captureSelection = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (textarea.selectionStart === textarea.selectionEnd) return;
    const snapped = snapSelection(line.tokens, textarea.selectionStart, textarea.selectionEnd);
    setDraft(snapped);
    setReplacement('');
    setReason('');
  };

  // 原文变化后选区可能失效，重新吸附；无法吸附则关闭表单。
  useEffect(() => {
    if (!draft) return;
    const snapped = snapSelection(line.tokens, draft.start, draft.end);
    setDraft(snapped);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.source]);

  const draftFragment = draft ? line.source.slice(draft.start, draft.end) : '';
  const occurrences = draft ? findOccurrences(lines, draftFragment) : [];
  const overlap = draft
    ? corrections.some((correction) => correction.status !== 'revoked' && correction.lineId === line.id
        && correction.start !== undefined && correction.end !== undefined
        && correction.start < draft.end && correction.end! > draft.start)
    : false;
  const canSave = Boolean(draft) && replacement.trim().length > 0 && reason.trim().length > 0 && !overlap;

  const submitCorrection = () => {
    if (!draft || !canSave) return;
    onCreateCorrection({
      lineId: line.id,
      fragment: draftFragment,
      start: draft.start,
      end: draft.end,
      replacement: replacement.trim(),
      reason: reason.trim(),
    });
    setDraft(null);
    setReplacement('');
    setReason('');
  };

  return (
    <article class={`line-card ${selected ? 'selected' : ''}`} id={`line-card-${line.id}`} onClick={onSelect}>
      <div class="line-gutter">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <span class={`line-status ${line.status}`} title={`状态：${line.status}`} />
      </div>
      <div class="line-body">
        <div class="line-source">
          <textarea
            ref={textareaRef}
            aria-label={`第 ${index + 1} 行原文`}
            value={line.source}
            rows={Math.max(1, Math.ceil(line.source.length / 52))}
            onFocus={onSelect}
            onSelect={captureSelection}
            onMouseUp={captureSelection}
            onKeyUp={(event: KeyboardEvent) => {
              if (event.key === 'Shift' || event.key.startsWith('Arrow')) captureSelection();
            }}
            onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="line-actions">
            <md-icon-button
              aria-label="为选中片段补局部改字"
              title="选中原文片段后补局部改字"
              onClick={(event: MouseEvent) => { event.stopPropagation(); captureSelection(); }}
            >✎</md-icon-button>
            <md-icon-button aria-label="标记待核对" title="标记待核对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('questionable'); }}>?</md-icon-button>
            <md-icon-button aria-label="标记已校对" title="标记已校对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('reviewed'); }}>✓</md-icon-button>
            <md-icon-button aria-label="批准此行" title="批准此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('approved'); }}>★</md-icon-button>
            <md-icon-button aria-label="删除此行" title="删除此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onDelete(); }}>×</md-icon-button>
          </div>
        </div>
        <div class="braille-preview" aria-label={`第 ${index + 1} 行盲文预览`}>
          {line.tokens.length === 0 && <span class="empty-preview">空行</span>}
          {pieces.map((piece) => {
            if (piece.kind === 'correction') {
              const correction = piece.correction;
              return (
                <span class={`braille-piece-correction ${correction.status === 'approved' ? 'approved' : 'pending'}`} key={correction.id} title={`局部改字：${correction.fragment} → ${correction.replacement}（${correction.reason}）`}>
                  <b>{correction.fragment}</b>
                  <span>{correction.replacement}</span>
                </span>
              );
            }
            const token = piece.token;
            return token.text === ' ' ? <span class="space-token" title="分词空格" /> : (
              <span
                key={token.id}
                class={`braille-token ${token.suspicious ? 'suspicious' : ''} ${token.braille.includes('⟦') ? 'error' : ''}`}
                title={`${token.text || '标记'} → ${token.braille}`}
              >
                <b>{token.text || '标记'}</b>
                <span>{token.braille}</span>
              </span>
            );
          })}
        </div>
        {lineCorrections.length > 0 && (
          <div class="correction-chips">
            {lineCorrections.map((correction) => (
              <button
                type="button"
                class={`correction-chip ${correction.status} ${correction.stale ? 'stale' : ''}`}
                key={correction.id}
                title={correction.stale ? `已过期：${STALE_REASON_TEXT[correction.staleReason ?? 'not-found']}` : correction.reason}
                onClick={(event: MouseEvent) => { event.stopPropagation(); if (!correction.stale && correction.lineId) onJumpToCorrection(); }}
              >
                <em>{correctionStatusLabel(correction)}</em>
                <b>{correction.fragment}</b>→<span>{correction.replacement}</span>
              </button>
            ))}
          </div>
        )}
        {lineIssues.length > 0 && (
          <div class="line-warnings">
            {lineIssues.slice(0, 3).map((item) => (
              <span class={`issue-chip ${item.severity}`} key={item.id}>{issueLabel(item)} · {item.message}</span>
            ))}
          </div>
        )}
        {selected && draft && (
          <div class="correction-form" onClick={(event: MouseEvent) => event.stopPropagation()}>
            <div class="correction-form-head">
              <strong>补局部改字</strong>
              <span class="correction-fragment">片段“{draftFragment}” · 自动盲文 {autoBrailleForRange(line.tokens, draft.start, draft.end) || '（空）'}</span>
              <md-icon-button aria-label="取消补改字" title="取消" onClick={() => setDraft(null)}>×</md-icon-button>
            </div>
            {occurrences.length > 1 && <p class="correction-warn">该片段全文出现 {occurrences.length} 处，将锚定当前位置；若该位置日后消失会标为过期，建议精简片段使其唯一。</p>}
            {overlap && <p class="correction-warn">该区间已有改字，请先撤销或调整选区。</p>}
            <div class="correction-fields">
              <md-outlined-text-field
                value={replacement}
                label="替换盲文"
                onInput={(event: any) => setReplacement(event.currentTarget.value)}
              />
              <md-outlined-text-field
                value={reason}
                label="改字原因（必填）"
                onInput={(event: any) => setReason(event.currentTarget.value)}
              />
            </div>
            <div class="correction-form-actions">
              <md-text-button onClick={() => setDraft(null)}>取消</md-text-button>
              <md-filled-button disabled={!canSave} onClick={submitCorrection}>保存并优先采用</md-filled-button>
            </div>
          </div>
        )}
        {selected && (
          <md-outlined-text-field
            class="note-field"
            value={line.note}
            label="校对备注"
            onInput={(event: any) => onNote(event.currentTarget.value)}
          />
        )}
      </div>
    </article>
  );
}

function EditorPanel({
  state,
  onSelectLine,
  onChangeLine,
  onNote,
  onStatus,
  onDelete,
  onAddLine,
  onSplitLongLines,
  onImport,
  onCreateCorrection,
}: {
  state: ProjectState;
  onSelectLine: (id: string, scroll?: boolean) => void;
  onChangeLine: (id: string, source: string) => void;
  onNote: (id: string, note: string) => void;
  onStatus: (id: string, status: TextbookLine['status']) => void;
  onDelete: (id: string) => void;
  onAddLine: () => void;
  onSplitLongLines: () => void;
  onImport: (text: string) => void;
  onCreateCorrection: (payload: { lineId: string; fragment: string; start: number; end: number; replacement: string; reason: string }) => void;
}) {
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <main class="editor-panel" aria-label="逐行转录校对区">
      <div class="editor-toolbar">
        <div>
          <span class="eyebrow">逐行校对</span>
          <h1>{state.title}</h1>
          <p>{state.author} · {state.lines.length} 行 · {brailleCellCount(state)} 格</p>
        </div>
        <div class="toolbar-actions">
          <md-outlined-button onClick={() => setShowImport((value) => !value)}>导入课文</md-outlined-button>
          <md-outlined-button onClick={onSplitLongLines}>按句拆分</md-outlined-button>
          <md-filled-button onClick={onAddLine}>新增行</md-filled-button>
        </div>
      </div>

      {showImport && (
        <div class="import-strip">
          <md-outlined-text-field
            type="textarea"
            rows={5}
            value={importText}
            label="粘贴课文；换行或句末标点将被拆成行"
            onInput={(event: any) => setImportText(event.currentTarget.value)}
          />
          <div>
            <md-text-button onClick={() => { setImportText(''); setShowImport(false); }}>取消</md-text-button>
            <md-filled-button
              disabled={!importText.trim()}
              onClick={() => {
                onImport(importText);
                setImportText('');
                setShowImport(false);
              }}
            >
              替换并重新转录
            </md-filled-button>
          </div>
        </div>
      )}

      <div class="line-list scroll-pane">
        {state.lines.map((line, index) => (
          <LineCard
            key={line.id}
            line={line}
            index={index}
            lines={state.lines}
            selected={state.selectedLineId === line.id}
            issues={state.issues}
            corrections={state.corrections}
            onSelect={() => onSelectLine(line.id)}
            onChange={(source) => onChangeLine(line.id, source)}
            onNote={(note) => onNote(line.id, note)}
            onStatus={(status) => onStatus(line.id, status)}
            onDelete={() => onDelete(line.id)}
            onCreateCorrection={onCreateCorrection}
            onJumpToCorrection={() => onSelectLine(line.id, true)}
          />
        ))}
      </div>
    </main>
  );
}

function IssuesPanel({
  issues,
  lines,
  onJump,
  onResolve,
  onBatchFix,
}: {
  issues: ProofIssue[];
  lines: TextbookLine[];
  onJump: (lineId: string) => void;
  onResolve: (issueId: string) => void;
  onBatchFix: (ruleId: string) => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const grouped = useMemo(() => {
    const map = new Map<string, ProofIssue[]>();
    unresolved.forEach((item) => {
      const key = item.ruleId ? `rule:${item.ruleId}` : `code:${item.code}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return [...map.entries()];
  }, [unresolved]);

  return (
    <div class="inspector-body">
      {grouped.length === 0 && <div class="empty-state"><span>✓</span><strong>没有未处理问题</strong><p>可以记录版本或导出打印稿。</p></div>}
      {grouped.map(([key, group]) => {
        const lineNumbers = group.map((item) => lines.findIndex((line) => line.id === item.lineId) + 1).join('、');
        return (
          <div class="issue-group" key={key}>
            <div class="issue-group-head">
              <span class={`severity-dot ${group[0].severity}`} />
              <div>
                <strong>{group[0].message}</strong>
                <p>影响第 {lineNumbers} 行 · 共 {group.length} 处</p>
              </div>
            </div>
            <div class="issue-actions">
              <md-text-button onClick={() => onJump(group[0].lineId)}>定位首处</md-text-button>
              {group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => onBatchFix(group[0].ruleId!)}>停用规则并修正同类</md-filled-tonal-button>
              )}
              {!group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => group.forEach((item) => onResolve(item.id))}>全部标记已处理</md-filled-tonal-button>
              )}
              <md-icon-button aria-label="标记此项已处理" title="标记已处理" onClick={() => onResolve(group[0].id)}>✓</md-icon-button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RuleDetailPanel({ state, onUpdateRule, onDeleteRule }: { state: ProjectState; onUpdateRule: (id: string, patch: Record<string, unknown>) => void; onDeleteRule: (id: string) => void }) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  return (
    <div class="inspector-body">
      <div class="rule-summary">
        <strong>{active.name}</strong>
        <p>{active.description}</p>
        <div class="metric-row"><span>{active.rules.filter((rule) => rule.enabled).length} 条启用</span><span>{active.rules.filter((rule) => rule.suspicious).length} 条可疑</span></div>
      </div>
      {active.rules.map((rule) => (
        <div class="rule-detail-card" key={rule.id}>
          <div>
            <strong>{rule.source || '数字符'}</strong>
            <span>{rule.output} · {rule.kind}</span>
            {rule.description && <p>{rule.description}</p>}
          </div>
          <div class="rule-detail-actions">
            <md-checkbox checked={rule.suspicious} onInput={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })} label="可疑" />
            <md-icon-button aria-label="删除规则" title="删除规则" onClick={() => onDeleteRule(rule.id)}>×</md-icon-button>
          </div>
        </div>
      ))}
    </div>
  );
}

function VersionsPanel({ state, onSnapshot, onRestore }: { state: ProjectState; onSnapshot: () => void; onRestore: (version: VersionSnapshot) => void }) {
  return (
    <div class="inspector-body">
      <div class="snapshot-callout">
        <div><strong>本地版本记录</strong><p>保存当前规则、原文、状态和备注的完整快照。</p></div>
        <md-filled-button onClick={onSnapshot}>记录版本</md-filled-button>
      </div>
      {state.versions.length === 0 && <div class="empty-state compact"><strong>还没有版本快照</strong><p>完成一轮校对后记录版本，便于比较和恢复。</p></div>}
      <div class="timeline">
        {state.versions.map((version) => (
          <div class="timeline-item" key={version.id}>
            <span class="timeline-dot" />
            <div>
              <strong>{version.name}</strong>
              <p>{version.action} · {formatTime(version.createdAt)}</p>
              <div class="metric-row"><span>{version.snapshot.lines.length} 行</span><span>{version.snapshot.issues.filter((issue) => !issue.resolved).length} 个未处理问题</span></div>
              <md-text-button onClick={() => onRestore(version)}>恢复此版本</md-text-button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CorrectionCard({
  correction,
  lineNumber,
  canJump,
  onJump,
  onApprove,
  onRevoke,
  onRebaseline,
  onDelete,
}: {
  correction: LocalCorrection;
  lineNumber: number;
  canJump: boolean;
  onJump: () => void;
  onApprove: () => void;
  onRevoke: () => void;
  onRebaseline: () => void;
  onDelete: () => void;
}) {
  return (
    <div class={`correction-card ${correction.status} ${correction.stale ? 'stale' : ''}`}>
      <div class="correction-card-head">
        <span class={`correction-badge ${correction.stale ? 'stale' : correction.status}`}>{correctionStatusLabel(correction)}</span>
        <button type="button" class="correction-location" disabled={!canJump} onClick={onJump} title={canJump ? '定位到该行' : '无法定位'}>
          第 {lineNumber > 0 ? lineNumber : '—'} 行 · {formatTime(correction.createdAt)}
        </button>
      </div>
      <div class="correction-swap">
        <span class="correction-frag">{correction.fragment}</span>
        <span class="correction-arrow">→</span>
        <span class="correction-repl">{correction.replacement}</span>
      </div>
      <p class="correction-reason">{correction.reason}</p>
      {correction.stale && <p class="correction-stale-note">已过期：{STALE_REASON_TEXT[correction.staleReason ?? 'not-found']}；不参与导出，需重新核对。</p>}
      <div class="correction-card-actions">
        {correction.stale && correction.staleReason === 'braille-changed' && (
          <md-text-button onClick={onRebaseline}>结果正确，重新确认</md-text-button>
        )}
        {correction.status !== 'revoked' && correction.status !== 'approved' && (
          <md-filled-tonal-button onClick={onApprove}>保留</md-filled-tonal-button>
        )}
        {correction.status !== 'revoked' && <md-text-button onClick={onRevoke}>撤销</md-text-button>}
        {correction.status === 'revoked' && <md-text-button onClick={onDelete}>删除记录</md-text-button>}
      </div>
    </div>
  );
}

function CorrectionsPanel({
  state,
  onJump,
  onApprove,
  onRevoke,
  onRebaseline,
  onDelete,
}: {
  state: ProjectState;
  onJump: (lineId: string) => void;
  onApprove: (id: string) => void;
  onRevoke: (id: string) => void;
  onRebaseline: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const corrections = state.corrections;
  const groups: { key: string; title: string; items: LocalCorrection[] }[] = [
    { key: 'pending', title: '待确认', items: corrections.filter((item) => !item.stale && item.status === 'pending') },
    { key: 'stale', title: '已过期 · 不参与导出', items: corrections.filter((item) => item.stale) },
    { key: 'approved', title: '已保留', items: corrections.filter((item) => !item.stale && item.status === 'approved') },
    { key: 'revoked', title: '已撤销', items: corrections.filter((item) => item.status === 'revoked') },
  ];

  const lineNumberOf = (correction: LocalCorrection): number => {
    if (!correction.lineId) return -1;
    return state.lines.findIndex((line) => line.id === correction.lineId) + 1;
  };

  return (
    <div class="inspector-body corrections-panel">
      <div class="correction-intro">
        在左侧原文中选中片段，点 ✎ 补局部改字。片段唯一时自动跟随移动；片段或自动盲文变化即过期。
      </div>
      {corrections.length === 0 && <div class="empty-state"><span>✎</span><strong>还没有局部改字</strong><p>选中原文片段，填入替换盲文和原因。</p></div>}
      {groups.map((group) => group.items.length > 0 && (
        <section class="correction-group" key={group.key}>
          <h3>{group.title}<span>{group.items.length}</span></h3>
          {group.items.map((correction) => (
            <CorrectionCard
              key={correction.id}
              correction={correction}
              lineNumber={lineNumberOf(correction)}
              canJump={!correction.stale && Boolean(correction.lineId)}
              onJump={() => correction.lineId && onJump(correction.lineId)}
              onApprove={() => onApprove(correction.id)}
              onRevoke={() => onRevoke(correction.id)}
              onRebaseline={() => onRebaseline(correction.id)}
              onDelete={() => onDelete(correction.id)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

export default function App() {
  const { state, history, commit, undo, redo, restore } = useProject();
  const [inspectorTab, setInspectorTab] = useState<'issues' | 'corrections' | 'rules' | 'versions'>('issues');
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  const activeRuleSet = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const unresolvedCount = state.issues.filter((issue) => !issue.resolved).length;
  const pendingCorrections = state.corrections.filter((correction) => !correction.stale && correction.status === 'pending');
  const staleCorrections = state.corrections.filter((correction) => correction.stale && correction.status !== 'revoked');
  const approvedCount = state.lines.filter((line) => line.status === 'approved').length;
  const progress = state.lines.length ? Math.round((approvedCount / state.lines.length) * 100) : 0;
  const attentionCount = pendingCorrections.length + staleCorrections.length;

  const selectLine = (lineId: string, scroll = false) => {
    if (lineId && lineId !== selectedLineRef.current) {
      commit('切换当前行', (current) => ({ ...current, selectedLineId: lineId }));
    }
    if (scroll) requestAnimationFrame(() => document.querySelector(`#line-card-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const changeLine = (lineId: string, source: string) => {
    commit('修改课文原文', (current) => analyzeProject({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, source } : line) }));
  };

  const changeStatus = (lineId: string, status: TextbookLine['status']) => {
    commit('更新校对状态', (current) => {
      const lines = current.lines.map((line) => line.id === lineId ? { ...line, status } : line);
      const issues = current.issues.map((item) => item.lineId === lineId && status === 'approved' ? { ...item, resolved: true } : item);
      return { ...current, lines, issues, updatedAt: new Date().toISOString() };
    });
  };

  const navigateLine = (direction: number) => {
    const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
    const next = state.lines[Math.max(0, Math.min(state.lines.length - 1, index + direction))];
    if (next && next.id !== selectedLineRef.current) selectLine(next.id, true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA/.test(target.tagName) || target.isContentEditable;
      if (modifier && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        recordVersion('快捷保存');
        return;
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        changeStatus(selectedLineRef.current, 'approved');
        const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
        if (state.lines[index + 1]) selectLine(state.lines[index + 1].id, true);
        return;
      }
      if (!editing && (event.key === 'ArrowDown' || event.key === 'j')) {
        event.preventDefault();
        navigateLine(1);
      }
      if (!editing && (event.key === 'ArrowUp' || event.key === 'k')) {
        event.preventDefault();
        navigateLine(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const createSnapshot = (action: string, source = state): VersionSnapshot => {
    const { versions: _versions, ...snapshot } = cloneState(source);
    return {
      id: `version-${Date.now().toString(36)}`,
      name: `${action} · ${source.lines.filter((line) => line.status === 'approved').length}/${source.lines.length} 行完成`,
      createdAt: new Date().toISOString(),
      action,
      snapshot,
    };
  };

  const recordVersion = (action = '手动记录') => {
    commit('记录版本快照', (current) => ({ ...current, versions: [createSnapshot(action, current), ...current.versions].slice(0, 20), updatedAt: new Date().toISOString() }));
  };

  const exportText = () => {
    const blob = new Blob([`${state.title}\n规则集：${activeRuleSet.name}\n\n${outputText(state)}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.title.replace(/[^\p{L}\p{N}-]+/gu, '-')}-盲文.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportPrint = () => {
    const printWindow = window.open('', '_blank', 'width=900,height=1100');
    if (!printWindow) return;
    const correctionMap = new Map<string, LocalCorrection[]>();
    state.corrections.forEach((correction) => {
      if (correction.stale || correction.status === 'revoked' || !correction.lineId) return;
      correctionMap.set(correction.lineId, [...(correctionMap.get(correction.lineId) ?? []), correction]);
    });
    const escapeHtml = (value: string) => value.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] ?? char));
    const rows = state.lines.map((line, index) => `
      <tr><td>${index + 1}</td><td>${escapeHtml(line.source)}</td><td class="braille">${escapeHtml(effectiveBraille(line, correctionMap.get(line.id) ?? []))}</td></tr>
    `).join('');
    printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${state.title}</title><style>body{font-family:Georgia,serif;color:#111;margin:36px}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top}td:first-child{width:36px;color:#666}.braille{font-family:"Apple Braille",sans-serif;font-size:24px}@media print{body{margin:16mm}}</style></head><body><h1>${state.title}</h1><p>${state.author} · ${activeRuleSet.name} · ${new Date().toLocaleDateString('zh-CN')}</p><table><thead><tr><th>#</th><th>原文</th><th>盲文校对稿</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),150)</script></body></html>`);
    printWindow.document.close();
  };

  const updateRule = (ruleId: string, patch: Record<string, unknown>) => {
    commit('修改转录规则', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, patch);
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) });
    });
  };

  const batchFixRule = (ruleId: string) => {
    commit('批量修正同类问题', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, { enabled: false });
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) });
    });
  };

  const createCorrection = (payload: { lineId: string; fragment: string; start: number; end: number; replacement: string; reason: string }) => {
    commit('补局部改字', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const line = current.lines.find((item) => item.id === payload.lineId);
      if (!line) return current;
      const tokens = transcribeLine(line.source, ruleSet);
      const baseline = autoBrailleForRange(tokens, payload.start, payload.end);
      const correction = makeCorrection(payload.lineId, payload.fragment, payload.start, payload.end, payload.replacement, payload.reason, baseline);
      return analyzeProject({ ...current, corrections: [...current.corrections, correction] });
    });
    setInspectorTab('corrections');
  };

  const approveCorrection = (correctionId: string) => {
    commit('保留局部改字', (current) => analyzeProject({
      ...current,
      corrections: current.corrections.map((item) => item.id === correctionId
        ? { ...item, status: 'approved' as const, stale: false, staleReason: undefined, updatedAt: new Date().toISOString() }
        : item),
    }));
  };

  const revokeCorrection = (correctionId: string) => {
    commit('撤销局部改字', (current) => analyzeProject({
      ...current,
      corrections: current.corrections.map((item) => item.id === correctionId
        ? { ...item, status: 'revoked' as const, stale: false, staleReason: undefined, updatedAt: new Date().toISOString() }
        : item),
    }));
  };

  const rebaselineCorrection = (correctionId: string) => {
    commit('重新确认局部改字', (current) => analyzeProject({
      ...current,
      corrections: current.corrections.map((item) => {
        if (item.id !== correctionId || !item.lineId || item.start === undefined || item.end === undefined) return item;
        const line = current.lines.find((l) => l.id === item.lineId);
        const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
        if (!line) return item;
        const tokens = transcribeLine(line.source, ruleSet);
        return {
          ...item,
          stale: false,
          staleReason: undefined,
          status: 'pending' as const,
          baselineBraille: autoBrailleForRange(tokens, item.start, item.end),
          updatedAt: new Date().toISOString(),
        };
      }),
    }));
  };

  const deleteCorrection = (correctionId: string) => {
    commit('删除局部改字记录', (current) => ({
      ...current,
      corrections: current.corrections.filter((item) => item.id !== correctionId),
      updatedAt: new Date().toISOString(),
    }));
  };

  const importCourse = (text: string) => {
    const sourceLines = text
      .replace(/\r/g, '')
      .split(/\n+|(?<=[.!?。！？])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit('导入课文', (current) => analyzeProject({
      ...current,
      lines: sourceLines.map((source, index) => ({ id: `line-import-${Date.now()}-${index}`, source, tokens: [], status: index === 0 ? 'questionable' : 'unchecked', note: index === 0 ? '导入后待确认规则集。' : '', continuesPrevious: false, continuesNext: false })),
      selectedLineId: '',
      issues: [],
    }));
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">⠿</div>
          <div><strong>BrailleAtelier</strong><span>盲文教材转录与校对工具</span></div>
        </div>
        <div class="topbar-center">
          <span class={`connection-dot ${navigator.onLine ? 'online' : ''}`} />
          {navigator.onLine ? '浏览器本地保存' : '离线模式 · 本地保存可继续'}
          <small>上次自动保存 {formatTime(state.updatedAt)}</small>
        </div>
        <div class="topbar-actions">
          <md-icon-button onClick={undo} disabled={history.past.length === 0} aria-label="撤销" title="撤销 ⌘Z">↶</md-icon-button>
          <md-icon-button onClick={redo} disabled={history.future.length === 0} aria-label="重做" title="重做 ⇧⌘Z">↷</md-icon-button>
          <md-outlined-button onClick={exportText}>导出文本</md-outlined-button>
          <md-filled-button onClick={exportPrint}>打印版导出</md-filled-button>
        </div>
      </header>

      <div class="status-ribbon">
        <div class="progress-block">
          <div><strong>{progress}%</strong><span>已批准 {approvedCount}/{state.lines.length} 行</span></div>
          <md-linear-progress value={progress / 100} aria-label="校对进度" />
        </div>
        <div class="status-stat warning"><strong>{unresolvedCount}</strong><span>未处理问题</span></div>
        <div class={`status-stat ${attentionCount > 0 ? 'warning' : ''}`}><strong>{attentionCount}</strong><span>改字待确认/过期</span></div>
        <div class="status-stat"><strong>{state.lines.filter((line) => line.status === 'questionable').length}</strong><span>待核对行</span></div>
        <div class="shortcut-hint">快捷键：⌘/Ctrl Z 撤销 · ⇧⌘/Ctrl Z 重做 · ⌘/Ctrl Enter 批准并下一行 · J/K 切换行</div>
      </div>

      <div class="workspace-grid">
        <RuleSetPanel
          state={state}
          onSelect={(id) => commit('切换规则集并重新检查', (current) => analyzeProject({ ...current, activeRuleSetId: id, issues: [] }))}
          onUpdateRule={updateRule}
          onToggleContractions={() => {
            const ruleSet = activeRuleSet;
            commit('切换缩写规则', (current) => analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === ruleSet.id ? { ...set, contractions: !set.contractions } : set) }));
          }}
          onAddRule={(source, output, suspicious) => {
            commit('新增转写规则', (current) => analyzeProject({
              ...current,
              ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: [...set.rules, makeRule(source, output, suspicious)] } : set),
            }));
          }}
          onRecheck={() => commit('重新检查全部内容', analyzeProject)}
        />

        <EditorPanel
          state={state}
          onSelectLine={selectLine}
          onChangeLine={changeLine}
          onNote={(lineId, note) => commit('添加校对备注', (current) => ({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, note } : line) }))}
          onStatus={changeStatus}
          onDelete={(lineId) => commit('删除课文行', (current) => {
            const lines = current.lines.filter((line) => line.id !== lineId);
            return analyzeProject({ ...current, lines: lines.length ? lines : [{ id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false }], selectedLineId: lines[0]?.id ?? '' });
          })}
          onAddLine={() => commit('新增课文行', (current) => {
            const line: TextbookLine = { id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false };
            return analyzeProject({ ...current, lines: [...current.lines, line], selectedLineId: line.id });
          })}
          onSplitLongLines={() => commit('按句拆分长行', (current) => {
            const lines = current.lines.flatMap((line) => line.source
              .split(/(?<=[.!?。！？])\s+|;\s*/)
              .filter((part) => part.trim())
              .map((source, index) => ({ ...line, id: index === 0 ? line.id : `line-split-${Date.now()}-${index}`, source: source.trim(), tokens: [], note: index === 0 ? line.note : '' })));
            return analyzeProject({ ...current, lines });
          })}
          onImport={importCourse}
          onCreateCorrection={createCorrection}
        />

        <aside class="right-panel">
          <div class="inspector-tabs" role="tablist">
            <button class={inspectorTab === 'issues' ? 'active' : ''} onClick={() => setInspectorTab('issues')}>问题 {unresolvedCount > 0 && <span>{unresolvedCount}</span>}</button>
            <button class={inspectorTab === 'corrections' ? 'active' : ''} onClick={() => setInspectorTab('corrections')}>改字 {attentionCount > 0 && <span>{attentionCount}</span>}</button>
            <button class={inspectorTab === 'rules' ? 'active' : ''} onClick={() => setInspectorTab('rules')}>规则</button>
            <button class={inspectorTab === 'versions' ? 'active' : ''} onClick={() => setInspectorTab('versions')}>版本 {state.versions.length > 0 && <span>{state.versions.length}</span>}</button>
          </div>
          {inspectorTab === 'issues' && (
            <IssuesPanel
              issues={state.issues}
              lines={state.lines}
              onJump={(lineId) => selectLine(lineId, true)}
              onResolve={(issueId) => commit('标记问题已处理', (current) => ({ ...current, issues: current.issues.map((item) => item.id === issueId ? { ...item, resolved: true } : item) }))}
              onBatchFix={batchFixRule}
            />
          )}
          {inspectorTab === 'corrections' && (
            <CorrectionsPanel
              state={state}
              onJump={(lineId) => selectLine(lineId, true)}
              onApprove={approveCorrection}
              onRevoke={revokeCorrection}
              onRebaseline={rebaselineCorrection}
              onDelete={deleteCorrection}
            />
          )}
          {inspectorTab === 'rules' && <RuleDetailPanel state={state} onUpdateRule={updateRule} onDeleteRule={(ruleId) => {
            commit('删除转录规则', (current) => analyzeProject({
              ...current,
              ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: set.rules.filter((rule) => rule.id !== ruleId) } : set),
            }));
          }} />}
          {inspectorTab === 'versions' && <VersionsPanel state={state} onSnapshot={() => recordVersion()} onRestore={(version) => {
            const restored: ProjectState = cloneState({ ...version.snapshot, versions: state.versions });
            restore(restored);
          }} />}
        </aside>
      </div>
    </div>
  );
}
