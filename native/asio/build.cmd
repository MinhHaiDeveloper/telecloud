@echo off
rem Builds native\asio\bin\tc-asio.exe with the Visual Studio C++ build tools (x64).
setlocal
set "HERE=%~dp0"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%TEMP%\tc-asio-vs.txt"
set /p VSPATH=<"%TEMP%\tc-asio-vs.txt"
del "%TEMP%\tc-asio-vs.txt"
if "%VSPATH%"=="" goto novs
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
if not exist "%HERE%bin" mkdir "%HERE%bin"
if not exist "%HERE%obj" mkdir "%HERE%obj"
cl /nologo /O2 /EHsc /MT /W3 /DWIN32 /D_CRT_SECURE_NO_WARNINGS /I"%HERE%sdk" /Fo"%HERE%obj\\" /Fe"%HERE%bin\tc-asio.exe" "%HERE%tc-asio.cpp" "%HERE%sdk\asio.cpp" "%HERE%sdk\asiodrivers.cpp" "%HERE%sdk\asiolist.cpp" ole32.lib user32.lib advapi32.lib || exit /b 1
echo Built %HERE%bin\tc-asio.exe
exit /b 0
:novs
echo Visual Studio C++ build tools not found
exit /b 1
