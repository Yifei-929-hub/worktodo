; 只为当前用户安装，不显示“为所有人安装”的选择页
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; 打包工具会为自动更新在用户电脑上另存一份安装包；没有自动更新，删除它
!macro removeInstallerCopy
  Delete "$LOCALAPPDATA\worktodo-updater\installer.exe"
  RMDir "$LOCALAPPDATA\worktodo-updater"
!macroend

!macro customInstall
  !insertmacro removeInstallerCopy
!macroend

!ifdef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh
  Var KeepRadio
  Var DropRadio
  Var DropData

  ; 卸载时选择是否保留数据；默认保留，选择删除时再确认一次
  Function un.DataPage
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "将卸载 WorkTodo。是否保留您的待办、日志和自动备份？"
    Pop $0
    ${NSD_CreateRadioButton} 0 32u 100% 12u "保留数据（以后重新安装仍可使用）"
    Pop $KeepRadio
    ${NSD_CreateRadioButton} 0 50u 100% 12u "不保留，删除全部数据"
    Pop $DropRadio
    ${NSD_CreateLabel} 12u 66u 100% 24u "您自行导出到其他位置的备份文件不受影响。"
    Pop $0
    ${If} $DropData == "1"
      ${NSD_Check} $DropRadio
    ${Else}
      ${NSD_Check} $KeepRadio
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function un.DataPageLeave
    StrCpy $DropData "0"
    ${NSD_GetState} $DropRadio $0
    ${If} $0 == ${BST_CHECKED}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "确定删除全部待办、日志和自动备份？此操作无法撤销。" IDYES confirmed
      Abort
      confirmed:
      StrCpy $DropData "1"
    ${EndIf}
  FunctionEnd

  !macro customUnWelcomePage
    UninstPage custom un.DataPage un.DataPageLeave
  !macroend

  ; 静默卸载（包括覆盖安装时自动卸载旧版）一律保留数据
  !macro customUnInstall
    !insertmacro removeInstallerCopy
    ${IfNot} ${Silent}
    ${AndIf} $DropData == "1"
      SetShellVarContext current
      RMDir /r "$APPDATA\${PRODUCT_NAME}"
    ${EndIf}
  !macroend
!endif
