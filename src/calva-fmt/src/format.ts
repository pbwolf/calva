import * as vscode from 'vscode';
import * as config from '../../formatter-config';
import * as outputWindow from '../../repl-window/repl-doc';
import { getIndent, getDocumentOffset, getDocument } from '../../doc-mirror/index';
import { formatTextAtRange, formatText, jsify } from '../../../out/cljs-lib/cljs-lib';
import * as util from '../../utilities';
import * as cursorDocUtils from '../../cursor-doc/utilities';
import { isUndefined, cloneDeep } from 'lodash';
import { LispTokenCursor } from '../../cursor-doc/token-cursor';
import { formatIndex } from './format-index';
import * as state from '../../state';

const FormatDepthDefaults = {
  deftype: 2,
  defprotocol: 2,
};

export async function indentPosition(position: vscode.Position, document: vscode.TextDocument) {
  const editor = util.getActiveTextEditor();
  const pos = new vscode.Position(position.line, 0);
  const indent = getIndent(
    getDocument(document).model.lineInputModel,
    getDocumentOffset(document, position),
    await config.getConfig(document)
  );
  const newPosition = new vscode.Position(position.line, indent);
  const delta = document.lineAt(position.line).firstNonWhitespaceCharacterIndex - indent;
  if (delta > 0) {
    return editor
      .edit((edits) => edits.delete(new vscode.Range(pos, new vscode.Position(pos.line, delta))), {
        undoStopAfter: false,
        undoStopBefore: false,
      })
      .then((onFulfilled) => {
        editor.selections = [new vscode.Selection(newPosition, newPosition)];
        return onFulfilled;
      });
  } else if (delta < 0) {
    const str = ' '.repeat(-delta);
    return editor
      .edit((edits) => edits.insert(pos, str), {
        undoStopAfter: false,
        undoStopBefore: false,
      })
      .then((onFulfilled) => {
        editor.selections = [new vscode.Selection(newPosition, newPosition)];
        return onFulfilled;
      });
  }
}

export function formatRangeEdits(
  document: vscode.TextDocument,
  originalRange: vscode.Range
): vscode.TextEdit[] | undefined {
  const mirrorDoc = getDocument(document);
  const startIndex = document.offsetAt(originalRange.start);
  const cursor = mirrorDoc.getTokenCursor(startIndex);
  if (!cursor.withinString() && !cursor.withinComment()) {
    const eol = _convertEolNumToStringNotation(document.eol);
    const originalText = document.getText(originalRange);
    const leadingWs = originalText.match(/^\s*/)[0];
    const trailingWs = originalText.match(/\s*$/)[0];
    const missingTexts = cursorDocUtils.getMissingBrackets(originalText);
    const healedText = `${missingTexts.prepend}${originalText.trim()}${missingTexts.append}`;
    const formattedHealedText = formatCode(healedText, document.eol);
    const leadingEolPos = leadingWs.lastIndexOf(eol);
    const startIndent =
      leadingEolPos === -1
        ? originalRange.start.character
        : leadingWs.length - leadingEolPos - eol.length;
    const formattedText = formattedHealedText
      .substring(
        missingTexts.prepend.length,
        missingTexts.prepend.length + formattedHealedText.length - missingTexts.append.length
      )
      .split(eol)
      .map((line: string, i: number) => (i === 0 ? line : `${' '.repeat(startIndent)}${line}`))
      .join(eol);
    const newText = `${formattedText.startsWith(leadingWs) ? '' : leadingWs}${formattedText}${
      formattedText.endsWith(trailingWs) ? '' : trailingWs
    }`;
    return [vscode.TextEdit.replace(originalRange, newText)];
  }
}

export async function formatRange(document: vscode.TextDocument, range: vscode.Range) {
  const wsEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
  const edits = formatRangeEdits(document, range);

  if (isUndefined(edits)) {
    console.error('formatRangeEdits returned undefined!', cloneDeep({ document, range }));
    return false;
  }

  wsEdit.set(document.uri, edits);
  return vscode.workspace.applyEdit(wsEdit);
}

