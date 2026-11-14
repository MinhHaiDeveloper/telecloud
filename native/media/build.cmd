@echo off
rem Builds native\media\bin\tc-media.exe (Windows media controls) with the Visual Studio C++ build tools (x64).
rem   build.cmd           TeleCloud
rem   build.cmd beta      TeleCloud Beta
rem Windows' media controls name an app by its exe's description and icon, so the helper carries the app's.
setlocal
set "HERE=%~dp0"
set "NAME=TeleCloud"
set "ICON=%HERE%..\..\public\icon.ico"
if /i "%~1"=="beta" (
  set "NAME=TeleCloud Beta"
  set "ICON=%HERE%..\..\public\icon-beta.ico"
)
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%TEMP%\tc-media-vs.txt"
set /p VSPATH=<"%TEMP%\tc-media-vs.txt"
del "%TEMP%\tc-media-vs.txt"
if "%VSPATH%"=="" goto novs
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
if not exist "%HERE%bin" mkdir "%HERE%bin"
if not exist "%HERE%obj" mkdir "%HERE%obj"
copy /y "%ICON%" "%HERE%obj\app.ico" >nul || exit /b 1
> "%HERE%obj\tc-media.rc" (
  echo 1 ICON "app.ico"
  echo 1 VERSIONINFO
  echo FILEVERSION 1,0,0,0
  echo PRODUCTVERSION 1,0,0,0
  echo FILEFLAGSMASK 0x3fL
  echo FILEFLAGS 0x0L
  echo FILEOS 0x40004L
  echo FILETYPE 0x1L
  echo FILESUBTYPE 0x0L
  echo BEGIN
  echo   BLOCK "StringFileInfo"
  echo   BEGIN
  echo     BLOCK "040904b0"
  echo     BEGIN
  echo       VALUE "CompanyName", "TeleCloud"
  echo       VALUE "FileDescription", "%NAME%"
  echo       VALUE "ProductName", "%NAME%"
  echo       VALUE "InternalName", "tc-media"
  echo       VALUE "OriginalFilename", "tc-media.exe"
  echo     END
  echo   END
  echo   BLOCK "VarFileInfo"
  echo   BEGIN
  echo     VALUE "Translation", 0x409, 1200
  echo   END
  echo END
)
pushd "%HERE%obj"
rc /nologo /fo tc-media.res tc-media.rc || (popd & exit /b 1)
popd
cl /nologo /O2 /EHsc /MT /W3 /std:c++20 /permissive- /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /Fo"%HERE%obj\\" /Fe"%HERE%bin\tc-media.exe" "%HERE%tc-media.cpp" "%HERE%obj\tc-media.res" windowsapp.lib ole32.lib user32.lib shell32.lib propsys.lib /link /SUBSYSTEM:CONSOLE || exit /b 1
echo Built %HERE%bin\tc-media.exe as %NAME%
exit /b 0
:novs
echo Visual Studio C++ build tools not found
exit /b 1
