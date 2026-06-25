import * as vscode from 'vscode';

/** 현재 브랜치 노드에만 붙이는 커스텀 resourceUri 스킴 */
export const CURRENT_SCHEME = 'gitbranchtree';

/** 현재 브랜치 resourceUri (한 트리에 현재 브랜치는 하나뿐이라 고정 경로) */
export const CURRENT_URI = vscode.Uri.from({ scheme: CURRENT_SCHEME, path: '/current' });

/**
 * 현재 체크아웃된 브랜치의 라벨을 초록색 + 배지로 장식한다.
 * (TreeItem 에 CURRENT_URI 를 resourceUri 로 달아 둔 노드만 대상)
 */
export class CurrentBranchDecoration implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  /** 트리가 바뀌면(현재 브랜치 변경 등) 장식을 다시 계산하게 한다. */
  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CURRENT_SCHEME) return undefined;
    return new vscode.FileDecoration('●', vscode.l10n.t('Current branch'), new vscode.ThemeColor('charts.green'));
  }
}
