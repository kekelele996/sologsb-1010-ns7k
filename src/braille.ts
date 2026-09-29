import type {
  BrailleToken,
  CorrectionPreview,
  CorrectionStaleReason,
  LocalCorrection,
  ProofIssue,
  ProjectState,
  RuleSet,
  TextbookLine,
  TranscriptionRule,
} from './types';

const LETTERS: Record<string, string> = {
  a: '⠁', b: '⠃', c: '⠉', d: '⠙', e: '⠑', f: '⠋', g: '⠛', h: '⠓', i: '⠊', j: '⠚',
  k: '⠅', l: '⠇', m: '⠍', n: '⠝', o: '⠕', p: '⠏', q: '⠟', r: '⠗', s: '⠎', t: '⠞',
  u: '⠥', v: '⠧', w: '⠺', x: '⠭', y: '⠽', z: '⠵',
};

const DEFAULT_PUNCTUATION: Record<string, string> = {
  ',': '⠂', ';': '⠆', ':': '⠒', '.': '⠲', '!': '⠖', '?': '⠦', '(': '⠐⠣', ')': '⠐⠜',
  '-': '⠤', '—': '⠠⠤', '"': '⠦', "'": '⠄', '/': '⠸⠌', '&': '⠈⠯', '@': '⠈⠁',
};

const DIGITS: Record<string, string> = {
  '0': '⠚', '1': '⠁', '2': '⠃', '3': '⠉', '4': '⠙', '5': '⠑', '6': '⠋', '7': '⠛', '8': '⠓', '9': '⠊',
};

export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function activeRule(ruleSet: RuleSet, source: string, kind: TranscriptionRule['kind']): TranscriptionRule | undefined {
  return ruleSet.rules.find((rule) => rule.enabled && rule.kind === kind && rule.source.toLocaleLowerCase() === source.toLocaleLowerCase());
}

function matchContraction(ruleSet: RuleSet, source: string, index: number): TranscriptionRule | undefined {
  if (!ruleSet.contractions) return undefined;
  const before = source[index - 1] ?? '';
  if (/[\p{L}\p{N}]/u.test(before)) return undefined;

  const candidates = ruleSet.rules
    .filter((rule) => rule.enabled && rule.kind === 'contraction')
    .sort((a, b) => b.source.length - a.source.length);

  const rest = source.slice(index).toLocaleLowerCase();
  return candidates.find((rule) => rest.startsWith(rule.source.toLocaleLowerCase()));
}

function addToken(
  tokens: BrailleToken[],
  text: string,
  braille: string,
  kind: BrailleToken['kind'],
  offset: number,
  rule?: TranscriptionRule,
  marker = false,
): void {
  tokens.push({
    id: uid('token'),
    text,
    braille,
    kind,
    ruleId: rule?.id,
    suspicious: Boolean(rule?.suspicious),
    offset,
    marker,
  });
}

