#!/usr/bin/env bash
# ============================================================
# github-accelerator v1.4.0 —— 诊断驱动的小白 GitHub 加速器 (macOS / Linux)
# 纯 bash 零依赖（兼容 macOS 自带 bash 3.2）
#
# 子命令:
#   check     只诊断不修改（无需管理员权限）
#   apply     诊断 + 写入 hosts + git/SSH 兜底（需 root；授权弹窗由 Agent 负责触发）
#   rollback  回滚到最近的备份并清理 git/SSH 配置（hosts 部分需 root）
#   status    查看当前配置与连通性
#   watt      一键下载安装 Watt Toolkit（需先征得用户同意；macOS 全自动，其余平台给指引）
#
# 设计原则:
#   1. 什么都不预设——每个域名、每个 IP、每个镜像都在用户本机运行时实测
#   2. 只写入实测通过的 hosts 条目（不盲信任何上游源）
#   3. hosts 修改仅限标记块内，绝不触碰用户其他内容；写入前自动备份（保留 3 份）
#   4. 全灭时诚实报告死因，不假装修复成功
#
# 测试钩子: 环境变量 HOSTS_FILE 可重定向 hosts 路径（供 dry-run 测试用）
# ============================================================

VERSION="1.4.1"
MARK_START="# GitHub-Accelerator Start"
MARK_END="# GitHub-Accelerator End"
MARK_SSH_START="# GitHub-Accelerator SSH Start"
MARK_SSH_END="# GitHub-Accelerator SSH End"
HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"
# 测试钩子: 可重定向 ssh config 路径（供 dry-run 测试用）
SSH_CONFIG_FILE="${SSH_CONFIG_FILE:-$HOME/.ssh/config}"
BACKUP_KEEP=3
UA="Mozilla/5.0 (compatible; GitHub-Accelerator/$VERSION)"
CURL_TIMEOUT=6
LOCK_DIR="${TMPDIR:-/tmp}/github-accelerator.lock"

# 关键: 切到 / 再干活。macOS 上 osascript 以 root 运行时，若 cwd 位于
# TCC 保护区(如 ~/Desktop)，git getcwd 都会 fatal，相对路径操作也不可靠
cd /

# 单实例锁: 防止并发 apply/rollback 交错写 hosts 导致内容丢失
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # 超过 10 分钟的锁视为僵尸锁，清理后重试
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +10 2>/dev/null)" ] && rmdir "$LOCK_DIR" 2>/dev/null && mkdir "$LOCK_DIR" 2>/dev/null; then
    :
  else
    printf '%s\n' "错误: 另一个实例正在运行，请稍后再试"
    exit 1
  fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# 需要修复的域名清单（GitHub 核心系）
DOMAINS="github.com api.github.com codeload.github.com gist.github.com raw.githubusercontent.com gist.githubusercontent.com objects.githubusercontent.com avatars.githubusercontent.com camo.githubusercontent.com user-images.githubusercontent.com cloud.githubusercontent.com desktop.githubusercontent.com"
# v1.4.1 同组边缘分组: 下列域名由同一批边缘节点服务（同 IP 池，靠 SNI 区分站点）。
# 某域名自身候选全灭时，可复用同组其他域名"已实测通过"的 IP（复用前仍需对该域名实测通过才写入）。
#   gh 组    = GitHub 自营边缘（github.com / api / codeload / gist / ssh.github.com 同一批 IP）
#   fastly 组 = Fastly CDN 边缘（*.githubusercontent.com 共用 .133 四胞胎等同一批 IP）
GH_EDGE="github.com api.github.com codeload.github.com gist.github.com ssh.github.com"
FASTLY_EDGE="raw.githubusercontent.com gist.githubusercontent.com objects.githubusercontent.com avatars.githubusercontent.com camo.githubusercontent.com user-images.githubusercontent.com cloud.githubusercontent.com desktop.githubusercontent.com"
# Fastly 系（.133 四胞胎大概率可用）
FASTLY_POOL="185.199.108.133 185.199.109.133 185.199.110.133 185.199.111.133"
# GitHub 官方已知网段候选（github.com / api / codeload 等）
GH_POOL="140.82.112.3 140.82.112.4 140.82.113.3 140.82.113.4 140.82.114.3 140.82.114.4 140.82.116.3 140.82.116.4 140.82.121.3 140.82.121.4 140.82.122.3 140.82.122.4 20.205.243.166 20.205.243.168 20.27.177.113 20.200.245.247"
# 镜像候选（URL 前缀拼接风格统一为: 镜像/完整原始URL）
MIRRORS="https://ghfast.top https://gh-proxy.com https://ghproxy.net https://ghproxy.cc https://github.moeyy.xyz https://ghps.cc"
# 镜像测速用的真实小文件（约 2.5KB）
MIRROR_TEST_PATH="/https://raw.githubusercontent.com/521xueweihan/GitHub520/main/hosts"
# DoH 服务器（国内必可达，绕过本地 DNS 污染拿真实 IP）
DOH_A="https://223.5.5.5/resolve"
DOH_B="https://1.12.12.12/resolve"

