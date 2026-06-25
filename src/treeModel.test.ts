import { describe, expect, it } from 'vitest';
import { buildModel, buildRemoteForest, buildTree, type TreeNode } from './treeModel';

/** 트리에서 라벨 경로로 노드를 찾는 헬퍼 */
function find(nodes: TreeNode[], path: string[]): TreeNode | undefined {
  let current: TreeNode | undefined;
  let level = nodes;
  for (const label of path) {
    current = level.find((n) => n.label === label);
    if (!current) return undefined;
    level = current.children;
  }
  return current;
}

describe('buildTree', () => {
  it('슬래시 없는 브랜치는 최상위 leaf 가 된다', () => {
    const tree = buildTree(['master'], { idPrefix: '#local' });
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe('branch');
    expect(tree[0].label).toBe('master');
    expect(tree[0].branchName).toBe('master');
  });

  it('임의 뎁스를 full expand 한다 (compact 안 함)', () => {
    const tree = buildTree(['foo/bar/abc/ticket-1234'], { idPrefix: '#local' });
    const foo = find(tree, ['foo']);
    const bar = find(tree, ['foo', 'bar']);
    const abc = find(tree, ['foo', 'bar', 'abc']);
    const leaf = find(tree, ['foo', 'bar', 'abc', 'ticket-1234']);

    expect(foo?.kind).toBe('folder');
    expect(bar?.kind).toBe('folder');
    expect(abc?.kind).toBe('folder');
    expect(leaf?.kind).toBe('branch');
    expect(leaf?.branchName).toBe('foo/bar/abc/ticket-1234');
  });

  it('prefix 를 공유하는 브랜치는 같은 폴더 아래 모인다', () => {
    const tree = buildTree(['foo/a', 'foo/b'], { idPrefix: '#local' });
    const foo = find(tree, ['foo']);
    expect(foo?.kind).toBe('folder');
    expect(foo?.children.map((c) => c.label)).toEqual(['a', 'b']);
    expect(foo?.children.every((c) => c.kind === 'branch')).toBe(true);
  });

  it('각 레벨에서 폴더 먼저, 그다음 알파벳순 정렬', () => {
    const tree = buildTree(['zzz', 'aaa', 'foo/x'], { idPrefix: '#local' });
    // foo(folder) 먼저, 그다음 aaa, zzz (branch 알파벳순)
    expect(tree.map((n) => n.label)).toEqual(['foo', 'aaa', 'zzz']);
    expect(tree[0].kind).toBe('folder');
  });

  it('현재 브랜치를 표시한다', () => {
    const tree = buildTree(['foo/bar', 'main'], { idPrefix: '#local', currentBranch: 'foo/bar' });
    const leaf = find(tree, ['foo', 'bar']);
    expect(leaf?.isCurrent).toBe(true);
    // 표시 문자열('현재')은 provider 에서 l10n 으로 입히므로 모델엔 description 없음
    expect(leaf?.description).toBeUndefined();
    expect(find(tree, ['main'])?.isCurrent).toBeFalsy();
  });

  it('id 는 섹션 prefix 를 포함해 고유하다', () => {
    const tree = buildTree(['foo/bar'], { idPrefix: '#local' });
    expect(find(tree, ['foo'])?.id).toBe('#local/foo');
    expect(find(tree, ['foo', 'bar'])?.id).toBe('#local/foo/bar');
  });
});

describe('buildRemoteForest', () => {
  it('리모트가 1개면 리모트 이름을 접고 바로 경로 트리를 노출한다', () => {
    const forest = buildRemoteForest(['origin/foo/bar', 'origin/master'], '#remote');
    // 최상위에 origin 노드 없음 → 바로 foo, master
    expect(forest.map((n) => n.label).sort()).toEqual(['foo', 'master']);
    const leaf = find(forest, ['foo', 'bar']);
    expect(leaf?.kind).toBe('branch');
    expect(leaf?.isRemote).toBe(true);
    expect(leaf?.remote).toBe('origin');
    // DWIM 체크아웃용 이름은 remote 접두어 없는 경로
    expect(leaf?.branchName).toBe('foo/bar');
  });

  it('리모트가 2개 이상이면 리모트 이름 폴더를 한 단계 둔다', () => {
    const forest = buildRemoteForest(['origin/foo', 'upstream/bar'], '#remote');
    expect(forest.map((n) => n.label)).toEqual(['origin', 'upstream']);
    expect(find(forest, ['origin', 'foo'])?.kind).toBe('branch');
    expect(find(forest, ['upstream', 'bar'])?.kind).toBe('branch');
  });

  it('origin/HEAD 심볼릭 ref 는 제외한다', () => {
    const forest = buildRemoteForest(['origin/HEAD', 'origin/main'], '#remote');
    expect(forest.map((n) => n.label)).toEqual(['main']);
  });
});

describe('buildModel', () => {
  it('Local 섹션은 항상, Remote 섹션은 remote 브랜치가 있을 때만 만든다', () => {
    const withRemote = buildModel(['main'], ['origin/main'], 'main');
    expect(withRemote.map((n) => n.label)).toEqual(['Local', 'Remote']);

    const localOnly = buildModel(['main'], [], 'main');
    expect(localOnly.map((n) => n.label)).toEqual(['Local']);
  });

  it('detached 상태면 Local 섹션에 detached 플래그를 단다', () => {
    const model = buildModel(['main'], [], undefined, true);
    const local = model.find((n) => n.label === 'Local');
    expect(local?.detached).toBe(true);
  });
});
