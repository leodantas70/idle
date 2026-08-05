'use strict';

// Atualizador da versao source. Ele nunca envia nada ao GitHub: apenas baixa o historico
// oficial e faz uma mesclagem de tres versoes pelo Git (base oficial + local + oficial nova).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const OFFICIAL_URL = 'https://github.com/soufoka/PokeGrid-source.git';
const OFFICIAL_REMOTE = 'pokegrid-oficial';
// Ultima versao oficial que foi mesclada manualmente neste projeto: PokeGrid 1.5.12.
const OFFICIAL_BASE = '79f40c0ac00f0fec790498a419585abd70dbfc94';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const normalizeUrl = (s) => String(s || '').trim().replace(/\/$/, '').replace(/\.git$/, '').toLowerCase();
const fileHash = (f) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; }
};

function runGit(cwd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
    }, (error, stdout, stderr) => resolve({
      ok: !error,
      code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
      stdout: String(stdout || '').trim(),
      stderr: String(stderr || '').trim(),
      error: error ? String(error.message || error) : ''
    }));
  });
}

function copyBackupTree(source, destination) {
  const ignoredDirs = new Set(['.git', 'node_modules', 'dist', '.teste-tmp']);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
    if (entry.isFile() && (/\.(?:zip|log)$/i.test(entry.name) || entry.name === '.update-needs-install')) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyBackupTree(from, to);
    else if (entry.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  }
}

function makeBackup(projectRoot, backupRoot) {
  const destination = path.join(backupRoot, 'antes-da-atualizacao-' + stamp());
  copyBackupTree(projectRoot, destination);
  return destination;
}

async function ensureLocalHistory(projectRoot, remoteUrl, baseCommit) {
  let probe = await runGit(projectRoot, ['rev-parse', '--is-inside-work-tree'], 15000);
  const inside = probe.ok && probe.stdout === 'true';
  if (!inside) {
    const init = await runGit(projectRoot, ['init'], 30000);
    if (!init.ok) throw new Error('Não foi possível iniciar o histórico local: ' + (init.stderr || init.error));
  }
  // Um download interrompido pode deixar a pasta .git criada, mas ainda sem commit/base.
  // Nesse caso o próximo clique precisa concluir a preparação, não tratar o repositório vazio como pronto.
  const head = await runGit(projectRoot, ['rev-parse', '--verify', 'HEAD'], 15000);
  const fresh = !head.ok;
  await runGit(projectRoot, ['config', 'user.name', 'PokeGrid Atualizador Local'], 15000);
  await runGit(projectRoot, ['config', 'user.email', 'atualizador@pokegrid.local'], 15000);

  const remotes = await runGit(projectRoot, ['remote'], 15000);
  const names = remotes.ok ? remotes.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (!names.includes(OFFICIAL_REMOTE)) {
    const add = await runGit(projectRoot, ['remote', 'add', OFFICIAL_REMOTE, remoteUrl], 15000);
    if (!add.ok) throw new Error('Não foi possível registrar o repositório oficial: ' + (add.stderr || add.error));
  } else {
    const got = await runGit(projectRoot, ['remote', 'get-url', OFFICIAL_REMOTE], 15000);
    if (!got.ok || normalizeUrl(got.stdout) !== normalizeUrl(remoteUrl)) {
      throw new Error('O endereço salvo para o repositório oficial é diferente do esperado. Nenhum arquivo foi alterado.');
    }
  }

  if (fresh) {
    const fetchBase = await runGit(projectRoot, ['fetch', '--no-tags', OFFICIAL_REMOTE, baseCommit], 180000);
    if (!fetchBase.ok) throw new Error('Não foi possível baixar a versão oficial de base: ' + (fetchBase.stderr || fetchBase.error));
    const reset = await runGit(projectRoot, ['reset', '--mixed', 'FETCH_HEAD'], 30000);
    if (!reset.ok) throw new Error('Não foi possível preparar a base da mesclagem: ' + (reset.stderr || reset.error));
  }
}

