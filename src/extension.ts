import * as vscode from 'vscode';
import { GitService } from './git';
import { BranchTreeProvider } from './branchTreeProvider';
import { CurrentBranchDecoration } from './decoration';
import type { TreeNode } from './treeModel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const repoRoot = cwd ? await GitService.findRepoRoot(cwd) : undefined;

  // repo 가 없어도 뷰는 등록한다(viewsWelcome 안내 노출). cwd 폴백으로 빈 GitService.
  const git = new GitService(repoRoot ?? cwd ?? process.cwd());
  const provider = new BranchTreeProvider(git);

  const treeView = vscode.window.createTreeView('gitBranchTree.view', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.treeView = treeView;

  const decoration = new CurrentBranchDecoration();

  context.subscriptions.push(
    treeView,
    vscode.window.registerFileDecorationProvider(decoration),
    // 트리가 바뀌면 현재 브랜치 장식도 다시 계산
    provider.onDidChangeTreeData(() => decoration.refresh()),
    vscode.commands.registerCommand('gitBranchTree.refresh', () => provider.reload()),
    vscode.commands.registerCommand('gitBranchTree.expandAll', () => provider.expandAll()),
    vscode.commands.registerCommand('gitBranchTree.checkout', (node: TreeNode) => checkout(git, provider, node)),
    vscode.commands.registerCommand('gitBranchTree.deleteLocalBranch', (node: TreeNode) =>
      deleteLocalBranch(git, provider, node),
    ),
    vscode.commands.registerCommand('gitBranchTree.deleteRemoteBranch', (node: TreeNode) =>
      deleteRemoteBranch(git, provider, node),
    ),
    vscode.commands.registerCommand('gitBranchTree.fetchPrune', () => fetchPrune(git, provider)),
    vscode.commands.registerCommand('gitBranchTree.createBranch', (node?: TreeNode) =>
      createBranch(git, provider, node),
    ),
    vscode.commands.registerCommand('gitBranchTree.loadMoreCommits', (node: TreeNode) => {
      if (node?.moreBranchId) provider.loadMore(node.moreBranchId);
    }),
    // 아코디언: 다른 브랜치를 펼치면 이전 브랜치는 접힘
    treeView.onDidExpandElement((e) => provider.handleExpand(e.element)),
    treeView.onDidCollapseElement((e) => provider.handleCollapse(e.element)),
    // 뷰가 다시 보일 때 갱신(외부 터미널에서 브랜치 바꿔도 반영)
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) void provider.reload();
    }),
  );

  if (repoRoot) {
    await provider.reload();
  }
}

async function checkout(git: GitService, provider: BranchTreeProvider, node: TreeNode): Promise<void> {
  if (!node || node.kind !== 'branch' || !node.branchName || node.isCurrent) return;
  try {
    await git.checkout(node.branchName);
    await provider.reload(); // 체크아웃 후 자동 갱신
    vscode.window.setStatusBarMessage(`$(git-branch) ${vscode.l10n.t('Switched to {0}', node.branchName)}`, 3000);
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Checkout failed: {0}', errText(err)));
  }
}

async function deleteLocalBranch(git: GitService, provider: BranchTreeProvider, node: TreeNode): Promise<void> {
  if (!node || node.kind !== 'branch' || node.isRemote || !node.branchName) return;
  const name = node.branchName;
  const DELETE = vscode.l10n.t('Delete');
  const FORCE = vscode.l10n.t('Force delete');

  // 모달 1번 — [삭제]는 안전 삭제(-d), [강제 삭제]는 -D. (VSCode 모달은 체크박스 미지원 → 버튼으로 제공)
  const pick = await vscode.window.showWarningMessage(
    vscode.l10n.t("Delete local branch '{0}'?", name),
    {
      modal: true,
      detail: vscode.l10n.t('Unmerged branches: choose [Force delete]. Commits unique to this branch may be lost.'),
    },
    DELETE,
    FORCE,
  );
  if (pick !== DELETE && pick !== FORCE) return;

  try {
    await git.deleteLocalBranch(name, pick === FORCE);
    await provider.reload();
    const msg = pick === FORCE ? vscode.l10n.t('Local branch {0} force-deleted', name) : vscode.l10n.t('Local branch {0} deleted', name);
    vscode.window.setStatusBarMessage(`$(trash) ${msg}`, 3000);
  } catch (err) {
    const detail = errText(err);
    // 안전 삭제가 미병합으로 거부된 경우 한 번 더 강제 여부 확인(안전망)
    if (pick === DELETE && /not fully merged/i.test(detail)) {
      const force = await vscode.window.showWarningMessage(
        vscode.l10n.t("'{0}' is not fully merged. Force delete?", name),
        { modal: true, detail: vscode.l10n.t('Commits unique to this branch may be lost.') },
        FORCE,
      );
      if (force !== FORCE) return;
      try {
        await git.deleteLocalBranch(name, true);
        await provider.reload();
        vscode.window.setStatusBarMessage(`$(trash) ${vscode.l10n.t('Local branch {0} force-deleted', name)}`, 3000);
      } catch (e2) {
        vscode.window.showErrorMessage(vscode.l10n.t('Delete failed: {0}', errText(e2)));
      }
      return;
    }
    vscode.window.showErrorMessage(vscode.l10n.t('Delete failed: {0}', detail));
  }
}

