'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { applyOfficialUpdate } = require('../src/updater');

let failures = 0;
const ok = (condition, label) => { console.log((condition ? 'ok   ' : 'FALHA') + ' ' + label); if (!condition) failures++; };
const git = (cwd, args) => execFileSync('git', args, { cwd, windowsHide:true, encoding:'utf8', stdio:['ignore', 'pipe', 'pipe'] }).trim();
const write = (root, name, text) => { const f = path.join(root, name); fs.mkdirSync(path.dirname(f), { recursive:true }); fs.writeFileSync(f, text); };

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pokegrid-updater-test-'));
  const official = path.join(temp, 'official');
  const local = path.join(temp, 'local');
  const backups = path.join(temp, 'backups');
  try {
    fs.mkdirSync(official); fs.mkdirSync(local); fs.mkdirSync(backups);
    git(official, ['init', '-b', 'main']);
    git(official, ['config', 'user.name', 'Teste']);
    git(official, ['config', 'user.email', 'teste@local.invalid']);
    const original = ['linha 1','linha 2','linha 3','linha 4','linha 5','linha 6','linha 7','linha 8','linha 9','linha 10'].join('\n') + '\n';
    write(official, 'index.html', original);
    write(official, 'package.json', '{"name":"teste","version":"1.0.0"}\n');
    write(official, '.gitignore', 'node_modules/\n*.log\n.update-needs-install\n');
    git(official, ['add', '-A']); git(official, ['commit', '-m', 'base']);
    const base = git(official, ['rev-parse', 'HEAD']);

    // A pasta local começa na base, mas com uma linha privada diferente.
    write(local, 'index.html', original.replace('linha 2', 'linha 2 PERSONALIZADA'));
    write(local, 'package.json', '{"name":"teste","version":"1.0.0"}\n');
    write(local, '.gitignore', 'node_modules/\n*.log\n.update-needs-install\n');
    write(local, 'somente-local.txt', 'privado\n');
    write(official, 'index.html', original.replace('linha 9', 'linha 9 OFICIAL NOVA'));
    write(official, 'package.json', '{"name":"teste","version":"1.1.0"}\n');
    git(official, ['add', '-A']); git(official, ['commit', '-m', 'oficial compativel']);

    const merged = await applyOfficialUpdate({ projectRoot:local, backupRoot:backups, remoteUrl:official, baseCommit:base });
    const afterMerge = fs.readFileSync(path.join(local, 'index.html'), 'utf8');
    ok(merged.ok && merged.updated, 'atualização compatível é aplicada');
    ok(afterMerge.includes('linha 2 PERSONALIZADA'), 'personalização local é preservada');
    ok(afterMerge.includes('linha 9 OFICIAL NOVA'), 'novidade oficial é adicionada');
    ok(fs.existsSync(path.join(local, 'somente-local.txt')), 'arquivo somente local permanece');
    ok(merged.backup && fs.existsSync(merged.backup), 'backup é criado antes da mesclagem');
    ok(merged.needsInstall && fs.existsSync(path.join(local, '.update-needs-install')), 'mudança de dependências agenda instalação no próximo início');

    // Agora os dois lados alteram a mesma linha. O atualizador deve abortar e deixar o local intacto.
    const localConflict = afterMerge.replace('linha 5', 'linha 5 PRIVADA');
    write(local, 'index.html', localConflict);
    write(official, 'index.html', fs.readFileSync(path.join(official, 'index.html'), 'utf8').replace('linha 5', 'linha 5 OFICIAL'));
    git(official, ['add', '-A']); git(official, ['commit', '-m', 'oficial conflitante']);
    const conflict = await applyOfficialUpdate({ projectRoot:local, backupRoot:backups, remoteUrl:official, baseCommit:base });
    ok(!conflict.ok && conflict.kind === 'conflict', 'conflito na mesma parte é recusado');
    ok(fs.readFileSync(path.join(local, 'index.html'), 'utf8') === localConflict, 'arquivo personalizado fica intacto após conflito');
    ok(!fs.readFileSync(path.join(local, 'index.html'), 'utf8').includes('<<<<<<<'), 'nenhum marcador de conflito é deixado no projeto');

    // Simula internet caindo depois de "git init": existe .git, mas ainda não existe HEAD.
    const partial = path.join(temp, 'parcial'); fs.mkdirSync(partial);
    write(partial, 'index.html', original);
    write(partial, 'package.json', '{"name":"teste","version":"1.0.0"}\n');
    write(partial, '.gitignore', 'node_modules/\n*.log\n.update-needs-install\n');
    git(partial, ['init']);
    const resumed = await applyOfficialUpdate({ projectRoot:partial, backupRoot:backups, remoteUrl:official, baseCommit:base });
    ok(resumed.ok && fs.readFileSync(path.join(partial, 'index.html'), 'utf8').includes('linha 5 OFICIAL'), 'preparação interrompida é retomada no próximo clique');
  } catch (e) {
    console.error(e && e.stack || e); failures++;
  } finally {
    try { fs.rmSync(temp, { recursive:true, force:true }); } catch {}
  }
  console.log(failures ? '\n' + failures + ' falha(s)' : '\nAtualizador: tudo certo');
  process.exit(failures ? 1 : 0);
})();