export function transcribeLine(source: string, ruleSet: RuleSet, continuesPrevious = false): BrailleToken[] {
  const tokens: BrailleToken[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const lower = char.toLocaleLowerCase();

    if (/\s/u.test(char)) {
      addToken(tokens, char, ' ', 'special', index);
      index += 1;
      continue;
    }

    const contraction = matchContraction(ruleSet, source, index);
    if (contraction) {
      addToken(tokens, source.slice(index, index + contraction.source.length), contraction.output, 'contraction', index, contraction);
      index += contraction.source.length;
      continue;
    }

    if (/\d/u.test(char)) {
      const start = index;
      let number = '';
      while (index < source.length && /\d/u.test(source[index])) {
        number += source[index];
        index += 1;
      }
      const numberRule = activeRule(ruleSet, '#', 'number');
      addToken(tokens, number, `${numberRule?.output ?? '⠼'}${[...number].map((digit) => DIGITS[digit]).join('')}`, 'number', start, numberRule);
      continue;
    }

    if (/[A-Z]/u.test(char)) {
      const capitalRule = activeRule(ruleSet, 'capital', 'special');
      addToken(tokens, char, `${capitalRule?.output ?? '⠠'}${LETTERS[lower]}`, 'letter', index, capitalRule);
      index += 1;
      continue;
    }

    if (/[a-z]/iu.test(char)) {
      const rule = activeRule(ruleSet, lower, 'letter');
      const output = rule?.output ?? LETTERS[lower] ?? '⠿';
      addToken(tokens, char, output, 'letter', index, rule);
      if (!rule) {
        addToken(tokens, '', '⟦未配置⟧', 'special', index, undefined, true);
      }
      index += 1;
      continue;
    }

    const punctuation = activeRule(ruleSet, char, 'punctuation') ?? activeRule(ruleSet, char.toLocaleLowerCase(), 'punctuation');
    if (punctuation) {
      addToken(tokens, char, punctuation.output, 'punctuation', index, punctuation);
      index += 1;
      continue;
    }

    const fallback = DEFAULT_PUNCTUATION[char];
    addToken(tokens, char, fallback ?? '⠿', 'punctuation', index);
    if (!fallback) addToken(tokens, '', '⟦无对应规则⟧', 'special', index, undefined, true);
    index += 1;
  }

  if (source.trimEnd().endsWith('-')) {
    addToken(tokens, '', ruleSet.hyphenMode === 'cross-line' ? '⠤↳' : '⠤', 'special', Math.max(0, source.length - 1), undefined, true);
  }

  if (continuesPrevious) {
    tokens.unshift({
      id: uid('token'),
      text: '',
      braille: '↳ ',
      kind: 'special',
      suspicious: true,
      offset: 0,
      marker: true,
    });
  }

  return tokens;
}

function issue(
  line: TextbookLine,
  code: string,
  message: string,
  severity: ProofIssue['severity'],
  token?: BrailleToken,
): ProofIssue {
  return {
    id: uid('issue'),
    lineId: line.id,
    tokenId: token?.id,
    ruleId: token?.ruleId,
    severity,
    code,
    message,
    resolved: false,
  };
}

function analyzeLine(line: TextbookLine, previousLine?: TextbookLine): { line: TextbookLine; issues: ProofIssue[] } {
  const issues: ProofIssue[] = [];
  const tokenText = line.tokens.map((token) => token.braille).join('');
  const hasContinuation = line.source.trimEnd().endsWith('-');
  const previousContinues = Boolean(previousLine?.source.trimEnd().endsWith('-'));
  const nextLine = {
    ...line,
    continuesPrevious: previousContinues,
    continuesNext: hasContinuation,
  };

  if (hasContinuation) {
    issues.push(issue(nextLine, 'cross-line-hyphen', '此行以连字符结尾，已插入跨行连接标记；请核对断词位置。', 'warning', nextLine.tokens.at(-1)));
  }

  for (const token of nextLine.tokens) {
    if (token.suspicious) {
      issues.push(issue(nextLine, 'suspicious-rule', `规则“${token.text}”被标记为可疑转写。`, 'warning', token));
    }
    if (token.text && token.braille.includes('⟦')) {
      issues.push(issue(nextLine, 'unknown-symbol', `“${token.text}”没有可用的转写规则。`, 'error', token));
    }
  }

  if (tokenText.replace(/\s/g, '').length > 42) {
    issues.push(issue(nextLine, 'line-too-long', `盲文结果为 ${tokenText.replace(/\s/g, '').length} 格，建议重新分词。`, 'info'));
  }

  if (hasContinuation && nextLine.source.trimEnd().split(/\s+/).at(-1)?.replace(/-$/, '').length === 1) {
    issues.push(issue(nextLine, 'orphan-fragment', '断词后仅剩一个字母，教学排版中通常应整体移到下一行。', 'warning'));
  }

  if (issues.some((item) => item.severity === 'error')) {
    nextLine.status = 'questionable';
  } else if (issues.length > 0 && nextLine.status === 'unchecked') {
    nextLine.status = 'questionable';
  }

  return { line: nextLine, issues };
}

export function updateRuleInSet(ruleSet: RuleSet, ruleId: string, patch: Partial<TranscriptionRule>): RuleSet {
  return {
    ...ruleSet,
    rules: ruleSet.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
  };
}

