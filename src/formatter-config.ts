import * as vscode from 'vscode';
import * as filesCache from './files-cache';
import * as cljsLib from '../out/cljs-lib/cljs-lib.js';
import * as lsp from './lsp';

const defaultCljfmtContent =
  '\
{:remove-surrounding-whitespace? true\n\
 :remove-trailing-whitespace? true\n\
 :remove-consecutive-blank-lines? false\n\
 :insert-missing-whitespace? true\n\
 :align-associative? false}';

const LSP_CONFIG_KEY = 'CLOJURE-LSP';
let lspFormatConfig: string | undefined;

function configuration(workspaceConfig: vscode.WorkspaceConfiguration, cljfmt: string) {
  const cljfmtOptions = cljsLib.cljfmtOptionsFromString(cljfmt);
  return {
    'format-as-you-type': !!formatOnTypeEnabled(),
    'keep-comment-forms-trail-paren-on-own-line?': !!workspaceConfig.get<boolean>(
      'keepCommentTrailParenOnOwnLine'
    ),
    'cljfmt-options-string': cljfmt,
    'cljfmt-options': cljfmtOptions,
  };
}

function getConfigPath(workspaceConfig: vscode.WorkspaceConfiguration): string | undefined {
  const pathFromSettings = workspaceConfig.get<string>('configPath');
  if (pathFromSettings) {
    return pathFromSettings;
  }
  // if not set, check default cljfmt paths (https://github.com/weavejester/cljfmt#configuration)
  const configFileNames = ['.cljfmt.edn', '.cljfmt.clj', 'cljfmt.edn', 'cljfmt.clj'];
  return configFileNames.find((configPath) => {
    return filesCache.content(configPath);
  });
}

export type FormatterConfig = Partial<Awaited<ReturnType<typeof getConfig>>>;

let cachedLspConfig = undefined;

async function getAndCacheLspConfig(documentUri: vscode.Uri) {
  const clientProvider = lsp.getClientProvider();
  const client = clientProvider.getClientForDocumentUri(documentUri);
  if (client && client.isRunning) {
    lspFormatConfig = await lsp.api.getCljFmtConfig(client);
    if (lspFormatConfig) {
      cachedLspConfig = lspFormatConfig;
    } else {
      console.error(
        'Fetching formatting settings from clojure-lsp failed. Check that you are running a version of clojure-lsp that provides "cljfmt-raw" in serverInfo.'
      );
    }
    return lspFormatConfig;
  }
}

function getCachedLspConfig(documentUri: vscode.Uri) {
  // The Uri ensures LSP config could be cached per-document, if that were necessary.
  if (cachedLspConfig) {
    return cachedLspConfig;
  } else {
    console.log(
      'LSP config is not cached yet, but I will get right on it. Try again in a little while.'
    );
    void getAndCacheLspConfig(documentUri);
    return {};
  }
}

// To enable synchronous commands to get an instant configuration,
// might return undefined for LSP-based members until background query completes.
export function getConfig(
  document: vscode.TextDocument = vscode.window.activeTextEditor?.document
): {
  'format-as-you-type': boolean;
  'keep-comment-forms-trail-paren-on-own-line?': boolean;
  'cljfmt-options-string': string;
  'cljfmt-options': object;
} {
  const workspaceConfig = vscode.workspace.getConfiguration('calva.fmt');
  const configPath: string | undefined = getConfigPath(workspaceConfig);

  if (configPath === LSP_CONFIG_KEY && document) {
    lspFormatConfig = getCachedLspConfig(document.uri);
  }
  const cljfmtContent: string | undefined =
    configPath === LSP_CONFIG_KEY
      ? lspFormatConfig
        ? lspFormatConfig
        : defaultCljfmtContent
      : filesCache.content(configPath);
  const config = configuration(
    workspaceConfig,
    cljfmtContent ? cljfmtContent : defaultCljfmtContent
  );
  if (config['cljfmt-options']['error']) {
    void vscode.window.showErrorMessage(
      `Error parsing ${configPath}: ${config['cljfmt-options']['error']}\n\nUsing default formatting configuration.`
    );
  }
  return config;
}

export function formatOnTypeEnabled() {
  return (
    vscode.workspace.getConfiguration('editor').get('formatOnType') ||
    vscode.workspace
      .getConfiguration('editor')
      .inspect('formatOnType')
      .languageIds.includes('clojure')
  );
}
