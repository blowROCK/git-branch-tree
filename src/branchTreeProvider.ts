import * as vscode from 'vscode';
import { GitService } from './git';
import { CURRENT_URI } from './decoration';
import { buildModel, type TreeNode } from './treeModel';

/** 한 번에 보여줄 커밋 수(더보기 단위) */
const COMMIT_PAGE = 5;

/**
 * 브랜치 트리 데이터 제공자.
 * - 폴더/섹션/브랜치: reload 에서 빌드해 둔 정적 모델
 * - 브랜치를 펼치면 그 브랜치의 최근 커밋을 lazy 하게 git log 로 가져온다
 * - 아코디언: 다른 브랜치를 펼치면 이전 브랜치는 TreeItem id 를 바꿔 접는다(API 우회)
 */
export class BranchTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: TreeNode[] = [];
  private parents = new Map<string, TreeNode | undefined>();
  private nodeById = new Map<string, TreeNode>();
  private currentNode?: TreeNode;

  /** 브랜치별로 현재까지 보여줄 커밋 수 */
  private commitLimits = new Map<string, number>();
  /** 브랜치별 접기 세대값 — 값이 바뀌면 TreeItem id 가 바뀌어 강제로 접힌다 */
  private collapseGen = new Map<string, number>();
  /** 현재 커밋이 펼쳐진 브랜치 id(아코디언) */
  private openBranchId?: string;

  /** activate 에서 주입 — reveal 에 필요 */
  treeView?: vscode.TreeView<TreeNode>;

  constructor(private readonly git: GitService) {}

  async reload(): Promise<void> {
    const [local, remote, current] = await Promise.all([
      this.git.listLocalBranches(),
      this.git.listRemoteBranches(),
      this.git.getCurrentBranch(),
    ]);

    const detached = current === undefined && local.length > 0;
    this.roots = buildModel(local, remote, current, detached);
    this.parents = computeParents(this.roots);
    this.nodeById = indexById(this.roots);
    this.currentNode = current ? findCurrent(this.roots) : undefined;

    this._onDidChangeTreeData.fire(undefined);
    await this.revealCurrent();
  }

  /** 브랜치를 펼치면 호출 — 아코디언: 이전 브랜치를 접는다 */
  handleExpand(node: TreeNode): void {
    if (node.kind !== 'branch') return;
    if (this.openBranchId && this.openBranchId !== node.id) {
      const prev = this.nodeById.get(this.openBranchId);
      if (prev) {
        // TreeItem id 를 갱신 → VSCode 가 새 항목(기본 접힘)으로 다시 그림
        this.collapseGen.set(prev.id, (this.collapseGen.get(prev.id) ?? 0) + 1);
        this._onDidChangeTreeData.fire(prev);
      }
    }
    this.openBranchId = node.id;
  }

  handleCollapse(node: TreeNode): void {
    if (node.kind === 'branch' && node.id === this.openBranchId) {
      this.openBranchId = undefined;
    }
  }

  /** '더보기' — 해당 브랜치의 커밋 표시 수를 늘리고 그 노드만 갱신 */
  loadMore(branchId: string): void {
    const cur = this.commitLimits.get(branchId) ?? COMMIT_PAGE;
    this.commitLimits.set(branchId, cur + COMMIT_PAGE);
    const node = this.nodeById.get(branchId);
    if (node) this._onDidChangeTreeData.fire(node);
  }

  /**
   * 모든 폴더를 펼친다(커밋까지는 펼치지 않음). VSCode 트리뷰엔 expand-all 이 없어서
   * 모든 브랜치를 reveal 하면 그 조상 폴더들이 펼쳐지는 성질을 이용한다.
   */
  async expandAll(): Promise<void> {
    if (!this.treeView) return;
    const branches: TreeNode[] = [];
    const walk = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.kind === 'branch') branches.push(n);
        else if (n.children.length > 0) walk(n.children);
      }
    };
    walk(this.roots);

    for (const b of branches) {
      try {
        await this.treeView.reveal(b, { select: false, focus: false, expand: false });
      } catch {
        // 개별 reveal 실패는 무시
      }
    }
    if (this.roots[0]) {
      try {
        await this.treeView.reveal(this.roots[0], { select: false, focus: false });
      } catch {
        // noop
      }
    }
  }

  private async revealCurrent(): Promise<void> {
    if (!this.currentNode || !this.treeView?.visible) return;
    try {
      // expand:false — 현재 브랜치의 커밋을 자동으로 펼치진 않고 위치만 노출
      await this.treeView.reveal(this.currentNode, { select: true, focus: false, expand: false });
    } catch {
      // reveal 실패는 치명적이지 않음(뷰 미준비 등)
    }
  }

  getChildren(element?: TreeNode): TreeNode[] | Promise<TreeNode[]> {
    if (!element) return this.roots;
    if (element.kind === 'branch') return this.getCommitChildren(element);
    return element.children;
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return this.parents.get(element.id);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'commit') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon('git-commit');
      item.contextValue = 'commit';
      return item;
    }

    if (node.kind === 'more') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.id = node.id;
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.contextValue = 'more';
      item.command = { command: 'gitBranchTree.loadMoreCommits', title: '더보기', arguments: [node] };
      return item;
    }

    const item = new vscode.TreeItem(node.label, collapsibleStateFor(node));
    // 브랜치는 접기 세대값을 id 에 붙여 아코디언 강제 접기를 구현
    const gen = this.collapseGen.get(node.id);
    item.id = node.kind === 'branch' && gen !== undefined ? `${node.id}@${gen}` : node.id;
    // 현재/detached 표기는 표시 시점에 번역(treeModel 은 순수 유지)
    if (node.kind === 'branch' && node.isCurrent) item.description = vscode.l10n.t('current');
    else if (node.kind === 'section' && node.detached) item.description = vscode.l10n.t('detached HEAD');
    else item.description = node.description;
    item.iconPath = iconFor(node);
    item.contextValue = contextValueFor(node);
    // 단일 클릭은 펼침/접힘(커밋 미리보기). 체크아웃·삭제는 우클릭 메뉴로.
    if (node.kind === 'branch') {
      item.tooltip = node.isRemote ? `${node.remote}/${node.branchName}` : node.branchName;
      // 현재 브랜치는 FileDecoration(초록 라벨 + ● 배지)으로 구분
      if (node.isCurrent) item.resourceUri = CURRENT_URI;
    }
    return item;
  }

  private async getCommitChildren(branch: TreeNode): Promise<TreeNode[]> {
    if (!branch.branchName) return [];
    const ref = branch.isRemote ? `${branch.remote}/${branch.branchName}` : branch.branchName;
    const limit = this.commitLimits.get(branch.id) ?? COMMIT_PAGE;

    let commits;
    try {
      commits = await this.git.log(ref, limit + 1);
    } catch {
      return [leafNode(`${branch.id}#err`, vscode.l10n.t('(failed to load commits)'))];
    }
    if (commits.length === 0) return [leafNode(`${branch.id}#empty`, vscode.l10n.t('(no commits)'))];

    const hasMore = commits.length > limit;
    const shown = hasMore ? commits.slice(0, limit) : commits;

    const nodes: TreeNode[] = shown.map((c) => ({
      label: c.subject,
      kind: 'commit',
      id: `${branch.id}#c:${c.sha}`,
      description: `${c.shortSha} · ${c.author} · ${c.relDate}`,
      tooltip: `${c.shortSha}  ${c.author} · ${c.relDate}\n\n${c.subject}`,
      sha: c.sha,
      children: [],
    }));

    if (hasMore) {
      nodes.push({
        label: vscode.l10n.t('Show more (+{0})', COMMIT_PAGE),
        kind: 'more',
        id: `${branch.id}#more`,
        moreBranchId: branch.id,
        children: [],
      });
    }
    return nodes;
  }
}