export function makeRule(source: string, output: string, suspicious: boolean, kind: TranscriptionRule['kind'] = 'contraction'): TranscriptionRule {
  return {
    id: uid('rule'),
    source,
    output,
    kind,
    enabled: true,
    suspicious,
    description: '自定义规则',
  };
}

export function outputText(state: ProjectState): string {
  return state.lines.map((line, index) => `${String(index + 1).padStart(3, '0')}  ${line.tokens.map((token) => token.braille).join('')}`).join('\n');
}

export function brailleCellCount(state: ProjectState): number {
  return state.lines.reduce((total, line) => total + line.tokens.reduce((count, token) => count + token.braille.replace(/\s/g, '').length, 0), 0);
}

/* ------------------------------------------------------------------ */
/* 局部改字：片段锚定、重定位、过期判定与盲文覆盖                          */
/* ------------------------------------------------------------------ */

/** 原文片段在一行中的所有出现位置。 */
function occurrences(source: string, fragment: string): number[] {
  if (!fragment) return [];
  const result: number[] = [];
  let at = source.indexOf(fragment);
  while (at !== -1) {
    result.push(at);
    at = source.indexOf(fragment, at + Math.max(1, fragment.length));
  }
  return result;
}

/**
 * 在一行中定位片段：优先沿用原行；原行不唯一时若全文仅该行出现也算唯一。
 * 返回所在行 id、偏移；未找到或多处出现时返回原因。
 */
export function locateFragment(
  lines: TextbookLine[],
  correction: Pick<LocalCorrection, 'lineId' | 'fragment'>,
): { lineId?: string; offset?: number; staleReason?: CorrectionStaleReason } {
  const perLine = lines.map((line) => ({ line, hits: occurrences(line.source, correction.fragment) }));
  const total = perLine.reduce((count, item) => count + item.hits.length, 0);

  const original = perLine.find((item) => item.line.id === correction.lineId);
  if (original && original.hits.length === 1) {
    // 周边文字移动（插入/删除/重排其他行）时，片段在原行仍唯一：跟着这一处走。
    return { lineId: original.line.id, offset: original.hits[0] };
  }
  if (total === 1) {
    // 片段文本整体移动到其他行（拆行、剪切粘贴）且全文唯一：跟随到新行。
    const only = perLine.find((item) => item.hits.length === 1)!;
    return { lineId: only.line.id, offset: only.hits[0] };
  }
  return total === 0 ? { staleReason: 'fragment-missing' } : { staleReason: 'fragment-ambiguous' };
}

/** 把选区吸附到盲文单元边界（结构性标记不参与）。 */
export function snapSelectionToTokens(
  tokens: BrailleToken[],
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  const spatial = tokens
    .filter((token) => !token.marker && token.text.length > 0)
    .sort((a, b) => a.offset - b.offset);
  const covering = spatial.filter((token) => token.offset < end && token.offset + token.text.length > start);
  if (covering.length === 0) return undefined;
  const snappedStart = Math.min(...covering.map((token) => token.offset));
  const snappedEnd = Math.max(...covering.map((token) => token.offset + token.text.length));
  if (snappedStart >= snappedEnd) return undefined;
  return { start: snappedStart, end: snappedEnd };
}

/** 计算某行指定区间内自动盲文（不含标记、不含改字覆盖）。 */
export function autoBrailleForRange(tokens: BrailleToken[], start: number, end: number): string {
  return tokens
    .filter((token) => !token.marker && !token.override && token.text.length > 0 && token.offset >= start && token.offset + token.text.length <= end)
    .sort((a, b) => a.offset - b.offset)
    .map((token) => token.braille)
    .join('');
}