c() { curl --noproxy '*' -s -A "$UA" "$@"; }

# 沙箱代理检测: WorkBuddy 等 Agent 的 Bash 沙箱会向命令注入 127.0.0.1 本地代理，
# git/curl 等默认服从该代理，可能导致"hosts 修好了但沙箱里 Agent 的 git 仍不通"
SANDBOX_PROXY=""
for _pv in https_proxy HTTPS_PROXY http_proxy HTTP_PROXY; do
  _pval=$(printenv "$_pv" 2>/dev/null)
  case "$_pval" in
    http://127.0.0.1:*|http://localhost:*) SANDBOX_PROXY="$_pval"; break ;;
  esac
done

# 经指定代理测试域名（模拟 Agent 默认路径）
domain_ok_via() {
  local code
  code=$(curl -s -x "$2" -A "$UA" -m "$CURL_TIMEOUT" -o /dev/null -w '%{http_code}' "https://$1/" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

log()  { printf '%s\n' "$*"; }
hr()   { printf '%s\n' "------------------------------------------------------------"; }

# 域名直连测试: 返回 0 = 可达（任何 2xx/3xx/4xx HTTP 响应都算活着）
# 用法: domain_ok <domain>
domain_ok() {
  local code
  code=$(c -m "$CURL_TIMEOUT" -o /dev/null -w '%{http_code}' "https://$1/" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

# 指定 IP 测试域名: 用 --resolve 模拟 hosts，不动系统
# 用法: ip_ok <domain> <ip>
ip_ok() {
  local code
  code=$(c -m "$CURL_TIMEOUT" -o /dev/null -w '%{http_code}' --resolve "$1:443:$2" "https://$1/" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

# TCP 端口测试
tcp_ok() {
  nc -z -G 5 "$1" "$2" >/dev/null 2>&1
}

# SSH 认证状态（v1.3.0）: 0=已认证可用, 1=通道可达但无有效密钥, 2=通道不通
# GitHub 连公开仓库的 SSH 克隆也要认证，所以"通道活着"不等于"能用"
ssh_auth_state() {
  local out
  if tcp_ok github.com 22; then
    out=$(ssh -T -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=6 git@github.com 2>&1)
  elif tcp_ok ssh.github.com 443; then
    out=$(ssh -T -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=6 -p 443 git@ssh.github.com 2>&1)
  else
    return 2
  fi
  case "$out" in
    *"successfully authenticated"*|*"Hi "*) return 0 ;;
    *"Permission denied"*) return 1 ;;
    *) return 2 ;;
  esac
}

# 多源拉取某域名的候选 IP（去重）:
#   源1: GitHub520 hosts（国内直连源）
#   源2: 阿里 DoH / DNSPod DoH（绕过本地 DNS 污染）
#   源3: 硬编码候选池（按域名归属选池）
# 用法: candidates_for <domain>
candidates_for() {
  local d="$1" pool="" line ips=""
  # 源1: GitHub520
  line=$(c -m 10 "https://raw.hellogithub.com/hosts" 2>/dev/null | grep -E "^[0-9a-fA-F.:]+[[:space:]]+$d([[:space:]]|\$)" | head -1 | awk '{print $1}')
  [ -n "$line" ] && ips="$line"
  # 源2: DoH（两家，哪家活着用哪家）
  for doh in "$DOH_A" "$DOH_B"; do
    local ans
    ans=$(c -m 6 "$doh?name=$d&type=A" 2>/dev/null | grep -o '"data":"[0-9.]*"' | cut -d'"' -f4)
    for ip in $ans; do
      case " $ips " in *" $ip "*) ;; *) ips="$ips $ip";; esac
    done
  done
  # 源3: 硬编码池
  case "$d" in
    *githubusercontent.com|*.github.io) pool="$FASTLY_POOL" ;;
    *) pool="$GH_POOL" ;;
  esac
  for ip in $pool; do
    case " $ips " in *" $ip "*) ;; *) ips="$ips $ip";; esac
  done
  echo $ips
}

