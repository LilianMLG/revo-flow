// La garde anti-merge (v3.3, docs/rd-v3/README.md §3 ter), module pur : ce qui est refusé, ce qui passe, et la lecture du shell.
// Écrits d'après le tableau de la spec, pas d'après le code.
import { describe, expect, test } from 'claude-code/testing'

import { brancheParDefaut, dossiersDuPush, mergeDenial, segments } from '../hooks/merge'

import type { MergeContexte } from '../hooks/merge'

const DEPOT: MergeContexte = { defaut: 'main' }
const PS: MergeContexte = { defaut: 'main', shell: 'powershell' }
const refuse = (c: string, ctx = DEPOT) => expect(mergeDenial(c, ctx)).toBeDefined()
const passe = (c: string, ctx = DEPOT) => expect(mergeDenial(c, ctx)).toBeUndefined()

describe('mergeDenial : merge par la CLI', () => {
  test('gh pr merge, avec ou sans --auto, numéro ou options', () => {
    refuse('gh pr merge')
    refuse('gh pr merge 42 --squash --delete-branch')
    refuse('gh pr merge --auto --merge 12')
    refuse('gh pr merge -R LilianMLG/revo-flow 3')
    refuse('/usr/local/bin/gh pr merge 3')
    refuse('gh.exe pr merge 3')
  })

  test('glab mr merge et son alias accept, et les options qui arment l’auto-merge', () => {
    refuse('glab mr merge 17')
    refuse('glab mr accept 17 --squash')
    refuse('GITLAB_HOST=git.entreprise.local glab mr merge 17')
    refuse('glab mr update 17 --auto-merge')
    refuse('glab mr create --fill --when-pipeline-succeeds')
  })

  test('ce qui ne fusionne pas passe : création, lecture, revue, approbation, merge local', () => {
    passe('gh pr create --fill --draft')
    passe('gh pr view 12 --json mergeable,mergeStateStatus')
    passe('gh pr list --search "merge conflict"')
    passe('gh pr review 12 --approve')
    passe('gh pr checks 12 --watch')
    passe('glab mr create --fill --draft --target-branch main')
    passe('glab mr view 17')
    passe('glab mr approve 17')
    passe('git merge origin/main')
    passe('git merge --no-ff feat/x')
  })
})