export function formatPositionInfo(
  editor: vscode.TextEditor,
  onType: boolean = false,
  extraConfig: CljFmtConfig = {}
) {
  const doc: vscode.TextDocument = editor.document;
  const index = doc.offsetAt(editor.selections[0].active);
  const mDoc = getDocument(doc);

  if (mDoc.model.documentVersion != doc.version) {
    console.warn(
      'Model for formatPositionInfo is out of sync with document; will not reformat now'
    );
    return;
  }
  const cursor = mDoc.getTokenCursor(index);

  const formatRange = _calculateFormatRange(extraConfig, cursor, index);
  if (!formatRange) {
    return;
  }

  const formatted: {
    'range-text': string;
    range: number[];
    'new-index': number;
  } = formatIndex(
    doc.getText(),
    formatRange,
    index,
    _convertEolNumToStringNotation(doc.eol),
    onType,
    {
      ...config.getConfigNow(),
      ...extraConfig,
      'comment-form?': cursor.getFunctionName() === 'comment',
    }
  );
  const range: vscode.Range = new vscode.Range(
    doc.positionAt(formatted.range[0]),
    doc.positionAt(formatted.range[1])
  );
  const newIndex: number = doc.offsetAt(range.start) + formatted['new-index'];
  const previousText: string = doc.getText(range);
  return {
    formattedText: formatted['range-text'],
    range: range,
    previousText: previousText,
    previousIndex: index,
    newIndex: newIndex,
  };
}

// TODO the MirrorDocument has a list of non-overlapping ranges to reformat. Can we avoid recomputing them here by a different algorithm & potentially introducing overlap?
export function formatPositionInfo2(doc: vscode.TextDocument, onType: boolean, index: number) {
  const mDoc = getDocument(doc);
  const extraConfig = {};
  if (mDoc.model.documentVersion != doc.version) {
    console.warn(
      'Model for formatPositionInfo2 is out of sync with document; will not reformat now'
    );
    return;
  }
  const cursor = mDoc.getTokenCursor(index);

  const formatRange = _calculateFormatRange(extraConfig, cursor, index);
  if (!formatRange) {
    return;
  }

  const formatted: {
    'range-text': string;
    range: number[];
    'new-index': number;
  } = formatIndex(
    doc.getText(),
    formatRange,
    index,
    _convertEolNumToStringNotation(doc.eol),
    onType,
    {
      ...config.getConfigNow(),
      ...extraConfig,
      'comment-form?': cursor.getFunctionName() === 'comment',
    }
  );
  const range: vscode.Range = new vscode.Range(
    doc.positionAt(formatted.range[0]),
    doc.positionAt(formatted.range[1])
  );
  const newIndex: number = doc.offsetAt(range.start) + formatted['new-index'];
  const previousText: string = doc.getText(range);
  return {
    formattedText: formatted['range-text'],
    range: range,
    previousText: previousText,
    previousIndex: index,
    newIndex: newIndex,
  };
}

interface CljFmtConfig {
  'format-depth'?: number;
  'align-associative?'?: boolean;
  'remove-multiple-non-indenting-spaces?'?: boolean;
}

function _calculateFormatRange(
  config: CljFmtConfig,
  cursor: LispTokenCursor,
  index: number
): [number, number] {
  const formatDepth = config?.['format-depth'] ?? _formatDepth(cursor);
  const rangeForTopLevelForm = cursor.rangeForDefun(index, false);
  if (!rangeForTopLevelForm) {
    return;
  }
  const topLevelStartCursor = cursor.doc.getTokenCursor(rangeForTopLevelForm[0]);
  const rangeForList = cursor.rangeForList(formatDepth);
  if (rangeForList) {
    if (rangeForList[0] === rangeForTopLevelForm[0]) {
      if (topLevelStartCursor.rowCol[1] !== 0) {
        const STOP_INFORMING = 'calvaFormat:stopInformingAboutTopLevelAlignment';
        if (!state.extensionContext.globalState.get(STOP_INFORMING)) {
          void vscode.window
            .showInformationMessage(
              'You are formatting a top level form that is not aligned with the left margin. Calva will not align it for you, because it promises to only format the content of the form. Please align the opening bracket of the form with the left margin and format again. You can also format the whole document by placing the cursor outside of the form and format.',
              'OK',
              "Don't show again"
            )
            .then((selection) => {
              if (selection === "Don't show again") {
                void state.extensionContext.globalState.update(STOP_INFORMING, true);
              }
            });
        }
      }
    }
    return rangeForList;
  }

  const rangeForCurrentForm = cursor.rangeForCurrentForm(index);
  if (!isUndefined(rangeForCurrentForm)) {
    if (rangeForCurrentForm[0] === rangeForTopLevelForm[0]) {
      if (topLevelStartCursor.rowCol[1] !== 0) {
        return;
      }
    }
    if (rangeForCurrentForm.includes(index)) {
      return rangeForCurrentForm;
    }
  }
}

