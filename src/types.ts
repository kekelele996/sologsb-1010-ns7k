export type RuleKind = 'letter' | 'number' | 'punctuation' | 'contraction' | 'special';
export type LineStatus = 'unchecked' | 'reviewed' | 'questionable' | 'approved';
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface TranscriptionRule {
  id: string;
  source: string;
  output: string;
  kind: RuleKind;
  enabled: boolean;
  suspicious: boolean;
  description: string;
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  contractions: boolean;
  hyphenMode: 'cross-line' | 'inline';
  rules: TranscriptionRule[];
}

export interface BrailleToken {
  id: string;
  text: string;
  braille: string;
  kind: RuleKind;
  ruleId?: string;
  suspicious: boolean;
  offset: number;
}

export interface TextbookLine {
  id: string;
  source: string;
  tokens: BrailleToken[];
  status: LineStatus;
  note: string;
  continuesPrevious: boolean;
  continuesNext: boolean;
}

export interface ProofIssue {
  id: string;
  lineId: string;
  tokenId?: string;
  ruleId?: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  resolved: boolean;
}

export type CorrectionStatus = 'pending' | 'approved' | 'revoked';
export type CorrectionStaleReason = 'not-found' | 'duplicated' | 'braille-changed';

export interface LocalCorrection {
  id: string;
  /** 选中的原文片段，改字随片段文本匹配，不绑行号。 */
  fragment: string;
  /** 替换盲文，转录时优先于自动结果。 */
  replacement: string;
  reason: string;
  status: CorrectionStatus;
  createdAt: string;
  updatedAt: string;
  /** 最近一次唯一定位到的位置；过期时可能为空。 */
  lineId?: string;
  start?: number;
  end?: number;
  /** 创建（或重新确认）时该片段的自动盲文，用于判断规则变化过期。 */
  baselineBraille?: string;
  stale: boolean;
  staleReason?: CorrectionStaleReason;
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  action: string;
  snapshot: Omit<ProjectState, 'versions'>;
}

export interface ProjectState {
  id: string;
  title: string;
  author: string;
  activeRuleSetId: string;
  ruleSets: RuleSet[];
  lines: TextbookLine[];
  corrections: LocalCorrection[];
  selectedLineId: string;
  issues: ProofIssue[];
  versions: VersionSnapshot[];
  lastCheckedAt: string;
  updatedAt: string;
}

export interface HistoryState {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
  lastAction: string;
}
