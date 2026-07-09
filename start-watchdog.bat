@echo off
REM furina 看门狗启动器
REM 从 oc 外部启动，双击此文件即可
REM
REM 看门狗会：
REM   1. 检测 oc 是否在线
REM   2. oc 不在线 -> 启动 oc
REM   3. 等 oc 插件泄露密码
REM   4. 读密码 + 启动 furina

cd /d "C:\Users\33647\Desktop\大宗\furina"
python "watchdog\watchdog.py"
pause
