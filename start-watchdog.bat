@echo off
REM korina 看门狗启动器
REM 从 oc 外部启动，双击此文件即可
REM
REM 看门狗会：
REM   1. 检测 oc 是否在线
REM   2. oc 不在线 -> 启动 oc
REM   3. 等 oc 插件泄露密码
REM   4. 读密码 + 启动 korina

cd /d "%~dp0"
node "watchdog\watchdog.mjs"
pause
