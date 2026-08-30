@echo off
cd /d "%~dp0"
echo 正在启动「错词本背单词」本地服务...
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  echo 未检测到 Node.js，尝试用 Python 启动...
  where python >nul 2>nul
  if %errorlevel%==0 (
    python -m http.server 8080
  ) else (
    echo 请先安装 Node.js 或 Python，再运行本脚本。
    pause
  )
)