function _formatDepth(cursor: LispTokenCursor) {
  const cursorClone = cursor.clone();
  cursorClone.backwardFunction(1);
  return FormatDepthDefaults?.[cursorClone.getFunctionName()] ?? 1;
}

//----------

export type ReformatChange = {
  start: number;
  end: number;
  text: string;
};

/** whitespace and substance. Pre-format and re-formatted text can be expressed
 * as a series of SpacedUnit. The substance parts can be aligned and then
 * changes in size can be translated to TextEdits.
 */
type SpacedUnit = [spaces: string, stuff: string];

/** Array of [spaces, nonspaces] which if concatenated would equal s.
 * Treats comma and JS regex \s as spaces.
 */
function spacedUnits(s: string): SpacedUnit[] {
  const frags = s.match(/[\s,]+|[^\s,]+/g);
  // Ensure 1st item is of whitespace:
  if (frags[0].match(/[^\s,]/)) {
    frags.unshift('');
  }
  // Ensure last item is of non-whitespace stuff:
  if (frags.length % 2) {
    frags.push('');
  }
  // Partition items into [space, stuff] pairs:
  const units = [];
  for (let i = 0; i < frags.length; i += 2) {
    units.push([frags[i], frags[i + 1]]);
  }
  return units;
}

/** Edits to accomplish the reformatting at one point in the document.
 * Edits are ordered from end- to start-of-document.
 */
// - For VS Code to move all cursors meaningfully,
// - there should be one ModelEdit per insertion/removal of whitespace
export function reformatChanges(doc: vscode.TextDocument, position: number): ReformatChange[] {
  const formattedInfo = formatPositionInfo2(doc, true, position);
  const a = spacedUnits(formattedInfo.previousText);
  const b = spacedUnits(formattedInfo.formattedText);
  // A single word in a or b may have been split into multiple words in the other.
  // Adjust them to the finest granularity of words.
  // The result should be an equal number of words in a and b:
  const a2 = [],
    b2 = [];
  while (a.length && b.length) {
    if (a[0][1] == b[0][1]) {
      a2.push(a[0]);
      b2.push(b[0]);
      a.shift();
      b.shift();
    } else if (a[0][1].length < b[0][1].length) {
      const aWhole = a[0][1];
      const bPart = b[0][1].slice(0, a[0][1].length);
      if (aWhole == bPart) {
        a2.push(a[0]);
        a.shift();
        b2.push([b[0][0], bPart]);
        b[0] = ['', b[0][1].slice(aWhole.length)];
      } else {
        console.error('a/b mismatch wherein a is shorter', {
          'a-next': a[0],
          'b-next': b[0],
          'a-past': a2,
          'b-past': b2,
          'a-whole': formattedInfo.previousText,
          'b-whole': formattedInfo.formattedText,
        });
        return [];
      }
    } else {
      const bWhole = b[0][1];
      const aPart = a[0][1].slice(0, b[0][1].length);
      if (bWhole == aPart) {
        b2.push(b[0]);
        b.shift();
        a2.push([a[0][0], aPart]);
        a[0] = ['', a[0][1].slice(bWhole.length)];
      } else {
        console.error('a/b mismatch wherein b is shorter', {
          'a-next': a[0],
          'b-next': b[0],
          'a-past': a2,
          'b-past': b2,
          'a-whole': formattedInfo.previousText,
          'b-whole': formattedInfo.formattedText,
        });
        return [];
      }
    }
  }
  if (a2.length != b2.length) {
    console.error('Uneven words in a and b', 'a2', a2, 'b2', b2);
    return [];
  } else {
    const ret: ReformatChange[] = [];
    let aPos = doc.offsetAt(formattedInfo.range.start);
    for (let i = 0; i < a2.length; i++) {
      const aSpaces = a2[i][0];
      const bSpaces = b2[i][0];
      if (aSpaces != bSpaces) {
        const start: number = aPos;
        const end: number = aPos + aSpaces.length;
        const text: string = bSpaces;
        ret.push({ start, end, text });
      }
      aPos += a2[i][0].length + a2[i][1].length;
    }
    // Order edits from end-of-doc to start:
    ret.reverse();
    return ret;
  }
}

