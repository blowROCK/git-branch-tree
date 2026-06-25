/**
 * 순수 트리 빌더 — VSCode API 의존 없음(단위 테스트 가능).
 *
 * 핵심 차별점: 브랜치 이름의 `/` 를 임의 뎁스로 펼쳐 폴더 트리를 만든다.
 * git 특성상 한 브랜치가 다른 브랜치의 prefix 가 될 수 없으므로
 * (refs/heads/foo 와 refs/heads/foo/bar 동시 존재 불가)
 * 중간 세그먼트는 항상 폴더, 마지막 세그먼트는 항상 브랜치(leaf)다.
 */

export type NodeKind = 'section' | 'folder' | 'branch' | 'commit' | 'more';

export interface TreeNode {
  /** 표시 라벨(해당 세그먼트만) */
  label: string;
  kind: NodeKind;
  /** 트리 내 고유 식별자(섹션 prefix 포함) */
  id: string;
  /** 우측 부가 설명(현재 브랜치 배지, detached 안내 등) */
  description?: string;
  /** branch 노드: 체크아웃 대상 이름(`git switch <name>` 에 그대로 사용) */
  branchName?: string;
  /** branch 노드: remote 전용 브랜치 여부 */
  isRemote?: boolean;
  /** branch 노드: 소속 remote 이름(origin 등) */
  remote?: string;
  /** branch 노드: 현재 HEAD 여부(local 만 해당) */
  isCurrent?: boolean;
  /** Local 섹션 노드: detached HEAD 상태(브랜치 아님) */
  detached?: boolean;
  /** commit 노드: 전체 SHA */
  sha?: string;
  /** commit 노드: 상세 tooltip */
  tooltip?: string;
  /** more 노드: 어느 브랜치의 '더보기'인지(브랜치 id) */
  moreBranchId?: string;
  children: TreeNode[];
}

interface BuildOpts {
  isRemote?: boolean;
  remote?: string;
  currentBranch?: string;
  idPrefix: string;
}

/**
 * `foo/bar/abc` 형태의 짧은 브랜치 이름 목록을 받아 중첩 트리를 만든다.
 * 정렬: 각 레벨에서 폴더 먼저 → 알파벳순.
 */
export function buildTree(branchNames: string[], opts: BuildOpts): TreeNode[] {
  const root: TreeNode = { label: '', kind: 'folder', id: opts.idPrefix, children: [] };

  for (const name of branchNames) {
    const segments = name.split('/');
    let node = root;
    let accId = opts.idPrefix;

    segments.forEach((seg, i) => {
      accId = `${accId}/${seg}`;
      const isLeaf = i === segments.length - 1;
      let child = node.children.find((c) => c.label === seg);

      if (!child) {
        child = {
          label: seg,
          kind: isLeaf ? 'branch' : 'folder',
          id: accId,
          children: [],
        };
        if (isLeaf) {
          child.branchName = name;
          child.isRemote = opts.isRemote;
          child.remote = opts.remote;
          if (!opts.isRemote && opts.currentBranch === name) {
            child.isCurrent = true;
          }
        }
        node.children.push(child);
      }
      node = child;
    });
  }

  sortNodes(root.children);
  return root.children;
}

/**
 * remote ref 짧은 이름 목록(`origin/foo/bar`, `upstream/x` ...)을 받아 트리를 만든다.
 * - 리모트가 1개면 리모트 이름을 접고 바로 경로 트리를 노출
 * - 2개 이상이면 리모트 이름 폴더 노드를 한 단계 둔다
 * - `origin/HEAD` 심볼릭 ref 는 제외
 */
export function buildRemoteForest(remoteRefNames: string[], idPrefix: string): TreeNode[] {
  const byRemote = new Map<string, string[]>();

  for (const ref of remoteRefNames) {
    const slash = ref.indexOf('/');
    if (slash < 0) continue;
    const remote = ref.slice(0, slash);
    const path = ref.slice(slash + 1);
    if (path === 'HEAD') continue; // origin/HEAD 제외
    const list = byRemote.get(remote) ?? [];
    list.push(path);
    byRemote.set(remote, list);
  }

  const remotes = [...byRemote.keys()].sort((a, b) => a.localeCompare(b));
  if (remotes.length === 0) return [];

  if (remotes.length === 1) {
    const r = remotes[0];
    return buildTree(byRemote.get(r)!, { isRemote: true, remote: r, idPrefix });
  }

  return remotes.map<TreeNode>((r) => ({
    label: r,
    kind: 'folder',
    id: `${idPrefix}/${r}`,
    children: buildTree(byRemote.get(r)!, { isRemote: true, remote: r, idPrefix: `${idPrefix}/${r}` }),
  }));
}

/**
 * 최상위 Local / Remote 섹션을 포함한 전체 모델을 만든다.
 * @param detached repo 는 있으나 HEAD 가 분리된 상태(브랜치 아님)
 */
export function buildModel(
  localBranches: string[],
  remoteRefs: string[],
  currentBranch: string | undefined,
  detached = false,
): TreeNode[] {
  const roots: TreeNode[] = [];

  const localSection: TreeNode = {
    label: 'Local',
    kind: 'section',
    id: '#local',
    children: buildTree(localBranches, { currentBranch, idPrefix: '#local' }),
  };
  if (detached) localSection.detached = true;
  roots.push(localSection);

  const remoteForest = buildRemoteForest(remoteRefs, '#remote');
  if (remoteForest.length > 0) {
    roots.push({
      label: 'Remote',
      kind: 'section',
      id: '#remote',
      children: remoteForest,
    });
  }

  return roots;
}

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1; // 폴더 먼저
    return a.label.localeCompare(b.label);
  });
  for (const n of nodes) {
    if (n.children.length > 0) sortNodes(n.children);
  }
}
