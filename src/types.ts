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
  /** 结构性标记（跨行连字符、承接符、未配置符号）不属于原文，改字覆盖时始终保留。 */
  marker?: boolean;
  /** 由局部改字生成的覆盖单元，不参与自动规则检查。 */
  override?: boolean;
  correctionId?: string;
}

export interface TextbookLine {
  id: string;
  source: string;
  tokens: BrailleToken[];
  status: LineStatus;
  note: string;
  continuesPrevious: boolean;
  continuesNext: boolean;
  /** 批准该行时最终盲文（改字已覆盖）的签名；之后结果变化即退回待核对。 */
  approvedOutput?: string;
}

export type CorrectionStatus = 'pending' | 'kept' | 'revoked' | 'expired';
export type CorrectionStaleReason = 'fragment-missing' | 'fragment-ambiguous' | 'braille-changed';

export interface LocalCorrection {
  id: string;
  /** 创建时所在行，仅用于展示；失配后按片段文本在全文重新定位。 */
  lineId: string;
  /** 锚定的原文片段。 */
  fragment: string;
  /** 替换盲文，转录时优先于自动盲文。 */
  replacement: string;
  reason: string;
  status: CorrectionStatus;
  /** 过期原因：片段文本变化（无法续用）或该段自动盲文变化（可重新确认）。 */
  staleReason?: CorrectionStaleReason;
  /** 过期前的生效状态，片段恢复唯一时自动回到该状态。 */
  preExpiryStatus?: 'pending' | 'kept';
  /** 当前所在行（重定位结果）；undefined 表示片段未找到或不唯一。 */
  locatedLineId?: string;
  /** 该片段当前的自动盲文；与 baselineBraille 不一致即因规则变化而过期。 */
  currentAutoBraille?: string;
  /** 创建时该片段的自动盲文基线。 */
  baselineBraille: string;
  createdAt: string;
  updatedAt: string;
}

export interface CorrectionPreview {
  lineId: string;
  fragment: string;
  start: number;
  end: number;
  autoBraille: string;
  staleReason?: CorrectionStaleReason;
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
  selectedLineId: string;
  issues: ProofIssue[];
  corrections: LocalCorrection[];
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