function contextValueFor(node: TreeNode): string {
  if (node.kind === 'section') return node.id === '#local' ? 'localSection' : 'remoteSection';
  if (node.kind === 'folder') return 'folder';
  if (node.isRemote) return 'remoteBranch';
  if (node.isCurrent) return 'currentBranch';
  return 'localBranch';
}

function collapsibleStateFor(node: TreeNode): vscode.TreeItemCollapsibleState {
  if (node.kind === 'branch') return vscode.TreeItemCollapsibleState.Collapsed; // 펼치면 커밋 미리보기
  if (node.id === '#remote') return vscode.TreeItemCollapsibleState.Collapsed; // 리모트는 보통 많아 기본 접힘
  return vscode.TreeItemCollapsibleState.Expanded; // Local 섹션 및 폴더는 펼침
}

function iconFor(node: TreeNode): vscode.ThemeIcon {
  switch (node.kind) {
    case 'section':
      return new vscode.ThemeIcon(node.id === '#local' ? 'device-desktop' : 'cloud');
    case 'folder':
      return vscode.ThemeIcon.Folder;
    case 'branch':
      // 현재 브랜치 구분은 FileDecoration(라벨 색 + 배지)이 담당 → 아이콘은 통일
      return new vscode.ThemeIcon('git-branch');
    default:
      return new vscode.ThemeIcon('git-commit');
  }
}

function leafNode(id: string, label: string): TreeNode {
  return { label, kind: 'commit', id, children: [] };
}

function computeParents(roots: TreeNode[]): Map<string, TreeNode | undefined> {
  const map = new Map<string, TreeNode | undefined>();
  const walk = (nodes: TreeNode[], parent: TreeNode | undefined): void => {
    for (const n of nodes) {
      map.set(n.id, parent);
      if (n.children.length > 0) walk(n.children, n);
    }
  };
  walk(roots, undefined);
  return map;
}

function indexById(roots: TreeNode[]): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>();
  const walk = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      map.set(n.id, n);
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(roots);
  return map;
}

function findCurrent(roots: TreeNode[]): TreeNode | undefined {
  const stack = [...roots];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.isCurrent) return n;
    stack.push(...n.children);
  }
  return undefined;
}
