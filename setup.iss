#define MyAppName "DeepSeek Harness"
; 版本号：本地默认值，CI 上用 /DMyAppVersion= 覆盖（与标签保持一致）
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#define MyAppExeName "DeepSeekHarness.exe"
; 项目根路径：默认取本脚本所在目录（即仓库根），CI 上用 /DProjectDir= 覆盖
#ifndef ProjectDir
  #define ProjectDir RemoveBackslash(SourcePath)
#endif
#define AppDirSource ProjectDir + "\build\DeepSeekHarnessApp"

[Setup]
AppId={{B4C9B9C2-9C41-4F8E-8A0C-3DEE42D99C01}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=DeepSeek AI
AppPublisherURL=https://github.com/deepseek-ai/deepseek-harness
AppSupportURL=https://github.com/deepseek-ai/deepseek-harness
; 安装到短目录(去空格),降低嵌套路径总长(DSH node_modules 深层文件,防 260 字符限制)
DefaultDirName={localappdata}\Programs\DshHarness
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#ProjectDir}\installers
OutputBaseFilename=DeepSeekHarnessSetup-{#MyAppVersion}
SetupIconFile={#ProjectDir}\build\app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Registry]
; 启用 Windows 长路径支持(LongPathsEnabled=1),根治 DSH 深层 node_modules 的 260 字符限制
; 需重启生效;HKLM 需管理员,非管理员安装时由 [Code] 提示(见下方)
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\FileSystem"; ValueType: dword; ValueName: "LongPathsEnabled"; ValueData: "1"; Flags: uninsdeletevalue; Check: IsAdminLoggedOn

[Code]
// 非管理员安装时提示启用长路径(否则 DSH 深层文件可能因 260 字符限制装不上)
function InitializeSetup(): Boolean;
begin
  Result := True;
  if not IsAdminLoggedOn() then
    MsgBox('建议以管理员身份运行安装程序,以便自动启用 Windows 长路径支持(DSH 含深层文件)。' + #13#10 +
           '如不启用,安装可能因路径过长(260字符限制)失败。', mbInformation, MB_OK);
end;

[Languages]
; 中文语言文件打进仓库（lang/），避免不同 Inno 版本目录差异
Name: "chinesesimplified"; MessagesFile: "{#SourcePath}lang\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#AppDirSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ProjectDir}\build\app.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\app.ico"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\app.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; 卸载前停掉应用及 harness 进程树（防 node 孤儿占住 3080、文件被占用删不掉）
Filename: "taskkill"; Parameters: "/IM {#MyAppExeName} /T /F"; Flags: runhidden; RunOnceId: "StopApp"
