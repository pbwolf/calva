import * as vscode from 'vscode';
import { deepEqual } from './util/object';
import * as docMirror from './doc-mirror';
import * as context from './cursor-doc/cursor-context';
import * as util from './utilities';
import * as namespace from './namespace';
import * as session from './nrepl/repl-session';
import { cljsLib } from './utilities';

export let lastContexts: context.CursorContext[] = [];
export let currentContexts: context.CursorContext[] = [];

export function setCursorContextIfChanged(editor: vscode.TextEditor) {
  if (
    !editor ||
    !editor.document ||
    editor.document.languageId !== 'clojure' ||
    editor !== util.tryToGetActiveTextEditor()
  ) {
    return;
  }
  const contexts = determineCursorContexts(editor.document, editor.selections[0].active);
  setCursorContexts(contexts);
  const [ns, _form] = namespace.getNamespace(editor.document, editor.selections[0].active);
  void vscode.commands.executeCommand('setContext', 'calva:ns', ns);
  const sessionType = session.getReplSessionType(cljsLib.getStateValue('connected'));
  void vscode.commands.executeCommand('setContext', 'calva:replSessionType', sessionType);
}

function determineCursorContexts(
  document: vscode.TextDocument,
  position: vscode.Position
): context.CursorContext[] {
  const mirrorDoc = docMirror.getDocument(document);
  return context.determineContexts(mirrorDoc, document.offsetAt(position));
}

function setCursorContexts(contexts: context.CursorContext[]) {
  lastContexts = currentContexts;
  currentContexts = contexts;
  context.allCursorContexts.forEach((context) => {
    void vscode.commands.executeCommand('setContext', context, contexts.indexOf(context) > -1);
  });
}
