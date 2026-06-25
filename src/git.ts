import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface GitExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  relDate: string;
  subject: string;
}

/**
 * git CLI 직접 래퍼. 외부 의존성 0, 네트워크/OAuth 없음(로컬 .git 데이터만).
 */
export class GitService {
  constructor(private readonly cwd: string) {}

  /** 워크스페이스 폴더가 git work tree 인지 확인하고 repo 루트를 돌려준다. */
  static async findRepoRoot(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await pexec('git', ['rev-parse', '--show-toplevel'], { cwd });
      const root = stdout.trim();
      return root || undefined;
    } catch {
      return undefined;
    }
  }

  /** 로컬 브랜치 짧은 이름 목록 (foo/bar 형태) */
  async listLocalBranches(): Promise<string[]> {
    const { stdout } = await pexec('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
      cwd: this.cwd,
    });
    return splitLines(stdout);
  }

  /** remote 브랜치 짧은 이름 목록 (origin/foo/bar 형태) */
  async listRemoteBranches(): Promise<string[]> {
    const { stdout } = await pexec('git', ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], {
      cwd: this.cwd,
    });
    return splitLines(stdout);
  }

  /** 현재 브랜치 이름. detached HEAD 면 undefined. */
  async getCurrentBranch(): Promise<string | undefined> {
    try {
      const { stdout } = await pexec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: this.cwd });
      return stdout.trim() || undefined;
    } catch {
      return undefined; // detached HEAD
    }
  }

  /**
   * 브랜치 전환. remote 전용 이름(예: foo/bar)도 `git switch` 의 DWIM 으로
   * 같은 이름의 로컬 추적 브랜치를 자동 생성한 뒤 전환한다.
   * 실패(더티 트리 등) 시 git 의 stderr 를 담은 에러를 던진다.
   */
  async checkout(branchName: string): Promise<void> {
    await pexec('git', ['switch', branchName], { cwd: this.cwd });
  }

  /**
   * 로컬 브랜치 삭제. force=false 면 `-d`(미병합이면 git 이 거부),
   * force=true 면 `-D`(강제). 거부 시 git 의 stderr 를 담은 에러를 던진다.
   */
  async deleteLocalBranch(name: string, force: boolean): Promise<void> {
    await pexec('git', ['branch', force ? '-D' : '-d', name], { cwd: this.cwd });
  }

  /**
   * 원격 서버의 브랜치 삭제. `git push <remote> --delete <branch>`.
   * 네트워크/푸시 권한이 필요하며 성공 시 로컬 추적 ref 도 함께 정리된다.
   */
  async deleteRemoteBranch(remote: string, branch: string): Promise<void> {
    await pexec('git', ['push', remote, '--delete', branch], { cwd: this.cwd });
  }

  /**
   * 모든 리모트를 fetch 하고 서버에서 사라진 추적 ref 를 정리한다.
   * 리모트 정리 워크플로우에서 화면을 실제 서버 상태와 맞춘다.
   */
  async fetchPrune(): Promise<void> {
    await pexec('git', ['fetch', '--all', '--prune'], { cwd: this.cwd });
  }

  /**
   * 새 브랜치를 생성하고 전환한다. `git switch -c <name> [startPoint]`.
   * startPoint 미지정 시 현재 HEAD 에서 분기한다.
   */
  async createBranch(name: string, startPoint?: string): Promise<void> {
    const args = ['switch', '-c', name];
    if (startPoint) args.push(startPoint);
    await pexec('git', args, { cwd: this.cwd });
  }

  /**
   * 특정 ref 의 최근 커밋을 limit 개 조회한다(미리보기용).
   * ref 는 로컬(foo/bar) 또는 원격(origin/foo/bar) 모두 가능.
   */
  async log(ref: string, limit: number): Promise<CommitInfo[]> {
    const SEP = String.fromCharCode(31); // unit separator(0x1F) — subject 에 거의 안 나오는 구분자
    const fmt = ['%H', '%h', '%an', '%ar', '%s'].join(SEP);
    const { stdout } = await pexec('git', ['log', '-n', String(limit), `--format=${fmt}`, ref], {
      cwd: this.cwd,
    });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, shortSha, author, relDate, subject] = line.split(SEP);
        return { sha, shortSha, author, relDate, subject };
      });
  }
}

function splitLines(out: string): string[] {
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