export async function formatPosition(
  editor: vscode.TextEditor,
  onType: boolean = false,
  extraConfig: CljFmtConfig = {}
): Promise<boolean> {
  // Stop trying if ever the document version changes - don't want to trample User's work
  const doc: vscode.TextDocument = editor.document,
    documentVersion = editor.document.version,
    formattedInfo = formatPositionInfo(editor, onType, extraConfig);
  if (formattedInfo && formattedInfo.previousText != formattedInfo.formattedText) {
    return editor
      .edit(
        (textEditorEdit) => {
          textEditorEdit.replace(formattedInfo.range, formattedInfo.formattedText);
        },
        { undoStopAfter: false, undoStopBefore: false }
      )
      .then((onFulfilled: boolean) => {
        if (onFulfilled) {
          if (documentVersion + 1 == editor.document.version) {
            editor.selections = [
              new vscode.Selection(
                doc.positionAt(formattedInfo.newIndex),
                doc.positionAt(formattedInfo.newIndex)
              ),
            ];
          }
        }
        return onFulfilled;
      });
  } else if (formattedInfo) {
    return new Promise((resolve, _reject) => {
      if (formattedInfo.newIndex != formattedInfo.previousIndex) {
        editor.selections = [
          new vscode.Selection(
            doc.positionAt(formattedInfo.newIndex),
            doc.positionAt(formattedInfo.newIndex)
          ),
        ];
      }
      resolve(true);
    });
  } else if (!onType && !outputWindow.isResultsDoc(doc)) {
    return formatRange(
      doc,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    );
  } else {
    return new Promise((resolve, _reject) => {
      resolve(true);
    });
  }
}

// Debounce format-as-you-type and toss it aside if User seems still to be working
let scheduledFormatCircumstances = undefined;
const scheduledFormatDelayMs = 250;

function formatPositionCallback(extraConfig: CljFmtConfig) {
  if (
    scheduledFormatCircumstances &&
    vscode.window.activeTextEditor === scheduledFormatCircumstances['editor'] &&
    vscode.window.activeTextEditor.document.version ==
      scheduledFormatCircumstances['documentVersion']
  ) {
    formatPosition(scheduledFormatCircumstances['editor'], true, extraConfig).finally(() => {
      scheduledFormatCircumstances = undefined;
    });
  }
  // do not anull scheduledFormatCircumstances. Another callback might have been scheduled
}

export function scheduleFormatAsType(editor: vscode.TextEditor, extraConfig: CljFmtConfig = {}) {
  const expectedDocumentVersionUponCallback = 1 + editor.document.version;
  if (
    !scheduledFormatCircumstances ||
    expectedDocumentVersionUponCallback != scheduledFormatCircumstances['documentVersion']
  ) {
    // Unschedule (if scheduled) & reschedule: best effort to reformat at a quiet time
    if (scheduledFormatCircumstances?.timeoutId) {
      clearTimeout(scheduledFormatCircumstances?.timeoutId);
    }
    scheduledFormatCircumstances = {
      editor: editor,
      documentVersion: expectedDocumentVersionUponCallback,
      timeoutId: setTimeout(function () {
        formatPositionCallback(extraConfig);
      }, scheduledFormatDelayMs),
    };
  }
}

export function formatPositionCommand(editor: vscode.TextEditor) {
  void formatPosition(editor);
}

export function alignPositionCommand(editor: vscode.TextEditor) {
  void formatPosition(editor, true, { 'align-associative?': true });
}

export function trimWhiteSpacePositionCommand(editor: vscode.TextEditor) {
  void formatPosition(editor, false, { 'remove-multiple-non-indenting-spaces?': true });
}

export function formatCode(code: string, eol: number) {
  const d = {
    'range-text': code,
    eol: _convertEolNumToStringNotation(eol),
    config: config.getConfigNow(),
  };
  const result = jsify(formatText(d));
  if (!result['error']) {
    return result['range-text'];
  } else {
    console.error('Error in `formatCode`:', result['error']);
    return code;
  }
}

async function _formatRange(
  rangeText: string,
  allText: string,
  range: number[],
  eol: string
): Promise<string | undefined> {
  const d = {
    'range-text': rangeText,
    'all-text': allText,
    range: range,
    eol: eol,
    config: await config.getConfig(),
  };
  const result = jsify(formatTextAtRange(d));
  if (!result['error']) {
    return result['range-text'];
  }
}

function _convertEolNumToStringNotation(eol: vscode.EndOfLine) {
  return eol == 2 ? '\r\n' : '\n';
}