describe('mergeDenial : merge par l’API', () => {
  test('REST GitHub : PUT sur /pulls/n/merge, mais pas une lecture GET explicite', () => {
    refuse('gh api -X PUT repos/o/r/pulls/12/merge -f merge_method=squash')
    refuse('curl -X PUT -H "Authorization: Bearer $T" https://api.github.com/repos/o/r/pulls/12/merge')
    passe('gh api -X GET repos/o/r/pulls/12/merge')
    passe('curl --request GET https://api.github.com/repos/o/r/pulls/12/merge')
  })

  test('GraphQL GitHub et GitLab', () => {
    refuse(`gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "X"}) { clientMutationId } }'`)
    refuse(`gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: "X"}) { clientMutationId } }'`)
    refuse(`curl -X POST https://git.entreprise.local/api/graphql -d '{"query":"mutation { mergeRequestAccept(input: {}) { errors } }"}'`)
  })

  test('REST GitLab : /merge_requests/n/merge et merge_when_pipeline_succeeds', () => {
    refuse('glab api -X PUT projects/12/merge_requests/17/merge')
    refuse('curl -X PUT "https://git.entreprise.local/api/v4/projects/12/merge_requests/17/merge?squash=true"')
    refuse('glab api -X PUT projects/12/merge_requests/17 -f merge_when_pipeline_succeeds=true')
    refuse('curl -X PUT https://git.entreprise.local/api/v4/projects/12/merge_requests/17 -d auto_merge=true')
    passe('glab api projects/12/merge_requests/17')
    passe('glab api projects/12/merge_requests/17/merge_ref')
    passe('glab api -X PUT projects/12/merge_requests/17 -f merge_when_pipeline_succeeds=false')
  })

  test('les autres façons de modifier main par l’API (revue, point 7)', () => {
    refuse('gh api repos/o/r/merges -f base=main -f head=feat/x')
    refuse('gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc')
    refuse('gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc')
    refuse('gh api repos/o/r/git/refs/heads/develop -X DELETE', { defaut: 'develop' })
    refuse(`gh api graphql -f query='mutation { enqueuePullRequest(input: {pullRequestId: "X"}) { clientMutationId } }'`)
    refuse(`gh api graphql -f query='mutation { mergeBranch(input: {repositoryId: "X", base: "main", head: "f"}) { clientMutationId } }'`)
    refuse('glab api -X POST projects/12/merge_trains/merge_requests/17')
    // les lectures passent : la ref de main, le train de merge
    passe('gh api repos/o/r/git/refs/heads/main')
    passe('gh api repos/o/r/git/refs/heads/main --jq .object.sha')
    passe('glab api projects/12/merge_trains/merge_requests/17')
    passe('gh api -X PATCH repos/o/r/git/refs/heads/feat/x -f sha=abc')
  })

  test('les écritures directes sur une branche protégée : fichiers, commits, refs GraphQL (revue PR, point 6)', () => {
    refuse('gh api -X PUT repos/o/r/contents/README.md -f branch=main -f message=x -f content=eA==')
    // sans branch, GitHub écrit sur la branche par défaut
    refuse('gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA==')
    refuse('gh api -X DELETE repos/o/r/contents/a.md -f branch=main -f message=x -f sha=abc')
    refuse(`gh api graphql -f query='mutation { createCommitOnBranch(input: {branch: {repositoryNameWithOwner: "o/r", branchName: "main"}}) { commit { oid } } }'`)
    refuse(`gh api graphql -f query='mutation { updateRef(input: {refId: "X", oid: "abc"}) { clientMutationId } }' -f name=refs/heads/main`)
    refuse(`curl -X POST https://git.entreprise.local/api/v4/projects/12/repository/commits -H 'Content-Type: application/json' -d '{"branch":"main","commit_message":"x","actions":[]}'`)
    refuse('glab api -X PUT projects/12/repository/files/README.md -f branch=develop -f content=x', { defaut: 'develop' })
    passe('gh api -X PUT repos/o/r/contents/README.md -f branch=feat/x -f message=x -f content=eA==')
    passe('gh api repos/o/r/contents/README.md')
    passe('glab api -X POST projects/12/repository/commits -f branch=feat/x -f commit_message=x')
    passe(`gh api graphql -f query='mutation { createCommitOnBranch(input: {branch: {repositoryNameWithOwner: "o/main-app", branchName: "feat/x"}}) { commit { oid } } }'`)
  })

  test('le texte libre de gh et glab ne déclenche rien ; gh api …/merge sans méthode reste refusé (revue, point 8)', () => {
    passe('gh pr create --title "garde" --body "la garde bloque mergePullRequest et /pulls/1/merge"')
    passe('gh pr comment 3 -b "merge_when_pipeline_succeeds=true est refusé"')
    passe('gh pr create --body="voir /repos/o/r/merges"')
    passe('glab mr create -t garde -d "bloque /merge_requests/1/merge"')
    passe('glab mr note 3 -m "auto_merge=true"')
    refuse('gh api repos/o/r/pulls/3/merge')
    refuse(`gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }' -t '{{.}}'`)
  })

  test('un texte qui cite une API ne l’appelle pas : message de commit, echo, grep', () => {
    passe('git commit -m "refuse aussi /pulls/12/merge et mergePullRequest"')
    passe('echo "glab api -X PUT projects/1/merge_requests/2/merge"')
    passe('grep -rn "merge_requests/1/merge" docs')
  })
})

describe('mergeDenial : push', () => {
  test('vers main, master ou la branche par défaut, sous toutes les formes de refspec', () => {
    refuse('git push origin main')
    refuse('git push origin master')
    refuse('git push origin HEAD:main')
    refuse('git push origin feat/garde:refs/heads/main')
    refuse('git push -f origin +main')
    refuse('git push --force-with-lease origin feat/x:main')
    refuse('git push origin :main')
    refuse('git push origin --delete main')
    refuse('git push origin develop', { defaut: 'develop' })
    refuse('git -C ../autre push origin main')
    refuse("git push origin 'refs/heads/*:refs/heads/*'")
  })

  test('un push doit nommer sa branche : sans refspec, HEAD ou @, il dépend du dossier du shell et de l’amont (revue PR, points 3 à 5)', () => {
    expect(mergeDenial('git push')).toContain('« git push sans branche nommée »')
    refuse('git push origin')
    refuse('git push -u origin HEAD')
    refuse('git push origin @')
    refuse('git push --follow-tags origin')
    refuse('git -C repo-feat push origin feat/x && git -C repo-main push')
    passe('git push --tags')
    passe('git push origin --tags')
    passe('git push -u origin feat/garde')
    passe('git push origin HEAD:feat/garde')
    passe('git push -u origin feat/garde', {})
  })

  test('--signed ne prend sa valeur qu’avec = : le remote n’est pas avalé (revue, point 4)', () => {
    refuse('git push --signed origin main')
    refuse('git push --signed=if-asked origin main')
    refuse('git push --recurse-submodules check origin main')
    passe('git push --signed origin feat/garde')
  })

  test('--all, --branches et --mirror poussent aussi main (revue PR, point 2)', () => {
    refuse('git push --all origin')
    refuse('git push --branches origin')
    refuse('git push --mirror')
  })

  test('les redirections ne sont pas des refspecs ; un commentaire n’est pas un argument (revue PR, points 1 et 10)', () => {
    refuse('git push origin 2>&1')
    refuse('git push origin >/dev/null 2>&1')
    refuse('git push origin &> out.txt')
    refuse('git push origin main 2>&1 | tail -5')
    passe('git push -u origin feat/garde 2>&1')
    passe('git push -u origin feat/garde > out.txt 2>&1')
    passe('git push -u origin feat/garde  # pas main')
    refuse('git push origin main # vers feat')
    expect(segments('a 2>&1 b > f c # d e\nf')).toEqual([['a', 'b', 'c'], ['f']])
  })

  test('les options de push GitLab qui fusionnent, sous leurs trois écritures', () => {
    refuse('git push -o merge_request.create -o merge_request.merge_when_pipeline_succeeds origin feat/garde')
    refuse('git push --push-option=merge_request.auto_merge origin feat/garde')
    refuse('git push -omerge_request.merge_when_pipeline_succeeds origin feat/garde')
    passe('git push -o merge_request.create -o merge_request.target=main origin feat/garde')
  })

  test('une branche de travail passe, même forcée', () => {
    passe('git push -u origin feat/garde')
    passe('git push --force-with-lease origin feat/garde')
    passe('git push origin HEAD:feat/autre')
    passe('git push origin main-fix')
  })
})