# ============ v1.4.1 同组边缘 IP 复用 ============
# 背景反馈: 有用户网络下 gist.github.com 自身候选全灭，但同组的 github.com 明明有可用 IP。
# gist 与 github.com 是同一批边缘节点，SNI 不同而已，理应共享可用 IP（复用前仍需对该域名实测通过）。
# 实现: 登记表 PASSED_<域名> 只记录"自身候选命中"的 IP；
# 某域名自身候选全灭时，逐个尝试同组兄弟域名登记过的 IP。
# 注意: find_ips 通常在 $( ) 子壳里被调用，全局变量传不出来，
# 因此"是否复用"由调用方对比登记表判断（找到 IP 但该域名登记为空 = 复用）。
_group_of() {
  case " $GH_EDGE " in *" $1 "*) echo gh; return ;; esac
  case " $FASTLY_EDGE " in *" $1 "*) echo fastly; return ;; esac
  echo none
}

_record_passed() {
  local key; key=$(printf '%s' "$1" | tr '.' '_')
  local cur=""; cur=$(eval "printf '%s' \"\$PASSED_$key\"" 2>/dev/null)
  eval "PASSED_$key=\"\$cur \$2\""
}

_passed_ips() {
  local key; key=$(printf '%s' "$1" | tr '.' '_')
  eval "printf '%s' \"\$PASSED_$key\"" 2>/dev/null
}

# 收集某域名最多 N 个实测可用 IP（多 IP 冗余 + 同组复用兜底，抗线路抖动）
# 用法: find_ips <domain> <max>  → 每行一个 IP
find_ips() {
  local d="$1" max="$2" ip n=0 out="" grp sibling
  for ip in $(candidates_for "$d"); do
    if ip_ok "$d" "$ip"; then
      out="$out $ip"; n=$((n+1)); _record_passed "$d" "$ip"
      [ "$n" -ge "$max" ] && break
    fi
  done
  if [ "$n" -eq 0 ]; then
    grp=$(_group_of "$d")
    if [ "$grp" != "none" ]; then
      for sibling in $DOMAINS; do
        [ "$sibling" = "$d" ] && continue
        case "$grp" in
          gh)     case " $GH_EDGE " in *" $sibling "*) ;; *) continue ;; esac ;;
          fastly) case " $FASTLY_EDGE " in *" $sibling "*) ;; *) continue ;; esac ;;
        esac
        for ip in $(_passed_ips "$sibling"); do
          if ip_ok "$d" "$ip"; then
            out="$out $ip"; n=$((n+1))
            [ "$n" -ge "$max" ] && break
          fi
        done
        [ "$n" -ge "$max" ] && break
      done
    fi
  fi
  [ -n "$out" ] && printf '%s\n' $out
  return 0
}

# 为域名找到第一个实测可用 IP
# 用法: find_ip <domain>  → 输出 IP 或空
find_ip() {
  local ip
  ip=$(find_ips "$1" 1 | head -1)
  [ -n "$ip" ] && { echo "$ip"; return 0; }
  return 1
}

# 判断某域名的可用 IP 是否来自同组复用（找到 IP 但登记表为空）
_is_reused() {
  [ -n "$1" ] || return 1
  case " $(_passed_ips "$2") " in *" $1 "*) return 1 ;; esac
  return 0
}

# 镜像竞速: 返回第一个实测可用的镜像 URL（按列表顺序=按预期可靠度）
# 用法: find_mirror → 输出镜像 base URL 或空
find_mirror() {
  local m code
  for m in $MIRRORS; do
    code=$(c -m 10 -o /dev/null -w '%{http_code}' "$m$MIRROR_TEST_PATH" 2>/dev/null)
    if [ "$code" = "200" ]; then
      echo "$m"
      return 0
    fi
  done
  return 1
}