async function deleteRemoteBranch(git: GitService, provider: BranchTreeProvider, node: TreeNode): Promise<void> {
  if (!node || node.kind !== 'branch' || !node.isRemote || !node.remote || !node.branchName) return;
  const remote = node.remote;
  const branch = node.branchName;
  const CONFIRM = vscode.l10n.t('Delete from remote');

  const pick = await vscode.window.showWarningMessage(
    vscode.l10n.t("Delete '{0}/{1}' from the remote server?", remote, branch),
    { modal: true, detail: vscode.l10n.t('This cannot be undone. Push access to {0} is required.', remote) },
    CONFIRM,
  );
  if (pick !== CONFIRM) return;

  await vscode.window.withProgress(
    { location: { viewId: 'gitBranchTree.view' }, title: vscode.l10n.t('Deleting {0}/{1}...', remote, branch) },
    async () => {
      try {
        await git.deleteRemoteBranch(remote, branch);
        await provider.reload();
        vscode.window.setStatusBarMessage(`$(trash) ${vscode.l10n.t('Deleted {0}/{1} from the remote', remote, branch)}`, 4000);
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('Remote delete failed: {0}', errText(err)));
      }
    },
  );
}

async function fetchPrune(git: GitService, provider: BranchTreeProvider): Promise<void> {
  await vscode.window.withProgress(
    { location: { viewId: 'gitBranchTree.view' }, title: vscode.l10n.t('Fetching (fetch --all --prune)...') },
    async () => {
      try {
        await git.fetchPrune();
        await provider.reload();
        vscode.window.setStatusBarMessage(`$(sync) ${vscode.l10n.t('fetch + prune done')}`, 3000);
      } catch (err) {
        vscode.window.showErrorMessage(vscode.l10n.t('fetch failed: {0}', errText(err)));
      }
    },
  );
}

async function createBranch(git: GitService, provider: BranchTreeProvider, node?: TreeNode): Promise<void> {
  // 브랜치 노드에서 호출되면 그 지점에서 분기, 툴바/팔레트에서 호출되면 현재 HEAD 에서 분기
  const startPoint =
    node?.kind === 'branch' && node.branchName
      ? node.isRemote
        ? `${node.remote}/${node.branchName}`
        : node.branchName
      : undefined;

  const name = await vscode.window.showInputBox({
    title: vscode.l10n.t('New branch'),
    prompt: startPoint ? vscode.l10n.t("Branch from '{0}'", startPoint) : vscode.l10n.t('Branch from current HEAD'),
    placeHolder: vscode.l10n.t('e.g. feature/my-work'),
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return vscode.l10n.t('Enter a branch name');
      if (/\s/.test(t)) return vscode.l10n.t('Spaces are not allowed');
      return undefined;
    },
  });
  if (!name) return;

  try {
    await git.createBranch(name.trim(), startPoint);
    await provider.reload();
    vscode.window.setStatusBarMessage(`$(git-branch) ${vscode.l10n.t('Created {0} and switched', name.trim())}`, 3000);
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Branch creation failed: {0}', errText(err)));
  }
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || vscode.l10n.t('Unknown error')).trim();
}

export function deactivate(): void {
  // 정리할 전역 리소스 없음(subscriptions 로 처리됨)
}