describe('mergeDenial : lecture du shell', () => {
  test('dans une chaîne, un sous-shell, sh -c, eval ou derrière une enveloppe', () => {
    refuse('npm test && gh pr merge 3')
    refuse('git status; git push origin main')
    refuse('echo ok | xargs gh pr merge')
    refuse('(cd app && git push origin main)')
    refuse('echo $(gh pr merge 3)')
    refuse(`bash -c "gh pr merge 3"`)
    refuse(`sh -lc 'git push origin main'`)
    refuse('eval "glab mr merge 3"')
    refuse('sudo -E env FOO=1 gh pr merge 3')
    refuse('gh pr create --fill\ngh pr merge --auto')
  })

  test('un heredoc ou un message entre guillemets est du texte, pas une commande', () => {
    passe(`git commit -F - <<'EOF'\nfeat: garde\n\ngh pr merge est refusé\ngit push origin main aussi\nEOF\ngit push -u origin feat/garde`)
    passe(`git commit -m "$(cat <<'EOF'\ngh pr merge refusé ; git push origin main aussi\nEOF\n)"`)
    passe(`git commit -m 'bloque "gh pr merge" && git push origin main'`)
    // la commande qui suit le heredoc est bien lue
    refuse(`cat <<EOF > notes.md\nrien\nEOF\ngit push origin main`)
  })

  test('PowerShell et cmd : -Command, Invoke-Expression, cmd /c et /k (revue, point 5)', () => {
    refuse(`pwsh -Command "gh pr merge 3"`)
    refuse(`Invoke-Expression "glab mr merge 3"`)
    refuse('cmd /c gh pr merge 3')
    refuse('cmd.exe /K "git push origin main"')
    refuse('powershell -EncodedCommand ZwBoACAAcAByACAAbQBlAHIAZwBlAA==')
  })

  test('outil PowerShell : le backtick échappe et continue la ligne, l’antislash est ordinaire (revue PR, point 8)', () => {
    refuse('gh pr `\n merge 12', PS)
    refuse('gh pr `\r\n merge 12', PS)
    refuse('g`h pr merge 12', PS)
    refuse('& "C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 3', PS)
    refuse('git push origin "ma`in"', PS)
    passe('git push -u origin feat/garde 2>&1', PS)
    passe('git commit -m "pas de gh pr merge ici"', PS)
    expect(segments('a `\n b; c', 'powershell')).toEqual([['a', 'b'], ['c']])
  })

  test('un shell qui lit son entrée : here-string et tube (revue PR, point 7)', () => {
    refuse('bash <<< "gh pr merge 12 --squash"')
    refuse(`sh <<< 'git push origin main'`)
    refuse(`echo 'gh pr merge 12' | sh`)
    refuse(`printf 'git push origin main\n' | bash -s`)
    passe(`grep x <<< "gh pr merge 12"`)
    passe('cat scripts/test.sh | wc -l')
    passe(`echo "gh pr merge" && bash scripts/test.sh`)
  })

  test('une substitution entre guillemets doubles est exécutée, entre guillemets simples non (revue, point 1)', () => {
    refuse('echo "done: $(gh pr merge 3 --squash)"')
    refuse('git commit -m "x `gh pr merge 3`"')
    refuse('echo "a $(echo "b $(git push origin main)")"')
    passe(`echo 'pas exécuté : $(gh pr merge 3)'`)
  })

  test('chemins Windows et antislash : le programme reste reconnu (revue, point 2)', () => {
    refuse('C:\\tools\\gh.exe pr merge 3')
    refuse('& "C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 3')
    refuse('& "C:\\Program Files\\Git\\cmd\\git.exe" push origin main')
    refuse('\\gh pr merge 3')
  })

  test('enveloppes : timeout, et les valeurs de leurs options (revue, point 3)', () => {
    refuse('timeout 60 gh pr merge 3')
    refuse('timeout -s KILL 5m gh pr merge 3')
    refuse('sudo -u me gh pr merge 3')
    refuse('xargs -n 1 gh pr merge')
    refuse('nice -n 10 git push origin main')
    refuse('env -u GH_TOKEN FOO=1 gh pr merge 3')
    passe('timeout 60 npm test')
  })

  test('un heredoc donné à un shell est exécuté ; non cité, ses substitutions aussi (revue, point 5)', () => {
    refuse(`bash <<'EOF'\ngh pr merge 3\nEOF`)
    refuse(`cat <<'EOF' | sh\ngit push origin main\nEOF`)
    refuse(`cat <<EOF > notes.md\n$(gh pr merge 3)\nEOF`)
    passe(`cat <<'EOF' > notes.md\n$(gh pr merge 3)\nEOF`)
  })

  test('le refus dit quoi, nomme la branche refusée et liste les protégées (revue, point 9)', () => {
    const r = mergeDenial('git push origin develop', { defaut: 'develop' })!
    expect(r).toContain('git push vers develop')
    expect(r).toContain("réservés à l'utilisateur")
    const m = mergeDenial('git push origin master', { defaut: 'develop' })!
    expect(m).toContain('« git push vers master »')
    expect(m).toContain('(main, master, develop)')
    expect(mergeDenial('gh pr merge 3')!).toContain('« gh pr merge »')
  })

  test('jamais d’exception, commande vide ou non textuelle', () => {
    expect(mergeDenial('')).toBeUndefined()
    expect(mergeDenial(undefined as never)).toBeUndefined()
    expect(mergeDenial('   ')).toBeUndefined()
    expect(mergeDenial('"guillemet non fermé gh pr merge')).toBeUndefined()
  })

  test('segments : mots sans guillemets, séparateurs, échappements', () => {
    expect(segments(`a "b c" 'd e'; f\\ g && h|i`)).toEqual([['a', 'b c', 'd e'], ['f g'], ['h'], ['i']])
  })
})