# ============ check（只诊断，无需 root）============
do_check() {
  log "GitHub-Accelerator v$VERSION —— 诊断报告（只读，未修改任何系统配置）"
  log "时间: $(date '+%F %T')    主机: $(uname -s) $(uname -m)"
  hr
  log "[1/4] 域名直连状态"
  local d ok_list="" bad_list="" pass ip
  for d in $DOMAINS; do
    if domain_ok "$d"; then
      ok_list="$ok_list $d"
      printf '  ✓ %-45s 直连正常\n' "$d"
    else
      bad_list="$bad_list $d"
      printf '  ✗ %-45s 直连失败\n' "$d"
    fi
  done
  hr
  # [1.5/4] Agent 沙箱环境双路检测（v1.1.2 新增）
  if [ -n "$SANDBOX_PROXY" ]; then
    log "[1.5/4] Agent 沙箱环境检测（检测到注入代理: $SANDBOX_PROXY）"
    if domain_ok_via github.com "$SANDBOX_PROXY"; then
      log "  · 沙箱代理路径: github.com 可通 → Agent 自己的 git/curl 可保留默认环境"
    else
      log "  · 沙箱代理路径: github.com 不通（沙箱代理拦截 GitHub，Agent 默认路径会失败）"
      if domain_ok github.com; then
        log "  · 对策: Agent 自己的 git/curl 操作必须绕开代理，命令前缀:"
        log "    env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY <命令>"
      else
        log "  · 直连与代理路径均不通 → 继续看下方 hosts/镜像修复"
      fi
    fi
    log "  · 注: hosts 修复对两条路径都生效（沙箱代理进程也使用本机系统解析）"
    hr
  fi
  log "[2/4] SSH 通道"
  if tcp_ok github.com 22; then log "  ✓ git@github.com:22 可通"; else log "  ✗ 22 端口不通"; fi
  if tcp_ok ssh.github.com 443; then log "  ✓ ssh.github.com:443 可通（SSH-over-443 兜底可用）"; else log "  ✗ ssh.github.com:443 不通"; fi
  if tcp_ok github.com 22 || tcp_ok ssh.github.com 443; then
    if ssh_auth_state; then
      log "  ✓ SSH 认证有效 → 若 HTTPS 全灭，apply 可启用 SSH-only 模式（git 全功能兜底）"
    else
      log "  ⚠ SSH 通道可达但未配置有效密钥（SSH 克隆需 GitHub 账号并添加公钥；否则 SSH 无法用于 git）"
    fi
  fi
  hr
  log "[3/4] 为失败域名寻找可用 IP（逐条实测，可能需要 1-2 分钟）"
  local fixable="" unfixable=""
  for d in $bad_list; do
    pass=""
    if ip=$(find_ip "$d"); then
      fixable="$fixable $d:$ip"
      if _is_reused "$ip" "$d"; then
        printf '  ✓ %-45s 可修复 → %s（复用同组域名已验证 IP）\n' "$d" "$ip"
      else
        printf '  ✓ %-45s 可修复 → %s\n' "$d" "$ip"
      fi
    else
      unfixable="$unfixable $d"
      printf '  ✗ %-45s 所有候选 IP 均不通（含同组复用尝试）\n' "$d"
    fi
  done
  hr
  log "[4/4] 镜像通道 + git 兜底判断"
  local mirror
  if mirror=$(find_mirror); then
    log "  ✓ 可用镜像: $mirror"
  else
    log "  ✗ 所有镜像均不可用"
  fi
  local insteadof_val
  insteadof_val=$(git config --global --get-regexp 'url\..*\.insteadof' 2>/dev/null || true)
  if [ -n "$insteadof_val" ]; then
    log "  - git insteadOf: 已配置"
  else
    log "  - git insteadOf: 未配置"
  fi
  if [ -f "$SSH_CONFIG_FILE" ] && grep -q "$MARK_SSH_START" "$SSH_CONFIG_FILE" 2>/dev/null; then
    log "  - SSH 兜底配置: 已配置"
  else
    log "  - SSH 兜底配置: 未配置"
  fi
  hr
  # 结论
  if [ -z "$bad_list" ]; then
    log "结论: 所有域名直连正常，无需任何修复。"
    return 0
  fi
  log "结论:"
  [ -n "$fixable" ] && log "  · ${fixable} 中的失败域名可通过写入 hosts 修复"
  [ -n "$unfixable" ] && log "  · $unfixable 无法通过 hosts 修复（候选 IP 全灭）"
  if [ -n "$unfixable" ]; then
    hr
    log "自救指引（这些域名已无法用 hosts/镜像修复时的合法加速方案）:"
    log "  推荐工具: Watt Toolkit（原 Steam++，开源免费、GitHub 官方在加速名单内，是国内合法网络优化工具，不是 VPN）"
    local _os; _os=$(uname -s)
    if [ "$_os" = "Darwin" ]; then
      log "  macOS 安装三步:"
      log "    1. 浏览器打开官网 https://steampp.net （国内直连）"
      log "    2. 点击「下载 macOS 版」下载 dmg，双击安装"
      log "    3. 打开软件 → 「网络加速」→ 勾选 GitHub → 点「一键加速」（推荐系统代理模式）"
    elif [ "$_os" = "Linux" ]; then
      log "  Linux 安装:"
      log "    1. 浏览器打开官网 https://steampp.net （国内直连），下载 Linux 版（x64/arm64 tgz）"
      log "    2. 打开软件 → 「网络加速」→ 勾选 GitHub → 点「一键加速」"
    else
      log "  Windows 安装三步:"
      log "    1. 打开「Microsoft Store」（微软商店），搜索 Watt Toolkit，点安装（Win10 17763+ 可装，官方上架）"
      log "    2. 商店打不开时: 浏览器打开官网 https://steampp.net 下载 x64 安装包安装"
      log "    3. 打开软件 → 「网络加速」→ 勾选 GitHub → 点「一键加速」（推荐系统代理模式）"
    fi
    log "  备用下载: Gitee 发行页 https://gitee.com/rmbgame/SteamTools/releases （国内直连）"
    log "  一键安装: 征得用户同意后，Agent 可直接运行 watt 子命令自动下载安装（macOS 全自动）"
    log "  注: 安装加速工具后建议重新运行本工具 check 复查，hosts 兜底可与加速工具并存。"
  fi
  log "执行 apply 前请用户确认。完整命令由 Agent 按引导执行。"
  return 0
}