/** 创建改字前的选区预览：定位 → 唯一校验 → 吸附 → 取自动盲文。 */
export function previewCorrection(
  state: ProjectState,
  lineId: string,
  selectionStart: number,
  selectionEnd: number,
): CorrectionPreview | undefined {
  const line = state.lines.find((item) => item.id === lineId);
  if (!line || selectionEnd <= selectionStart) return undefined;
  const selected = line.source.slice(selectionStart, selectionEnd).trim();
  if (!selected) return undefined;

  // 先用选区文本做唯一性校验（周边文字移动时改字能否跟随只取决于片段文本）。
  const probe: Pick<LocalCorrection, 'lineId' | 'fragment'> = { lineId, fragment: selected };
  const located = locateFragment(state.lines, probe);
  if (!located.lineId || located.offset === undefined) {
    return { lineId, fragment: selected, start: selectionStart, end: selectionEnd, autoBraille: '', staleReason: located.staleReason };
  }

  const locatedLine = state.lines.find((item) => item.id === located.lineId)!;
  const snapped = snapSelectionToTokens(locatedLine.tokens, located.offset, located.offset + selected.length);
  if (!snapped) return undefined;
  const fragment = locatedLine.source.slice(snapped.start, snapped.end);
  return {
    lineId: locatedLine.id,
    fragment,
    start: snapped.start,
    end: snapped.end,
    autoBraille: autoBrailleForRange(locatedLine.tokens, snapped.start, snapped.end),
  };
}

/** 重转录后逐条核对改字：重定位、比较自动盲文、刷新状态。 */
function reconcileCorrections(state: ProjectState): {
  corrections: LocalCorrection[];
  activeByLine: Map<string, { correction: LocalCorrection; start: number; end: number }[]>;
  issues: ProofIssue[];
} {
  const issues: ProofIssue[] = [];
  const activeByLine = new Map<string, { correction: LocalCorrection; start: number; end: number }[]>();

  const corrections = state.corrections.map((correction) => {
    const nowIso = new Date().toISOString();
    const next: LocalCorrection = { ...correction, updatedAt: nowIso };
    delete next.locatedLineId;
    delete next.currentAutoBraille;

    // 已撤销只留记录，不再参与定位与导出。
    if (next.status === 'revoked') return next;

    const located = locateFragment(state.lines, next);
    const fallbackLine = state.lines.find((line) => line.id === next.lineId);

    if (!located.lineId || located.offset === undefined) {
      if (next.status === 'pending' || next.status === 'kept') next.preExpiryStatus = next.status;
      next.status = 'expired';
      next.staleReason = located.staleReason;
      if (fallbackLine) {
        issues.push(issue(fallbackLine, 'correction-stale', `局部改字“${next.fragment}”${located.staleReason === 'fragment-ambiguous' ? '出现多处，无法判断跟随位置' : '对应的原文片段已不存在'}，已暂停使用。`, 'warning'));
      }
      return next;
    }

    const locatedLine = state.lines.find((line) => line.id === located.lineId)!;
    const end = located.offset + next.fragment.length;
    const autoBraille = autoBrailleForRange(locatedLine.tokens, located.offset, end);
    next.locatedLineId = locatedLine.id;
    next.currentAutoBraille = autoBraille;

    if (autoBraille !== next.baselineBraille) {
      if (next.status === 'pending' || next.status === 'kept') next.preExpiryStatus = next.status;
      next.status = 'expired';
      next.staleReason = 'braille-changed';
      issues.push(issue(locatedLine, 'correction-braille-changed', `“${next.fragment}”的自动盲文已变化，原局部改字待重新确认。`, 'warning'));
      return next;
    }

    if (next.status === 'expired') {
      // 片段一度消失或歧义、之后又恢复为唯一且自动盲文未变（如跨两步移动到其他行）：自动回到过期前状态。
      // 仅“自动盲文变化”造成的过期保留 expired，必须由教师重新确认。
      if (next.staleReason !== 'braille-changed') {
        next.status = next.preExpiryStatus ?? 'kept';
        next.staleReason = undefined;
      } else {
        return next;
      }
    }

    next.staleReason = undefined;
    const list = activeByLine.get(locatedLine.id) ?? [];
    list.push({ correction: next, start: located.offset, end });
    activeByLine.set(locatedLine.id, list);
    return next;
  });

  return { corrections, activeByLine, issues };
}