async function commitLocalChanges(projectRoot) {
  const add = await runGit(projectRoot, ['add', '-A'], 30000);
  if (!add.ok) throw new Error('Não foi possível preparar as personalizações locais: ' + (add.stderr || add.error));
  const pending = await runGit(projectRoot, ['diff', '--cached', '--quiet'], 15000);
  if (pending.ok) return false;
  const commit = await runGit(projectRoot, ['commit', '-m', 'Personalizações locais antes da atualização oficial'], 60000);
  if (!commit.ok) throw new Error('Não foi possível salvar as personalizações no histórico local: ' + (commit.stderr || commit.error));
  return true;
}

async function applyOfficialUpdate(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const backupRoot = path.resolve(options.backupRoot);
  const remoteUrl = options.remoteUrl || OFFICIAL_URL;
  const baseCommit = options.baseCommit || OFFICIAL_BASE;
  if (!fs.existsSync(path.join(projectRoot, 'package.json')) || !fs.existsSync(path.join(projectRoot, 'index.html'))) {
    return { ok:false, kind:'invalid-project', message:'A pasta do PokeGrid não foi reconhecida.' };
  }

  let backup = '';
  try {
    backup = makeBackup(projectRoot, backupRoot);
    const gitVersion = await runGit(projectRoot, ['--version'], 15000);
    if (!gitVersion.ok) return { ok:false, kind:'git-missing', backup, message:'Git não foi encontrado neste computador.' };

    await ensureLocalHistory(projectRoot, remoteUrl, baseCommit);
    await commitLocalChanges(projectRoot);

    const beforeLock = fileHash(path.join(projectRoot, 'package-lock.json'));
    const beforePackage = fileHash(path.join(projectRoot, 'package.json'));
    const fetchNew = await runGit(projectRoot, ['fetch', '--no-tags', OFFICIAL_REMOTE, 'main'], 180000);
    if (!fetchNew.ok) return { ok:false, kind:'network', backup, message:'Não foi possível baixar a atualização: ' + (fetchNew.stderr || fetchNew.error) };
    const sha = await runGit(projectRoot, ['rev-parse', 'FETCH_HEAD'], 15000);
    const already = await runGit(projectRoot, ['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD'], 15000);
    if (already.ok) return { ok:true, updated:false, backup, commit:sha.stdout, files:[], message:'Você já está com a versão oficial mais recente.' };

    const merge = await runGit(projectRoot, ['merge', '--no-edit', '--no-ff', 'FETCH_HEAD'], 180000);
    if (!merge.ok) {
      const unresolved = await runGit(projectRoot, ['diff', '--name-only', '--diff-filter=U'], 15000);
      const files = unresolved.stdout.split(/\r?\n/).filter(Boolean);
      await runGit(projectRoot, ['merge', '--abort'], 30000);
      return {
        ok:false,
        kind:'conflict',
        backup,
        commit:sha.stdout,
        files,
        message:'A atualização também alterou uma parte personalizada. Sua versão foi mantida sem marcadores de conflito.'
      };
    }

    const changed = await runGit(projectRoot, ['diff', '--name-only', 'HEAD^1', 'HEAD'], 15000);
    const files = changed.stdout.split(/\r?\n/).filter(Boolean);
    const afterLock = fileHash(path.join(projectRoot, 'package-lock.json'));
    const afterPackage = fileHash(path.join(projectRoot, 'package.json'));
    const needsInstall = beforeLock !== afterLock || beforePackage !== afterPackage;
    if (needsInstall) fs.writeFileSync(path.join(projectRoot, '.update-needs-install'), '1\n');
    return { ok:true, updated:true, backup, commit:sha.stdout, files, needsInstall, message:'Atualização oficial mesclada sem apagar as personalizações.' };
  } catch (e) {
    return { ok:false, kind:'error', backup, message:String((e && e.message) || e) };
  }
}

module.exports = { applyOfficialUpdate, OFFICIAL_URL, OFFICIAL_BASE, _test:{ runGit, makeBackup } };