# ============ hosts 标记块构建 ============
# v1.0.2: 对所有域名（不只失败域名）固定最多 3 个实测通过的 IP。
# 理由: 国内对 GitHub 的阻断/丢包是间歇性抖动的，直连此刻正常不代表 5 分钟后正常；
# hosts 同域名写多行时系统会依次尝试，形成自动备胎链。
# v1.4.1: 某域名自身候选全灭时，自动复用同组域名已实测通过的 IP（见 find_ips）。
MAX_IPS_PER_DOMAIN=3
build_block() {
  local d ip
  echo "$MARK_START"
  echo "# 由 github-accelerator v$VERSION 于 $(date '+%F %T') 写入"
  echo "# 每个域名最多 $MAX_IPS_PER_DOMAIN 个本机实测通过的 IP（多行=自动备胎）；重复运行会覆盖更新此块"
  for d in $DOMAINS; do
    for ip in $(find_ips "$d" "$MAX_IPS_PER_DOMAIN"); do
      printf '%-16s %s\n' "$ip" "$d"
    done
  done
  # ssh.github.com 兜底条目（22 被封但 443 活着时需要稳定解析）
  if ! tcp_ok github.com 22 && tcp_ok ssh.github.com 443; then
    for ip in $(find_ips "ssh.github.com" 1); do
      printf '%-16s %s\n' "$ip" "ssh.github.com"
    done
  fi
  echo "$MARK_END"
}

backup_hosts() {
  local ts bak
  ts=$(date +%Y%m%d-%H%M%S)
  bak="$HOSTS_FILE.ghacc.bak.$ts"
  cp -p "$HOSTS_FILE" "$bak" 2>/dev/null || { log "错误: 无法创建备份 $bak"; return 1; }
  log "已备份: $bak"
  # 只保留最近 BACKUP_KEEP 份
  ls -t "$HOSTS_FILE".ghacc.bak.* 2>/dev/null | tail -n +$((BACKUP_KEEP+1)) | while read -r old; do rm -f "$old"; done
  return 0
}

