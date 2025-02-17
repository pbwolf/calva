export { getIndent } from '../cursor-doc/indent';
import * as vscode from 'vscode';
import * as utilities from '../utilities';
import * as formatter from '../calva-fmt/src/format';
import { LispTokenCursor } from '../cursor-doc/token-cursor';
import {
  ModelEdit,
  EditableDocument,
  EditableModel,
  ModelEditOptions,
  LineInputModel,
  ModelEditRange,
  ModelEditSelection,
  ModelEditFunction,
  selectionsAfterEdits,
} from '../cursor-doc/model';
import { isUndefined } from 'lodash';

const documents = new Map<vscode.TextDocument, MirroredDocument>();

/**
 * Ranges-to-reformat, capturing distinct, disjoint lists surrounding the given edits.
 * Positions in edits are relative to the document *before* any of the edits are applied.
 */
const reformatListRangesForEdits = (function () {
  // 'Decoders' of the [start, length] outer bounds of the new content inserted by a ModelEdit
  const pointsChangeRange = function (edit: ModelEdit<'changeRange'>): number[] {
    return [edit.args[0], edit.args[1]];
  };
  const pointsDeleteRange = function (edit: ModelEdit<'deleteRange'>): number[] {
    return [edit.args[0], edit.args[0]];
  };
  const pointsInsertString = function (edit: ModelEdit<'insertString'>): number[] {
    return [edit.args[0], edit.args[0] + edit.args[1].length];
  };
  const pointsModelEdit = function (edit: ModelEdit<ModelEditFunction>): number[] {
    const e: any = edit;
    return edit.editFn == 'deleteRange'
      ? pointsDeleteRange(e)
      : edit.editFn == 'changeRange'
      ? pointsChangeRange(e)
      : pointsInsertString(e);
  };

  const listAroundPoint = function (
    model: DocumentModel,
    offset: number
  ): ModelEditRange | undefined {
    const cursor = model.getTokenCursor(offset);
    if (cursor.forwardList()) {
      const end = cursor.offsetStart;
      if (cursor.backwardList()) {
        const start = cursor.offsetStart;
        return [start, end];
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  };

  return function (model: DocumentModel, edits: ModelEdit<ModelEditFunction>[]): ModelEditRange[] {
    // (The edits' positions are as-of the moment *before* application of the edits.)
    // Translate each edit to a start- and end-point of new content.
    // Translate those points to start- and end-points of sexprs.
    // Compute disjoint ranges.
    const listRanges: ModelEditRange[] = edits
      .flatMap(pointsModelEdit)
      .map((n: number) => listAroundPoint(model, n))
      .filter((r: ModelEditRange | undefined) => r != undefined)
      .sort((a: ModelEditRange, b: ModelEditRange) => b[1] - b[0] - (a[1] - a[0]));
    // Discard ranges embedded in other ranges. O(n2)
    // -Sort by length. Then traverse the list once. At each step,
    // -traverse the remainder of the list once, weeding out ranges included in the outer range.
    // -Use start==-1 as sentinel of a weeded-out range.
    for (let i = 0; i < listRanges.length; i++) {
      const outerRange = listRanges[i];
      if (outerRange[0] != -1) {
        for (let j = i + 1; j < listRanges.length; j++) {
          const innerRange = listRanges[j];
          if (innerRange[0] != -1) {
            if (innerRange[0] >= outerRange[0] && innerRange[1] <= outerRange[1]) {
              listRanges[j][0] = -1;
            }
          }
        }
      }
    }
    const disjointListRanges = listRanges.filter((r: ModelEditRange) => r[0] != -1);
    return disjointListRanges;
  };
})();

export class DocumentModel implements EditableModel {
  readonly lineEndingLength: number;
  lineInputModel: LineInputModel;
  documentVersion: number; // model reflects this version
  staleDocumentVersion: number; // this version is outdated by queued edits

  constructor(private document: MirroredDocument) {
    this.lineEndingLength = document.document.eol == vscode.EndOfLine.CRLF ? 2 : 1;
    this.lineInputModel = new LineInputModel(this.lineEndingLength);
  }

  get lineEnding() {
    return this.lineEndingLength == 2 ? '\r\n' : '\n';
  }

  /** A loggable message if the model is out-of-date with the given document version
   * or has been edited beyond that document version */
  stale(editorVersion: number): string {
    if (this.documentVersion && this.documentVersion != editorVersion) {
      return 'model=' + this.documentVersion + ' vs document=' + editorVersion;
    } else if (this.documentVersion && this.documentVersion == this.staleDocumentVersion) {
      return 'edited since ' + this.documentVersion;
    } else {
      return null;
    }
  }

  private editNowTextOnly(
    modelEdits: ModelEdit<ModelEditFunction>[],
    options: ModelEditOptions
  ): void {
    const builder = options.builder;
    for (const modelEdit of modelEdits) {
      switch (modelEdit.editFn) {
        case 'insertString':
          this.insertEdit.apply(this, [builder, ...modelEdit.args]);
          break;
        case 'changeRange':
          this.replaceEdit.apply(this, [builder, ...modelEdit.args]);
          break;
        case 'deleteRange':
          this.deleteEdit.apply(this, [builder, ...modelEdit.args]);
          break;
        default:
          break;
      }
    }
    this.staleDocumentVersion = this.documentVersion;
  }

  editNow(modelEdits: ModelEdit<ModelEditFunction>[], options: ModelEditOptions): void {
    this.editNowTextOnly(modelEdits, options);
    if (options.selections) {
      this.document.selections = options.selections;
    }
    if (!options.skipFormat) {
      const editor = utilities.getActiveTextEditor();
      void formatter.scheduleFormatAsType(editor, {
        'format-depth': options.formatDepth ?? 1,
      });
    }
  }

  edit(modelEdits: ModelEdit<ModelEditFunction>[], options: ModelEditOptions): Thenable<boolean> {
    const editor = utilities.getActiveTextEditor(),
      undoStopBefore = !!options.undoStopBefore;
    const listSelectionsForUnmodifiedDocument: ModelEditSelection[] = reformatListRangesForEdits(
      this,
      modelEdits
    ).map((r: ModelEditRange): ModelEditSelection => {
      return new ModelEditSelection(r[0], r[0], r[0], r[0]);
    });
    const reformattableSelectionsForModifiedDocument = selectionsAfterEdits(
      modelEdits,
      listSelectionsForUnmodifiedDocument
    );
    const reformatPositions = reformattableSelectionsForModifiedDocument.map((sel) => sel.active);
    const reformatPositionsAsOf = this.document.document.version;
    return editor
      .edit(
        (builder) => {
          this.editNowTextOnly(modelEdits, { builder: builder, ...options });
        },
        { undoStopBefore, undoStopAfter: false }
      )
      .then((isFulfilled) => {
        if (isFulfilled) {
          if (options.selections) {
            this.document.selections = options.selections;
          }
          if (!options.skipFormat) {
            if (reformatPositionsAsOf != this.document.document.version) {
              console.warn('Reformatting plan is out-of-date. Skipping reformatting');
              return Promise.resolve(true);
            } else {
              const reformatChange: formatter.ReformatChange[] = reformatPositions
                .sort((a, b) => a - b)
                .flatMap((p) => formatter.reformatChanges(this.document.document, p));
              const reformattingEdits: ModelEdit<'changeRange'>[] = reformatChange.map(
                (rc) => new ModelEdit('changeRange', [rc.start, rc.end, rc.text])
              );
              if (reformattingEdits.length) {
                return editor.edit((builder) => {
                  this.editNowTextOnly(reformattingEdits, { builder: builder, skipFormat: true });
                });
              } else {
                return Promise.resolve(true);
              }
            }

            // Reformatting exits multicursor mode. format-depth may vary among multiple selections.
            // Pending resolution of issues, kip formatting if there are multiple cursors:
            //if (1 < this.document.selections.length) {
            //  console.log('Skipping reformatting with multiple cursors.');
            //} else {
            //     return formatter.formatPosition(editor, true, {
            //       'format-depth': options.formatDepth ?? 1,
            //     });
            //}
          }
        }
        return isFulfilled;
      });
  }

  private insertEdit(
    builder: vscode.TextEditorEdit,
    offset: number,
    text: string,
    oldSelection?: [number, number],
    newSelection?: [number, number]
  ) {
    const editor = utilities.getActiveTextEditor(),
      document = editor.document;
    builder.insert(document.positionAt(offset), text);
  }

  private replaceEdit(
    builder: vscode.TextEditorEdit,
    start: number,
    end: number,
    text: string,
    oldSelection?: [number, number],
    newSelection?: [number, number]
  ) {
    const editor = utilities.getActiveTextEditor(),
      document = editor.document,
      range = new vscode.Range(document.positionAt(start), document.positionAt(end));
    builder.replace(range, text);
  }

  private deleteEdit(
    builder: vscode.TextEditorEdit,
    offset: number,
    count: number,
    oldSelection?: [number, number],
    newSelection?: [number, number]
  ) {
    const editor = utilities.getActiveTextEditor(),
      document = editor.document,
      range = new vscode.Range(document.positionAt(offset), document.positionAt(offset + count));
    builder.delete(range);
  }

  public getText(start: number, end: number, mustBeWithin = false) {
    return this.lineInputModel.getText(start, end, mustBeWithin);
  }

  public getLineText(line: number) {
    return this.lineInputModel.getLineText(line);
  }

  getOffsetForLine(line: number) {
    return this.lineInputModel.getOffsetForLine(line);
  }

  public getTokenCursor(offset: number, previous?: boolean) {
    return this.lineInputModel.getTokenCursor(offset, previous);
  }
}

export class MirroredDocument implements EditableDocument {
  constructor(public document: vscode.TextDocument) {}

  model = new DocumentModel(this);

  selectionsStack: ModelEditSelection[][] = [];

  public getTokenCursor(
    offset: number = this.selections[0].active,
    previous: boolean = false
  ): LispTokenCursor {
    return this.model.getTokenCursor(offset, previous);
  }

  public insertString(text: string) {
    const editor = utilities.getActiveTextEditor(),
      selection = editor.selections[0],
      wsEdit = new vscode.WorkspaceEdit(),
      // TODO: prob prefer selection.active or .start
      edit = vscode.TextEdit.insert(this.document.positionAt(this.selections[0].anchor), text);
    wsEdit.set(this.document.uri, [edit]);
    void vscode.workspace.applyEdit(wsEdit).then((_v) => {
      editor.selections = [selection];
    });
  }

  get selections(): ModelEditSelection[] {
    const editor = utilities.getActiveTextEditor(),
      document = editor.document;
    return editor.selections.map((sel) => {
      const anchor = document.offsetAt(sel.anchor),
        active = document.offsetAt(sel.active);
      return new ModelEditSelection(anchor, active);
    });
  }

  set selections(selections: ModelEditSelection[]) {
    const editor = utilities.getActiveTextEditor(),
      document = editor.document;
    editor.selections = selections.map((selection) => {
      const anchor = document.positionAt(selection.anchor),
        active = document.positionAt(selection.active);
      return new vscode.Selection(anchor, active);
    });

    const primarySelection = selections[0];
    const active = document.positionAt(primarySelection.active);
    editor.revealRange(new vscode.Range(active, active));
  }

  public getSelectionText() {
    const editor = utilities.getActiveTextEditor(),
      selection = editor.selections[0];
    return this.document.getText(selection);
  }
}

let registered = false;

function processChanges(event: vscode.TextDocumentChangeEvent) {
  const model = documents.get(event.document).model;
  for (const change of event.contentChanges) {
    // vscode may have a \r\n marker, so it's line offsets are all wrong.
    const myStartOffset =
        model.getOffsetForLine(change.range.start.line) + change.range.start.character,
      myEndOffset = model.getOffsetForLine(change.range.end.line) + change.range.end.character;
    void model.lineInputModel.edit(
      [
        new ModelEdit('changeRange', [
          myStartOffset,
          myEndOffset,
          change.text.replace(/\r\n/g, '\n'),
        ]),
      ],
      {}
    );
  }
  model.lineInputModel.flushChanges();

  // we must clear out the repaint cache data, since we don't use it.
  model.lineInputModel.dirtyLines = [];
  model.lineInputModel.insertedLines.clear();
  model.lineInputModel.deletedLines.clear();

  model.documentVersion = event.document.version;
  model.staleDocumentVersion = undefined;
}

export function tryToGetDocument(doc: vscode.TextDocument) {
  return documents.get(doc);
}

export function getDocument(doc: vscode.TextDocument) {
  const mirrorDoc = tryToGetDocument(doc);

  if (isUndefined(mirrorDoc)) {
    throw new Error('Missing mirror document!');
  }

  return mirrorDoc;
}

export function getDocumentOffset(doc: vscode.TextDocument, position: vscode.Position) {
  const model = getDocument(doc).model;
  return model.getOffsetForLine(position.line) + position.character;
}

function addDocument(doc?: vscode.TextDocument): boolean {
  if (doc && doc.languageId == 'clojure') {
    if (!documents.has(doc)) {
      const document = new MirroredDocument(doc);
      document.model.lineInputModel.insertString(0, doc.getText());
      documents.set(doc, document);
      return false;
    } else {
      return true;
    }
  }
  return false;
}

export function activate() {
  // the last thing we want is to register twice and receive double events...
  if (registered) {
    return;
  }
  registered = true;

  addDocument(utilities.tryToGetDocument({}));

  vscode.workspace.onDidCloseTextDocument((e) => {
    if (e.languageId == 'clojure') {
      documents.delete(e);
    }
  });

  vscode.window.onDidChangeActiveTextEditor((e) => {
    if (e && e.document && e.document.languageId == 'clojure') {
      addDocument(e.document);
    }
  });

  vscode.workspace.onDidOpenTextDocument((doc) => {
    addDocument(doc);
  });

  vscode.workspace.onDidChangeTextDocument((e) => {
    if (addDocument(e.document)) {
      processChanges(e);
    }
  });
}