describe('utilitaires', () => {
  test('dossiersDuPush : les cd et git -C avant le push, dans l’ordre ; inconnu après cd ~, cd - ou popd (revue, point 6)', () => {
    expect(dossiersDuPush('npm test')).toBeUndefined()
    expect(dossiersDuPush('gh pr merge 3')).toBeUndefined()
    expect(dossiersDuPush('git push')).toEqual({ dossiers: [], connu: true })
    expect(dossiersDuPush('cd ../app && git push')).toEqual({ dossiers: ['../app'], connu: true })
    expect(dossiersDuPush('cd a && cd b && git -C c push origin')).toEqual({ dossiers: ['a', 'b', 'c'], connu: true })
    expect(dossiersDuPush('(cd "../mon app" && git push)')).toEqual({ dossiers: ['../mon app'], connu: true })
    expect(dossiersDuPush('Set-Location -Path C:\\app; git push', 'powershell')).toEqual({ dossiers: ['C:\\app'], connu: true })
    expect(dossiersDuPush('cd ~/app && git push')).toEqual({ dossiers: [], connu: false })
    expect(dossiersDuPush('cd - && git push')).toEqual({ dossiers: [], connu: false })
    expect(dossiersDuPush('pushd x && popd && git push')).toEqual({ dossiers: ['x'], connu: false })
    // seul le premier push compte ; un cd après lui ne change rien
    expect(dossiersDuPush('git push -u origin f && cd ../b')).toEqual({ dossiers: [], connu: true })
  })

  test('brancheParDefaut : origin/main, refs/remotes/origin/develop, vide', () => {
    expect(brancheParDefaut('origin/main\n')).toBe('main')
    expect(brancheParDefaut('refs/remotes/origin/develop')).toBe('develop')
    expect(brancheParDefaut('upstream/release/2026')).toBe('release/2026')
    expect(brancheParDefaut('')).toBeUndefined()
  })
})
