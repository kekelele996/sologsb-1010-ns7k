import { analyzeProject, makeCorrection, previewCorrection, reconfirmCorrection, outputText } from '../src/braille.ts';
import { createInitialProject } from '../src/sample.ts';
import type { ProjectState } from '../src/types.ts';

let failures = 0;
const check = (name: string, condition: boolean, detail = '') => {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name} ${detail}`);
  }
};

const findLine = (state: ProjectState, source: string) => state.lines.find((line) => line.source === source)!;
const lineOutput = (state: ProjectState, id: string) => {
  const line = state.lines.find((item) => item.id === id)!;
  return line.tokens.map((token) => token.braille).join('');
};

let state = analyzeProject(createInitialProject());
const targetSource = 'It needs water, light and time.';
const line = findLine(state, targetSource);
const lineId = line.id;

// --- 1. 在唯一片段 "water" 上创建改字 ---
const selStart = line.source.indexOf('water');
let preview = previewCorrection(state, lineId, selStart, selStart + 5);
check('预览吸附到 token 且有自动盲文基线', Boolean(preview && preview.fragment === 'water' && preview.autoBraille.length > 0), JSON.stringify(preview));
state = analyzeProject({ ...state, corrections: [makeCorrection(lineId, preview!, '⟫⟫TEST', '资源教师标注：局部改字')] });
let correction = state.corrections[0];
check('新改字为待确认', correction.status === 'pending');
check('转录优先采用替换盲文（预览行含替换内容）', lineOutput(state, lineId).includes('⟫⟫TEST'));
check('自动盲文原文不再出现于该行（被覆盖）', !lineOutput(state, lineId).includes(preview!.autoBraille));
check('导出文本包含替换盲文', outputText(state).includes('⟫⟫TEST'));

// --- 2. 批准保留 ---
state = analyzeProject({ ...state, corrections: state.corrections.map((c) => c.id === correction.id ? { ...c, status: 'kept' } : c) });
check('批准后仍生效', state.corrections[0].status === 'kept' && lineOutput(state, lineId).includes('⟫⟫TEST'));

// --- 3. 周边文字移动：在前面插入一行，片段仍唯一，改字跟着走 ---
state = analyzeProject({
  ...state,
  lines: [
    { id: 'new-top', source: 'A new first line appears.', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
    ...state.lines,
  ],
});
check('插入前置行后改字仍绑定原行 id', state.corrections[0].locatedLineId === lineId);
check('跟随移动后仍采用替换盲文', lineOutput(state, lineId).includes('⟫⟫TEST'));
check('插入前置行后状态仍为已批准', state.corrections[0].status === 'kept');

// --- 4. 撤销 ---
state = analyzeProject({ ...state, corrections: state.corrections.map((c) => ({ ...c, status: 'revoked' })) });
check('撤销后不参与导出', !outputText(state).includes('⟫⟫TEST') && state.corrections[0].status === 'revoked');
state = analyzeProject({ ...state, corrections: state.corrections.map((c) => ({ ...c, status: 'kept' })) });
check('撤销后恢复仍可重新生效', lineOutput(state, lineId).includes('⟫⟫TEST'));

// --- 5. 片段文本变化：删除 water，片段不存在 => 过期 ---
state = analyzeProject({
  ...state,
  lines: state.lines.map((l) => l.id === lineId ? { ...l, source: 'It needs sunlight and time.' } : l),
});
check('片段消失后标为过期 fragment-missing', state.corrections[0].status === 'expired' && state.corrections[0].staleReason === 'fragment-missing');
check('过期改字不参与导出', !outputText(state).includes('⟫⟫TEST'));
check('过期生成提醒 issue', state.issues.some((issue) => issue.code === 'correction-stale'));

// --- 6. 片段出现多处 => 歧义过期 ---
state = analyzeProject({
  ...state,
  lines: state.lines.map((l) => l.id === lineId ? { ...l, source: 'water, light water and time.' } : l),
});
check('片段多处时标为过期 fragment-ambiguous', state.corrections[0].status === 'expired' && state.corrections[0].staleReason === 'fragment-ambiguous');

// --- 7. 该段自动盲文变化（修改字母 m 规则输出） => braille-changed，可重新确认 ---
state = analyzeProject(createInitialProject());
const line7 = state.lines.find((l) => l.source.includes('measure'))!;
const p7 = previewCorrection(state, line7.id, line7.source.indexOf('measure'), line7.source.indexOf('measure') + 7);
state = analyzeProject({ ...state, corrections: [makeCorrection(line7.id, p7!, '⟪CUSTOM⟫', '测试规则变化过期')] });
state = analyzeProject({
  ...state,
  ruleSets: state.ruleSets.map((set) => set.id === state.activeRuleSetId
    ? { ...set, rules: set.rules.map((rule) => rule.id === 'letter-m' ? { ...rule, output: '⟨M⟩' } : rule) }
    : set),
});
check('自动盲文变化后标为过期 braille-changed', state.corrections[0].status === 'expired' && state.corrections[0].staleReason === 'braille-changed');
check('盲文变化型过期不参与导出', !outputText(state).includes('⟪CUSTOM⟫'));
const refreshed = analyzeProject(state);
const reconfirmed = reconfirmCorrection(refreshed.corrections[0]);
state = analyzeProject({ ...refreshed, corrections: refreshed.corrections.map((c) => c.id === reconfirmed.id ? reconfirmed : c) });
check('重新确认后恢复已批准且继续采用', state.corrections[0].status === 'kept' && outputText(state).includes('⟪CUSTOM⟫'));
check('重新确认后基线已更新为新自动盲文', state.corrections[0].baselineBraille === state.corrections[0].currentAutoBraille);

// --- 8. 片段移动到另一行（拆行/编辑）：全文唯一时跟随 ---
state = analyzeProject(createInitialProject());
const src = findLine(state, targetSource);
const p8 = previewCorrection(state, src.id, src.source.indexOf('light'), src.source.indexOf('light') + 5);
state = analyzeProject({ ...state, corrections: [makeCorrection(src.id, p8!, '⟪L⟫', '跟随测试')] });
// 教师先批准保留
state = analyzeProject({ ...state, corrections: state.corrections.map((c) => ({ ...c, status: 'kept' })) });
state = analyzeProject({
  ...state,
  lines: state.lines.map((l) => l.id === src.id ? { ...l, source: 'It needs water, and time.' } : l),
});
const other = state.lines.find((l) => l.source === 'By Friday, a green shoot appears.')!;
state = analyzeProject({
  ...state,
  lines: state.lines.map((l) => l.id === other.id ? { ...l, source: 'By Friday, light a green shoot appears.' } : l),
});
check('片段移动到其他行后跟随', state.corrections[0].status === 'kept' && state.corrections[0].locatedLineId === other.id);
check('跟随后在新行生效', lineOutput(state, other.id).includes('⟪L⟫'));

// --- 9. 已批准行结果变化退回待核对 ---
state = analyzeProject(createInitialProject());
const appLine = state.lines[0];
const outputAtApproval = appLine.tokens.map((t) => t.braille).join('');
state = { ...state, lines: state.lines.map((l) => l.id === appLine.id ? { ...l, status: 'approved', approvedOutput: outputAtApproval } : l) };
check('批准后结果未变保持批准', state.lines[0].status === 'approved');
state = analyzeProject({ ...state, lines: state.lines.map((l) => l.id === appLine.id ? { ...l, source: l.source + ' More text.' } : l) });
check('批准行结果变化后退回待核对', state.lines.find((l) => l.id === appLine.id)!.status === 'questionable');
check('退回生成 approved-output-changed issue', state.issues.some((issue) => issue.code === 'approved-output-changed'));

// --- 10. 改字覆盖导致批准行结果变化也退回 ---
state = analyzeProject(createInitialProject());
const aLine = state.lines[0];
const before = aLine.tokens.map((t) => t.braille).join('');
state = { ...state, lines: state.lines.map((l) => l.id === aLine.id ? { ...l, status: 'approved', approvedOutput: before } : l) };
const p10 = previewCorrection(state, aLine.id, aLine.source.indexOf('small'), aLine.source.indexOf('small') + 5);
state = analyzeProject({ ...state, corrections: [makeCorrection(aLine.id, p10!, '⟪S⟫', '覆盖改变批准结果')] });
check('新增改字改变批准行结果时退回待核对', state.lines.find((l) => l.id === aLine.id)!.status === 'questionable');

// --- 11. 同片段重复改字检测 ---
state = analyzeProject(createInitialProject());
const dup = state.lines[0];
const p11 = previewCorrection(state, dup.id, dup.source.indexOf('seed'), dup.source.indexOf('seed') + 4);
state = analyzeProject({ ...state, corrections: [makeCorrection(dup.id, p11!, '⟪1⟫', '第一条')] });
const dupExists = state.corrections.some(
  (c) => (c.status === 'pending' || c.status === 'kept') && (c.locatedLineId ?? c.lineId) === dup.id && c.fragment === 'seed',
);
check('同片段存在生效改字时检测到重复', dupExists);

// --- 12. 结构性标记（跨行连字）不被改字吞掉 ---
state = analyzeProject(createInitialProject());
const lookLine = state.lines.find((l) => l.source === 'Look-')!;
const p12 = previewCorrection(state, lookLine.id, 0, 4);
state = analyzeProject({ ...state, corrections: [makeCorrection(lookLine.id, p12!, '⟪LK⟫', '标记保留')] });
const out12 = lineOutput(state, lookLine.id);
check('覆盖 Look 后跨行连字标记仍保留', out12.includes('⟪LK⟫') && (out12.includes('⠤↳') || out12.includes('⠤')), out12);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
