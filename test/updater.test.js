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
    write(official, 'notas.txt', 'nota base\n');
    const bootCheck = "'use strict';\nconst fs=require('fs'),path=require('path');\nconst html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');\nif(html.includes('linha 5 PRIVADA')&&html.includes('linha 5 OFICIAL')) process.exit(1);\n";
    write(official, 'test/boot.test.js', bootCheck);
    git(official, ['add', '-A']); git(official, ['commit', '-m', 'base']);
    const base = git(official, ['rev-parse', 'HEAD']);

    // A pasta local começa na base, mas com uma linha privada diferente.
    write(local, 'index.html', original.replace('linha 2', 'linha 2 PERSONALIZADA'));
    write(local, 'package.json', '{"name":"teste","version":"1.0.0"}\n');
    write(local, '.gitignore', 'node_modules/\n*.log\n.update-needs-install\n');
    write(local, 'notas.txt', 'nota base\n');
    write(local, 'test/boot.test.js', bootCheck);
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

    // Conflito de texto simples: as duas linhas cabem juntas e devem ser conservadas.
    write(local, 'notas.txt', 'nota PERSONALIZADA\n');
    write(official, 'notas.txt', 'nota OFICIAL NOVA\n');
    git(official, ['add', '-A']); git(official, ['commit', '-m', 'oficial para uniao']);
    const union = await applyOfficialUpdate({ projectRoot:local, backupRoot:backups, remoteUrl:official, baseCommit:base });
    const afterUnion = fs.readFileSync(path.join(local, 'notas.txt'), 'utf8');
    ok(union.ok && union.autoCombined, 'trechos sobrepostos compatíveis são unidos automaticamente');
    ok(afterUnion.includes('nota PERSONALIZADA') && afterUnion.includes('nota OFICIAL NOVA'), 'união mantém o trecho local e acrescenta o oficial');

    // Código conflitante que não funciona junto: conserva apenas esse bloco local, mas traz
    // as outras novidades oficiais do mesmo arquivo em vez de cancelar toda a atualização.
    const localConflict = afterMerge.replace('linha 5', 'linha 5 PRIVADA');
    write(local, 'index.html', localConflict);
    write(official, 'index.html', fs.readFileSync(path.join(official, 'index.html'), 'utf8')
      .replace('linha 5', 'linha 5 OFICIAL')
      .replace('linha 10', 'linha 10 OFICIAL SEGURA'));
    git(official, ['add', '-A']); git(official, ['commit', '-m', 'oficial conflitante']);
    const conflict = await applyOfficialUpdate({ projectRoot:local, backupRoot:backups, remoteUrl:official, baseCommit:base });
    const afterConflict = fs.readFileSync(path.join(local, 'index.html'), 'utf8');
    ok(conflict.ok && conflict.updated && conflict.keptLocalSections, 'conflito incompatível não cancela toda a atualização');
    ok(afterConflict.includes('linha 5 PRIVADA') && !afterConflict.includes('linha 5 OFICIAL'), 'somente o pequeno bloco incompatível mantém a versão local');
    ok(afterConflict.includes('linha 10 OFICIAL SEGURA'), 'novidade oficial fora do bloco conflitante é adicionada');
    ok(!afterConflict.includes('<<<<<<<'), 'nenhum marcador de conflito é deixado no projeto');

    // Simula internet caindo depois de "git init": existe .git, mas ainda não existe HEAD.
    const partial = path.join(temp, 'parcial'); fs.mkdirSync(partial);
    write(partial, 'index.html', original);
    write(partial, 'package.json', '{"name":"teste","version":"1.0.0"}\n');
    write(partial, '.gitignore', 'node_modules/\n*.log\n.update-needs-install\n');
    write(partial, 'notas.txt', 'nota base\n');
    write(partial, 'test/boot.test.js', bootCheck);
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
