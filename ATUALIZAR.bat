@echo off
setlocal
title Atualizar PokeGrid Leo
cd /d "%~dp0"

echo ========================================
echo       ATUALIZADOR POKEGRID LEO
echo ========================================
echo.
echo Buscando a versao mais recente do seu GitHub...

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERRO: Git nao foi encontrado neste computador.
  echo Instale o Git e tente novamente.
  pause
  exit /b 1
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin https://github.com/leodantas70/idle.git
) else (
  git remote set-url origin https://github.com/leodantas70/idle.git
)
if errorlevel 1 goto :erro

git fetch --prune origin master
if errorlevel 1 goto :erro

echo.
echo Substituindo todos os arquivos pela versao do GitHub...
git reset --hard origin/master
if errorlevel 1 goto :erro

git clean -fdx
if errorlevel 1 goto :erro

echo.
echo Instalando as dependencias da versao atualizada...
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo AVISO: npm nao foi encontrado. Os arquivos foram atualizados,
  echo mas sera necessario instalar o Node.js para iniciar o programa.
  goto :fim
)

call npm.cmd ci
if errorlevel 1 goto :erro

:fim
echo.
echo ========================================
echo   ATUALIZACAO CONCLUIDA COM SUCESSO!
echo ========================================
echo Voce ja pode abrir o PokeGrid.
pause
exit /b 0

:erro
echo.
echo ========================================
echo        A ATUALIZACAO FALHOU
echo ========================================
echo Confira sua internet e tente novamente.
echo Nenhuma versao incompleta sera iniciada automaticamente.
pause
exit /b 1