# ============ apply（需 root 或 HOSTS_FILE 重定向测试）============
do_apply() {
  if [ "$(id -u)" -ne 0 ] && [ "$HOSTS_FILE" = "/etc/hosts" ]; then
    log "错误: apply 需要管理员权限（root）。请通过授权弹窗或 sudo 运行。"
    exit 1
  fi
  [ -f "$HOSTS_FILE" ] || touch "$HOSTS_FILE"
  backup_hosts || exit 1

  # 生成新 hosts: 去掉旧标记块 + 追加新块（含内容保护，绝不丢用户原有内容）
  local orig_size tmp
  orig_size=$(wc -c < "$HOSTS_FILE" 2>/dev/null | tr -d ' ' || echo 0)
  tmp=$(mktemp) || { log "错误: 无法创建临时文件"; exit 1; }
  awk -v s="$MARK_START" -v e="$MARK_END" '
    index($0, s) == 1 { inblk=1; next }
    index($0, e) == 1 { inblk=0; next }
    !inblk { print }
  ' "$HOSTS_FILE" > "$tmp" 2>/dev/null
  # 内容保护: 原文件非空但 awk 输出为空 → 读取异常，拒绝写入
  if [ "$orig_size" -gt 0 ] && [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    log "错误: 读取原 hosts 内容异常，已中止写入（原文件未动）"
    exit 1
  fi
  build_block >> "$tmp"
  cp -f "$tmp" "$HOSTS_FILE"
  rm -f "$tmp"
  log "hosts 已更新（仅标记块内容，其余未动）。"

  # 刷新 DNS 缓存
  dscacheutil -flushcache 2>/dev/null
  killall -HUP mDNSResponder 2>/dev/null || true
  log "DNS 缓存已刷新。"

  # ============ git 兜底决策（v1.3.0）============
  # github.com HTTPS 直连失败时，按优先级自动选择 git 兜底通道:
  #   ① SSH-only 模式: SSH 通道可达且密钥已认证 → git 全功能走 SSH（无第三方中转，最稳）
  #   ② 镜像模式: SSH 不可用但镜像活着 → git 走镜像（下载场景够用）
  #   ③ 全不可用 → 诚实报告 + 出路指引
  if domain_ok github.com; then
    log "github.com 直连正常，跳过 git 兜底配置（不引入不必要的第三方中转）。"
  else
    local ssh_state="dead"
    if tcp_ok github.com 22 || tcp_ok ssh.github.com 443; then
      if ssh_auth_state; then ssh_state="authed"; else ssh_state="nokey"; fi
    fi
    if [ "$ssh_state" = "authed" ]; then
      # --- SSH-only 模式: 写 ~/.ssh/config 标记块 + git insteadOf (https → ssh) ---
      local sshcfg="$SSH_CONFIG_FILE"
      mkdir -p "$(dirname "$sshcfg")" && chmod 700 "$(dirname "$sshcfg")" 2>/dev/null
      if [ -f "$sshcfg" ] && ! grep -q "$MARK_SSH_START" "$sshcfg" 2>/dev/null; then
        cp -p "$sshcfg" "$sshcfg.ghacc.bak" 2>/dev/null
      fi
      local tmp; tmp=$(mktemp)
      if [ -f "$sshcfg" ]; then
        awk -v s="$MARK_SSH_START" -v e="$MARK_SSH_END" '
          index($0, s) == 1 { inblk=1; next }
          index($0, e) == 1 { inblk=0; next }
          !inblk { print }
        ' "$sshcfg" > "$tmp"
      else
        : > "$tmp"
      fi
      {
        echo "$MARK_SSH_START"
        echo "# Managed by github-accelerator v$VERSION. Re-running apply updates this block."
        echo "Host github.com"
        echo "  User git"
        if ! tcp_ok github.com 22 && tcp_ok ssh.github.com 443; then
          echo "  HostName ssh.github.com"
          echo "  Port 443"
        fi
        echo "$MARK_SSH_END"
      } >> "$tmp"
      cp -f "$tmp" "$sshcfg" && rm -f "$tmp"
      chmod 600 "$sshcfg" 2>/dev/null
      git config --global "url.git@github.com:.insteadOf" "https://github.com/"
      git config --global github-accelerator.gitmode ssh
      log "SSH-only 模式已启用: git 全部 https 地址自动转 SSH（clone/pull/push 全功能可用，无第三方中转）。"
      log "  Agent/小白照常执行 git clone https://github.com/用户名/仓库名.git 即可。"
    else
      # --- SSH 不可用: 走镜像，并如实报告 SSH 状态 ---
      local mirror
      if mirror=$(find_mirror); then
        git config --global "url.$mirror/https://github.com/.insteadOf" "https://github.com/"
        git config --global "github-accelerator.mirror" "$mirror"
        log "git 已配置镜像加速: $mirror（clone/pull 自动走镜像；如需关闭运行 rollback）"
      else
        log "警告: github.com 直连失败且所有镜像不可用，git 镜像兜底未能配置。"
      fi
      if [ "$ssh_state" = "nokey" ]; then
        log "提示: SSH 通道可达但未配置有效密钥（SSH 克隆需 GitHub 账号并添加公钥）。"
        log "  配置好 SSH 公钥后重跑 apply，可启用更稳的 SSH-only 模式。"
      elif [ "$ssh_state" = "dead" ]; then
        log "提示: SSH 通道也不通，git 仅能依赖镜像（若上方配置成功）。"
      fi
    fi
  fi

  # 端到端验证
  hr
  log "端到端验证（写入后实测）:"
  local d fail=0
  for d in $DOMAINS; do
    if domain_ok "$d"; then
      printf '  ✓ %s\n' "$d"
    else
      printf '  ✗ %s（hosts 已写入但仍不通，见诊断报告的出路指引）\n' "$d"
      fail=1
    fi
  done
  if [ "$fail" -eq 0 ]; then log "全部域名修复成功 ✓"; else log "部分域名未能修复，详见上方报告。"; fi
  # 沙箱环境提示（v1.1.2）: hosts 修好了但 Agent 沙箱代理仍拦 GitHub 的情况
  if [ -n "$SANDBOX_PROXY" ] && ! domain_ok_via github.com "$SANDBOX_PROXY" && domain_ok github.com; then
    hr
    log "沙箱提示: 检测到 Agent 沙箱代理拦截 GitHub（直连已修复）。"
    log "Agent 后续执行 git clone / curl / 下载安装时务必绕开代理，命令前缀:"
    log "  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY <命令>"
  fi
  return $fail
}

# ============ rollback ============
do_rollback() {
  # hosts 还原
  if [ "$(id -u)" -eq 0 ] || [ "$HOSTS_FILE" != "/etc/hosts" ]; then
    local latest
    latest=$(ls -t "$HOSTS_FILE".ghacc.bak.* 2>/dev/null | head -1)
    if [ -n "$latest" ]; then
      cp -p "$latest" "$HOSTS_FILE"
      log "hosts 已还原自: $latest"
      dscacheutil -flushcache 2>/dev/null
      killall -HUP mDNSResponder 2>/dev/null || true
    else
      # 无备份则仅移除标记块
      local tmp; tmp=$(mktemp) || { log "错误: 无法创建临时文件"; return 1; }
      awk -v s="$MARK_START" -v e="$MARK_END" '
        index($0, s) == 1 { inblk=1; next }
        index($0, e) == 1 { inblk=0; next }
        !inblk { print }
      ' "$HOSTS_FILE" > "$tmp" 2>/dev/null && [ -s "$tmp" ] && cp -f "$tmp" "$HOSTS_FILE" && rm -f "$tmp"
      log "未找到备份，已移除标记块内容。"
    fi
  fi
  # git 清理（镜像模式）
  local mirror
  mirror=$(git config --global --get github-accelerator.mirror 2>/dev/null)
  if [ -n "$mirror" ]; then
    git config --global --unset "url.$mirror/https://github.com/.insteadOf" 2>/dev/null
    git config --global --unset github-accelerator.mirror 2>/dev/null
    log "git 镜像配置已移除。"
  fi
  # git 清理（SSH-only 模式，v1.3.0）
  local gitmode
  gitmode=$(git config --global --get github-accelerator.gitmode 2>/dev/null)
  if [ "$gitmode" = "ssh" ]; then
    git config --global --unset "url.git@github.com:.insteadOf" 2>/dev/null
    git config --global --unset github-accelerator.gitmode 2>/dev/null
    log "git SSH-only 配置已移除。"
  fi
  # ssh 配置清理
  local sshcfg="$SSH_CONFIG_FILE"
  if [ -f "$sshcfg" ] && grep -q "$MARK_SSH_START" "$sshcfg" 2>/dev/null; then
    local tmp; tmp=$(mktemp)
    awk -v s="$MARK_SSH_START" -v e="$MARK_SSH_END" '
      index($0, s) == 1 { inblk=1; next }
      index($0, e) == 1 { inblk=0; next }
      !inblk { print }
    ' "$sshcfg" > "$tmp" && cp "$tmp" "$sshcfg" && rm -f "$tmp"
    log "SSH 兜底配置已移除。"
  fi
  log "回滚完成。"
}

# ============ watt: 一键自助安装 Watt Toolkit（v1.4.0）============
# 调用前提: Agent 已征得用户同意（SKILL.md 把关），或用户本人主动运行。
# macOS 路径: 官网 api.json（国内直连）拿最新版本号 → GitHub release dmg 经镜像池下载
#             → 挂载校验 → 安装到 /Applications（提权弹窗）→ 打开应用 → 使用教程。
# 全部通道失败时: 自动打开官网下载页 + 给出网盘渠道，绝不引导翻墙。
WATT_DEST="${WATT_DEST:-/Applications}"

watt_latest_ver() {
  local v
  v=$(c "https://steampp.net/api.json?r=0" | tr ',{}' '\n' | grep -m1 '"version"' | sed 's/.*: *"//; s/".*//' | tr -d ' ')
  if [ -n "$v" ]; then echo "$v"; else echo "3.1.0"; fi  # 兜底: 已验证的可用版本
}

do_watt() {
  log "Watt Toolkit 一键自助安装（开源免费、国内合法网络优化工具，非 VPN）"
  hr
  if [ "$(uname -s)" != "Darwin" ]; then
    log "当前平台暂不支持一键安装，已打开官网下载页，请手动下载对应平台版本:"
    log "  https://steampp.net/download"
    open "https://steampp.net/download" 2>/dev/null
    return 1
  fi
  local ver dmg dmg_url m src ok=""
  ver=$(watt_latest_ver)
  dmg_url="https://github.com/BeyondDimension/SteamTools/releases/download/$ver/Steam%2B%2B_v${ver}_macos.dmg"
  dmg="$HOME/Downloads/Steam++_v${ver}_macos.dmg"
  log "[1/4] 下载安装包 v$ver（约 230MB，自动选用最快的加速镜像）"
  local mnt; mnt=$(mktemp -d)
  for m in $MIRRORS https://github.com; do
    printf '  尝试 %s ...\n' "$m"
    rm -f "$dmg"
    if curl --noproxy '*' -L --progress-bar -m 1200 "$m/$dmg_url" -o "$dmg" 2>/dev/null \
       && [ "$(wc -c < "$dmg" | tr -d ' ')" -gt 100000000 ] \
       && hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mnt" >/dev/null 2>&1; then
      ok=1; log "  ✓ 下载完成并校验通过（$m）"; break
    fi
  done
  if [ -z "$ok" ]; then
    log "  ✗ 自动下载通道全部失败。"
    log "  已打开官网下载页，也可用以下网盘渠道手动下载（提取码均为 1234）:"
    log "    蓝奏云: https://wwn.lanzouy.com/b01v4izaf"
    log "    夸克网盘: https://pan.quark.cn/s/766914a2b0e7"
    open "https://steampp.net/download" 2>/dev/null
    rm -rf "$mnt"; return 1
  fi
  src=$(ls -d "$mnt"/*.app 2>/dev/null | head -1)
  if [ -z "$src" ]; then log "  ✗ dmg 内未找到应用（版本异常），请到官网手动下载。"; hdiutil detach "$mnt" >/dev/null 2>&1; rm -rf "$mnt"; return 1; fi
  local appname; appname=$(basename "$src")
  log "[2/4] 安装 $appname 到 $WATT_DEST"
  if cp -Rp "$src" "$WATT_DEST/" 2>/dev/null; then
    log "  ✓ 安装完成"
  elif osascript -e "do shell script \"rm -rf '$WATT_DEST/$appname'; cp -Rp '$src' '$WATT_DEST/'\" with administrator privileges" >/dev/null 2>&1; then
    log "  ✓ 安装完成（已通过系统授权）"
  else
    log "  ✗ 未获得安装权限。已打开 dmg 窗口，请手动把 $appname 拖入「应用程序」文件夹，完成后跳到教程部分。"
    open "$mnt" 2>/dev/null
    log "[3/4] 使用教程（安装后执行）:"
    call_watt_tutorial
    return 0
  fi
  hdiutil detach "$mnt" >/dev/null 2>&1; rm -rf "$mnt"
  rm -f "$dmg"
  log "[3/4] 启动 Watt Toolkit（首次打开如提示验证/ unidentified developer，点「打开」即可）"
  open "$WATT_DEST/$appname" 2>/dev/null || true
  log "[4/4] 使用教程（三步开始加速）:"
  call_watt_tutorial
  log "✓ 完成。之后可重跑本工具 check 复查直连状态。"
}

call_watt_tutorial() {
  log "  1. 打开 Watt Toolkit → 左侧「网络加速」"
  log "  2. 勾选 GitHub（可按需勾选其他平台）"
  log "  3. 点「一键加速」（推荐「系统代理」模式），状态显示运行中即生效"
  log "  提示: 加速生效后重新打开浏览器再访问 github.com；浏览器若装有代理插件请先关闭，避免冲突。"
}

# ============ status ============
do_status() {
  log "GitHub-Accelerator v$VERSION —— 当前状态"
  hr
  if [ -f "$HOSTS_FILE" ] && grep -q "$MARK_START" "$HOSTS_FILE" 2>/dev/null; then
    log "hosts 标记块内容:"
    awk -v s="$MARK_START" -v e="$MARK_END" 'index($0,s)==1{p=1} p{print} index($0,e)==1{exit}' "$HOSTS_FILE" | sed 's/^/  /'
  else
    log "hosts 中无本工具标记块（未安装或已回滚）。"
  fi
  hr
  do_check
}

case "${1:-check}" in
  check)    do_check ;;
  apply)    do_apply ;;
  rollback) do_rollback ;;
  status)   do_status ;;
  watt)     do_watt ;;
  *) echo "用法: $0 {check|apply|rollback|status|watt}"; exit 2 ;;
esac
