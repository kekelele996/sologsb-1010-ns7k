import type {
  BrailleToken,
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

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
): void {
  tokens.push({
    id: uid('token'),
    text,
    braille,
    kind,
    ruleId: rule?.id,
    suspicious: Boolean(rule?.suspicious),
    offset,
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
        addToken(tokens, '', '⟦未配置⟧', 'special', index);
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
    if (!fallback) addToken(tokens, '', '⟦无对应规则⟧', 'special', index);
    index += 1;
  }

  if (source.trimEnd().endsWith('-')) {
    addToken(tokens, '', ruleSet.hyphenMode === 'cross-line' ? '⠤↳' : '⠤', 'special', Math.max(0, source.length - 1));
  }

  if (continuesPrevious) {
    tokens.unshift({
      id: uid('token'),
      text: '',
      braille: '↳ ',
      kind: 'special',
      suspicious: true,
      offset: 0,
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

export function analyzeProject(state: ProjectState): ProjectState {
  const ruleSet = state.ruleSets.find((item) => item.id === state.activeRuleSetId) ?? state.ruleSets[0];

  // 先按现有状态计算每条行的有效盲文（旧自动结果 + 旧改字），用于批准行变化回退。
  const oldByLine = new Map<string, LocalCorrection[]>();
  (state.corrections ?? []).forEach((correction) => {
    if (correction.stale || correction.status === 'revoked' || !correction.lineId) return;
    oldByLine.set(correction.lineId, [...(oldByLine.get(correction.lineId) ?? []), correction]);
  });
  const oldEffective = new Map<string, string>();
  state.lines.forEach((line) => oldEffective.set(line.id, effectiveBraille(line, oldByLine.get(line.id) ?? [])));

  const nextLines: TextbookLine[] = [];
  const issues: ProofIssue[] = [];

  state.lines.forEach((line, index) => {
    const previousSourceContinues = Boolean(state.lines[index - 1]?.source.trimEnd().endsWith('-'));
    const tokens = transcribeLine(line.source, ruleSet, previousSourceContinues);
    const analyzed = analyzeLine({ ...line, tokens }, state.lines[index - 1]);
    nextLines.push(analyzed.line);
    issues.push(...analyzed.issues);
  });

  const corrections = resolveCorrections(state.corrections ?? [], nextLines);
  const correctionsByLine = new Map<string, LocalCorrection[]>();
  corrections.forEach((correction) => {
    if (correction.stale || correction.status === 'revoked' || !correction.lineId) return;
    correctionsByLine.set(correction.lineId, [...(correctionsByLine.get(correction.lineId) ?? []), correction]);
  });

  const lines = nextLines.map((line) => {
    const effective = effectiveBraille(line, correctionsByLine.get(line.id) ?? []);
    if (line.status === 'approved' && oldEffective.has(line.id) && oldEffective.get(line.id) !== effective) {
      return { ...line, status: 'questionable' as const };
    }
    return line;
  });

  return {
    ...state,
    lines,
    corrections,
    issues,
    lastCheckedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 局部改字
// ---------------------------------------------------------------------------

/** 真正承载原文字符的 token 区间（空格、系统标记除外）。 */
export function realInterval(token: BrailleToken): [number, number] | null {
  if (!token.text || token.text === ' ') return null;
  return [token.offset, token.offset + token.text.length];
}

function isRealToken(token: BrailleToken): boolean {
  return realInterval(token) !== null;
}

/** 把从 start 到 end 的选区吸附到覆盖它的最小真实 token 区间。 */
export function snapSelection(
  tokens: BrailleToken[],
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (start < 0 || end <= start) return null;
  const real = tokens.filter(isRealToken).sort((a, b) => a.offset - b.offset);
  const first = real.find((token) => {
    const interval = realInterval(token)!;
    return interval[0] <= start && start < interval[1];
  }) ?? real.find((token) => {
    const interval = realInterval(token)!;
    return interval[0] >= start;
  });
  const last = [...real].reverse().find((token) => {
    const interval = realInterval(token)!;
    return interval[0] < end && interval[1] >= end;
  }) ?? [...real].reverse().find((token) => {
    const interval = realInterval(token)!;
    return interval[1] <= end;
  });
  if (!first || !last) return null;
  const from = first.offset;
  const to = last.offset + last.text.length;
  if (to <= from) return null;
  return { start: from, end: to };
}

/** 全文中所有片段出现位置（按原文精确匹配）。 */
export function findOccurrences(lines: TextbookLine[], fragment: string): { lineId: string; start: number; end: number }[] {
  if (!fragment) return [];
  const results: { lineId: string; start: number; end: number }[] = [];
  for (const line of lines) {
    let index = line.source.indexOf(fragment);
    while (index !== -1) {
      results.push({ lineId: line.id, start: index, end: index + fragment.length });
      index = line.source.indexOf(fragment, index + fragment.length);
    }
  }
  return results;
}

/** 某一行指定区间的自动盲文（仅真实字符 token，不含空格与系统标记）。 */
export function autoBrailleForRange(tokens: BrailleToken[], start: number, end: number): string {
  return tokens
    .filter((token) => {
      const interval = realInterval(token);
      if (!interval) return false;
      return interval[0] >= start && interval[1] <= end;
    })
    .sort((a, b) => a.offset - b.offset)
    .map((token) => token.braille)
    .join('');
}

function activeOnLine(corrections: LocalCorrection[], lineId: string): LocalCorrection[] {
  return corrections
    .filter((correction) => !correction.stale && correction.status !== 'revoked' && correction.lineId === lineId && correction.start !== undefined && correction.end !== undefined)
    .sort((a, b) => (a.start! - b.start!) || (a.end! - b.end!));
}

/**
 * 重新匹配每条改字：
 * - 片段在全文唯一 → 跟随到新位置；周边移动不受影响。
 * - 找不到 / 多处出现 → 过期，不参与导出。
 * - 片段在、但该段自动盲文与基线不同（规则或规则集变化）→ 过期。
 * - 已批准改字若曾经过期、恢复后自动盲文又变 → 退回待核对。
 */
export function resolveCorrections(corrections: LocalCorrection[], lines: TextbookLine[]): LocalCorrection[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  return corrections.map((correction) => {
    // 撤销是终态：记录保留，不再参与匹配/过期判定与导出。
    if (correction.status === 'revoked') return correction;
    const occurrences = findOccurrences(lines, correction.fragment);

    if (occurrences.length === 0) {
      return { ...correction, stale: true, staleReason: 'not-found', lineId: undefined, start: undefined, end: undefined };
    }

    let occurrence = occurrences[0];
    if (occurrences.length > 1) {
      // 原位置仍在（另一处是新出现的）→ 继续锚定原位置；原位置消失导致多义 → 过期。
      const previous = occurrences.find((item) => item.lineId === correction.lineId && item.start === correction.start)
        ?? occurrences.find((item) => item.lineId === correction.lineId);
      if (!previous) {
        return { ...correction, stale: true, staleReason: 'duplicated', lineId: undefined, start: undefined, end: undefined };
      }
      occurrence = previous;
    }

    const line = byId.get(occurrence.lineId);
    if (!line) {
      return { ...correction, stale: true, staleReason: 'not-found', lineId: undefined, start: undefined, end: undefined };
    }

    const autoBraille = autoBrailleForRange(line.tokens, occurrence.start, occurrence.end);
    if (correction.baselineBraille !== undefined && autoBraille !== correction.baselineBraille) {
      return {
        ...correction,
        stale: true,
        staleReason: 'braille-changed',
        lineId: occurrence.lineId,
        start: occurrence.start,
        end: occurrence.end,
      };
    }

    // 片段唯一且自动盲文未变：从过期恢复。曾被批准的也要重新核对（不静默复活）。
    const wasStale = correction.stale;
    const next: LocalCorrection = {
      ...correction,
      stale: false,
      staleReason: undefined,
      lineId: occurrence.lineId,
      start: occurrence.start,
      end: occurrence.end,
    };
    if (wasStale && next.status === 'approved') next.status = 'pending';
    if (next.baselineBraille === undefined) next.baselineBraille = autoBraille;
    return next;
  });
}

/** 一行的渲染片段：普通 token，或被改字整体替换的片段。 */
export type LinePiece =
  | { kind: 'token'; token: BrailleToken }
  | { kind: 'correction'; correction: LocalCorrection };

/**
 * 按有效改字合成一行的展示片段。
 * 被改字区间覆盖的真实 token 合并为一个“改字”片段；未覆盖的系统标记原样保留，
 * 位于改字区间内的系统标记（如被改好的未配置字符提示）隐藏。
 */
export function buildLinePieces(line: TextbookLine, corrections: LocalCorrection[]): LinePiece[] {
  const active = activeOnLine(corrections, line.id);
  const pieces: LinePiece[] = [];
  let current: LocalCorrection | null = null;

  for (const token of line.tokens) {
    const interval = realInterval(token);
    if (!interval) {
      // 跨行连接/连字符等排版标记始终保留；仅“未配置字符”警告位于改字区间时隐藏。
      const isWarningMarker = token.braille.includes('⟦');
      const coveredBy = isWarningMarker
        ? active.find((correction) => correction.start! <= token.offset && token.offset < correction.end!)
        : undefined;
      if (coveredBy) {
        current = coveredBy;
        continue;
      }
      if (current) {
        pieces.push({ kind: 'correction', correction: current });
        current = null;
      }
      pieces.push({ kind: 'token', token });
      continue;
    }

    const cover = active.find((correction) => correction.start! <= interval[0] && interval[1] <= correction.end!);
    if (cover) {
      if (!current || current.id !== cover.id) {
        if (current) pieces.push({ kind: 'correction', correction: current });
        current = cover;
      }
    } else {
      if (current) {
        pieces.push({ kind: 'correction', correction: current });
        current = null;
      }
      pieces.push({ kind: 'token', token });
    }
  }

  if (current) pieces.push({ kind: 'correction', correction: current });
  return pieces;
}

function pieceBraille(piece: LinePiece): string {
  return piece.kind === 'correction' ? piece.correction.replacement : piece.token.braille;
}

/** 一行应用有效改字后的盲文串（空格与跨行标记保留）。 */
export function effectiveBraille(line: TextbookLine, corrections: LocalCorrection[]): string {
  return buildLinePieces(line, corrections).map(pieceBraille).join('');
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

export function makeCorrection(
  lineId: string,
  fragment: string,
  start: number,
  end: number,
  replacement: string,
  reason: string,
  baselineBraille: string,
): LocalCorrection {
  const now = new Date().toISOString();
  return {
    id: uid('correction'),
    fragment,
    replacement,
    reason,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    lineId,
    start,
    end,
    baselineBraille,
    stale: false,
  };
}

const activeByLine = (state: ProjectState): Map<string, LocalCorrection[]> => {
  const map = new Map<string, LocalCorrection[]>();
  state.corrections.forEach((correction) => {
    if (correction.stale || correction.status === 'revoked' || !correction.lineId) return;
    map.set(correction.lineId, [...(map.get(correction.lineId) ?? []), correction]);
  });
  return map;
};

export function outputText(state: ProjectState): string {
  const byLine = activeByLine(state);
  return state.lines.map((line, index) => `${String(index + 1).padStart(3, '0')}  ${effectiveBraille(line, byLine.get(line.id) ?? [])}`).join('\n');
}

export function brailleCellCount(state: ProjectState): number {
  const byLine = activeByLine(state);
  return state.lines.reduce(
    (total, line) => total + effectiveBraille(line, byLine.get(line.id) ?? []).replace(/\s/g, '').length,
    0,
  );
}