/** 把生效中的改字覆盖到该行盲文单元上；结构性标记始终保留。 */
function applyCorrections(
  line: TextbookLine,
  active: { correction: LocalCorrection; start: number; end: number }[] | undefined,
): BrailleToken[] {
  if (!active || active.length === 0) return line.tokens;

  // 同一片段若存在多条改字（后创建者优先），仅保留首个覆盖区间，其余忽略。
  const ranges = [...active]
    .sort((a, b) => a.start - b.start || b.correction.createdAt.localeCompare(a.correction.createdAt))
    .reduce<{ start: number; end: number; correction: LocalCorrection }[]>((kept, item) => {
      if (kept.every((range) => item.start >= range.end || item.end <= range.start)) {
        kept.push({ start: item.start, end: item.end, correction: item.correction });
      }
      return kept;
    }, []);

  const tokens: BrailleToken[] = [];
  for (const token of line.tokens) {
    if (token.marker) {
      tokens.push(token);
      continue;
    }
    const range = ranges.find((item) => token.offset >= item.start && token.offset + token.text.length <= item.end);
    if (!range) {
      tokens.push(token);
      continue;
    }
    if (range.start === token.offset) {
      tokens.push({
        id: uid('token'),
        text: range.correction.fragment,
        braille: range.correction.replacement,
        kind: 'special',
        suspicious: false,
        offset: range.start,
        override: true,
        correctionId: range.correction.id,
      });
    }
  }
  return tokens;
}

export function lineOutput(line: TextbookLine): string {
  return line.tokens.map((token) => token.braille).join('');
}

export function analyzeProject(state: ProjectState): ProjectState {
  const ruleSet = state.ruleSets.find((item) => item.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const corrections = state.corrections ?? [];
  const transcribed: TextbookLine[] = [];
  const issues: ProofIssue[] = [];

  state.lines.forEach((line, index) => {
    const previousSourceContinues = Boolean(state.lines[index - 1]?.source.trimEnd().endsWith('-'));
    const tokens = transcribeLine(line.source, ruleSet, previousSourceContinues);
    const analyzed = analyzeLine({ ...line, tokens }, state.lines[index - 1]);
    transcribed.push(analyzed.line);
    issues.push(...analyzed.issues);
  });

  // 改字以自动转录结果为基准进行重定位与过期判定。
  const transcribedState: ProjectState = { ...state, lines: transcribed };
  const { corrections: reconciled, activeByLine, issues: correctionIssues } = reconcileCorrections({ ...transcribedState, corrections });
  issues.push(...correctionIssues);

  const nextLines = transcribed.map((line) => {
    const tokens = applyCorrections(line, activeByLine.get(line.id));
    const output = tokens.map((token) => token.braille).join('');
    let status = line.status;
    if (status === 'approved' && line.approvedOutput !== undefined && line.approvedOutput !== output) {
      status = 'questionable';
      issues.push(issue(line, 'approved-output-changed', '已批准行的盲文结果发生变化，已退回待核对。', 'warning'));
    }
    return { ...line, tokens, status };
  });

  return {
    ...state,
    lines: nextLines,
    issues,
    corrections: reconciled,
    lastCheckedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function makeCorrection(
  lineId: string,
  preview: CorrectionPreview,
  replacement: string,
  reason: string,
): LocalCorrection {
  const nowIso = new Date().toISOString();
  return {
    id: uid('correction'),
    lineId,
    fragment: preview.fragment,
    replacement,
    reason,
    status: 'pending',
    locatedLineId: lineId,
    currentAutoBraille: preview.autoBraille,
    baselineBraille: preview.autoBraille,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** 重新确认一条因自动盲文变化而过期的改字：沿用替换盲文，基线更新为当前自动盲文。 */
export function reconfirmCorrection(correction: LocalCorrection): LocalCorrection {
  return {
    ...correction,
    status: 'kept',
    staleReason: undefined,
    baselineBraille: correction.currentAutoBraille ?? correction.baselineBraille,
    updatedAt: new Date().toISOString(),
  };
}
